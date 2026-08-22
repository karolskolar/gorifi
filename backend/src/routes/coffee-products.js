import { Router } from 'express';
import { uploadSingle } from '../helpers/multipart.js';
import { bindValue } from '../helpers/bind-value.js';
import { parseCsvProducts, parseGsheetCsvProducts, parseMultiRowProducts, fetchGsheetCsv } from '../helpers/import-parsing.js';
import { importRowsIntoCatalog } from '../helpers/catalog-import.js';
import { migrateHistoricalSnapshots } from '../helpers/catalog-migrate.js';

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

export default router;
