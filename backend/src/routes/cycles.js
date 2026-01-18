import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

// Get all order cycles
router.get('/', (req, res) => {
  const cycles = db.prepare(`
    SELECT c.*,
           COUNT(DISTINCT CASE WHEN o.status = 'submitted' THEN o.id END) as orders_count
    FROM order_cycles c
    LEFT JOIN orders o ON o.cycle_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(cycles);
});

// Get single cycle
router.get('/:id', (req, res) => {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }
  res.json(cycle);
});

// Get public cycle info (no auth required) - for friend ordering page
router.get('/:id/public', (req, res) => {
  const cycle = db.prepare('SELECT id, name, status FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }

  // Return all active friends (global, not cycle-specific)
  const friends = db.prepare('SELECT id, name FROM friends WHERE active = 1 ORDER BY name').all();

  res.json({
    cycle,
    friends
  });
});

// Authenticate for cycle (validates password and friend selection)
router.post('/:id/auth', (req, res) => {
  const { password, friendId } = req.body;

  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }

  // Check password
  if (!cycle.shared_password) {
    return res.status(400).json({ error: 'Heslo nie je nastavené pre tento cyklus' });
  }

  if (password !== cycle.shared_password) {
    return res.status(401).json({ error: 'Nesprávne heslo' });
  }

  // Validate friend exists and is active (global, no cycle check)
  const friend = db.prepare('SELECT id, name FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  res.json({
    success: true,
    friend
  });
});

// Create new order cycle
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Nazov je povinny' });
  }

  const result = db.prepare('INSERT INTO order_cycles (name) VALUES (?)').run(name);
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(cycle);
});

// Update cycle (lock/unlock/complete/password)
router.patch('/:id', (req, res) => {
  const { status, name, shared_password } = req.body;
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);

  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  if (status && !['open', 'locked', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Neplatny status' });
  }

  const updates = [];
  const values = [];

  if (status) {
    updates.push('status = ?');
    values.push(status);
  }
  if (name) {
    updates.push('name = ?');
    values.push(name);
  }
  if (shared_password !== undefined) {
    updates.push('shared_password = ?');
    values.push(shared_password || null);
  }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE order_cycles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete cycle
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM order_cycles WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }
  res.status(204).send();
});

// Get order summary for cycle (for email to company)
router.get('/:id/summary', (req, res) => {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  const summary = db.prepare(`
    SELECT p.name, oi.variant, SUM(oi.quantity) as total_quantity,
           SUM(oi.quantity * oi.price) as total_price
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    WHERE o.cycle_id = ? AND o.status = 'submitted'
    GROUP BY p.id, oi.variant
    ORDER BY p.name, oi.variant
  `).all(req.params.id);

  const totalItems = summary.reduce((acc, item) => acc + item.total_quantity, 0);
  const totalPrice = summary.reduce((acc, item) => acc + item.total_price, 0);

  res.json({
    cycle,
    items: summary,
    totalItems,
    totalPrice
  });
});

// Get distribution list (per-friend orders for packing)
router.get('/:id/distribution', (req, res) => {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }

  // Get friends who have submitted orders for this cycle (global friends)
  const friendsWithOrders = db.prepare(`
    SELECT f.id, f.name, o.id as order_id, o.status, o.paid, o.total
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    WHERE o.cycle_id = ? AND o.status = 'submitted'
    ORDER BY f.name
  `).all(req.params.id);

  const distribution = friendsWithOrders.map(friend => {
    const items = db.prepare(`
      SELECT p.name as product_name, oi.variant, oi.quantity, oi.price
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
      ORDER BY p.name
    `).all(friend.order_id);

    return { ...friend, items };
  });

  res.json({ cycle, distribution });
});

export default router;
