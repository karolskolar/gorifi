import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

// Get order by friend's access token
router.get('/token/:token', (req, res) => {
  const friend = db.prepare('SELECT * FROM friends WHERE access_token = ?').get(req.params.token);

  if (!friend) {
    return res.status(404).json({ error: 'Neplatny odkaz' });
  }

  // Get or create order for this friend
  let order = db.prepare(`
    SELECT * FROM orders WHERE friend_id = ?
  `).get(friend.id);

  if (!order) {
    const result = db.prepare(`
      INSERT INTO orders (friend_id, cycle_id) VALUES (?, ?)
    `).run(friend.id, friend.cycle_id);
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  }

  // Get order items
  const items = db.prepare(`
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);

  // Get cycle info
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(friend.cycle_id);

  res.json({
    order,
    items,
    friend: { id: friend.id, name: friend.name },
    cycle
  });
});

// Update cart (add/update/remove items)
router.put('/token/:token', (req, res) => {
  const friend = db.prepare('SELECT * FROM friends WHERE access_token = ?').get(req.params.token);

  if (!friend) {
    return res.status(404).json({ error: 'Neplatny odkaz' });
  }

  // Check if cycle is locked
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(friend.cycle_id);
  if (cycle.status === 'locked' || cycle.status === 'completed') {
    return res.status(403).json({ error: 'Objednavky su uzamknute' });
  }

  // Get or create order
  let order = db.prepare('SELECT * FROM orders WHERE friend_id = ?').get(friend.id);

  if (!order) {
    const result = db.prepare(`
      INSERT INTO orders (friend_id, cycle_id) VALUES (?, ?)
    `).run(friend.id, friend.cycle_id);
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  }

  const { items } = req.body; // Array of { product_id, variant, quantity }

  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'items musia byt pole' });
  }

  // Update items in a transaction
  const updateItems = db.transaction((orderItems) => {
    // Clear existing items
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);

    let total = 0;

    for (const item of orderItems) {
      if (item.quantity <= 0) continue;

      // Get product and price
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) continue;

      const price = item.variant === '1kg' ? product.price_1kg : product.price_250g;
      if (!price) continue;

      db.prepare(`
        INSERT INTO order_items (order_id, product_id, variant, quantity, price)
        VALUES (?, ?, ?, ?, ?)
      `).run(order.id, item.product_id, item.variant, item.quantity, price);

      total += price * item.quantity;
    }

    // Update order total
    db.prepare('UPDATE orders SET total = ?, status = ? WHERE id = ?').run(total, 'draft', order.id);

    return total;
  });

  updateItems(items);

  // Return updated order
  const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const updatedItems = db.prepare(`
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);

  res.json({
    order: updatedOrder,
    items: updatedItems,
    friend: { id: friend.id, name: friend.name },
    cycle
  });
});

// Submit order
router.post('/token/:token/submit', (req, res) => {
  const friend = db.prepare('SELECT * FROM friends WHERE access_token = ?').get(req.params.token);

  if (!friend) {
    return res.status(404).json({ error: 'Neplatny odkaz' });
  }

  // Check if cycle is locked
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(friend.cycle_id);
  if (cycle.status === 'locked' || cycle.status === 'completed') {
    return res.status(403).json({ error: 'Objednavky su uzamknute' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE friend_id = ?').get(friend.id);

  if (!order) {
    return res.status(404).json({ error: 'Objednavka neexistuje' });
  }

  // Check if order has items
  const itemCount = db.prepare('SELECT COUNT(*) as count FROM order_items WHERE order_id = ?').get(order.id);
  if (itemCount.count === 0) {
    return res.status(400).json({ error: 'Objednavka je prazdna' });
  }

  // Submit order
  db.prepare(`
    UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(order.id);

  const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const items = db.prepare(`
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);

  res.json({
    order: updatedOrder,
    items,
    friend: { id: friend.id, name: friend.name },
    cycle
  });
});

// Admin: Mark order as paid/unpaid
router.patch('/:id/paid', (req, res) => {
  const { paid } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Objednavka neexistuje' });
  }

  db.prepare('UPDATE orders SET paid = ? WHERE id = ?').run(paid ? 1 : 0, req.params.id);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Admin: Get all orders for a cycle
router.get('/cycle/:cycleId', (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, f.name as friend_name
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    WHERE o.cycle_id = ?
    ORDER BY o.submitted_at DESC
  `).all(req.params.cycleId);

  res.json(orders);
});

export default router;
