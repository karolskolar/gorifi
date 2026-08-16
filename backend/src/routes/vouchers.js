import { Router } from 'express';
import db from '../db/schema.js';
import { validateFriendAuth } from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { bindValue } from '../helpers/bind-value.js';

const router = Router();

// POST /vouchers/generate — Create vouchers for selected friends from a cycle (admin only)
router.post('/generate', requireAdmin, (req, res) => {
  const { source_cycle_id, supplier_discount, applied_discount, friend_ids } = req.body;

  // Validate required fields
  if (!source_cycle_id || supplier_discount === undefined || applied_discount === undefined || !friend_ids) {
    return res.status(400).json({ error: 'Chýbajú povinné polia: source_cycle_id, supplier_discount, applied_discount, friend_ids' });
  }

  if (!Array.isArray(friend_ids) || friend_ids.length === 0) {
    return res.status(400).json({ error: 'friend_ids musí byť neprázdne pole' });
  }

  // Bounds: discounts are percentages. applied_discount must stay < 100 or the
  // retailTotal calculation below divides by zero; both must be non-negative and
  // supplier_discount cannot exceed 100 (SEC-H3).
  if (
    typeof supplier_discount !== 'number' || typeof applied_discount !== 'number' ||
    !Number.isFinite(supplier_discount) || !Number.isFinite(applied_discount) ||
    supplier_discount < 0 || supplier_discount > 100 ||
    applied_discount < 0 || applied_discount >= 100
  ) {
    return res.status(400).json({ error: 'Zľavy musia byť čísla v rozsahu 0–100 (applied_discount < 100)' });
  }

  if (supplier_discount <= applied_discount) {
    return res.status(400).json({ error: 'supplier_discount musí byť väčší ako applied_discount' });
  }

  // ⚠ FUP-T15 — `source_cycle_id` and every element of the client-supplied
  // `friend_ids` reach binds here (the route only checks that `friend_ids` IS a
  // non-empty array, never what is in it). Unbindable ⇒ `undefined` ⇒ binds as NULL
  // ⇒ the cycle lookup misses and answers this route's own 404, and an element that
  // resolves to no friend takes the `continue` an unknown id already took. Nothing
  // new is refused and no new message exists.
  const sourceCycleIdValue = bindValue(source_cycle_id);

  // Validate cycle exists
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(sourceCycleIdValue);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }

  const createdVouchers = [];

  for (const rawFriendId of friend_ids) {
    const friendId = bindValue(rawFriendId);

    // Skip if friend already has a pending voucher for this cycle
    const existingVoucher = db.prepare(
      "SELECT id FROM vouchers WHERE friend_id = ? AND source_cycle_id = ? AND status = 'pending'"
    ).get(friendId, sourceCycleIdValue);
    if (existingVoucher) {
      continue;
    }

    // Get friend's submitted order for this cycle
    const order = db.prepare(
      "SELECT * FROM orders WHERE friend_id = ? AND cycle_id = ? AND status = 'submitted'"
    ).get(friendId, sourceCycleIdValue);
    if (!order) {
      continue;
    }

    const orderTotal = order.total;
    const retailTotal = Math.round((orderTotal / (1 - applied_discount / 100)) * 100) / 100;
    const voucherAmount = Math.round((retailTotal * (supplier_discount - applied_discount) / 100) * 100) / 100;

    const result = db.prepare(`
      INSERT INTO vouchers (friend_id, source_cycle_id, supplier_discount, applied_discount, order_total, retail_total, voucher_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(friendId, sourceCycleIdValue, supplier_discount, applied_discount, orderTotal, retailTotal, voucherAmount);

    const voucher = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(result.lastInsertRowid);
    createdVouchers.push(voucher);
  }

  res.status(201).json({ vouchers: createdVouchers, count: createdVouchers.length });
});

// GET / — List all vouchers with friend name and cycle name (admin only)
router.get('/', requireAdmin, (req, res) => {
  // ⚠ FUP-T15 — both filters come from the query string, where `?status[a]=1` is an
  // OBJECT. They were pushed straight into `params` and bound (500 + ~1.1 KB of
  // stack). Unbindable ⇒ `undefined` ⇒ the filter is simply not applied, which is
  // exactly what an absent filter does.
  const status = bindValue(req.query.status);
  const source_cycle_id = bindValue(req.query.source_cycle_id);

  let sql = `
    SELECT v.*, f.name as friend_name, c.name as cycle_name
    FROM vouchers v
    JOIN friends f ON f.id = v.friend_id
    JOIN order_cycles c ON c.id = v.source_cycle_id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    sql += ' AND v.status = ?';
    params.push(status);
  }

  if (source_cycle_id) {
    sql += ' AND v.source_cycle_id = ?';
    params.push(source_cycle_id);
  }

  sql += ' ORDER BY v.created_at DESC';

  const vouchers = db.prepare(sql).all(...params);
  res.json(vouchers);
});

// GET /cycle/:cycleId/friends — Get friends with submitted orders in a cycle (admin only)
router.get('/cycle/:cycleId/friends', requireAdmin, (req, res) => {
  const { cycleId } = req.params;

  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }

  const friends = db.prepare(`
    SELECT f.id, f.name, o.total as order_total
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    WHERE o.cycle_id = ? AND o.status = 'submitted'
    ORDER BY f.name ASC
  `).all(cycleId);

  res.json(friends);
});

// GET /pending — Get pending vouchers for authenticated friend
router.get('/pending', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // For token auth, friendId comes from validation; for shared password, from query param.
  // ⚠ FUP-T15 — the query half is client-shaped: `?friendId[a]=1` was bound directly
  // into the SELECT below (500 + ~1.1 KB of stack). The presence test stays on the RAW
  // value — a present-but-unbindable id must be answered like an id belonging to
  // nobody (an empty list), not like a missing one (this route's 400).
  const friendId = validation.friendId || req.query.friendId;
  if (!friendId) {
    return res.status(400).json({ error: 'friendId je povinný pre zdieľané heslo' });
  }

  const vouchers = db.prepare(`
    SELECT v.*, c.name as cycle_name
    FROM vouchers v
    JOIN order_cycles c ON c.id = v.source_cycle_id
    WHERE v.friend_id = ? AND v.status = 'pending'
    ORDER BY v.created_at DESC
  `).all(bindValue(friendId));

  res.json(vouchers);
});

// POST /:id/resolve — Accept or decline a voucher
router.post('/:id/resolve', (req, res) => {
  const { id } = req.params;
  const { action } = req.body;

  if (!action || !['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: "action musí byť 'accept' alebo 'decline'" });
  }

  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // ⚠ FUP-T15 — the recorded blocker here ("`voucher.friend_id !== Number(friendId)`
  // is NaN-true, so a malformed id 403s first") did NOT fully hold, in both
  // directions: `Number()` is a ToPrimitive call, so `?friendId[toString]=1` THREW
  // inside the guard itself (500 + full stack), and `?friendId[]=<owner>` passed it
  // and reached the INSERT below — which mints a REAL ledger credit. Sanitizing at
  // the source closes both: an unbindable id fails the ownership comparison and
  // takes this route's existing 403, and no `transactions` row is written.
  const friendId = validation.friendId || req.query.friendId;
  if (!friendId) {
    return res.status(400).json({ error: 'friendId je povinný pre zdieľané heslo' });
  }
  // Sanitized once, here, and used for BOTH the ownership comparison and the INSERT.
  const friendIdValue = bindValue(friendId);

  const voucher = db.prepare(`
    SELECT v.*, c.name as cycle_name
    FROM vouchers v
    JOIN order_cycles c ON c.id = v.source_cycle_id
    WHERE v.id = ?
  `).get(id);

  if (!voucher) {
    return res.status(404).json({ error: 'Voucher nebol nájdený' });
  }

  if (voucher.status !== 'pending') {
    return res.status(400).json({ error: 'Voucher nie je v stave pending' });
  }

  if (voucher.friend_id !== Number(friendIdValue)) {
    return res.status(403).json({ error: 'Tento voucher nepatrí vám' });
  }

  const resolvedAt = new Date().toISOString();

  if (action === 'accept') {
    // Create adjustment transaction with +voucher_amount
    const note = `Voucher z cyklu ${voucher.cycle_name}`;
    const txResult = db.prepare(`
      INSERT INTO transactions (friend_id, type, amount, note)
      VALUES (?, 'adjustment', ?, ?)
    `).run(friendIdValue, voucher.voucher_amount, note);

    const transactionId = txResult.lastInsertRowid;

    db.prepare(`
      UPDATE vouchers SET status = 'accepted', transaction_id = ?, resolved_at = ? WHERE id = ?
    `).run(transactionId, resolvedAt, id);
  } else {
    // decline
    db.prepare(`
      UPDATE vouchers SET status = 'declined', resolved_at = ? WHERE id = ?
    `).run(resolvedAt, id);
  }

  const updatedVoucher = db.prepare(`
    SELECT v.*, c.name as cycle_name
    FROM vouchers v
    JOIN order_cycles c ON c.id = v.source_cycle_id
    WHERE v.id = ?
  `).get(id);

  res.json(updatedVoucher);
});

export default router;
