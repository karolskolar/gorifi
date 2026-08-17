import { Router } from 'express';
import db from '../db/schema.js';
import { imageFromUpload, imageFromBody } from '../helpers/image-upload.js';
import { uploadSingle } from '../helpers/multipart.js';
import { bindValue, bindRecord } from '../helpers/bind-value.js';

// FUP-T13 — one variant record, reduced to values SQLite can bind.
//
// ⚠ THE ELEMENT ITSELF NEEDS SHAPE-CHECKING, NOT JUST ITS FIELDS. The routes below
// only ever checked `Array.isArray(variants)`, so `variants: [null]` reached
// `null.price` and raised a TypeError — a 500 + stack that is not even a binder
// error — while `[{price:{}}]` and `[{id:{}}]` raised binder errors one line later.
// `bindRecord` turns any non-record element into an empty one, after which every
// field is `undefined` and behaves exactly like an omitted field — for `label` and
// `weight_grams` that means NULL, and for `price` it means the required-price 400
// below, because of the constraint the next paragraph is about.
//
// ⚠ BOTH `bakery_products.price` AND `bakery_product_variants.price` are
// `REAL NOT NULL` (schema.js:488, :510), so a variant price that does not parse
// binds NULL and raises a NOT NULL SqliteError ⇒ 500 + stack. That was true before
// FUP-T13 too, for an ordinary STRING: `variants:[{price:'abc'}]` inserted the
// PRODUCT row (a REAL NOT NULL column happily takes the text `abc`) and only then
// 500'd on the variants INSERT — leaving a HALF-WRITTEN product with a text price
// and no variants at all, which is exactly what a probe of this route produced.
// Checking every price up front and answering the route's OWN required-price 400
// removes the 500 and the partial write together, and the parsed number is what
// gets bound, so a numeric string still stores the same value SQLite's REAL
// affinity was already converting it to.
function variantPrice(v) {
  const n = parseFloat(v.price);
  return Number.isFinite(n) ? n : null;
}

function normaliseVariants(list) {
  return list.map((raw) => {
    const v = bindRecord(raw);
    return {
      id: bindValue(v.id),
      label: bindValue(v.label),
      weight_grams: bindValue(v.weight_grams),
      price: bindValue(v.price),
    };
  });
}

const router = Router();

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
router.post('/', uploadSingle('image'), (req, res) => {
  // FUP-T13 — all seven are bound directly into the INSERT below, so any of them
  // carrying an object/array/boolean was a 500 + ~1.1 KB of stack. Unbindable ⇒
  // `undefined` ⇒ bound as NULL, i.e. what an absent field already stored; `name` and
  // `price` then fall into the route's own required-field 400s.
  const name = bindValue(req.body.name);
  const description = bindValue(req.body.description);
  const subtitle = bindValue(req.body.subtitle);
  const weight_grams = bindValue(req.body.weight_grams);
  const price = bindValue(req.body.price);
  const composition = bindValue(req.body.composition);
  const category = bindValue(req.body.category);
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

  variants = normaliseVariants(variants);
  if (variants.some((v) => variantPrice(v) === null)) {
    return res.status(400).json({ error: 'Cena je povinná (aspoň jeden variant)' });
  }

  let image = null;
  if (req.file) {
    const built = imageFromUpload(req.file);
    if (built.error) return res.status(400).json({ error: built.error });
    image = built.image;
  } else if (req.body.image) {
    const built = imageFromBody(req.body.image);
    if (built.error) return res.status(400).json({ error: built.error });
    image = built.image;
  }

  const result = db.run(
    'INSERT INTO bakery_products (name, description, subtitle, weight_grams, price, composition, category, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [name, description || null, subtitle || null, variants[0].weight_grams || null, variantPrice(variants[0]), composition || null, category || 'slané', image]
  );
  const productId = result.lastInsertRowid;

  // Insert variants
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    db.run(
      'INSERT INTO bakery_product_variants (bakery_product_id, label, weight_grams, price, sort_order) VALUES (?, ?, ?, ?, ?)',
      [productId, v.label || null, v.weight_grams ? parseInt(v.weight_grams) : null, variantPrice(v), i]
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

  // FUP-T13 — as on POST, plus the update half: every gate below is `!== undefined`,
  // so an unbindable value now SKIPS its write and the stored column survives rather
  // than being coerced to NULL behind a clean 200. An explicit null still clears.
  // `active` is `? 1 : 0` and never bound raw.
  const name = bindValue(req.body.name);
  const description = bindValue(req.body.description);
  const subtitle = bindValue(req.body.subtitle);
  const composition = bindValue(req.body.composition);
  const category = bindValue(req.body.category);
  const image = bindValue(req.body.image);
  const { active } = req.body;
  // Normalised UP FRONT, before the column UPDATE below: a throw inside the variant
  // sync used to leave the product row already written and variants half-soft-deleted.
  const variants = Array.isArray(req.body.variants) ? normaliseVariants(req.body.variants) : req.body.variants;

  // ⚠ Before ANY write: the column UPDATE below runs first and the variant sync
  // second, so a price that fails the NOT NULL constraint used to leave the product
  // renamed and its variants already soft-deleted.
  if (Array.isArray(variants) && variants.some((v) => variantPrice(v) === null)) {
    return res.status(400).json({ error: 'Cena je povinná (aspoň jeden variant)' });
  }

  const updates = [];
  const values = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description || null); }
  if (subtitle !== undefined) { updates.push('subtitle = ?'); values.push(subtitle || null); }
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
          [v.label || null, v.weight_grams ? parseInt(v.weight_grams) : null, variantPrice(v), i, v.id, req.params.id]
        );
      } else {
        // Create new
        db.run(
          'INSERT INTO bakery_product_variants (bakery_product_id, label, weight_grams, price, sort_order) VALUES (?, ?, ?, ?, ?)',
          [req.params.id, v.label || null, v.weight_grams ? parseInt(v.weight_grams) : null, variantPrice(v), i]
        );
      }
    }

    // Update the bakery_products table weight_grams and price from first variant (for backward compat)
    if (variants.length > 0) {
      db.run(
        'UPDATE bakery_products SET weight_grams = ?, price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [variants[0].weight_grams ? parseInt(variants[0].weight_grams) : null, variantPrice(variants[0]), req.params.id]
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
router.post('/:id/image', uploadSingle('image'), (req, res) => {
  const product = db.prepare('SELECT * FROM bakery_products WHERE id = ?').get(req.params.id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  let image = null;
  if (req.file) {
    const built = imageFromUpload(req.file);
    if (built.error) return res.status(400).json({ error: built.error });
    image = built.image;
  } else if (req.body.image) {
    const built = imageFromBody(req.body.image);
    if (built.error) return res.status(400).json({ error: built.error });
    image = built.image;
  }

  db.prepare('UPDATE bakery_products SET image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(image, req.params.id);

  const updated = db.prepare('SELECT * FROM bakery_products WHERE id = ?').get(req.params.id);
  res.json(updated);
});

export default router;
