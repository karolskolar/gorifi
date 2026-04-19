# Bakery Product Variants

## Context

Bakery products in Gorifi currently support a single weight/price pair. The admin wants to offer the same product in multiple sizes (e.g. Vianočka in 230g and 400g) without duplicating the entire product entry. Each variant shares the product's name, description, image, and composition but has its own weight, price, and optional label.

## Data Model

### New table: `bakery_product_variants`

```sql
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
```

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| bakery_product_id | INTEGER FK | Links to `bakery_products.id` |
| label | TEXT | Optional display label (e.g. "Malá", "Veľká") |
| weight_grams | INTEGER | Optional weight in grams |
| price | REAL NOT NULL | Variant price in EUR |
| sort_order | INTEGER | Controls display order within the product |
| active | INTEGER | Soft delete (1=active, 0=deleted) |

### Changes to `bakery_products` table

No columns removed. The existing `weight_grams` and `price` columns remain but are no longer used — variant data lives in `bakery_product_variants`. This keeps the migration safe and reversible.

### Migration of existing data

For every existing bakery product, insert one row into `bakery_product_variants`:
```sql
INSERT INTO bakery_product_variants (bakery_product_id, weight_grams, price, sort_order)
SELECT id, weight_grams, price, 0 FROM bakery_products WHERE price IS NOT NULL
```

### Changes to `products` table (cycle snapshots)

Two new columns via ALTER TABLE migration:

| Column | Type | Description |
|--------|------|-------------|
| variant_label | TEXT | Snapshotted label from the variant (e.g. "Malá") |
| source_variant_id | INTEGER | Links to `bakery_product_variants.id` for traceability |

### Cycle snapshotting

**Current behavior:** One bakery product → one row in `products` table.

**New behavior:** One bakery product with N active variants → N rows in `products` table. Each snapshotted row contains:
- `name`, `description1`, `purpose`, `composition`, `image` — from the bakery product (shared)
- `price_unit`, `weight_grams` — from the variant
- `variant_label` — from the variant's label field
- `source_bakery_product_id` — from the bakery product (existing column)
- `source_variant_id` — from the variant

This ensures historical data is preserved even if variants are later deleted or modified in the catalog.

## API Changes

### Bakery Products CRUD

**`GET /api/bakery-products`** and **`GET /api/bakery-products/all`**
- Response now includes a `variants` array on each product:
```json
{
  "id": 1,
  "name": "Vianočka",
  "description": "Klasická maslová...",
  "category": "sladké",
  "image": "data:image/...",
  "composition": "múka, maslo...",
  "variants": [
    { "id": 1, "label": null, "weight_grams": 230, "price": 2.5, "sort_order": 0 },
    { "id": 2, "label": "Veľká", "weight_grams": 400, "price": 4.0, "sort_order": 1 }
  ]
}
```

**`POST /api/bakery-products`**
- Request body accepts a `variants` array:
```json
{
  "name": "Vianočka",
  "description": "...",
  "category": "sladké",
  "variants": [
    { "label": null, "weight_grams": 230, "price": 2.5 },
    { "label": "Veľká", "weight_grams": 400, "price": 4.0 }
  ]
}
```
- At least one variant with a price is required.
- If no `variants` array is provided, falls back to top-level `weight_grams` and `price` for backward compatibility (creates one variant).

**`PATCH /api/bakery-products/:id`**
- Accepts a `variants` array for full replacement of the product's variants:
  - Variants with an `id` → updated
  - Variants without an `id` → created
  - Existing variants not in the array → soft-deleted (active=0)
- Other product fields (name, description, etc.) updated as before.

**`DELETE /api/bakery-products/:id`**
- Soft-deletes the product. Variants are left as-is (cascade not needed since product is soft-deleted).

### Cycle creation

**`POST /api/cycles`** (bakery type)
- When snapshotting bakery products, iterate over each product's active variants instead of the product itself.
- Each variant becomes its own `products` row with `variant_label` and `source_variant_id` populated.

## Admin UI

### Product Edit/Create Modal

**Current layout:** Standalone Hmotnosť (g) and Cena (EUR) fields.

**New layout:** Replace weight/price fields with a "Varianty" section:

```
Varianty
┌─────────────────┬───────────────┬──────────────┬───┐
│ Názov (opt.)    │ Hmotnosť (g)  │ Cena (EUR) * │   │
│ napr. Malá      │ 230           │ 2.50         │   │
├─────────────────┼───────────────┼──────────────┼───┤
│ napr. Veľká     │ 400           │ 4.00         │ × │
└─────────────────┴───────────────┴──────────────┴───┘
              [+ Pridať variant]
```

**Behavior:**
- New product: starts with one empty variant row
- Editing product: loads all existing active variants
- "+" button adds a new empty variant row
- "×" button removes a variant row (not shown on the first/only row)
- At least one variant is required; each variant must have a price
- Label and weight are optional
- Sort order determined by row position in the form

### Product List

No changes to the product list/card in the admin bakery catalog. Products still display by name. The variant count could optionally be shown as a badge (e.g. "2 varianty") but is not required.

## Friend Order View

### Bakery Product Card

**Current layout:** One price/weight line with one +/- counter per product.

**New layout:** Multiple variant rows within the same card:

```
┌──────────┬──────────────────────────────────────┐
│          │  Vianočka                             │
│  [image] │  Klasická maslová vianočka...         │
│          │  ► Zloženie                           │
│          │                                       │
│          │  Malá  2.50 EUR / 230g        - 0 +   │
│          │  Veľká 4.00 EUR / 400g        - 0 +   │
└──────────┴──────────────────────────────────────┘
```

**Rendering rules:**
- Product name, description, composition displayed once at the top
- Each snapshotted variant (each `products` row from the same bakery product) gets its own row
- Variant row shows: label (if set, small muted text), price (bold), weight (if set), +/- controls
- Single-variant products without a label look identical to today's layout
- Variants are grouped by `source_bakery_product_id` in the products query

**Grouping logic:**
- Products from the same `source_bakery_product_id` are grouped into one card
- The first product in the group provides name, description, image, composition
- Each product in the group becomes a variant row with its own quantity controls

### Cart and Pricing

- Each variant is its own `product_id` in the cart — the existing cart structure (`{ [productId]: { [variant]: quantity } }`) works unchanged
- Markup applied per variant as today
- Cart totals sum across all variant quantities

## Distribution View

Each variant ordered appears as its own line item:
- "Vianočka — Malá × 2"
- "Vianočka — Veľká × 1"

The variant label (or weight if no label) distinguishes items from the same product. The existing distribution rendering already shows one line per order_item, so this works without structural changes. The variant_label can be appended to the product name display.

## Order Items

No changes to `order_items` table structure. Each variant is a separate `products` row, so `order_items.product_id` already points to the correct snapshotted variant. The `variant` column continues to use `'unit'` for all bakery items.

## Scope

### In scope
- `bakery_product_variants` table + migration of existing data
- `products` table: `variant_label` and `source_variant_id` columns
- Bakery products API: variants in CRUD responses and requests
- Cycle creation: snapshot variants as individual product rows
- Admin modal: variant rows with add/remove
- Friend order: grouped variant display with per-variant quantity controls
- Distribution view: variant label in item display

### Out of scope
- Per-variant image (all variants share the product image)
- Selective variant inclusion per cycle (all active variants included)
- Variant-level analytics/reporting (future work)
- Variant stock/availability tracking

## Verification

1. **Create product with 2 variants** — verify both saved and returned by API
2. **Edit product: add variant, remove variant** — verify soft delete and new creation
3. **Create bakery cycle** — verify N variants → N product rows in snapshot
4. **Friend order** — verify grouped card display, independent +/- per variant
5. **Submit order with multiple variants** — verify order_items correct
6. **Distribution view** — verify variant label shown per line item
7. **Delete variant from catalog, check old cycle** — verify historical data intact
8. **Single-variant product** — verify it looks identical to current behavior
9. **Migration** — verify existing products get one variant each after schema migration
