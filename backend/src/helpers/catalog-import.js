import db from '../db/schema.js';
import { normalizeProductName, normalizeRoastery, nameSimilarity, FUZZY_THRESHOLD } from './catalog.js';

// Catalog consolidation — 12 §UC-PC-003 (duplicate-aware, cycle-independent
// import) + §UC-PC-004 (the machine-readable report). PC-T2.
//
// ⚠ THE ONE consolidation layer. All three catalog import endpoints
// (routes/coffee-products.js) and — from PC-T3 on — the manual per-cycle
// product POST funnel through `consolidateCatalogRow`. The gsheet endpoints are
// not e2e-exercisable (live sheet required), so the CSV suite's coverage
// transfers ONLY while this stays the single home; keep the routes' call sites
// trivial (§Accepted risks).
//
// ⚠ NOTHING here ever touches `products` or `order_cycles` — imports are
// frozen-by-construction for cycles (resolved decisions 11+12), and the e2e
// byte-compares those tables before/after every import path.
//
// ⚠ Everything here is SYNCHRONOUS better-sqlite3. Callers must enter
// `importRowsIntoCatalog` (one db.transaction) only AFTER their last `await`
// (the GA-T8 lesson — an await between a uniqueness check and its INSERT breaks
// the instances:1 atomicity assumption).

// The seven catalog "current price" columns. A parsed row DECLARES a field when
// it carries a number OR an explicit null there (parsePrice yields number|null;
// the plain CSV formats declare 250g/1kg only, the multirow format and the
// manual POST declare the full vector).
const SHEET_PRICE_FIELDS = ['price_150g', 'price_200g', 'price_250g', 'price_500g', 'price_1kg', 'price_20pc5g', 'price_8pc12g'];

// Sheet-sourced metadata (resolved decision 13): refreshed on exact match, but
// only when the sheet value is non-empty AND differs. Admin-only fields —
// name-as-stored, country, region, altitude, farm, variety, processing, image,
// status, is_new, curator_pick_note — are NEVER written by an import.
const SHEET_TEXT_FIELDS = ['description1', 'description2', 'roast_type', 'purpose'];

function exactMatch(key, roastery) {
  return db.get(
    'SELECT * FROM coffee_products WHERE normalized_name = ? AND roastery = ?',
    [key, roastery]
  );
}

// Exact-match refresh per resolved decision 13. Returns the per-row result;
// writes only when something actually differs (no write-churn — this is what
// makes re-imports naturally idempotent, byte-for-byte, updated_at included).
function refreshCatalogRow(existing, parsedRow) {
  const updates = [];
  const values = [];
  const priceChanges = [];

  // ── PC-T12 — AMENDMENT to resolved decision 13 (prices only) ──────────────
  // On a refresh the sheet owns the whole price VECTOR, not individual cells:
  //   • a parsed row DECLARES a price field when it carries a number or an
  //     explicit null there. The multirow format declares six (NOT price_500g —
  //     it has no 500g label path; a format must never clear a column it cannot
  //     even express); the plain CSV formats declare only 250g/1kg; the manual
  //     POST declares only the fields present in its body (SET semantics are
  //     scoped to the SHEET refresh — a blank manual form field is
  //     "unspecified", never "clear it");
  //   • when ≥1 DECLARED field is a POSITIVE number, EVERY declared field is
  //     written — numbers as the new price, nulls as NULL. A variant that left
  //     the sheet stops being purchasable, and a mis-parsed pack price (the
  //     2026-08-23 staging bug: `20ks x 5g` priced into price_250g) self-heals
  //     on the next import;
  //   • otherwise ALL prices are left untouched — a partial/failed parse must
  //     never blank a product, and a zeros-only row (parsePrice reads "0" as
  //     the number 0) must not arm the vector-clear either.
  // Consequence, stated in the admin edit dialog too: manual price edits
  // (UC-PC-009 PATCH) are temporary until the next import — the same posture
  // decision 13 already takes for descriptions.
  const declared = SHEET_PRICE_FIELDS.filter(
    (f) => typeof parsedRow[f] === 'number' || parsedRow[f] === null
  );
  const anyPrice = declared.some((f) => typeof parsedRow[f] === 'number' && parsedRow[f] > 0);
  if (anyPrice) {
    for (const field of declared) {
      const v = typeof parsedRow[field] === 'number' ? parsedRow[field] : null;
      if (existing[field] === v) continue;
      updates.push(`${field} = ?`);
      values.push(v);
      priceChanges.push({ catalog_id: existing.id, name: existing.name, field, old: existing[field], new: v });
    }
  }

  for (const field of SHEET_TEXT_FIELDS) {
    const v = parsedRow[field];
    if (typeof v !== 'string' || v.trim() === '') continue; // an empty cell never blanks
    if (existing[field] === v) continue;
    updates.push(`${field} = ?`);
    values.push(v);
  }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    db.run(`UPDATE coffee_products SET ${updates.join(', ')} WHERE id = ?`, [...values, existing.id]);
  }

  return {
    outcome: 'matched',
    catalog_id: existing.id,
    name: existing.name,
    price_changes: priceChanges,
    fuzzy: null,
  };
}

// consolidateCatalogRow(parsedRow, roastery, opts) — 12 §UC-PC-003 steps 1–4.
//
//   • key = normalizeProductName(row.name); '' ⇒ { outcome: 'skipped',
//     reason: 'missing name' } (the importers' existing `if (name)` skip made
//     observable).
//   • exact match within the resolved roastery ⇒ refresh per decision 13.
//   • no exact match ⇒ fuzzy scan over the SAME-roastery catalog rows; CREATE
//     the row regardless (resolved decision 1 — create-as-new-but-flagged,
//     never auto-merged, never held pending) and carry the best in-band
//     candidate on `fuzzy`.
//
// opts.seenCatalogIds (a Set, per import run): when the exact match resolves to
// an id this run already processed, the row is an IN-SHEET DUPLICATE — return
// { outcome: 'duplicate', catalog_id } WITHOUT refreshing (rule 5: skipped, so
// it must write nothing, not even a price). PC-T3's single-row caller passes no
// set and never hits this branch.
//
// opts.image: seam for PC-T3 (UC-PC-005 — a manual POST's uploaded image is
// additionally stored on a CREATED catalog row). Imports never set it, so every
// import-created row has image = NULL and needs_image: true.
export function consolidateCatalogRow(parsedRow, roastery, opts = {}) {
  const key = normalizeProductName(parsedRow.name);
  const r = normalizeRoastery(roastery);
  if (key === '') {
    return { outcome: 'skipped', reason: 'missing name' };
  }

  const seen = opts.seenCatalogIds;
  const existing = exactMatch(key, r);
  if (existing) {
    if (seen && seen.has(existing.id)) {
      return { outcome: 'duplicate', catalog_id: existing.id, name: existing.name };
    }
    return refreshCatalogRow(existing, parsedRow);
  }

  // Fuzzy scan — same-roastery candidates only (resolved decision 3): a
  // hypothetical other-roastery import can never match or fuzzy-suggest a
  // Goriffee product. Best candidate first.
  const candidates = db
    .all('SELECT id, name, normalized_name FROM coffee_products WHERE roastery = ?', [r])
    .map((c) => ({
      candidate_catalog_id: c.id,
      candidate_name: c.name,
      similarity: nameSimilarity(key, c.normalized_name),
    }))
    .filter((c) => c.similarity >= FUZZY_THRESHOLD && c.similarity < 1)
    .sort((a, b) => b.similarity - a.similarity);

  const image = typeof opts.image === 'string' && opts.image !== '' ? opts.image : null;

  const insert = () =>
    db.run(
      `INSERT INTO coffee_products
         (name, normalized_name, roastery, description1, description2, roast_type, purpose,
          price_150g, price_200g, price_250g, price_500g, price_1kg, price_20pc5g, price_8pc12g, image, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available')`,
      [
        parsedRow.name,
        key,
        r,
        parsedRow.description1 ?? null,
        parsedRow.description2 ?? null,
        parsedRow.roast_type ?? null,
        parsedRow.purpose ?? null,
        typeof parsedRow.price_150g === 'number' ? parsedRow.price_150g : null,
        typeof parsedRow.price_200g === 'number' ? parsedRow.price_200g : null,
        typeof parsedRow.price_250g === 'number' ? parsedRow.price_250g : null,
        typeof parsedRow.price_500g === 'number' ? parsedRow.price_500g : null,
        typeof parsedRow.price_1kg === 'number' ? parsedRow.price_1kg : null,
        typeof parsedRow.price_20pc5g === 'number' ? parsedRow.price_20pc5g : null,
        typeof parsedRow.price_8pc12g === 'number' ? parsedRow.price_8pc12g : null,
        image,
        // status is the literal 'available' above — never caller-supplied
      ]
    );

  let result;
  try {
    result = insert();
  } catch (e) {
    // Dual layer (UC-PC-003 rule 7): the in-transaction check above is
    // load-bearing under instances:1; this translation covers the PM2-cluster
    // scenario. Match the code PREFIX plus the EXACT index message (never a
    // bare /UNIQUE/i — the GA-T8 lesson: a future constraint on this table must
    // not be silently answered with the exact-match path).
    if (
      e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT') &&
      typeof e.message === 'string' &&
      e.message.includes('UNIQUE constraint failed: coffee_products.normalized_name, coffee_products.roastery')
    ) {
      const row = exactMatch(key, r);
      if (row) {
        if (seen && seen.has(row.id)) {
          return { outcome: 'duplicate', catalog_id: row.id, name: row.name };
        }
        return refreshCatalogRow(row, parsedRow);
      }
    }
    throw e;
  }

  return {
    outcome: 'new',
    catalog_id: result.lastInsertRowid,
    name: parsedRow.name,
    needs_image: image === null,
    price_changes: [],
    fuzzy: candidates.length > 0 ? candidates[0] : null,
  };
}

// exactCatalogMatch(name, roastery) — PC-T3 (12 §UC-PC-005): the manual POST's
// `duplicate_in_cycle` pre-check needs the WOULD-BE exact match BEFORE any
// write happens (a refused POST must not even run the decision-13 price
// refresh). Read-only; returns the catalog row or null. Kept here so the
// normalization pair (normalizeProductName + normalizeRoastery) is applied by
// the one consolidation home, never re-inlined in a route.
export function exactCatalogMatch(name, roastery) {
  const key = normalizeProductName(name);
  if (key === '') return null;
  return exactMatch(key, normalizeRoastery(roastery)) ?? null;
}

// singleRowReport(result) — PC-T3 (12 §UC-PC-005): the manual POST's 201 gains
// the SAME UC-PC-004 report shape with exactly one row accounted for. The
// bucket vocabulary is the contract importRowsIntoCatalog pins below; the
// 'duplicate' outcome cannot occur here (no seenCatalogIds on a one-row call).
// `unparsed.row` is null — there is no sheet row to point at (the warnings
// precedent).
export function singleRowReport(result) {
  const report = {
    summary: { new: 0, matched: 0, price_changes: 0, pending_fuzzy: 0, unparsed: 0, warnings: 0 },
    new: [],
    matched: [],
    price_changes: [],
    pending_fuzzy: [],
    unparsed: [],
    warnings: [],
  };

  if (result.outcome === 'skipped') {
    report.unparsed.push({ row: null, reason: result.reason });
  } else if (result.outcome === 'matched') {
    report.matched.push({ catalog_id: result.catalog_id, name: result.name });
    report.price_changes.push(...result.price_changes);
  } else {
    report.new.push({ catalog_id: result.catalog_id, name: result.name, needs_image: result.needs_image });
    if (result.fuzzy) {
      report.pending_fuzzy.push({
        catalog_id: result.catalog_id,
        name: result.name,
        candidate_catalog_id: result.fuzzy.candidate_catalog_id,
        candidate_name: result.fuzzy.candidate_name,
        similarity: result.fuzzy.similarity,
      });
    }
  }

  report.summary = {
    new: report.new.length,
    matched: report.matched.length,
    price_changes: report.price_changes.length,
    pending_fuzzy: report.pending_fuzzy.length,
    unparsed: report.unparsed.length,
    warnings: report.warnings.length,
  };
  return report;
}

// importRowsIntoCatalog(parsedRows, roastery, { warnings }) — the whole-import
// orchestrator the three routes call. Runs EVERYTHING (lookups + writes) inside
// ONE db.transaction and assembles the UC-PC-004 report:
//
//   { summary: { new, matched, price_changes, pending_fuzzy, unparsed, warnings },
//     new:           [{ catalog_id, name, needs_image }],
//     matched:       [{ catalog_id, name }],
//     price_changes: [{ catalog_id, name, field, old, new }],
//     pending_fuzzy: [{ catalog_id, name, candidate_catalog_id, candidate_name, similarity }],
//     unparsed:      [{ row, reason }],
//     warnings:      [{ row, reason }] }
//
// ⚠ THE SHAPE IS A CONTRACT (brief §2.6 — the future autonomous routine
// consumes it raw). No cycle context of any kind, no product_id, no `unchanged`
// bucket. Nothing is silently guessed or dropped.
//
// PC-T12 — the honest split (ADDITIVE, recorded): the old report folded the
// multirow parser `warnings` into `unparsed`, which mixed "skipped, nothing
// written" with "imported, but check this" — the PM read "Nespracované riadky"
// as not-imported and was wrong. `unparsed` KEEPS ITS NAME but now means
// strictly the skipped rows (missing name, in-sheet duplicate — every entry a
// row nothing was written for), a subset of what it carried before; the NEW
// `warnings` bucket carries the parser warnings (row: null — a warning names a
// product, not a row). A consumer of `unparsed` sees only true skips now.
export function importRowsIntoCatalog(parsedRows, roastery, { warnings = [] } = {}) {
  const run = db.transaction(() => {
    const report = {
      summary: { new: 0, matched: 0, price_changes: 0, pending_fuzzy: 0, unparsed: 0, warnings: 0 },
      new: [],
      matched: [],
      price_changes: [],
      pending_fuzzy: [],
      unparsed: [],
      warnings: [],
    };
    const seenCatalogIds = new Set();

    parsedRows.forEach((parsedRow, i) => {
      // Sheet row for the report: the multirow parser stamps the product's real
      // CSV row (_rowStart); columns-with-headers formats count the header as
      // row 1, so data row i sits at i + 2.
      const rowNo = typeof parsedRow._rowStart === 'number' ? parsedRow._rowStart : i + 2;

      const result = consolidateCatalogRow(parsedRow, roastery, { seenCatalogIds });

      if (result.outcome === 'skipped') {
        report.unparsed.push({ row: rowNo, reason: result.reason });
        return;
      }
      if (result.outcome === 'duplicate') {
        report.unparsed.push({ row: rowNo, reason: 'duplicate row in sheet' });
        return;
      }

      seenCatalogIds.add(result.catalog_id);

      if (result.outcome === 'matched') {
        report.matched.push({ catalog_id: result.catalog_id, name: result.name });
        report.price_changes.push(...result.price_changes);
        return;
      }

      // outcome === 'new'
      report.new.push({ catalog_id: result.catalog_id, name: result.name, needs_image: result.needs_image });
      if (result.fuzzy) {
        report.pending_fuzzy.push({
          catalog_id: result.catalog_id,
          name: result.name,
          candidate_catalog_id: result.fuzzy.candidate_catalog_id,
          candidate_name: result.fuzzy.candidate_name,
          similarity: result.fuzzy.similarity,
        });
      }
    });

    for (const w of warnings) {
      report.warnings.push({ row: null, reason: String(w) });
    }

    report.summary = {
      new: report.new.length,
      matched: report.matched.length,
      price_changes: report.price_changes.length,
      pending_fuzzy: report.pending_fuzzy.length,
      unparsed: report.unparsed.length,
      warnings: report.warnings.length,
    };
    return report;
  });
  return run();
}
