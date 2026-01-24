import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

// GET /transactions/friend/:friendId - Get all transactions for a friend
router.get('/friend/:friendId', (req, res) => {
  const { friendId } = req.params;

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  const transactions = db.prepare(`
    SELECT t.*, o.cycle_id, c.name as cycle_name
    FROM transactions t
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN order_cycles c ON c.id = o.cycle_id
    WHERE t.friend_id = ?
    ORDER BY t.created_at DESC
  `).all(friendId);

  res.json(transactions);
});

// POST /transactions/payment - Record a payment from friend
router.post('/payment', (req, res) => {
  const { friend_id, amount, note, date } = req.body;

  if (!friend_id) {
    return res.status(400).json({ error: 'friend_id je povinný' });
  }

  if (amount === undefined || amount === null || amount <= 0) {
    return res.status(400).json({ error: 'Suma musí byť kladné číslo' });
  }

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(friend_id);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Note max 160 chars
  const truncatedNote = note ? note.substring(0, 160) : null;

  // Use provided date or default to now
  const createdAt = date ? new Date(date).toISOString() : new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO transactions (friend_id, type, amount, note, created_at)
    VALUES (?, 'payment', ?, ?, ?)
  `).run(friend_id, amount, truncatedNote, createdAt);

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);

  // Calculate new balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(friend_id);

  res.status(201).json({
    transaction,
    balance: balanceResult.balance
  });
});

// POST /transactions/adjustment - Add credit/adjustment for a friend
router.post('/adjustment', (req, res) => {
  const { friend_id, order_id, amount, note } = req.body;

  if (!friend_id) {
    return res.status(400).json({ error: 'friend_id je povinný' });
  }

  if (amount === undefined || amount === null || amount === 0) {
    return res.status(400).json({ error: 'Suma je povinná a nemôže byť nula' });
  }

  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'Dôvod (poznámka) je povinný' });
  }

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(friend_id);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Validate order if provided
  if (order_id) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND friend_id = ?').get(order_id, friend_id);
    if (!order) {
      return res.status(404).json({ error: 'Objednávka nebola nájdená alebo nepatrí tomuto priateľovi' });
    }
  }

  // Note max 160 chars
  const truncatedNote = note.trim().substring(0, 160);

  const result = db.prepare(`
    INSERT INTO transactions (friend_id, order_id, type, amount, note)
    VALUES (?, ?, 'adjustment', ?, ?)
  `).run(friend_id, order_id || null, amount, truncatedNote);

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);

  // Calculate new balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(friend_id);

  res.status(201).json({
    transaction,
    balance: balanceResult.balance
  });
});

// PATCH /transactions/:id - Update a transaction
router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const { amount, note, date } = req.body;

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!transaction) {
    return res.status(404).json({ error: 'Transakcia nebola nájdená' });
  }

  // Only allow editing payment and adjustment transactions (not charges)
  if (transaction.type === 'charge') {
    return res.status(400).json({ error: 'Účtovacie transakcie nie je možné upravovať' });
  }

  // Build update query dynamically
  const updates = [];
  const values = [];

  if (amount !== undefined && amount !== null) {
    if (transaction.type === 'payment' && amount <= 0) {
      return res.status(400).json({ error: 'Suma platby musí byť kladné číslo' });
    }
    updates.push('amount = ?');
    values.push(amount);
  }

  if (note !== undefined) {
    const truncatedNote = note ? note.substring(0, 160) : null;
    updates.push('note = ?');
    values.push(truncatedNote);
  }

  if (date !== undefined) {
    const createdAt = date ? new Date(date).toISOString() : transaction.created_at;
    updates.push('created_at = ?');
    values.push(createdAt);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Žiadne údaje na aktualizáciu' });
  }

  values.push(id);
  db.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);

  // Calculate new balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(transaction.friend_id);

  res.json({
    transaction: updated,
    balance: balanceResult.balance
  });
});

// DELETE /transactions/:id - Delete a transaction
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!transaction) {
    return res.status(404).json({ error: 'Transakcia nebola nájdená' });
  }

  // Only allow deleting payment and adjustment transactions (not charges)
  if (transaction.type === 'charge') {
    return res.status(400).json({ error: 'Účtovacie transakcie nie je možné vymazať' });
  }

  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);

  // Calculate new balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(transaction.friend_id);

  res.json({ balance: balanceResult.balance });
});

export default router;
