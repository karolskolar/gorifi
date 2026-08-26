import { Router } from 'express';
import db, { generateGuestToken } from '../db/schema.js';
import { requireHost } from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { loadSubOrders } from '../helpers/guest-orders.js';

const router = Router();

// The host's guest share links.
//
// ⚠ MIXED-AUTH ROUTER — mounted BARE in index.js and gated PER ROUTE (the
// routes/guest-orders.js:17-27 idiom):
//   HOST-only  (friend Bearer identity, §UC-GSO-005)
//     POST   /cycle/:cycleId                  create-or-regenerate own link
//     GET    /cycle/:cycleId                  own link + own sub-orders
//     PATCH  /:id                             deactivate / reactivate own link
//   ADMIN-only (`requireAdmin`, 14 §UC-GR-004)
//     GET    /cycle/:cycleId/all              every host's link for the cycle
//     POST   /cycle/:cycleId/host/:friendId   create-if-missing for one host
// Wrapping the mount in either guard would be wrong in both directions — an admin
// route cannot live under a host guard, and vice versa. Every route added here
// MUST state its own guard on its first lines.
//
// ⚠⚠ EXPLICIT NON-CAPABILITY (14 §UC-GR-004 / Decision D3 — PO decision): the
// admin has **READ + CREATE only**. There is NO admin regenerate, NO admin
// deactivate and NO admin reactivate, and **no admin route on this prefix may ever
// write `token` or `active`**. Revocation stays host-only (PATCH /:id, requireHost
// + ownership). The reasons are the production incident itself:
//   - an admin REGENERATE silently severs every colleague already holding the URL
//     — that is exactly what stranded the incident's guest;
//   - an admin REACTIVATE would republish a link the host deliberately revoked
//     after a leak, and only the host knows who holds it.
// The create route below therefore returns an existing row completely UNTOUCHED
// (token byte-identical, `active` unwritten, including when it is 0). Its
// idempotency is machine-pinned in e2e/tests/guest-order-recovery.spec.js
// ("the no-regenerate proof"), which is what a future "just refresh the token
// while we're here" refactor will trip over.

const LINK_COLUMNS = 'id, token, host_friend_id, cycle_id, active, created_at';

function getLink(id) {
  return db.prepare(`SELECT ${LINK_COLUMNS} FROM guest_order_links WHERE id = ?`).get(id);
}

// Unique token, with a collision retry against the `token UNIQUE` constraint.
function uniqueToken() {
  let token = generateGuestToken();
  while (db.prepare('SELECT id FROM guest_order_links WHERE token = ?').get(token)) {
    token = generateGuestToken();
  }
  return token;
}

// The host's sub-orders under a link, plus their running total, live in
// helpers/guest-orders.js — GSO-T5 enriched each row with its `items` (the
// "Objednávky kolegov" view lists what every colleague ordered, §UC-GSO-006) and
// the host's delivered/remove mutations in routes/guest-orders.js answer with the
// same row shape, so the loaders are shared rather than duplicated.
//
// The GSO-T2 response shape is EXTENDED, never reshaped: `{ link, guest_orders,
// totals }` still holds, `guest_orders[i].items` is new. `order_token` remains
// unexposed — it is the guest's private status/edit URL and the host never needs
// it.

function getCycle(cycleId) {
  return db.prepare('SELECT id FROM order_cycles WHERE id = ?').get(cycleId);
}

// POST /guest-links/cycle/:cycleId — create the host's share link for this
// cycle, or regenerate it if one already exists.
router.post('/cycle/:cycleId', (req, res) => {
  const host = requireHost(req);
  if (host.error) return res.status(host.status).json({ error: host.error });

  const cycle = getCycle(req.params.cycleId);
  if (!cycle) return res.status(404).json({ error: 'Cyklus nebol nájdený' });

  const existing = db.prepare(
    'SELECT id FROM guest_order_links WHERE host_friend_id = ? AND cycle_id = ?'
  ).get(host.friendId, cycle.id);

  if (existing) {
    // Regenerate IN PLACE. The row id is what guest_orders.link_id points at and
    // those FKs cascade on delete, so a DELETE + INSERT would take every
    // existing sub-order with it — the token is swapped instead. A previously
    // deactivated link is reactivated by re-sharing.
    db.prepare('UPDATE guest_order_links SET token = ?, active = 1 WHERE id = ?')
      .run(uniqueToken(), existing.id);
    const link = getLink(existing.id);
    return res.json({ link, regenerated: true, ...loadSubOrders(link.id) });
  }

  const result = db.prepare(
    'INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES (?, ?, ?, 1)'
  ).run(uniqueToken(), host.friendId, cycle.id);

  const link = getLink(result.lastInsertRowid);
  res.status(201).json({ link, regenerated: false, ...loadSubOrders(link.id) });
});

// GET /guest-links/cycle/:cycleId — the host's own link for this cycle (null if
// they have not shared yet) plus their guest sub-orders.
router.get('/cycle/:cycleId', (req, res) => {
  const host = requireHost(req);
  if (host.error) return res.status(host.status).json({ error: host.error });

  const cycle = getCycle(req.params.cycleId);
  if (!cycle) return res.status(404).json({ error: 'Cyklus nebol nájdený' });

  // Scoped to the authenticated friend, so one host can never read another's link.
  const link = db.prepare(
    `SELECT ${LINK_COLUMNS} FROM guest_order_links WHERE host_friend_id = ? AND cycle_id = ?`
  ).get(host.friendId, cycle.id);

  res.json({ link, ...loadSubOrders(link?.id) });
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
  // every guest (routes/guest.js resolveLink) — the admin must see that the URL is
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
// link for a non-open cycle is inert anyway, since `resolveLink` 410s it.
router.post('/cycle/:cycleId/host/:friendId', requireAdmin, (req, res) => {
  const cycle = getCycle(req.params.cycleId);
  if (!cycle) return res.status(404).json({ error: 'Cyklus nebol nájdený' });

  const friend = db.prepare('SELECT id, active FROM friends WHERE id = ?').get(req.params.friendId);
  if (!friend) return res.status(404).json({ error: 'Priateľ nebol nájdený' });

  // A deactivated host's link 410s for every guest, so creating one would hand the
  // admin a dead URL as if it had worked.
  if (!friend.active) {
    return res.status(409).json({
      error: 'Priateľ je deaktivovaný — odkaz pre hostí by nefungoval. Najprv ho aktivujte.',
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
  ).run(uniqueToken(), friend.id, cycle.id);

  res.status(201).json({ link: getLink(result.lastInsertRowid), created: true });
});

export default router;
