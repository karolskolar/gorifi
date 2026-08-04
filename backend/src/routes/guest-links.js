import { Router } from 'express';
import db, { generateGuestToken } from '../db/schema.js';
import { requireHost } from '../middleware/friend-auth.js';
import { loadSubOrders } from '../helpers/guest-orders.js';

const router = Router();

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

export default router;
