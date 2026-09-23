import { Router } from 'express';
import db from '../db/schema.js';
import { requireHost } from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { loadSubOrders, linkTotals } from '../helpers/guest-orders.js';
import { uniqueGuestToken, standingPayload, regeneratedPayload, sendStanding } from '../helpers/standing-link.js';

const router = Router();

// The host's guest share links.
//
// ⚠ MIXED-AUTH ROUTER — mounted BARE in index.js and gated PER ROUTE (the
// routes/guest-orders.js:17-27 idiom):
//   HOST-only  (friend Bearer identity, §UC-GSO-005)
//     POST   /cycle/:cycleId                  create-or-regenerate own link
//     GET    /cycle/:cycleId                  own link + own sub-orders
//     PATCH  /:id                             deactivate / reactivate own link
//     GET    /standing                        own STANDING link, minted lazily (19 §UC-GL-001, D1)
//     POST   /standing/regenerate             rotate own standing token (no `has_orders` gate, D2)
//   (the ADMIN half of the standing link lives on /api/friends/:id/guest-link/standing —
//    PO 2026-09-19 — because it is keyed on a friend, not on a cycle; same helper.)
//   ADMIN-only (`requireAdmin`, 14 §UC-GR-004)
//     GET    /cycle/:cycleId/all                        every host's link
//     POST   /cycle/:cycleId/host/:friendId             create-if-missing
//     POST   /cycle/:cycleId/host/:friendId/regenerate  rotate the token in place
// Wrapping the mount in either guard would be wrong in both directions — an admin
// route cannot live under a host guard, and vice versa. Every route added here
// MUST state its own guard on its first lines.
//
// ⚠⚠ DECISION D3 IS **AMENDED** (PO decision, 2026-08-31). The admin CAN now
// regenerate a host's link. The admin still CANNOT deactivate or reactivate one.
//
// D3 originally made admin link powers READ + CREATE only, for two reasons.
//
// THE FIRST REASON IS SPENT. It read: "an admin REGENERATE silently severs every
// colleague already holding the URL — that is exactly what stranded the incident's
// guest." That was true while a guest's status URL resolved by the (link, order)
// **pair**: rotating the link half killed her order URL, which is the production
// incident this whole module exists for. Since GR-T1/GR-T2 a guest's order resolves
// by `order_token` ALONE (§UC-GR-001/002, D1/D2), so NO regeneration — the host's
// or the admin's — can strand an already-created order any more. What regeneration
// still does is stop NEW orders through the old URL (`resolveEntry` — formerly
// `resolveLink` — 404s it), which
// is a deliberate revocation act rather than collateral damage.
//
// THE SECOND REASON STANDS, UNAMENDED: an admin REACTIVATE would republish a link
// the host deliberately revoked after a leak, and only the host knows who holds it.
// So `active` remains HOST-ONLY — **no admin route on this prefix may ever write
// `active`**, the regenerate route below included. It rotates `token` and nothing
// else, so a revoked link stays revoked through an admin regeneration.
//
// WHY THE ADMIN NEEDS IT AT ALL: the host's own POST below now REFUSES to
// regenerate while live sub-orders exist (409 `reason:'has_orders'` — a host must
// not be able to invalidate an ordering link colleagues are already using), and the
// share dialog tells the host to contact the admin. That escalation target has to
// exist, or the copy points at a dead end — which is precisely the GSO-T5 mistake
// module 14 was written to remove ("escalate to the admin" with no admin route, and
// a paying guest nobody could help).
//
// UNCHANGED by the amendment: the admin CREATE route returns an existing row
// completely UNTOUCHED (token byte-identical, `active` unwritten, including when it
// is 0). Its idempotency is machine-pinned in
// e2e/tests/guest-order-recovery.spec.js ("the no-regenerate proof"), which is what
// a future "just refresh the token while we're here" refactor will trip over.
// Regeneration is a SEPARATE, EXPLICIT route — the create route still never rotates
// a token, because "create" silently rotating one is how the incident happened.

const LINK_COLUMNS = 'id, token, host_friend_id, cycle_id, active, created_at';

function getLink(id) {
  return db.prepare(`SELECT ${LINK_COLUMNS} FROM guest_order_links WHERE id = ?`).get(id);
}

// ⚠ Per-cycle tokens are minted by `helpers/standing-link.js uniqueGuestToken()`
// (19 §UC-GL-001). It REPLACED this file's private `uniqueToken`, whose collision
// retry checked `guest_order_links.token` only: from GL-T2 on `/g/:token` resolves a
// per-cycle token AND a host's standing `friends.guest_link_token` through one
// resolver, so a value must be unique across BOTH spaces — one generator, one check.

// The host's sub-orders under a link, plus their running total, live in
// helpers/guest-orders.js — GSO-T5 enriched each row with its `items` (the
// "Objednávky kolegov" view lists what every colleague ordered, §UC-GSO-006) and
// the host's delivered/remove mutations in routes/guest-orders.js answer with the
// same row shape, so the loaders are shared rather than duplicated.
//
// The GSO-T2 response shape is EXTENDED, never reshaped: `{ link, guest_orders,
// totals }` still holds, `guest_orders[i].items` is new.
//
// ⚠ `order_token` IS exposed here from module 14 on (14 §UC-GR-006, GR-T5) — a
// CONSCIOUS REVERSAL of GSO-T2's exclusion, and `GET /cycle/:cycleId` below is the
// primary publishing surface. The host needs it to re-send a colleague the link to
// their own order: hiding it is precisely why nobody could help the guest whose
// status URL died with a link regeneration. The surviving half of the old rule is
// the one that matters: **routes/guest.js remains the ONLY place `order_token`
// authenticates anything.** Published is not the same as rendered — no view may put
// a token into an attribute (`title`/`href`/`data-*`); it is composed in JS at click
// time. The LINK listing (`GET /cycle/:cycleId/all`, UC-GR-004) deliberately carries
// no token: it is link data, and the tokens ride the sub-order rows.

function getCycle(cycleId) {
  return db.prepare('SELECT id FROM order_cycles WHERE id = ?').get(cycleId);
}

// POST /guest-links/cycle/:cycleId — create the host's share link for this
// cycle, or regenerate it if one already exists.
router.post('/cycle/:cycleId', (req, res) => {
  const host = requireHost(req);
  if (host.error) return res.status(host.status).json({ error: host.error });

  const cycle = getCycle(req.params.cycleId);
  if (!cycle) return res.status(404).json({ error: 'Ponuka nebola nájdená' });

  const existing = db.prepare(
    'SELECT id FROM guest_order_links WHERE host_friend_id = ? AND cycle_id = ?'
  ).get(host.friendId, cycle.id);

  if (existing) {
    // ⚠ THE REGENERATION GATE (PO decision, 2026-08-31). A host may not invalidate
    // an ordering link their colleagues are ALREADY using: once a live sub-order
    // hangs off this link, "Vygenerovať nový odkaz" would stop every colleague who
    // has not ordered yet from reaching the offer, and the host's own reading of
    // that button ("share with one more colleague") is what caused the incident.
    // Refused with 409 `reason:'has_orders'`; the host is pointed at the admin, who
    // has an EXPLICIT regenerate route below — the escalation target exists.
    //
    // ⚠ SCOPED TO THE REGENERATION BRANCH ONLY, and structurally so: the create
    // path is the `if (existing)` else-branch, and with no link row there is nothing
    // for a sub-order to hang off. Creation therefore cannot be affected by this
    // gate — asserted in the spec rather than left as an argument.
    //
    // ⚠ The live count is `linkTotals().count` — the SHIPPED aggregate, whose count
    // already excludes cancelled sub-orders via `guestOrderStatus()`. Two things
    // follow, both deliberate. A CANCELLED sub-order does NOT block: it owes
    // nothing, holds no stock and is nobody's pending hand-over, so the host is free
    // to rotate the token again. And the status predicate is NOT re-inlined here —
    // this repo already watched a hand-written copy of it drop the `<> 'cancelled'`
    // half (the guest cancel door, before `softCancelGuestOrder` centralised it).
    const liveOrders = linkTotals(existing.id).count;
    if (liveOrders > 0) {
      return res.status(409).json({
        error: 'Nový odkaz nie je možné vygenerovať, kým cez tento odkaz existujú objednávky. Ak potrebujete nový odkaz, kontaktujte správcu.',
        reason: 'has_orders',
        live_orders: liveOrders,
      });
    }

    // Regenerate IN PLACE. The row id is what guest_orders.link_id points at and
    // those FKs cascade on delete, so a DELETE + INSERT would take every
    // existing sub-order with it — the token is swapped instead. A previously
    // deactivated link is reactivated by re-sharing.
    db.prepare('UPDATE guest_order_links SET token = ?, active = 1 WHERE id = ?')
      .run(uniqueGuestToken(), existing.id);
    const link = getLink(existing.id);
    return res.json({ link, regenerated: true, ...loadSubOrders(link.id) });
  }

  const result = db.prepare(
    'INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES (?, ?, ?, 1)'
  ).run(uniqueGuestToken(), host.friendId, cycle.id);

  const link = getLink(result.lastInsertRowid);
  res.status(201).json({ link, regenerated: false, ...loadSubOrders(link.id) });
});

// GET /guest-links/cycle/:cycleId — the host's own link for this cycle (null if
// they have not shared yet) plus their guest sub-orders.
router.get('/cycle/:cycleId', (req, res) => {
  const host = requireHost(req);
  if (host.error) return res.status(host.status).json({ error: host.error });

  const cycle = getCycle(req.params.cycleId);
  if (!cycle) return res.status(404).json({ error: 'Ponuka nebola nájdená' });

  // Scoped to the authenticated friend, so one host can never read another's link.
  const link = db.prepare(
    `SELECT ${LINK_COLUMNS} FROM guest_order_links WHERE host_friend_id = ? AND cycle_id = ?`
  ).get(host.friendId, cycle.id);

  res.json({ link, ...loadSubOrders(link?.id) });
});

// ---------------------------------------------------------------------------
// THE STANDING LINK — 19 §UC-GL-001. HOST-only, `requireHost()` identity: the host is
// the Bearer session and NEVER a body field (SEC-A1) — neither route reads `req.body`
// at all, so nothing smuggled into one can name another friend or a token.
//
// ⚠ NO MODERN-MODE 409 GUARD, and that is a decision, not an omission. CLAUDE.md's
// GA-T5 rule covers routes that write a LOGIN credential (password, username, Google
// link): under legacy auth the shared password can mint anyone's session, so such a
// write is account takeover. A standing token authenticates NOBODY as the friend — it
// opens the public guest surface only, exactly like the per-cycle token that
// `POST /cycle/:cycleId` above has always minted and rotated with no mode guard. A
// guard here would also 409 every host while production runs `auth_mode = legacy`,
// i.e. ship the feature to nobody. `requireHost()` already refuses the bare shared
// password (no friendId ⇒ 401) in BOTH modes.
//
// Rule 1 (an ACTIVE host mints): deactivating a friend deletes their sessions in the
// same transaction (friends.js admin PATCH), so a deactivated host's Bearer 401s here
// before anything is read. The rule itself lives in `helpers/standing-link.js`, so the
// admin's routes on /api/friends/:id/guest-link/standing are held to it too: an
// inactive friend with NO token gets 409 `inactive_host` (no mint), while one WITH a
// token can still be read and rotated — revocation matters most there.
//
// Both handlers are synchronous (GA-T8); the payloads are composed by
// `helpers/standing-link.js`, shared verbatim with the admin routes.
//
// ⚠ Registered BEFORE `PATCH /:id`. There is no `GET /:id` or `POST /:id/…` on this
// router, so nothing collides today; keeping literal segments above parameter routes
// makes that hold for whatever is added next.

// GET /guest-links/standing — the host's standing link, minted on the first call.
// ⚠ The ONE deliberate write inside a GET in this router (D1): R9.4 says the host can
// copy the link „any time", so it has no „not yet created" state on the host side.
// `created` is true only on the call that minted.
router.get('/standing', (req, res) => {
  const host = requireHost(req);
  if (host.error) return res.status(host.status).json({ error: host.error });

  // Both refusals are unreachable for a live session — `friend_sessions` cascade on a
  // friend DELETE, and deactivation deletes them — but they are mapped by the ONE
  // `sendStanding` both routers share, so a vanished row is a 404, never a TypeError.
  sendStanding(res, standingPayload(host.friendId));
});

// POST /guest-links/standing/regenerate — rotate the host's standing token in place.
// ⚠ NO `has_orders` GATE (D2) — the per-cycle link above keeps its own token, and
// every sub-order resolves by `order_token` alone (14 D2), so rotating strands nobody
// who has ordered; it closes the door on whoever holds the OLD standing URL and has
// not, which is the point after a leak. Nothing but `friends.guest_link_token` moves.
router.post('/standing/regenerate', (req, res) => {
  const host = requireHost(req);
  if (host.error) return res.status(host.status).json({ error: host.error });

  sendStanding(res, regeneratedPayload(host.friendId));
});

// PATCH /guest-links/:id — deactivate (default) or reactivate the host's own
// link. Body: { active? }.
router.patch('/:id', (req, res) => {
  const host = requireHost(req);
  if (host.error) return res.status(host.status).json({ error: host.error });

  const link = db.prepare('SELECT * FROM guest_order_links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Odkaz nebol nájdený' });
  if (String(link.host_friend_id) !== String(host.friendId)) {
    return res.status(403).json({ error: 'Nemáte oprávnenie na tento odkaz' });
  }

  const active = req.body?.active === undefined ? 0 : (req.body.active ? 1 : 0);
  db.prepare('UPDATE guest_order_links SET active = ? WHERE id = ?').run(active, link.id);

  const updated = getLink(link.id);
  res.json({ link: updated, ...loadSubOrders(updated.id) });
});

// ---------------------------------------------------------------------------
// ADMIN half (14 §UC-GR-004). `requireAdmin` on each route's own line — see the
// MIXED-AUTH note at the top of this file, and the D3 non-capability it records.

// The same LINK_COLUMNS, qualified for the JOIN below. One column list, so a
// future addition cannot land on one surface and not the other.
const LINK_COLUMNS_L = LINK_COLUMNS.split(', ').map((c) => `l.${c}`).join(', ');

// GET /guest-links/cycle/:cycleId/all — ADMIN. Every host's share link for this
// cycle, so the admin can forward one on the host's behalf (PO requirement 1).
//
// Deliberately a SEPARATE endpoint rather than a fold into the orders-tab payload
// (routes/orders.js `GET /cycle/:cycleId`): that payload is built over friend
// orders with a LEFT JOIN, and a second join for link data is the row-multiplying
// class the GSO-T6/T8 notes warn about. Link data keeps its one home here and the
// frontend joins the two payloads by `host_friend_id` (§UC-GR-008).
//
// `order_token` is NOT link data and does not appear here — it rides the sub-order
// rows (§UC-GR-006, GR-T5).
router.get('/cycle/:cycleId/all', requireAdmin, (req, res) => {
  const cycle = getCycle(req.params.cycleId);
  if (!cycle) return res.status(404).json({ error: 'Cyklus nebol nájdený' });

  // `host_active` is joined in because a link under a deactivated host 410s for
  // every guest (routes/guest.js resolveEntry, formerly resolveLink) — the admin must see that the URL is
  // dead even though the link row itself still says active = 1.
  const links = db.prepare(`
    SELECT ${LINK_COLUMNS_L}, f.name AS host_name, f.active AS host_active
    FROM guest_order_links l
    JOIN friends f ON f.id = l.host_friend_id
    WHERE l.cycle_id = ?
    ORDER BY f.name COLLATE NOCASE, l.id
  `).all(cycle.id);

  res.json({ links });
});

// POST /guest-links/cycle/:cycleId/host/:friendId — ADMIN, CREATE-IF-MISSING.
//
// ⚠ This route NEVER regenerates and NEVER writes `active` (D3). An existing row
// is returned exactly as stored — including an inactive one, so the admin sees the
// state the host chose rather than silently getting it republished. Only the
// INSERT branch writes anything, and it names its columns literally, so nothing
// smuggled into the request body can land.
//
// No cycle-status gate, mirroring the host's own POST above (existence only): a
// link for a non-open cycle takes no orders anyway: `resolveEntry` (formerly
// `resolveLink`, which 410'd it) answers it with the pre-open page since 19 §UC-GL-002.
router.post('/cycle/:cycleId/host/:friendId', requireAdmin, (req, res) => {
  const cycle = getCycle(req.params.cycleId);
  if (!cycle) return res.status(404).json({ error: 'Cyklus nebol nájdený' });

  const friend = db.prepare('SELECT id, active FROM friends WHERE id = ?').get(req.params.friendId);
  if (!friend) return res.status(404).json({ error: 'Priateľ nebol nájdený' });

  // A deactivated host's link 410s for every guest, so creating one would hand the
  // admin a dead URL as if it had worked.
  if (!friend.active) {
    return res.status(409).json({
      error: 'Priateľ je deaktivovaný - odkaz pre hostí by nefungoval. Najprv ho aktivujte.',
      reason: 'inactive_host',
    });
  }

  const existing = db.prepare(
    `SELECT ${LINK_COLUMNS} FROM guest_order_links WHERE host_friend_id = ? AND cycle_id = ?`
  ).get(friend.id, cycle.id);

  if (existing) {
    return res.json({ link: existing, created: false });
  }

  const result = db.prepare(
    'INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES (?, ?, ?, 1)'
  ).run(uniqueGuestToken(), friend.id, cycle.id);

  res.status(201).json({ link: getLink(result.lastInsertRowid), created: true });
});

// POST /guest-links/cycle/:cycleId/host/:friendId/regenerate — ADMIN.
//
// The escalation target for the host's `has_orders` 409 (D3 as amended — see the
// header block for why the reason D3 forbade this is now spent). Without this route
// the dialog's "kontaktujte správcu" points at a dead end.
//
// ⚠⚠ ROTATES `token` IN PLACE ON THE EXISTING ROW. **Never DELETE + INSERT.**
// `guest_orders.link_id` is an FK that CASCADES ON DELETE, so re-inserting the row
// would take every sub-order under it with it — silently destroying the very orders
// the host-side gate exists to protect, and turning a recovery tool into a worse
// version of the original incident. The UPDATE names one column, once.
//
// ⚠ `active` IS NOT WRITTEN — the one asymmetry with the host's own regenerate,
// which does set `active = 1` (a host re-sharing means to republish). The surviving
// half of D3 keeps reactivation host-only: only the host knows who holds a leaked
// URL. So a revoked link stays revoked through an admin regeneration, and this route
// can never be used as a back-door reactivate.
//
// ⚠ NO `has_orders` gate here — being exempt from it is this route's entire purpose.
//
// ⚠ NO `inactive_host` gate either, and that IS a deliberate divergence from the
// create route directly above rather than an oversight. The create gate exists
// because handing the admin a fresh URL that 410s for every guest would look like it
// worked. Regeneration's effect is twofold — it retires the OLD token as well as
// minting a new one — and the retirement half works regardless of the host's
// `active` flag. Refusing it would block the admin from killing a leaked URL
// belonging to a deactivated host, which is a case where revocation matters most.
router.post('/cycle/:cycleId/host/:friendId/regenerate', requireAdmin, (req, res) => {
  const cycle = getCycle(req.params.cycleId);
  if (!cycle) return res.status(404).json({ error: 'Cyklus nebol nájdený' });

  const friend = db.prepare('SELECT id FROM friends WHERE id = ?').get(req.params.friendId);
  if (!friend) return res.status(404).json({ error: 'Priateľ nebol nájdený' });

  const existing = db.prepare(
    'SELECT id FROM guest_order_links WHERE host_friend_id = ? AND cycle_id = ?'
  ).get(friend.id, cycle.id);

  // Nothing to rotate. Deliberately NOT a create-if-missing: that capability is the
  // sibling route above, and one route doing both is exactly how "regenerate" ends
  // up silently minting links nobody asked for.
  if (!existing) {
    return res.status(404).json({ error: 'Odkaz pre hostí neexistuje', reason: 'no_link' });
  }

  db.prepare('UPDATE guest_order_links SET token = ? WHERE id = ?')
    .run(uniqueGuestToken(), existing.id);

  res.json({ link: getLink(existing.id), regenerated: true });
});

export default router;
