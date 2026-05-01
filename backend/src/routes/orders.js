import { Router } from 'express';
import db from '../db/schema.js';
import { validateFriendAuth, getAuthMode } from '../middleware/friend-auth.js';

const router = Router();

// Helper: Validate password from Bearer token, X-Friends-Password (global), or X-Cycle-Password (legacy) header
function validateCyclePassword(req, cycleId) {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return { error: 'Cyklus nebol najdeny', status: 404 };
  }

  // Try Bearer token first (new token-based auth)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const authResult = validateFriendAuth(req);
    if (authResult.valid) {
      return { cycle };
    }
  }

  // Try global friends password (shared password system) — blocked in modern mode
  const friendsPassword = req.headers['x-friends-password'];
  if (friendsPassword) {
    if (getAuthMode() === 'modern') {
      return { error: 'Spolocne heslo nie je povolene. Prihlaste sa menom a heslom.', status: 401 };
    }
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

  // Check if any auth was provided
  if (!authHeader && !friendsPassword && !cyclePassword) {
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

  // Get existing order for this friend in this cycle (don't auto-create)
  const order = db.prepare('SELECT * FROM orders WHERE friend_id = ? AND cycle_id = ?').get(friendId, cycleId);

  // Get order items if order exists
  const items = order ? db.prepare(`
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1, p.variant_label
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id) : [];

  res.json({
    order: order || null,
    items,
    friend: { id: friend.id, name: friend.name, packeta_address: friend.packeta_address || null },
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

  // Stock limit validation
  const variantGrams = {
    '150g': 150, '200g': 200, '250g': 250, '500g': 500, '1kg': 1000, '20pc5g': 100
  };

  // Group incoming items by product_id to compute total grams per product
  const newGramsByProduct = {};
  for (const item of items) {
    if (item.quantity > 0 && variantGrams[item.variant]) {
      if (!newGramsByProduct[item.product_id]) newGramsByProduct[item.product_id] = 0;
      newGramsByProduct[item.product_id] += variantGrams[item.variant] * item.quantity;
    }
  }

  // Check stock limits for affected products
  const limitedProductIds = Object.keys(newGramsByProduct).map(Number);
  if (limitedProductIds.length > 0) {
    const placeholders = limitedProductIds.map(() => '?').join(',');
    const limitedProducts = db.prepare(
      `SELECT id, name, stock_limit_g FROM products WHERE id IN (${placeholders}) AND stock_limit_g IS NOT NULL`
    ).all(...limitedProductIds);

    const violations = [];
    for (const lp of limitedProducts) {
      // Get current ordered grams from OTHER friends' submitted orders
      const currentOrdered = db.prepare(`
        SELECT oi.variant, SUM(oi.quantity) as total_qty
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = ? AND o.cycle_id = ? AND o.status = 'submitted' AND o.friend_id != ?
        GROUP BY oi.variant
      `).all(lp.id, cycleId, friendId);

      let existingGrams = 0;
      for (const row of currentOrdered) {
        existingGrams += (variantGrams[row.variant] || 0) * row.total_qty;
      }

      const requestedGrams = newGramsByProduct[lp.id] || 0;
      if (existingGrams + requestedGrams > lp.stock_limit_g) {
        const remainingG = Math.max(0, lp.stock_limit_g - existingGrams);
        violations.push(`${lp.name}: zostáva ${remainingG}g z ${lp.stock_limit_g}g`);
      }
    }

    if (violations.length > 0) {
      return res.status(400).json({
        error: 'Prekročený limit zásob',
        details: violations
      });
    }
  }

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
      else if (item.variant === '500g') basePrice = product.price_500g;
      else if (item.variant === '20pc5g') basePrice = product.price_20pc5g;
      else if (item.variant === '150g') basePrice = product.price_150g;
      else if (item.variant === '200g') basePrice = product.price_200g;
      else if (item.variant === 'unit') basePrice = product.price_unit;
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
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1, p.variant_label
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

  // Stock limit validation on submit
  const submitVariantGrams = {
    '150g': 150, '200g': 200, '250g': 250, '500g': 500, '1kg': 1000, '20pc5g': 100
  };

  const orderItems = db.prepare('SELECT product_id, variant, quantity FROM order_items WHERE order_id = ?').all(order.id);
  const submitGramsByProduct = {};
  for (const item of orderItems) {
    if (!submitGramsByProduct[item.product_id]) submitGramsByProduct[item.product_id] = 0;
    submitGramsByProduct[item.product_id] += (submitVariantGrams[item.variant] || 0) * item.quantity;
  }

  const submitProductIds = Object.keys(submitGramsByProduct).map(Number);
  if (submitProductIds.length > 0) {
    const ph = submitProductIds.map(() => '?').join(',');
    const limitedProds = db.prepare(
      `SELECT id, name, stock_limit_g FROM products WHERE id IN (${ph}) AND stock_limit_g IS NOT NULL`
    ).all(...submitProductIds);

    const submitViolations = [];
    for (const lp of limitedProds) {
      const currentOrdered = db.prepare(`
        SELECT oi.variant, SUM(oi.quantity) as total_qty
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = ? AND o.cycle_id = ? AND o.status = 'submitted' AND o.friend_id != ?
        GROUP BY oi.variant
      `).all(lp.id, cycleId, friendId);

      let existingGrams = 0;
      for (const row of currentOrdered) {
        existingGrams += (submitVariantGrams[row.variant] || 0) * row.total_qty;
      }

      const requestedGrams = submitGramsByProduct[lp.id] || 0;
      if (existingGrams + requestedGrams > lp.stock_limit_g) {
        const remainingG = Math.max(0, lp.stock_limit_g - existingGrams);
        submitViolations.push(`${lp.name}: zostáva ${remainingG}g z ${lp.stock_limit_g}g`);
      }
    }

    if (submitViolations.length > 0) {
      return res.status(400).json({
        error: 'Prekročený limit zásob',
        details: submitViolations
      });
    }
  }

  // Handle pickup location / parcel delivery
  const { pickup_location_id, pickup_location_note, use_parcel_delivery, packeta_address } = req.body || {};

  if (use_parcel_delivery) {
    // Validate parcel is enabled for this cycle
    if (!cycle.parcel_enabled) {
      return res.status(400).json({ error: 'Doručenie Packetou nie je pre tento cyklus dostupné' });
    }
    if (!packeta_address?.trim()) {
      return res.status(400).json({ error: 'Adresa výdajného miesta je povinná' });
    }
    // Submit with parcel delivery — clear pickup fields
    db.prepare(`
      UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
        delivery_fee = ?, packeta_address = ?,
        pickup_location_id = NULL, pickup_location_note = NULL
      WHERE id = ?
    `).run(cycle.parcel_fee || 0, packeta_address.trim(), order.id);
  } else {
    // Standard pickup — clear parcel fields
    if (pickup_location_id !== undefined && pickup_location_id !== null) {
      const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ? AND active = 1').get(pickup_location_id);
      if (!location) {
        return res.status(400).json({ error: 'Vybrané miesto vyzdvihnutia neexistuje alebo nie je aktívne' });
      }
    }

    db.prepare(`
      UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
        pickup_location_id = ?, pickup_location_note = ?,
        delivery_fee = 0, packeta_address = NULL
      WHERE id = ?
    `).run(
      pickup_location_id || null,
      pickup_location_id ? null : (pickup_location_note || null),
      order.id
    );
  }

  const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const items = db.prepare(`
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1, p.variant_label
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
    SELECT o.*, f.name as friend_name, pl.name as pickup_location_name
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    LEFT JOIN pickup_locations pl ON pl.id = o.pickup_location_id
    WHERE o.cycle_id = ?
  `).all(cycleId);

  // Create a map of friend_id to order
  const ordersByFriend = {};
  for (const order of existingOrders) {
    ordersByFriend[order.friend_id] = order;
  }

  // Build combined list
  // Friends with orders always appear; friends without orders only for non-submitted view
  const balanceByFriend = {};
  for (const f of allFriends) {
    balanceByFriend[f.id] = f.balance;
  }

  const orders = [];

  // Add friends who have orders in this cycle
  for (const order of existingOrders) {
    order.items = db.prepare(`
      SELECT oi.*, p.name as product_name, p.purpose, p.variant_label
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
    `).all(order.id);

    order.count_150g = order.items
      .filter(i => i.variant === '150g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_200g = order.items
      .filter(i => i.variant === '200g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_250g = order.items
      .filter(i => i.variant === '250g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_500g = order.items
      .filter(i => i.variant === '500g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_1kg = order.items
      .filter(i => i.variant === '1kg')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_20pc5g = order.items
      .filter(i => i.variant === '20pc5g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_unit = order.items
      .filter(i => i.variant === 'unit')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.friend_balance = balanceByFriend[order.friend_id] ?? 0;

    orders.push(order);
  }

  // Add friends without orders as placeholders
  const friendsWithOrders = new Set(existingOrders.map(o => o.friend_id));
  for (const friend of allFriends) {
    if (!friendsWithOrders.has(friend.id)) {
      orders.push({
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
        count_500g: 0,
        count_1kg: 0,
        count_20pc5g: 0,
        count_unit: 0
      });
    }
  }

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
