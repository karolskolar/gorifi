# Requirements Brief: Product Catalog Consolidation, Friend Coffee Profiles & Recommendations

**Date:** 2026-08-18 (v10, updated 2026-08-23 — product images move to files + URLs)  · **Author:** Karol (PM) + Claude (research/synthesis)
**Status:** FINAL raw requirements material — input for `/draft-spec`.

> **v2 rescope:** The import pipeline stays AS IS (admin pastes an adapted Google Sheet;
> existing CSV/gsheet importer endpoints unchanged). Raw-roastery-sheet parsing, Apps Script
> image extraction, tier-price capture and the weekly auto-sync are moved to §5 Future.
> **v3:** the six open questions are resolved (see §6 Decisions).

---

## 1. Why (problem statements)

1. **No product identity across cycles.** Products exist only inside cycle snapshots; "Pink Bourbon in March" and "Pink Bourbon in June" are unrelated rows. Images and descriptions are re-attached every cycle, and no cross-cycle question is answerable.
2. **Re-importing known products.** Each cycle's sheet paste re-creates products that already exist in the app; nothing detects them.
3. **No memory of taste.** The app can't answer "most ordered product ever", "what does this friend like", "what should a beginner try" — the levers for engagement and order growth.

**Goals:** (a) one consolidated product database shared across cycles; (b) import that detects and reuses existing products (idempotent); (c) historical data migrated so statistics count from day one; (d) cross-cycle statistics as a foundation for Modules 2–3.

**Success metrics:** admin import effort per cycle (target: paste sheet → read report "X new / Y existing / Z price changes"); participation rate per cycle; trial rate (% of orders containing a new-to-that-friend coffee); avg kg per cycle; review response rate (Modules 2–3).

---

## 2. Module 1 — Consolidated catalog, duplicate-aware import, migration, stats

### 2.1 Architecture ✅

**Catalog + snapshot links — the proven bakery pattern.**
- New `coffee_products` catalog table: each real-world product exactly ONCE (name, descriptions, roast, purpose, roastery, image, country, status, timestamps).
- Cycle products remain **snapshots** in the existing `products` table (frozen prices, stock limits), now carrying `source_coffee_product_id` → catalog. `order_items` and every guarded seam (stock counting, pricing, guest aggregation, packing gates) are **untouched**.
- "Consolidated" is delivered by the LINK: catalog id ⇒ which cycles offered it, who ordered it, how often — while history stays immutable.
- Friends need no consolidation (stable `friends.id` already); their cross-cycle stats join through the same link.
- Bakery catalog stays separate ✅ — bakery will most likely be REMOVED from the app; no convergence work, ever. Do not generalize the coffee catalog for bakery's sake.

### 2.2 Import flow — ⚠ SUPERSEDED 2026-08-22 by the bakery-pattern pivot (decision #15)

> The premise "importer stays per-cycle as-is" is retired. **Imports now target the
> CATALOG from a main-menu tool (like the bakery products page); coffee cycle creation
> ticks products from the catalog and snapshots them; the per-cycle sheet import is
> REMOVED.** The sheet PARSING/column mapping stays byte-identical — only the target
> moves. Everything below about matching (exact auto-link / fuzzy confirm), price
> auto-apply + report, idempotency and the JSON report contract carries over to the
> catalog-targeted import. Frozen cycles are now enforced by construction (imports
> cannot touch a cycle at all). Canonical text: 12-product-catalog.md.

### 2.2-old Import flow (existing importer + consolidation layer) — superseded, kept for provenance

- **Input unchanged:** admin pastes the adapted Google Sheet (or CSV) exactly as today; the existing endpoints and column mapping stay byte-identical. The adapted sheet carries final sell prices, as today.
- **Goriffee-only scope ✅:** the importer works exclusively with the Goriffee roastery sheet. Duplicate matching runs ONLY against Goriffee catalog products; products of other roasteries are never candidates and never checked. Identity key = **normalized name within Goriffee** (trim, case-fold, collapse whitespace, fold punctuation).
- **New behavior after parsing, per row:** match against the (Goriffee) catalog by identity key →
  - **Exact match:** link automatically ✅. No new catalog entry; image/metadata reused; this cycle's snapshot created linked to it.
  - **Very similar / similar name (fuzzy):** NOT auto-linked — the import report asks for confirmation ("Je to premenovaný X?") ✅. Admin confirms merge or creates as new.
  - **No match:** create catalog entry + linked snapshot; flag "needs image" if none.
- **Price changes ✅:** auto-applied and reported. The new price affects ONLY the new cycle's snapshot (and the catalog's "current price"); existing/old cycles keep their frozen prices untouched.
- **Same-cycle re-import FORBIDDEN ✅ (2026-08-22):** imports target fresh/future cycles only; an import into a cycle that already has coffee products is refused and writes nothing. Cycles are frozen absolutely — no import path may mutate an existing cycle's products. Field consolidation (picture, name, …) across historical duplicates happens ONLY at migration/merge time on catalog rows.
- **Idempotency (automation-critical):** importing the same sheet into the same cycle twice = no duplicate snapshots, no duplicate catalog entries; second run reports "0 changes". This is the property that later makes autonomous imports safe.
- **Import report (machine-readable JSON + rendered in admin):** N new products, M matched existing, K price changes (old→new), fuzzy-match confirmations pending, unparsed rows. Nothing is silently guessed or dropped.

### 2.3 Migration of historical data — ⚠ matching policy SUPERSEDED by decision #16 (manual workbench; no auto-links, no fuzzy)

- One-time migration: group all historical coffee `products` rows by identity key → create catalog entries → backfill `source_coffee_product_id` on every snapshot.
- **Matching policy ✅ (same as import):** exact normalized-name matches link automatically in bulk; very-similar/similar names go to a confirmation report for manual merge decisions.
- Admin **merge tool** (merge catalog entry B into A: repoint all snapshot links, delete B) — resolves the migration tail and stays as the permanent safety valve for future duplicates.
- Never delete or alter historical snapshots, prices, or order_items.

### 2.4 Cross-cycle statistics (the acceptance test of the whole module) ✅

Must be answerable with simple queries once links exist; exposed via admin analytics (and later consumed by Modules 2–3):
- Most ordered product across all cycles — by kg, by distinct friends, and by distinct **repeat** buyers; filterable per purpose (Espresso/Filter/Kapsule).
- Per friend × product: how many times / how much a friend ordered each product over all cycles.
- Per product: availability history (which cycles offered it) and order trend.
- Guests: count in product/cycle totals, never in per-friend aggregates (Decision-4 discipline).

### 2.5 Catalog management (admin)

- Catalog list view: image, name, purpose, roastery, status (available/retired), cycles count, all-time kg. Edit metadata + image ONCE (no more per-cycle image attaching — the headline friction win).
- **Informational attributes** (optional, per catalog product, entered once by admin — NEVER from the importer): country, region, altitude, farm, variety, processing. Empty = simply not shown. Future: prefill by name-matching goriffee.com product pages (§5).
- Cycle creation gains nothing new in v3 (still import-driven); a "tick catalog products for this cycle" flow is a natural later addition (§5).

### 2.6 Automation-readiness (decided posture) ✅

- **DB stays SQLite/better-sqlite3. No Supabase, no external DB.** The automation boundary is the **authenticated HTTP API**, not the DB file: direct SQLite writes over SSH would bypass validation, migrations, and WAL locking against the live app.
- A future autonomous routine (e.g. a scheduled Claude Code job) = fetch/adapt sheet → call the existing import endpoint → read the JSON report → notify admin. Requirements 2.2 (idempotency, machine-readable report) are the only things this version must do to keep that door open. The routine itself is out of scope (§5).

---

## 3. Module 2 — Friend coffee profile & passport ("Moje kávy") — ⛔ DEFERRED WHOLESALE (PM 2026-08-22)

> Spec drafted as `docs/specification/13-coffee-passport.md`, then deferred entirely
> ("not sure about it now") — nothing below is built until revived.

Data-first: derived from orders, corrected by micro-reviews. Only ONE question ever asked directly.
- **Brew methods** (the one question) — **MULTI-SELECT ✅**: "Ako pripravujete kávu? (môžete vybrať viac)". Values: espresso machine / moka / filter–dripper / french press / capsules. Asked once, editable in "Upraviť profil". Storage: `friend_brew_methods(friend_id, method)` junction — the `friend_subscriptions` pattern (UNIQUE pair). A friend with e.g. capsules on weekdays + filter on weekends simply ticks both.
  - Recommendations filter to the UNION of matching purposes (filter+capsules → both Filter and Kapsule tabs are candidates).
  - Purpose-tab defaulting only when unambiguous (single method); multi-method friends keep the standard tab order — never guess.
  - Roast-purpose mismatch hints fire only when a product'''s purpose matches NONE of the friend'''s methods (a multi-method friend is never falsely warned). Educational, never blocking.
  - Review brew chip defaults to whichever of the friend'''s methods matches the coffee'''s purpose; one tap to override.
- ~~Flavor chips~~ — **REMOVED from v1 (PM decision 2026-08-22: risk of being misleading).** No column, no auto-tagger, no display. The concept (4 consumer taste families) is recorded in §5 Future for possible later use by module 14.
- **Passport screen** (friend portal): header stats (káv vyskúšaných, krajín, kg spolu, streak — streak already computed in `analytics.js`, today admin-only); history list (coffee · country · ordered N× · last date · 👍/😐/👎); **"Objednať znova"** when that catalog product is in an open cycle (the retention loop); inline rating chips on unrated rows — the passport IS the review-collection surface (no modals, no emails).
- **Micro-reviews:** 👍/😐/👎 + optional brew-method override. NO star ratings, NO text reviews. One row per (friend, catalog product), latest wins.
- **Country** (`Krajina pôvodu`) on catalog products (name parsing + admin override) — the ONLY new first-class stats/filter attribute; feeds passport ("4 krajiny") and the Svetobežník badge.
- **Product detail modal (friend-facing):** tapping a product opens a modal (extends the existing photo-lightbox interaction: photo on top) showing the informational attributes below it — Región, Nadmorská výška, Farma, Odroda kávy, Spracovanie — rendering only rows that have values. Display-only: no filtering, no statistics on these. Attribute vocabulary mirrors goriffee.com product pages verbatim.
- Slovak register: vy-form, no gendered participles addressing the reader (house rule).

## 4. Module 3 — Group favorites, recommendations, engagement

### 4.1 Group favorite badges — DEFERRED (display), DB support required NOW ✅

- **No badge/label ships at this stage** — neither aggregate ("Objednalo znova 9 kolegov") nor named ("Jozef objednal 4×"). The whole display layer is future work (§5).
- **What Module 1 must guarantee today:** the schema and stats queries make these badges a pure frontend addition later — per-product distinct-buyer and distinct-REPEAT-buyer counts across cycles, per purpose tab, window-limitable (e.g. last 6 cycles), guests excluded from per-friend counts. Covered by §2.4; no additional schema needed beyond the catalog link.
- Design decisions recorded for the future implementation (so they are not re-litigated): rank by distinct repeat buyers, min threshold ~3, scoped per purpose tab, aggregate counts only (named variant even further out).

### 4.2 Roaster's/curator's pick
- Admin marks ≤1 product per cycle `Výber` + optional one-liner. Zero data dependency. Sheet's `NOVINKA` flag → `Novinka` badge if present in the adapted sheet.

### 4.3 Beginner recommendation ("Pomôž mi vybrať")
- Entry: passport empty state + explicit button. Two questions: brew method (stored) + taste fork (`Klasická a vyvážená` vs `Ovocná a odvážna`).
- Logic: filter current cycle by purpose → rank by group-favorite score (the §2.4 repeat-buyer stats; internal ranking only — no badges shown, per §4.1) within matching flavor family (requires the deferred flavor-chip data — module 14 cannot ship its taste fork before chips return) → top 2–3 as "Podpultovka odporúča" (no social-proof line while §4.1 display is deferred). Transparent rules; NO ML (user base too small for collaborative filtering — content-based + social proof is the market-correct approach at this scale).

### 4.4 Engagement extras (cheap, later)
- Year recap ("Tvoj rok v káve" + group version) — screenshot-friendly for the office chat.
- Exploration badges (Prieskumník / Svetobežník / Verný-streak) — cosmetic, NO points machinery.
- Visible referral credit to hosts ("3 kolegovia sa pridali cez teba") — display only, mechanism exists.

### 4.5 Explicit non-goals
No points/loyalty program (tier discount is the collective reward). No star ratings / text reviews. No fake urgency (real deadline + real stock only). No AI-chat sommelier. No collaborative-filtering ML. No social-proof badges of any kind at this stage — aggregate AND named deferred (§4.1); DB support only.

---

## 5. Future / deferred (recorded, deliberately out of scope now)

- **Raw roastery sheet ingestion** (3-row block parser, hidden-row semantics via Sheets API, in-cell image extraction via Apps Script `CellImage.getContentUrl()`), tier-price capture (buy vs sell columns, VAT setting, exact margin analytics), weekly auto-sync with review queue. Full v1 analysis preserved in git history of this file (`git log -- docs/requirements/`).
- **Autonomous import routine** (scheduled Claude Code job driving the import API) — enabled by §2.2/§2.6, not built now.
- **Cycle creation from catalog** (tick products instead of importing) — natural once the catalog is trusted.
- **goriffee.com attribute prefill** — scrape/name-match the eshop product page to prefill country/region/altitude/farm/variety/processing on new catalog products.
- **Flavor chips** (4 taste families: Ovocná/kyslejšia · Čokoláda/oriešky · Kvetinová/jemná · Experimentálna; auto-tag over description2 + admin override) — removed from v1 by PM 2026-08-22; a prerequisite for module 14's taste fork.
- **Social-proof badges/labels** (aggregate "Objednalo znova N kolegov" first; named "Jozef objednal 4×" further out) — display layer only; data support lands with Module 1 (§2.4).
- **Module 3 threshold calibration** against real group size/goals (PM deferred providing these; ship sensible defaults, tune from data).
- ~~Bakery catalog convergence~~ — CANCELLED: bakery stays separate and will most likely be removed from the app.

## 6. Decisions log (2026-08-18, PM)

1. ✅ Importer is **Goriffee-only**; duplicate matching never considers other roasteries' products. Identity = normalized name within Goriffee.
2. ✅ Price changes on import: **auto-apply + report**; affect only the new cycle's snapshot and the catalog's current price — old cycles frozen.
3. ✅ Matching: **exact names auto-link; very-similar/similar ask for confirmation** (both at import time and in migration).
4. ✅ Social proof: **no badges/labels at all at this stage** (aggregate and named both deferred). The database/stats layer must support them (§2.4); display is future work.
5. ✅ Group-size/goal calibration deferred; defaults ship, tuned post-launch.
6. ✅ Bakery **stays separate**; likely to be removed entirely — no convergence work.

**2026-08-22:**
7. ✅ Tier progress on the friend order page ("Ešte 3 kg do 35 % zľavy…") — **removed from scope entirely** (not deferred).
8. ✅ Brew method is **multi-select** (junction table); union-based recommendation filtering; tab defaulting only when unambiguous; mismatch hints only on zero overlap.
9. ✅ Product attributes two-layer: `country` first-class (stats/filter); region/altitude/farm/variety/processing informational-only, shown in a friend-facing product detail modal, admin-entered once per catalog product, never imported from the sheet.
10. ✅ **Flavor chips removed from v1 entirely** (PM 2026-08-22 — "not sure they won't be misleading"): no column, no auto-tagger, no display anywhere. Recorded in §5 Future.
11. ✅ Brew-method → purpose mapping confirmed: `moka → Espresso`, `french press → Filter`.
12. ✅ **Same-cycle re-import is not possible** — imports only into fresh cycles; existing cycles frozen absolutely (no in-place snapshot updates of any kind). Historical field merging happens only in the migration/merge tool.
13. ✅ **Module 2 (passport/brew methods/reviews/detail modal) DEFERRED WHOLESALE** — spec drafted and kept, nothing built. Module 12 ships alone.
14. ✅ Catalog-image display derivation accepted: editing a catalog product's image changes how past cycles display it (data untouched).
15. ✅ **PIVOT (2026-08-22): "unified import tool in the main menu like in the bakery."** Imports target the catalog (cycle-independent, main-menu page); coffee cycle creation gains a tick-list picker over `status='available'` catalog products (bakery flow); the per-cycle import endpoints + CycleDetail import UI are retired. Supersedes the v2 "keep importer per-cycle as-is" premise; sheet parsing itself is still unchanged. Decided after PC-T1 shipped, before PC-T2 started.

## 7. Data-model sketch (directional)

- `coffee_products` (catalog): id, name, normalized_name, roastery (default 'Goriffee'), country, region, altitude, farm, variety, processing, description1, description2, flavor_chips, roast_type, purpose, is_new, curator_pick_note, image, status, current prices (last imported), created_at/updated_at. UNIQUE(normalized_name, roastery). Only `country`/`purpose`/`roast_type`/`flavor_chips` are ever filtered or aggregated; the rest render in the detail modal.
- `products` (cycle snapshot — shape unchanged) + `source_coffee_product_id` (nullable FK; the ONLY schema change to an existing table).
- `friend_reviews`: friend_id, coffee_product_id, verdict (up/mid/down), brew_method, created_at, UNIQUE(friend_id, coffee_product_id).
- `friend_brew_methods(friend_id, method)` — UNIQUE(friend_id, method), the `friend_subscriptions` pattern. (Replaces the earlier single-column `friends.brew_method` idea.)
- Import report: returned JSON (persist later if the autonomous routine needs history).

Guarded seams that must NOT change behavior: stock counting (`helpers/stock.js`), pricing (`helpers/pricing.js`), guest aggregation JS-merge rules, packing gates, per-friend vs cycle-level aggregate split (Decision 4), `instances: 1` + synchronous-handler concurrency assumptions (migration + import writes stay transactional).
16. ✅ **Migration is a MANUAL WORKBENCH (2026-08-23, from staging testing).** The automatic
    migration's fuzzy suggestions merged unrelated products. Replaced: all unresolved historical
    products are listed (one row per identical name), the admin checkbox-selects one or more and
    either assigns them to an existing catalog product or creates a new one from the selection;
    resolved rows disappear, created products appear. No similarity suggestions anywhere in
    migration. The 0.75 fuzzy threshold (still used by import flagging + duplicates tab) is
    recorded as too loose on real data — tuning is a follow-up.
17. ✅ **Product images become FILES served by URL (2026-08-23, PC-T10).** Inline base64 storage
    put ~10 MB of image text into every product listing response with zero browser caching (the
    recorded "13 MB JSON payload" issue). Approved: uploads become server-side files behind a
    public cacheable GET; `image` columns hold URL paths; a one-time admin-triggered conversion
    migrates existing base64 (catalog AND historical coffee snapshots). Frontend rendering is
    unchanged (`<img src>` takes a URL like a data URI).

