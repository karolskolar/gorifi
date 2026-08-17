import { Router } from 'express';
import db from '../db/schema.js';
import { requireAdmin } from '../middleware/admin-auth.js';

const router = Router();

// GET /pickup-locations - List active locations (public, for friend order form)
// Optional query param: ?type=coffee or ?type=bakery to filter by cycle type
router.get('/', (req, res) => {
  const { type } = req.query;
  let sql = 'SELECT * FROM pickup_locations WHERE active = 1';
  if (type === 'coffee') {
    sql += ' AND for_coffee = 1';
  } else if (type === 'bakery') {
    sql += ' AND for_bakery = 1';
  }
  sql += ' ORDER BY name';
  const locations = db.prepare(sql).all();
  res.json(locations);
});

// GET /pickup-locations/all - List all locations including inactive (admin)
router.get('/all', requireAdmin, (req, res) => {
  const locations = db.prepare('SELECT * FROM pickup_locations ORDER BY name').all();
  res.json(locations);
});

// POST /pickup-locations - Create location (admin)
router.post('/', requireAdmin, (req, res) => {
  const { name, address, for_coffee, for_bakery } = req.body;

  // ⚠ FUP-T12: folded into the existing required rule — same status, same message.
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Názov je povinný' });
  }

  // `address` is OPTIONAL and has no rule of its own, so a non-string is treated as
  // if the key were absent (⇒ NULL on this INSERT) rather than refused with an
  // invented message. See the PATCH below for why it may not be coerced there.
  const addressValue = typeof address === 'string' ? address.trim() || null : null;

  const result = db.prepare(
    'INSERT INTO pickup_locations (name, address, for_coffee, for_bakery) VALUES (?, ?, ?, ?)'
  ).run(name.trim(), addressValue, for_coffee !== undefined ? (for_coffee ? 1 : 0) : 1, for_bakery !== undefined ? (for_bakery ? 1 : 0) : 1);

  const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(location);
});

// PATCH /pickup-locations/:id - Update location (admin)
router.patch('/:id', requireAdmin, (req, res) => {
  const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(req.params.id);
  if (!location) {
    return res.status(404).json({ error: 'Miesto nebolo nájdené' });
  }

  const { name, address, active, for_coffee, for_bakery } = req.body;

  if (name !== undefined) {
    // ⚠ FUP-T12: folded into the existing required rule — same status, same message.
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Názov je povinný' });
    }
    db.prepare('UPDATE pickup_locations SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  }
  // ⚠ FUP-T12 — the optional-free-text shape (same as `friends.js`'s packeta_address):
  // a non-string is treated as if the key were absent and the write is SKIPPED. It may
  // not be coerced to NULL here — this is an UPDATE, so that would answer 200 while
  // silently wiping a real address. `null` stays in, because clearing by null is the
  // shipped convention.
  if (address !== undefined && (address === null || typeof address === 'string')) {
    db.prepare('UPDATE pickup_locations SET address = ? WHERE id = ?').run(address?.trim() || null, req.params.id);
  }
  if (active !== undefined) {
    db.prepare('UPDATE pickup_locations SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  }
  if (for_coffee !== undefined) {
    db.prepare('UPDATE pickup_locations SET for_coffee = ? WHERE id = ?').run(for_coffee ? 1 : 0, req.params.id);
  }
  if (for_bakery !== undefined) {
    db.prepare('UPDATE pickup_locations SET for_bakery = ? WHERE id = ?').run(for_bakery ? 1 : 0, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /pickup-locations/:id - Delete or soft-delete (admin)
router.delete('/:id', requireAdmin, (req, res) => {
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
