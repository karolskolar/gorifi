import { Router } from 'express';
import multer from 'multer';
import db from '../db/schema.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Get active bakery products
router.get('/', (req, res) => {
  const products = db.prepare('SELECT * FROM bakery_products WHERE active = 1 ORDER BY category, name').all();
  res.json(products);
});

// Get all bakery products including inactive (admin)
router.get('/all', (req, res) => {
  const products = db.prepare('SELECT * FROM bakery_products ORDER BY category, name').all();
  res.json(products);
});

// Get single product
router.get('/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM bakery_products WHERE id = ?').get(req.params.id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }
  res.json(product);
});

// Create product
router.post('/', upload.single('image'), (req, res) => {
  const { name, description, weight_grams, price, composition, category } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: 'Nazov a cena su povinne' });
  }

  let image = null;
  if (req.file) {
    const mimeType = req.file.mimetype;
    const base64 = req.file.buffer.toString('base64');
    image = `data:${mimeType};base64,${base64}`;
  } else if (req.body.image) {
    image = req.body.image;
  }

  const result = db.prepare(`
    INSERT INTO bakery_products (name, description, weight_grams, price, composition, category, image)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    description || null,
    weight_grams ? parseInt(weight_grams) : null,
    parseFloat(price),
    composition || null,
    category || 'slané',
    image
  );

  const product = db.prepare('SELECT * FROM bakery_products WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(product);
});

// Update product
router.patch('/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM bakery_products WHERE id = ?').get(req.params.id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  const { name, description, weight_grams, price, composition, category, image, active } = req.body;

  const updates = [];
  const values = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description || null); }
  if (weight_grams !== undefined) { updates.push('weight_grams = ?'); values.push(weight_grams ? parseInt(weight_grams) : null); }
  if (price !== undefined) { updates.push('price = ?'); values.push(parseFloat(price)); }
  if (composition !== undefined) { updates.push('composition = ?'); values.push(composition || null); }
  if (category !== undefined) { updates.push('category = ?'); values.push(category); }
  if (image !== undefined) { updates.push('image = ?'); values.push(image || null); }
  if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);
    db.prepare(`UPDATE bakery_products SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM bakery_products WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete product (soft delete)
router.delete('/:id', (req, res) => {
  const result = db.prepare('UPDATE bakery_products SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }
  res.status(204).send();
});

// Upload/update image
router.post('/:id/image', upload.single('image'), (req, res) => {
  const product = db.prepare('SELECT * FROM bakery_products WHERE id = ?').get(req.params.id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  let image = null;
  if (req.file) {
    const mimeType = req.file.mimetype;
    const base64 = req.file.buffer.toString('base64');
    image = `data:${mimeType};base64,${base64}`;
  } else if (req.body.image) {
    image = req.body.image;
  }

  db.prepare('UPDATE bakery_products SET image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(image, req.params.id);

  const updated = db.prepare('SELECT * FROM bakery_products WHERE id = ?').get(req.params.id);
  res.json(updated);
});

export default router;
