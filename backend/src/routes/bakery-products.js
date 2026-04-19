import { Router } from 'express';
import multer from 'multer';
import db from '../db/schema.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Get active bakery products with their active variants
router.get('/', (req, res) => {
  const products = db.all('SELECT * FROM bakery_products WHERE active = 1 ORDER BY category, name');
  for (const product of products) {
    product.variants = db.all(
      'SELECT id, label, weight_grams, price, sort_order FROM bakery_product_variants WHERE bakery_product_id = ? AND active = 1 ORDER BY sort_order',
      [product.id]
    );
  }
  res.json(products);
});

// Get all bakery products including inactive (admin) with variants
router.get('/all', (req, res) => {
  const products = db.all('SELECT * FROM bakery_products ORDER BY category, name');
  for (const product of products) {
    product.variants = db.all(
      'SELECT id, label, weight_grams, price, sort_order FROM bakery_product_variants WHERE bakery_product_id = ? AND active = 1 ORDER BY sort_order',
      [product.id]
    );
  }
  res.json(products);
});

// Get single product with variants
router.get('/:id', (req, res) => {
  const product = db.get('SELECT * FROM bakery_products WHERE id = ?', [req.params.id]);
  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }
  product.variants = db.all(
    'SELECT id, label, weight_grams, price, sort_order FROM bakery_product_variants WHERE bakery_product_id = ? AND active = 1 ORDER BY sort_order',
    [product.id]
  );
  res.json(product);
});

// Create product with variants
router.post('/', upload.single('image'), (req, res) => {
  const { name, description, weight_grams, price, composition, category } = req.body;
  let variants = req.body.variants;

  // Parse variants if sent as JSON string (from FormData)
  if (typeof variants === 'string') {
    try { variants = JSON.parse(variants); } catch (e) { variants = null; }
  }

  if (!name) {
    return res.status(400).json({ error: 'Nazov je povinny' });
  }

  // Backward compat: if no variants array, use top-level weight_grams + price
  if (!Array.isArray(variants) || variants.length === 0) {
    if (!price) {
      return res.status(400).json({ error: 'Cena je povinná (aspoň jeden variant)' });
    }
    variants = [{ label: null, weight_grams: weight_grams ? parseInt(weight_grams) : null, price: parseFloat(price) }];
  }

  let image = null;
  if (req.file) {
    const mimeType = req.file.mimetype;
    const base64 = req.file.buffer.toString('base64');
    image = `data:${mimeType};base64,${base64}`;
  } else if (req.body.image) {
    image = req.body.image;
  }

  const result = db.run(
    'INSERT INTO bakery_products (name, description, weight_grams, price, composition, category, image) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [name, description || null, variants[0].weight_grams || null, variants[0].price, composition || null, category || 'slané', image]
  );
  const productId = result.lastInsertRowid;

  // Insert variants
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    db.run(
      'INSERT INTO bakery_product_variants (bakery_product_id, label, weight_grams, price, sort_order) VALUES (?, ?, ?, ?, ?)',
      [productId, v.label || null, v.weight_grams ? parseInt(v.weight_grams) : null, parseFloat(v.price), i]
    );
  }

  const product = db.get('SELECT * FROM bakery_products WHERE id = ?', [productId]);
  product.variants = db.all(
    'SELECT id, label, weight_grams, price, sort_order FROM bakery_product_variants WHERE bakery_product_id = ? AND active = 1 ORDER BY sort_order',
    [productId]
  );
  res.status(201).json(product);
});

// Update product and sync variants
router.patch('/:id', (req, res) => {
  const product = db.get('SELECT * FROM bakery_products WHERE id = ?', [req.params.id]);
  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  const { name, description, weight_grams, price, composition, category, image, active, variants } = req.body;

  const updates = [];
  const values = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description || null); }
  if (composition !== undefined) { updates.push('composition = ?'); values.push(composition || null); }
  if (category !== undefined) { updates.push('category = ?'); values.push(category); }
  if (image !== undefined) { updates.push('image = ?'); values.push(image || null); }
  if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);
    db.run(`UPDATE bakery_products SET ${updates.join(', ')} WHERE id = ?`, values);
  }

  // Sync variants if provided
  if (Array.isArray(variants)) {
    const incomingIds = variants.filter(v => v.id).map(v => v.id);

    // Soft-delete variants not in the incoming list
    const existing = db.all(
      'SELECT id FROM bakery_product_variants WHERE bakery_product_id = ? AND active = 1',
      [req.params.id]
    );
    for (const ex of existing) {
      if (!incomingIds.includes(ex.id)) {
        db.run('UPDATE bakery_product_variants SET active = 0 WHERE id = ?', [ex.id]);
      }
    }

    // Upsert variants
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      if (v.id) {
        // Update existing
        db.run(
          'UPDATE bakery_product_variants SET label = ?, weight_grams = ?, price = ?, sort_order = ? WHERE id = ? AND bakery_product_id = ?',
          [v.label || null, v.weight_grams ? parseInt(v.weight_grams) : null, parseFloat(v.price), i, v.id, req.params.id]
        );
      } else {
        // Create new
        db.run(
          'INSERT INTO bakery_product_variants (bakery_product_id, label, weight_grams, price, sort_order) VALUES (?, ?, ?, ?, ?)',
          [req.params.id, v.label || null, v.weight_grams ? parseInt(v.weight_grams) : null, parseFloat(v.price), i]
        );
      }
    }

    // Update the bakery_products table weight_grams and price from first variant (for backward compat)
    if (variants.length > 0) {
      db.run(
        'UPDATE bakery_products SET weight_grams = ?, price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [variants[0].weight_grams ? parseInt(variants[0].weight_grams) : null, parseFloat(variants[0].price), req.params.id]
      );
    }
  }

  const updated = db.get('SELECT * FROM bakery_products WHERE id = ?', [req.params.id]);
  updated.variants = db.all(
    'SELECT id, label, weight_grams, price, sort_order FROM bakery_product_variants WHERE bakery_product_id = ? AND active = 1 ORDER BY sort_order',
    [req.params.id]
  );
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
