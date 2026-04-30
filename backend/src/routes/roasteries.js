import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

// Get all roasteries
router.get('/', (req, res) => {
  const roasteries = db.all('SELECT * FROM roasteries ORDER BY is_default DESC, name ASC');
  res.json(roasteries);
});

// Create new roastery
router.post('/', (req, res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Názov pražiarne je povinný' });
  }

  try {
    const result = db.run(
      'INSERT INTO roasteries (name) VALUES (?)',
      [name.trim()]
    );
    const roastery = db.get('SELECT * FROM roasteries WHERE id = ?', [result.lastInsertRowid]);
    res.status(201).json(roastery);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Pražiareň s týmto názvom už existuje' });
    }
    throw e;
  }
});

// Update roastery
router.patch('/:id', (req, res) => {
  const { name } = req.body;
  const roastery = db.get('SELECT * FROM roasteries WHERE id = ?', [req.params.id]);

  if (!roastery) {
    return res.status(404).json({ error: 'Pražiareň nebola nájdená' });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Názov pražiarne je povinný' });
  }

  try {
    db.run('UPDATE roasteries SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
    const updated = db.get('SELECT * FROM roasteries WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Pražiareň s týmto názvom už existuje' });
    }
    throw e;
  }
});

// Delete roastery (only if no products reference it and it's not default)
router.delete('/:id', (req, res) => {
  const roastery = db.get('SELECT * FROM roasteries WHERE id = ?', [req.params.id]);

  if (!roastery) {
    return res.status(404).json({ error: 'Pražiareň nebola nájdená' });
  }

  if (roastery.is_default) {
    return res.status(400).json({ error: 'Predvolenú pražiareň nie je možné vymazať' });
  }

  // Check if any products reference this roastery
  const productCount = db.get(
    'SELECT COUNT(*) as count FROM products WHERE roastery = ? AND active = 1',
    [roastery.name]
  );

  if (productCount && productCount.count > 0) {
    return res.status(400).json({
      error: `Pražiareň nie je možné vymazať, pretože má ${productCount.count} priradených produktov`
    });
  }

  db.run('DELETE FROM roasteries WHERE id = ?', [req.params.id]);
  res.status(204).send();
});

export default router;
