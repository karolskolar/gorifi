import { Router } from 'express';
import { nanoid } from 'nanoid';
import db, { generateUid } from '../db/schema.js';

const router = Router();

// Helper: Validate global friends password from X-Friends-Password header
function validateFriendsPassword(req) {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'friends_password'").get();
  if (!setting || !setting.value) {
    return { error: 'Heslo pre priateľov nie je nastavené', status: 400 };
  }

  const password = req.headers['x-friends-password'];
  if (password !== setting.value) {
    return { error: 'Nesprávne heslo', status: 401 };
  }

  return { valid: true };
}

// POST /friends/auth - Global authentication for friends
router.post('/auth', (req, res) => {
  const { password, friendId } = req.body;

  // Validate password against global friends_password
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'friends_password'").get();
  if (!setting || !setting.value) {
    return res.status(400).json({ error: 'Heslo pre priateľov nie je nastavené' });
  }

  if (password !== setting.value) {
    return res.status(401).json({ error: 'Nesprávne heslo' });
  }

  // Validate friend exists and is active (optional - honor system)
  if (friendId) {
    const friend = db.prepare('SELECT id, name FROM friends WHERE id = ? AND active = 1').get(friendId);
    if (!friend) {
      return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
    }
    return res.json({ success: true, friend });
  }

  res.json({ success: true });
});

// GET /friends/cycles - List cycles for authenticated friend
router.get('/cycles', (req, res) => {
  const validation = validateFriendsPassword(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const friendId = req.query.friendId;

  // Get all cycles (open, locked, completed) with stored total_friends
  const cycles = db.prepare(`
    SELECT c.id, c.name, c.status, c.created_at, c.total_friends, c.expected_date
    FROM order_cycles c
    WHERE c.name != '_placeholder'
    ORDER BY c.created_at DESC
  `).all();

  // Add friend's order status and cycle progress to each cycle
  const cyclesWithOrders = cycles.map(cycle => {
    let hasOrder = false;
    let orderTotal = 0;
    let orderStatus = null;

    if (friendId) {
      const order = db.prepare(`
        SELECT o.id, o.status, o.total
        FROM orders o
        WHERE o.cycle_id = ? AND o.friend_id = ? AND o.status = 'submitted'
      `).get(cycle.id, friendId);

      if (order) {
        hasOrder = true;
        orderTotal = order.total;
        orderStatus = order.status;
      }
    }

    // Get total kilos for this cycle (all submitted orders)
    const kilosResult = db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN oi.variant = '150g' THEN oi.quantity * 0.15
          WHEN oi.variant = '200g' THEN oi.quantity * 0.2
          WHEN oi.variant = '250g' THEN oi.quantity * 0.25
          WHEN oi.variant = '1kg' THEN oi.quantity * 1.0
          WHEN oi.variant = '20pc5g' THEN oi.quantity * 0.1
          ELSE 0
        END
      ), 0) as totalKilos
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.cycle_id = ? AND o.status = 'submitted'
    `).get(cycle.id);

    // Count submitted orders (unique friends) for this cycle
    const submittedResult = db.prepare(`
      SELECT COUNT(DISTINCT o.friend_id) as submittedOrders
      FROM orders o
      WHERE o.cycle_id = ? AND o.status = 'submitted'
    `).get(cycle.id);

    return {
      ...cycle,
      hasOrder,
      orderTotal,
      orderStatus,
      totalKilos: kilosResult.totalKilos,
      submittedOrders: submittedResult.submittedOrders,
      totalFriends: cycle.total_friends || 0
    };
  });

  res.json(cyclesWithOrders);
});

// Get all friends (global, optionally filter by active status) with balance
router.get('/', (req, res) => {
  const activeOnly = req.query.active === 'true';
  const sql = activeOnly
    ? `SELECT f.*, COALESCE(SUM(t.amount), 0) as balance
       FROM friends f
       LEFT JOIN transactions t ON t.friend_id = f.id
       WHERE f.active = 1
       GROUP BY f.id
       ORDER BY f.name`
    : `SELECT f.*, COALESCE(SUM(t.amount), 0) as balance
       FROM friends f
       LEFT JOIN transactions t ON t.friend_id = f.id
       GROUP BY f.id
       ORDER BY f.name`;
  const friends = db.prepare(sql).all();
  res.json(friends);
});

// Get friend balance and recent transactions (for friend portal, requires friend auth)
router.get('/:id/balance', (req, res) => {
  const validation = validateFriendsPassword(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const friendId = req.params.id;

  const friend = db.prepare(`
    SELECT f.id, f.name, COALESCE(SUM(t.amount), 0) as balance
    FROM friends f
    LEFT JOIN transactions t ON t.friend_id = f.id
    WHERE f.id = ?
    GROUP BY f.id
  `).get(friendId);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Get last 5 transactions
  const transactions = db.prepare(`
    SELECT t.id, t.type, t.amount, t.note, t.created_at, c.name as cycle_name
    FROM transactions t
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN order_cycles c ON c.id = o.cycle_id
    WHERE t.friend_id = ?
    ORDER BY t.created_at DESC
    LIMIT 5
  `).all(friendId);

  res.json({
    balance: friend.balance,
    transactions
  });
});

// Get friend detail with balance, transactions, and orders
router.get('/:id/detail', (req, res) => {
  const friendId = req.params.id;

  const friend = db.prepare(`
    SELECT f.*, COALESCE(SUM(t.amount), 0) as balance
    FROM friends f
    LEFT JOIN transactions t ON t.friend_id = f.id
    WHERE f.id = ?
    GROUP BY f.id
  `).get(friendId);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Get all transactions for this friend
  const transactions = db.prepare(`
    SELECT t.*, o.cycle_id, c.name as cycle_name
    FROM transactions t
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN order_cycles c ON c.id = o.cycle_id
    WHERE t.friend_id = ?
    ORDER BY t.created_at DESC
  `).all(friendId);

  // Get all orders for this friend
  const orders = db.prepare(`
    SELECT o.*, c.name as cycle_name
    FROM orders o
    JOIN order_cycles c ON c.id = o.cycle_id
    WHERE o.friend_id = ? AND o.status = 'submitted'
    ORDER BY o.submitted_at DESC
  `).all(friendId);

  res.json({
    friend,
    transactions,
    orders
  });
});

// Create new friend (global, no cycle_id required)
router.post('/', (req, res) => {
  const { name, display_name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Prihlasovacie meno je povinné' });
  }

  // Generate unique access token (kept for backwards compatibility)
  const access_token = nanoid(12);

  // Generate unique UID (8 alphanumeric characters)
  let uid = generateUid();
  // Ensure uniqueness (unlikely to collide, but check anyway)
  while (db.prepare('SELECT id FROM friends WHERE uid = ?').get(uid)) {
    uid = generateUid();
  }

  // cycle_id column still has foreign key constraint, so we need a valid cycle_id
  // Use the first available cycle, or create a placeholder cycle if none exist
  let cycle = db.prepare('SELECT id FROM order_cycles ORDER BY id LIMIT 1').get();
  if (!cycle) {
    const cycleResult = db.prepare(`INSERT INTO order_cycles (name, status) VALUES ('_placeholder', 'completed')`).run();
    cycle = { id: cycleResult.lastInsertRowid };
  }

  const result = db.prepare(`
    INSERT INTO friends (cycle_id, name, display_name, uid, access_token, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(cycle.id, name, display_name || null, uid, access_token);

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(friend);
});

// Update friend (name, display_name, and/or active status) - Admin endpoint
router.patch('/:id', (req, res) => {
  const { name, display_name, active } = req.body;
  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  const updates = [];
  const values = [];

  if (name !== undefined) {
    updates.push('name = ?');
    values.push(name);
  }
  if (display_name !== undefined) {
    updates.push('display_name = ?');
    values.push(display_name || null);
  }
  if (active !== undefined) {
    updates.push('active = ?');
    values.push(active ? 1 : 0);
  }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE friends SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Update own profile (friend can update their login name only) - requires friends password
// Note: display_name is admin-only and cannot be changed by friends
router.patch('/:id/profile', (req, res) => {
  const validation = validateFriendsPassword(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const { name } = req.body;
  const friendId = req.params.id;

  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  if (name !== undefined) {
    if (!name.trim()) {
      return res.status(400).json({ error: 'Prihlasovacie meno je povinné' });
    }
    db.prepare('UPDATE friends SET name = ? WHERE id = ?').run(name.trim(), friendId);
  }

  const updated = db.prepare('SELECT id, name, uid FROM friends WHERE id = ?').get(friendId);
  res.json(updated);
});

// Delete friend (blocked if balance is non-zero)
router.delete('/:id', (req, res) => {
  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Check balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(req.params.id);

  // Use small epsilon for floating point comparison
  if (Math.abs(balanceResult.balance) > 0.01) {
    return res.status(400).json({
      error: `Priateľ má nenulový zostatok (${balanceResult.balance.toFixed(2)} EUR). Pred vymazaním vyrovnajte zostatok.`
    });
  }

  const result = db.prepare('DELETE FROM friends WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

export default router;
