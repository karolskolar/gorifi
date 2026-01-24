import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db/schema.js';

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

  // Get all cycles (open, locked, completed)
  const cycles = db.prepare(`
    SELECT c.id, c.name, c.status, c.created_at
    FROM order_cycles c
    WHERE c.name != '_placeholder'
    ORDER BY c.created_at DESC
  `).all();

  // Add friend's order status to each cycle
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

    return {
      ...cycle,
      hasOrder,
      orderTotal,
      orderStatus
    };
  });

  res.json(cyclesWithOrders);
});

// Get all friends (global, optionally filter by active status)
router.get('/', (req, res) => {
  const activeOnly = req.query.active === 'true';
  const sql = activeOnly
    ? 'SELECT * FROM friends WHERE active = 1 ORDER BY name'
    : 'SELECT * FROM friends ORDER BY name';
  const friends = db.prepare(sql).all();
  res.json(friends);
});

// Create new friend (global, no cycle_id required)
router.post('/', (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Meno je povinné' });
  }

  // Generate unique access token (kept for backwards compatibility)
  const access_token = nanoid(12);

  // cycle_id column still has foreign key constraint, so we need a valid cycle_id
  // Use the first available cycle, or create a placeholder cycle if none exist
  let cycle = db.prepare('SELECT id FROM order_cycles ORDER BY id LIMIT 1').get();
  if (!cycle) {
    const cycleResult = db.prepare(`INSERT INTO order_cycles (name, status) VALUES ('_placeholder', 'completed')`).run();
    cycle = { id: cycleResult.lastInsertRowid };
  }

  const result = db.prepare(`
    INSERT INTO friends (cycle_id, name, access_token, active)
    VALUES (?, ?, ?, 1)
  `).run(cycle.id, name, access_token);

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(friend);
});

// Update friend (name and/or active status)
router.patch('/:id', (req, res) => {
  const { name, active } = req.body;
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

// Delete friend
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM friends WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }
  res.status(204).send();
});

export default router;
