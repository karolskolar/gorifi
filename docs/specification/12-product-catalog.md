# 12 — Product catalog (consolidated coffee products, duplicate-aware import, migration, cross-cycle stats)

> Scope: The consolidated `coffee_products` catalog and everything that keeps it true:
> the schema (`coffee_products` + the single change to an existing table,
> `products.source_coffee_product_id`), the ONE exported normalization helper, the
> **unified catalog import tool in the main admin menu** (the bakery pattern, resolved
> decision 12) — a duplicate-aware consolidation layer that runs AFTER parsing, per
> row, targeting the CATALOG (cycle-independent), with a machine-readable naturally
> idempotent import report — **coffee cycle creation as a catalog picker** (snapshots
> from ticked catalog products, the bakery flow), the **retirement of the per-cycle
> import endpoints + UI**, the manual per-cycle POST (the one sanctioned
> add-to-existing-cycle exception), the historical-migration **manual assignment
> workbench** (resolved decision 14 — the shipped auto-migration is retired), the
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
> generalize the coffee catalog for it (brief Decision 6) — its own picker, tables and
> snapshot flow are untouched. **Importer parsing/column mapping** — byte-identical,
> extracted and reused, never rewritten (the TARGET moves to the catalog; the PARSING
> does not move an inch). **Autonomous import routine** — future; the
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
   (UC-PC-008). This is an
   implementation-level choice consistent with brief Decision 3 ("very-similar names
   ask for confirmation" — they do, in the report and the duplicates review; they are
   never auto-MERGED), so it is decided here, not OPEN. ~~The same mechanism resolves
   the migration's fuzzy tail~~ — superseded by decision 14: the migration has no
   fuzzy anything any more; this decision now governs the IMPORT flow only.
2. **Migration runs admin-triggered, never at boot.** The house try/catch boot
   pattern is for columns (and is used for them here); linking history is heavy,
   needs admin judgement, must be observable, and a failed boot migration would
   block startup. ~~One idempotent `POST /api/coffee-products/migrate` auto-creating
   catalog rows from exact groups + a fuzzy-review report~~ — the AUTOMATIC half of
   this decision is **superseded by decision 14** (the shipped auto-migration merged
   unrelated products on staging); the admin-triggered, never-boot half stands and
   now takes the form of the manual assignment workbench (UC-PC-006).
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
   than any per-snapshot image mechanics and wins. Picker-created snapshots keep
   `image = NULL`; read paths resolve `COALESCE(p.image, cp.image)` (UC-PC-012).
   A snapshot-level image, where present (manual upload, bakery, history), still wins.
   Consequence, stated openly: editing a catalog image changes how PAST cycles display
   that product — accepted (PM-confirmed 2026-08-22); immutability protects
   prices/order_items, not display art.
6. ~~The importer response shape is EXTENDED, never replaced.~~ **SUPERSEDED by
   decision 12:** the per-cycle importers retire wholesale (UC-PC-013), so there is
   no legacy response to stay compatible with. The NEW catalog import endpoints
   return the UC-PC-004 report directly.
7. **The multirow importer's "without transaction wrapper to avoid sql.js issues"
   comment is STALE** (SEC-D1 moved to better-sqlite3). The consolidation layer wraps
   each import's DB work in one `db.transaction` on all three format paths — required
   anyway by the GA-T8 lesson (the two gsheet routes `await` a fetch; every DB
   read/write must happen AFTER the last `await`, synchronously, or
   check-then-insert races).
8. **`is_new` is admin-edited only in this module.** Brief §4.2's "Sheet's NOVINKA
   flag → Novinka badge if present in the adapted sheet" would require a new column
   mapping — a parsing change, which is forbidden here. The column ships; sheet-driven
   capture is future work (module 14 / §5).
9. **No standalone catalog DELETE.** Lifecycle end is `status = 'retired'`; the merge
   tool is the ONLY path that deletes a catalog row (after repointing every link), so
   a dangling `source_coffee_product_id` cannot be created by this module (the GSO-T9
   dangling-pointer lesson, prevented by construction instead of tolerated).
    ⚠ **SUPERSEDED IN PART (PM 2026-08-23):** a real `DELETE /api/coffee-products/:id`
    now exists — the admin asked for it for rows imported by mistake. Retirement
    (`status='retired'`) stays available and is still the non-destructive option, and the
    merge is still the only deleter that PRESERVES history links. The delete route clears
    `products.source_coffee_product_id` for the row **inside the same transaction** (the
    GSO-T9 dangling-pointer lesson: an unlinked snapshot lands in no stats bucket, a
    dangling one is worse — it points at nothing); the affected snapshots keep every byte
    of their own data and reappear in the migration workbench. Confirmed in a modal that
    names the history cost. Pinned by the "Catalog delete" describe in
    `catalog-admin.spec.js`; the two old no-DELETE assertions were retargeted (case a).
10. **Flavor chips (auto-tag + admin override + column) DEFERRED by PM decision
    2026-08-22** — the chips risk being misleading and are skipped for v1 entirely
    (no `flavor_chips` column, no `autoTagFlavorChips`, no admin override UI).
    Re-adding later is the house try/catch ALTER pattern plus a backfill over
    `description2`; **nothing in v1 may assume the column exists.** Module 13 drops
    its chips display row in the same decision. The brief (v6 decision #10), 00-overview's
    glossary and 01-architecture's column list already record the removal.
11. **Cycles are frozen ABSOLUTELY (PM decision 2026-08-22) — the PRINCIPLE stands;
    its 409 guard is RETIRED as moot under decision 12.** The principle: nothing may
    mutate an existing cycle's products — **no in-place snapshot price updates,
    ever**; this supersedes the brief §2.2's "importing the same sheet into the same
    cycle twice = … second run reports '0 changes'" (and the `unchanged` report
    bucket that existed for it stays dropped). Under decision 12 imports never touch
    ANY cycle, so the `cycle_not_empty` 409 guard this decision originally mandated
    has nothing to guard and ships nowhere — the principle is enforced **by
    construction**: imports write the catalog only; snapshots are created only at
    cycle creation (UC-PC-012) or by the manual POST, which ADDS a new snapshot and
    never mutates an existing one (UC-PC-005). Price changes flow: import updates
    the CATALOG current price; the next cycle's picker snapshot freezes it. (The
    pre-existing admin `PATCH /api/products/:id`, which can edit a snapshot, is
    outside this module's scope — recorded in §Accepted risks.)
12. **ARCHITECTURE PIVOT (PM decision 2026-08-22, after PC-T1 shipped): "unified
    import tool in the main menu, like in the bakery."** Imports target the CATALOG
    (cycle-independent); coffee cycle creation TICKS products from the catalog (the
    bakery `AdminBakeryProducts` + cycle-creation-picker precedent,
    `routes/cycles.js:229`); the per-cycle sheet import RETIRES (UC-PC-013). This
    supersedes the brief's v2-rescope premise ("the import pipeline stays AS IS …
    existing CSV/gsheet importer endpoints unchanged") **in its TARGET only — the
    PARSING and column mapping stay byte-identical**, extracted from `products.js`
    and reused by the new catalog endpoints (UC-PC-003). Consequences: import
    idempotency becomes natural (re-import = 0 new / N matched / 0 price changes —
    no refusal needed); the report loses its cycle context; the import UI moves from
    `CycleDetail.vue` to the catalog view (UC-PC-009).
13. **Sheet-sourced catalog fields refresh on exact match; admin-only fields are
    never touched by the importer.** On an exact match the import updates
    `description1`, `description2`, `roast_type`, `purpose` (and prices per
    decision 2/11) from the sheet — only when the sheet value is **non-empty** (an
    empty cell never blanks a catalog value) and only when it **differs** (no
    write-churn). `name`, `country`, `region`, `altitude`, `farm`, `variety`,
    `processing`, `image`, `status`, `is_new`, `curator_pick_note` are NEVER written
    by an import. Consequence, stated openly: an admin edit to a sheet-sourced field
    survives only until the next import carries a non-empty value for that product —
    the sheet is the roastery's current truth for its own fields; durable admin
    curation belongs in the admin-only fields. Recorded in §Accepted risks.
14. **The AUTOMATIC migration is REPLACED by a fully MANUAL assignment workbench
    (PM decision 2026-08-23, from staging testing of the shipped PC-T1..T8).** The
    shipped `POST /api/coffee-products/migrate` auto-created catalog rows from
    exact-name groups and its fuzzy suggestions **merged unrelated products** on
    real data. The PM's replacement, verbatim: *"1. All products from the history
    will be listed. 2. I can select (checkbox) one or more old products and assign
    them the final product that already exists in the new db or create a new from
    selection of these products. 3. With each selection, old products will be
    disappearing and new products appearing."* Consequences: UC-PC-006 is rewritten
    as the workbench (pending list + assign + create-from-selection); the shipped
    `/migrate` endpoint, `helpers/catalog-migrate.js`'s auto-create/`fuzzy_review`
    flow and the AdminCatalog migration trigger + report UI are RETIRED (a rework of
    shipped code — backlog row PC-T9); **NO similarity/fuzzy math anywhere in the
    migration flow** — identical normalized names grouping into one pending row is
    identity (brief Decision 3), not a suggestion. Fuzzy similarity survives ONLY
    where it already lives: the import's `pending_fuzzy` flag (UC-PC-003) and the
    duplicates tab (UC-PC-008) — both unchanged, though the PM found
    `FUZZY_THRESHOLD = 0.75` too loose in practice on real data (recorded follow-up
    in §Accepted risks, not tuned here). This supersedes the auto-migration parts of
    decision 2 and the `fuzzy_review` surface everywhere it appeared.
15. **Product images move from inline base64 to FILES + URL strings (PM-approved
    2026-08-23, task PC-T10 — the recorded "13 MB JSON payload" follow-up).**
    Measured state: 20 catalog images ≈ 10.3 MB of base64 inline in
    `coffee_products.image`, plus historical `products.image` base64 — every
    listing response ships the full weight and nothing is browser-cacheable. The
    compatibility rationale that makes this cheap: **every frontend consumer is
    `<img :src>`** (verified — FriendOrder, CycleDetail, AdminCatalog,
    GuestProductGrid, ProductImageModal; PaymentModal's QR data-URI is unrelated),
    and `<img>` renders a URL path exactly like a data URI, so converted rows need
    ZERO frontend rendering changes; `imageFromBody` already passes plain URL/path
    strings through by design, and the `COALESCE(p.image, cp.image)` read paths are
    value-agnostic. Admin upload flows keep SENDING what they send today — the
    SERVER converts to file + URL on write. Bakery (`bakery_products`) is
    explicitly OUT (slated for removal). Details: UC-PC-014.

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

## UC-PC-003 Catalog import — duplicate-aware, cycle-independent (Admin)

**Goal (resolved decision 12):** the unified import tool. New admin endpoints on the
UC-PC-009 mount import the sheet INTO THE CATALOG — no cycle is named, touched, or
needed:

- `POST /api/coffee-products/import` — CSV upload (multipart, `uploadSingle('file')`,
  optional `roastery` field), the format of today's `products.js POST /import/:cycleId`.
- `POST /api/coffee-products/import-gsheet` — Google Sheets URL, columns-with-headers
  format (today's `/import-gsheet/:cycleId`).
- `POST /api/coffee-products/import-gsheet-multirow` — Google Sheets URL, the 3-rows-
  per-product format (today's `/import-gsheet-multirow/:cycleId`). ⚠ **KEPT, not
  dropped:** `CycleDetail.vue`'s import UI exposes a format radio defaulting to
  `'multirow'` (`gsheetFormat`, CycleDetail.vue:50) — the multirow parser IS the
  adapted-sheet flow's primary path; the plain gsheet format is the secondary live
  option. All three formats survive the pivot.

**Parsing seam — extract, never rewrite:** the parsing/column-mapping code moves
VERBATIM out of `products.js` into `backend/src/helpers/import-parsing.js`: the CSV
column-mapping loop (name/desc/roast/purpose aliases + `parsePrice`), the gsheet
URL→CSV resolution (sheet-id/gid extraction + `safeFetch`), and
`parseMultiRowProducts` with its helpers (`isSeparatorRow`, `isProductSectionHeader`,
`parsePriceString`). The new endpoints are the consumers; after UC-PC-013 retires the
old routes the helper is the parser's ONLY home. Byte-identical means **moved, not
reimplemented** — the diff of the parsing functions must be pure relocation. The new
routes also carry over the old routes' hostile-input guards, which are e2e-pinned and
must survive the retargeting (UC-PC-013): the FUP-T12 `typeof url !== 'string'` 400,
the FUP-T15 `bindValue(req.body.roastery)`, and the FUP-T13 discipline on any new
body field.

**Per parsed row, `consolidateCatalogRow(parsedRow, roastery)`** (one exported
function — suggested home `helpers/catalog-import.js`; note the shipped PC-T1
`helpers/catalog.js` keeps exactly its UC-PC-002 exports):

1. **Normalize:** `key = normalizeProductName(row.name)`; `r = normalizeRoastery(roastery)`.
   `key === ''` ⇒ the row is skipped exactly as today's `if (name)` does, and counted
   in the report's `unparsed` (new observability, no parsing change).
2. **Exact match** (`coffee_products WHERE normalized_name = key AND roastery = r`) ⇒
   count as `matched` and refresh the catalog row per **resolved decision 13**:
   - **Price auto-apply** (brief Decision 2): for every price field the sheet
     supplies (non-NULL after the existing `parsePrice`), if it differs from the
     catalog's current price, UPDATE it and report `{catalog_id, name, field, old,
     new}` under `price_changes`. Fields the sheet does not supply stay untouched.
     The snapshot half of the price flow happens later, at cycle creation
     (UC-PC-012) — an import can never move a price inside any cycle.
   - **Sheet-sourced metadata refresh:** `description1`, `description2`,
     `roast_type`, `purpose` — updated only when the sheet value is non-empty AND
     differs (decision 13). Admin-only fields are never written.
3. **No exact match ⇒ fuzzy scan:** compute `nameSimilarity(key, candidate)` over
   the same-roastery catalog rows; collect candidates in the fuzzy band, best first.
4. **Create catalog row** (whether or not fuzzy candidates exist — resolved
   decision 1): `name` = the sheet name (original casing), `normalized_name = key`,
   `roastery = r`, descriptions/roast/purpose/prices from the parsed row,
   `status = 'available'`, `image = NULL`, informational attributes NULL (never from
   the importer). Report under `new` with `needs_image: true`; when fuzzy candidates
   existed, ALSO report under `pending_fuzzy` as
   `{catalog_id, name, candidate_catalog_id, candidate_name, similarity}` — the
   "Je to premenovaný X?" question. The new row is **not** linked to the candidate;
   the admin merges via UC-PC-007 or leaves it as genuinely new.
5. **In-sheet duplicate:** a later row in the SAME sheet resolving to a catalog id
   this run already processed is skipped and reported under `unparsed` with reason
   `duplicate row in sheet` — nothing is silently dropped.

**Cross-cutting rules:**

6. **Idempotent naturally (resolved decision 12):** re-importing the same sheet =
   every row exact-matches with nothing to refresh ⇒ `0 new / N matched /
   0 price_changes / 0 pending_fuzzy`. The future autonomous routine's retry case is
   harmless by construction — no guard, no refusal, no special casing.
7. **One synchronous transaction per import.** All catalog lookups + writes run
   inside one `db.transaction`, entered only AFTER the last `await` on the gsheet
   paths (the GA-T8 lesson: an `await` between a uniqueness check and its INSERT
   breaks the `instances: 1` atomicity assumption). Dual-layer: the in-transaction
   check is load-bearing today; a `SQLITE_CONSTRAINT` on `coffee_products` (match
   `code.startsWith('SQLITE_CONSTRAINT')` PLUS the exact
   `UNIQUE constraint failed: coffee_products.normalized_name` message, never a bare
   `/UNIQUE/i`) is additionally translated to the exact-match path's behavior, for
   the PM2-cluster scenario.
8. **No cycle is ever touched** (resolved decisions 11+12): the import writes
   `coffee_products` rows and nothing else — no `products` row, no `order_cycles`
   read beyond none at all. This is the frozen-cycles principle enforced by
   construction, and it is asserted, not assumed (acceptance below).
9. Matching stays within-roastery (resolved decision 3) — Goriffee-only by
   construction for the Goriffee sheet.

**Acceptance criteria:** importing a CSV with one known product (exact normalized
match, different price + changed description) and one unknown product yields:
1 matched with the catalog price updated + reported old→new and the description
refreshed, 1 new catalog row (`needs_image: true`); the `products` table is
**byte-identical before/after the import** (the no-cycle-touch pin); re-importing
the same CSV reports `0 new / 2 matched / 0 price_changes` and writes nothing
(byte-compare the catalog rows' `updated_at` too); a near-miss name ("Pink Bourbon
Honey" vs existing "Pink Bourbon") creates a new catalog row AND a `pending_fuzzy`
entry naming the candidate; an admin-edited `country` survives any import; a
non-string gsheet `url` 400s without echoing a stack (the FUP-T12 pin, carried
over).

---

## UC-PC-004 Import report — the machine-readable contract (Admin / future routine)

**Goal:** every import (and the manual POST, UC-PC-005) returns a JSON report that a
human reads rendered and a future autonomous routine consumes raw. **The shape is a
contract** — changing it later is a breaking change to the routine (brief §2.6).

**Response rule (resolved decision 12 — decision 6 is superseded):** the three NEW
catalog import endpoints (UC-PC-003) return the report directly as their 201 body.
There is no legacy `{message, products}` compatibility layer — those keys belonged
to the retired per-cycle endpoints (UC-PC-013). The report carries **no cycle
context of any kind** (no `cycle_id`, no snapshot ids — an import creates no
snapshots); multirow parser `warnings` fold into `unparsed`:

```json
{
  "report": {
    "summary": { "new": 1, "matched": 3, "price_changes": 2,
                 "pending_fuzzy": 1, "unparsed": 0 },
    "new":           [{ "catalog_id": 41, "name": "…", "needs_image": true }],
    "matched":       [{ "catalog_id": 7,  "name": "…" }],
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

- Category semantics (fixed vocabulary): `new` = catalog row created;
  `matched` = exact match found (prices/metadata refreshed as needed per
  decision 13); `price_changes` = one entry per (catalog row, price field) whose
  catalog current price changed; `pending_fuzzy` = a `new` row with a same-roastery
  near-miss candidate (subset of `new`, cross-referenced by `catalog_id`);
  `unparsed` = rows the existing parser skipped (no name), in-sheet duplicates
  (UC-PC-003 rule 5), or rows that produced multirow parser `warnings` — **nothing
  is silently guessed or dropped** (brief §2.2). There is deliberately NO
  `unchanged` bucket (resolved decision 11's supersession stands) and NO
  `product_id` anywhere — imports do not create snapshots.
- **"0 changes" is a natural report state again** (resolved decision 12): a
  re-import of the same sheet reports `0 new / N matched / 0 price_changes /
  0 pending_fuzzy` having written nothing. The future autonomous routine needs no
  special retry handling.
- The report is **returned, not persisted** (brief §7: "persist later if the
  autonomous routine needs history"). Loss is harmless: `pending_fuzzy` is
  recomputable via UC-PC-008, everything else is visible in the catalog.
- Rendering: the CATALOG view's import UI (UC-PC-009 — moved there from
  `CycleDetail.vue`) renders `report.summary` as the headline ("X nových /
  Y existujúcich / Z zmien cien" — the brief's success metric) with the detail
  lists expandable; each `pending_fuzzy` entry renders "Je to premenovaný
  {candidate_name}?" with a link/button into the merge flow (UC-PC-007/009).

**Acceptance criteria:** the JSON shape above is asserted key-for-key in e2e (a
contract test — extra keys allowed, listed keys stable, `product_id` asserted
ABSENT); the second identical import reports the 0-changes state; an import with a
skipped nameless row reports it under `unparsed` with a reason.

---

## UC-PC-005 Manual product POST — the one sanctioned add-to-existing-cycle path (Admin)

**Goal:** `POST /api/products` (manual per-cycle product entry) joins the
consolidation so a hand-entered coffee cannot silently bypass the catalog.

**Decision (re-examined under the pivot, 2026-08-22): the manual POST is KEPT** —
not retired into "add to catalog only". Justification: the real workflow it serves
is mid-cycle — the roastery offers an extra product after the cycle opened, or the
admin forgot to tick one in the picker; without it the only remedy would be
recreating the cycle, destroying submitted orders. It does not violate the
frozen-cycles principle (resolved decision 11): it **ADDS a new snapshot** to an
open cycle and never mutates an existing one. It stays the ONE sanctioned exception,
and everything it creates is catalog-consolidated. Not OPEN — the trade-off is
implementation-level, and both the picker (miss-proof at creation) and this
(recoverable after creation) are needed.

**Business rules (consistent with UC-PC-003):**

- For a coffee-cycle row the route calls the SAME `consolidateCatalogRow` for the
  catalog half — exact match ⇒ link (and the manual price, being a current sell
  price, updates the catalog current price exactly like an imported one); no match
  ⇒ create catalog row; fuzzy near-miss ⇒ create-as-new-but-flagged — and then
  INSERTs the snapshot as today PLUS `source_coffee_product_id`. The 201 response
  keeps returning the created snapshot row (byte-compatible — this endpoint
  survives, so its consumers matter) and gains the same `report` object with
  exactly one row accounted for.
- **Coffee-row detection:** the manual POST can create bakery-shaped rows too
  (bakery snapshots normally come from cycle creation, but the endpoint is generic).
  Consolidation runs when the target cycle's `COALESCE(type,'coffee') = 'coffee'`;
  bakery-cycle rows are never consolidated and never touch `coffee_products`
  (brief Decision 6).
- A manual POST with an uploaded/body image stores it on the SNAPSHOT (existing
  behavior, unchanged) — it wins the UC-PC-012 COALESCE; when the row also CREATED a
  catalog entry, the image is additionally stored on the new catalog row (so the next
  cycle reuses it — the friction win).
- FUP-T13 `bindValue` treatment of existing fields is untouched; the existing
  `cycle_id`/`name` 400 still fires first.
- **Duplicate guard:** a POST whose exact match already
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

## UC-PC-006 Historical migration — the manual assignment workbench (Admin)

**Goal (resolved decision 14 — REWORK of the shipped PC-T4 auto-migration):** all
historical coffee snapshots get catalog links, so statistics count from day one
(brief goal (c)) — but every grouping-to-catalog decision is the ADMIN's, made in a
workbench: a pending list the admin drains by either assigning old products to an
existing catalog product or creating a new catalog product from a selection. **No
similarity/fuzzy math anywhere in this flow.** Grouping identical
`(normalized_name, roastery)` keys into one pending row is NOT a suggestion — it is
identity (brief Decision 3, the same key the UNIQUE constraint enforces).

**Shared definitions:**

- **Unlinked candidate set** (unchanged predicate, the PC-T4 one): `products` rows
  whose owning cycle has `COALESCE(order_cycles.type,'coffee') = 'coffee'`, with
  `source_bakery_product_id IS NULL` AND `source_coffee_product_id IS NULL`. Under
  the pivot every NEW snapshot is born linked (picker UC-PC-012, manual POST
  UC-PC-005), so this set only shrinks — the workbench drains it to empty and it
  stays empty.
- **Group key:** `{ normalized_name, roastery }` — roastery carried PER ENTRY, so a
  key is unambiguous even if two roasteries ever share a name. `roastery` is the
  normalized value (`normalizeRoastery`, NULL ⇒ default).
- **Newest snapshot of a selection:** highest `cycle_id`, `id DESC` tiebreak (the
  GSO-T8 same-second lesson) — the strictly-newest rule, unchanged from PC-T4.

**Endpoint 1 — `GET /api/coffee-products/migration/pending`** (whole-mount
`requireAdmin`):

- One row per DISTINCT group key among the unlinked candidate set:

  ```json
  { "pending": [{
      "normalized_name": "pink bourbon",
      "roastery": "Goriffee",
      "display_name": "Pink Bourbon",        // name of the group's newest snapshot
      "snapshots": 4,                          // unlinked rows in the group
      "cycles": 3,                             // COUNT(DISTINCT cycle_id)
      "newest_cycle": { "id": 41, "name": "August 2026", "created_at": "…" },
      "purpose": "Filter",                    // from the newest snapshot
      "roast_type": "Light roast"             // from the newest snapshot
  }], "pending_count": 17 }
  ```

- Ordered by `display_name` (locale-insensitive over the normalized key). No
  similarity column, no candidate suggestions — deliberately (decision 14).

**Endpoint 2 — `POST /api/coffee-products/migration/assign`** — body
`{ groups: [{ normalized_name, roastery }...], catalog_id }`:

- **404** unknown `catalog_id`; **400** `groups` missing/empty/malformed (each entry
  needs both strings; `bindValue`-hygiene on every field).
- **409 `field:'roastery'`** when ANY group's roastery differs from the catalog
  row's (the UC-PC-007 merge-tool precedent — cross-roastery identity is never
  crossed).
- **ONE `db.transaction`** (synchronous, no `await`): for each group, bulk
  `UPDATE products SET source_coffee_product_id = :catalog_id` over the group's
  unlinked candidate rows. **The only write is the link column** — the PC-T4
  data-safety invariant stands verbatim: never a snapshot name/description/price,
  never `order_items`, never anything in any cycle beyond the one column.
- **Raced/empty group ⇒ skip-and-report, never 404** (decision, per the module's
  convergence conventions — the GSO-T5 "DELETE converges on the requested end
  state" precedent): group keys are DERIVED, not stored, so "never existed" and
  "already resolved by a parallel action" are indistinguishable; the requested end
  state (those snapshots linked/absent from pending) already holds. Reported as
  `skipped: [{normalized_name, roastery, reason: 'no_unlinked_rows'}]`.
- **200 response:** `{ linked_snapshots: n, groups_linked: n, skipped: […],
  pending_count: n }` — `pending_count` recomputed after the write so the UI drops
  rows without a full reload (the PM's step 3: "old products will be disappearing").

**Endpoint 3 — `POST /api/coffee-products/migration/create`** — body
`{ groups: [{ normalized_name, roastery }...] }`:

- **400** empty/malformed selection, or when the selection resolves to ZERO unlinked
  snapshots (nothing to create from — and this is also the convergence guard: a
  double-fired create finds its groups already linked and 400s instead of minting a
  duplicate catalog row).
- **409 `field:'roastery'`** when the selection spans two roasteries (one catalog
  row has one roastery).
- **ONE `db.transaction`:** create ONE catalog row from the **newest snapshot across
  the whole selection** (the strictly-newest rule): name (original casing) +
  recomputed `normalized_name`, roastery, `description1/2`, `roast_type`, `purpose`,
  prices as current prices, `image` = that snapshot's image if any (how per-cycle
  images consolidate into the one catalog image), `status='available'`,
  informational attributes NULL (decision-13 field mapping — admin-only fields are
  born empty). Then link ALL selected groups' unlinked snapshots to it.
- **NOT funnelled through `consolidateCatalogRow`** (decision, justified): the
  import helper's semantics are match-or-create with fuzzy flagging and decision-13
  refresh — here the admin's intent is CREATE, unconditionally, with fuzzy banned
  (decision 14), so a funnel would silently convert "create new" into
  "match-and-refresh". One-home discipline is kept where it matters: the creator
  uses `normalizeProductName`/`normalizeRoastery` (UC-PC-002) and the same
  `SQLITE_CONSTRAINT` dual layer — a new row whose key collides with an EXISTING
  catalog row is a clean **409** `field:'name'` carrying the existing
  `catalog_id`, so the UI can offer "Priradiť k existujúcemu" instead (assign is
  the right verb there, and the admin just learned why).
- **201 response:** `{ catalog: <row>, linked_snapshots: n, skipped: […],
  pending_count: n }` (the PM's "new products appearing" — the UI adds the row to
  the catalog list from this payload).

**Cross-cutting rules:**

- **Field consolidation happens ONLY on the catalog row** (PM-confirmed
  2026-08-22, unchanged): the created row carries the newest snapshot's fields;
  further consolidation is the admin editing that row (UC-PC-009). Never expressed
  as writes into old cycles' snapshots — a snapshot keeps its historical
  name/description/price forever, even when they differ from the catalog row it
  links to.
- **Retired with this rework (PC-T9):** `POST /api/coffee-products/migrate` (404
  after removal), `helpers/catalog-migrate.js`'s auto-create/`fuzzy_review` flow
  (the file is removed or gutted to shared query helpers the workbench reuses —
  implementer's call, but no auto-create path may survive anywhere), and the
  AdminCatalog migration trigger + report UI (UC-PC-009 gains the workbench
  instead). `ADMIN_ENDPOINTS` updated per UC-PC-011.

**Acceptance criteria:** on a DB seeded with "Pink Bourbon" ×3 cycles (one with an
image) + "Pink  bourbon" (whitespace variant) + "Pink Bourbon Honey" + a bakery
cycle: pending lists exactly TWO rows (`pink bourbon` — 4 snapshots incl. the
variant, `pink bourbon honey`) and no bakery row, each with newest-cycle metadata;
NO similarity/candidate field appears anywhere in the payload; `create` on the
`pink bourbon` selection makes one catalog row with the newest snapshot's metadata +
image and links all 4, pending drops to 1 with `pending_count` in the response;
`assign` of `pink bourbon honey` to an existing catalog product links its snapshots
(only-write pin: `order_items` and all snapshot columns except the link
byte-identical before/after); re-firing the same `assign` returns the group under
`skipped`; re-firing the same `create` 400s (no duplicate catalog row); a
cross-roastery assign 409s; `create` colliding with an existing key 409s naming the
existing `catalog_id`; `POST /api/coffee-products/migrate` answers 404; anonymous
calls on all three new routes 401 via the sweep.

---

## UC-PC-007 Admin merge tool — merge catalog B into A (Admin)

**Goal:** the permanent safety valve (brief §2.3): resolve import near-misses,
workbench mistakes (two catalog rows created that turn out to be one product), and
any future duplicate.

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
400s; unknown ids 404; a later catalog import carrying B's sheet name after the
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

**Goal:** the catalog is manageable in one place — the "unified import tool in the
main menu" (resolved decision 12): import, list, edit metadata + image ONCE,
informational attributes, status, duplicates, migration — the headline friction win
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
  on snapshots but is no longer needed. **From PC-T10 the stored VALUE is a file
  URL, not base64** — UC-PC-014 owns the storage mechanics; this route's request
  contract is unchanged.
- `POST /import`, `POST /import-gsheet`, `POST /import-gsheet-multirow`
  (UC-PC-003 — the catalog import), `POST /:id/merge` (UC-PC-007),
  `GET /migration/pending` + `POST /migration/assign` + `POST /migration/create`
  (UC-PC-006 — the workbench; the shipped `POST /migrate` is RETIRED per resolved
  decision 14), `GET /duplicates` (UC-PC-008),
  `GET /stats` + `GET /:id/stats` (UC-PC-010).
- **No `DELETE`** (resolved decision 9). **Retirement** (`status='retired'`) has NO
  effect on existing snapshots, orders or stats — it only signals "don't expect this
  again" in the list and to future consumers (module 13 hides retired products from
  "Objednať znova"; module 14 from curation).

**Frontend — `AdminCatalog.vue`, route `/admin/catalog` (admin nav entry "Katalóg"):**

- **Existing admin skin:** shadcn `Card`/`Dialog`/`Input`/`Button`/tables, NO
  Podpultovka theme classes, no `.app` scope, no `neo/` components (01-architecture
  scope rule). Slovak in the admin app's existing pragmatic register.
- **Import section (moved here from `CycleDetail.vue` — resolved decision 12):**
  CSV file upload + Google Sheets URL with the format radio (simple / multirow,
  default multirow — the shipped `gsheetFormat` behavior carries over) and the
  roastery selector, calling the UC-PC-003 endpoints; renders the UC-PC-004 report
  (summary headline, expandable detail lists, `pending_fuzzy` → merge-flow links).
- List: image thumbnail, name, purpose, roastery, status badge
  (Dostupná/Vyradená), `cycles_count` ("Cykly"), `all_time_kg` ("Spolu kg"); filters
  mirroring the endpoint's. **"Needs image" affordance:** a product with
  `image IS NULL` shows an amber "Chýba fotka" badge and the list offers a
  chýba-fotka filter — the report's `needs_image` flag made durable (the admin's
  post-import to-do list survives the report).
- Edit dialog: metadata fields; the six informational attributes grouped under
  "Informačné atribúty" (Krajina pôvodu, Región, Nadmorská výška, Farma, Odroda,
  Spracovanie) with a hint that empty = simply not shown (brief §2.5);
  status select; image upload. Save errors render
  **in-dialog** (the module-11 `modalError` lesson — a page-level Alert hides behind
  the radix overlay).
- Duplicates section (UC-PC-008's pairs) with per-pair merge buttons + an inline
  confirm (merge is destructive-ish: it deletes a row).
- **Migration workbench (replaces the shipped "Spustiť migráciu histórie" trigger +
  report — resolved decision 14):** a table of UC-PC-006 pending rows (display
  name, roastery, snapshots count, cycles count, newest cycle, purpose/roast) with
  **checkboxes** and two bulk actions on the selection: **"Priradiť k existujúcemu"**
  (opens a searchable catalog picker → `POST /migration/assign`) and **"Vytvoriť
  nový produkt z výberu"** (→ `POST /migration/create`). Resolved rows disappear
  from the table using the response's `pending_count`/payload (no full reload — the
  PM's step 3), and a `create` appends its new row to the catalog list. The
  create-collision 409 (`field:'name'` + existing `catalog_id`) renders in-context
  offering assign instead. Empty state: **"História je zmigrovaná."** No
  similarity hints, no suggested candidates — the picker is search, not suggestion.
- `frontend/src/api.js` gains the corresponding admin calls (standard `request()`
  with `X-Admin-Token`).
- A12 note: admin views are outside the iOS 16px input rule's scope (recorded
  residual class in CLAUDE.md); no `.inp` here — shadcn `Input` as elsewhere in admin.

**Acceptance criteria:** the list shows a migrated product with correct cycles count
and kg; a CSV import from this view renders the report with the merge link on a
fuzzy entry; a NULL-image product carries "Chýba fotka" and the filter finds it;
editing attributes persists and re-renders; a rename colliding with another
catalog row shows an in-dialog 409;
image uploaded once appears on the NEXT cycle's picker-created snapshot on the friend
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
   `POST /api/coffee-products/1/merge`,
   `GET /api/coffee-products/duplicates`, `GET /api/coffee-products/stats`,
   `GET /api/coffee-products/1/stats`, **plus the pivot's import routes**
   `POST /api/coffee-products/import`, `POST /api/coffee-products/import-gsheet`,
   `POST /api/coffee-products/import-gsheet-multirow` (UC-PC-003), **plus the
   workbench routes (PC-T9)** `GET /api/coffee-products/migration/pending`,
   `POST /api/coffee-products/migration/assign`,
   `POST /api/coffee-products/migration/create` (UC-PC-006), **plus PC-T10's
   conversion route** `POST /api/coffee-products/convert-images` (UC-PC-014).
   ⚠ `GET /api/images/:filename` is **deliberately NOT added** — it is a public
   read (friend and guest pages render it; exposure equivalent to the already-
   public products listing, UC-PC-014) — do not "fix" it into the sweep. PC-T9 also
   **REMOVES** the shipped `POST /api/coffee-products/migrate` row from
   `ADMIN_ENDPOINTS` — the route retires (resolved decision 14), so its
   anonymous-401 pin retires with it, in the same change. The RETIRED
   per-cycle routes (`/api/products/import*/:cycleId`) had **no existing
   `ADMIN_ENDPOINTS` rows to remove** (verified 2026-08-22: `api-security.spec.js`
   carried no `/api/products` import entry).
2. **`e2e/tests/catalog-import.spec.js`** (shipped in PC-T5): the UC-PC-003/004/005 acceptance
   criteria — exact match/price-change/metadata-refresh, new-row creation, fuzzy
   flag, **natural idempotency: the second identical import reports 0 new /
   N matched / 0 price_changes and writes nothing (byte-compare the catalog rows)**,
   **the no-cycle-touch pin: the `products` table byte-identical before/after any
   import**, the admin-only-field survival (an edited `country` outlives an import),
   in-sheet duplicate → `unparsed`, report shape contract test (`product_id`
   asserted absent), manual-POST consolidation incl. the bakery-cycle exemption and
   the 409 `duplicate_in_cycle` refusal. ⚠ **Vehicle: the CSV endpoint**
   (`POST /api/coffee-products/import`, multipart) — the two gsheet endpoints need a
   live public sheet and are not e2e-exercisable (the recorded FUP-T15 reality);
   all three MUST share `consolidateCatalogRow` + the extracted parser so CSV
   coverage transfers — pin that by grep-style structural assertion (one call site
   per endpoint, one definition) or accept the seam consciously in the spec file's
   comments.
3. **`e2e/tests/catalog-admin.spec.js`** (shipped in PC-T4..T8): merge (repoint +
   delete + cross-roastery 409 + self-merge 400), duplicates review before/after
   merge, catalog CRUD incl. the rename-collision 409, the "Chýba fotka"
   affordance, the image COALESCE on the friend order page, and **the
   cycle-creation picker** (UC-PC-012) — all UNTOUCHED by PC-T9.
   **Its migration half is REWRITTEN with PC-T9** (sanctioned under case (a) of the
   e2e-immutability rule — resolved decision 14 mandates the behavior change; cite
   UC-PC-006 in a comment). Tests that retire WITH the `/migrate` endpoint,
   enumerated from the shipped file:
   - `:196` "anonymous POST /api/coffee-products/migrate is 401" — replaced by
     anonymous-401 pins on the three workbench routes (item 1's sweep covers them
     too; the old route instead gets a **404-after-retirement** assertion).
   - `:210/:302/:330/:369` (grouping, newest-snapshot creation, id-DESC tiebreak,
     exact-match backfill, per-roastery groups), `:397` (byte-identical apart from
     the link), `:449` (idempotent second run), `:507` (`fuzzy_review`) and `:778`
     ("a /migrate re-run links a still-unlinked snapshot to the SURVIVOR").
   Their protected PROPERTIES survive, re-pointed at the workbench: the
   newest-pick rule, the roastery split, the only-write/byte-identical pin and the
   convergence pins all re-assert against `pending`/`assign`/`create` (UC-PC-006
   acceptance criteria). The two decision-14 REMOVALS — auto-creation and
   `fuzzy_review` — do not transfer; instead their absence is asserted (no
   similarity field in any workbench payload, no catalog row created by anything
   but an explicit `create`). The `:778` seam becomes: after a merge, `pending` still lists the
   unlinked group and `assign` links it to the survivor. New workbench UI tests
   cover the checkbox table, both bulk actions, rows disappearing without reload,
   the create-collision 409 → assign hand-off, and the "História je zmigrovaná."
   empty state. (The retired "Spustiť migráciu histórie" trigger has no UI e2e pin
   — verified 2026-08-23, the string exists only in `AdminCatalog.vue` — so no
   further spec retargeting.)
4. **Retargeting of pipeline-authored specs pinned to the RETIRED routes
   (UC-PC-013)** — case (a) of the e2e-immutability rule (module 03 §UC-FL-013):
   each edit re-points the assertion at the new route protecting the SAME property,
   citing UC-PC-013 in a comment:
   - `e2e/tests/image-upload.spec.js:126/191/348` — uses
     `POST /api/products/import/:cycleId` as a multipart vehicle; retarget to
     `POST /api/coffee-products/import`.
   - `e2e/tests/nonstring-body-shape.spec.js:862/878` (FUP-T12 non-string `url` +
     FUP-T15 `roastery` bindValue on both gsheet routes) and `:2804` (T15.14, the
     CSV route's `roastery`) — retarget to the three new catalog routes; the guards
     they pin are mandatory on the new routes (UC-PC-003 parsing seam).
   All other pre-existing specs must pass **unchanged**.
5. **`e2e/tests/catalog-stats.spec.js`** (shipped): the UC-PC-010 fixture verbatim —
   including the two assertions no refactor may lose: the **cancelled guest excluded**
   and the **guest absent from every per-friend figure** (the Decision-4 pins), plus
   the JS-merge non-multiplication pin (1 friend kg + 2 × 1 guest kg = 3.0, friend
   count still per the friend half — the GSO-T8 idiom).
6. **New `e2e/tests/catalog-images.spec.js` (PC-T10, UC-PC-014):** the
   upload→file→URL→served roundtrip incl. the immutable cache header and
   content-type; same-bytes dedupe + different-bytes new-URL (cache busting);
   filename-regex 404s (traversal-shaped names included); conversion idempotency
   (`converted = 0` on the second run) + `bytes_freed`; the payload pin — after
   conversion neither `GET /api/products/cycle/:id` nor the guest listing body
   contains `data:image`, and both still render via the COALESCE with URL values;
   bakery base64 untouched; anonymous `GET /api/images/…` 200 vs anonymous
   `POST /convert-images` 401. Uploads land next to the test `DB_PATH`, so no
   fixture cleanup problem arises.
7. **Fixtures per test, not a shared `beforeAll`** (Playwright re-runs `beforeAll`
   after a worker failure — the GSO-T8 lesson); DB-shape tests that write rows
   directly need `DB_PATH` and self-skip without it (house convention).
8. Existing suites (beyond item 4's enumerated retargets) must pass **unchanged** —
   this module changes no friend/guest behavior except serving a catalog image where
   the snapshot has none (an additive COALESCE;
   `order-product-card.spec.js`'s fixture products carry snapshot images or
   none at all, so its assertions are unaffected — verify, don't assume) and, from
   PC-T10, `image` values being URL paths instead of data URIs — rendering-
   equivalent for `<img :src>` (decision 15), but any spec that asserts a `data:`
   prefix on a COFFEE image must be checked (the product-photo specs use fixture
   uploads, which now come back as URLs — verify, don't assume). ⚠ Seeded
   admin flows that create coffee cycles (`e2e/seed.mjs`, cycle-creating helpers in
   existing specs) must be checked against UC-PC-012: `coffee_product_ids` is
   OPTIONAL on cycle creation precisely so an id-less `POST /api/cycles` keeps
   working and those fixtures stay untouched.

**Procedure:** the CLAUDE.md local recipe verbatim — build → `backend/public`, port
3997 confirmed free (kill by the PID owning the port), fresh `DB_PATH` +
`e2e/seed.mjs`, `CORS_ORIGIN` incl. the gate's own origin, **all five** rate-limit
env vars raised, run from `e2e/` (repo root = false green "No tests found"), output
to a file never `| tail`.

---

## UC-PC-012 Cycle creation from the catalog picker (Admin)

**Goal (resolved decision 12):** coffee cycle creation gains "select products" — the
bakery flow (`routes/cycles.js:229`) applied to the coffee catalog. This is where
snapshots come from once the per-cycle import retires.

**Business rules:**

- **Backend — `POST /api/cycles` gains `coffee_product_ids`** (array, optional),
  honoured only when the cycle's type resolves to `'coffee'` — the exact parallel of
  the existing `bakery_product_ids` branch, including its element hygiene: the array
  is `Array.isArray`-gated and each element goes through `bindValue`
  (the FUP-T13 lesson recorded on the bakery loop: "the ARRAY was checked, its
  ELEMENTS never were"). **Optional on purpose:** an id-less coffee-cycle POST keeps
  today's behavior (empty cycle; the manual POST can populate it) — existing e2e
  fixtures and any scripted cycle creation stay valid.
- **Per selected id, inside the existing creation flow:** load the catalog row with
  `status = 'available'`; a missing or **retired** row is skipped exactly as the
  bakery loop's `if (!bp) continue` skips inactive products — retired catalog
  products can never enter a new cycle, even by hand-crafted request. INSERT one
  `products` snapshot row: `cycle_id`, `name`, `description1`, `description2`,
  `roast_type`, `purpose`, `roastery`, all six price fields **copied from the
  catalog's current prices — this is the freeze moment** (resolved decision 11's
  price flow: import moves the catalog price, the picker freezes it into the cycle),
  `source_coffee_product_id = catalog.id`, `image = NULL` (resolved decision 5 —
  rule below carries the image), `stock_limit_g = NULL` (per-cycle, admin sets it
  later via the existing snapshot PATCH). Later catalog edits do NOT touch existing
  snapshots — the freeze is one-way.
- **NO junction table (decision, justified against the bakery precedent):**
  `source_coffee_product_id` alone is the selection record. Bakery needs
  `cycle_bakery_products` because its variant explosion snapshots N `products` rows
  per selected product, so a per-PRODUCT selection record has no 1:1 snapshot row to
  live on; a coffee catalog product snapshots to exactly ONE row per cycle (variants
  are price columns), so the snapshot row IS the selection record and a junction
  would duplicate derivable state. Simpler shape wins; nothing in UC-PC-010's stats
  needs more than the link.
- **Image fallback on the snapshot read paths** (moved here from the pre-pivot
  import UC — the rule is about who READS snapshots, not who creates them):
  snapshot list/detail reads serve `COALESCE(p.image, cp.image) AS image` via
  `LEFT JOIN coffee_products cp ON cp.id = p.source_coffee_product_id`. Response
  shapes unchanged (still an `image` field). Enumerated call sites:
  `products.js GET /cycle/:cycleId`, `products.js GET /:id`, and the guest product
  listing in `routes/guest.js` (read-only column change on the hostile-boundary
  route — nothing about its gates, bounds or pricing moves); the implementer must
  sweep for any other snapshot read serving `image`. A non-NULL snapshot image
  (manual upload, bakery, history) still wins the COALESCE.
- **UI — the existing new-cycle dialog in `AdminDashboard.vue`** (where the bakery
  picker already lives): a coffee-type cycle shows the catalog product list with
  checkboxes — **default: all `status='available'` products pre-ticked, the admin
  unticks** (the brief's paste-and-go effort target, inverted into tick-and-go);
  retired products are not listed at all. Admin skin, existing dialog conventions;
  Slovak labels in the admin app's register. `api.js createCycle` already forwards
  arbitrary body fields (`typeof data === 'string'` legacy form aside), so the
  picker needs no API-client change beyond the dashboard passing
  `coffee_product_ids`.
- The creation flow's existing pieces (total_friends snapshot, status/type
  handling, bakery branch) are byte-untouched; the coffee branch is a sibling of
  the bakery branch, never a rewrite of it.

**Acceptance criteria:** creating a coffee cycle with 2 ticked products yields 2
`products` rows linked via `source_coffee_product_id`, prices equal to the catalog's
at creation time; a later catalog price edit leaves those snapshots byte-identical
(the freeze pin); a retired id in the request is skipped and produces no row; a
coffee-cycle POST without `coffee_product_ids` still creates the (empty) cycle; the
friend order page lists the picked products with the catalog image (COALESCE); the
new-cycle dialog pre-ticks all available products and unticking one keeps it out of
the cycle.

---

## UC-PC-013 Retire the per-cycle import (Admin / System)

**Goal (resolved decision 12):** once UC-PC-003 (catalog import) and UC-PC-012
(picker) exist, the per-cycle sheet import has no job left — it is REMOVED, not
deprecated-in-place.

**Business rules:**

- **Deleted endpoints** (`backend/src/routes/products.js`):
  `POST /import/:cycleId`, `POST /import-gsheet/:cycleId`,
  `POST /import-gsheet-multirow/:cycleId` — handlers gone; their parsing code lives
  on in `helpers/import-parsing.js` (UC-PC-003's extraction; the deletion happens in
  the same change as the extraction or after it, never before). A hit on a deleted
  route falls through to Express's default 404 — no tombstone handler.
- **Consumer sweep (verified 2026-08-22, restate-and-recheck at implementation
  time):** the only consumers are admin-surface — `frontend/src/api.js`
  (`importProducts`, `importFromGoogleSheets`, `importFromGoogleSheetsMultirow` —
  all three deleted) and `CycleDetail.vue`'s import section (CSV upload, gsheet
  URL + format radio, roastery selector, `importCSV()` / `importGoogleSheets()` —
  deleted; the products tab's other functions stay). No friend/guest surface, no
  seed script, and no other backend code calls them.
- **The hostile-input guards do not retire with the routes** — FUP-T12
  (`typeof url !== 'string'` → 400, no stack echo) and FUP-T15
  (`bindValue(req.body.roastery)`) were bought with real incidents and are
  MANDATORY on the three replacement routes (UC-PC-003); the e2e pins move with
  them (UC-PC-011 item 4).
- **e2e retargets** are enumerated in UC-PC-011 item 4 (`image-upload.spec.js`,
  `nonstring-body-shape.spec.js`); `ADMIN_ENDPOINTS` had no rows for the retired
  routes (UC-PC-011 item 1), so the sweep only gains entries.
- CLAUDE.md's Pickup-Locations-era notes describing the per-cycle import flow become
  partially stale — supersede on landing (the house strikethrough convention).

**Acceptance criteria:** the three old routes answer 404 to an authenticated admin;
a grep for `products/import` across `frontend/src` returns nothing (the surviving
import calls all target `coffee-products/import*`); CycleDetail renders its products
tab with no import section; the retargeted specs pass; the full suite is green with
the retired-route specs re-pointed, none deleted.

---

## UC-PC-014 Product images as files + URLs (Admin / System — PC-T10)

**Goal (resolved decision 15):** image BYTES leave the database and the JSON
payloads. Uploads become files in a persistent directory served by a public,
long-cached route; `image` columns hold a URL path string; existing base64 is
converted once by an admin-triggered endpoint.

**Storage — `backend/src/helpers/image-store.js` (the ONE home for writing image
files):**

- **Directory:** default `join(dirname(<DB file>), 'uploads')` — i.e. a SIBLING of
  the SQLite file (`backend/src/db/uploads/` in prod/staging, and automatically
  next to the throwaway `DB_PATH` in e2e runs, which isolates test uploads per
  run); `UPLOADS_DIR` env overrides. Created on boot (`mkdir recursive`).
- ⚠ **`deploy/deploy.sh` MUST gain `--exclude 'src/db/uploads'`** on the backend
  rsync (same block as the DB exclude): the deploy rsyncs `backend/` with
  `--delete`, and the existing `src/db/database.sqlite*` glob does NOT cover a
  directory — without the new exclude the FIRST deploy after PC-T10 deletes every
  uploaded image. This is the load-bearing line of the whole task; it lands in the
  same change as the code.
- **Filename = content hash:** `sha256(bytes)` hex, first 32 chars, plus the
  canonical extension for the SNIFFED type (`detectImageMime` stays the one magic-
  bytes authority — SEC-H2): `<hash32>.png|jpg|gif|webp`. Consequences, all
  deliberate: identical bytes dedupe to one file; a REPLACED photo gets a NEW
  filename ⇒ a new URL ⇒ **cache busting by construction** (an admin image swap
  can never serve stale, because the old URL is simply no longer referenced);
  conversion and re-uploads are idempotent (file exists ⇒ skip the write).
- `storeImage(buffer)` → `{ url: '/api/images/<hash32>.<ext>' }` or
  `{ error }` (non-raster refused — the existing SEC-H2 message). Write order:
  file fully written first, column updated second — a crash between the two leaves
  a valid state (old value still in the column, an orphan file on disk that a
  re-run reuses by hash).
- **Orphan files are accepted:** replacing a photo does not delete the old file
  (dedupe means two rows may share one file; reference counting is not worth it at
  ~tens of images). Recorded in §Accepted risks.

**Serving — `GET /api/images/:filename` (PUBLIC, mounted BARE — deliberately NOT
`requireAdmin` and NOT in `ADMIN_ENDPOINTS`):**

- Why public is correct: friend AND guest pages render these images, and the
  exposure is EQUIVALENT to today — `GET /api/products/cycle/:id` is already a
  public route shipping the same bytes inline. Recorded so the ADMIN_ENDPOINTS
  sweep's reviewer doesn't "fix" it.
- A validated ROUTE, not an `express.static` mount (house hostile-boundary style):
  `:filename` must match `^[a-f0-9]{32}\.(png|jpg|gif|webp)$` — anything else 404s,
  which forecloses path traversal by construction (no separator can appear).
  Content-Type from the extension (trusted: the extension was derived from sniffed
  magic bytes at write time, never from client input). Missing file ⇒ 404.
- **Cache headers that actually cache:** `Cache-Control: public,
  max-age=31536000, immutable` — safe ONLY because the filename is a content hash
  (the busting scheme above). Express sends these itself; nginx's `location /api`
  adds no header of its own, so nothing overrides them.
- **URL placement under `/api` is deliberate:** both nginx confs proxy ONLY `/api`
  to the backend, so no nginx change and no CSP change is needed — `img-src 'self'`
  covers same-origin (`data:` stays in the policy for bakery + QR codes). The Vite
  dev proxy already forwards `/api` → :3000 and `API_BASE` defaults to `/api`, so
  the stored RELATIVE path renders in dev, e2e and prod alike. ⚠ Constraint,
  recorded: a deployment that set `VITE_API_URL` to a cross-origin API would break
  relative image paths — no current deployment does; revisit only if that ever
  changes.

**Column semantics + write paths converted (coffee only):**

- `coffee_products.image` and `products.image` (coffee rows) hold either a URL path
  string (`/api/images/…`) or legacy base64 pending conversion; NULL = no image.
  **Base64 never enters these columns again** on the converted paths:
  - catalog `POST /api/coffee-products/:id/image` (multipart AND body-base64 forms
    — the server stores a file and writes the URL; a body value that is already a
    plain URL/path passes through as `imageFromBody` always did);
  - the manual product POST's dual-store (UC-PC-005 — snapshot and, when created,
    catalog row both receive the URL);
  - the snapshot-level `products.js POST /:id/image` and `POST /:id/image-from-url`
    (both still-reachable admin routes; they convert regardless of cycle type —
    same column, same consumers — while the `bakery_products` table and its routes
    stay untouched, bakery being out of scope).
- Frontend: ZERO rendering changes (decision 15's `<img :src>` rationale). Admin
  upload UIs keep sending multipart/base64 exactly as today.

**One-time conversion — `POST /api/coffee-products/convert-images`
(`requireAdmin`, whole-mount; the migration-endpoint precedent, resolved
decision 2's surviving half):**

- Converts every `image LIKE 'data:%'` value in `coffee_products` AND in `products`
  rows of coffee cycles (`COALESCE(order_cycles.type,'coffee')='coffee'`,
  `source_bakery_product_id IS NULL`) — old cycles' friend pages get the payload
  win too. Per row: sniff + store file (reusing `storeImage`; an unparseable/
  non-raster legacy value is SKIPPED and reported, never dropped), then UPDATE the
  column to the URL. **Per-row commit order file-then-column** (crash safety as
  above); rows already holding URL values or NULL are skipped — that is the
  idempotency (second run converts 0).
- **Report:** `{ converted_catalog: n, converted_snapshots: n, skipped:
  [{table, id, reason}], bytes_freed: n, second_run_hint }` — `bytes_freed` is the
  summed base64 string length removed from columns (the PM-visible payoff number).
- Synchronous handler, no `await` (file writes via `fs.writeFileSync` — consistent
  with the `instances: 1` + synchronous-handler concurrency model; ~10 MB of
  writes is a one-time admin action, not a hot path).
- UI: a small action in AdminCatalog near the workbench ("Konvertovať obrázky na
  súbory"), rendering the report counts; admin skin.

**Backup implication (SEC-D2) — explicit addition, PM-visible:** `backup-db.sh`
snapshots ONLY the SQLite file (`sqlite3 .backup` → age-encrypt → rclone). Once
images are files they LEAVE that backup. **The same change extends `backup-db.sh`
to tar the uploads dir and ship it alongside the DB snapshot, encrypted with the
same age key** (`gorifi-uploads-<TS>-<label>.tar.age`); until that script lands on
the server, image loss on disk failure is an accepted risk — recorded in
§Accepted risks so the PM sees it either way. The uploads tar can skip unchanged
re-uploads only if someone later adds state; shipping the whole ~10 MB each run is
fine at this size.

**Acceptance criteria:** uploading a PNG to a catalog product stores a file under
the uploads dir, writes `/api/images/<hash32>.png` into the column, and `GET` on
that URL serves the exact bytes with `Cache-Control: public, max-age=31536000,
immutable` and `Content-Type: image/png`; re-uploading the same bytes reuses the
same URL; uploading different bytes yields a DIFFERENT URL (the cache-busting
pin); `GET /api/images/x%2F..%2Fdb.sqlite`-style and any non-matching filename
404; the conversion endpoint converts a seeded base64 catalog row AND a historical
coffee snapshot, reports `bytes_freed > 0`, and a second run reports 0 converted;
after conversion, `GET /api/products/cycle/:id` and the guest listing contain **no
`data:image` substring** (the payload-size pin) and both still render the image
via the COALESCE; a bakery product's base64 is untouched; anonymous
`POST /convert-images` 401s via the sweep while anonymous `GET /api/images/…`
succeeds (the deliberate-public pin).

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
  the migration workbench (UC-PC-006) must be fully worked through (pending list
  empty) before 13 ships.
- **Merge-transaction extension obligation:** when `friend_reviews` lands, module 13
  ADDS the review-repoint (latest-wins on the UNIQUE pair) into UC-PC-007's
  transaction. Recorded on both sides.
- `country` is the only informational-adjacent field that is first-class for
  stats/filtering (brief Decision 9) — it feeds 13's "krajín" counter and the future
  Svetobežník badge; parsing-from-name + admin override is 13's concern, the column
  is here.

**What the future autonomous import routine consumes (enablers only, routine not
built):** the authenticated HTTP catalog-import endpoints (the automation boundary
is the API, never the SQLite file — brief §2.6), the UC-PC-004 `report` contract
(shape-stable), and natural idempotency (resolved decision 12): a retried/duplicate
run reports `0 new / N matched / 0 price_changes` having written nothing — no retry
special-casing needed. The pivot also SHRINKS the routine's job: it imports into the
catalog on the roastery's schedule, decoupled from cycle timing — cycle creation
stays a human act (the picker).

**What stays untouched — the guarded-seams list (01-architecture, verbatim
obligations):** `helpers/stock.js` (stock counting), `helpers/pricing.js` (variant
pricing), the guest-aggregation JS-merge rules, the packing gates
(`helpers/packing.js`), `order_items` and frozen snapshot prices, the per-friend vs
cycle-level aggregate split (Decision 4), importer parsing + column mapping,
`instances: 1` + synchronous-handler concurrency (all new writes transactional, no
`await` between check and write), and bakery everything.

---

## Accepted risks / follow-ups / OPEN items

- **`FUZZY_THRESHOLD = 0.75` is a shipped default — and the PM found it TOO LOOSE
  in practice on real staging data (2026-08-23):** the migration's fuzzy
  suggestions paired unrelated products, which is what triggered the decision-14
  workbench rework. The threshold now governs only the import `pending_fuzzy` flag
  and the duplicates tab (UC-PC-003/008); **tuning it is a recorded follow-up, not
  done here** — a false pair there costs one review-list row, never a merge.
- **Catalog image edits change past cycles' display** (resolved decision 5) —
  **PM-confirmed 2026-08-22**; price/order history stays immutable.
- **Admin edits to sheet-sourced catalog fields do not survive the next import
  naming that product** (resolved decision 13) — `description1/2`, `roast_type`,
  `purpose` and prices are the sheet's; durable curation belongs in the admin-only
  fields. Accepted openly; revisit with an "admin-locked" flag if it bites.
- **The pre-existing `PATCH /api/products/:id` can still edit a snapshot in place**
  (prices included) — the one surviving in-place mutation path, predating this
  module and deliberately out of its scope (retiring it would need its own
  spec-impact pass; UC-PC-005's ADD-only rule and decision 11's principle do not
  govern a pre-existing admin capability). Recorded so nobody mistakes decision 11
  for a claim the codebase cannot express a snapshot edit at all. ⚠ Post-PC-T10
  this includes the base64-specific half: the PATCH still writes any string
  (base64 included) into `products.image` verbatim — pre-existing, admin-only,
  and self-correcting (a convert-images re-run sweeps `data:%` values back out).
- **A mistake in the ticked product set is recoverable additively only** — a wrongly
  UNTICKED product is added later via the manual POST (UC-PC-005); a wrongly TICKED
  one is soft-deleted via the existing product DELETE (`active = 0`). Neither breaks
  the frozen-cycles principle.
- **Manual double-POST of the same name into one cycle now 409s
  (`duplicate_in_cycle`)** instead of creating a second row (UC-PC-005) — a
  deliberate behavior change; rename to genuinely duplicate.
- **The gsheet import paths are not e2e-exercisable** (live sheet required) — the
  shared `consolidateCatalogRow` + extracted parser is the mitigation (UC-PC-011
  item 2). Residual risk: a divergence in how an endpoint CALLS the helper would
  escape the suite; keep the call sites trivial.
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
- **PC-T10 (UC-PC-014): image files are NOT in the DB backup until the
  `backup-db.sh` uploads-tar addition lands ON THE SERVER** (the script snapshots
  only the SQLite file). The addition is specified as part of the same change and
  is PM-visible; the residual window — the deploy that ships PC-T10 up to the next
  backup-script rollout — is an accepted risk. Losing the disk in that window
  loses the image FILES while the DB keeps their URLs (broken `<img>`s, re-upload
  recovers).
- **PC-T10: orphan image files are accepted** — replacing a photo does not delete
  the old file (content-hash dedupe means two rows may share one file; refcounting
  is not worth it at ~tens of images, ~10 MB total). Disk cost is bounded and
  visible with `du`.

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
