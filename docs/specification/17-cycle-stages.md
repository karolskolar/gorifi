# 17 — Cycle stages, opening/closing dates, timeline component

> Scope: The stage model that splits today's monolithic `locked` into what the friend
> actually wants to know ("where is my coffee?"), plus the two planning dates the closed
> and open states need. Four areas: (a) three new nullable columns on `order_cycles` —
> `opens_at`, `closes_at` (ISO calendar dates, informational, never a scheduler) and
> `stage` (`ordered` → `arrived` → `ready`, meaningful only while `status='locked'`,
> defaulted to `ordered` on lock **from `open`**, cleared on unlock **from `locked`** —
> ⚠ both scopes are load-bearing, not descriptive: reading them as unqualified is exactly
> how the shipped `!== 'locked'` guard got written, which rewound a handed-out round's
> timeline from step 5 to step 2 until FUP-T26); (b) the `PATCH /cycles/:id`
> extension and the ONE backend helper (`helpers/cycle-stage.js`) that owns the enum and
> the "first hand-over ⇒ `ready`" transition module 16 calls; (c) the three fields
> published on every friend, guest and admin cycle payload; (d) `CycleTimeline.vue` — ONE
> component, two variants (vertical with label/when/desc; compact 6-dot) over the six
> friend-facing steps *planned → open → ordered → arrived → ready → completed*, with its
> step model, Slovak copy and the „o n týždňov“ derivation in ONE plain-JS home
> (`lib/cycle-stages.js`) that modules 18 and 19 consume. This module mounts the
> component on `GuestOrderStatus.vue` and, read-only, on the admin cycle header; it adds
> the date fields and the two stage buttons („Káva dorazila“ / „Zabalené, rozvážame“) to
> `CycleDetail.vue`. Backend + schema changes.
> Out of scope (handoffs): the hand-over flag, its endpoints and the distribution board
> (**module 16** — it CALLS `markCycleReady()`, it does not own it); the portal landing,
> the locked-state card, the closed modal + banner, the menu and the explainer (**module
> 18** mounts `CycleTimeline` there and composes the closed-state copy from this module's
> builders); the standing guest link and pre-open page (**module 19** reuses
> `nextOpeningText()`); notifications incl. the „closing soon“ message that reads
> `closes_at` (**module 21**); cycle auto-completion (**dropped**, roadmap §16 Q8.c);
> auto-open / auto-lock on the dates (**dropped** — no scheduler, 01-architecture §Shared
> services); bakery (retiring — the `type` column stays untouched, the timeline copy is
> coffee-only and a bakery cycle renders the same six generic steps).
> Actors: **Admin** — the only writer: dates on any status, stage while locked; sees the
> compact timeline read-only in the cycle header. **Friend** — read-only: receives the
> three fields on `GET /friends/cycles`; the portal surfaces that render them are module
> 18's. **Guest** — read-only: receives the three fields in the status payload and sees
> the vertical timeline on their order page; no new write, no new capability.
> Sources: `docs/superpowers/specs/2026-09-03-roadmap-requirements.md` — §3.1 (stage
> table), §3.2 (timeline component), §1 R1.3/R1.4/R1.6 + §1 Data (`opens_at`), §11
> („Admin cycle header … first stage-3 bag → cycle stage `ready`“), §16 (R1.3 wording
> „objednávka“; Q8.c no auto-complete; Q3.a), §18 row 5 (depends on row 3 = module 16);
> `docs/superpowers/specs/2026-04-19-preliminary-cycle-design.md` (the shipped `planned`
> status + `plan_note`, "structured date fields" explicitly NOT in that scope — added
> here); `docs/specification/01-architecture.md` §Roadmap October 2026 additions (the
> fixed column set) + §Permissions; `00-overview.md` glossary (Cycle stage, Round /
> objednávka); prototype `docs/design/friends-portal-redesign/friends/portal2.jsx`
> (`P2.stages`, `Timeline`, `Dots`, the locked state card „Kde je vaša káva“, the closed
> modal) + `portal2.css:22-42` (`.p2-tl`, `.p2-dots`), `admin2.jsx` header (manual
> „Ukončiť objednávku“), README addenda 2026-09-05/06; code `backend/src/routes/cycles.js`
> (POST :205, PATCH :317, `/public` :152), `backend/src/db/schema.js:125-201`
> (`order_cycles` CREATE, ALTERs, the `_check_test` recreate block),
> `backend/src/routes/friends.js:623-720`, `backend/src/routes/guest.js:187,428-434,543-549`,
> `frontend/src/views/CycleDetail.vue` (:855-866 lock/complete, :1406-1437 header,
> :1485-1518 settings card), `GuestOrderStatus.vue` (:160-170 `readOnlyReason`, :537-540
> pills, :622 `status-readonly`), `frontend/src/lib/plural.js`; shipped e2e
> `guest-status-shell.spec.js:356`, `nonstring-body-shape.spec.js` (FUP-T13 sweep),
> `api-security.spec.js`. The most recent decision wins on conflict (§16 > §11 > §3 > §1;
> prototype 2026-09-05 > roadmap text 2026-09-03).
> **Design reference:** `portal2.jsx` `Timeline` + `portal2.css:22-35` (vertical) and
> `Dots` + `portal2.css:38-42` (compact) are the pixel canon — port the CSS
> byte-equivalent into the component's `<style scoped>`, never into `friends-theme.css`
> (canon port ends at A12; new styling is scoped). The guest status page keeps its own
> lagging skin around the mounted card; the admin header wraps the compact variant in
> shadcn chrome and adds no `neo/` class.

---

## Resolved conflicts (recency / canonicity)

1. **Explainer renders the timeline (§3.2 „static, all steps, with one sentence each“)
   vs the 2026-09-05 prototype**, whose `Explainer` uses its own six didactic phase cards
   (`p2-step`: Pauza · Ohlásenie objednávky · Objednávanie · Čakáme na pražiareň · Balíme
   · Odovzdanie) and NOT `Timeline`. The prototype is newer and wins: the explainer is
   module 18's and does not mount `CycleTimeline`. The component's six steps are the
   STATUS-based ones of §3.1 (planned/open/ordered/arrived/ready/completed), which is what
   „Kde je vaša káva“ and the closed modal's dots show in the prototype.
2. **„Pripravujeme ďalšie kolo“ / „Kolo ukončené“ (§3.1 table) vs §16 R1.3.** The
   decision wins: every friend/guest-facing string in this module says „objednávka“; the
   two labels become „Pripravujeme ďalšiu objednávku“ and „Objednávka ukončená“
   (copy sign-off — §OPEN O1). Admin UI may keep „cyklus“ (glossary).
3. **§11 „pipeline feeds the F3.1 stage automatically … offers Ukončiť kolo when every bag
   is at stage 3“ vs §16 Q8.c „no auto-complete“.** Both survive in their halves: the first
   hand-over DOES set `stage='ready'` (UC-CS-003); NOTHING ever sets `status='completed'`
   but the admin's manual ~~„Označiť ako dokončený“~~ **„Ukončiť objednávku“** (relabelled
   by DP-T8, 2026-09-20 — the SAME button on BOTH headers now, `CycleDetail.vue` and the
   board, and it carries a UI-only gate: enabled once every party is handed over, while the
   API still completes on request). The "every bag handed over" hint is 16's board UI.
4. **„Horizontal on desktop / vertical on mobile“ (§3.2) vs the prototype**, which is
   vertical at every width (the portal is one 760 px-max column) and uses the compact
   6-dot strip where a horizontal read is wanted. Prototype wins: variants are
   `vertical` and `compact`, neither is width-switched.
5. **Q3.a „guests get 3 steps“ vs the status page.** The 3-step version is the guest
   EXPLAINER on the link page (module 19, `g-link2`). A guest holding an ORDER asks „kde je
   moja káva“, which needs the granular locked stages — the status page mounts the full
   six (§OPEN O4 records the default).
6. **`expected_date` semantics.** Roadmap §1 Data calls it „delivery expectation“; the live
   app renders it as the ORDERING DEADLINE („Objednávka do: {expected_date}“, 04 §UC-FO
   cartbar; admin label „Očakávaný dátum objednávky“, free text). This module does NOT
   read `expected_date` anywhere and does not relabel it; `closes_at` is the structured
   deadline from here on and module 18 decides what its status line/cartbar print (§OPEN
   O2). The prototype's „Káva príde okolo 24. 9.“ is likewise 18's.
7. **R1.3 `opens_at DATE` vs 01-architecture `TEXT`.** SQLite has no DATE affinity worth
   the name; 01-architecture fixes `TEXT`. Stored as ISO `YYYY-MM-DD` and validated at
   the write (UC-CS-002) so the „o n týždňov“ derivation is never fed free text.
8. **Prototype `when` lines „dnes, 23. 9.“ on `arrived` and „≈ 25. 9.“ on `ready`** need
   per-stage timestamps that the fixed column set (01-architecture) does not include.
   DROPPED: `arrived`/`ready`/`completed` render no `when`; `planned`/`open`/`ordered`
   derive theirs from `opens_at`/`closes_at`. The prototype's `desc` sentences („Dáme
   vedieť cez WhatsApp, keď bude v Neškôlke.“) are WhatsApp- and pickup-point-bound
   placeholders — DROPPED in v1; the component keeps the `desc` slot so 18/21 can fill it.

---

## UC-CS-001 Schema — `opens_at`, `closes_at`, `stage` on `order_cycles` (system)

**Goal:** the three columns 01-architecture §Roadmap October 2026 fixed, added the way
`schema.js` adds columns to a table already in production.

**Columns:**

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `opens_at` | `TEXT` | nullable, ISO `YYYY-MM-DD` enforced by the route (UC-CS-002) | planned opening of ordering; drives „Ďalšia objednávka sa otvorí približne …“ and „o n týždňov“ |
| `closes_at` | `TEXT` | nullable, ISO `YYYY-MM-DD` enforced by the route | ordering deadline; drives „Objednávky otvorené · do …“; module 21's „closing soon“ reads it |
| `stage` | `TEXT` | nullable, `CHECK (stage IN ('ordered','arrived','ready'))` | where a LOCKED cycle's coffee is; NULL on every non-locked cycle |

**Business rules:**

- Both the `CREATE TABLE IF NOT EXISTS order_cycles` block (schema.js:125-132) AND three
  `try { ALTER TABLE order_cycles ADD COLUMN … } catch {}` migrations carry the columns
  (CLAUDE.md: a column on a table already in prod needs CREATE **and** ALTER). SQLite
  accepts a `CHECK` constraint in `ADD COLUMN`, so the enum is enforced at the storage
  layer too; the route still validates first (a `SQLITE_CONSTRAINT_CHECK` throw would be
  a 500, never an acceptable answer).
- ⚠ **Placement:** the three ALTERs go AFTER the `_check_test` recreate block
  (schema.js:177-201). That block rebuilds `order_cycles` from a HARD-CODED column list;
  an ALTER placed before it is dropped on any database where it fires. (That the block
  also omits `parcel_enabled`/`parcel_fee` is a pre-existing latent defect on very old
  databases, out of this module's scope — recorded so nobody "fixes" it inside this row.)
- **No backfill.** Existing `locked` cycles keep `stage = NULL`; every reader treats
  `NULL` under `locked` as `ordered` (UC-CS-005 rule 2). Existing planned cycles keep
  `opens_at = NULL` — the closed state then falls back to `plan_note` (R1.3).
- The `status` CHECK, `plan_note`, `expected_date`, `parcel_*`, `type` are untouched.
- Backend restart runs the migration (deployment note, CLAUDE.md §Dev & deploy).

**Acceptance criteria:** a fresh DB and a DB seeded from the pre-module schema both end
with the three columns (`PRAGMA table_info(order_cycles)`); inserting `stage='packed'`
raises a constraint error at the SQLite layer; a pre-existing locked row reads back
`stage IS NULL`.

---

## UC-CS-002 Cycle API — `POST /cycles` and `PATCH /cycles/:id` extensions (Admin)

**Goal:** §3.1's „one `PATCH /cycles/:id` extension“: dates on any status, stage while
locked, and the status↔stage coupling so the admin's existing Uzamknúť/Odomknúť buttons
need no client change.

**`POST /api/cycles`** (cycles.js:205) additionally accepts `opens_at`, `closes_at` —
read through `bindValue` (FUP-T13), validated as below, stored in the INSERT (literal
columns). `stage` in a create body is **ignored** (a new cycle is `open` or `planned`,
where stage is meaningless).

**`PATCH /api/cycles/:id`** (cycles.js:317) — `requireAdmin`, literal-column UPDATE, never
a spread of the body:

| Field | Rule |
|---|---|
| `opens_at`, `closes_at` | `bindValue`; `undefined` (absent or unbindable shape) ⇒ skip the column (the shipped FUP-T13 contract at :318-324 — the stored value survives); `null` or `''` ⇒ clear; a string must match `^\d{4}-\d{2}-\d{2}$` AND be a real calendar date (round-trips through `new Date(s + 'T00:00:00Z').toISOString().slice(0,10) === s`) else **400 `{ error: 'Neplatný dátum', field: 'opens_at' \| 'closes_at' }`**. Writable on EVERY status (planning happens on `planned`, the deadline is edited while `open`, corrections after). |
| dates together | after applying the body, if both are non-null and `closes_at < opens_at` ⇒ **400 `{ error: 'Uzávierka nemôže byť pred otvorením', reason: 'dates_order' }`**, nothing written. |
| `stage` | if present: must be a string in `CYCLE_STAGES` (`helpers/cycle-stage.js`) else **400 `{ error: 'Neplatná fáza' }`** (non-string shapes land here too, never a 500). Then the EFFECTIVE status (`body.status ?? cycle.status`) must be `locked` else **409 `{ error: 'Fázu možno meniť len pri uzamknutom cykle', reason: 'not_locked' }`**. Any of the three values is accepted while locked, in any order — `ready → arrived` is a legal admin correction (the API is reversible; the UI offers forward buttons only, UC-CS-007 / §OPEN O3). |
| `status: 'locked'` (transition INTO locked from `open`) | `stage = body.stage ?? 'ordered'` (`LOCKED_STAGE_DEFAULT`) written in the same UPDATE. |
| `status: 'open'` while the cycle is `locked` (unlock) | `stage = NULL` in the same UPDATE. A body carrying both `status:'open'` and a `stage` is the 409 above (checked first). |
| `status: 'completed'` | `stage` untouched — it is the historical record of where the coffee ended; the step index derives from `status` first (UC-CS-005), so the stale value is never shown as current. |
| `status: 'locked'` when already locked | no stage change unless `body.stage` is present. |
| `status: 'planned'` | unchanged from today (the route accepts it; no stage semantics). |

> ⚠ **The parentheticals in the two `status: 'locked'` rows are SCOPES, not glosses**
> (clarified by FUP-T26, 2026-09-20, after the shipped guard read them as descriptive).
> This table partitions the lock rule by SOURCE status: from `open` (default `ordered`) and
> from `locked` (no change without an explicit `body.stage`). `completed → locked` and
> `planned → locked` are named by NEITHER, so neither authorises a stage write — the shipped
> `cycle.status !== 'locked'` fired from both, and on `completed` it RESET a handed-out
> round's `ready` to `ordered`, contradicting the `completed` row two lines up. The guard is
> now `cycle.status === 'open'`. The two fall-throughs the table DOES cover by leaving them
> alone — `locked → planned` (row: „unchanged from today") and `completed → open` (the
> unlock rule is scoped „while the cycle is `locked`") — keep their stale `stage`
> deliberately; `stageIndex()` reads `status` first, so neither reaches a screen. All of it
> is pinned server-side in `cycle-stages.spec.js` (`FUP-T26 · 17 §UC-CS-002`).

**Business rules:**

- **One home for the enum:** `CYCLE_STAGES = ['ordered','arrived','ready']` and
  `LOCKED_STAGE_DEFAULT = 'ordered'` are exported from `backend/src/helpers/cycle-stage.js`
  (UC-CS-003) and imported here — the CHECK constraint, the route and the helper must
  never disagree.
- Validation runs BEFORE any write; a 400/409 leaves the row byte-identical (the
  refusal tests read the row back).
- Response stays the full row (`SELECT *`, cycles.js:387) — the client reads the new
  fields from it.
- `GET /api/cycles` (cycles.js:52) and `GET /api/cycles/:id` carry the three fields
  (the list must add them to its column set if it enumerates columns).
- **`ADMIN_ENDPOINTS` (api-security.spec.js):** `PATCH /api/cycles/1` was never listed;
  it now writes `stage` and joins the sweep as
  `{ method: 'patch', path: '/api/cycles/1', data: { stage: 'arrived' } }` (01-architecture
  §Permissions lists „cycle stage PATCH“ as admin). No NEW route is introduced.
- No scheduler, no cron: `opens_at`/`closes_at` never change `status` by themselves
  (preliminary-cycle-design §Not in scope, restated). Locking remains the admin's click.

**Acceptance criteria:** `PATCH {opens_at:'2026-10-03'}` on a planned cycle ⇒ 200 and the
row reads it back; `{closes_at:'2026-13-40'}` ⇒ 400 `Neplatný dátum`, row unchanged;
`{opens_at:'2026-10-10', closes_at:'2026-10-03'}` ⇒ 400 `dates_order`; `{stage:'arrived'}`
on an OPEN cycle ⇒ 409 `not_locked`, `stage IS NULL` after; `{status:'locked'}` ⇒ 200 with
`stage:'ordered'`; then `{stage:'ready'}` ⇒ 200, `{stage:'arrived'}` ⇒ 200 (backward
allowed); `{status:'open'}` ⇒ 200 with `stage:null`; `{stage:'packed'}` ⇒ 400 `Neplatná
fáza`; `{stage:{}}`, `{stage:true}`, `{stage:[1]}` ⇒ 400 not 500; `{opens_at:{}}` ⇒ 200
with the stored value unchanged (FUP-T13 skip); anonymous PATCH ⇒ 401.

---

## UC-CS-003 `helpers/cycle-stage.js` — the enum + `markCycleReady()` seam (system)

**Goal:** this module OWNS the `stage` column and its one automatic transition; module
16 fires it. „First stage-3 bag → cycle stage `ready`“ (§11), nothing more (§16 Q8.c).

**Exports (`backend/src/helpers/cycle-stage.js`):**

- `CYCLE_STAGES`, `LOCKED_STAGE_DEFAULT` (UC-CS-002).
- `markCycleReady(cycleId) → { changed: boolean }` — executes exactly
  `UPDATE order_cycles SET stage = 'ready' WHERE id = ? AND status = 'locked' AND
  (stage IS NULL OR stage <> 'ready')`; `changed = (changes === 1)`.

**Business rules:**

- **Idempotent and monotonic in the forward direction only:** a second call is a no-op;
  it never writes `arrived` or `ordered`; it never touches `status` (⚠ no auto-complete —
  Q8.c); it is a no-op on a non-locked cycle (a hand-over on a completed cycle — the
  mis-click recovery case 16 allows — leaves `stage` as it was).
- **Synchronous, called INSIDE the caller's transaction**, after the hand-over row is
  stamped: `PATCH /api/orders/:id/handed-over` with `handed_over: true`, `PATCH
  /api/guest-orders/:id/handed-over` with `handed_over: true` (a Packeta guest is its own
  bag and counts as a first bag; the cycle comes from `guest_order_links.cycle_id`), and
  `POST /api/cycles/:id/distribution/hand-over` once per request (not once per row). The
  stage and the hand-over commit or roll back together.
- **Un-hand-over never reverts the stage.** Clearing `handed_over_at` (16's reversible
  mis-click path) calls nothing here; the admin corrects the stage by hand if they must
  (UC-CS-002 allows it).
- **`packed` never calls it.** Zabalené is the ledger moment (`helpers/packing.js`,
  untouched); the coffee is "ready" for the friend only when a bag has left the admin's
  hands.
- **Dependency, stated:** roadmap §18 row 5 (this module) depends on row 3 (16's
  `handed_over_at` + endpoints). The helper ships with this module; its e2e coverage
  (UC-CS-009 item 3) drives 16's endpoints and is what proves the seam connects. If 16 is
  not yet merged when this row is implemented, the helper is still written and unit-
  exercised through the admin `PATCH … {stage}` contract, and item 3 becomes a `⚠`
  seam note on 16's row.

**Acceptance criteria:** locked cycle, one packed order: hand-over ⇒ `stage='ready'`,
`status='locked'` unchanged; second hand-over on another order ⇒ `changed:false`,
stage still `ready`; un-hand-over ⇒ stage still `ready`; hand-over on a locked cycle
whose stage is NULL (pre-module row) ⇒ `ready`; `transactions` row count unmoved
(16's ledger-neutrality, re-asserted from this side).

---

## UC-CS-004 Payload publication — friend, public, guest and admin cycle payloads (system)

**Goal:** every surface that renders a cycle can derive the timeline without a new
request. Read-only, no new route.

**Changes:**

| Payload | Where | Change |
|---|---|---|
| `GET /api/friends/cycles` | friends.js:638-643 SELECT | add `c.opens_at, c.closes_at, c.stage` |
| `GET /api/cycles/:id/public` | cycles.js:153 SELECT | add `opens_at, closes_at, stage` |
| guest status payload `cycle` block | guest.js:187 SELECT + :428-434 `statusPayload` | add the three |
| guest listing payload `cycle` block | guest.js:543-549 | add the three |
| admin `GET /cycles`, `GET /cycles/:id`, PATCH response | cycles.js | carry the three (`SELECT *` already does; the list adds them if it enumerates) |

**Business rules:**

- Fields are appended; nothing is removed or renamed — every shipped key-shape pin
  (`portal-cycles`, `guest-status-shell`, `guest-order-shell`, `guest-invite-dead`) keeps
  passing; only the `localStorage` shape pins exist and they are not payload pins.
- `GUEST_ORDER_FIELDS` (`helpers/guest-orders.js`) is untouched — these are cycle fields,
  not sub-order fields (the 14 §UC-GR-006 one-list rule is about sub-orders).
- `routes/live-cycle.js` (admin live dashboard) is unchanged — it renders no stage.
- The friend/guest payloads stay free of `shared_password`, `markup_ratio` (public) and
  every other admin-only column exactly as today; the three new fields are not sensitive.

**Acceptance criteria:** a friend Bearer GET returns each cycle with the three keys
present (`null` allowed); the guest status GET for an order in a locked cycle returns
`cycle.stage` equal to the admin row; `/public` returns them without auth; no admin-only
column appears in either.

---

## UC-CS-005 `lib/cycle-stages.js` — step model, copy, date and „o n týždňov“ derivation (Friend/Guest)

> ⚠ **Amended by PO decision 2026-09-19** (see §PO decisions at the end of this file): `expected_date` is the DELIVERY expectation; `closes_at` is the deadline — copy helpers publish „Objednávky do {closes_at}“ and „Káva príde okolo {expected_date}“, falling back to `expected_date` as the deadline only when `closes_at` is NULL.

**Goal:** ONE dependency-free plain-JS home (`frontend/src/lib/cycle-stages.js`, imports
only `./plural.js`) for everything three modules print about a round's state, so the
copy cannot drift between the timeline, the closed modal (18), the banner (18) and the
pre-open guest page (19). Being plain ESM it is importable from a Playwright spec
(UC-CS-009 item 4).

**Step model (`STEPS`, index = position, coffee-only copy, vy-form, never „kolo“/„cyklus“):**

| # | `key` | `label` | `when` (only when derivable, else `''`) |
|---|---|---|---|
| 0 | `planned` | Pripravujeme ďalšiu objednávku | `opens_at` ⇒ „otvorí sa {fmtDay(opens_at)}“ |
| 1 | `open` | Objednávky otvorené | `closes_at` ⇒ „do {fmtDay(closes_at)}“ |
| 2 | `ordered` | Objednávky uzavreté, káva objednaná v pražiarni | `closes_at` ⇒ „{fmtDay(closes_at)}“ |
| 3 | `arrived` | Káva dorazila, balíme | `''` (no timestamp — resolved conflict 8) |
| 4 | `ready` | Zabalené, rozvážame | `''` |
| 5 | `completed` | Objednávka ukončená | `''` |

`desc` is `''` for every step in v1 (resolved conflict 8); the component exposes it so a
consumer may pass its own.

**Functions:**

1. `stageIndex(cycle)` — `cycle` null/undefined ⇒ `0`; `status === 'planned'` ⇒ `0`;
   `'open'` ⇒ `1`; `'locked'` ⇒ `stage === 'ready'` ? `4` : `stage === 'arrived'` ? `3` :
   `2` (⚠ `NULL`/unknown under locked reads as `ordered` — the no-backfill rule);
   `'completed'` ⇒ `5`; any other status ⇒ `0`. `status` is consulted BEFORE `stage`, so
   a stale `stage` on a completed cycle can never render as current.
2. `timelineSteps(cycle)` ⇒ six `{ key, label, when, desc, state }` with `state` =
   `'done'` for index < current, `'now'` for the current, `'next'` after.
3. `fmtDay(iso)` ⇒ `new Date(iso + 'T00:00:00').toLocaleDateString('sk-SK', { day:
   'numeric', month: 'long' })` — „3. októbra“ (ICU's Slovak long month in a date is the
   genitive, which is exactly the prototype's form); any non-matching / invalid input ⇒
   `''` (never throws, never prints „Invalid Date“). Year is never printed in these
   strings (the prototype prints none; the dates are always within a few weeks).
4. `daysUntil(iso, today = new Date())` ⇒ integer difference in calendar days between
   `today`'s local date and `iso` (UTC-midnight arithmetic on both, so DST cannot yield
   6.96 days); `null` on invalid input.
5. `inWeeksText(iso, today)` ⇒ `d = daysUntil(...)`; `d === null || d <= 0` ⇒ `null`
   (nothing to announce for a date that has passed or is today — the caller then prints
   the date alone); `d < 7` ⇒ `o ${daysLabel(d)}`; else `n = Math.round(d / 7)` ⇒
   `o ${weeksLabel(n)}`. New declensions in `lib/plural.js` (its one-home rule): `daysLabel`
   — 1 deň / 2–4 dni / 5+ dní; `weeksLabel` — 1 týždeň / 2–4 týždne / 5+ týždňov (the
   accusative after „o“, the prototype's „o 4 týždne“). §OPEN O6 records the <7-days
   default.
6. `nextOpeningText(plannedCycle, today)` ⇒ `{ date, inWeeks, text }` — R1.3's three
   branches with the R1.3/§16 wording: planned cycle with `opens_at` ⇒ `date =
   fmtDay(opens_at)`, `inWeeks = inWeeksText(opens_at)`, `text = 'Ďalšia objednávka sa
   otvorí približne ' + date` + (inWeeks ? ` (${inWeeks}).` : '.'); planned cycle without
   `opens_at` but with `plan_note` ⇒ `{ date: null, inWeeks: null, text: plan_note }`
   (verbatim, multiline preserved by the consumer's `white-space: pre-line`); no planned
   cycle ⇒ `{ date: null, inWeeks: null, text: 'O ďalšej objednávke dáme vedieť.' }`.
   Consumers (18's modal/banner, 19's pre-open page) lay the pieces out; they never
   re-compose the sentence from raw fields.
7. `openUntilText(cycle)` ⇒ `closes_at` ? `Objednávky otvorené · do {fmtDay(closes_at)}`
   : `Objednávky otvorené`.
8. `currentCycleFor(cycles)` ⇒ the round a landing/link should describe from a
   `GET /friends/cycles` array: the newest `open` (⚠ if two are open, the newest by
   `created_at, id` and a `console.warn` — R1.2), else the newest `locked`, else the
   newest `planned`, else `null` (18 and 19 both need this pick; two copies is how the
   landing and the link disagree about "the current round").

**Business rules:**

- No string in this file contains „kolo“, „kolá“, „cyklus“ or „cykl“ (pinned by a grep
  in UC-CS-009); no gendered participle addresses the reader.
- The lib is the ONLY place the six labels live; `CycleTimeline.vue`, module 18 and 19
  import them — never re-type them.

**Acceptance criteria (as unit checks inside the e2e spec):** the `stageIndex` table
above for all seven inputs incl. locked+NULL ⇒ 2 and completed+`ready` ⇒ 5;
`fmtDay('2026-10-03') === '3. októbra'`; `inWeeksText` for +1/+3/+6/+7/+18/+35 days ⇒
„o 1 deň“ / „o 3 dni“ / „o 6 dní“ / „o 1 týždeň“ / „o 3 týždne“ / „o 5 týždňov“; a past
date ⇒ `null`; `nextOpeningText` three branches produce exactly the strings above.

---

## UC-CS-006 `CycleTimeline.vue` — one component, two variants (Friend/Guest)

**Goal:** the single rendering of the six steps, mounted by three modules; the
prototype's `Timeline` and `Dots` ported as two variants of ONE Vue component
(`frontend/src/components/CycleTimeline.vue`) — never two components, never a fork per
consumer (the `CartLineList` one-home rule).

**Props:** `cycle` (object — any cycle payload row carrying `status`, `stage`,
`opens_at`, `closes_at`; may be `null` ⇒ index 0), `variant` (`'vertical'` default |
`'compact'`), `steps` (optional array overriding `timelineSteps(cycle)` — lets a consumer
inject `desc` lines; same shape). No other props; no emits.

**Vertical variant (`data-testid="cycle-timeline"`):** root `div.cs-tl`; per step
`div.st` with class `done`/`now`/`next` and `data-step="{key}"`; marker `span.mk` —
done: inline-SVG check (the prototype's `I.check` path, white on ink), now: the 1-based
index on accent with `3px 3px 0` ink shadow, next: the index, dashed border, faint
ink; `div.lbl`; `div.when` rendered only when non-empty; `div.desc` only when non-empty.
Connector: `.st::before` 3 px left rule from 28 px down, ink when done, 18 % ink
otherwise, none on the last step. Port `portal2.css:22-35` byte-equivalent; the `now`
label is display font, uppercase, 800, 20 px, `line-height:1` (inline where the cascade
would lose it — CLAUDE.md).

**Compact variant (`data-testid="cycle-timeline-compact"`):** root `div.cs-dots` with
`role="img"` and `aria-label="Krok {i+1} z 6: {label}"`; six `span.d` (class `now` on the
current, `next` after it, none before) interleaved with five `span.ln`. Port
`portal2.css:38-42`. ⚠ The caption row under the dots („Pauza · Objednávky · Doručenie“
in the closed modal) is the CONSUMER's (module 18) — the component renders dots only.

**Business rules:**

- **Styles are `<style scoped>`** with tokens read through fallbacks (`var(--nb-ink,
  #0a0a0a)`, `var(--accent, #ff2d87)`, `var(--accent-ink, …)`, `var(--font-mono,
  ui-monospace)`, `var(--font-display, inherit)`, …) and **no `.app`/`.modal-layer`
  ancestor selector** — the same markup renders inside `.app` (portal), inside the modal
  layer (18's closed modal) and inside the shadcn admin header (UC-CS-007). Nothing is
  added to `friends-theme.css`; nothing is added to admin CSS.
- A consumer must never mount it as a DIRECT child of `.app` (the `.app > *` cascade
  rule) — it sits inside a card or a modal body in every prototype placement.
- Text comes exclusively from `lib/cycle-stages.js`; the component contains no literal
  Slovak beyond the `aria-label` template.
- Renders identically for `type='bakery'` cycles (coffee-only copy, retiring type).
- Purely presentational: no fetch, no store, no `loadSeq` (it has no async).
- Print: the vertical variant needs no fold; both variants are inert under
  `emulateMedia({media:'print'})`.

**Acceptance criteria:** with a locked+`arrived` cycle the vertical variant renders
three `done`, one `now` with text „Káva dorazila, balíme“, two `next`, and no `.when`
on steps 3–5; with `opens_at='2026-10-03'` on a planned cycle step 0 shows `.when`
„otvorí sa 3. októbra“; the compact variant renders exactly 6 `.d` and 5 `.ln` and the
`aria-label` names the current step; the rendered text contains neither „kolo“ nor
„cyklus“; the component's computed style inside a bare `<div>` (no `.app`) still yields a
3 px ink border on `.mk`.

---

## UC-CS-007 Admin controls on `CycleDetail.vue` — dates, stage buttons, read-only header timeline (Admin)

**Goal:** §3.1's „one admin control on `CycleDetail.vue`“ plus the two stage buttons;
admin skin (shadcn, no `neo/` classes, no theme tokens outside the mounted component).

**Cycle settings card (CycleDetail.vue:1485-1518, beside „Očakávaný dátum objednávky“):**

| Field | Control | Save |
|---|---|---|
| `opens_at` | `<Label>Otvorenie objednávok</Label>` + `<Input type="date" v-model="opensAt">` + „Uložiť“ | `api.updateCycle(id, { opens_at: opensAt \|\| null })`, own `opensAtSaving` flag, `loadAll()` after — the `saveExpectedDate` pattern (:1069-1080) |
| `closes_at` | `<Label>Uzávierka objednávok</Label>` + `<Input type="date" v-model="closesAt">` + „Uložiť“ | `api.updateCycle(id, { closes_at: closesAt \|\| null })`, own `closesAtSaving` flag |

- Native `type="date"` emits ISO `YYYY-MM-DD` — exactly the server format, no client
  parsing. Empty ⇒ `null` ⇒ clear.
- ⚠⚠ **THIS BULLET AND THE „follow `saveExpectedDate`" INSTRUCTION ABOVE CONTRADICT EACH
  OTHER** (found and resolved in CS-T3, 2026-09-20). `saveExpectedDate()` keeps its
  `loadAll()` INSIDE the `try`, so a refused save never refetches and the rejected value
  STAYS IN THE INPUT — the opposite of snapping back. The snap-back requirement wins
  (CLAUDE.md is the tiebreaker), so the two new savers put `loadAll()` in `finally`; copy
  THEM, not `saveExpectedDate`. (`expected_date`/`plan_note` keep the old shape and it is
  unobservable: the route validates neither column, so neither has a 400 path at all.)
- A 400 (`Neplatný dátum` / `dates_order`) lands in `error.value` and the control snaps
  back to the stored value on the `loadAll()` refetch (CLAUDE.md: a refused change snaps
  the control back).
- „Očakávaný dátum objednávky“ (`expected_date`) and „Plán objednávky“ (`plan_note`)
  stay exactly as they are (resolved conflict 6, §OPEN O2).

**Header (CycleDetail.vue:1406-1437), when `cycle.status === 'locked'`:**

- A stage `Badge` next to the status badge with the friend-facing label from
  `STEPS[stageIndex(cycle)].label` (so the admin reads what the friend reads).
- Button **„Káva dorazila“** — rendered while `stage` is `null` or `'ordered'` ⇒
  `api.updateCycle(id, { stage: 'arrived' })`.
- Button **„Zabalené, rozvážame“** — rendered while `stage !== 'ready'` ⇒
  `api.updateCycle(id, { stage: 'ready' })`. Skipping „Káva dorazila“ is allowed (the
  server accepts any value); the hand-over (UC-CS-003) makes this button redundant on
  most cycles — it exists for the admin who distributes before the board is used.
- After `ready`: badge only, no stage buttons (forward-only UI; corrections via the API
  — §OPEN O3).
- Each button disables while its own request is pending; `loadAll()` after; errors to
  `error.value`. Uzamknúť/Odomknúť/~~„Označiť ako dokončený“ (:855-866)~~ **„Ukončiť
  objednávku“ (`markCompleted()`, `CycleDetail.vue` ~:926 / the button ~:1519 after DP-T8 —
  the line numbers MOVED, search the symbol, not the line)** send exactly what they send
  today — the server couples stage to status (UC-CS-002). ⚠ **This row SHARES that header
  with DP-T8's plan line** (`cycle-plan-line`, `lib/distribution-plan.js`, rendered for
  `locked`/`completed`): add the stage badge and timeline beside it, do not replace it, and
  do not re-derive its numbers — they are the server's `plan[]`/`totals`.

**Read-only timeline in the header (all statuses):** `<CycleTimeline :cycle="cycle"
variant="compact" />` inside the header block, followed by a muted line with the current
step's label. Shadcn chrome around it; the component's scoped styles are the one styled
island (the shared-across-skins precedent is `PickupLocationPicker.vue`, mounted by both
`FriendOrder` and the admin badge).

**Not in this module:** `AdminDashboard.vue` (cycle cards, create dialog) is unchanged —
the admin sets the dates on `CycleDetail` after creation (§OPEN O5); the distribution
board's manual „Ukončiť objednávku“ is module 16's.

**Acceptance criteria:** saving `opens_at` shows the stored value after reload; an
invalid pair shows the server message and the inputs revert; on a locked cycle the two
buttons appear, „Káva dorazila“ flips the badge to „Káva dorazila, balíme“ and hides
itself, „Zabalené, rozvážame“ then hides both; the compact timeline's `now` dot index
equals `stageIndex` for planned (0), open (1), locked+ready (4), completed (5); no
`neo/` class or `.app` wrapper appears in the diff to `CycleDetail.vue`.

---

## UC-CS-008 Guest status page mounts the timeline (Guest)

**Goal:** §3.2 — „the guest sees where their coffee is — replaces the bare status text“.
The guest's order page (`GuestOrderStatus.vue`, both URL forms of module 14) gains the
vertical timeline; the fields ride `statusPayload` (UC-CS-004), so no new request.

**Placement:** in the READ view (`data-testid="guest-status"`), directly after the
`status-paid` / `status-delivered` pill row (:537-540) and before the items list: a
`div.card` (`data-testid="guest-timeline-card"`) with a `div.field-lbl` **„Kde je vaša
káva“** and `<CycleTimeline :cycle="cycle" />`.

**Business rules:**

- Rendered when `cycle` is loaded and `!isCancelled` (a cancelled guest has no coffee to
  locate; the danger banner carries that state). Hidden in EDIT mode (the cart has the
  screen — the shipped pattern for `GuestInviteRequest`). Rendered in the OPEN state too
  (index 1, „Objednávky otvorené · do …“ is useful while they can still edit).
- The status-404 card (06 §UC-GX-010) is untouched — no cycle, no timeline.
- The pills stay: `paid` (admin's flag) and `delivered` (host's flag) are the GUEST's
  own bag's state; the timeline is the ROUND's state. Both are read-only.
- **Copy retarget (vocabulary rule, 00-overview glossary):** `readOnlyReason` (:166-168)
  „Objednávanie v tomto cykle je uzavreté, objednávku už nie je možné upraviť.“ becomes
  **„Objednávky sú uzavreté, objednávku už nie je možné upraviť.“** — sanctioned edit to
  `guest-status-shell.spec.js:356` (UC-CS-009 item 5). The dead-link branch (no „cyklus“)
  is unchanged.
- `document.title`, the payment block, `status-readonly` placement and every
  `data-testid` the shipped specs pin are unchanged.

**Acceptance criteria:** for a sub-order in a locked+`ready` cycle the card renders with
the `now` step „Zabalené, rozvážame“ and four `done` steps; a cancelled sub-order renders
no `guest-timeline-card`; entering edit mode hides it and leaving restores it; the
`status-readonly` banner reads the new sentence; the page contains neither „kolo“ nor
„cyklus“ (whole-document text sweep, non-vacuous: the card must be present).

---

## UC-CS-009 Verification — e2e obligations (system)

**Goal:** which shipped assertions this module edits (sanctioned, each cites its UC) and
what the new spec must pin. No unit runner (01-architecture §Testing): `node --check` on
every changed backend file, then Playwright.

1. **New `e2e/tests/cycle-stages.spec.js`** (fixtures per test, never a shared
   `beforeAll`; admin token adopted from the browser in UI+API tests):
   - **PATCH contract (UC-CS-002):** every acceptance line — valid dates, invalid date
     400, `dates_order` 400, stage on open 409 `not_locked`, lock ⇒ `ordered`, all three
     values incl. backward, unlock ⇒ `null`, complete keeps stage, invalid/non-string
     stage 400, unbindable date shape ⇒ 200 unchanged; **every refusal reads the row
     back** via `GET /api/cycles/:id`.
   - **Payloads (UC-CS-004):** the three keys present on `GET /friends/cycles` (Bearer),
     `GET /cycles/:id/public`, the guest status GET (both URL forms, byte-equal cycle
     block); no admin-only column leaked.
   - **Seam (UC-CS-003), through module 16's endpoints:** hand-over ⇒ `ready`;
     idempotent; un-hand-over keeps `ready`; guest-order hand-over on a Packeta guest
     ⇒ `ready`; `status` never changes; `transactions` count unmoved. ⚠ Self-skips with a
     named reason if `PATCH /api/orders/:id/handed-over` answers 404 (16 not merged) — a
     skip is reported, never silently green.
   - **Lib derivation (UC-CS-005):** `import('../../frontend/src/lib/cycle-stages.js')`
     directly (plain ESM, only `./plural.js`): the `stageIndex` table, `fmtDay`,
     `inWeeksText` declensions, `nextOpeningText` branches, `openUntilText`,
     `currentCycleFor` precedence; a regex sweep ~~`/kol[oáa]\b|cykl/i`~~ `/\bkol[oáa]|cykl/iu`
     over every string the module exports or builds ⇒ zero matches (non-vacuous: ≥ 6 labels
     checked). ⚠ **The struck regex is BROKEN IN BOTH DIRECTIONS** (CS-T2, 2026-09-20,
     measured): a trailing `\b` after `á` never fires, because `á` is outside ASCII `\w`, so
     it MISSES „kolá" — the very plural it bans — and it false-positives „okolo", which is
     module 18's own PO-approved „Káva príde okolo {expected_date}". The LEADING `\b` is the
     fix; the `u` flag is cosmetic.
   - **UI:** CycleDetail date save + revert-on-400 + stage buttons + compact `now` index
     (UC-CS-007); guest status page card, cancelled hides it, edit mode hides it, the new
     `status-readonly` sentence (UC-CS-008); vertical variant's `done/now/next` counts
     for a locked+`arrived` cycle; ~~the component's `.mk` border computed inside the admin
     page (no `.app`) is `3px solid`~~ — ⚠ **UNREACHABLE AS WRITTEN, retargeted by CS-T3
     (2026-09-20): §UC-CS-007 mounts `variant="compact"`, whose marker is `.d`, NOT `.mk`.**
     The claim is delivered on `.cs-dots .d`, which carries the byte-identical
     `border: 3px solid var(--nb-ink, #0a0a0a)`. ⚠⚠ And it CANNOT be moved to CS-T4 instead:
     the guest status page's root is `<div class="app …">`, and `.app` DEFINES
     `--nb-ink:#0a0a0a` — byte-identical to the fallback — so a computed-style read there
     would pass whether or not the fallback exists. **CS-T3's `.d` measurement is module 17's
     only runtime proof of the fallback mechanism**; per-declaration fallback coverage is
     CS-T2's source gate, not a second computed-style test.
2. **`api-security.spec.js` — `ADMIN_ENDPOINTS` +=** `{ method: 'patch', path:
   '/api/cycles/1', data: { stage: 'arrived' } }` (UC-CS-002). No public route is added,
   so the zero-external-requests sweep in `self-hosted-fonts.spec.js` is unchanged.
3. **`nonstring-body-shape.spec.js`** — the FUP-T13 `POST /api/cycles` describe (:1220)
   and the `PATCH /api/cycles/:id leaves every column UNCHANGED` read-back describe
   (:1296) add `opens_at`, `closes_at` (unbindable ⇒ skipped, 200) and `stage`
   (non-string ⇒ 400) to their field lists — additive rows, no existing assertion moves.
4. **`portal-cycles.spec.js`, `portal-fidelity.spec.js`, `portal-share-row.spec.js`,
   `guest-order-shell.spec.js`, `guest-invite-dead.spec.js`: NO edits** — payload
   additions are invisible to them; the `localStorage` key-shape pins concern the stored
   entry, not the cycle payload.
5. **`guest-status-shell.spec.js:356`** — `toHaveText('Objednávanie v tomto cykle je
   uzavreté, …')` retargets to „Objednávky sú uzavreté, objednávku už nie je možné
   upraviť.“ (UC-CS-008, vocabulary rule; case (a) of the e2e-immutability rule — the
   protected property, "read-only is explained", is unchanged). The other seven
   `status-readonly` visibility pins pass as-is.
6. **Procedure:** targeted files (`cycle-stages`, `guest-status-shell`, `guest-status`,
   `nonstring-body-shape`, `api-security`, `portal-cycles`) per row; the full suite only
   at the module milestone, `--workers=1`, all five `RATE_LIMIT_*_MAX` raised, output to
   a file (CLAUDE.md §Running the e2e suite).

---

## Seams (both sides must connect — for the orchestrator)

- **← 16 Distribution pipeline:** calls `markCycleReady(cycleId)` inside each hand-over
  transaction (single PATCH ×2, bulk ×1) when `handed_over: true`; never on clear, never
  on `packed`. 16's board may show `STEPS[stageIndex(cycle)].label` as the cycle line; its
  manual „Ukončiť objednávku“ sends `{status:'completed'}` — no auto-complete.
- **→ 18 Portal IA:** mounts `CycleTimeline` vertical in the locked-state „Kde je vaša
  káva“ card and compact in the closed modal (+ its own caption row); composes the
  closed modal/banner from `nextOpeningText()`, the open status line from
  `openUntilText()`, and picks the round with `currentCycleFor()`. Decides what the
  cartbar deadline prints now that `closes_at` exists (§OPEN O2). Fills `desc` if it
  wants the prototype's sentences.
- **→ 19 Standing guest link:** pre-open page prints `nextOpeningText()` („Ďalšia
  objednávka sa otvorí približne {date} ({o n týždňov})“).
- **→ 21 WhatsApp:** the „closing soon“ template reads `closes_at`; the „arrived“ /
  „ready“ stage changes are NOT notification triggers (hand-over is — §11).

## Dropped / Phase 2 (named so they are not silently implemented)

- Auto-open on `opens_at`, auto-lock on `closes_at` (no scheduler); auto-complete (Q8.c).
- Per-stage timestamps (`arrived_at`, `stage_changed_at`) and the prototype's „dnes,
  23. 9.“ / „≈ 25. 9.“ `when` lines; the prototype's `desc` sentences.
- Horizontal desktop layout of the timeline (§3.2) — superseded by the prototype.
- Per-party refinement of the `ready` label by delivery type („odovzdané na odberné
  miesto“ vs „Packeta“) — needs 16's `helpers/delivery.js` on the friend payload; Phase 2.
- Bakery-specific timeline copy; the 3-step guest explainer (19); the explainer's
  six phase cards (18); a public „Ako to funguje“ page (Q3.b, dropped project-wide).
- `AdminDashboard` create-dialog date fields; a stage badge on dashboard cycle cards.
- Backfilling `stage` on historical locked cycles.

## OPEN (surface to the PO / orchestrator; defaults chosen so `/plan-backlog` can proceed)

- **O1 Copy sign-off:** the six labels, especially „Pripravujeme ďalšiu objednávku“ and
  „Objednávka ukončená“ (mechanical kolo→objednávka substitution of §3.1's table — the PO
  may prefer e.g. „Všetko odovzdané“). Default: as tabled in UC-CS-005.
- **O2 `expected_date`:** today the ordering deadline in the live UI, „delivery
  expectation“ in the roadmap. Default here: untouched, unread; module 18 decides whether
  the cartbar/status line switch to `closes_at` and whether the admin label is renamed.
- **O3 Stepping back in the admin UI:** default forward-only buttons; the API accepts any
  of the three values for corrections.
- **O4 Six steps on the guest STATUS page** (Q3.a's "3 steps" is the link-page explainer):
  default six.
- **O5 Dates in the dashboard create dialog:** default none in this module.
- **O6 `inWeeksText` under 7 days:** default „o n dní“ with the 1/2–4/5+ declension; a
  passed date prints the date alone.

## PO decisions 2026-09-19 — OPEN items resolved

> Recorded by the orchestrator from the PO walkthrough. Each line resolves the `OPEN:` of the same name above; where a default was overturned the affected UC carries an amendment note.

- **O1 copy sign-off** deferred to staging review (labels stay as drafted).
- **O2 `expected_date`** = DELIVERY expectation from now on; `closes_at` = ordering deadline. Friends see „Objednávky do {closes_at}“ and „Káva príde okolo {expected_date}“. Existing rounds keep `expected_date` untouched; the cartbar deadline line switches to `closes_at` when present, else falls back to `expected_date` (module 18 renders; this module publishes both). ⚠ Amends UC-CS-005 copy helpers accordingly.
- **O3 admin step-back** = forward-only buttons; API accepts any stage.
- **O4 guest STATUS page** = all six steps.
- **O5 dashboard create dialog** = no date fields; detail page only.
- **O6 under 7 days** = „o n dní“ with declension (default).
