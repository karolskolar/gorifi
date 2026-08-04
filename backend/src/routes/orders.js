import { Router } from 'express';
import db from '../db/schema.js';
import { validateFriendAuth, getAuthMode } from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { packOrder, unpackOrder, packingItemStats } from '../helpers/packing.js';
import { gramsByProductFromItems, stockViolations } from '../helpers/stock.js';
import { basePriceForVariant, applyMarkup } from '../helpers/pricing.js';
import { cycleSubOrdersByHost } from '../helpers/guest-orders.js';

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

// SEC-A3: bind an order operation to the authenticated friend. When a Bearer
// token is present its friendId must equal the :friendId in the URL (closes the
// friend-vs-friend IDOR). Shared/cycle-password auth carries no identity and is
// permitted only in legacy mode as a migration window; in 'modern' mode a token
// is required. validateCyclePassword still validates the password itself.
function enforceOrderOwnership(req, friendId) {
  const auth = validateFriendAuth(req);
  if (auth.friendId != null) {
    if (String(auth.friendId) !== String(friendId)) {
      return { error: 'Nemáte oprávnenie na túto objednávku', status: 403 };
    }
    return {};
  }
  if (getAuthMode() === 'modern') {
    return { error: 'Prihláste sa svojím menom a heslom', status: 401 };
  }
  return {};
}

// Get order by cycle and friend (password protected)
router.get('/cycle/:cycleId/friend/:friendId', (req, res) => {
  const { cycleId, friendId } = req.params;

  // Validate password
  const validation = validateCyclePassword(req, cycleId);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // SEC-A3: the authenticated friend may only act on their own order
  const ownership = enforceOrderOwnership(req, friendId);
  if (ownership.error) {
    return res.status(ownership.status).json({ error: ownership.error });
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

  // SEC-A3: the authenticated friend may only act on their own order
  const ownership = enforceOrderOwnership(req, friendId);
  if (ownership.error) {
    return res.status(ownership.status).json({ error: ownership.error });
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

  // Stock limit validation — counts OTHER friends' submitted orders AND every
  // live guest sub-order in this cycle (helpers/stock.js). Runs outside the write
  // transaction below: safe only single-process, see the warning in that helper.
  const violations = stockViolations(cycleId, gramsByProductFromItems(items), { excludeFriendId: friendId });
  if (violations.length > 0) {
    return res.status(400).json({
      error: 'Prekročený limit zásob',
      details: violations
    });
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

      // An UNKNOWN variant is dropped, not silently priced at the 250g price:
      // that old fallback let a client buy real goods under a made-up variant
      // that helpers/stock.js scores at 0 g, walking straight past
      // products.stock_limit_g. ('unit' stays priceable — see helpers/pricing.js.)
      const basePrice = basePriceForVariant(product, item.variant);
      if (!basePrice) continue;

      // Apply markup to get final price (round to 2 decimal places)
      const price = applyMarkup(basePrice, markupRatio);

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

  // SEC-A3: the authenticated friend may only act on their own order
  const ownership = enforceOrderOwnership(req, friendId);
  if (ownership.error) {
    return res.status(ownership.status).json({ error: ownership.error });
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

  // Stock limit validation on submit — a draft that was legal when it was saved
  // must not slip through after other friends OR guests took the rest of the
  // stock in the meantime (helpers/stock.js). Same single-process caveat as the
  // cart PUT: the check is not inside a transaction with the write.
  const orderItems = db.prepare('SELECT product_id, variant, quantity FROM order_items WHERE order_id = ?').all(order.id);
  const submitViolations = stockViolations(cycleId, gramsByProductFromItems(orderItems), { excludeFriendId: friendId });
  if (submitViolations.length > 0) {
    return res.status(400).json({
      error: 'Prekročený limit zásob',
      details: submitViolations
    });
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
router.patch('/:id/paid', requireAdmin, (req, res) => {
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
router.patch('/:id/packed', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Objednávka neexistuje' });
  }

  if (order.status !== 'submitted') {
    return res.status(400).json({ error: 'Len odoslané objednávky môžu byť označené ako zabalené' });
  }

  const newPackedStatus = order.packed ? 0 : 1;

  // Gate: an order may only be marked packed once every one of its items has
  // been individually checked off in the Distribution view (persisted
  // order_items.packed). This makes the "Zabaliť" button a deliberate final
  // step and matches the server-side rule in the spec (Decision 3 / UC-GSO-011).
  //
  // GSO-T7 completed the rule: `packingItemStats()` UNIONs the guest items placed
  // through this host's share link for this cycle (cancelled sub-orders excluded),
  // so a colleague's untouched bag blocks the pack exactly like an own item does.
  // The requirement is therefore "at least one item across own + guest, and all of
  // them packed" — a host with zero own items but guest items IS packable, which is
  // why the count is no longer taken over `order_items` alone.
  //
  // Zero items overall still 409s: there is nothing to check off, so nothing to
  // confirm. (Unreachable through the API today — emptying a friend's cart deletes
  // the order row instead of leaving a zero-item one — but it keeps the endpoint
  // agreeing with the frontend, whose "Zabaliť" is disabled in that state.)
  if (newPackedStatus === 1) {
    const itemStats = packingItemStats({
      orderId: order.id,
      friendId: order.friend_id,
      cycleId: order.cycle_id,
    });
    if (itemStats.total === 0 || (itemStats.packed_count || 0) < itemStats.total) {
      return res.status(409).json({ error: 'Najprv označ všetky položky ako zabalené' });
    }
  }

  // Use transaction to ensure consistency
  const togglePacked = db.transaction(() => {
    if (newPackedStatus === 1) {
      packOrder(order);
    } else {
      unpackOrder(order);
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
router.get('/cycle/:cycleId', requireAdmin, (req, res) => {
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

  // GSO-T6 (§UC-GSO-009): the guest sub-orders placed through each host's share
  // link, NESTED under that host's row — the admin sees them where the money and
  // the bags are, not in a separate list. Each carries its items plus both
  // single-owner flags: `paid` (the admin toggles it via
  // `PATCH /api/guest-orders/:id/paid`) and `delivered` (the HOST's hand-over tick,
  // read-only here).
  //
  // Always an array, never undefined, so the client has one shape to render.
  const subOrdersByHost = cycleSubOrdersByHost(cycleId);
  for (const order of orders) {
    order.guest_orders = subOrdersByHost.get(order.friend_id) || [];
  }

  // §Edge Cases, "host has no own order at lock time": a host whose colleagues
  // ordered but who ordered nothing themselves must still appear, or their guests
  // (and the guests' money) would be invisible on this screen. The placeholder loop
  // above only covers ACTIVE friends, so a deactivated host — whose link 410s for
  // new guests while the existing sub-orders live on — needs one built here.
  const listedFriends = new Set(orders.map(o => o.friend_id));
  for (const [hostFriendId, subOrders] of subOrdersByHost) {
    if (listedFriends.has(hostFriendId)) continue;
    orders.push({
      id: null,
      friend_id: hostFriendId,
      friend_name: subOrders[0].host_name,
      friend_balance: balanceByFriend[hostFriendId] ?? 0,
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
      count_unit: 0,
      guest_orders: subOrders
    });
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
