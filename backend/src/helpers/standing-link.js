import db, { generateGuestToken } from '../db/schema.js';

// ═══════════════════════════════════════════════════════════════════════════
// THE STANDING GUEST LINK — 19 §UC-GL-001 (+ PO decisions 2026-09-19). ONE HOME.
//
// A host has ONE cycle-independent guest URL, `friends.guest_link_token`, minted
// lazily and rotatable after a leak. From GL-T2 on, `/g/:token` resolves BOTH token
// spaces through one resolver (UC-GL-002): a per-cycle `guest_order_links.token` OR
// a standing `friends.guest_link_token`. Everything that mints a value for either
// space, and everything that writes the standing column, lives here:
//
//   uniqueGuestToken()          a fresh token unique across BOTH spaces — it REPLACED
//                               guest-links.js's private `uniqueToken()`, which checked
//                               `guest_order_links` alone
//   ensureStandingToken(id)     the host's token, minted on first call (a STRING —
//                               module 21's `{odkaz}` seam composes
//                               `standingUrlPath(ensureStandingToken(id))`, UC-GL-010)
//   regenerateStandingToken(id) rotate in place; NOTHING else moves (UC-GL-002 rule 6)
//   standingUrlPath(token)      `/g/<token>` — the one composer
//   currentOpenCycle()          „the current round" (UC-GL-002 rule 2), ONE query
//   waitingCount(id)            the host's „kto čaká" COUNT (never names or phones)
//   standingPayload(id)         the GET body, shared by the host AND admin routes
//   regeneratedPayload(id)      the regenerate body, likewise — one helper, two guards
//   STANDING_REFUSALS           the two refusal bodies both routers answer with
//
// ⚠ RULE 1 LIVES HERE (19 §UC-GL-001 rule 1, „Minting requires an ACTIVE host"): a
// friend with `active = 0` and NO token is never minted one — by ensure, by
// regenerate, from either guard. An inactive friend WITH a token keeps it readable and
// ROTATABLE: rotation retires the old URL, and revocation matters most for a
// deactivated host. The host routes never reach this (deactivation deletes the
// friend's sessions); the admin routes answer it as 409 `reason:'inactive_host'`.
//
// ⚠ THE ONLY TWO WRITERS OF `friends.guest_link_token` in backend/src are the two
// UPDATEs in this file (ensure + regenerate). No INSERT INTO friends names the
// column, no admin PATCH touches it, nothing clears it. `e2e/tests/
// guest-standing-link.spec.js` §6 sweeps the whole backend for a third writer.
//
// ⚠ IT IS A CREDENTIAL — the URL token IS the credential of the public guest surface
// (CLAUDE.md, `routes/guest.js`) — so it is `invite_code`'s class exactly:
// `sanitizeFriend` strips it off every friend payload, `routes/guest.js`'s
// LINK_SELECT never selects it, and it has exactly FOUR publishing surfaces — every
// route that answers `standing.token`: the host's `GET /api/guest-links/standing` and
// `POST /api/guest-links/standing/regenerate`, and the admin's
// `GET /api/friends/:id/guest-link/standing` and `POST …/standing/regenerate`. It is
// NOT a LOGIN credential: it authenticates nobody as the friend, which is why the
// GA-T5 modern-mode 409 guard does not apply to any of them (see guest-links.js).
//
// ⚠ SYNCHRONOUS, ALL OF IT (GA-T8). `uniqueGuestToken()`'s check and the UPDATE that
// consumes its value are indivisible only because better-sqlite3 is synchronous and
// PM2 runs `instances: 1`. There is no DB constraint ACROSS the two tables — the
// in-process check is the whole cross-space guarantee. An `await` anywhere between
// the check and the write, or cluster mode, would reopen it. The unique index on
// `friends.guest_link_token` backs the standing half only; its `SQLITE_CONSTRAINT*`
// is translated into a retry below (unreachable today, kept for the cluster case).
// ═══════════════════════════════════════════════════════════════════════════

// Is `token` already a guest-link token in EITHER space? One statement over both.
const TOKEN_TAKEN_SQL = `
  SELECT 1 FROM guest_order_links WHERE token = ?
  UNION ALL
  SELECT 1 FROM friends WHERE guest_link_token = ?
  LIMIT 1
`;

/**
 * A fresh guest-link token, unique across `guest_order_links.token` AND
 * `friends.guest_link_token`. `generateGuestToken()` (schema.js: 14 chars of the
 * CSPRNG alphabet, SEC-S2) is the only generator — never a second RNG.
 */
export function uniqueGuestToken() {
  let token = generateGuestToken();
  while (db.prepare(TOKEN_TAKEN_SQL).get(token, token)) {
    token = generateGuestToken();
  }
  return token;
}

// Does this error come from `idx_friends_guest_link_token`? BOTH halves, and the
// message half COLUMN-SPECIFIC — `friends.uid`/`username`/`invite_code`/`google_sub`
// have unique indexes of their own, and retrying on one of those would be a lie (the
// `isGoogleSubConflict` precedent in friends.js / invitations.js).
function isStandingTokenConflict(e) {
  return typeof e?.code === 'string'
    && e.code.startsWith('SQLITE_CONSTRAINT')
    && /UNIQUE constraint failed: friends\.guest_link_token/.test(String(e?.message || ''));
}

// Bounded: a conflict here is unreachable under `instances: 1` (the check above and
// the write below have nothing between them), so a loop that kept failing would mean
// something else is wrong — surface it instead of spinning.
const MAX_WRITE_ATTEMPTS = 5;

// The two statements this file owns. Named literal columns, one value each.
const ENSURE_SQL = 'UPDATE friends SET guest_link_token = ? WHERE id = ? AND guest_link_token IS NULL';
const REGENERATE_SQL = 'UPDATE friends SET guest_link_token = ? WHERE id = ?';

function writeToken(sql, friendId) {
  for (let attempt = 1; ; attempt++) {
    try {
      return db.prepare(sql).run(uniqueGuestToken(), friendId);
    } catch (e) {
      if (!isStandingTokenConflict(e) || attempt >= MAX_WRITE_ATTEMPTS) throw e;
    }
  }
}

function readToken(friendId) {
  return db.prepare('SELECT id, active, guest_link_token FROM friends WHERE id = ?').get(friendId);
}

// Rule 1: minting — filling a NULL token — needs an ACTIVE friend. `active` is
// `INTEGER DEFAULT 1` and the admin PATCH writes 0/1, so only an explicit 0 refuses
// (a NULL, which no writer produces, is read as the column default).
function mayMint(row) {
  return row.active !== 0;
}

// The internal results: `{ token, created }`, `{ refused: 'not_found' }` or
// `{ refused: 'inactive_host' }`. The READ comes first, so an already-minted host
// costs no RNG draw and no uniqueness query — and the UPDATE's
// `AND guest_link_token IS NULL` is what makes a second mint impossible even if two
// calls ever did interleave (rule 2: a read never re-mints).
function mintIfMissing(friendId) {
  const row = readToken(friendId);
  if (!row) return { refused: 'not_found' };
  if (row.guest_link_token) return { token: row.guest_link_token, created: false };
  if (!mayMint(row)) return { refused: 'inactive_host' };
  const result = writeToken(ENSURE_SQL, row.id);
  const after = readToken(row.id);
  return { token: after.guest_link_token, created: result.changes === 1 };
}

function rotate(friendId) {
  const row = readToken(friendId);
  if (!row) return { refused: 'not_found' };
  // A NULL token is a MINT, and rule 1 applies to it; an existing one is a ROTATION,
  // which stays allowed for an inactive friend (revocation).
  if (!row.guest_link_token && !mayMint(row)) return { refused: 'inactive_host' };
  writeToken(REGENERATE_SQL, row.id);
  return { token: readToken(row.id).guest_link_token };
}

/**
 * The host's standing token, minted on the first call (D1). Idempotent. Returns the
 * token STRING, or null — for an unknown friend, and for an INACTIVE friend who has
 * none yet (rule 1). Neither null case writes anything.
 */
export function ensureStandingToken(friendId) {
  return mintIfMissing(friendId).token ?? null;
}

/**
 * Rotate the host's standing token IN PLACE on the `friends` row (a NULL one is
 * minted, which rule 1 refuses for an inactive friend). ⚠ NOTHING ELSE MOVES
 * (UC-GL-002 rule 6, D2): no `guest_order_links` row, no `active` flag, no sub-order,
 * no `order_token` — the per-cycle link keeps its own token and every created
 * sub-order resolves by `order_token` alone (14 D2). Returns the new token, or null
 * (unknown friend, or an inactive one with no token) without writing.
 */
export function regenerateStandingToken(friendId) {
  return rotate(friendId).token ?? null;
}

/** `/g/<token>` — the ONE composer (host dialog payload, module 21's `{odkaz}`). */
export function standingUrlPath(token) {
  return typeof token === 'string' && token ? `/g/${token}` : '';
}

/**
 * „The current round" (UC-GL-002 rule 2): the NEWEST `open` cycle, of ANY type — a
 * type filter would silently strand a host whose open round is the last bakery one.
 * 00-overview fixes „at most one open cycle"; if the data ever holds two, the newest
 * wins and ONE warn line says so (R1.2's rule, restated for the guest side — the
 * frontend's `[cycle-stages]` warn is the portal-side twin).
 *
 * ⚠ ONE statement: the window `COUNT(*) OVER ()` is evaluated before the LIMIT, so
 * the same row that answers the question also counts the open rounds. Returns
 * `{ id, name, status }` or null. GL-T2's resolver may widen the column list —
 * additively, and still in this one query.
 */
export function currentOpenCycle() {
  const row = db.prepare(`
    SELECT id, name, status, COUNT(*) OVER () AS open_count
    FROM order_cycles
    WHERE status = 'open'
    ORDER BY id DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  if (row.open_count > 1) {
    console.warn(`[standing-link] ${row.open_count} open cycles — using the newest (id ${row.id})`);
  }
  return { id: row.id, name: row.name, status: row.status };
}

/**
 * The host's „kto čaká" COUNT (19 Actors: „sees the waitlist as a COUNT only") — the
 * people who asked to be told and have NOT been told yet: `notified_at IS NULL`.
 *
 * ⚠ Why the filter (orchestrator decision on the GL-T1 review; 19's own text implies
 * it three times): UC-GL-004 rule 4 RE-ARMS a row on re-signup by resetting
 * `notified_at = NULL` — which only means something if NULL is „still waiting";
 * UC-GL-010's segment is `WHERE w.notified_at IS NULL`, so once module 21 has sent a
 * round the waiting set is empty; and the copy the count feeds — „N ľudí čaká na váš
 * odkaz" — says they are still waiting for the link. A notified row stays in the
 * table (the admin sees it until a purge, UC-GL-005) but no longer counts here.
 *
 * `guest_waitlist` is INERT until GL-T3 ships its public writer, so this is 0
 * everywhere today — but it counts the real table, never a placeholder.
 */
export function waitingCount(friendId) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM guest_waitlist WHERE host_friend_id = ? AND notified_at IS NULL'
  ).get(friendId).n;
}

/**
 * The two refusals both routers answer with, keyed by the composers' `refused`. ONE
 * copy of each body, so the host and admin guards cannot drift apart. The 409 follows
 * the per-cycle admin CREATE's `inactive_host` (guest-links.js) — message style and
 * `reason` key alike. Neither string says „cyklus"/„kolo" (friend-facing vocabulary
 * rule), although only the admin can actually reach the 409.
 */
export const STANDING_REFUSALS = Object.freeze({
  not_found: Object.freeze({ status: 404, body: Object.freeze({ error: 'Priateľ nebol nájdený' }) }),
  inactive_host: Object.freeze({
    status: 409,
    body: Object.freeze({
      error: 'Priateľ je deaktivovaný - stály odkaz pre hostí by nefungoval. Najprv ho aktivujte.',
      reason: 'inactive_host',
    }),
  }),
});

/**
 * The `GET …/standing` result — HOST and ADMIN alike (one helper, two guards):
 * `{ payload }` with `payload = { standing: { token, url_path, created },
 * waiting_count, current }` (`created` true ONLY on the call that minted, `current`
 * `{ cycle_id, name, status } | null`), or `{ refused }` — a key of
 * `STANDING_REFUSALS`. ⚠ The one deliberate write inside a GET (D1).
 */
export function standingPayload(friendId) {
  const minted = mintIfMissing(friendId);
  if (minted.refused) return { refused: minted.refused };
  const current = currentOpenCycle();
  return {
    payload: {
      standing: {
        token: minted.token,
        url_path: standingUrlPath(minted.token),
        created: minted.created,
      },
      waiting_count: waitingCount(friendId),
      current: current ? { cycle_id: current.id, name: current.name, status: current.status } : null,
    },
  };
}

/**
 * The `POST …/standing/regenerate` result — HOST and ADMIN alike: `{ payload }` with
 * `payload = { standing: { token, url_path }, regenerated: true, waiting_count }`, or
 * `{ refused }`.
 */
export function regeneratedPayload(friendId) {
  const rotated = rotate(friendId);
  if (rotated.refused) return { refused: rotated.refused };
  return {
    payload: {
      standing: { token: rotated.token, url_path: standingUrlPath(rotated.token) },
      regenerated: true,
      waiting_count: waitingCount(friendId),
    },
  };
}

/** Send a composer's result — the one place a `refused` becomes a status (both routers). */
export function sendStanding(res, result) {
  if (result.refused) {
    const { status, body } = STANDING_REFUSALS[result.refused];
    return res.status(status).json(body);
  }
  return res.json(result.payload);
}
