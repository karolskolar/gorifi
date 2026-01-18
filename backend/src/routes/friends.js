import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db/schema.js';

const router = Router();

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
