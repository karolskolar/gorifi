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

  // Get markup ratio for price calculation (default to 1.0 if not set)
  const markupRatio = cycle.markup_ratio || 1.0;

  // Update items in a transaction
  const updateItems = db.transaction((orderItems) => {
    // Clear existing items
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);

    let total = 0;

    for (const item of orderItems) {
      if (item.quantity <= 0) continue;

      // Get product and base price
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) continue;

      let basePrice;
      if (item.variant === '1kg') basePrice = product.price_1kg;
      else if (item.variant === '20pc5g') basePrice = product.price_20pc5g;
      else if (item.variant === '150g') basePrice = product.price_150g;
      else if (item.variant === '200g') basePrice = product.price_200g;
      else basePrice = product.price_250g;
      if (!basePrice) continue;

      // Apply markup to get final price (round to 2 decimal places)
      const price = Math.round(basePrice * markupRatio * 100) / 100;

      db.prepare(`
        INSERT INTO order_items (order_id, product_id, variant, quantity, price)
        VALUES (?, ?, ?, ?, ?)
      `).run(order.id, item.product_id, item.variant, item.quantity, price);

      total += price * item.quantity;
    }

    // Update order total
    // If cart is now empty, delete the order entirely (order was canceled)
    // Otherwise preserve existing status
    if (total === 0) {
      db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
      return { total: 0, deleted: true };
    } else {
      db.prepare('UPDATE orders SET total = ? WHERE id = ?').run(total, order.id);
      return { total, deleted: false };
    }
  });

  const result = updateItems(items);

  // If order was deleted (canceled), return empty response
  if (result.deleted) {
    return res.json({
      order: null,
      items: [],
      friend: { id: friend.id, name: friend.name },
      cycle
    });
  }

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

// Admin: Mark order as paid/unpaid (creates payment transaction)
router.patch('/:id/paid', (req, res) => {
  const { paid } = req.body;
  const order = db.prepare(`
    SELECT o.*, c.name as cycle_name
    FROM orders o
    JOIN order_cycles c ON c.id = o.cycle_id
    WHERE o.id = ?
  `).get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Objednavka neexistuje' });
  }

  // Use transaction to ensure consistency
  const togglePaid = db.transaction(() => {
    if (paid && !order.paid) {
      // Marking as paid - create payment transaction
      db.prepare(`
        INSERT INTO transactions (friend_id, order_id, type, amount, note)
        VALUES (?, ?, 'payment', ?, ?)
      `).run(order.friend_id, order.id, order.total, order.cycle_name);
    } else if (!paid && order.paid) {
      // Marking as unpaid - create reversal transaction (negative payment)
      db.prepare(`
        INSERT INTO transactions (friend_id, order_id, type, amount, note)
        VALUES (?, ?, 'payment', ?, ?)
      `).run(order.friend_id, order.id, -order.total, `${order.cycle_name} - storno`);
    }

    db.prepare('UPDATE orders SET paid = ? WHERE id = ?').run(paid ? 1 : 0, req.params.id);
  });

  togglePaid();

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);

  // Get updated balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(order.friend_id);

  res.json({
    ...updated,
    friend_balance: balanceResult.balance
  });
});

// Admin: Toggle order packed status (creates charge/reversal transaction)
router.patch('/:id/packed', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Objednávka neexistuje' });
  }

  if (order.status !== 'submitted') {
    return res.status(400).json({ error: 'Len odoslané objednávky môžu byť označené ako zabalené' });
  }

  const newPackedStatus = order.packed ? 0 : 1;

  // Use transaction to ensure consistency
  const togglePacked = db.transaction(() => {
    if (newPackedStatus === 1) {
      // Marking as packed - create charge transaction (negative amount)
      db.prepare(`
        INSERT INTO transactions (friend_id, order_id, type, amount, note)
        VALUES (?, ?, 'charge', ?, NULL)
      `).run(order.friend_id, order.id, -order.total);

      db.prepare('UPDATE orders SET packed = 1, packed_at = CURRENT_TIMESTAMP WHERE id = ?').run(order.id);
    } else {
      // Unpacking - create reversal transaction (positive amount to cancel the charge)
      db.prepare(`
        INSERT INTO transactions (friend_id, order_id, type, amount, note)
        VALUES (?, ?, 'charge', ?, 'Stornované')
      `).run(order.friend_id, order.id, order.total);

      db.prepare('UPDATE orders SET packed = 0, packed_at = NULL WHERE id = ?').run(order.id);
    }
  });

  togglePacked();

  const updated = db.prepare(`
    SELECT o.*, f.name as friend_name
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    WHERE o.id = ?
  `).get(req.params.id);

  // Get updated balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(order.friend_id);

  res.json({
    ...updated,
    friend_balance: balanceResult.balance
  });
});

// Admin: Get all orders for a cycle (includes all active friends)
router.get('/cycle/:cycleId', (req, res) => {
  const cycleId = req.params.cycleId;

  // Get all active friends with balance
  const allFriends = db.prepare(`
    SELECT f.id, f.name, COALESCE(SUM(t.amount), 0) as balance
    FROM friends f
    LEFT JOIN transactions t ON t.friend_id = f.id
    WHERE f.active = 1
    GROUP BY f.id
    ORDER BY f.name
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
        SELECT oi.*, p.name as product_name, p.purpose
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?
        ORDER BY
          CASE p.purpose
            WHEN 'Espresso' THEN 1
            WHEN 'Filter' THEN 2
            WHEN 'Kapsule' THEN 3
            ELSE 4
          END,
          p.name, oi.variant
      `).all(existingOrder.id);

      existingOrder.count_150g = existingOrder.items
        .filter(i => i.variant === '150g')
        .reduce((sum, i) => sum + i.quantity, 0);
      existingOrder.count_200g = existingOrder.items
        .filter(i => i.variant === '200g')
        .reduce((sum, i) => sum + i.quantity, 0);
      existingOrder.count_250g = existingOrder.items
        .filter(i => i.variant === '250g')
        .reduce((sum, i) => sum + i.quantity, 0);
      existingOrder.count_1kg = existingOrder.items
        .filter(i => i.variant === '1kg')
        .reduce((sum, i) => sum + i.quantity, 0);
      existingOrder.count_20pc5g = existingOrder.items
        .filter(i => i.variant === '20pc5g')
        .reduce((sum, i) => sum + i.quantity, 0);
      existingOrder.friend_balance = friend.balance;

      return existingOrder;
    } else {
      // Friend has no order - return placeholder
      return {
        id: null,
        friend_id: friend.id,
        friend_name: friend.name,
        friend_balance: friend.balance,
        cycle_id: parseInt(cycleId),
        status: 'none',
        paid: 0,
        packed: 0,
        total: 0,
        items: [],
        count_150g: 0,
        count_200g: 0,
        count_250g: 0,
        count_1kg: 0,
        count_20pc5g: 0
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
