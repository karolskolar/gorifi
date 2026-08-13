import { Router } from 'express';
import { nanoid } from 'nanoid';
import db, { generateUid, generateInviteCode } from '../db/schema.js';
import { validateFriendAuth, requireFriendOwner, createFriendSession, invalidateFriendSessions, getAuthMode, validateUsername, isUsernameTaken, hashPassword, comparePassword } from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { authLimiter } from '../middleware/rate-limit.js';
import { getPlaceholderCycleId } from '../helpers/friend-create.js';

const router = Router();

// Remove credential material from a friend row before returning it to any
// client. access_token is a live auth credential; password_hash enables
// offline cracking; invite_code is a shareable secret. None are consumed by
// the frontend from these endpoints. Mutates and returns the object.
function sanitizeFriend(friend) {
  if (!friend) return friend;
  delete friend.password_hash;
  delete friend.access_token;
  delete friend.invite_code;
  return friend;
}

// GET /friends/auth-mode - Public endpoint to get current auth mode
router.get('/auth-mode', (req, res) => {
  res.json({ authMode: getAuthMode() });
});

// POST /friends/auth - Authentication for friends (shared password or personal credentials)
router.post('/auth', authLimiter, (req, res) => {
  const { password, friendId, username } = req.body;
  const authMode = getAuthMode();

  // Personal login: username + password
  if (username) {
    const friend = db.prepare('SELECT * FROM friends WHERE username = ? AND active = 1').get(username.toLowerCase());
    if (!friend || !friend.password_hash) {
      return res.status(401).json({ error: 'Nesprávne prihlasovacie údaje' });
    }

    if (!comparePassword(password, friend.password_hash)) {
      return res.status(401).json({ error: 'Nesprávne prihlasovacie údaje' });
    }

    const session = createFriendSession(friend.id);
    return res.json({
      success: true,
      friend: { id: friend.id, name: friend.name, uid: friend.uid, username: friend.username, packeta_address: friend.packeta_address },
      token: session.token,
      expiresAt: session.expiresAt,
      hasCredentials: true,
      // Forced-change: set when an admin reset this friend's password.
      mustChangePassword: !!friend.must_change_password
    });
  }

  // Shared password login: password + friendId
  if (authMode === 'modern') {
    return res.status(401).json({ error: 'Spoločné heslo nie je povolené. Prihláste sa menom a heslom.' });
  }

  const setting = db.prepare("SELECT value FROM settings WHERE key = 'friends_password'").get();
  if (!setting || !setting.value) {
    return res.status(400).json({ error: 'Heslo pre priateľov nie je nastavené' });
  }

  if (password !== setting.value) {
    return res.status(401).json({ error: 'Nesprávne heslo' });
  }

  if (friendId) {
    const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
    if (!friend) {
      return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
    }

    const session = createFriendSession(friend.id);
    return res.json({
      success: true,
      friend: { id: friend.id, name: friend.name, uid: friend.uid, username: friend.username, packeta_address: friend.packeta_address },
      token: session.token,
      expiresAt: session.expiresAt,
      hasCredentials: !!friend.password_hash,
      // Forced-change: set when an admin reset this friend's password. In the
      // shared-password window the frontend routes this to "set your own login".
      mustChangePassword: !!friend.must_change_password
    });
  }

  res.json({ success: true });
});

// GET /friends/login-list - Public minimal list for the legacy/transition login
// dropdown: id + name + hasCredentials only (no contact data, balances or
// usernames — the full list at GET / stays admin-only, SEC-P1). In modern mode
// the dropdown doesn't exist, so don't expose names at all.
router.get('/login-list', (req, res) => {
  if (getAuthMode() === 'modern') {
    return res.json([]);
  }
  const rows = db.prepare('SELECT id, name, password_hash FROM friends WHERE active = 1 ORDER BY name').all();
  res.json(rows.map(f => ({ id: f.id, name: f.name, hasCredentials: !!f.password_hash })));
});

// GET /friends/:id/profile - Own full profile (owner token required). Used to
// hydrate the portal after login/session-restore now that the login page no
// longer receives the admin-only friends list.
router.get('/:id/profile', (req, res) => {
  const owner = requireFriendOwner(req, req.params.id);
  if (owner.error) {
    return res.status(owner.status).json({ error: owner.error });
  }

  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(req.params.id);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }
  friend.hasCredentials = !!friend.password_hash;
  res.json(sanitizeFriend(friend));
});

// POST /friends/:id/setup-credentials - Set username + password for first time
router.post('/:id/setup-credentials', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const friendId = req.params.id;

  // If authenticated via token, verify the token owner matches the requested friend
  if (validation.friendId && String(validation.friendId) !== String(friendId)) {
    return res.status(403).json({ error: 'Nemáte oprávnenie upravovať iného používateľa' });
  }

  const { username, password } = req.body;

  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // First-time only — if credentials already set, use change-password instead
  if (friend.password_hash && friend.username) {
    return res.status(409).json({ error: 'Prihlasovacie údaje sú už nastavené. Použite zmenu hesla.' });
  }

  // Validate username
  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }

  if (isUsernameTaken(username.toLowerCase(), friendId)) {
    return res.status(409).json({ error: 'Užívateľské meno je už obsadené' });
  }

  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Heslo musí mať aspoň 8 znakov' });
  }

  db.prepare('UPDATE friends SET username = ?, password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(username.toLowerCase(), hashPassword(password), friendId);

  // Create new session with credentials
  invalidateFriendSessions(friendId);
  const session = createFriendSession(friendId);

  const updated = db.prepare('SELECT id, name, uid, username FROM friends WHERE id = ?').get(friendId);
  res.json({ success: true, friend: updated, token: session.token, expiresAt: session.expiresAt });
});

// PUT /friends/:id/change-password - Change own password (requires token auth)
router.put('/:id/change-password', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // Must be authenticated via token and match the friend ID
  if (!validation.friendId || String(validation.friendId) !== String(req.params.id)) {
    return res.status(403).json({ error: 'Nemáte oprávnenie meniť heslo iného používateľa' });
  }

  const friendId = req.params.id;
  const { currentPassword, newPassword } = req.body;

  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend || !friend.password_hash) {
    return res.status(400).json({ error: 'Nemáte nastavené osobné heslo' });
  }

  // Normal change requires the current password. But when an admin reset the
  // password (must_change_password), the valid session token already proves the
  // friend just authenticated with the admin-issued password, so skip the
  // re-entry and let them pick their own password directly (forced-change #3).
  if (!friend.must_change_password) {
    if (!comparePassword(currentPassword, friend.password_hash)) {
      return res.status(401).json({ error: 'Aktuálne heslo nie je správne' });
    }
  }

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Nové heslo musí mať aspoň 8 znakov' });
  }

  db.prepare('UPDATE friends SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(newPassword), friendId);

  // Invalidate all sessions and create a new one
  invalidateFriendSessions(friendId);
  const session = createFriendSession(friendId);

  res.json({ success: true, token: session.token, expiresAt: session.expiresAt });
});

// GET /friends/check-username/:username - Public check if username is available
router.get('/check-username/:username', (req, res) => {
  const username = req.params.username.toLowerCase();
  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.json({ available: false, error: usernameError });
  }
  const taken = isUsernameTaken(username);
  res.json({ available: !taken });
});

// GET /friends/cycles - List cycles for authenticated friend
router.get('/cycles', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const friendId = req.query.friendId;

  // Get all cycles (open, locked, completed) with stored total_friends
  const cycles = db.prepare(`
    SELECT c.id, c.name, c.status, c.created_at, c.total_friends, c.expected_date, c.type, c.plan_note
    FROM order_cycles c
    WHERE c.name != '_placeholder'
    ORDER BY c.created_at DESC
  `).all();

  // Add friend's order status to each cycle
  const cyclesWithOrders = cycles.map(cycle => {
    let hasOrder = false;
    let orderTotal = 0;
    let orderStatus = null;
    let orderKilos = 0;
    let orderItemCount = 0;
    let orderPickupName = null;
    let orderPacketa = false;

    if (friendId) {
      const order = db.prepare(`
        SELECT o.id, o.status, o.total, o.delivery_fee, o.packeta_address,
               o.pickup_location_id, o.pickup_location_note, pl.name as pickup_location_name
        FROM orders o
        LEFT JOIN pickup_locations pl ON pl.id = o.pickup_location_id
        WHERE o.cycle_id = ? AND o.friend_id = ? AND o.status = 'submitted'
      `).get(cycle.id, friendId);

      if (order) {
        hasOrder = true;
        orderTotal = (order.total || 0) + (order.delivery_fee || 0);
        orderStatus = order.status;

        // Calculate kilos for this friend's order only
        const friendKilosResult = db.prepare(`
          SELECT COALESCE(SUM(
            CASE
              WHEN oi.variant = '150g' THEN oi.quantity * 0.15
              WHEN oi.variant = '200g' THEN oi.quantity * 0.2
              WHEN oi.variant = '250g' THEN oi.quantity * 0.25
              WHEN oi.variant = '1kg' THEN oi.quantity * 1.0
              WHEN oi.variant = '20pc5g' THEN oi.quantity * 0.1
              WHEN oi.variant = 'unit' THEN oi.quantity * COALESCE(p.weight_grams, 0) / 1000.0
              ELSE 0
            END
          ), 0) as orderKilos
          FROM order_items oi
          LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ?
        `).get(order.id);
        orderKilos = friendKilosResult.orderKilos;

        // Calculate total item count (useful for bakery)
        const itemCountResult = db.prepare(`
          SELECT COALESCE(SUM(oi.quantity), 0) as itemCount
          FROM order_items oi
          WHERE oi.order_id = ?
        `).get(order.id);
        orderItemCount = itemCountResult.itemCount;
        orderPickupName = order.pickup_location_name || order.pickup_location_note || null;
        orderPacketa = !!order.packeta_address;
      }
    }

    return {
      ...cycle,
      hasOrder,
      orderTotal,
      orderStatus,
      orderKilos,
      orderItemCount,
      orderPickupName,
      orderPacketa
    };
  });

  // Filter by friend's subscriptions (if they have any)
  let filteredCycles = cyclesWithOrders;
  if (friendId) {
    const subs = db.prepare('SELECT type FROM friend_subscriptions WHERE friend_id = ?').all(friendId);
    if (subs.length > 0) {
      const subscribedTypes = subs.map(s => s.type);
      filteredCycles = cyclesWithOrders.filter(c => {
        // Always show cycles where friend has an existing order
        if (c.hasOrder) return true;
        // Filter by subscription type
        return subscribedTypes.includes(c.type || 'coffee');
      });
    }
  }

  res.json(filteredCycles);
});

// Get all friends (global, optionally filter by active status) with balance (admin)
router.get('/', requireAdmin, (req, res) => {
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

  // Attach subscriptions and credential info to each friend
  const allSubs = db.prepare('SELECT friend_id, type FROM friend_subscriptions').all();
  const subsMap = {};
  for (const s of allSubs) {
    if (!subsMap[s.friend_id]) subsMap[s.friend_id] = [];
    subsMap[s.friend_id].push(s.type);
  }
  for (const f of friends) {
    f.subscriptions = subsMap[f.id] || [];
    f.hasCredentials = !!f.password_hash;
    // Don't expose credential material to clients
    sanitizeFriend(f);
  }

  res.json(friends);
});

// Get friend balance and recent transactions (for friend portal, requires friend auth)
router.get('/:id/balance', (req, res) => {
  const owner = requireFriendOwner(req, req.params.id);
  if (owner.error) {
    return res.status(owner.status).json({ error: owner.error });
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

// Get friend detail with balance, transactions, and orders (admin)
router.get('/:id/detail', requireAdmin, (req, res) => {
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
    friend: sanitizeFriend(friend),
    transactions,
    orders
  });
});

// Create new friend (global, no cycle_id required) (admin)
router.post('/', requireAdmin, (req, res) => {
  const { name, display_name, phone, email } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Prihlasovacie meno je povinné' });
  }

  const trimmedEmail = email ? email.trim() : null;
  if (trimmedEmail && !trimmedEmail.includes('@')) {
    return res.status(400).json({ error: 'Neplatný email' });
  }

  // Generate unique access token (kept for backwards compatibility)
  const access_token = nanoid(12);

  // Generate unique UID (8 alphanumeric characters)
  let uid = generateUid();
  while (db.prepare('SELECT id FROM friends WHERE uid = ?').get(uid)) {
    uid = generateUid();
  }

  // Generate unique invite code (5 characters)
  let invite_code = generateInviteCode();
  while (db.prepare('SELECT id FROM friends WHERE invite_code = ?').get(invite_code)) {
    invite_code = generateInviteCode();
  }

  // cycle_id column still has foreign key constraint, so we need a valid cycle_id
  // Use the first available cycle, or create a placeholder cycle if none exist
  // (shared with onboarding + approval — see helpers/friend-create.js, 07 §UC-IA-002)
  const cycleId = getPlaceholderCycleId();

  const result = db.prepare(`
    INSERT INTO friends (cycle_id, name, display_name, uid, access_token, invite_code, active, phone, email)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(cycleId, name, display_name || null, uid, access_token, invite_code, phone || null, trimmedEmail);

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(sanitizeFriend(friend));
});

// Update friend (name, display_name, and/or active status) - Admin endpoint
router.patch('/:id', requireAdmin, (req, res) => {
  const { name, display_name, active, phone, email } = req.body;
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
    // Invalidate sessions when deactivating
    if (!active) {
      invalidateFriendSessions(req.params.id);
    }
  }
  if (phone !== undefined) {
    updates.push('phone = ?');
    values.push(phone || null);
  }
  if (email !== undefined) {
    const trimmed = email ? email.trim() : null;
    if (trimmed && !trimmed.includes('@')) {
      return res.status(400).json({ error: 'Neplatný email' });
    }
    updates.push('email = ?');
    values.push(trimmed);
  }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE friends SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  res.json(sanitizeFriend(updated));
});

// Update own profile (friend can update their login name only) - requires friends password
// Note: display_name is admin-only and cannot be changed by friends
router.patch('/:id/profile', (req, res) => {
  const owner = requireFriendOwner(req, req.params.id);
  if (owner.error) {
    return res.status(owner.status).json({ error: owner.error });
  }

  const { name, packeta_address } = req.body;
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

  if (packeta_address !== undefined) {
    db.prepare('UPDATE friends SET packeta_address = ? WHERE id = ?')
      .run(packeta_address?.trim() || null, friendId);
  }

  const updated = db.prepare('SELECT id, name, uid, packeta_address FROM friends WHERE id = ?').get(friendId);
  res.json(updated);
});

// Admin: Reset friend password
router.put('/:id/reset-password', requireAdmin, (req, res) => {
  const { password } = req.body;
  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Heslo musí mať aspoň 8 znakov' });
  }

  // Set the password AND flag it must be changed: on next login the friend is
  // forced to choose their own password (SEC-A3 migration + forced-change #3).
  db.prepare('UPDATE friends SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), req.params.id);
  invalidateFriendSessions(req.params.id);

  res.json({ success: true });
});

// Admin: Set/change friend username
router.put('/:id/admin-username', requireAdmin, (req, res) => {
  const { username } = req.body;
  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }

  if (isUsernameTaken(username.toLowerCase(), friend.id)) {
    return res.status(409).json({ error: 'Užívateľské meno je už obsadené' });
  }

  db.prepare('UPDATE friends SET username = ? WHERE id = ?').run(username.toLowerCase(), req.params.id);
  invalidateFriendSessions(req.params.id);
  const updated = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  res.json(sanitizeFriend(updated));
});

// Delete friend (blocked if balance is non-zero) (admin)
router.delete('/:id', requireAdmin, (req, res) => {
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

  // ⚠ `friends.root_friend_id` was added by a bare ALTER TABLE, so it has NO foreign
  // key: deleting a group's root used to leave every member pointing at a row that no
  // longer exists. Such a member belongs to no group and is not unassigned either, so
  // they dropped out of the rewards report entirely — a routine delete silently zeroed
  // their whole reward volume (own kilos and the guest kilos GSO-T9 credits them).
  // `rewards.js` now treats an unresolvable pointer as unassigned as well; this clears
  // the pointer so the broken state is not created in the first place. One
  // transaction: a half-applied delete would leave exactly the dangling rows this
  // prevents.
  const removeFriend = db.transaction(() => {
    db.run('UPDATE friends SET root_friend_id = NULL WHERE root_friend_id = ?', [req.params.id]);
    db.run('DELETE FROM friends WHERE id = ?', [req.params.id]);
  });
  removeFriend();

  res.status(204).send();
});

export default router;
