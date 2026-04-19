# Bakery Product Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow bakery products to have multiple weight/price variants that are independently orderable by friends.

**Architecture:** New `bakery_product_variants` table stores variant rows linked to bakery products. When a cycle is created, each variant is snapshotted as its own row in the `products` table (with new `variant_label` and `source_variant_id` columns). The friend order view groups snapshotted products by `source_bakery_product_id` into single cards with per-variant quantity controls.

**Tech Stack:** Node.js/Express backend, sql.js (SQLite), Vue 3 frontend with Tailwind CSS + shadcn-vue.

**Spec:** `docs/superpowers/specs/2026-04-19-bakery-product-variants-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `backend/src/db/schema.js` | New table + migrations + data migration |
| Modify | `backend/src/routes/bakery-products.js` | CRUD with variants in request/response |
| Modify | `backend/src/routes/cycles.js` | Snapshot variants during cycle creation |
| Modify | `backend/src/routes/cycles.js` | Include `variant_label` in distribution query |
| Modify | `frontend/src/views/AdminBakeryProducts.vue` | Variant rows in product modal + table display |
| Modify | `frontend/src/views/FriendOrder.vue` | Grouped variant cards with per-variant +/- |
| Modify | `frontend/src/views/Distribution.vue` | Show variant label in item display |

---

### Task 1: Database schema — new table + migrations

**Files:**
- Modify: `backend/src/db/schema.js:326` (after bakery_products CREATE TABLE)

- [ ] **Step 1: Add `bakery_product_variants` table and data migration**

In `backend/src/db/schema.js`, add after the `bakery_products` CREATE TABLE block (after line 326):

```javascript
  // Create bakery_product_variants table
  db.run(`
    CREATE TABLE IF NOT EXISTS bakery_product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bakery_product_id INTEGER NOT NULL,
      label TEXT,
      weight_grams INTEGER,
      price REAL NOT NULL,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bakery_product_id) REFERENCES bakery_products(id) ON DELETE CASCADE
    )
  `);

  // Migration: Populate variants from existing bakery_products that have no variants yet
  try {
    const existingVariants = db.exec('SELECT COUNT(*) FROM bakery_product_variants');
    const count = existingVariants[0]?.values[0]?.[0] || 0;
    if (count === 0) {
      const productsWithPrice = db.exec('SELECT id, weight_grams, price FROM bakery_products WHERE price IS NOT NULL');
      if (productsWithPrice.length > 0 && productsWithPrice[0].values.length > 0) {
        for (const row of productsWithPrice[0].values) {
          const [id, weight_grams, price] = row;
          db.run('INSERT INTO bakery_product_variants (bakery_product_id, weight_grams, price, sort_order) VALUES (?, ?, ?, 0)',
            [id, weight_grams, price]);
        }
      }
    }
  } catch (e) {
    console.error('Migration error (bakery product variants):', e.message);
  }
```

- [ ] **Step 2: Add `variant_label` and `source_variant_id` columns to products table**

In `backend/src/db/schema.js`, add after the existing bakery migration block (after line 370, the `composition` ALTER TABLE):

```javascript
  try {
    db.run('ALTER TABLE products ADD COLUMN variant_label TEXT');
  } catch (e) {}
  try {
    db.run('ALTER TABLE products ADD COLUMN source_variant_id INTEGER');
  } catch (e) {}
```

- [ ] **Step 3: Verify backend starts**

Run backend dev server. Expected: Server starts on port 3000 without errors. The `bakery_product_variants` table is created and populated from existing bakery products.

- [ ] **Step 4: Commit**

```
feat(bakery-variants): add bakery_product_variants table and migrations
```

---

### Task 2: Backend API — variants in bakery products CRUD

**Files:**
- Modify: `backend/src/routes/bakery-products.js`

- [ ] **Step 1: Update GET endpoints to include variants**

Replace the GET `/` handler (lines 12-15) with:

```javascript
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
```

Replace the GET `/all` handler (lines 18-21) with:

```javascript
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
```

Replace the GET `/:id` handler (lines 24-30) with:

```javascript
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
```

- [ ] **Step 2: Update POST endpoint to create variants**

Replace the POST `/` handler (lines 33-64) with:

```javascript
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
```

- [ ] **Step 3: Update PATCH endpoint to sync variants**

Replace the PATCH `/:id` handler (lines 67-95) with:

```javascript
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
```

- [ ] **Step 4: Verify backend starts and test endpoints**

Start backend dev server. Test that GET returns variants array on each product.

- [ ] **Step 5: Commit**

```
feat(bakery-variants): add variants to bakery products CRUD
```

---

### Task 3: Cycle creation — snapshot variants

**Files:**
- Modify: `backend/src/routes/cycles.js:90-107`

- [ ] **Step 1: Update bakery snapshot logic to iterate variants**

Replace the bakery snapshotting block in the POST `/` handler (lines 91-107) with:

```javascript
  if (cycleType === 'bakery' && Array.isArray(bakery_product_ids) && bakery_product_ids.length > 0) {
    for (const bpId of bakery_product_ids) {
      const bp = db.get('SELECT * FROM bakery_products WHERE id = ? AND active = 1', [bpId]);
      if (!bp) continue;

      // Insert into cycle_bakery_products junction
      db.run('INSERT INTO cycle_bakery_products (cycle_id, bakery_product_id) VALUES (?, ?)', [cycleId, bp.id]);

      // Get active variants for this product
      const variants = db.all(
        'SELECT * FROM bakery_product_variants WHERE bakery_product_id = ? AND active = 1 ORDER BY sort_order',
        [bp.id]
      );

      // Snapshot each variant as its own products row
      const categoryLabel = bp.category === 'sladké' ? 'Sladké' : 'Slané';
      for (const variant of variants) {
        db.run(
          `INSERT INTO products (cycle_id, name, description1, purpose, price_unit, weight_grams, composition, image, source_bakery_product_id, variant_label, source_variant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [cycleId, bp.name, bp.description || null, categoryLabel, variant.price, variant.weight_grams || null, bp.composition || null, bp.image || null, bp.id, variant.label || null, variant.id]
        );
      }

      // Fallback: if product has no variants, snapshot with product-level data
      if (variants.length === 0) {
        db.run(
          `INSERT INTO products (cycle_id, name, description1, purpose, price_unit, weight_grams, composition, image, source_bakery_product_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [cycleId, bp.name, bp.description || null, categoryLabel, bp.price, bp.weight_grams || null, bp.composition || null, bp.image || null, bp.id]
        );
      }
    }
  }
```

- [ ] **Step 2: Verify backend starts**

Start backend dev server. No errors expected.

- [ ] **Step 3: Commit**

```
feat(bakery-variants): snapshot variants as individual product rows in cycles
```

---

### Task 4: Distribution view — include variant_label in query

**Files:**
- Modify: `backend/src/routes/cycles.js:225-238`
- Modify: `frontend/src/views/Distribution.vue`

- [ ] **Step 1: Add variant_label to distribution query**

In `backend/src/routes/cycles.js`, update the distribution items query (line 226) to include `variant_label`:

Replace:
```javascript
      SELECT p.name as product_name, p.purpose, p.roast_type, oi.variant, oi.quantity, oi.price
```
With:
```javascript
      SELECT p.name as product_name, p.purpose, p.roast_type, p.variant_label, oi.variant, oi.quantity, oi.price
```

- [ ] **Step 2: Show variant label in Distribution.vue**

In `frontend/src/views/Distribution.vue`, find the product name display in the normal view. Update it to append variant label:

Replace:
```html
                    <div class="font-semibold text-sm">{{ item.product_name }}</div>
```
With:
```html
                    <div class="font-semibold text-sm">{{ item.product_name }}<span v-if="item.variant_label" class="font-normal text-muted-foreground"> — {{ item.variant_label }}</span></div>
```

In the print table, update the product name cell:

Replace:
```html
                    <td class="py-1">{{ item.product_name }}</td>
```
With:
```html
                    <td class="py-1">{{ item.product_name }}<span v-if="item.variant_label"> — {{ item.variant_label }}</span></td>
```

- [ ] **Step 3: Commit**

```
feat(bakery-variants): show variant label in distribution view
```

---

### Task 5: Admin UI — variant rows in product modal

**Files:**
- Modify: `frontend/src/views/AdminBakeryProducts.vue`

- [ ] **Step 1: Update form state and modal logic for variants**

In `AdminBakeryProducts.vue`, replace the form ref (line 23-25):

```javascript
const form = ref({
  name: '', description: '', composition: '', category: 'slané', image: '',
  variants: [{ label: '', weight_grams: '', price: '' }]
})
```

Update `openModal` function (lines 48-66):

```javascript
function openModal(product = null) {
  editingProduct.value = product
  if (product) {
    const variants = (product.variants && product.variants.length > 0)
      ? product.variants.map(v => ({ id: v.id, label: v.label || '', weight_grams: v.weight_grams || '', price: v.price || '' }))
      : [{ label: '', weight_grams: product.weight_grams || '', price: product.price || '' }]
    form.value = {
      name: product.name || '',
      description: product.description || '',
      composition: product.composition || '',
      category: product.category || 'slané',
      image: product.image || '',
      variants
    }
    imagePreview.value = product.image || null
  } else {
    form.value = {
      name: '', description: '', composition: '', category: 'slané', image: '',
      variants: [{ label: '', weight_grams: '', price: '' }]
    }
    imagePreview.value = null
  }
  showModal.value = true
}
```

Update `saveProduct` function (lines 68-88):

```javascript
async function saveProduct() {
  if (!form.value.name.trim()) return
  // At least one variant with a price is required
  const validVariants = form.value.variants.filter(v => v.price)
  if (validVariants.length === 0) return

  try {
    const data = {
      name: form.value.name,
      description: form.value.description || null,
      composition: form.value.composition || null,
      category: form.value.category,
      image: form.value.image || null,
      variants: form.value.variants.map((v, i) => ({
        ...(v.id ? { id: v.id } : {}),
        label: v.label || null,
        weight_grams: v.weight_grams ? parseInt(v.weight_grams) : null,
        price: parseFloat(v.price),
        sort_order: i
      }))
    }
    if (editingProduct.value) {
      await api.updateBakeryProduct(editingProduct.value.id, data)
    } else {
      await api.createBakeryProduct(data)
    }
    showModal.value = false
    await loadProducts()
  } catch (e) {
    error.value = e.message
  }
}
```

Update `duplicateProduct` function (lines 90-103):

```javascript
function duplicateProduct(product) {
  editingProduct.value = null
  const variants = (product.variants && product.variants.length > 0)
    ? product.variants.map(v => ({ label: v.label || '', weight_grams: v.weight_grams || '', price: v.price || '' }))
    : [{ label: '', weight_grams: product.weight_grams || '', price: product.price || '' }]
  form.value = {
    name: (product.name || '') + ' (kópia)',
    description: product.description || '',
    composition: product.composition || '',
    category: product.category || 'slané',
    image: product.image || '',
    variants
  }
  imagePreview.value = product.image || null
  showModal.value = true
}
```

Add two helper functions after `duplicateProduct`:

```javascript
function addVariant() {
  form.value.variants.push({ label: '', weight_grams: '', price: '' })
}

function removeVariant(index) {
  if (form.value.variants.length > 1) {
    form.value.variants.splice(index, 1)
  }
}
```

- [ ] **Step 2: Update modal template — replace weight/price fields with variants section**

In the modal template, replace the weight/price grid (lines 335-344):

```html
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1">
                <Label>Hmotnosť (g)</Label>
                <Input v-model="form.weight_grams" type="number" />
              </div>
              <div class="space-y-1">
                <Label>Cena (EUR) *</Label>
                <Input v-model="form.price" type="number" step="0.01" />
              </div>
            </div>
```

With this variants section:

```html
            <div class="space-y-2">
              <Label>Varianty</Label>
              <div v-for="(variant, index) in form.variants" :key="index" class="flex items-center gap-2">
                <Input v-model="variant.label" placeholder="napr. Malá" class="flex-1" />
                <Input v-model="variant.weight_grams" type="number" placeholder="g" class="w-20" />
                <Input v-model="variant.price" type="number" step="0.01" placeholder="EUR" class="w-24" />
                <button
                  v-if="form.variants.length > 1"
                  @click="removeVariant(index)"
                  class="text-destructive hover:text-destructive/80 p-1"
                  type="button"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <div v-else class="w-6"></div>
              </div>
              <button
                @click="addVariant"
                type="button"
                class="text-sm text-primary hover:text-primary/80 flex items-center gap-1"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
                Pridať variant
              </button>
            </div>
```

- [ ] **Step 3: Update save button disabled condition**

Replace the save button disabled condition:

```html
          <Button @click="saveProduct" :disabled="!form.name.trim() || !form.price">Uložiť</Button>
```

With:

```html
          <Button @click="saveProduct" :disabled="!form.name.trim() || !form.variants.some(v => v.price)">Uložiť</Button>
```

- [ ] **Step 4: Update product table to show variants instead of separate weight/price columns**

Replace the Hmotnosť and Cena table headers:

```html
              <TableHead class="text-right">Hmotnosť</TableHead>
              <TableHead class="text-right">Cena</TableHead>
```

With:

```html
              <TableHead class="text-right">Varianty</TableHead>
```

Replace the two corresponding cells:

```html
              <TableCell class="text-right text-sm">{{ product.weight_grams ? `${product.weight_grams}g` : '-' }}</TableCell>
              <TableCell class="text-right text-sm">{{ formatPrice(product.price) }}</TableCell>
```

With:

```html
              <TableCell class="text-right text-sm">
                <div v-if="product.variants && product.variants.length > 0" class="space-y-0.5">
                  <div v-for="v in product.variants" :key="v.id" class="whitespace-nowrap">
                    <span v-if="v.label" class="text-muted-foreground">{{ v.label }}: </span>
                    <span>{{ formatPrice(v.price) }}</span>
                    <span v-if="v.weight_grams" class="text-muted-foreground"> / {{ v.weight_grams }}g</span>
                  </div>
                </div>
                <span v-else>{{ formatPrice(product.price) }}</span>
              </TableCell>
```

- [ ] **Step 5: Verify in browser**

Run both servers. Navigate to `/admin/bakery-products`. Verify:
- Product table shows variants column
- Opening a product modal shows variant rows
- Can add/remove variant rows
- Save works with multiple variants

- [ ] **Step 6: Commit**

```
feat(bakery-variants): variant rows in admin product modal and table
```

---

### Task 6: Friend order — grouped variant display

**Files:**
- Modify: `frontend/src/views/FriendOrder.vue`

- [ ] **Step 1: Add variant grouping logic**

In `FriendOrder.vue`, after the `groupedProducts` computed (around line 172), add a new computed that groups bakery products by their `source_bakery_product_id`:

```javascript
const groupedBakeryProducts = computed(() => {
  if (!isBakery.value) return groupedProducts.value

  const result = {}
  for (const [purpose, purposeProducts] of Object.entries(groupedProducts.value)) {
    const groups = []
    const seen = new Set()
    for (const product of purposeProducts) {
      const groupKey = product.source_bakery_product_id || product.id
      if (seen.has(groupKey)) continue
      seen.add(groupKey)

      // Find all products with same source_bakery_product_id
      const variants = purposeProducts.filter(p =>
        p.source_bakery_product_id && p.source_bakery_product_id === product.source_bakery_product_id
      )

      if (variants.length > 1) {
        // Multi-variant product: first variant provides the card info
        groups.push({ ...variants[0], _variants: variants })
      } else {
        // Single product (no grouping needed)
        groups.push({ ...product, _variants: [product] })
      }
    }
    result[purpose] = groups
  }
  return result
})
```

- [ ] **Step 2: Add helper to check if any variant in a group has items**

Add after the `groupedBakeryProducts` computed:

```javascript
function getGroupQuantityTotal(variants) {
  return variants.reduce((sum, v) => sum + getQuantity(v.id, 'unit'), 0)
}
```

- [ ] **Step 3: Update the product list to use grouped data for bakery**

Find this line in the template:

```html
            <Card
              v-for="product in groupedProducts[purpose]"
              :key="product.id"
            >
```

Replace with:

```html
            <Card
              v-for="product in (isBakery ? groupedBakeryProducts[purpose] : groupedProducts[purpose])"
              :key="product.id"
            >
```

- [ ] **Step 4: Replace the bakery card template with variant-aware version**

Replace the entire bakery card `<CardContent>` block (from `<CardContent v-if="isBakery && product.price_unit"` to its closing `</CardContent>`) with:

```html
              <!-- Bakery product card with variant support -->
              <CardContent v-if="isBakery && product.price_unit" class="p-0">
                <div
                  :class="[
                    'flex rounded-lg overflow-hidden transition-colors',
                    getGroupQuantityTotal(product._variants) > 0
                      ? 'ring-2 ring-primary'
                      : ''
                  ]"
                >
                  <!-- Product image - full height left side -->
                  <div class="w-28 flex-shrink-0 bg-muted flex items-center justify-center">
                    <img v-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                    <svg v-else class="w-8 h-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <!-- Product info + variant rows -->
                  <div class="flex-1 min-w-0 p-3 flex flex-col">
                    <div class="flex justify-between items-start gap-2">
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <h3 class="font-semibold text-foreground">{{ product.name }}</h3>
                        </div>
                        <p v-if="product.description1" class="text-sm text-muted-foreground mt-0.5">{{ product.description1 }}</p>
                        <details v-if="product.composition" class="mt-1">
                          <summary class="text-xs text-muted-foreground/70 cursor-pointer select-none">Zloženie</summary>
                          <p class="text-xs text-muted-foreground/70 mt-0.5">{{ product.composition }}</p>
                        </details>
                      </div>
                    </div>
                    <!-- Variant rows -->
                    <div class="mt-auto pt-2 space-y-1.5">
                      <div v-for="v in product._variants" :key="v.id" class="flex items-center justify-between">
                        <div class="text-sm">
                          <span v-if="v.variant_label" class="text-xs text-muted-foreground mr-1">{{ v.variant_label }}</span>
                          <span class="font-semibold text-primary">{{ formatPrice(applyMarkup(v.price_unit)) }}</span>
                          <span v-if="v.weight_grams" class="text-muted-foreground ml-1">/ {{ v.weight_grams }}g</span>
                        </div>
                        <div class="flex items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="icon"
                            @click="decrement(v.id, 'unit')"
                            :disabled="isLocked || getQuantity(v.id, 'unit') === 0"
                            class="h-8 w-8 rounded-full"
                          >
                            -
                          </Button>
                          <span class="w-6 text-center font-semibold text-sm">{{ getQuantity(v.id, 'unit') }}</span>
                          <Button
                            variant="outline"
                            size="icon"
                            @click="increment(v.id, 'unit')"
                            :disabled="isLocked"
                            class="h-8 w-8 rounded-full"
                          >
                            +
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
```

- [ ] **Step 5: Verify in browser**

Run both servers. Create a test bakery cycle with a multi-variant product. Open the friend order view and verify:
- Multi-variant products show as one card with multiple variant rows
- Single-variant products look the same as before
- +/- buttons work independently per variant
- Cart totals correctly sum across variants

- [ ] **Step 6: Commit**

```
feat(bakery-variants): grouped variant display in friend order view
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Full flow test**

1. Go to Admin > Pekáreň. Create a new product "Vianočka" with two variants: "Malá" (230g, 2.50) and "Veľká" (400g, 4.00)
2. Edit the product — verify both variants load correctly. Add a third variant, save. Remove it, save.
3. Create a new bakery cycle, select the multi-variant product
4. Open the friend order view for that cycle — verify the grouped card with multiple variant rows
5. Order different quantities of each variant, submit
6. Check distribution view — verify each variant shows as its own line with the label

- [ ] **Step 2: Single-variant backward compatibility**

1. Check existing single-variant products — verify they display identically to before in both admin and friend order views
2. Create a new product with only one variant (no label) — verify it looks like the old layout

- [ ] **Step 3: Final commit**

```
docs: add bakery product variants implementation plan
```
