import { Router } from 'express';
import db from '../db/schema.js';
import { uploadSingle } from '../helpers/multipart.js';
import { bindValue } from '../helpers/bind-value.js';
// PC-T10 (12 §UC-PC-014): the image write paths store content-hash FILES and
// write the URL path into the column — base64 never enters a column on these
// paths again. Same magic-byte validation as before (image-store sniffs via
// detectImageMime), same request contracts (multipart AND body base64).
import { imageUrlFromUpload, imageUrlFromBody, storeImage } from '../helpers/image-store.js';
import { normalizeProductName, normalizeRoastery } from '../helpers/catalog.js';
import { parseCsvProducts, parseGsheetCsvProducts, parseMultiRowProducts, fetchGsheetCsv } from '../helpers/import-parsing.js';
import { importRowsIntoCatalog } from '../helpers/catalog-import.js';
import { pendingMigrationGroups, parseGroupSelection, assignGroupsToCatalog, createCatalogFromGroups, ignoreGroups, unignoreGroups, ignoredMigrationGroups, createManualCatalogRow } from '../helpers/catalog-workbench.js';
import { mergeCatalogRows, findDuplicatePairs } from '../helpers/catalog-merge.js';
import { coffeeCycleWindow, catalogRanking, catalogProductStats, allTimeKgByCatalogId } from '../helpers/catalog-stats.js';

// Coffee-product catalog routes — module 12 (PC-T2 opened this file with the
// three UC-PC-003 import endpoints; PC-T5/T6/T7 added merge/duplicates/CRUD/
// stats; PC-T9 replaced PC-T4's auto-migration with the manual assignment
// workbench — all on the SAME router).
//
// ⚠ WHOLE-MOUNT ADMIN: index.js mounts this as
//   app.use('/api/coffee-products', requireAdmin, coffeeProductsRouter)
// (the bakery-products precedent). No public or friend route may ever live
// here — module 13's friend-facing catalog reads are separate Bearer-guarded
// routes OUTSIDE this mount (12 §UC-PC-009). Every route added here also joins
// ADMIN_ENDPOINTS in e2e/tests/api-security.spec.js (standing invariant).
//
// ⚠ Imports NEVER touch any cycle (resolved decisions 11+12): the handlers
// below call the parsing helper and importRowsIntoCatalog and nothing else —
// keep the call sites trivial (§Accepted risks: the gsheet paths are not
// e2e-exercisable, so a bespoke divergence here would escape the suite; the
// e2e pins exactly one importRowsIntoCatalog call per endpoint).
//
// ⚠ GA-T8 discipline on the two gsheet routes: the ONLY await is the sheet
// fetch, and it completes BEFORE importRowsIntoCatalog enters its single
// synchronous db.transaction. Never add an await below the fetch.
//
// ⚠ FUP-T12/T15 guards carried from birth (12 §UC-PC-013: the guards do not
// retire with the legacy routes): `typeof url !== 'string'` → 400 with the
// route's own message, `bindValue(req.body.roastery)` (multer's append-field
// really does deliver objects/arrays for bracketed or repeated multipart
// fields), errors never echo internal messages, console.error logs e.message
// only — never a stack (the FUP-T3/FUP-T7 log-flood rule).

const router = Router();

// Import products from CSV into the CATALOG (admin) — the format of the legacy
// POST /api/products/import/:cycleId, retargeted per resolved decision 12.
router.post('/import', uploadSingle('file'), (req, res) => {
  const roastery = bindValue(req.body.roastery) || null;

  if (!req.file) {
    return res.status(400).json({ error: 'Ziaden subor nebol nahrany' });
  }

  let rows;
  try {
    rows = parseCsvProducts(req.file.buffer.toString('utf-8'));
  } catch (error) {
    console.error('Catalog CSV import parse error:', error.message);
    return res.status(400).json({ error: 'Chyba pri parsovani CSV. Skontrolujte format suboru.' });
  }

  try {
    const report = importRowsIntoCatalog(rows, roastery);
    return res.status(201).json({ report });
  } catch (error) {
    console.error('Catalog CSV import error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa importovat produkty' });
  }
});

// Import products from a Google Sheets URL (columns-with-headers format) into
// the CATALOG (admin).
router.post('/import-gsheet', async (req, res) => {
  const { url } = req.body;
  const roastery = bindValue(req.body.roastery) || null;

  if (typeof url !== 'string' || !url) {
    return res.status(400).json({ error: 'URL je povinne' });
  }

  let fetched;
  try {
    fetched = await fetchGsheetCsv(url);
  } catch (error) {
    // safeFetch refusal (SSRF guard, timeout, network) — a fetch problem, never
    // an echo of the underlying error.
    console.error('Catalog gsheet import fetch error:', error.message);
    return res.status(400).json({ error: 'Nepodarilo sa nacitat Google Sheet. Skontrolujte ci je sheet verejny.' });
  }
  if (fetched.error === 'invalid_url') {
    return res.status(400).json({ error: 'Neplatna Google Sheets URL' });
  }
  if (fetched.error) {
    return res.status(400).json({ error: 'Nepodarilo sa nacitat Google Sheet. Skontrolujte ci je sheet verejny.' });
  }

  // Last await is behind us — everything below is synchronous (GA-T8).
  let rows;
  try {
    rows = parseGsheetCsvProducts(fetched.csvContent);
  } catch (error) {
    console.error('Catalog gsheet import parse error:', error.message);
    return res.status(400).json({ error: 'Chyba pri parsovani CSV. Skontrolujte format suboru.' });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Ziadne produkty neboli najdene. Skontrolujte nazvy stlpcov.' });
  }

  try {
    const report = importRowsIntoCatalog(rows, roastery);
    return res.status(201).json({ report });
  } catch (error) {
    console.error('Catalog gsheet import error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa importovat produkty' });
  }
});

// Import products from a Google Sheets URL with the multi-row format (3 rows
// per product — the adapted sheet's PRIMARY path) into the CATALOG (admin).
router.post('/import-gsheet-multirow', async (req, res) => {
  const { url } = req.body;
  const roastery = bindValue(req.body.roastery) || null;

  if (typeof url !== 'string' || !url) {
    return res.status(400).json({ error: 'URL je povinne' });
  }

  let fetched;
  try {
    fetched = await fetchGsheetCsv(url);
  } catch (error) {
    console.error('Catalog multirow import fetch error:', error.message);
    return res.status(400).json({ error: 'Nepodarilo sa nacitat Google Sheet. Skontrolujte ci je sheet verejny.' });
  }
  if (fetched.error === 'invalid_url') {
    return res.status(400).json({ error: 'Neplatna Google Sheets URL' });
  }
  if (fetched.error) {
    return res.status(400).json({ error: 'Nepodarilo sa nacitat Google Sheet. Skontrolujte ci je sheet verejny.' });
  }

  // Last await is behind us — everything below is synchronous (GA-T8).
  let parsed;
  try {
    parsed = parseMultiRowProducts(fetched.csvContent);
  } catch (error) {
    console.error('Catalog multirow import parse error:', error.message);
    return res.status(400).json({ error: 'Chyba pri parsovani CSV. Skontrolujte format suboru.' });
  }

  if (parsed.products.length === 0) {
    return res.status(400).json({
      error: 'Ziadne produkty neboli najdene. Skontrolujte format sheetu (3 riadky na produkt, oddelene prazdnym riadkom).'
    });
  }

  try {
    // Multirow parser warnings fold into the report's `warnings` bucket —
    // "imported, but check this" — kept separate from `unparsed`, which is
    // strictly the skipped rows (PC-T12's honest split of UC-PC-004). Nothing
    // is silently guessed or dropped.
    const report = importRowsIntoCatalog(parsed.products, roastery, { warnings: parsed.warnings });
    return res.status(201).json({ report });
  } catch (error) {
    console.error('Catalog multirow import error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa importovat produkty' });
  }
});

// ── The migration workbench (admin) — 12 §UC-PC-006 (PC-T9) ────────────────
//
// REPLACES the shipped POST /migrate (resolved decision 14 — the auto-flow's
// fuzzy suggestions merged unrelated products; the retired route now answers
// 404, no tombstone handler). NO similarity/fuzzy math anywhere in these three
// routes. Fully synchronous — no await (GA-T8); each mutating handler is ONE
// db.transaction inside the helper. Literal paths, registered ABOVE the
// parametric routes like /duplicates and /stats.

// The pending list: one row per distinct (normalized_name, roastery) over the
// unlinked historical coffee snapshots. Read-only.
router.get('/migration/pending', (req, res) => {
  try {
    return res.json(pendingMigrationGroups());
  } catch (error) {
    console.error('Migration pending error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa nacitat nespracovane produkty' });
  }
});

// Assign the selected groups to an EXISTING catalog product. Raced/empty
// groups are skip-and-report (never 404 — group keys are derived, not stored);
// cross-roastery is refused unconditionally.
router.post('/migration/assign', (req, res) => {
  const selection = parseGroupSelection(req.body?.groups);
  if (!selection) {
    return res.status(400).json({ error: 'Neplatny vyber skupin', field: 'groups' });
  }

  // catalog_id — bindValue hygiene (FUP-T13): missing/unbindable is a 400
  // about the request shape; a non-integer can match no row, so it is the
  // same 404 as an unknown id (the merge-route pattern).
  const rawId = bindValue(req.body?.catalog_id);
  if (rawId === undefined || rawId === null || rawId === '') {
    return res.status(400).json({ error: 'catalog_id je povinne', field: 'catalog_id' });
  }
  const catalogId = Number(rawId);
  if (!Number.isInteger(catalogId)) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }

  try {
    const catalog = db.prepare('SELECT id, roastery FROM coffee_products WHERE id = ?').get(catalogId);
    if (!catalog) {
      return res.status(404).json({ error: 'Produkt neexistuje' });
    }
    // Cross-roastery identity is never crossed (the UC-PC-007 merge-tool
    // precedent) — ANY group under another roastery refuses the whole call.
    if (selection.some((g) => g.roastery !== catalog.roastery)) {
      return res.status(409).json({ error: 'Produkty patria roznym praziarniam', field: 'roastery' });
    }
    return res.json(assignGroupsToCatalog(selection, catalogId));
  } catch (error) {
    console.error('Migration assign error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa priradit produkty' });
  }
});

// Create ONE catalog product from the newest snapshot across the selection,
// then link everything selected. Unconditional create — deliberately NOT via
// consolidateCatalogRow (its match-or-refresh semantics would silently convert
// "create new" into "match-and-refresh"; fuzzy is banned here).
router.post('/migration/create', (req, res) => {
  const selection = parseGroupSelection(req.body?.groups);
  if (!selection) {
    return res.status(400).json({ error: 'Neplatny vyber skupin', field: 'groups' });
  }
  // One catalog row has one roastery — a selection spanning two refuses.
  if (selection.some((g) => g.roastery !== selection[0].roastery)) {
    return res.status(409).json({ error: 'Produkty patria roznym praziarniam', field: 'roastery' });
  }

  try {
    const result = createCatalogFromGroups(selection);
    if (result.outcome === 'nothing_to_create') {
      // Zero unlinked snapshots — nothing to create from. Also the
      // double-fire guard: a repeated create 400s instead of minting a
      // duplicate catalog row.
      return res.status(400).json({ error: 'Ziadne neprepojene produkty vo vybere', field: 'groups' });
    }
    if (result.outcome === 'name_collision') {
      // The assign hand-off: the 409 names the existing row so the UI can
      // offer "Priradiť k existujúcemu" instead.
      return res.status(409).json({
        error: 'Produkt s tymto nazvom uz v katalogu existuje',
        field: 'name',
        catalog_id: result.catalog_id,
      });
    }
    // Return the created row in the LIST shape (cycles_count + all_time_kg)
    // so the UI can append it to the catalog list straight from this payload.
    const row = db.prepare(`
      SELECT cp.*,
        (SELECT COUNT(DISTINCT p.cycle_id) FROM products p
          WHERE p.source_coffee_product_id = cp.id) AS cycles_count
      FROM coffee_products cp WHERE cp.id = ?
    `).get(result.catalog_id);
    const kg = allTimeKgByCatalogId();
    return res.status(201).json({
      catalog: { ...row, all_time_kg: kg.get(row.id) || 0 },
      linked_snapshots: result.linked_snapshots,
      skipped: result.skipped,
      pending_count: result.pending_count,
    });
  } catch (error) {
    console.error('Migration create error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa vytvorit produkt' });
  }
});

// Workbench "Ignorovať" (PC-T13, PM gap 3): explicit dismissal for junk
// pending groups (sheet section headers — the prod case `Nespresso kapsule`:
// 5 snapshots, 0 order_items). Soft-delete would NOT hide them (CANDIDATE_SQL
// has no `active` filter); this writes exactly ONE column
// (products.migration_ignored) in ONE transaction. Same body shape as assign.
// A group whose snapshots HAVE order_items refuses with 409 and the count —
// real history needs a catalog identity, hiding it would drop it from stats.
router.post('/migration/ignore', (req, res) => {
  const selection = parseGroupSelection(req.body?.groups);
  if (!selection) {
    return res.status(400).json({ error: 'Neplatny vyber skupin', field: 'groups' });
  }
  try {
    const result = ignoreGroups(selection);
    if (result.outcome === 'has_orders') {
      return res.status(409).json({
        error: `Skupina „${result.display_name}“ má objednávky (${result.order_items}) — nie je možné ju ignorovať. Priraďte ju do katalógu.`,
        field: 'groups',
        order_items: result.order_items,
      });
    }
    const { outcome, ...body } = result;
    return res.json(body);
  } catch (error) {
    console.error('Migration ignore error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa ignorovat skupiny' });
  }
});

// The undo — restores dismissed groups to the pending list.
router.post('/migration/unignore', (req, res) => {
  const selection = parseGroupSelection(req.body?.groups);
  if (!selection) {
    return res.status(400).json({ error: 'Neplatny vyber skupin', field: 'groups' });
  }
  try {
    return res.json(unignoreGroups(selection));
  } catch (error) {
    console.error('Migration unignore error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa obnovit skupiny' });
  }
});

// The review surface for dismissed groups — same row shape as /pending.
router.get('/migration/ignored', (req, res) => {
  try {
    return res.json(ignoredMigrationGroups());
  } catch (error) {
    console.error('Migration ignored list error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa nacitat ignorovane skupiny' });
  }
});

// One-time image conversion (admin) — 12 §UC-PC-014 (PC-T10, the
// migration-endpoint precedent). Converts every legacy `data:%` value in
// coffee_products.image AND in products.image rows of COFFEE cycles
// (COALESCE(order_cycles.type,'coffee')='coffee', source_bakery_product_id IS
// NULL — bakery is out of scope) to a content-hash file + URL, so old cycles'
// friend pages get the payload win too.
//
// Idempotent: rows already holding URL values or NULL don't match the LIKE and
// are never touched — a second run converts 0. Per row the FILE is written
// first (inside storeImage), the column second, so a crash between the two
// leaves a valid state: the old base64 still in the column, an orphan file on
// disk that the re-run reuses by hash. An unparseable/non-raster legacy value
// is SKIPPED and reported, never dropped.
//
// Fully synchronous, no await (writeFileSync — consistent with the
// `instances: 1` + synchronous-handler concurrency model; ~10 MB of writes is
// a one-time admin action, not a hot path). Registered ABOVE the parametric
// routes, like /duplicates.
router.post('/convert-images', (req, res) => {
  try {
    const skipped = [];
    let bytesFreed = 0;

    const convertRows = (table, rows) => {
      let converted = 0;
      for (const row of rows) {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(row.image);
        if (!m) {
          skipped.push({ table, id: row.id, reason: 'unparseable' });
          continue;
        }
        // File first (storeImage writes it before returning), column second.
        const stored = storeImage(Buffer.from(m[2], 'base64'));
        if (stored.error) {
          skipped.push({ table, id: row.id, reason: 'not_an_image' });
          continue;
        }
        db.prepare(`UPDATE ${table} SET image = ? WHERE id = ?`).run(stored.url, row.id);
        // The PM-visible payoff number: base64 string length removed from columns.
        bytesFreed += row.image.length;
        converted++;
      }
      return converted;
    };

    const catalogRows = db.prepare(
      "SELECT id, image FROM coffee_products WHERE image LIKE 'data:%'"
    ).all();
    const snapshotRows = db.prepare(`
      SELECT p.id, p.image
      FROM products p
      JOIN order_cycles c ON c.id = p.cycle_id
      WHERE p.image LIKE 'data:%'
        AND COALESCE(c.type, 'coffee') = 'coffee'
        AND p.source_bakery_product_id IS NULL
    `).all();

    const converted_catalog = convertRows('coffee_products', catalogRows);
    const converted_snapshots = convertRows('products', snapshotRows);

    return res.json({
      converted_catalog,
      converted_snapshots,
      skipped,
      bytes_freed: bytesFreed,
      second_run_hint: 'Opakované spustenie je bezpečné — už skonvertované riadky sa preskočia.',
    });
  } catch (error) {
    console.error('Image conversion error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa skonvertovat obrazky' });
  }
});

// Stateless fuzzy-duplicate review (admin) — 12 §UC-PC-008 (PC-T5). Recomputed
// on demand from the catalog; no pending-state table, no dismiss state. The
// admin resolves a pair with the merge below (it disappears from the next
// recompute) or leaves it (two genuinely different coffees). Registered ABOVE
// the /:id routes so PC-T7's future GET /:id can never shadow it.
router.get('/duplicates', (req, res) => {
  try {
    return res.json(findDuplicatePairs());
  } catch (error) {
    console.error('Catalog duplicates error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa nacitat duplicity' });
  }
});

// Cross-cycle statistics ranking (admin) — 12 §UC-PC-010 (PC-T6). Pure
// computation lives in helpers/catalog-stats.js (module 13 imports those
// FUNCTIONS server-side — never this endpoint). Fully synchronous — no await
// (GA-T8). Registered ABOVE the parametric routes, like /duplicates, so a
// future GET /:id can never shadow it.
router.get('/stats', (req, res) => {
  // Window: last N coffee cycles, ordered created_at DESC, id DESC (the
  // GSO-T8 same-second tiebreak — mandatory). Omitted = all time.
  let lastN = null;
  // ⚠ Deliberate asymmetry: `?purpose=` (empty) means "no filter", but `?last_n_cycles=`
  // (empty) 400s — a window must be a positive integer or absent. PC-T7's UI must OMIT
  // the param for "all time", never send it empty. Do not "fix" either side to match the other.
  if (req.query.last_n_cycles !== undefined) {
    lastN = Number(req.query.last_n_cycles);
    if (!Number.isInteger(lastN) || lastN < 1) {
      return res.status(400).json({ error: 'last_n_cycles musi byt kladne cele cislo', field: 'last_n_cycles' });
    }
  }

  // Purpose filter partitions by the CATALOG row's purpose. A repeated or
  // bracketed query param arrives as an array — refuse, never coerce
  // (the FUP-T13 discipline applied to query strings).
  let purpose = null;
  if (req.query.purpose !== undefined) {
    if (typeof req.query.purpose !== 'string') {
      return res.status(400).json({ error: 'purpose musi byt retazec', field: 'purpose' });
    }
    purpose = req.query.purpose || null; // empty string = no filter
  }

  try {
    const cycleIds = coffeeCycleWindow(lastN);
    const products = catalogRanking({ purpose, cycleIds });
    // `window` names the cycles the numbers were computed over — auditable.
    return res.json({ products, window: { cycle_ids: cycleIds } });
  } catch (error) {
    console.error('Catalog stats error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa nacitat statistiky' });
  }
});

// Per-product statistics (admin) — availability history + order trend (one
// per-cycle series: every offering cycle with the friend/guest kg split) and
// the per friend × product table (friends ONLY — Decision 4). All-time.
router.get('/:id/stats', (req, res) => {
  const id = Number(req.params.id);
  // A non-integer id can match no row — 404 without binding a NaN/float.
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }
  try {
    const result = catalogProductStats(id);
    if (!result) {
      return res.status(404).json({ error: 'Produkt neexistuje' });
    }
    return res.json(result);
  } catch (error) {
    console.error('Catalog product stats error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa nacitat statistiky' });
  }
});

// Merge catalog row B (body.source_id) INTO A (:id) — 12 §UC-PC-007 (PC-T5).
// The permanent safety valve for the migration's fuzzy tail, import
// near-misses, and any future duplicate — and the module's ONLY catalog-row
// deleter (decision 9). Fully synchronous — no await (GA-T8); the helper runs
// the two writes inside ONE db.transaction. UI (duplicates section, per-pair
// merge buttons) lands in PC-T7 — API-only here.
router.post('/:id/merge', (req, res) => {
  // 400 — source_id missing/unbindable (the FUP-T13 bindValue discipline: an
  // object/array/bool body value must refuse cleanly, never reach a binder).
  const sourceRaw = bindValue(req.body?.source_id);
  if (sourceRaw === undefined || sourceRaw === null || sourceRaw === '') {
    return res.status(400).json({ error: 'source_id je povinne', field: 'source_id' });
  }

  const targetId = Number(req.params.id);
  const sourceId = Number(sourceRaw);

  // 400 — self-merge (request shape, like missing source_id — checked before
  // any lookup; a nonexistent id can otherwise only 404 below).
  if (Number.isFinite(targetId) && targetId === sourceId) {
    return res.status(400).json({ error: 'Produkt nie je mozne zlucit sam so sebou', field: 'source_id' });
  }

  // A non-integer id can match no row — refuse as unknown without ever binding
  // a NaN/float into the statement.
  if (!Number.isInteger(targetId) || !Number.isInteger(sourceId)) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }

  try {
    const result = mergeCatalogRows(targetId, sourceId);
    if (result.outcome === 'not_found') {
      // Either id unknown — 404 BEFORE any 4xx about state (§UC-PC-007). This
      // is also what a repeated merge of the now-deleted source returns.
      return res.status(404).json({ error: 'Produkt neexistuje' });
    }
    if (result.outcome === 'roastery_mismatch') {
      // Cross-roastery merges are refused unconditionally, nothing written.
      return res.status(409).json({ error: 'Produkty patria roznym praziarniam', field: 'roastery' });
    }
    return res.json({ target: result.target, repointed_snapshots: result.repointed_snapshots });
  } catch (error) {
    console.error('Catalog merge error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa zlucit produkty' });
  }
});

// ── Catalog CRUD (PC-T7, 12 §UC-PC-009) ────────────────────────────────────
//
// ⚠ ROUTE ORDERING: the parametric GET /:id, PATCH /:id and POST /:id/image
// below are registered AFTER every literal path (/duplicates, /stats, /import*,
// /migration/*) and after GET /:id/stats — express matches in registration order,
// so keeping them at the END of this file is what stops /:id from shadowing
// /duplicates or /stats. Never move them up.
//
// ⚠ NO DELETE ROUTE EVER (resolved decision 9): the merge tool above is the
// module's only catalog-row deleter. Retirement is PATCH { status: 'retired' }
// and has zero effect on snapshots, orders or stats.

// List the catalog (admin) — every catalog column plus computed `cycles_count`
// and `all_time_kg` (the PC-T6 seam: allTimeKgByCatalogId is the ONE home for
// that number — never re-derive it here). Filters: status, purpose, roastery,
// q (substring over normalized_name via the ONE normalization helper).
router.get('/', (req, res) => {
  // Query params must be strings — a repeated/bracketed param arrives as an
  // array/object; refuse, never coerce (the FUP-T13 discipline, as /stats).
  const filters = {};
  for (const key of ['status', 'purpose', 'roastery', 'q']) {
    if (req.query[key] !== undefined) {
      if (typeof req.query[key] !== 'string') {
        return res.status(400).json({ error: `${key} musi byt retazec`, field: key });
      }
      filters[key] = req.query[key];
    }
  }

  const where = [];
  const params = [];
  if (filters.status) { where.push('cp.status = ?'); params.push(filters.status); }
  if (filters.purpose) { where.push('cp.purpose = ?'); params.push(filters.purpose); }
  if (filters.roastery) { where.push('cp.roastery = ?'); params.push(filters.roastery); }
  if (filters.q) {
    const nq = normalizeProductName(filters.q);
    // A q that normalizes to '' matches nothing meaningful — treat as no filter
    // (an all-punctuation search must not return an empty list by accident).
    if (nq) { where.push('cp.normalized_name LIKE ?'); params.push(`%${nq}%`); }
  }

  try {
    // cycles_count via a CORRELATED SUBQUERY, never a LEFT JOIN — a join here
    // would multiply catalog rows per linked snapshot (the GSO-T6 trap).
    const rows = db.prepare(`
      SELECT cp.*,
        (SELECT COUNT(DISTINCT p.cycle_id) FROM products p
          WHERE p.source_coffee_product_id = cp.id) AS cycles_count
      FROM coffee_products cp
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY cp.name COLLATE NOCASE ASC, cp.id ASC
    `).all(...params);
    const kg = allTimeKgByCatalogId();
    return res.json(rows.map((r) => ({ ...r, all_time_kg: kg.get(r.id) || 0 })));
  } catch (error) {
    console.error('Catalog list error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa nacitat katalog' });
  }
});

// The rename-collision detector shared by both PATCH layers. The app-level
// check answers the common case; the constraint translation is the layer that
// survives a future PM2 cluster (the GA-T8/GSO-T10 dual-layer pattern). Match
// on the code PLUS the exact index message — a future UNIQUE on this table
// must not start answering 409 for the wrong reason.
const isNormalizedNameCollision = (e) =>
  e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT') &&
  String(e.message || '').includes('UNIQUE constraint failed: coffee_products.normalized_name, coffee_products.roastery');

// The column vocabularies shared by PATCH and the PC-T13 manual POST — one
// validation home, never forked.
const PLAIN_FIELDS = [
  'country', 'region', 'altitude', 'farm', 'variety', 'processing',
  'description1', 'description2', 'roast_type', 'purpose', 'curator_pick_note',
];
const PRICE_FIELDS = [
  'price_150g', 'price_200g', 'price_250g', 'price_500g', 'price_1kg', 'price_20pc5g', 'price_8pc12g',
];

// Price validation (PC-T12, extracted for PC-T13): numbers only, 400 on junk —
// bindValue used to pass any string through and `price_250g: 'abc'` stored the
// literal TEXT into a REAL column. `null`/'' clears; a numeric string is parsed
// like an imported price (decimal comma included). Returns { ok, value } or
// { ok: false }.
function parsePriceInput(raw) {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return { ok: true, value: null };
    const parsed = Number(trimmed.replace(',', '.'));
    if (!Number.isFinite(parsed)) return { ok: false };
    return { ok: true, value: parsed };
  }
  return { ok: false };
}

// Manual catalog product creation (PC-T13, PM 2026-08-23 gap 1): a coffee that
// is neither in the current sheet nor in history can now exist in the catalog
// ("aj keď aktuálne Filter nie je dostupný, mal by byť v databáze"). Same
// field vocabulary and validation as PATCH; the name collision is the SAME
// dual-layer 409 field:'name' (app check + SQLITE_CONSTRAINT translation, one
// normalizer home). Roastery resolves through normalizeRoastery — empty means
// the `roasteries` is_default row. Fully synchronous, no await (GA-T8).
router.post('/', (req, res) => {
  const name = bindValue(req.body?.name);
  const normalized = typeof name === 'string' ? normalizeProductName(name) : '';
  if (!normalized) {
    return res.status(400).json({ error: 'Názov je povinný', field: 'name' });
  }
  const roastery = normalizeRoastery(bindValue(req.body?.roastery) || '');

  // status — defaults to 'available'; anything but the two states 400s.
  let status = 'available';
  if (req.body.status !== undefined) {
    status = bindValue(req.body.status);
    if (status !== 'available' && status !== 'retired') {
      return res.status(400).json({ error: 'Neplatny stav produktu', field: 'status' });
    }
  }

  const plain = {};
  for (const field of PLAIN_FIELDS) {
    const value = bindValue(req.body[field]);
    plain[field] = value === undefined ? null : value;
  }

  const prices = {};
  for (const field of PRICE_FIELDS) {
    if (req.body[field] === undefined) {
      prices[field] = null;
      continue;
    }
    const parsed = parsePriceInput(req.body[field]);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'Cena musí byť číslo', field });
    }
    prices[field] = parsed.value;
  }

  try {
    // The write (app-level collision check + insert, dual collision layer)
    // lives in the workbench helper — this file's structural pin bans catalog
    // inserts in route code (catalog-row creation has helper homes only).
    const result = createManualCatalogRow({
      name,
      normalizedName: normalized,
      roastery,
      plain,
      prices,
      isNew: !!req.body.is_new,
      status,
    });
    if (result.outcome === 'name_collision') {
      return res.status(409).json({ error: 'Produkt s tymto nazvom uz v katalogu existuje', field: 'name' });
    }

    // 201 in the LIST shape (cycles_count + all_time_kg both zero by
    // construction — a manual row is born with no history) so the UI can
    // append it straight from this payload, the workbench-create precedent.
    const row = db.prepare('SELECT * FROM coffee_products WHERE id = ?').get(result.catalog_id);
    return res.status(201).json({ ...row, cycles_count: 0, all_time_kg: 0 });
  } catch (error) {
    console.error('Catalog create error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa vytvorit produkt' });
  }
});

// Catalog detail (admin) — the row + availability history (which cycles
// offered it, per-cycle kg). The history comes from catalogProductStats (the
// one home for per-product kg math) — never a second weight query here.
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }
  try {
    const row = db.prepare('SELECT * FROM coffee_products WHERE id = ?').get(id);
    if (!row) {
      return res.status(404).json({ error: 'Produkt neexistuje' });
    }
    const stats = catalogProductStats(id);
    return res.json({ ...row, history: stats ? stats.history : [] });
  } catch (error) {
    console.error('Catalog detail error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa nacitat produkt' });
  }
});

// Admin edit (12 §UC-PC-009) — field-by-field `!== undefined` + bindValue, the
// products.js PATCH pattern. `name` recomputes `normalized_name` via the ONE
// helper in the same statement flow; a rename colliding with an existing
// (normalized_name, roastery) answers 409 field:'name'. `roastery` is
// deliberately NOT editable here — it is half of the identity key.
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }
  const product = db.prepare('SELECT * FROM coffee_products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }

  const updates = [];
  const values = [];

  // name — recompute normalized_name; '' after normalization = no identity,
  // which the catalog can never store (the importers' `if (name)` rule).
  const name = bindValue(req.body.name);
  if (name !== undefined) {
    const normalized = normalizeProductName(name);
    if (!normalized) {
      return res.status(400).json({ error: 'Nazov je povinny', field: 'name' });
    }
    // App-level collision check (layer 1), excluding the row itself.
    const clash = db.prepare(
      'SELECT id FROM coffee_products WHERE normalized_name = ? AND roastery = ? AND id != ?'
    ).get(normalized, product.roastery, id);
    if (clash) {
      return res.status(409).json({ error: 'Produkt s tymto nazvom uz v katalogu existuje', field: 'name' });
    }
    updates.push('name = ?'); values.push(name);
    updates.push('normalized_name = ?'); values.push(normalized);
  }

  // Plain text columns — unbindable values SKIP their write (the stored
  // column survives); an explicit null still clears. Vocabulary shared with
  // the PC-T13 manual POST (PLAIN_FIELDS above).
  for (const field of PLAIN_FIELDS) {
    const value = bindValue(req.body[field]);
    if (value !== undefined) { updates.push(`${field} = ?`); values.push(value); }
  }

  // Prices — PC-T12 (the PM's manual repair path): numbers only, 400 on junk;
  // the validation lives in parsePriceInput, shared with the manual POST. Note
  // decision 13's posture (stated in the edit dialog too): a manual price edit
  // lives only until the next import, which owns the whole price vector.
  for (const field of PRICE_FIELDS) {
    if (req.body[field] === undefined) continue;
    const parsed = parsePriceInput(req.body[field]);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'Cena musí byť číslo', field });
    }
    updates.push(`${field} = ?`); values.push(parsed.value);
  }

  // status — 'available'/'retired' only, else 400 (12 §UC-PC-009).
  if (req.body.status !== undefined) {
    const status = bindValue(req.body.status);
    if (status !== 'available' && status !== 'retired') {
      return res.status(400).json({ error: 'Neplatny stav produktu', field: 'status' });
    }
    updates.push('status = ?'); values.push(status);
  }

  // is_new — `? 1 : 0`, never bound raw (the products.js `active` rule).
  if (req.body.is_new !== undefined) {
    updates.push('is_new = ?'); values.push(req.body.is_new ? 1 : 0);
  }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    try {
      db.prepare(`UPDATE coffee_products SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
    } catch (error) {
      // Layer 2 — the UNIQUE index catches what the app-level check raced past.
      if (isNormalizedNameCollision(error)) {
        return res.status(409).json({ error: 'Produkt s tymto nazvom uz v katalogu existuje', field: 'name' });
      }
      console.error('Catalog PATCH error:', error.message);
      return res.status(500).json({ error: 'Nepodarilo sa ulozit produkt' });
    }
  }

  return res.json(db.prepare('SELECT * FROM coffee_products WHERE id = ?').get(id));
});

// Upload the catalog image (admin) — THE image home from now on (12
// §UC-PC-009): uploaded once here, served to every future snapshot via the
// UC-PC-012 COALESCE. Reuses the image helpers exactly as products.js
// POST /:id/image does — same storage, same validation.
router.post('/:id/image', uploadSingle('image'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }
  const product = db.prepare('SELECT id FROM coffee_products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  let image = null;
  if (req.file) {
    const built = imageUrlFromUpload(req.file);
    if (built.error) return res.status(400).json({ error: built.error });
    image = built.image;
  } else if (req.body.image) {
    const built = imageUrlFromBody(req.body.image);
    if (built.error) return res.status(400).json({ error: built.error });
    image = built.image;
  }

  db.prepare('UPDATE coffee_products SET image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(image, id);
  return res.json(db.prepare('SELECT * FROM coffee_products WHERE id = ?').get(id));
});

// ── Split declarations (PC-T13, PM gap 2 — option B) ────────────────────────
//
// `catalog_import_splits` maps ONE sheet row → N catalog products. The import
// consumes it in importRowsIntoCatalog (refresh every target, create nothing,
// no pending_fuzzy, roast_type admin-owned); findDuplicatePairs suppresses
// sibling pairs and target↔sheet-name pairs. These routes only manage the
// declarations. Parametric two-segment paths — they cannot shadow the literal
// /migration/* routes (their second segment differs) but stay down here with
// the other /:id routes by convention.

// The one splits payload shape, shared by GET/POST/DELETE: every declaration
// of this product, each with the SIBLING set (the other targets of the same
// sheet row) so the admin sees the whole variant family. `split_of_this_row`
// (additive, PC-T13 review fix 4) lists OTHER products declared as variants of
// THIS product's own identity — i.e. this row is the "old combined row" whose
// sheet line was split: the import no longer refreshes it and the duplicates
// review hides its target pairs, so the UI warns and suggests `Vyradená`.
function splitsPayload(productId) {
  const product = db.prepare(
    'SELECT normalized_name, roastery FROM coffee_products WHERE id = ?'
  ).get(productId);
  const splits = db.prepare(`
    SELECT id, sheet_name, normalized_name, roastery
    FROM catalog_import_splits WHERE coffee_product_id = ? ORDER BY id
  `).all(productId);
  return {
    splits: splits.map((s) => ({
      ...s,
      siblings: db.prepare(`
        SELECT cp.id, cp.name
        FROM catalog_import_splits x
        JOIN coffee_products cp ON cp.id = x.coffee_product_id
        WHERE x.normalized_name = ? AND x.roastery = ? AND x.coffee_product_id != ?
        ORDER BY cp.id
      `).all(s.normalized_name, s.roastery, productId),
    })),
    split_of_this_row: product
      ? db.prepare(`
          SELECT cp.id, cp.name
          FROM catalog_import_splits x
          JOIN coffee_products cp ON cp.id = x.coffee_product_id
          WHERE x.normalized_name = ? AND x.roastery = ? AND x.coffee_product_id != ?
          ORDER BY cp.id
        `).all(product.normalized_name, product.roastery, productId)
      : [],
  };
}

router.get('/:id/splits', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }
  const product = db.prepare('SELECT id FROM coffee_products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }
  try {
    return res.json(splitsPayload(id));
  } catch (error) {
    console.error('Catalog splits list error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa nacitat varianty riadku' });
  }
});

// Declare "this product is a variant of sheet row X". The identity is the
// normalized pair (the ONE helpers/catalog.js home); the roastery is the
// PRODUCT's — a split can never cross roasteries by construction. Dual-layer
// duplicate refusal (app check + the exact UNIQUE-index translation).
const isSplitCollision = (e) =>
  e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT') &&
  String(e.message || '').includes('UNIQUE constraint failed: catalog_import_splits.normalized_name, catalog_import_splits.roastery, catalog_import_splits.coffee_product_id');

router.post('/:id/splits', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }
  const product = db.prepare('SELECT id, roastery FROM coffee_products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }

  const sheetName = bindValue(req.body?.sheet_name);
  const normalized = typeof sheetName === 'string' ? normalizeProductName(sheetName) : '';
  if (!normalized) {
    return res.status(400).json({ error: 'Názov riadku zo sheetu je povinný', field: 'sheet_name' });
  }

  try {
    const existing = db.prepare(
      'SELECT id FROM catalog_import_splits WHERE normalized_name = ? AND roastery = ? AND coffee_product_id = ?'
    ).get(normalized, product.roastery, id);
    if (existing) {
      return res.status(409).json({ error: 'Tento produkt už je variantom tohto riadku', field: 'sheet_name' });
    }
    try {
      db.prepare(
        'INSERT INTO catalog_import_splits (sheet_name, normalized_name, roastery, coffee_product_id) VALUES (?, ?, ?, ?)'
      ).run(String(sheetName).trim(), normalized, product.roastery, id);
    } catch (error) {
      if (isSplitCollision(error)) {
        return res.status(409).json({ error: 'Tento produkt už je variantom tohto riadku', field: 'sheet_name' });
      }
      throw error;
    }
    return res.status(201).json(splitsPayload(id));
  } catch (error) {
    console.error('Catalog split declare error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa ulozit variant riadku' });
  }
});

router.delete('/:id/splits/:splitId', (req, res) => {
  const id = Number(req.params.id);
  const splitId = Number(req.params.splitId);
  if (!Number.isInteger(id) || !Number.isInteger(splitId)) {
    return res.status(404).json({ error: 'Záznam neexistuje' });
  }
  try {
    const gone = db.prepare(
      'DELETE FROM catalog_import_splits WHERE id = ? AND coffee_product_id = ?'
    ).run(splitId, id);
    if (gone.changes === 0) {
      return res.status(404).json({ error: 'Záznam neexistuje' });
    }
    return res.json(splitsPayload(id));
  } catch (error) {
    console.error('Catalog split delete error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa odstranit variant riadku' });
  }
});

// "Odpojiť od katalógu" (PC-T13, PM gap 4): return a product's history to the
// migration workbench — the catalog row itself SURVIVES untouched (unlike
// DELETE below, the photo and curation stay). This is exactly the operation
// the PM ran as raw SQL on production (8 `Peach Please filter blend` snapshots
// wrongly assigned to the Brew Bags product) — never again by hand.
// ⚠ The ONLY write is the link column (the PC-T4 data-safety invariant), one
// transaction; order_items, prices and every snapshot byte stay put.
router.post('/:id/unlink', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }
  const product = db.prepare('SELECT id FROM coffee_products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }
  try {
    const run = db.transaction(() =>
      db.prepare(
        'UPDATE products SET source_coffee_product_id = NULL WHERE source_coffee_product_id = ?'
      ).run(id).changes
    );
    return res.json({ unlinked_snapshots: run() });
  } catch (error) {
    console.error('Catalog unlink error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa odpojit produkt' });
  }
});

// DELETE a catalog product (admin) — PM decision 2026-08-23, which SUPERSEDES
// resolved decision 9's "no DELETE route ever" (retirement via status='retired'
// stays available and is still the non-destructive option; the admin asked for a
// real delete for rows imported by mistake).
//
// ⚠ THE DANGLING-POINTER RULE (the GSO-T9 lesson, and the reason this is one
// transaction): `products.source_coffee_product_id` was added by a bare ALTER with
// NO foreign key, so deleting a catalog row would leave historical snapshots
// pointing at nothing — such rows land in NO stats bucket and vanish from the
// reports (exactly how a dangling `root_friend_id` once erased reward volume).
// So the links are CLEARED FIRST, in the same transaction as the delete. The
// affected snapshots keep every byte of their own data (name, prices, order_items)
// and simply become unlinked again — they reappear in the migration workbench,
// which is the correct end state for "this catalog product should not exist".
// Registered LAST: parametric, below every literal path.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }
  const product = db.prepare('SELECT * FROM coffee_products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt neexistuje' });
  }

  const run = db.transaction(() => {
    // Only write to `products` is the link column — the PC-T4 data-safety
    // invariant, unchanged: no snapshot data, no prices, no order_items.
    const unlinked = db.prepare(
      'UPDATE products SET source_coffee_product_id = NULL WHERE source_coffee_product_id = ?'
    ).run(id);
    db.prepare('DELETE FROM coffee_products WHERE id = ?').run(id);
    return unlinked.changes;
  });

  const unlinked_snapshots = run();
  return res.json({ deleted: { id, name: product.name }, unlinked_snapshots });
});

export default router;
