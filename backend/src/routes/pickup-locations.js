import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

// GET /pickup-locations - List active locations (public, for friend order form)
router.get('/', (req, res) => {
  const locations = db.prepare('SELECT * FROM pickup_locations WHERE active = 1 ORDER BY name').all();
  res.json(locations);
});

// GET /pickup-locations/all - List all locations including inactive (admin)
router.get('/all', (req, res) => {
  const locations = db.prepare('SELECT * FROM pickup_locations ORDER BY name').all();
  res.json(locations);
});

// POST /pickup-locations - Create location (admin)
router.post('/', (req, res) => {
  const { name, address } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Názov je povinný' });
  }

  const result = db.prepare(
    'INSERT INTO pickup_locations (name, address) VALUES (?, ?)'
  ).run(name.trim(), address?.trim() || null);

  const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(location);
});

// PATCH /pickup-locations/:id - Update location (admin)
router.patch('/:id', (req, res) => {
  const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(req.params.id);
  if (!location) {
    return res.status(404).json({ error: 'Miesto nebolo nájdené' });
  }

  const { name, address, active } = req.body;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Názov je povinný' });
    db.prepare('UPDATE pickup_locations SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  }
  if (address !== undefined) {
    db.prepare('UPDATE pickup_locations SET address = ? WHERE id = ?').run(address?.trim() || null, req.params.id);
  }
  if (active !== undefined) {
    db.prepare('UPDATE pickup_locations SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /pickup-locations/:id - Delete or soft-delete (admin)
router.delete('/:id', (req, res) => {
  const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(req.params.id);
  if (!location) {
    return res.status(404).json({ error: 'Miesto nebolo nájdené' });
  }

  // Check if any orders reference this location
  const referenced = db.prepare('SELECT COUNT(*) as count FROM orders WHERE pickup_location_id = ?').get(req.params.id);
  if (referenced.count > 0) {
    // Soft-delete: deactivate instead
    db.prepare('UPDATE pickup_locations SET active = 0 WHERE id = ?').run(req.params.id);
  } else {
    db.prepare('DELETE FROM pickup_locations WHERE id = ?').run(req.params.id);
  }

  res.status(204).send();
});

export default router;
