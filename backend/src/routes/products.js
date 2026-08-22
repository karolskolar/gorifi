import { Router } from 'express';
import db from '../db/schema.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { safeFetch } from '../helpers/safe-fetch.js';
// PC-T2 (12 §UC-PC-003 parsing seam): the importers' parsing/column mapping was
// extracted VERBATIM into helpers/import-parsing.js — the catalog import
// (routes/coffee-products.js) shares it. The three per-cycle import routes
// below are otherwise UNTOUCHED and retire wholesale in PC-T8 (UC-PC-013).
import { parseCsvProducts, parseGsheetCsvProducts, parseMultiRowProducts, fetchGsheetCsv, parsePrice } from '../helpers/import-parsing.js';
// PC-T3 (12 §UC-PC-005): the manual per-cycle POST is the ONE sanctioned
// add-to-an-existing-cycle path and funnels its catalog half through the SAME
// consolidation layer as the importers. helpers/catalog.js stays the one
// normalizer (imported via catalog-import.js — never re-inlined here).
import { consolidateCatalogRow, exactCatalogMatch, singleRowReport } from '../helpers/catalog-import.js';
import { normalizeProductName, normalizeRoastery } from '../helpers/catalog.js';
import { cycleAvailability } from '../helpers/stock.js';
import { imageFromUpload, imageFromBody, detectImageMime } from '../helpers/image-upload.js';
import { uploadSingle } from '../helpers/multipart.js';
import { bindValue } from '../helpers/bind-value.js';

const router = Router();

// Get all products for a cycle
router.get('/cycle/:cycleId', (req, res) => {
  const products = db.prepare(`
    SELECT * FROM products WHERE cycle_id = ? AND active = 1 ORDER BY purpose, name
  `).all(req.params.cycleId);
  res.json(products);
});

// Get single product
router.get('/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }
  res.json(product);
});

// Get product availability for stock-limited products in a cycle.
// Counts friend orders AND guest sub-orders (see helpers/stock.js).
router.get('/cycle/:cycleId/availability', (req, res) => {
  // No excludeGuestOrderId here on purpose: this endpoint is public, and a guest
  // editing their own sub-order (GSO-T4) reads availability through their own
  // token-scoped payload, not through an id anyone could pass in a query string.
  //
  // ⚠ FUP-T13 — THE SHARPEST SITE IN THAT ROW: this endpoint is PUBLIC, carries NO
  // rate limiter, and `excludeFriendId` was handed straight to a bind in
  // `helpers/stock.js`. `?excludeFriendId[a]=1` — a plain GET, no credential, no body
  // — appended 1120 bytes of stack per request, i.e. a cheaper log-flood than the one
  // FUP-T12 was opened for. Guarded HERE rather than in `stock.js` because this is the
  // only caller that takes the value from a client: `orders.js` passes a route param
  // (always a string) and `guest.js` passes a row id. Unbindable ⇒ `undefined`, which
  // `orderedGramsByProduct` already treats as "no exclusion" — the absent-param answer.
  res.json(cycleAvailability(req.params.cycleId, { excludeFriendId: bindValue(req.query.excludeFriendId) }));
});

// Create single product (manual entry) - with optional image (admin)
router.post('/', requireAdmin, uploadSingle('image'), (req, res) => {
  // FUP-T13 — every field below is bound directly into the INSERT, so ANY of them
  // carrying an object/array/boolean was a 500 + ~1.1 KB of stack, not just `name`.
  // `bindValue` maps an unbindable value to `undefined`, which binds as NULL — byte
  // for byte what an absent field already stored — so the optional columns need no new
  // branch and `cycle_id`/`name` fall into the route's existing required-field 400.
  // ⚠ A numeric STRING must still pass through untouched: the admin form posts prices
  // and the stock limit as strings, so this deliberately does NOT demand a number.
  const cycle_id = bindValue(req.body.cycle_id);
  const name = bindValue(req.body.name);
  const description1 = bindValue(req.body.description1);
  const description2 = bindValue(req.body.description2);
  const roast_type = bindValue(req.body.roast_type);
  const purpose = bindValue(req.body.purpose);
  const price_150g = bindValue(req.body.price_150g);
  const price_200g = bindValue(req.body.price_200g);
  const price_250g = bindValue(req.body.price_250g);
  const price_500g = bindValue(req.body.price_500g);
  const price_1kg = bindValue(req.body.price_1kg);
  const price_20pc5g = bindValue(req.body.price_20pc5g);
  const roastery = bindValue(req.body.roastery);
  const stock_limit_g = bindValue(req.body.stock_limit_g);

  if (!cycle_id || !name) {
    return res.status(400).json({ error: 'cycle_id a nazov su povinne' });
  }

  // Handle image - either from file upload or base64 in body
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

  // The snapshot INSERT, byte-for-byte the pre-PC-T3 statement plus the
  // source_coffee_product_id link (12 §UC-PC-005: "INSERTs the snapshot as
  // today PLUS source_coffee_product_id").
  const insertSnapshot = (sourceCoffeeProductId) => db.prepare(`
    INSERT INTO products (cycle_id, name, description1, description2, roast_type, purpose, price_150g, price_200g, price_250g, price_500g, price_1kg, price_20pc5g, image, roastery, stock_limit_g, source_coffee_product_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cycle_id, name, description1, description2, roast_type, purpose, price_150g, price_200g, price_250g, price_500g || null, price_1kg, price_20pc5g, image, roastery || null, stock_limit_g ? parseInt(stock_limit_g) : null, sourceCoffeeProductId);

  // PC-T3 (12 §UC-PC-005): consolidation runs ONLY when the target cycle is a
  // coffee cycle — bakery-cycle rows are never consolidated and never touch
  // coffee_products (brief Decision 6). A nonexistent cycle_id has no type, so
  // it takes the plain path and fails on the products FK exactly as before
  // (500 — pinned by image-upload.spec.js's FK-fault probe; crucially it must
  // not leave an orphan catalog row behind).
  const cycle = db.prepare('SELECT type FROM order_cycles WHERE id = ?').get(cycle_id);
  const isCoffeeCycle = !!cycle && (cycle.type || 'coffee') === 'coffee';

  if (!isCoffeeCycle) {
    const result = insertSnapshot(null);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    return res.status(201).json(product);
  }

  // The catalog half sees the body the way the importers see a sheet row: the
  // admin form posts prices as strings, so they go through the SAME parsePrice
  // an imported price gets (a non-price stays off the row — consolidation
  // treats only numbers as "supplied").
  const parsedRow = {
    name,
    description1,
    description2,
    roast_type,
    purpose,
    price_150g: parsePrice(price_150g),
    price_200g: parsePrice(price_200g),
    price_250g: parsePrice(price_250g),
    price_500g: parsePrice(price_500g),
    price_1kg: parsePrice(price_1kg),
    price_20pc5g: parsePrice(price_20pc5g),
  };

  // ONE synchronous transaction for the whole coffee path (the handler has no
  // await anywhere — the GA-T8 discipline): the duplicate check, the catalog
  // write and the snapshot INSERT commit or roll back together, so a refused
  // POST writes nothing and an FK failure cannot strand a catalog row.
  const createConsolidated = db.transaction(() => {
    // Duplicate guard (12 §UC-PC-005): a POST whose exact match already has a
    // snapshot in the TARGET cycle is refused BEFORE consolidateCatalogRow runs
    // — a 409 must not even apply the decision-13 price refresh. "Has a
    // snapshot" is checked by link AND by normalized identity: snapshots made
    // before PC-T3 (or before the PC-T4 migration runs) carry no
    // source_coffee_product_id, and re-adding one of those is the same admin
    // mistake the module exists to catch. Active rows only — a soft-deleted
    // product must stay re-addable.
    const match = exactCatalogMatch(name, roastery);
    if (match) {
      const inCycle = db.prepare(
        'SELECT name, roastery, source_coffee_product_id FROM products WHERE cycle_id = ? AND active = 1'
      ).all(cycle_id);
      const dup = inCycle.some((p) =>
        p.source_coffee_product_id === match.id ||
        (normalizeProductName(p.name) === match.normalized_name && normalizeRoastery(p.roastery) === match.roastery)
      );
      if (dup) return { duplicate: true };
    }

    // opts.image — the UC-PC-005 dual store: the image lands on the SNAPSHOT
    // via insertSnapshot (existing behavior, wins the UC-PC-012 COALESCE) and,
    // when the row CREATES a catalog entry, additionally on the new catalog row
    // (the friction win — the next cycle reuses it). A MATCH never writes the
    // catalog image: image is admin-only there (resolved decision 13).
    const rowResult = consolidateCatalogRow(parsedRow, roastery, { image });
    const report = singleRowReport(rowResult);
    // 'skipped' (a name that normalizes to '') keeps today's snapshot-only
    // behavior: no catalog row exists to link.
    const sourceId = rowResult.outcome === 'skipped' ? null : rowResult.catalog_id;
    const result = insertSnapshot(sourceId);
    return { productId: result.lastInsertRowid, report };
  });

  const created = createConsolidated();
  if (created.duplicate) {
    return res.status(409).json({ error: 'Produkt už v tomto cykle existuje.', reason: 'duplicate_in_cycle' });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(created.productId);
  // Byte-compatible 201: the snapshot row at the top level (this endpoint's
  // consumers read fields straight off the body) plus the UC-PC-004 report
  // with exactly one row accounted for.
  res.status(201).json({ ...product, report: created.report });
});

// Import products from CSV (admin)
router.post('/import/:cycleId', requireAdmin, uploadSingle('file'), (req, res) => {
  const cycleId = req.params.cycleId;
  // ⚠ FUP-T15 — THE RECORDED "LATENT" BLOCKER ON THIS ROUTE WAS FALSE. It read
  // "the route requires `req.file`, so the body is multipart and every field is a
  // string". multer parses fields with the `append-field` package, which honours
  // bracket notation and repeated keys — so `roastery[a]=1` really did arrive as an
  // OBJECT, was bound into the per-row INSERT below, and this route's own try/catch
  // answered 400 with the BINDER'S OWN SENTENCE echoed to the client ("Chyba pri
  // parsovani CSV: Too few parameter values were provided") after `console.error`
  // wrote ~1.1 KB of stack. Unbindable ⇒ `undefined` ⇒ `|| null` ⇒ exactly what an
  // absent `roastery` field already stores.
  const roastery = bindValue(req.body.roastery) || null;

  // Check cycle exists
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Ziaden subor nebol nahrany' });
  }

  try {
    const csvContent = req.file.buffer.toString('utf-8');
    // Column mapping + price parsing moved verbatim to helpers/import-parsing.js
    // (PC-T2); the helper returns every record mapped, and the `if (p.name)`
    // skip below is the route's original behavior, unchanged.
    const records = parseCsvProducts(csvContent);

    const insertStmt = db.prepare(`
      INSERT INTO products (cycle_id, name, description1, description2, roast_type, purpose, price_250g, price_1kg, roastery)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((products) => {
      const results = [];
      for (const p of products) {
        if (p.name) {
          const result = insertStmt.run(cycleId, p.name, p.description1, p.description2, p.roast_type, p.purpose, p.price_250g, p.price_1kg, roastery);
          results.push(result.lastInsertRowid);
        }
      }
      return results;
    });

    const insertedIds = insertMany(records);

    const products = db.prepare(`
      SELECT * FROM products WHERE id IN (${insertedIds.map(() => '?').join(',')})
    `).all(...insertedIds);

    res.status(201).json({
      message: `${products.length} produktov bolo importovanych`,
      products
    });
  } catch (error) {
    console.error('CSV parse error:', error);
    res.status(400).json({ error: 'Chyba pri parsovani CSV: ' + error.message });
  }
});

// Upload image for existing product (admin)
router.post('/:id/image', requireAdmin, uploadSingle('image'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

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

  db.prepare('UPDATE products SET image = ? WHERE id = ?').run(image, req.params.id);

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Upload image from URL (for drag & drop from external sites) (admin)
// SSRF-guarded (SEC-H1): safeFetch rejects private/loopback/link-local targets,
// refuses redirects, and caps time + size.
router.post('/:id/image-from-url', requireAdmin, async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL obrazku je povinne' });
  }

  try {
    // Fetch image from URL (SSRF-guarded)
    const response = await safeFetch(url);
    if (!response.ok) {
      return res.status(400).json({ error: 'Nepodarilo sa stiahnut obrazok z URL' });
    }

    // Determine the type from the actual bytes, not the (untrusted) remote
    // Content-Type header — a server could label HTML/SVG as an image.
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = detectImageMime(buffer);
    if (!contentType) {
      return res.status(400).json({ error: 'URL neobsahuje platný obrázok (PNG, JPEG, GIF, WebP)' });
    }

    const base64 = buffer.toString('base64');
    const image = `data:${contentType};base64,${base64}`;

    db.prepare('UPDATE products SET image = ? WHERE id = ?').run(image, req.params.id);

    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (error) {
    console.error('Image download error:', error);
    res.status(400).json({ error: 'Chyba pri stahivani obrazku: ' + error.message });
  }
});

// Update product (admin)
router.patch('/:id', requireAdmin, (req, res) => {
  // FUP-T13 — as on POST, plus the half a status check cannot see. Every gate below
  // is `!== undefined`, so an unbindable value now SKIPS its write and the stored
  // column survives; an explicit null still clears. ⚠ `stock_limit_g` was already
  // silently destructive before this: `{}` is truthy, `parseInt({})` is NaN, and
  // better-sqlite3 binds NaN as NULL — so a malformed body answered 200 and REMOVED a
  // product's stock limit. `active` is `? 1 : 0` and never bound raw, so it is left
  // exactly as it was.
  const name = bindValue(req.body.name);
  const description1 = bindValue(req.body.description1);
  const description2 = bindValue(req.body.description2);
  const roast_type = bindValue(req.body.roast_type);
  const purpose = bindValue(req.body.purpose);
  const price_150g = bindValue(req.body.price_150g);
  const price_200g = bindValue(req.body.price_200g);
  const price_250g = bindValue(req.body.price_250g);
  const price_500g = bindValue(req.body.price_500g);
  const price_1kg = bindValue(req.body.price_1kg);
  const price_20pc5g = bindValue(req.body.price_20pc5g);
  const image = bindValue(req.body.image);
  const roastery = bindValue(req.body.roastery);
  const stock_limit_g = bindValue(req.body.stock_limit_g);
  const { active } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  const updates = [];
  const values = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (description1 !== undefined) { updates.push('description1 = ?'); values.push(description1); }
  if (description2 !== undefined) { updates.push('description2 = ?'); values.push(description2); }
  if (roast_type !== undefined) { updates.push('roast_type = ?'); values.push(roast_type); }
  if (purpose !== undefined) { updates.push('purpose = ?'); values.push(purpose); }
  if (price_150g !== undefined) { updates.push('price_150g = ?'); values.push(price_150g); }
  if (price_200g !== undefined) { updates.push('price_200g = ?'); values.push(price_200g); }
  if (price_250g !== undefined) { updates.push('price_250g = ?'); values.push(price_250g); }
  if (price_500g !== undefined) { updates.push('price_500g = ?'); values.push(price_500g); }
  if (price_1kg !== undefined) { updates.push('price_1kg = ?'); values.push(price_1kg); }
  if (price_20pc5g !== undefined) { updates.push('price_20pc5g = ?'); values.push(price_20pc5g); }
  if (image !== undefined) { updates.push('image = ?'); values.push(image); }
  if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0); }
  if (roastery !== undefined) { updates.push('roastery = ?'); values.push(roastery || null); }
  if (stock_limit_g !== undefined) { updates.push('stock_limit_g = ?'); values.push(stock_limit_g ? parseInt(stock_limit_g) : null); }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete product (soft delete - set active = 0) (admin)
router.delete('/:id', requireAdmin, (req, res) => {
  const result = db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }
  res.status(204).send();
});

// Import products from Google Sheets URL (admin)
router.post('/import-gsheet/:cycleId', requireAdmin, async (req, res) => {
  const cycleId = req.params.cycleId;
  // ⚠ FUP-T15 — same class and same file as the CSV import above: `roastery` is bound
  // into every inserted row. Reaching it needs a live public sheet, so it is not
  // exercisable from the e2e suite — but the shape is identical and so is the cost
  // (this route's catch logs the whole Error, i.e. a full stack, and echoes
  // `error.message` to the client). Unbindable ⇒ absent, exactly as `|| null` already
  // treats an empty field.
  const { url } = req.body;
  const roastery = bindValue(req.body.roastery);

  // Check cycle exists
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  // ⚠ FUP-T12: a non-string reached `url.match(...)` below and threw a TypeError. The
  // route's own try/catch already turned that into a 400, so the STATUS looked fine —
  // but it ECHOED `url.match is not a function` to the client and still wrote ~1.2 KB
  // of stack to the log per request. Folded into the existing presence rule: same
  // status, same message, and a string url still reaches the parser unchanged.
  if (typeof url !== 'string' || !url) {
    return res.status(400).json({ error: 'URL je povinne' });
  }

  try {
    // Sheet-id/gid extraction + safeFetch moved verbatim to
    // helpers/import-parsing.js (PC-T2). Error mapping stays here so the
    // messages are byte-identical; a safeFetch throw still lands in this
    // route's own catch, exactly as before.
    const fetched = await fetchGsheetCsv(url);
    if (fetched.error === 'invalid_url') {
      return res.status(400).json({ error: 'Neplatna Google Sheets URL' });
    }
    if (fetched.error) {
      return res.status(400).json({ error: 'Nepodarilo sa nacitat Google Sheet. Skontrolujte ci je sheet verejny.' });
    }

    // Column mapping + price parsing moved verbatim to the same helper
    // (⚠ the gsheet mapper keeps its extra 'Chutovy profil' alias).
    const records = parseGsheetCsvProducts(fetched.csvContent);

    const insertStmt = db.prepare(`
      INSERT INTO products (cycle_id, name, description1, description2, roast_type, purpose, price_250g, price_1kg, roastery)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((products) => {
      const results = [];
      for (const p of products) {
        if (p.name) {
          const result = insertStmt.run(cycleId, p.name, p.description1, p.description2, p.roast_type, p.purpose, p.price_250g, p.price_1kg, roastery || null);
          results.push(result.lastInsertRowid);
        }
      }
      return results;
    });

    const insertedIds = insertMany(records);

    if (insertedIds.length === 0) {
      return res.status(400).json({ error: 'Ziadne produkty neboli najdene. Skontrolujte nazvy stlpcov.' });
    }

    const products = db.prepare(`
      SELECT * FROM products WHERE id IN (${insertedIds.map(() => '?').join(',')})
    `).all(...insertedIds);

    res.status(201).json({
      message: `${products.length} produktov bolo importovanych z Google Sheets`,
      products
    });
  } catch (error) {
    console.error('Google Sheets import error:', error);
    res.status(400).json({ error: 'Chyba pri importe: ' + error.message });
  }
});

// Import products from Google Sheets with multi-row format (3 rows per product) (admin)
router.post('/import-gsheet-multirow/:cycleId', requireAdmin, async (req, res) => {
  const cycleId = req.params.cycleId;
  // ⚠ FUP-T15 — same class and same file as the CSV import above: `roastery` is bound
  // into every inserted row. Reaching it needs a live public sheet, so it is not
  // exercisable from the e2e suite — but the shape is identical and so is the cost
  // (this route's catch logs the whole Error, i.e. a full stack, and echoes
  // `error.message` to the client). Unbindable ⇒ absent, exactly as `|| null` already
  // treats an empty field.
  const { url } = req.body;
  const roastery = bindValue(req.body.roastery);

  // Check cycle exists
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  // ⚠ FUP-T12: a non-string reached `url.match(...)` below and threw a TypeError. The
  // route's own try/catch already turned that into a 400, so the STATUS looked fine —
  // but it ECHOED `url.match is not a function` to the client and still wrote ~1.2 KB
  // of stack to the log per request. Folded into the existing presence rule: same
  // status, same message, and a string url still reaches the parser unchanged.
  if (typeof url !== 'string' || !url) {
    return res.status(400).json({ error: 'URL je povinne' });
  }

  try {
    // Sheet-id/gid extraction + safeFetch moved verbatim to
    // helpers/import-parsing.js (PC-T2); error mapping stays here so the
    // messages are byte-identical, and a safeFetch throw still lands in this
    // route's own catch, exactly as before.
    const fetched = await fetchGsheetCsv(url);
    if (fetched.error === 'invalid_url') {
      return res.status(400).json({ error: 'Neplatna Google Sheets URL' });
    }
    if (fetched.error) {
      return res.status(400).json({
        error: 'Nepodarilo sa nacitat Google Sheet. Skontrolujte ci je sheet verejny.'
      });
    }

    // Parse with multi-row logic (moved verbatim to the same helper)
    const { products, warnings } = parseMultiRowProducts(fetched.csvContent);

    if (products.length === 0) {
      return res.status(400).json({
        error: 'Ziadne produkty neboli najdene. Skontrolujte format sheetu (3 riadky na produkt, oddelene prazdnym riadkom).'
      });
    }

    // Insert products into database (without transaction wrapper to avoid sql.js issues)
    const insertedIds = [];
    for (const p of products) {
      if (p.name) {
        const result = db.prepare(`
          INSERT INTO products (cycle_id, name, description1, description2, roast_type, purpose, price_150g, price_200g, price_250g, price_1kg, roastery)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(cycleId, p.name, p.description1, p.description2, p.roast_type, p.purpose, p.price_150g, p.price_200g, p.price_250g, p.price_1kg, roastery || null);
        insertedIds.push(result.lastInsertRowid);
      }
    }

    if (insertedIds.length === 0) {
      return res.status(400).json({
        error: 'Ziadne produkty neboli importovane. Skontrolujte format sheetu.'
      });
    }

    const insertedProducts = db.prepare(`
      SELECT * FROM products WHERE id IN (${insertedIds.map(() => '?').join(',')})
    `).all(...insertedIds);

    res.status(201).json({
      message: `${insertedProducts.length} produktov bolo importovanych z Google Sheets`,
      products: insertedProducts,
      warnings: warnings
    });

  } catch (error) {
    console.error('Google Sheets multi-row import error:', error);
    res.status(400).json({ error: 'Chyba pri importe: ' + error.message });
  }
});

export default router;
