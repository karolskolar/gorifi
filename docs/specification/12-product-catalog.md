# 12 — Product catalog (consolidated coffee products, duplicate-aware import, migration, cross-cycle stats)

> Scope: The consolidated `coffee_products` catalog and everything that keeps it true:
> the schema (`coffee_products` + the single change to an existing table,
> `products.source_coffee_product_id`), the ONE exported normalization helper, the
> duplicate-aware consolidation layer that runs AFTER parsing on every coffee product
> creation path (the three import endpoints + the manual per-cycle POST), the
> machine-readable idempotent import report, the one-time historical migration, the
> admin merge tool, the fuzzy-duplicate review, the catalog admin view (existing admin
> skin — shadcn, NO Podpultovka theme classes), and the cross-cycle statistics
> (admin, `requireAdmin`). ⚠ Like 07–11 this module INCLUDES backend/schema changes.
> Out of scope (handoffs): **ALL friend-facing UI** — passport, reviews, brew methods,
> product detail modal — belongs to module 13; this file only defines the seams 13
> consumes (§Seams). **Social-proof badges/labels of any kind** — deferred; the stats
> layer here must support them (brief §4.1), display is future work. **Tier progress
> on the order page** — cut entirely (brief Decision 7), do not build the DB for it.
> **Module 14** (curator's pick UI, Novinka badge) — `curator_pick_note` and `is_new`
> ship as COLUMNS ONLY here. **Bakery** — stays separate, likely removed; never
> generalize the coffee catalog for it (brief Decision 6). **Importer parsing/column
> mapping** — byte-identical, no change. **Autonomous import routine** — future; the
> JSON report + idempotency here are its enablers. **goriffee.com attribute prefill** —
> future (brief §5).
> Actors: **Admin** — sole operator of every surface in this module (import, migration,
> merge, catalog management, stats). **System** — schema, helpers, consolidation layer.
> **Friend / Guest** — appear only as data (buyers in statistics); no friend/guest
> surface changes here. Future **autonomous import routine** — a machine consumer of
> the import report contract (§UC-PC-004), not built now.
> Sources: `docs/requirements/2026-08-18-catalog-profiles-recommendations-brief.md`
> (v5, CANONICAL — its §6 Decisions log wins over earlier body text);
> `docs/specification/00-overview.md` §Scope extension 2026-08-22 + file index;
> `docs/specification/01-architecture.md` §Catalog & passport extensions (BINDING
> conventions: schema shapes, single-home normalization, import-layer contract,
> migration/merge rules, stats conventions, ADMIN_ENDPOINTS rule, no-new-dependencies
> rule); repo code (`backend/src/routes/products.js` — the importers,
> `backend/src/routes/cycles.js:229` — the bakery snapshot precedent,
> `backend/src/db/schema.js` — house migration pattern + `roasteries` seed,
> `backend/src/helpers/analytics.js` — `variantToKg()`,
> `backend/src/helpers/guest-aggregation.js` — `guestCycleItems()`,
> `backend/src/index.js` — mount conventions); `docs/data-model.md`; repo `CLAUDE.md`
> (ADMIN_ENDPOINTS invariant, GA-T8 await-breaks-atomicity lesson, GSO-T6/T8 JS-merge
> rule, GSO-T8 id-tiebreak lesson, FUP-T13 `bindValue` pattern, the 2026-08-20
> "one image per product" product decision). The most recent decision wins on conflict.
> **Design reference:** no prototype screen exists for this module. The catalog admin
> view follows the existing shadcn conventions of `AdminBakeryProducts.vue` /
> `CycleDetail.vue` (01-architecture scope rule: admin views keep the current look —
> no `.app` scope, no theme tokens, no `neo/` components). Admin copy stays in the
> existing pragmatic Slovak of the admin app.

---

## Resolved conflicts & module-level decisions (recency / canonicity)

1. **Fuzzy near-miss ⇒ CREATE-AS-NEW-BUT-FLAGGED, never held pending.** The brief's
   §2.2 wording ("the import report asks for confirmation… Admin confirms merge or
   creates as new") admits two mechanisms: (a) hold the row until the admin answers, or
   (b) import it as a NEW catalog row + linked snapshot, flag the suspicion in the
   report, and let the admin resolve with the merge tool. **This module picks (b).**
   Justification: the import must complete non-interactively (brief §2.6 — the future
   autonomous routine cannot answer a prompt); the cycle must be fully populated the
   moment the import returns (the admin imports right before opening a cycle — a held
   row is a product friends cannot buy); "held" would need a new pending-rows table +
   resolution endpoint, while (b) reuses the merge tool the module must ship anyway
   (brief §2.3 names it "the permanent safety valve"); and (b) leaves nothing
   half-done — the next cycle's import exact-matches the flagged row (or the merged
   survivor) instead of re-asking. "Admin confirms
   merge" = runs the merge (UC-PC-007); "creates as new" = does nothing — new is
   already the state. The suspicion survives report loss because it is **recomputable**
   (UC-PC-008). The same mechanism resolves the migration's fuzzy tail. This is an
   implementation-level choice consistent with brief Decision 3 ("very-similar names
   ask for confirmation" — they do, in the report and the duplicates review; they are
   never auto-MERGED), so it is decided here, not OPEN.
2. **Migration runs as an admin-triggered endpoint, not a boot migration.** The house
   try/catch boot pattern is for columns (and is used for them here); the grouping
   migration is heavy, needs to return a fuzzy-review report, must be observable, and
   must be re-runnable after merges. A failed boot migration would block startup;
   a boot migration cannot render a report. `POST /api/coffee-products/migrate`
   (UC-PC-006) is idempotent — safe to call again at any time.
3. **"Goriffee-only" is realized as within-roastery matching.** The import endpoints
   accept a `roastery` body field (default = the `roasteries` `is_default` row,
   'Goriffee'). Matching candidates are ALWAYS restricted to catalog rows of the row's
   effective roastery — for the Goriffee sheet that is Goriffee-only by construction
   (01-architecture's phrasing), and a hypothetical other-roastery import can never
   match (or fuzzy-suggest) a Goriffee product. `NULL`/empty roastery on a row or
   snapshot means the default roastery's name.
4. **Normalization includes diacritic folding.** The brief lists "trim, case-fold,
   collapse whitespace, fold punctuation"; this module adds NFD + strip combining
   marks. Rationale: sheet names are sometimes typed without diacritics, and a missed
   diacritic variant silently creates the exact duplicate this module exists to kill;
   two real coffees differing ONLY in diacritics do not occur in this domain (names
   are foreign: "Pink Bourbon", "Cerro Azul"). Recorded as a deliberate extension of
   the brief's list, one function, one home (UC-PC-002).
5. **The image becomes CATALOG-OWNED; snapshots stop carrying their own copy.** The
   2026-08-20 product decision recorded in CLAUDE.md ("the planned DB consolidation
   makes products global — one image per product, not per cycle snapshot") is newer
   than any per-snapshot image mechanics and wins. Import-created snapshots keep
   `image = NULL`; read paths resolve `COALESCE(p.image, cp.image)` (UC-PC-003 rule 6).
   A snapshot-level image, where present (manual upload, bakery, history), still wins.
   Consequence, stated openly: editing a catalog image changes how PAST cycles display
   that product — accepted; immutability protects prices/order_items, not display art.
6. **The importer response shape is EXTENDED, never replaced.** `CycleDetail.vue`
   consumes `{message, products}` (+ `warnings` on multirow) today; those keys stay
   byte-compatible and the response gains `report` (UC-PC-004). Existing frontend
   keeps working before the report UI lands.
7. **The multirow importer's "without transaction wrapper to avoid sql.js issues"
   comment is STALE** (SEC-D1 moved to better-sqlite3). The consolidation layer wraps
   each import's DB work in one `db.transaction` on all three paths — required anyway
   by the GA-T8 lesson (the two gsheet routes `await` a fetch; every DB read/write
   must happen AFTER the last `await`, synchronously, or check-then-insert races).
8. **`is_new` is admin-edited only in this module.** Brief §4.2's "Sheet's NOVINKA
   flag → Novinka badge if present in the adapted sheet" would require a new column
   mapping — a parsing change, which is forbidden here. The column ships; sheet-driven
   capture is future work (module 14 / §5).
9. **No standalone catalog DELETE.** Lifecycle end is `status = 'retired'`; the merge
   tool is the ONLY path that deletes a catalog row (after repointing every link), so
   a dangling `source_coffee_product_id` cannot be created by this module (the GSO-T9
   dangling-pointer lesson, prevented by construction instead of tolerated).
10. **Flavor chips (auto-tag + admin override + column) DEFERRED by PM decision
    2026-08-22** — the chips risk being misleading and are skipped for v1 entirely
    (no `flavor_chips` column, no `autoTagFlavorChips`, no admin override UI).
    Re-adding later is the house try/catch ALTER pattern plus a backfill over
    `description2`; **nothing in v1 may assume the column exists.** Module 13 drops
    its chips display row in the same decision. The brief (v6 decision #10), 00-overview's
    glossary and 01-architecture's column list already record the removal.
11. **Cycles are frozen ABSOLUTELY — re-import into a non-empty cycle is REFUSED
    (PM decision 2026-08-22).** This supersedes the brief §2.2's "importing the same
    sheet into the same cycle twice = … second run reports '0 changes'": imports
    target fresh/future cycles only, and an import must never change products within
    an existing cycle — **no in-place snapshot price updates, ever**. An import into
    a cycle that already contains any coffee product is refused with a clean 409
    writing nothing (UC-PC-003 rule 0). The refusal IS the idempotency property now:
    a double-fired import (the future autonomous routine's retry case) writes nothing
    the second time. The report's `unchanged` bucket, which existed only for the
    superseded re-import semantics, is dropped from the contract (UC-PC-004). Price
    changes only ever accompany a NEW snapshot (an import into a fresh cycle, or a
    manual POST adding a product — UC-PC-005): catalog current price updated + the
    new snapshot carries the new price. There is NO in-place snapshot price update
    path anywhere in this module; existing cycles are untouched by construction.

---

## UC-PC-001 Schema — `coffee_products` + the snapshot link (System)

**Goal:** the catalog table, its indexes, and the single change to an existing table,
in `backend/src/db/schema.js`, using the house patterns.

**Business rules:**

- New table, `CREATE TABLE IF NOT EXISTS` (new tables need no ALTER migrations —
  the guest-tables precedent):

  ```sql
  CREATE TABLE IF NOT EXISTS coffee_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    roastery TEXT NOT NULL DEFAULT 'Goriffee',
    country TEXT,
    region TEXT,
    altitude TEXT,
    farm TEXT,
    variety TEXT,
    processing TEXT,
    description1 TEXT,
    description2 TEXT,
    roast_type TEXT,
    purpose TEXT,
    is_new INTEGER DEFAULT 0,     -- column only; feature is module 14
    curator_pick_note TEXT,       -- column only; feature is module 14
    image TEXT,
    status TEXT NOT NULL DEFAULT 'available'
      CHECK (status IN ('available','retired')),
    price_150g REAL, price_200g REAL, price_250g REAL,
    price_500g REAL, price_1kg REAL, price_20pc5g REAL,  -- "current" = last imported
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(normalized_name, roastery)
  )
  ```

  `region`/`altitude`/`farm`/`variety`/`processing` are **informational attributes**:
  admin-entered once, display-only (13's detail modal), **NEVER written by the
  importer or the migration** (brief Decision 9). Only `country`/`purpose`/
  `roast_type` are ever filtered or aggregated (01-architecture's list minus
  `flavor_chips`, deferred per resolved decision 10).
- **`products.source_coffee_product_id`** — the ONLY change to an existing table
  (brief §7): house try/catch pattern,
  `ALTER TABLE products ADD COLUMN source_coffee_product_id INTEGER` (no FK — the
  bare-ALTER house precedent, 07 §UC-IA-001; safe because UC-PC-007 is the only
  deleter and it repoints first, per decision 9 above). Every consumer must tolerate
  NULL (unmigrated / pre-feature rows): a NULL-linked snapshot simply counts toward
  no catalog product.
- Index for the stats joins:
  `CREATE INDEX IF NOT EXISTS idx_products_source_coffee ON products(source_coffee_product_id)`
  (create with `IF NOT EXISTS` outside try/catch — indexes support it; never a
  swallowing try/catch around a UNIQUE the app relies on, the GA-T5 lesson). The
  `UNIQUE(normalized_name, roastery)` constraint doubles as the lookup index.
- `order_items`, frozen snapshot prices, and every guarded seam (`helpers/stock.js`,
  `helpers/pricing.js`, guest JS-merge, packing gates) are **untouched** — this UC
  adds one nullable column and one table, nothing else.

**Acceptance criteria:** backend restart on an existing production-shaped DB creates
the table, adds the column and the index without error, and is idempotent (second
restart = no-op); inserting two catalog rows with the same `normalized_name` +
`roastery` fails on the UNIQUE constraint; a snapshot row with NULL link is served by
every existing endpoint exactly as before.

---

## UC-PC-002 `helpers/catalog.js` — normalization + fuzzy similarity (System)

**Goal:** ONE backend helper module holding the pure functions every other UC
calls. Two normalizers drifting is how duplicates return (01-architecture) — the
importer (UC-PC-003), manual POST (UC-PC-005), migration (UC-PC-006), merge tool
(UC-PC-007) and duplicates review (UC-PC-008) must ALL import from here.

**Business rules:**

- **`normalizeProductName(s)`** — the identity key. Deterministic pipeline:
  `String(s)` → Unicode NFD → strip combining marks (U+0300–036F) → lowercase →
  replace every run of characters outside `[a-z0-9]` with a single space → trim.
  Examples (testable): `"  Pink  Bourbon – Honey "` → `pink bourbon honey`;
  `"CERRO AZUL"` → `cerro azul`; `"Mliečna Čokoláda!"` → `mliecna cokolada`.
  Empty/whitespace-only input normalizes to `''` — callers must treat `''` as
  "no identity, never match" (matches the importers' existing `if (name)` skip).
- **`normalizeRoastery(s)`** — `trim(s)` when non-empty, else the `roasteries`
  `is_default` row's name (seeded `'Goriffee'`). Matching and catalog storage always
  use the resolved name (resolved decision 3).
- **`nameSimilarity(a, b)`** — in-repo, **no fuzzy-string dependency**
  (01-architecture): plain Levenshtein over the two normalized names,
  `similarity = 1 − distance / (len_a + len_b)`. ⚠ CORRECTED during PC-T1: the
  original text said `… / max(len_a, len_b)`, which contradicts this UC's own
  acceptance example — it yields 0.667 for `('pink bourbon','pink bourbon honey')`,
  below the 0.75 band the example requires. The sum-denominator form gives 0.80 /
  0.52 for the two pinned pairs; exact = 1. If the threshold is ever retuned
  (UC-PC-008), tune against THIS formula. The candidate set is ~tens of
  rows, so O(n·m) per pair is free. Either normalized name being `''` ⇒ similarity
  0 ("no identity, never match" — also avoids 0/0).
- **`FUZZY_THRESHOLD = 0.75`** — a named exported constant: a pair is a fuzzy
  near-miss when `FUZZY_THRESHOLD ≤ similarity < 1`. Shipped as a sensible default,
  tunable from data (the brief's Decision-5 posture). Exact (`similarity = 1`, i.e.
  equal normalized names) is never "fuzzy".
- _(Flavor-chip auto-tagging was drafted here and REMOVED — resolved decision 10.
  No chip helper exists in v1.)_

**Acceptance criteria:** `node --check` passes; the example normalizations above hold;
`nameSimilarity('pink bourbon', 'pink bourbon honey')` lands in the fuzzy band while
`('pink bourbon','ethiopia sidamo')` does not; grep across `backend/src` finds exactly
one definition of the normalization pipeline.

---

## UC-PC-003 Import consolidation layer — per-row matching on all three importers (Admin)

**Goal:** every parsed coffee row is consolidated against the catalog before its
snapshot is written. Parsing and column mapping in
`POST /products/import/:cycleId`, `POST /products/import-gsheet/:cycleId` and
`POST /products/import-gsheet-multirow/:cycleId` stay **byte-identical** — the layer
runs after parsing, per parsed row, implemented once as an exported
`consolidateRow(cycleId, parsedRow, roastery)` (suggested home: `helpers/catalog.js`
or a sibling `helpers/catalog-import.js`) that all three endpoints call.

**Route-level guard (before any per-row work):**

0. **The frozen-cycle guard (resolved decision 11).** An import into a cycle that
   already contains ANY coffee snapshot —
   `SELECT 1 FROM products WHERE cycle_id = ? AND source_bakery_product_id IS NULL LIMIT 1`,
   deliberately **regardless of `active`** (a soft-deleted snapshot may already carry
   `order_items`; "redo a botched import" happens in a NEW cycle, per the remedy) —
   is refused with **409**
   `{ error: 'Cyklus už obsahuje produkty — vytvorte nový cyklus.', reason: 'cycle_not_empty' }`,
   **writing nothing**. This predicate is the simpler defensible choice over
   "created-by-import rows only": it needs no provenance column, and a cycle with any
   coffee product (imported or manual) is by definition not the fresh cycle imports
   target. Checked EARLY (right after the existing cycle-404, before the gsheet fetch
   — no wasted outbound call) AND **re-checked inside the write transaction** (the
   gsheet paths `await` a fetch between the two — the GA-T8 window; the in-transaction
   re-check is what makes a double-fired import write nothing, which is now THE
   idempotency property). Applies to all three import endpoints; the manual POST has
   its own narrower rule (UC-PC-005).

**Per-row algorithm (in order):**

1. **Normalize:** `key = normalizeProductName(row.name)`; `r = normalizeRoastery(roastery)`.
   `key === ''` ⇒ the row is skipped exactly as today's `if (name)` does, and counted
   in the report's `unparsed` (new observability, no behavior change).
2. **Exact match** (`coffee_products WHERE normalized_name = key AND roastery = r`):
   - **Auto-link** (brief Decision 3): INSERT the snapshot exactly as today
     (same columns, same values from the sheet) plus `source_coffee_product_id`, with
     empty sheet fields (`description1`, `description2`, `roast_type`, `purpose`)
     filled from the catalog row (metadata reuse). **No image copy** — resolved
     decision 5; rule 6 below carries the image. Count as `matched`.
   - **Price auto-apply** (brief Decision 2 + resolved decision 11): for every price
     field the sheet supplies (non-NULL after the existing `parsePrice`), if it
     differs from the catalog's current price, UPDATE the catalog field and report
     `{catalog_id, name, field, old, new}` under `price_changes`. Fields the sheet
     does not supply are left untouched on the catalog. This — a new cycle's import —
     is the ONLY path a price change enters the app: the catalog's current price plus
     the new cycle's snapshots. Existing cycles' snapshots are never touched (rule 0
     removed the only path that could have reached one); frozen prices are a guarded
     seam.
   - **In-sheet duplicate:** a later row in the SAME sheet resolving to a catalog id
     this run already snapshotted is skipped (no second snapshot) and reported under
     `unparsed` with reason `duplicate row in sheet` — nothing is silently dropped.
3. **No exact match ⇒ fuzzy scan:** compute `nameSimilarity(key, candidate)` over
   the same-roastery catalog rows; collect candidates in the fuzzy band, best first.
4. **Create catalog row** (whether or not fuzzy candidates exist — resolved
   decision 1): `name` = the sheet name (original casing), `normalized_name = key`,
   `roastery = r`, descriptions/roast/purpose/prices from the parsed row,
   `status = 'available'`,
   `image = NULL`, informational attributes NULL (never from the importer). INSERT
   the linked snapshot as in step 2. Report under `new` with
   `needs_image: true` (image is NULL by definition here); when fuzzy candidates
   existed, ALSO report under `pending_fuzzy` as
   `{catalog_id, name, candidate_catalog_id, candidate_name, similarity}` — the
   "Je to premenovaný X?" question. The new row is **not** linked to the candidate;
   the admin merges via UC-PC-007 or leaves it as genuinely new.

**Cross-cutting rules:**

5. **One synchronous transaction per import.** All catalog lookups + writes + snapshot
   INSERTs for the request run inside one `db.transaction`, entered only AFTER the
   last `await` on the gsheet paths (the GA-T8 lesson: an `await` between a uniqueness
   check and its INSERT breaks the `instances: 1` atomicity assumption). Dual-layer:
   the in-transaction check is load-bearing today; a `SQLITE_CONSTRAINT` on
   `coffee_products` (match `code.startsWith('SQLITE_CONSTRAINT')` PLUS the exact
   `UNIQUE constraint failed: coffee_products.normalized_name` message, never a bare
   `/UNIQUE/i`) is additionally translated to the exact-match path's behavior, for
   the PM2-cluster scenario. The multirow endpoint's bare insert loop moves inside
   the same transaction (resolved decision 7 — no parsing change).
6. **Image fallback on the snapshot read paths.** Snapshot list/detail reads serve
   `COALESCE(p.image, cp.image) AS image` via
   `LEFT JOIN coffee_products cp ON cp.id = p.source_coffee_product_id`. Response
   shapes are unchanged (still an `image` field). Enumerated call sites to convert:
   `products.js GET /cycle/:cycleId`, `products.js GET /:id`, and the guest product
   listing in `routes/guest.js` (read-only column change on the hostile-boundary
   route — nothing about its gates, bounds or pricing moves); the implementer must
   sweep for any other snapshot read that serves `image`. A non-NULL snapshot image
   (manual upload, bakery, historical rows) still wins the COALESCE.
7. **`bindValue` discipline** (FUP-T13 house pattern): any NEW body field this layer
   reads goes through `bindValue`; existing fields keep their existing treatment.
8. Consolidation applies to **coffee rows only**. The three importers only ever
   create coffee-shaped rows (they have no bakery path), so no runtime type check is
   needed there; the rule matters for UC-PC-005.

**Acceptance criteria:** importing a CSV into a FRESH cycle with one known product
(exact normalized match, different price) and one unknown product yields: 1 matched
snapshot linked to the existing catalog row with the sheet's price, 1 catalog price
updated + reported old→new, 1 new catalog row + linked snapshot; older cycles'
snapshots byte-identical before/after; **re-importing the same CSV into the same
cycle is refused with 409 `cycle_not_empty` and ZERO writes** (byte-compare the
cycle's `products` rows and the catalog before/after the refused call); a near-miss
name ("Pink Bourbon Honey" vs existing "Pink Bourbon") creates a new catalog row AND
a `pending_fuzzy` entry naming the candidate; the friend order page shows the
catalog image for an import-created snapshot.

---

## UC-PC-004 Import report — the machine-readable contract (Admin / future routine)

**Goal:** every import (and the manual POST, UC-PC-005) returns a JSON report that a
human reads rendered and a future autonomous routine consumes raw. **The shape is a
contract** — changing it later is a breaking change to the routine (brief §2.6).

**Response rule:** the three import endpoints keep their existing 201 body keys
byte-compatible (`message`, `products`, and multirow's `warnings` — resolved
decision 6) and gain `report`:

```json
{
  "report": {
    "summary": { "new": 1, "matched": 3, "price_changes": 2,
                 "pending_fuzzy": 1, "unparsed": 0 },
    "new":           [{ "catalog_id": 41, "product_id": 812, "name": "…",
                        "needs_image": true }],
    "matched":       [{ "catalog_id": 7,  "product_id": 813, "name": "…" }],
    "price_changes": [{ "catalog_id": 7,  "name": "…", "field": "price_250g",
                        "old": 8.9, "new": 9.4 }],
    "pending_fuzzy": [{ "catalog_id": 41, "name": "…",
                        "candidate_catalog_id": 7, "candidate_name": "…",
                        "similarity": 0.87 }],
    "unparsed":      [{ "row": 14, "reason": "missing name" }]
  }
}
```

**Business rules:**

- Category semantics (fixed vocabulary): `new` = catalog row created (+ snapshot);
  `matched` = linked to an existing catalog row, new snapshot created;
  `price_changes` = one entry per (catalog row, price field) whose catalog current
  price changed; `pending_fuzzy` = a `new` row with a same-roastery near-miss
  candidate (subset of `new`, cross-referenced by `catalog_id`); `unparsed` = rows
  the existing parser skipped (no name), in-sheet duplicates (UC-PC-003), or rows
  that produced multirow `warnings` — **nothing is silently guessed or dropped**
  (brief §2.2). There is deliberately NO `unchanged` bucket: it existed only for the
  superseded same-cycle re-import semantics (resolved decision 11).
- **The idempotency promise is the refusal, not a report state** (resolved
  decision 11): a report is only ever produced for an import into an empty cycle;
  a repeated/retried import answers 409 `cycle_not_empty` with zero writes. The
  future autonomous routine treats that 409 as "already done", not as an error.
- The report is **returned, not persisted** (brief §7: "persist later if the
  autonomous routine needs history"). Loss is harmless: `pending_fuzzy` is
  recomputable via UC-PC-008, everything else is visible in the catalog.
- Rendering: `CycleDetail.vue`'s import UI renders `report.summary` as the headline
  ("X nových / Y existujúcich / Z zmien cien" — the brief's success metric) with the
  detail lists expandable; each `pending_fuzzy` entry renders "Je to premenovaný
  {candidate_name}?" with a link/button into the catalog view's merge flow
  (UC-PC-009). Existing import UI behavior otherwise unchanged.

**Acceptance criteria:** the JSON shape above is asserted key-for-key in e2e (a
contract test — extra keys allowed, listed keys stable); the second identical import
gets the 409 refusal and produces no report; an import with a skipped nameless row
reports it under `unparsed` with a reason.

---

## UC-PC-005 Manual product POST — consolidation on manual creation (Admin)

**Goal:** `POST /api/products` (manual per-cycle product entry) joins the
consolidation so a hand-entered coffee cannot silently bypass the catalog.

**Business rules (decision + proposal, consistent with UC-PC-003):**

- The route runs the SAME `consolidateRow` path for coffee rows: exact match ⇒
  auto-link (and the manual price, being this cycle's sell price, updates the
  catalog current price exactly like an imported one); no match ⇒ create catalog row
  + linked snapshot; fuzzy near-miss ⇒ create-as-new-but-flagged.
  The 201 response keeps returning the created snapshot row (byte-compatible) and
  gains the same `report` object with exactly one row accounted for.
- **Coffee-row detection:** the manual POST can create bakery-shaped rows too
  (bakery snapshots normally come from cycle creation, but the endpoint is generic).
  Consolidation runs when the target cycle's `COALESCE(type,'coffee') = 'coffee'`;
  bakery-cycle rows are never consolidated and never touch `coffee_products`
  (brief Decision 6).
- A manual POST with an uploaded/body image stores it on the SNAPSHOT (existing
  behavior, unchanged) — it wins the UC-PC-003 COALESCE; when the row also CREATED a
  catalog entry, the image is additionally stored on the new catalog row (so the next
  cycle reuses it — the friction win).
- FUP-T13 `bindValue` treatment of existing fields is untouched; the existing
  `cycle_id`/`name` 400 still fires first.
- **The UC-PC-003 rule-0 frozen-cycle guard does NOT apply here** — the manual POST
  is precisely the sanctioned way to add one more product to a cycle that already
  has some. Its narrower duplicate guard instead: a POST whose exact match already
  has a snapshot in the TARGET cycle is refused with **409**
  `{ error: 'Produkt už v tomto cykle existuje.', reason: 'duplicate_in_cycle' }`,
  writing nothing (today it would create a second row — a deliberate behavior
  change, recorded here; it is the same admin mistake the module exists to catch).
  The admin who genuinely wants a second identical product in one cycle renames it.

**Acceptance criteria:** manual POST of a known Goriffee name links the snapshot and
returns `matched`; POST of a new name creates a catalog row with `needs_image`
reflecting the image's presence; the same POST repeated is refused with 409
`duplicate_in_cycle` and no duplicate snapshot (zero writes); POST into a bakery
cycle creates no `coffee_products` row.

---

## UC-PC-006 One-time historical migration (Admin)

**Goal:** all historical coffee snapshots get catalog rows and links, so statistics
count from day one (brief goal (c)).

**Route contract:** `POST /api/coffee-products/migrate` — `requireAdmin` (whole-mount,
UC-PC-009), admin-triggered (resolved decision 2), idempotent, transactional.

**Business rules:**

- **Candidate set:** `products` rows where the owning cycle's
  `COALESCE(order_cycles.type, 'coffee') = 'coffee'` AND
  `source_bakery_product_id IS NULL` AND `source_coffee_product_id IS NULL`
  (already-linked rows are skipped — that is the idempotency; re-running after an
  import or a merge only picks up the still-unlinked tail).
- **Grouping:** by `(normalizeProductName(name), normalizeRoastery(roastery))` — the
  same helper the importer uses, by construction (single-home rule).
- **Per group, inside ONE `db.transaction`** (better-sqlite3, synchronous — no
  `await` anywhere in the handler):
  - An exact-matching catalog row exists ⇒ backfill `source_coffee_product_id` on
    every snapshot in the group (bulk UPDATE).
  - None exists ⇒ create the catalog row **from the group's most recent snapshot**
    (highest `cycle_id`, `id DESC` tiebreak — the GSO-T8 same-second lesson):
    name (original casing), descriptions, roast_type, purpose, prices as current
    prices, `image` = that snapshot's image if any (this is how existing per-cycle
    images consolidate into the one catalog image), `status = 'available'`,
    informational attributes NULL. Then backfill the links.
  - **Fuzzy tail:** groups whose key fuzzy-matches (UC-PC-002 band) a DIFFERENT
    group's key or an existing catalog row are still migrated as their own catalog
    row (resolved decision 1 — same mechanism as import) and reported under
    `fuzzy_review` for the admin to merge (UC-PC-007) or leave.
- **Field consolidation happens ONLY on the catalog row** (PM-confirmed 2026-08-22):
  merging the duplicate historical variants' fields — picture, name, descriptions,
  prices — into one identity is done by CREATING the catalog row from the newest
  snapshot (above) and, for the fuzzy tail, by the admin editing the surviving row
  after a merge (UC-PC-007/009). It is **never** expressed as writes into old
  cycles' snapshots: a snapshot keeps its historical name/description/price forever,
  even when they differ from the consolidated catalog row it links to.
- **Never mutates** snapshot names, descriptions, prices, `order_items`, or anything
  in old cycles beyond the one new column (brief §2.3 — "never delete or alter
  historical snapshots, prices, or order_items"; resolved decision 11 extends this
  to CURRENT cycles too). The bulk UPDATE writes exactly `source_coffee_product_id`.
- **Response report:** `{ summary: { groups: n, catalog_created: n, snapshots_linked:
  n, already_linked: n, fuzzy_review: n }, catalog_created: […], fuzzy_review:
  [{catalog_id, name, candidate_catalog_id, candidate_name, similarity}],
  unlinked_remaining: n }` — `unlinked_remaining` must be 0 after a run (every coffee
  snapshot groups somewhere); non-zero is a bug signal, not a state.
- Second run on a migrated DB: all rows `already_linked`, zero writes.

**Acceptance criteria:** on a DB seeded with "Pink Bourbon" in three cycles (one with
an image) + "Pink  bourbon" (case/whitespace variant) in a fourth + a bakery cycle:
one catalog row is created carrying the newest snapshot's metadata and the image, all
four snapshots link to it, bakery rows stay NULL-linked, order_items and snapshot
prices are byte-identical before/after; a second call writes nothing; a near-miss
pair lands in `fuzzy_review`; anonymous call 401s via the api-security sweep.

---

## UC-PC-007 Admin merge tool — merge catalog B into A (Admin)

**Goal:** the permanent safety valve (brief §2.3): resolve the migration's fuzzy
tail, import near-misses, and any future duplicate.

**Route contract:** `POST /api/coffee-products/:id/merge`, body `{ source_id }` —
merge catalog row `source_id` (B) INTO `:id` (A). `requireAdmin` (whole-mount).

**Business rules:**

- **404** — either id unknown. **400** — `source_id` missing/unbindable
  (`bindValue`), or `source_id == :id` (self-merge).
- **409 `field: 'roastery'`** — `A.roastery !== B.roastery`. Cross-roastery merges
  are refused unconditionally (01-architecture; brief Decision 1's scope discipline).
- **ONE `db.transaction`, exactly two writes:**
  1. `UPDATE products SET source_coffee_product_id = A.id WHERE source_coffee_product_id = B.id`
  2. `DELETE FROM coffee_products WHERE id = B.id`
- **Target wins entirely:** A's name, normalized_name, metadata, image,
  status, prices are all untouched by the merge. If B had the better image or the
  admin prefers B's name, they edit A afterwards (UC-PC-009) — the merge does one
  thing. (Merging A into B instead is the admin's choice of direction.)
- **No `transactions` row, no snapshot mutation, no order_items change** — a merge is
  a metadata repointing, never a financial or historical event (the GSO-T6 lesson).
- ⚠ **Forward seam for module 13:** when `friend_reviews(friend_id,
  coffee_product_id)` lands, a merge must repoint reviews too, with latest-wins
  dedupe on the UNIQUE pair. That write is ADDED to this same transaction **by
  module 13** — recorded here so neither module ships a merge that strands reviews
  (§Seams).
- Response: 200 `{ target: <catalog row A>, repointed_snapshots: n }`.

**Acceptance criteria:** merging B (2 linked snapshots) into A leaves A's row
byte-identical, B deleted, both snapshots linked to A, cross-cycle stats for A now
including B's history; cross-roastery attempt 409s with nothing written; self-merge
400s; unknown ids 404; importing B's sheet name into a LATER fresh cycle after the
merge fuzzy-flags or exact-matches against A (depending on the names) rather than
resurrecting B blindly.

---

## UC-PC-008 Fuzzy-duplicate review — the durable resolution surface (Admin)

**Goal:** "pending fuzzy confirmation" must survive a closed browser tab. The reports
(UC-PC-004/006) are the notification; this endpoint is the durable, **stateless,
recomputable** review queue — no pending-state table exists (resolved decision 1).

**Route contract:** `GET /api/coffee-products/duplicates` — `requireAdmin`
(whole-mount).

**Business rules:**

- Recomputes, on demand, every same-roastery catalog pair in the fuzzy band
  (UC-PC-002: `FUZZY_THRESHOLD ≤ similarity < 1`), both rows `status` ANY (a retired
  duplicate still pollutes history until merged). Response:
  `{ pairs: [{ a: {id, name, cycles_count}, b: {id, name, cycles_count},
  similarity }] }`, ordered by similarity DESC. O(n²) over ~tens of rows — free.
- Resolution semantics: the admin either **merges** (UC-PC-007 — the pair disappears
  from the next recompute because one row is gone) or **leaves the pair** (two
  genuinely different coffees with similar names). There is no "dismiss" state in
  this module — a standing false-positive pair costs one list row.
- The catalog admin view renders this list (UC-PC-009) with a merge action per pair,
  in both directions.

**Acceptance criteria:** after an import that fuzzy-flagged a row, the endpoint
returns the pair; after merging, it returns empty; two dissimilar names never appear;
anonymous 401 via the sweep.

_(If standing false positives become noisy in practice, a `dismissed_pairs` table is
the future extension — recorded, not built.)_

---

## UC-PC-009 Catalog routes + admin view (Admin)

**Goal:** the catalog is manageable in one place: list, edit metadata + image ONCE,
informational attributes, status — the headline friction win
(brief §2.5).

**Backend — new router `backend/src/routes/coffee-products.js`, mounted
`app.use('/api/coffee-products', requireAdmin, coffeeProductsRouter)`** (whole-mount
admin, like `bakery-products` — no public route lives here; module 13's friend-facing
reads are separate Bearer-guarded routes and must NOT be added under this mount):

- `GET /` — list: every catalog column plus computed `cycles_count`
  (`COUNT(DISTINCT cycle_id)` of linked snapshots) and `all_time_kg` (UC-PC-010's
  total, guests included). Query filters: `status`, `purpose`, `roastery`, `q`
  (substring over `normalized_name` via the normalization helper).
- `GET /:id` — detail: the row + availability history (which cycles offered it:
  id, name, created_at, per-cycle kg) — the per-product history primitive.
- `PATCH /:id` — admin edit: `name` (⚠ recomputes `normalized_name` via the helper
  inside the same statement flow; a rename colliding with an existing
  `(normalized_name, roastery)` ⇒ **409** `field:'name'` — the app-level check +
  constraint translation dual layer), `country`, `region`, `altitude`, `farm`,
  `variety`, `processing`, `description1`, `description2`, `roast_type`, `purpose`,
  `status` (`available`/`retired` only, else 400), `is_new`, `curator_pick_note`,
  current prices. Field-by-field `!== undefined` update pattern + `bindValue`, as
  `products.js PATCH` does.
- `POST /:id/image` — reuse the `imageFromUpload`/`imageFromBody` +
  `uploadSingle('image')` helpers verbatim (the `products.js POST /:id/image`
  pattern). This is THE image home from now on; per-cycle attaching remains possible
  on snapshots but is no longer needed.
- `POST /:id/merge` (UC-PC-007), `POST /migrate` (UC-PC-006),
  `GET /duplicates` (UC-PC-008), `GET /stats` + `GET /:id/stats` (UC-PC-010).
- **No `DELETE`** (resolved decision 9). **Retirement** (`status='retired'`) has NO
  effect on existing snapshots, orders or stats — it only signals "don't expect this
  again" in the list and to future consumers (module 13 hides retired products from
  "Objednať znova"; module 14 from curation).

**Frontend — `AdminCatalog.vue`, route `/admin/catalog` (admin nav entry "Katalóg"):**

- **Existing admin skin:** shadcn `Card`/`Dialog`/`Input`/`Button`/tables, NO
  Podpultovka theme classes, no `.app` scope, no `neo/` components (01-architecture
  scope rule). Slovak in the admin app's existing pragmatic register.
- List: image thumbnail, name, purpose, roastery, status badge
  (Dostupná/Vyradená), `cycles_count` ("Cykly"), `all_time_kg` ("Spolu kg"); filters
  mirroring the endpoint's.
- Edit dialog: metadata fields; the six informational attributes grouped under
  "Informačné atribúty" (Krajina pôvodu, Región, Nadmorská výška, Farma, Odroda,
  Spracovanie) with a hint that empty = simply not shown (brief §2.5);
  status select; image upload. Save errors render
  **in-dialog** (the module-11 `modalError` lesson — a page-level Alert hides behind
  the radix overlay).
- Duplicates section (UC-PC-008's pairs) with per-pair merge buttons + an inline
  confirm (merge is destructive-ish: it deletes a row).
- Migration trigger: a "Spustiť migráciu histórie" action rendering the UC-PC-006
  report; visible always (the endpoint is idempotent — a re-run is safe and picks up
  the unlinked tail).
- `frontend/src/api.js` gains the corresponding admin calls (standard `request()`
  with `X-Admin-Token`).
- A12 note: admin views are outside the iOS 16px input rule's scope (recorded
  residual class in CLAUDE.md); no `.inp` here — shadcn `Input` as elsewhere in admin.

**Acceptance criteria:** the list shows a migrated product with correct cycles count
and kg; editing attributes persists and re-renders; a rename colliding with another
catalog row shows an in-dialog 409;
image uploaded once appears on the NEXT cycle's import-created snapshot on the friend
order page; no theme class appears in `AdminCatalog.vue`
(`grep -E 'class=.*(\.app|\bcard\b|\bbtn\b|neo/)' `-style structural check per 02's
scoping rule — implemented as the e2e admin-skin assertion, UC-PC-011).

---

## UC-PC-010 Cross-cycle statistics (Admin)

**Goal:** the acceptance test of the whole module (brief §2.4): the questions must be
answerable with simple queries once links exist — and they power the deferred
social-proof badges and module 13's internal ranking without any further schema.

**Computation home:** `backend/src/helpers/catalog-stats.js` — exported pure
functions the admin endpoints wrap. ⚠ Module 13's recommendation ranking imports
these FUNCTIONS server-side; it must never call the admin HTTP endpoints or re-write
the SQL (§Seams).

**Conventions (all BINDING, from 01-architecture + CLAUDE.md):**

- Friend half: `order_items` JOIN `orders` (`status = 'submitted'`) JOIN `products`
  ON the item's product, keyed by `products.source_coffee_product_id` (NULL-linked
  snapshots count toward nothing). Weight authority is **`variantToKg()`**
  (`helpers/analytics.js`) — never a third variant→weight map.
- **Guest half via `guestCycleItems(cycleIds)`** (`helpers/guest-aggregation.js` —
  the existing one home; never a fifth UNION), mapped `product_id →
  source_coffee_product_id` and **merged in JavaScript, never as a JOIN** onto the
  friend query (the GSO-T6/T8 multiplied-rows trap).
- **Decision-4 discipline:** guests count in per-PRODUCT kg/value totals ONLY.
  Distinct-friend counts, repeat-buyer counts, per-friend histories NEVER include
  guests — a guest must never appear as, or inflate a count of, a friend.
- **Windowing:** `last_n_cycles=N` = the last N cycles with
  `COALESCE(type,'coffee') = 'coffee'`, ordered `created_at DESC, id DESC` (the
  GSO-T8 same-second tiebreak lesson — mandatory here, not optional). Omitted = all
  time.
- **Purpose filter:** by the CATALOG row's `purpose` (the current truth; snapshots
  may drift per cycle, and the filter must partition products stably). Values as the
  brief: Espresso / Filter / Kapsule (matching existing purpose strings).
- **Repeat buyer:** a friend with submitted order_items of that catalog product in
  **≥ 2 DISTINCT cycles** (within the window when one is given).

**Endpoints (both under the UC-PC-009 mount, `requireAdmin`):**

- `GET /api/coffee-products/stats?purpose=&last_n_cycles=` — the ranking: one row
  per catalog product with `{ catalog_id, name, purpose, total_kg (friends+guests),
  friend_kg, guest_kg, distinct_friends, repeat_buyers, cycles_offered,
  cycles_ordered }`, sortable client-side; the response also names the window it
  evaluated (`{ window: { cycle_ids: […] } }`) so the numbers are auditable.
- `GET /api/coffee-products/:id/stats` — per product: availability history
  (which cycles offered it, per-cycle kg — friend + guest split), order trend
  (per-cycle series), and the **per friend × product** table:
  `{ friend_id, name, times (count of cycles ordered in), total_kg }` — friends
  only, by construction.

**Admin UI:** a stats tab/section in `AdminCatalog.vue` (or linked from the existing
analytics tab navigation) rendering the ranking with the purpose filter and window
selector, and the per-product panel from the detail view. Chart.js only if trivially
reusing the existing analytics components; tables are sufficient for acceptance.

**Acceptance criteria (the brief's §2.4 questions, verbatim, as e2e fixtures):**
seed friend A ordering product P in 2 cycles (0.25 kg each), friend B in 1 cycle
(1 kg), one guest 1 kg, one cancelled guest 1 kg ⇒ P reports `total_kg = 2.5`,
`friend_kg = 1.5`, `guest_kg = 1.0` (cancelled excluded — the status predicate),
`distinct_friends = 2`, `repeat_buyers = 1`; windowed to the last 1 cycle the repeat
count drops accordingly; purpose filter partitions; per-friend table lists A with
`times = 2` and no guest row anywhere; availability history lists exactly the
offering cycles.

---

## UC-PC-011 Verification — e2e obligations (System)

**Goal:** how the implementing tasks prove this module correct, per the house bar
(no unit runner — Playwright e2e in `e2e/` is the bar; `node --check` on changed
backend files).

**Numbered spec obligations:**

1. **`api-security.spec.js` — `ADMIN_ENDPOINTS` grows every new admin route**
   (standing CLAUDE.md invariant; the mount is whole-mount `requireAdmin`, the sweep
   still pins each): `GET /api/coffee-products`, `GET /api/coffee-products/1`,
   `PATCH /api/coffee-products/1`, `POST /api/coffee-products/1/image`,
   `POST /api/coffee-products/1/merge`, `POST /api/coffee-products/migrate`,
   `GET /api/coffee-products/duplicates`, `GET /api/coffee-products/stats`,
   `GET /api/coffee-products/1/stats`.
2. **New `e2e/tests/catalog-import.spec.js`:** the UC-PC-003/004/005 acceptance
   criteria — exact match/link/price-change, new-row creation, fuzzy flag, **the
   frozen-cycle guard: a double-fired import 409s `cycle_not_empty` with ZERO writes
   (byte-compare the cycle's `products` rows AND the catalog before/after the
   refused call)**, in-sheet duplicate → `unparsed`, report shape contract test,
   manual-POST consolidation incl. the bakery-cycle exemption and the 409
   `duplicate_in_cycle` refusal, old-cycle freeze
   (byte-compare a prior snapshot row before/after). ⚠ **Vehicle: the CSV endpoint**
   (`POST /products/import/:cycleId`, multipart) — the two gsheet endpoints need a
   live public sheet and are not e2e-exercisable (the recorded FUP-T15 reality);
   they MUST share `consolidateRow` so CSV coverage transfers — pin that by grep-style
   structural assertion (one call site per endpoint, one definition) or accept the
   seam consciously in the spec file's comments.
3. **New `e2e/tests/catalog-admin.spec.js`:** migration (fixture DB with duplicate
   name variants across cycles → linked; idempotent second run; order_items
   untouched), merge (repoint + delete + cross-roastery 409 + self-merge 400),
   duplicates review before/after merge, catalog CRUD incl. the rename-collision
   409, the image COALESCE on the friend order page.
4. **New `e2e/tests/catalog-stats.spec.js`:** the UC-PC-010 fixture verbatim —
   including the two assertions no refactor may lose: the **cancelled guest excluded**
   and the **guest absent from every per-friend figure** (the Decision-4 pins), plus
   the JS-merge non-multiplication pin (1 friend kg + 2 × 1 guest kg = 3.0, friend
   count still per the friend half — the GSO-T8 idiom).
5. **Fixtures per test, not a shared `beforeAll`** (Playwright re-runs `beforeAll`
   after a worker failure — the GSO-T8 lesson); DB-shape tests that write rows
   directly need `DB_PATH` and self-skip without it (house convention).
6. Existing suites must pass **unchanged** — this module changes no friend/guest
   behavior except serving a catalog image where the snapshot has none (an additive
   COALESCE; `order-product-card.spec.js`'s fixture products carry snapshot images or
   none at all, so its assertions are unaffected — verify, don't assume).

**Procedure:** the CLAUDE.md local recipe verbatim — build → `backend/public`, port
3997 confirmed free (kill by the PID owning the port), fresh `DB_PATH` +
`e2e/seed.mjs`, `CORS_ORIGIN` incl. the gate's own origin, **all five** rate-limit
env vars raised, run from `e2e/` (repo root = false green "No tests found"), output
to a file never `| tail`.

---

## Seams

> ⛔ **Module 13 was DEFERRED WHOLESALE on 2026-08-22** (see its file's status banner).
> Every "module 13" seam below binds only if that module is ever un-deferred; nothing
> in this module may wait on it, and `/plan-backlog` emits rows for module 12 only.

**What module 13 consumes from this module (defined here, built there):**

- **The friend-facing catalog read shape — the DISPLAY SET ONLY:** `id`, `name`,
  `description1`, `description2`, `roast_type`, `purpose`, `country`, `region`,
  `altitude`, `farm`, `variety`, `processing`, `image`, `is_new`,
  `status`. **Never** `normalized_name`, current prices, timestamps, or any stats
  internals. 13's routes are Bearer + ownership-guarded and live OUTSIDE the
  whole-mount admin router (UC-PC-009).
- **Stats primitives:** the exported functions of `helpers/catalog-stats.js`
  (repeat-buyer ranking per purpose, windowable) — 13's recommendation ranking
  (brief §4.3) imports them server-side; never the admin HTTP endpoints, never
  re-written SQL.
- **The snapshot link itself:** `products.source_coffee_product_id` is how 13 maps a
  friend's `order_items` history and open-cycle offerings ("Objednať znova") onto
  catalog identities; NULL-linked rows are invisible to the passport — which is why
  the migration (UC-PC-006) must run before 13 ships.
- **Merge-transaction extension obligation:** when `friend_reviews` lands, module 13
  ADDS the review-repoint (latest-wins on the UNIQUE pair) into UC-PC-007's
  transaction. Recorded on both sides.
- `country` is the only informational-adjacent field that is first-class for
  stats/filtering (brief Decision 9) — it feeds 13's "krajín" counter and the future
  Svetobežník badge; parsing-from-name + admin override is 13's concern, the column
  is here.

**What the future autonomous import routine consumes (enablers only, routine not
built):** the authenticated HTTP import endpoints (the automation boundary is the
API, never the SQLite file — brief §2.6), the UC-PC-004 `report` contract
(shape-stable), and idempotency in its resolved-decision-11 form: a retried/
duplicate run hits the frozen-cycle 409 (`reason: 'cycle_not_empty'`) with zero
writes — the routine treats that answer as "already done", never as a failure.

**What stays untouched — the guarded-seams list (01-architecture, verbatim
obligations):** `helpers/stock.js` (stock counting), `helpers/pricing.js` (variant
pricing), the guest-aggregation JS-merge rules, the packing gates
(`helpers/packing.js`), `order_items` and frozen snapshot prices, the per-friend vs
cycle-level aggregate split (Decision 4), importer parsing + column mapping,
`instances: 1` + synchronous-handler concurrency (all new writes transactional, no
`await` between check and write), and bakery everything.

---

## Accepted risks / follow-ups / OPEN items

- **`FUZZY_THRESHOLD = 0.75` is a shipped default, tuned from data** (the brief's
  Decision-5 posture applied to matching). Too low = noisy review list; too high =
  missed duplicates that the duplicates view (UC-PC-008) still catches later.
- **Catalog image edits change past cycles' display** (resolved decision 5) —
  **PM-confirmed 2026-08-22**; price/order history stays immutable.
- **A botched import cannot be redone in the same cycle** (resolved decision 11's
  guard counts even soft-deleted snapshots) — the remedy is always a new cycle, per
  the PM's rule. Accepted; the 409's Slovak message names it.
- **Manual double-POST of the same name into one cycle now 409s
  (`duplicate_in_cycle`)** instead of creating a second row (UC-PC-005) — a
  deliberate behavior change; rename to genuinely duplicate.
- **The gsheet import paths are not e2e-exercisable** (live sheet required) — the
  shared `consolidateRow` is the mitigation (UC-PC-011 item 2). Residual risk: a
  divergence in how an endpoint CALLS the helper would escape the suite; keep the
  call sites trivial.
- **Report not persisted** — recomputable (`duplicates`) or visible in the catalog;
  persistence is the recorded future extension if the autonomous routine needs
  history (brief §7).
- **13 MB JSON payload from base64 images in product listings** — pre-existing
  (recorded 2026-08-20); this module's catalog-owned image is the prerequisite for
  the eventual fix (an image endpoint instead of inline base64), which is NOT done
  here.
- **`analytics.js:28` whole-series `ORDER BY created_at ASC` without an id tiebreak**
  — pre-existing recorded follow-up; UC-PC-010's own window picks carry the tiebreak,
  the old analytics module is untouched.
- **No auto-retire policy** — `status` is purely admin-curated; products absent from
  recent cycles stay `available` until the admin says otherwise. Revisit if the list
  gets noisy.

---

Sources: `docs/requirements/2026-08-18-catalog-profiles-recommendations-brief.md` (v5,
2026-08-22 — canonical; §2 Module 1, §6 Decisions 1–3/6–9, §7 data-model sketch);
`docs/specification/00-overview.md` (§Scope extension — product catalog & coffee
passport, file-index rows 12/13, glossary); `docs/specification/01-architecture.md`
(§Catalog & passport extensions — binding conventions; §Permissions & roles; §Testing
& gate; §Frontend structure module-12 additions); `backend/src/routes/products.js`
(importers + manual POST + image helpers — parsing frozen); `backend/src/routes/cycles.js:229`
(bakery snapshot precedent); `backend/src/db/schema.js` (migration house pattern,
`products` columns, `roasteries` seed); `backend/src/helpers/analytics.js`
(`variantToKg`); `backend/src/helpers/guest-aggregation.js` (`guestCycleItems`,
Decision-4 commentary); `backend/src/index.js` (mount conventions);
`docs/data-model.md`; repo `CLAUDE.md` (ADMIN_ENDPOINTS invariant, GA-T8, GSO-T6/T8,
FUP-T13, GSO-T9, IA-T3, the 2026-08-20 one-image-per-product decision). The most
recent decision wins on conflict.
