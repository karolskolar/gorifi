import db from '../db/schema.js';
import { nameSimilarity, FUZZY_THRESHOLD } from './catalog.js';

// Merge tool + stateless duplicates review — 12 §UC-PC-007/008 (PC-T5).
//
// ⚠ mergeCatalogRows is the ONLY code path in the module that DELETES a
// coffee_products row (resolved decision 9 — no standalone DELETE route ever
// exists). Because it repoints every snapshot link FIRST, inside the same
// transaction, a dangling products.source_coffee_product_id cannot be created
// by construction (the GSO-T9 dangling-pointer lesson, prevented rather than
// tolerated).
//
// ⚠ Fully SYNCHRONOUS better-sqlite3 — no `await` anywhere in this file or in
// the route handlers (the GA-T8 lesson: an await between the existence checks
// and the writes would break the instances:1 atomicity assumption).
//
// ⚠ Similarity comes from helpers/catalog.js, the ONE home (UC-PC-002) — never
// re-inline the normalization or the Levenshtein band here.

// mergeCatalogRows(targetId, sourceId) — merge catalog row B (source) INTO A
// (target). ONE db.transaction, and the transaction does exactly this:
//   1. UPDATE products SET source_coffee_product_id = A.id WHERE … = B.id
//   2. TRANSFER B's split mappings to A (PC-T13): DELETE B's rows whose
//      (normalized_name, roastery) A already carries — the UNIQUE-dedupe —
//      then UPDATE the rest to point at A. Without this the FK CASCADE on
//      catalog_import_splits would silently drop the mapping with B, the
//      sheet row would refresh one fewer target, and if B was the LAST
//      target the row would re-create as `new` on the next import.
//   3. DELETE FROM coffee_products WHERE id = B.id
// Nothing else is written — the "metadata repointing, never a financial or
// historical event" posture is unchanged.
//
// Target wins entirely: A's name, normalized_name, metadata, image, status and
// prices are all untouched — if B had the better image or name, the admin edits
// A afterwards (UC-PC-009). No `transactions` row, no snapshot mutation beyond
// the link column, no order_items change — a merge is a metadata repointing,
// never a financial or historical event (the GSO-T6 lesson).
//
// ⚠ Forward seam for module 13 (binds only if 13 revives): when
// friend_reviews(friend_id, coffee_product_id) lands, the review repoint (with
// latest-wins dedupe on the UNIQUE pair) is ADDED to THIS transaction by
// module 13 — recorded so neither module ships a merge that strands reviews.
//
// Outcomes (the route maps them to HTTP): 'not_found' — either id unknown,
// which is also what a REPEATED merge of a now-deleted source returns (404,
// per §UC-PC-007's "either id unknown"; deliberately not an idempotent 200);
// 'roastery_mismatch' — refused unconditionally, nothing written;
// 'merged' — { target: <A's row, read before the writes it never touches>,
// repointed_snapshots: n }.
export function mergeCatalogRows(targetId, sourceId) {
  const run = db.transaction(() => {
    const target = db.get('SELECT * FROM coffee_products WHERE id = ?', [targetId]);
    const source = db.get('SELECT * FROM coffee_products WHERE id = ?', [sourceId]);
    // 404 before any 4xx about state: an unknown id refuses here, before the
    // roastery comparison can even be posed.
    if (!target || !source) return { outcome: 'not_found' };
    if (target.roastery !== source.roastery) return { outcome: 'roastery_mismatch' };

    const repointed = db.run(
      'UPDATE products SET source_coffee_product_id = ? WHERE source_coffee_product_id = ?',
      [target.id, source.id]
    );

    // Split-mapping transfer (PC-T13): dedupe first — drop the source's rows
    // whose (normalized_name, roastery) the target already declares, so the
    // repoint below can never violate UNIQUE(normalized_name, roastery,
    // coffee_product_id) — then hand the survivors to the target.
    db.run(
      `DELETE FROM catalog_import_splits
        WHERE coffee_product_id = ?
          AND EXISTS (
            SELECT 1 FROM catalog_import_splits t
             WHERE t.coffee_product_id = ?
               AND t.normalized_name = catalog_import_splits.normalized_name
               AND t.roastery = catalog_import_splits.roastery
          )`,
      [source.id, target.id]
    );
    db.run(
      'UPDATE catalog_import_splits SET coffee_product_id = ? WHERE coffee_product_id = ?',
      [target.id, source.id]
    );

    db.run('DELETE FROM coffee_products WHERE id = ?', [source.id]);

    return { outcome: 'merged', target, repointed_snapshots: repointed.changes };
  });
  return run();
}

// findDuplicatePairs() — the durable "pending confirmation" surface
// (UC-PC-008): a stateless, on-demand recompute of every SAME-roastery catalog
// pair in the fuzzy band (FUZZY_THRESHOLD ≤ similarity < 1), both rows' status
// ANY (a retired duplicate still pollutes history until merged). No
// pending-state table exists (resolved decision 1) and no dismiss state — a
// standing false positive costs one list row (a dismissed_pairs table is the
// recorded future extension, not built).
//
// Resolution is the merge above: the pair disappears from the next recompute
// because one row is gone. O(n²) over ~tens of rows — free.
//
// Shape: { pairs: [{ a: {id, name, cycles_count}, b: {…}, similarity }] },
// similarity DESC. cycles_count = COUNT(DISTINCT cycle_id) of linked snapshots
// (the UC-PC-009 list's definition — NULL-linked snapshots count toward
// nothing).
export function findDuplicatePairs() {
  const rows = db.all(
    'SELECT id, name, normalized_name, roastery FROM coffee_products ORDER BY id'
  );

  const cyclesCount = new Map();
  for (const r of db.all(`
    SELECT source_coffee_product_id AS catalog_id, COUNT(DISTINCT cycle_id) AS n
    FROM products
    WHERE source_coffee_product_id IS NOT NULL
    GROUP BY source_coffee_product_id
  `)) {
    cyclesCount.set(r.catalog_id, r.n);
  }

  const entry = (r) => ({ id: r.id, name: r.name, cycles_count: cyclesCount.get(r.id) ?? 0 });

  // PC-T13 split-rule suppression: a split target is EXCLUDED from the review
  // against its siblings (targets of the same sheet row) and against a row
  // whose identity IS the sheet name — otherwise the PM gets the same false
  // pair the split mapping exists to dissolve, in a different tab. Deliberately
  // minimal: any other near-name still surfaces.
  const splitKeysByProduct = new Map(); // coffee_product_id → Set('key\u0000roastery')
  for (const s of db.all('SELECT normalized_name, roastery, coffee_product_id FROM catalog_import_splits')) {
    let set = splitKeysByProduct.get(s.coffee_product_id);
    if (!set) splitKeysByProduct.set(s.coffee_product_id, (set = new Set()));
    set.add(`${s.normalized_name}\u0000${s.roastery}`);
  }
  const identityKey = (r) => `${r.normalized_name}\u0000${r.roastery}`;
  const splitSuppressed = (a, b) => {
    const ka = splitKeysByProduct.get(a.id);
    const kb = splitKeysByProduct.get(b.id);
    if (ka && kb) {
      for (const k of ka) if (kb.has(k)) return true; // siblings of one sheet row
    }
    if (ka && ka.has(identityKey(b))) return true; // target ↔ sheet-named row
    if (kb && kb.has(identityKey(a))) return true;
    return false;
  };

  // Within-roastery only (resolved decision 3): a Goriffee product can never
  // pair with another roastery's, however similar the names.
  const byRoastery = new Map();
  for (const r of rows) {
    // '' = no identity, never match (the UC-PC-002 rule) — nameSimilarity
    // would score it 0 anyway; skipping just saves the loop.
    if (r.normalized_name === '') continue;
    let list = byRoastery.get(r.roastery);
    if (!list) byRoastery.set(r.roastery, (list = []));
    list.push(r);
  }

  const pairs = [];
  for (const list of byRoastery.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const similarity = nameSimilarity(list[i].normalized_name, list[j].normalized_name);
        // Exact (similarity = 1) is never "fuzzy" — and cannot occur here
        // anyway, UNIQUE(normalized_name, roastery) forbids two equal keys.
        if (similarity >= FUZZY_THRESHOLD && similarity < 1 && !splitSuppressed(list[i], list[j])) {
          pairs.push({ a: entry(list[i]), b: entry(list[j]), similarity });
        }
      }
    }
  }

  pairs.sort((x, y) => y.similarity - x.similarity);
  return { pairs };
}
