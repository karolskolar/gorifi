import db from '../db/schema.js';
import { toE164 } from './phone.js';

// ═══════════════════════════════════════════════════════════════════════════
// THE GUEST WAITLIST — 19 §UC-GL-004 (the write), §UC-GL-005 (the purges),
// §UC-GL-009 (the admin read + delete), §UC-GL-010 (the module-21 seam). ONE HOME
// for every statement that WRITES `guest_waitlist`:
//
//   joinWaitlist(...)                 the public signup (routes/guest.js POST …/waitlist)
//   purgeWaitlistOnOrder(phone, host) inside the guest submit transaction (rule 1)
//   purgeWaitlistAfterTwoCompletions() on the admin complete PATCH (rule 2)
//   deleteWaitlistRow(id)             the admin's manual third path (rule 3)
//
// plus the admin list reader. The host's COUNT is `helpers/standing-link.js
// waitingCount()` (a count only — the host never sees a name or a phone).
//
// ⚠ `notified_at` IS WRITTEN BY MODULE 21 ONLY (the outbox marks a row once its
// message reaches `sent`). The ONE thing this file does to it is RESET it to NULL on a
// re-signup (UC-GL-004 rule 4: re-arm the row for the next round) — never a
// timestamp, never from an admin route.
//
// ⚠ THE ROWS ARE NON-MEMBER PII (people who never joined). The e2e template scrub
// must cover `name` / `phone` / `phone_e164` before this writer reaches production —
// the exact lines are recorded on the GL-T6 row's BLOCKING scrub note (they land
// together with `friends.guest_link_token`'s, the first time production carries both
// migrations; learnings 11 §Seams).
//
// ⚠ SYNCHRONOUS, ALL OF IT (GA-T8). The signup is check-then-write; nothing may run
// between the lookup and the INSERT. The partial unique index
// `idx_guest_waitlist_host_e164` backs the E.164 half — its `SQLITE_CONSTRAINT*` (a
// lost race, unreachable under `instances: 1`) is translated into the UPDATE path.
//
// ── THE MODULE-21 SEGMENT — a CODE-COMMENT CONTRACT (19 §UC-GL-010) ─────────────
// There is deliberately NO `helpers/segments.js` here: that file is module 21's
// home. The SQL it must run for segment `waitlist` is stated here so the composer
// builds against a contract, not a guess:
//
//   SELECT w.id, w.host_friend_id, w.name, w.phone_e164,
//          f.name AS host_name, f.guest_link_token
//   FROM guest_waitlist w JOIN friends f ON f.id = w.host_friend_id
//   WHERE w.notified_at IS NULL AND w.whatsapp_opt_in = 1
//     AND w.phone_e164 IS NOT NULL AND f.active = 1
//
// Rows with `phone_e164 IS NULL` / `whatsapp_opt_in = 0` are listed by the composer
// as „bez platného čísla" / „bez súhlasu" and never sent. Recipient kind `waitlist`,
// `recipient_id = guest_waitlist.id`; `{odkaz}` = the STANDING link
// (`standingUrlPath(ensureStandingToken(host_friend_id))`), never a per-cycle token.
// ═══════════════════════════════════════════════════════════════════════════

// Does this error come from the partial unique index on (host, phone_e164)? BOTH
// halves, and the message half COLUMN-SPECIFIC (the `isStandingTokenConflict`
// precedent): a different constraint must never be read as „already signed up".
function isWaitlistConflict(e) {
  return typeof e?.code === 'string'
    && e.code.startsWith('SQLITE_CONSTRAINT')
    && /UNIQUE constraint failed: guest_waitlist\.host_friend_id, guest_waitlist\.phone_e164/
      .test(String(e?.message || ''));
}

// Rule 4's lookup: the E.164 value when it normalises, else the raw phone exactly.
// (A raw-phone row always has `phone_e164 IS NULL` — `toE164()` is deterministic —
// so the raw half cannot pick up a normalised row.)
function findSignup(hostId, phone, phoneE164) {
  if (phoneE164) {
    return db.prepare(
      'SELECT id FROM guest_waitlist WHERE host_friend_id = ? AND phone_e164 = ?'
    ).get(hostId, phoneE164);
  }
  return db.prepare(
    'SELECT id FROM guest_waitlist WHERE host_friend_id = ? AND phone_e164 IS NULL AND phone = ? ORDER BY id DESC LIMIT 1'
  ).get(hostId, phone);
}

// Latest submission wins on name + consent; `cycle_id` moves to the current „last
// round"; `notified_at` is RE-ARMED; `phone` (as first entered) and `created_at` stay.
const REARM_SQL = `
  UPDATE guest_waitlist
  SET name = ?, whatsapp_opt_in = ?, cycle_id = ?, notified_at = NULL
  WHERE id = ?
`;

/**
 * The public signup (19 §UC-GL-004 rules 3–4). Create OR re-arm — the caller answers
 * the SAME 200 either way (no oracle), so this returns nothing the route could leak.
 * `name` / `phone` are the already-validated identity strings; `optIn` is 0 | 1.
 */
export function joinWaitlist({ hostId, cycleId, name, phone, optIn }) {
  const phoneE164 = toE164(phone);
  const rearm = (id) => db.prepare(REARM_SQL).run(name, optIn, cycleId, id);

  const existing = findSignup(hostId, phone, phoneE164);
  if (existing) {
    rearm(existing.id);
    return;
  }
  try {
    db.prepare(`
      INSERT INTO guest_waitlist (host_friend_id, cycle_id, name, phone, phone_e164, whatsapp_opt_in)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hostId, cycleId, name, phone, phoneE164, optIn);
  } catch (e) {
    // A lost race on the partial unique index ⇒ the winner's row exists; take the
    // UPDATE path. Anything else — or a conflict the re-SELECT cannot explain — is
    // re-thrown, never swallowed.
    if (!isWaitlistConflict(e)) throw e;
    const winner = findSignup(hostId, phone, phoneE164);
    if (!winner) throw e;
    rearm(winner.id);
  }
}

/**
 * 19 §UC-GL-005 rule 1 — the guest just ORDERED, so they are a customer of this round.
 * ⚠ Call it INSIDE the submit transaction. When the phone normalises, every host's
 * row for that person goes (D5: a second host's row would only produce a duplicate
 * „objednávka je otvorená" message); otherwise only this host's row with the exact
 * raw phone.
 */
export function purgeWaitlistOnOrder(phone, hostId) {
  const phoneE164 = toE164(phone);
  if (phoneE164) {
    return db.prepare(
      'DELETE FROM guest_waitlist WHERE phone_e164 = ? AND phone_e164 IS NOT NULL'
    ).run(phoneE164).changes;
  }
  return db.prepare(
    'DELETE FROM guest_waitlist WHERE host_friend_id = ? AND phone = ?'
  ).run(hostId, phone).changes;
}

/**
 * 19 §UC-GL-005 rule 2 — a row signed up against round N (its `cycle_id` = the last
 * closed round at signup) goes once rounds N+1 AND N+2 have both completed: the
 * guest was offered two openings and ordered in neither. `cycle_id` NULL (no round
 * had ever closed) counts from 0. ⚠ Call it on the admin PATCH's TRANSITION to
 * `completed` only (module 17 never auto-completes), in the same transaction.
 */
export function purgeWaitlistAfterTwoCompletions() {
  return db.prepare(`
    DELETE FROM guest_waitlist
    WHERE (SELECT COUNT(*) FROM order_cycles c
           WHERE c.status = 'completed' AND c.id > COALESCE(guest_waitlist.cycle_id, 0)) >= 2
  `).run().changes;
}

/**
 * The admin list (19 §UC-GL-009) — in full, by design („to the admin in full").
 * `hostFriendId` is an integer filter or null (ignored).
 */
export function listWaitlist(hostFriendId = null) {
  const where = hostFriendId === null ? '' : 'WHERE w.host_friend_id = ?';
  const params = hostFriendId === null ? [] : [hostFriendId];
  return db.prepare(`
    SELECT w.id, w.host_friend_id, f.name AS host_name, w.name, w.phone, w.phone_e164,
           w.whatsapp_opt_in, w.cycle_id, c.name AS cycle_name, w.created_at, w.notified_at
    FROM guest_waitlist w
    JOIN friends f ON f.id = w.host_friend_id
    LEFT JOIN order_cycles c ON c.id = w.cycle_id
    ${where}
    ORDER BY f.name COLLATE NOCASE, w.created_at DESC, w.id DESC
  `).all(...params);
}

/** The admin's manual delete (rule 3). Returns true when a row went. */
export function deleteWaitlistRow(id) {
  return db.prepare('DELETE FROM guest_waitlist WHERE id = ?').run(id).changes === 1;
}
