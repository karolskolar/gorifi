import { Router } from 'express';
import { uploadSingle } from '../helpers/multipart.js';
import { bindValue } from '../helpers/bind-value.js';
import { parseCsvProducts, parseGsheetCsvProducts, parseMultiRowProducts, fetchGsheetCsv } from '../helpers/import-parsing.js';
import { importRowsIntoCatalog } from '../helpers/catalog-import.js';
import { migrateHistoricalSnapshots } from '../helpers/catalog-migrate.js';
import { mergeCatalogRows, findDuplicatePairs } from '../helpers/catalog-merge.js';

// Coffee-product catalog routes — module 12 (PC-T2 opened this file with the
// three UC-PC-003 import endpoints; PC-T4/T5/T6/T7 add migrate/merge/
// duplicates/CRUD/stats to the SAME router).
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
    // Multirow parser warnings fold into the report's `unparsed` (UC-PC-004) —
    // nothing is silently guessed or dropped.
    const report = importRowsIntoCatalog(parsed.products, roastery, { warnings: parsed.warnings });
    return res.status(201).json({ report });
  } catch (error) {
    console.error('Catalog multirow import error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa importovat produkty' });
  }
});

// One-time historical migration (admin) — 12 §UC-PC-006 (PC-T4). Idempotent
// and deliberately re-runnable (after merges it links the still-unlinked
// fuzzy tail). Fully synchronous — no await anywhere (GA-T8); the helper runs
// everything inside ONE db.transaction. The admin trigger + report rendering
// land in PC-T7; until then this is API-only.
router.post('/migrate', (req, res) => {
  try {
    const report = migrateHistoricalSnapshots();
    return res.json(report);
  } catch (error) {
    console.error('Catalog migration error:', error.message);
    return res.status(500).json({ error: 'Nepodarilo sa migrovat historicke produkty' });
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

export default router;
