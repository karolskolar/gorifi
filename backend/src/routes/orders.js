import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

// Helper: Validate password from X-Friends-Password (global) or X-Cycle-Password (legacy) header
function validateCyclePassword(req, cycleId) {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return { error: 'Cyklus nebol najdeny', status: 404 };
  }

  // Try global friends password first (new system)
  const friendsPassword = req.headers['x-friends-password'];
  if (friendsPassword) {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'friends_password'").get();
    if (setting && setting.value && friendsPassword === setting.value) {
      return { cycle };
    }
  }

  // Fall back to per-cycle password (legacy)
  const cyclePassword = req.headers['x-cycle-password'];
  if (cycle.shared_password && cyclePassword === cycle.shared_password) {
    return { cycle };
  }

  // Check if any password was provided
  if (!friendsPassword && !cyclePassword) {
    return { error: 'Heslo nie je poskytnuté', status: 401 };
  }

  return { error: 'Nespravne heslo', status: 401 };
}

// Get order by cycle and friend (password protected)
router.get('/cycle/:cycleId/friend/:friendId', (req, res) => {
  const { cycleId, friendId } = req.params;

  // Validate password
  const validation = validateCyclePassword(req, cycleId);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // Validate friend exists and is active (global, no cycle check)
  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  // Get or create order for this friend in this cycle
  let order = db.prepare('SELECT * FROM orders WHERE friend_id = ? AND cycle_id = ?').get(friendId, cycleId);

  if (!order) {
    const result = db.prepare(`
      INSERT INTO orders (friend_id, cycle_id) VALUES (?, ?)
    `).run(friendId, cycleId);
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  }

  // Get order items
  const items = db.prepare(`
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);

  res.json({
    order,
    items,
    friend: { id: friend.id, name: friend.name },
    cycle: validation.cycle
  });
});

// Update cart by cycle and friend (password protected)
router.put('/cycle/:cycleId/friend/:friendId', (req, res) => {
  const { cycleId, friendId } = req.params;

  // Validate password
  const validation = validateCyclePassword(req, cycleId);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }
  const cycle = validation.cycle;

  // Check if cycle is locked
  if (cycle.status === 'locked' || cycle.status === 'completed') {
    return res.status(403).json({ error: 'Objednavky su uzamknute' });
  }

  // Validate friend exists and is active (global, no cycle check)
  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  // Get or create order for this friend in this cycle
  let order = db.prepare('SELECT * FROM orders WHERE friend_id = ? AND cycle_id = ?').get(friendId, cycleId);

  if (!order) {
    const result = db.prepare(`
      INSERT INTO orders (friend_id, cycle_id) VALUES (?, ?)
    `).run(friendId, cycleId);
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

// Submit order by cycle and friend (password protected)
router.post('/cycle/:cycleId/friend/:friendId/submit', (req, res) => {
  const { cycleId, friendId } = req.params;

  // Validate password
  const validation = validateCyclePassword(req, cycleId);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }
  const cycle = validation.cycle;

  // Check if cycle is locked
  if (cycle.status === 'locked' || cycle.status === 'completed') {
    return res.status(403).json({ error: 'Objednavky su uzamknute' });
  }

  // Validate friend exists and is active (global, no cycle check)
  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE friend_id = ? AND cycle_id = ?').get(friendId, cycleId);

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

// Admin: Get all orders for a cycle (includes all active friends)
router.get('/cycle/:cycleId', (req, res) => {
  const cycleId = req.params.cycleId;

  // Get all active friends
  const allFriends = db.prepare(`
    SELECT id, name FROM friends WHERE active = 1 ORDER BY name
  `).all();

  // Get existing orders for this cycle
  const existingOrders = db.prepare(`
    SELECT o.*, f.name as friend_name
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    WHERE o.cycle_id = ?
  `).all(cycleId);

  // Create a map of friend_id to order
  const ordersByFriend = {};
  for (const order of existingOrders) {
    ordersByFriend[order.friend_id] = order;
  }

  // Build combined list: all friends with their order (or placeholder)
  const orders = allFriends.map(friend => {
    const existingOrder = ordersByFriend[friend.id];

    if (existingOrder) {
      // Friend has an order - add items and counts
      existingOrder.items = db.prepare(`
        SELECT oi.*, p.name as product_name
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?
        ORDER BY p.name, oi.variant
      `).all(existingOrder.id);

      existingOrder.count_250g = existingOrder.items
        .filter(i => i.variant === '250g')
        .reduce((sum, i) => sum + i.quantity, 0);
      existingOrder.count_1kg = existingOrder.items
        .filter(i => i.variant === '1kg')
        .reduce((sum, i) => sum + i.quantity, 0);

      return existingOrder;
    } else {
      // Friend has no order - return placeholder
      return {
        id: null,
        friend_id: friend.id,
        friend_name: friend.name,
        cycle_id: parseInt(cycleId),
        status: 'none',
        paid: 0,
        total: 0,
        items: [],
        count_250g: 0,
        count_1kg: 0
      };
    }
  });

  // Sort: submitted first, then draft, then none (by name within each group)
  orders.sort((a, b) => {
    const statusOrder = { submitted: 0, draft: 1, none: 2 };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    return a.friend_name.localeCompare(b.friend_name);
  });

  res.json(orders);
});

export default router;
