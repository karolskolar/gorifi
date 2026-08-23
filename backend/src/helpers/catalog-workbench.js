import db from '../db/schema.js';
import { normalizeProductName, normalizeRoastery } from './catalog.js';

// The manual assignment workbench — 12 §UC-PC-006 (PC-T9, resolved
// decision 14). REPLACES helpers/catalog-migrate.js's automatic flow: the
// shipped auto-migration's fuzzy suggestions merged unrelated products on
// staging, so every grouping-to-catalog decision is now the ADMIN's. ⚠ NO
// similarity/fuzzy math exists anywhere in this file — grouping identical
// (normalized_name, roastery) keys into one pending row is IDENTITY (the same
// key the UNIQUE constraint enforces), not a suggestion. Do not import
// nameSimilarity/FUZZY_THRESHOLD here, ever.
//
// ⚠ The PC-T4 data-safety invariant stands verbatim: the ONLY `products`
// write anywhere in this file is the bulk UPDATE of EXACTLY
// `source_coffee_product_id`. Snapshot names, descriptions, prices and
// order_items stay byte-identical (the e2e byte-compares).
//
// ⚠ Fully SYNCHRONOUS better-sqlite3 — no `await` anywhere in this file or in
// the route handlers (the GA-T8 lesson: an await between a check and its
// write breaks the instances:1 atomicity assumption).

// Candidate set (unchanged predicate, the PC-T4 one): coffee-cycle snapshots
// that are neither bakery-sourced nor already linked. Under the pivot every
// NEW snapshot is born linked, so this set only shrinks — the workbench
// drains it to empty and it stays empty.
const CANDIDATE_SQL = `
  SELECT p.*, oc.name AS cycle_name, oc.created_at AS cycle_created_at
  FROM products p
  JOIN order_cycles oc ON oc.id = p.cycle_id
  WHERE COALESCE(oc.type, 'coffee') = 'coffee'
    AND p.source_bakery_product_id IS NULL
    AND p.source_coffee_product_id IS NULL
  ORDER BY p.cycle_id DESC, p.id DESC`;

const groupKeyOf = (normalizedName, roastery) => `${normalizedName}\u0000${roastery}`;

// Load + group the unlinked candidates by the ONE normalization pair
// (single-home rule — never re-inlined). Candidates arrive newest-first
// (highest cycle_id, `id DESC` tiebreak — the GSO-T8 same-second lesson), so
// each group's FIRST snapshot is its newest. A name normalizing to '' has no
// identity (the importers' skip) and stays out of every group.
function loadGroups() {
  const groups = new Map();
  for (const snap of db.all(CANDIDATE_SQL)) {
    const key = normalizeProductName(snap.name);
    if (key === '') continue;
    const roastery = normalizeRoastery(snap.roastery);
    const gk = groupKeyOf(key, roastery);
    let group = groups.get(gk);
    if (!group) {
      group = { key, roastery, snapshots: [] };
      groups.set(gk, group);
    }
    group.snapshots.push(snap);
  }
  return groups;
}

// pending_count = the number of DISTINCT group keys still unlinked — the
// figure both mutating endpoints return recomputed after their write, so the
// UI drops rows without a full reload (the PM's step 3).
function countPendingGroups() {
  return loadGroups().size;
}

// GET /migration/pending — one row per distinct (normalized_name, roastery),
// display metadata from the group's NEWEST snapshot. Ordered by display_name,
// locale-insensitively (i.e. over the normalized key — ASCII lowercase, so a
// plain compare is the locale-insensitive order). No similarity column, no
// candidate suggestions — deliberately (decision 14).
export function pendingMigrationGroups() {
  const groups = loadGroups();
  const pending = [...groups.values()]
    .map((group) => {
      const newest = group.snapshots[0];
      const cycleIds = new Set(group.snapshots.map((s) => s.cycle_id));
      return {
        normalized_name: group.key,
        roastery: group.roastery,
        display_name: newest.name,
        snapshots: group.snapshots.length,
        cycles: cycleIds.size,
        newest_cycle: {
          id: newest.cycle_id,
          name: newest.cycle_name,
          created_at: newest.cycle_created_at,
        },
        purpose: newest.purpose,
        roast_type: newest.roast_type,
      };
    })
    .sort((a, b) => (a.normalized_name < b.normalized_name ? -1 : a.normalized_name > b.normalized_name ? 1 : 0));
  return { pending, pending_count: pending.length };
}

// Shared by both mutating endpoints: validate the request's `groups` array.
// Each entry needs BOTH strings (bindValue-hygiene by construction — only
// non-empty strings pass, so nothing unbindable ever reaches a statement).
// Returns the normalized, DEDUPED list or null when malformed. Deduping keeps
// linked_snapshots honest when the same key is sent twice.
export function parseGroupSelection(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set();
  const parsed = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.normalized_name !== 'string' || entry.normalized_name.trim() === '') return null;
    if (typeof entry.roastery !== 'string' || entry.roastery.trim() === '') return null;
    const normalizedName = normalizeProductName(entry.normalized_name);
    if (normalizedName === '') return null;
    const roastery = normalizeRoastery(entry.roastery);
    const gk = groupKeyOf(normalizedName, roastery);
    if (seen.has(gk)) continue;
    seen.add(gk);
    parsed.push({ normalized_name: normalizedName, roastery, gk });
  }
  return parsed;
}

// The one sanctioned `products` write — link every unlinked snapshot of the
// resolved groups to `catalogId`. Raced/empty groups are SKIPPED and reported,
// never a 404 (the GSO-T5 convergence rule: group keys are DERIVED, not
// stored, so "never existed" and "already resolved in parallel" are
// indistinguishable — and in both cases the requested end state holds).
// Runs INSIDE the caller's transaction.
function linkGroups(selection, catalogId, groups) {
  let linkedSnapshots = 0;
  let groupsLinked = 0;
  const skipped = [];
  for (const g of selection) {
    const group = groups.get(g.gk);
    if (!group || group.snapshots.length === 0) {
      skipped.push({ normalized_name: g.normalized_name, roastery: g.roastery, reason: 'no_unlinked_rows' });
      continue;
    }
    const ids = group.snapshots.map((s) => s.id);
    db.run(
      `UPDATE products SET source_coffee_product_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
      [catalogId, ...ids]
    );
    linkedSnapshots += ids.length;
    groupsLinked += 1;
  }
  return { linkedSnapshots, groupsLinked, skipped };
}

// POST /migration/assign — link the selection's unlinked snapshots to an
// EXISTING catalog row. The caller (route) has already validated the shape,
// resolved the catalog row and refused cross-roastery (409) — everything here
// is ONE synchronous db.transaction.
export function assignGroupsToCatalog(selection, catalogId) {
  const run = db.transaction(() => {
    const { linkedSnapshots, groupsLinked, skipped } = linkGroups(selection, catalogId, loadGroups());
    return {
      linked_snapshots: linkedSnapshots,
      groups_linked: groupsLinked,
      skipped,
      pending_count: countPendingGroups(),
    };
  });
  return run();
}

// POST /migration/create — ONE new catalog row from the NEWEST snapshot
// across the WHOLE selection (the strictly-newest rule), then link ALL
// selected groups' unlinked snapshots to it.
//
// ⚠ Deliberately NOT funnelled through consolidateCatalogRow (spec'd): the
// import helper's semantics are match-or-create with fuzzy flagging and a
// decision-13 refresh — here the admin's intent is CREATE, unconditionally,
// with fuzzy banned (decision 14). A funnel would silently convert "create
// new" into "match-and-refresh". One-home discipline is kept where it
// matters: the normalization pair above, and the same SQLITE_CONSTRAINT dual
// layer (isCatalogKeyCollision below mirrors catalog-import.js's, message
// included — a future UNIQUE on this table must not be silently answered as
// a name collision).
//
// Outcomes: { outcome: 'created', catalog_id, linked_snapshots, skipped,
// pending_count } | { outcome: 'name_collision', catalog_id } |
// { outcome: 'nothing_to_create' }.
export function createCatalogFromGroups(selection) {
  const run = db.transaction(() => {
    const groups = loadGroups();
    const newest = newestHead(selection, groups);
    // Zero unlinked snapshots ⇒ nothing to create from. This is also the
    // double-fire guard: a repeated create finds its groups already linked
    // and refuses instead of minting a duplicate catalog row.
    if (!newest) return { outcome: 'nothing_to_create' };

    const normalizedName = normalizeProductName(newest.name);
    const roastery = normalizeRoastery(newest.roastery);

    // App-level collision check (layer 1): a new row whose key collides with
    // an EXISTING catalog row is the assign hand-off, carrying the id.
    const clash = db.get(
      'SELECT id FROM coffee_products WHERE normalized_name = ? AND roastery = ?',
      [normalizedName, roastery]
    );
    if (clash) return { outcome: 'name_collision', catalog_id: clash.id };

    // Decision-13 field mapping: original casing, newest metadata, prices as
    // current prices, the newest snapshot's image (how per-cycle images
    // consolidate into the one catalog image), status 'available',
    // informational attributes born NULL (columns omitted).
    const result = db.run(
      `INSERT INTO coffee_products
         (name, normalized_name, roastery, description1, description2, roast_type, purpose,
          price_150g, price_200g, price_250g, price_500g, price_1kg, price_20pc5g, image, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available')`,
      [
        newest.name,
        normalizedName,
        roastery,
        newest.description1 ?? null,
        newest.description2 ?? null,
        newest.roast_type ?? null,
        newest.purpose ?? null,
        newest.price_150g ?? null,
        newest.price_200g ?? null,
        newest.price_250g ?? null,
        newest.price_500g ?? null,
        newest.price_1kg ?? null,
        newest.price_20pc5g ?? null,
        typeof newest.image === 'string' && newest.image !== '' ? newest.image : null,
      ]
    );
    const catalogId = result.lastInsertRowid;

    const { linkedSnapshots, skipped } = linkGroups(selection, catalogId, groups);
    return {
      outcome: 'created',
      catalog_id: catalogId,
      linked_snapshots: linkedSnapshots,
      skipped,
      pending_count: countPendingGroups(),
    };
  });

  try {
    return run();
  } catch (e) {
    // Layer 2 of the dual layer (the GA-T8/GSO-T10 pattern): the UNIQUE index
    // catches what the app-level check raced past — the transaction rolled
    // back, so NOTHING was written. Match the code PREFIX plus the EXACT index
    // message, never a bare /UNIQUE/i.
    if (isCatalogKeyCollision(e)) {
      // Re-derive the colliding row for the assign hand-off. The insert ran,
      // so a newest head exists — the same one the rolled-back attempt used.
      const newest = newestHead(selection, loadGroups());
      if (newest) {
        const clash = db.get(
          'SELECT id FROM coffee_products WHERE normalized_name = ? AND roastery = ?',
          [normalizeProductName(newest.name), normalizeRoastery(newest.roastery)]
        );
        if (clash) return { outcome: 'name_collision', catalog_id: clash.id };
      }
    }
    throw e;
  }
}

// Newest snapshot across the whole selection. Candidates are ordered
// cycle_id DESC, id DESC globally, so per group the first snapshot is its
// newest — compare group heads by the same order.
function newestHead(selection, groups) {
  let newest = null;
  for (const g of selection) {
    const group = groups.get(g.gk);
    if (!group || group.snapshots.length === 0) continue;
    const head = group.snapshots[0];
    if (!newest || head.cycle_id > newest.cycle_id || (head.cycle_id === newest.cycle_id && head.id > newest.id)) {
      newest = head;
    }
  }
  return newest;
}

function isCatalogKeyCollision(e) {
  return (
    e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT') &&
    typeof e.message === 'string' &&
    e.message.includes('UNIQUE constraint failed: coffee_products.normalized_name, coffee_products.roastery')
  );
}
