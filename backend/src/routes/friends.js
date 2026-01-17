import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db/schema.js';

const router = Router();

// Get all friends for a cycle
router.get('/cycle/:cycleId', (req, res) => {
  const friends = db.prepare(`
    SELECT f.*, o.id as order_id, o.status as order_status, o.paid, o.total
    FROM friends f
    LEFT JOIN orders o ON o.friend_id = f.id
    WHERE f.cycle_id = ?
    ORDER BY f.name
  `).all(req.params.cycleId);
  res.json(friends);
});

// Create new friend
router.post('/', (req, res) => {
  const { cycle_id, name } = req.body;

  if (!cycle_id || !name) {
    return res.status(400).json({ error: 'cycle_id a meno su povinne' });
  }

  // Check cycle exists
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycle_id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  // Generate unique access token (kept for backwards compatibility but not used)
  const access_token = nanoid(12);

  const result = db.prepare(`
    INSERT INTO friends (cycle_id, name, access_token)
    VALUES (?, ?, ?)
  `).run(cycle_id, name, access_token);

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(friend);
});

// Update friend
router.patch('/:id', (req, res) => {
  const { name } = req.body;
  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);

  if (!friend) {
    return res.status(404).json({ error: 'Priatel nebol najdeny' });
  }

  if (name) {
    db.prepare('UPDATE friends SET name = ? WHERE id = ?').run(name, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete friend
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM friends WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Priatel nebol najdeny' });
  }
  res.status(204).send();
});

export default router;
