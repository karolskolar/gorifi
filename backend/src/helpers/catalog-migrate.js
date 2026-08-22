import db from '../db/schema.js';
import { normalizeProductName, normalizeRoastery } from './catalog.js';
import { consolidateCatalogRow } from './catalog-import.js';

// One-time historical migration — 12 §UC-PC-006 (PC-T4).
//
// Groups every UNLINKED historical coffee snapshot by the ONE normalization
// pair (normalizeProductName, normalizeRoastery — never re-inlined), creates
// catalog rows from the NEWEST snapshot per group, backfills
// `products.source_coffee_product_id`, and returns the report incl.
// `fuzzy_review`. Idempotent by construction: already-linked rows are excluded
// from the candidate set, so a second run finds nothing and writes nothing —
// and deliberately re-runnable after merges to pick up the still-unlinked tail.
//
// ⚠ This is a SEPARATE helper from catalog-import.js on purpose:
// catalog-import.js carries the invariant "NOTHING here ever touches
// `products`" (imports are frozen-by-construction for cycles), while the
// migration's whole job is the one sanctioned `products` write — the bulk
// UPDATE of EXACTLY `source_coffee_product_id`. Names, descriptions, prices
// and order_items stay byte-identical (brief §2.3; the e2e byte-compares).
//
// ⚠ Fully SYNCHRONOUS better-sqlite3, everything inside ONE db.transaction —
// no `await` anywhere in this file or in the route handler (the GA-T8 lesson).
//
// ⚠ The CREATE path reuses `consolidateCatalogRow` so a migration-created
// catalog row is consistent with what an import would create (decision-13
// field mapping) — original-cased name, descriptions, roast_type, purpose,
// prices as current prices, `status='available'`, informational attributes
// NULL — plus the newest snapshot's image via opts.image (this is how existing
// per-cycle images consolidate into the one catalog image). The EXACT-match
// path deliberately does NOT go through consolidateCatalogRow: an exact match
// here is backfill-only — the decision-13 refresh would overwrite catalog
// current prices with a HISTORICAL snapshot's price, which is exactly wrong.
export function migrateHistoricalSnapshots() {
  const run = db.transaction(() => {
    // Candidate set (12 §UC-PC-006): coffee-cycle snapshots that are neither
    // bakery-sourced nor already linked. Already-linked rows being excluded IS
    // the idempotency. Ordered newest-first — highest cycle_id, `id DESC`
    // tiebreak (the GSO-T8 same-second lesson: two snapshots in one cycle must
    // resolve deterministically) — so each group's FIRST snapshot is the one
    // the catalog row is built from.
    const candidateWhere = `
      FROM products p
      JOIN order_cycles oc ON oc.id = p.cycle_id
      WHERE COALESCE(oc.type, 'coffee') = 'coffee'
        AND p.source_bakery_product_id IS NULL
        AND p.source_coffee_product_id IS NULL`;

    const alreadyLinked = db.get(`
      SELECT COUNT(*) AS n FROM products p
      JOIN order_cycles oc ON oc.id = p.cycle_id
      WHERE COALESCE(oc.type, 'coffee') = 'coffee'
        AND p.source_bakery_product_id IS NULL
        AND p.source_coffee_product_id IS NOT NULL
    `).n;

    const candidates = db.all(`
      SELECT p.* ${candidateWhere}
      ORDER BY p.cycle_id DESC, p.id DESC
    `);

    // Group by (normalizeProductName(name), normalizeRoastery(roastery)) — the
    // same helper pair the importer uses (single-home rule). A name that
    // normalizes to '' has no identity (the importers' skip): it stays
    // unlinked and surfaces in unlinked_remaining, the report's bug signal.
    const groups = new Map();
    for (const snap of candidates) {
      const key = normalizeProductName(snap.name);
      if (key === '') continue;
      const roastery = normalizeRoastery(snap.roastery);
      const gk = `${key}\u0000${roastery}`;
      let group = groups.get(gk);
      if (!group) {
        group = { key, roastery, snapshots: [] };
        groups.set(gk, group);
      }
      group.snapshots.push(snap);
    }

    const catalogCreated = [];
    const fuzzyReview = [];
    let snapshotsLinked = 0;

    for (const group of groups.values()) {
      const newest = group.snapshots[0]; // candidates order: cycle_id DESC, id DESC
      let catalogId;

      const existing = db.get(
        'SELECT id FROM coffee_products WHERE normalized_name = ? AND roastery = ?',
        [group.key, group.roastery]
      );

      if (existing) {
        // Exact match ⇒ backfill only. No refresh, no fuzzy scan (the import
        // precedent: matched rows never fuzzy-scan).
        catalogId = existing.id;
      } else {
        // No match ⇒ create from the newest snapshot. consolidateCatalogRow
        // cannot hit its exact-match branch here (checked above, same
        // transaction), so the outcome is always 'new' — with the fuzzy scan
        // over the same-roastery catalog, which by this point also contains
        // the rows earlier groups created this run (that is how
        // group-vs-group near-misses land in fuzzy_review).
        const result = consolidateCatalogRow(
          {
            name: newest.name,
            description1: newest.description1,
            description2: newest.description2,
            roast_type: newest.roast_type,
            purpose: newest.purpose,
            price_150g: newest.price_150g,
            price_200g: newest.price_200g,
            price_250g: newest.price_250g,
            price_500g: newest.price_500g,
            price_1kg: newest.price_1kg,
            price_20pc5g: newest.price_20pc5g,
          },
          group.roastery,
          { image: newest.image }
        );
        catalogId = result.catalog_id;
        catalogCreated.push({
          catalog_id: result.catalog_id,
          name: result.name,
          needs_image: result.needs_image,
        });
        if (result.fuzzy) {
          fuzzyReview.push({
            catalog_id: result.catalog_id,
            name: result.name,
            candidate_catalog_id: result.fuzzy.candidate_catalog_id,
            candidate_name: result.fuzzy.candidate_name,
            similarity: result.fuzzy.similarity,
          });
        }
      }

      // The bulk backfill — writes EXACTLY source_coffee_product_id, nothing
      // else (snapshot names/descriptions/prices/order_items stay untouched).
      const ids = group.snapshots.map((s) => s.id);
      db.run(
        `UPDATE products SET source_coffee_product_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [catalogId, ...ids]
      );
      snapshotsLinked += ids.length;
    }

    // Must be 0 after a run — every coffee snapshot groups somewhere.
    // Non-zero is a bug signal (e.g. a name normalizing to ''), not a state.
    const unlinkedRemaining = db.get(`SELECT COUNT(*) AS n ${candidateWhere}`).n;

    return {
      summary: {
        groups: groups.size,
        catalog_created: catalogCreated.length,
        snapshots_linked: snapshotsLinked,
        already_linked: alreadyLinked,
        fuzzy_review: fuzzyReview.length,
      },
      catalog_created: catalogCreated,
      fuzzy_review: fuzzyReview,
      unlinked_remaining: unlinkedRemaining,
    };
  });
  return run();
}
