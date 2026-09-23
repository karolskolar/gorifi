# 19 — Standing guest link, pre-open guest page, waitlist, 3-step guest explainer

> Scope: A host's guest link stops being tied to one ordering round. (a) `friends.guest_link_token` —
> a per-host **standing link** minted lazily on first use, host-regenerable, same generator and entropy
> as every other guest token; (b) a rewritten resolution rule for `/g/:token`: a standing token resolves
> to the host's link for the **current open round** (the per-cycle `guest_order_links` row is created or
> reused server-side, so every shipped guest mechanism — stock, pricing, sub-orders, pickup store, host
> view, admin view, distribution, aggregation, rewards, recovery — keeps working untouched), or to the
> **pre-open page** when nothing is open; legacy per-cycle tokens keep working and fall through to the
> same pre-open page when their cycle is not open (today's 410 `closed` dead card on the listing is
> retired; 404 unknown and 410 `inactive` stay); (c) the pre-open page itself: host name, „Objednávky sú
> zatvorené“, the next opening (module 17 fields, `plan_note` fallback), the 3-step explainer, the
> roasters line, a faded read-only preview of the last round's catalogue, and the „Dajte mi vedieť“
> waitlist form; (d) the `guest_waitlist` table and its public, rate-limited, idempotent write;
> (e) the host's share dialog gains the standing link and a „kto čaká“ COUNT; (f) the admin sees waitlist
> rows in full and can delete them; purge rules (on order / after two completed rounds); (g) the compact
> 3-step strip on the OPEN guest hero with an expandable detail; (h) the waitlist becomes a named segment
> for module 21. Backend + schema changes.
> Out of scope (handoffs): guest Packeta at checkout and the `delivery_fee`/`packeta_address` columns →
> `20-guest-packeta.md`; sending anything (outbox, templates, `phone_e164` on `friends`, the composer,
> the `gorifi-wa` process) → `21-whatsapp-notifications.md` — this module only *stores* consent and
> exposes a segment; the explainer's content source (`lib/roasters.js`, the „Kto sme“ texts) →
> `18-portal-information-architecture.md` — consumed here, never redefined; `opens_at`/`closes_at`/`stage`
> and the timeline → `17-cycle-stages.md` — read here, never written; the friend-side placement of the
> share entry point (menu item / appbar) → module 18 (this module changes the dialog's CONTENT only).
> Actors: **Guest (public)** — holds a URL token (standing or legacy per-cycle); sees the pre-open page or
> the ordering page, may leave a waitlist contact; never sees a per-cycle token, a host's `invite_code`
> or any other guest's data. **Friend (host)** — Bearer session via `requireHost()`; reads/regenerates
> their own standing link; sees the waitlist as a COUNT only (never names or phones). **Admin** — reads
> the full waitlist and deletes rows; keeps module 14's per-cycle link powers unchanged; ~~gains no write
> on standing tokens in v1 (see §OPEN)~~ **reads + regenerates a host's standing token (PO 2026-09-19;
> shipped by GL-T1 as `GET/POST /api/friends/:id/guest-link/standing[/regenerate]`).**
> Sources: `docs/superpowers/specs/2026-09-03-roadmap-requirements.md` §17 (F9, R9.1–R9.4 + the privacy
> line — the NEWEST source, wins every conflict), §16 rows Q3.a (3-step guest explainer, default 3), Q3.b
> (no public page — the guest link carries the explainer), Q4.c (guest may order even when the host
> orders nothing), §13 (roasters line: Goriffee + Robo), §18 row 7, §3.3 (guest compact explainer copy),
> §1 R1.3 (closed-state copy variants, adapted to „objednávka“ wording per §16); prototype
> `docs/design/friends-portal-redesign/friends/guest2.jsx` (`GLink2` states `closed` / `open3`, `G2Steps`,
> `G2Roasters`) + README addendum 2026-09-06; `docs/specification/00-overview.md` (§Scope extension —
> roadmap October 2026, glossary „Standing link“, „Waitlist“), `01-architecture.md` (§Roadmap additions
> — `friends.guest_link_token`, `guest_waitlist`; §Permissions), `06-guest-flow.md` (UC-GX-001 hero,
> UC-GX-010 dead-link variants), `14-guest-order-recovery.md` (format reference; UC-GR-001/002 resolver
> model, UC-GR-004/012 admin link powers, D1/D2/D12); `docs/learnings/02-guest-shared-orders.md`
> (rate-limit buckets, the 410-cacheable lesson, GSO invariants); repo `CLAUDE.md` (Auth & boundaries —
> `routes/guest.js` is PUBLIC hostile input with bounds, five buckets, uniform 404, `invite_code` never in
> guest payloads, GA-T8 synchronous handlers); code `backend/src/routes/guest.js` (`resolveLink`,
> `validateIdentity`, `statusPayload`, `firstName`), `routes/guest-links.js` (`uniqueToken` — replaced by
> `helpers/standing-link.js uniqueGuestToken()` in GL-T1 —, the MIXED router contract), `db/schema.js` (`generateGuestToken`, `guest_order_links`), `middleware/rate-limit.js`,
> `frontend/src/views/GuestOrder.vue`, `components/GuestShareDialog.vue`, `GuestBrandHeader.vue`,
> `e2e/tests/self-hosted-fonts.spec.js` (the zero-external-requests sweep). The most recent decision wins
> on conflict.
> **Design reference:** `docs/design/friends-portal-redesign/Podpultovka Friends.html` → screen
> „Kolega · odkaz v2“ (`friends/guest2.jsx`), sub-states **Zatvorené** (pre-open page) and **Otvorené · 3
> kroky** (compact strip + expandable detail). Match the card order, the step tiles (numbered magenta
> dot, 3px ink border, `3px 3px 0` shadow), the faded `.p2-ro` preview and the form. Admin additions keep
> the shadcn look (01-architecture §Design system scope rule).

---

## Resolved conflicts (recency / canonicity)

1. **410 `closed` on the listing vs the pre-open page.** `routes/guest.js` `resolveLink(token, 410)` and
   06 §UC-GX-010 pin a dead card for a link whose cycle is not open; R9.1 (2026-09-06) says a link whose
   cycle is not open lands on the pre-open page. **R9.1 wins**: the LISTING `GET /api/guest/:token`
   answers 200 with a pre-open payload for every non-open cycle (planned, locked, completed). The SUBMIT
   `POST /api/guest/:token/orders` keeps 409 `closed` (the lock race is a race, not a state to explain).
   Dead-link variants that REMAIN: 404 unknown token, 410 `inactive` (link deactivated OR host inactive).
   Consequence: `guest-order.spec.js:174-185` and `guest-invite-dead.spec.js`'s `closed` variant are
   sanctioned retargets (UC-GL-011).
2. **Guest chrome chip/subtitle.** Prototype v2 shows a lock chip when closed and an „Otvorené“ chip when
   open, subtitle „Objednávka cez {host}“; shipped + pinned (`guest-order-shell.spec.js:170-172`) is
   `chip.acc` „Bez účtu“ + „Objednávka cez odkaz“. Resolution: **closed state = lock chip (prototype),
   open state keeps the shipped chip and subtitle.** The open hero + ticker already say the state, so the
   „Otvorené“ chip adds nothing worth a retarget; the subtitle stays one string for both states (§OPEN for
   the PO). The ticker DOES flip in the closed state (prototype) — via a boolean prop, not free text
   (UC-GL-006 rule 2), so 06's „no caller can fork the ticker“ intent survives.
3. **Duplicate waitlist phone → 200 (R9.2) vs „uniform responses, no oracle“ (R9.2, same line).** A 201
   on create and a 200 on duplicate would let a token holder test whether a phone is on the host's
   waitlist. Resolution: **both answer `200 { success: true }`** — the idempotency case is proven by the
   admin reading the row back, not by a status difference (UC-GL-004, D3).
4. **`friends.guest_link_token TEXT UNIQUE` (01-architecture) vs SQLite.** `ALTER TABLE … ADD COLUMN`
   cannot carry `UNIQUE`; the column is added plain and uniqueness is a `CREATE UNIQUE INDEX IF NOT EXISTS`
   (UC-GL-001). Same property, legal DDL.
5. **„Nothing planned“ copy.** R1.3 says „O ďalšom kole dáme vedieť.“; §16 forbids „kolo“. Adapted:
   **„O ďalšej objednávke dáme vedieť.“** (draft, §OPEN).
6. **Legacy per-cycle token while a NEWER round is open.** R9.1 says such a link „redirects to the same
   page“ (the pre-open page). Making old per-cycle links evergreen instead (resolve to the current round)
   REJECTED: it would turn every past link into a perpetual door with no host-side affordance to revoke
   old links. Resolution: the pre-open page renders in a **`stale` variant** — the round it belonged to
   is closed, a new one is open, „požiadajte {host} o aktuálny odkaz“, no waitlist form (UC-GL-003 rule 5).

---

## UC-GL-001 Standing token — schema + host routes (Friend/host)

> ⚠ **Amended by PO decision 2026-09-19** (see §PO decisions at the end of this file): admin ALSO gets read + regenerate of the standing token (`requireAdmin`, `ADMIN_ENDPOINTS`).

**Goal:** R9.1/R9.4 — a host has ONE cycle-independent guest URL they can copy at any time, and can
rotate it after a leak.

**Schema (`backend/src/db/schema.js`, the `try/catch ALTER` idiom; a column on a table already in prod
needs the ALTER — `friends` has no fresh CREATE path for it):**

- `ALTER TABLE friends ADD COLUMN guest_link_token TEXT` (nullable — NULL means „not minted yet“).
- `CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_guest_link_token ON friends(guest_link_token)` (resolved
  conflict 4). SQLite unique indexes ignore NULLs, so unminted friends do not collide.

**One home: `backend/src/helpers/standing-link.js`.**

- `uniqueGuestToken()` — `generateGuestToken()` (14 chars, `crypto.randomInt` over `CODE_ALPHABET`,
  SEC-S2 — never a second RNG) with a collision retry that checks **BOTH** `guest_order_links.token` and
  `friends.guest_link_token`. ⚠ `routes/guest-links.js`'s private `uniqueToken()` is REPLACED by this
  helper — the two token spaces share one resolver (UC-GL-002), so a value must be unique across both.
- `ensureStandingToken(friendId)` — returns the friend's token, minting on first call:
  `UPDATE friends SET guest_link_token = ? WHERE id = ? AND guest_link_token IS NULL`, then re-SELECT.
  Idempotent; a `SQLITE_CONSTRAINT*` on the unique index (theoretical) retries with a fresh token. This is
  the ONLY writer of the column besides `regenerateStandingToken`.
- `regenerateStandingToken(friendId)` — `UPDATE friends SET guest_link_token = ? WHERE id = ?`. Nothing
  else moves: no `guest_order_links` row, no `active` flag, no sub-order is touched (UC-GL-002 rule 6).
- `standingUrlPath(token)` → `` `/g/${token}` `` — one composer, consumed by the host dialog payload and by
  module 21's `{odkaz}` placeholder.

**Routes — `routes/guest-links.js` (the MIXED router; every route states its guard on its first line;
never wrap the mount). Both HOST-only, `requireHost()` identity — the host is the Bearer session, never a
body field (SEC-A1):**

| Route | Behaviour |
|---|---|
| `GET /api/guest-links/standing` | `ensureStandingToken(host.friendId)` (⚠ the ONE deliberate write inside a GET in this router — recorded as D1: R9.4 says the host can copy the link „any time“, so the link has no „not yet created“ state on the host side) → `{ standing: { token, url_path, created: <bool, true only on the call that minted> }, waiting_count: <int>, current: { cycle_id, name, status } | null }`. `waiting_count` per UC-GL-008 rule 1 **(GL-T1: UC-GL-008 has no numbered rule. The count is the host's `guest_waitlist` rows with `notified_at IS NULL` — the people who asked to be told and have not been told yet. This spec implies that reading three times: UC-GL-004 rule 4 RE-ARMS a row on re-signup by resetting `notified_at = NULL`, which only means something if NULL is „still waiting"; UC-GL-010's segment is `WHERE w.notified_at IS NULL`, and 21 §UC-WA-007's acceptance says that after release „the segment then counts 0"; and the copy the count feeds (UC-GL-008 item 1) is „N ľudí čaká na váš odkaz". A notified row stays visible to the admin until a purge (UC-GL-005). One home: `helpers/standing-link.js waitingCount()`)**. `current` = the open cycle per UC-GL-002 rule 2, or null. |
| `POST /api/guest-links/standing/regenerate` | `regenerateStandingToken` → `200 { standing: { token, url_path }, regenerated: true, waiting_count }`. **No `has_orders` gate** (D2): rotating the standing token strands nobody — every created sub-order resolves by `order_token` alone (14 D2), and the per-cycle link stays valid under its own token, so colleagues mid-order who followed the per-cycle URL are unaffected; colleagues who followed the STANDING URL and have not ordered yet lose the door, which is the point of regenerating after a leak. |

- Both handlers are synchronous (no `async`/`await` — the GA-T8 rule).
- The friend's OWN payloads (`GET /api/friends/me`-style profile routes) do not gain the token; the
  standing route is its only publishing surface on the friend side **(GL-T1: the standing route PAIR — `GET` and
  `POST …/regenerate` both answer `standing.token`; with the admin pair, FOUR publishing routes in all)**. ~~`sanitizeFriend` needs no change
  (the token is not a login credential)~~ **SUPERSEDED by GL-T1: `sanitizeFriend` DOES strip it.
  `GET /api/friends/:id/profile` is `SELECT *` → `sanitizeFriend`, so „no change" would have published
  the token on the friend's own profile, contradicting the sentence before it. „Not a login credential"
  is true but is not the function's test — it also strips `invite_code`, which is not one either; it
  strips credentials of ANY surface, and the admin reads the token through its own route below.** And ⚠ **no guest payload may ever carry
  `friends.guest_link_token`** — the `LINK_SELECT` in `routes/guest.js` must not add it, exactly like
  `friends.invite_code` (CLAUDE.md). The guest already holds the URL they followed; the server never
  echoes a token back.
- `api-security.spec.js`: both routes join **`FRIEND_IDENTITY_ENDPOINTS`** (admin token ⇒ 401, shared
  password ⇒ 401 — an admin token is not host identity), never `ADMIN_ENDPOINTS`.
- `api.js`: `getStandingGuestLink()`, `regenerateStandingGuestLink()` (`request()` with the Bearer
  session, beside `getGuestLink`/`createGuestLink`).

**Business rules:**

1. Minting requires an ACTIVE host: `requireHost()` already rejects a deactivated friend's session; a
   deactivated host's existing token stays in the row but resolves 410 (UC-GL-002 rule 4) — mirroring the
   per-cycle `host_active` gate. **GL-T1 (review decision): the rule is enforced in `helpers/standing-link.js`
   for EVERY caller, not only by the host session — the admin routes (PO block) answer 409
   `reason:'inactive_host'` for an inactive friend with NO token (read or regenerate; nothing is minted),
   while an inactive friend's EXISTING token stays readable and rotatable (revocation).**
2. Two consecutive `GET`s return the same token (`created: true` then `false`); the row is never
   re-minted by a read.
3. Regeneration is in place on the `friends` row; the old token answers 404 to a new visitor the next
   request (the same uniform „Tento odkaz na objednávku neexistuje“ as any unknown token).

**Acceptance criteria:** first GET mints a 14-char `[A-Z2-9]` token and a second GET returns it
unchanged; regenerate changes it, the old token then 404s on `/api/guest/:old`, and the host's per-cycle
link token (if any) plus every sub-order and `order_token` are byte-identical before/after; admin token
and shared password get 401 on both routes; the token never appears in any `/api/guest/*` response body.

---

## UC-GL-002 Token resolution rule for `/g/:token` (Guest, system)

**Goal:** one resolver in `routes/guest.js` understands both token spaces, so every existing guest route
(`GET /:token`, `POST /:token/orders`, and the new `POST /:token/waitlist`) works for a standing URL
without a second code path — and every shipped guest mechanism keeps operating on a real
`guest_order_links` row.

**Replaces `resolveLink(token, closedStatus)` with `resolveEntry(token, { forSubmit })`**, returning one of:

- `{ kind: 'order', link, cycle }` — the shipped orderable state (`cycle.status === 'open'`, link active,
  host active). Byte-identical downstream behaviour.
- `{ kind: 'preopen', host, staleCycle | null, openElsewhere }` — the pre-open state (UC-GL-003).
- `{ status: 404 | 410 | 409, error, reason }` — a refusal.

**Lookup order and rules:**

1. `guest_order_links.token = ?` first, then `friends.guest_link_token = ?` (`String(token || '')`
   coercion on both). Both miss ⇒ **404 `'Tento odkaz na objednávku neexistuje'`** — the SAME message and
   shape as today for every miss, whichever table was consulted (no oracle about which space a string
   belongs to).
2. **„The current round“** = `SELECT id … FROM order_cycles WHERE status = 'open' ORDER BY id DESC LIMIT 1`.
   00-overview fixes „at most one open cycle“; if the data ever holds two, the newest is used and one
   `console.warn` line is logged (R1.2's rule, restated for the guest side). No `type` filter (bakery is
   retiring; a type filter would silently strand a host if the last bakery cycle is the open one).
3. **Standing token hit** (`friends` row `h`):
   - `h.active = 0` ⇒ **410 `reason:'inactive'`**, the shipped message (a deactivated host's link keeps
     no door open — the same rule `resolveLink` applies to `host_active`).
   - No open cycle ⇒ `preopen` with `staleCycle = null`, `openElsewhere = false`.
   - Open cycle `c` ⇒ **get-or-create** the per-cycle row: `INSERT INTO guest_order_links (token,
     host_friend_id, cycle_id, active) VALUES (?, ?, ?, 1)` with `uniqueGuestToken()`, then SELECT by
     `(host_friend_id, cycle_id)`. The `UNIQUE(host_friend_id, cycle_id)` constraint makes it idempotent;
     a `SQLITE_CONSTRAINT*` (unreachable under `instances: 1` + synchronous handlers, but translated
     anyway — GA-T8 idiom) falls through to the SELECT. Then apply the shipped gates on THAT row:
     `link.active = 0` ⇒ **410 `inactive`** (D4 — deactivating the round's link means „no new colleague
     orders this round“, and the standing link is a resolver, not a second door around that decision);
     else `{ kind: 'order', link, cycle: c }`.
   - ⚠ The per-cycle row's `token` NEVER reaches the guest: the listing/submit/status payloads carry no
     link token today and gain none; the page keeps calling the API with the token it was opened with.
     A standing visitor therefore cannot learn the per-cycle URL, and regenerating the standing token
     fully revokes it for new visitors (UC-GL-001 rule 3).
4. **Legacy per-cycle token hit** (`guest_order_links` row `l`, joined with the host as today):
   - `l.active = 0 OR host_active = 0` ⇒ **410 `inactive`** (unchanged).
   - cycle missing ⇒ 404 (unchanged degenerate case).
   - `cycle.status = 'open'` ⇒ `{ kind: 'order' }` (unchanged).
   - `cycle.status ≠ 'open'` ⇒ **`preopen`** with `staleCycle = l.cycle`, `openElsewhere = (an open cycle
     exists per rule 2)` — resolved conflict 6. ⚠ The legacy token does NOT get-or-create anything and
     does NOT resolve to the newer open cycle.
5. **`forSubmit: true`** (the `POST /:token/orders` caller): a `preopen` outcome is converted to
   **409 `reason:'closed'`** with ~~the shipped message („Objednávanie v tomto cykle je už uzavreté.“)~~
   **the `CLOSED` message — re-worded by GL-T7 to „Objednávky sú už uzavreté, objednávku už nie je možné
   odoslať.“ (18 §UC-PI-017's vocabulary rule, PO draft; status + `reason` byte-identical, learnings 11
   §GL-T7)** — the lock-race contract is unchanged, for both token spaces. The `waitlist` caller (UC-GL-004) handles
   `order` and `preopen` itself.
6. **Nothing else moves.** `resolveGuestOrderByOrderToken`, the `/o/:orderToken` routes, the legacy pair
   routes, `statusPayload`, `handleInviteRequest` are untouched — sub-orders created through a standing
   URL hang off a real per-cycle row, so recovery (14), host view (05), admin view, distribution,
   `helpers/stock.js` (UNION own+guest), `helpers/guest-aggregation.js`, rewards and
   `helpers/pickup.js` (the per-(host, cycle) row IS the pickup store for a host without an `orders`
   row — get-or-create keeps that row existing exactly when it did before) all see ordinary data.
7. **Route ordering hazard restated:** the `/o/…` routes stay registered BEFORE `/:token`; the new
   `POST /:token/waitlist` is registered with the other `/:token/*` routes. No literal segment can collide
   with a 14-char uppercase token.
8. Handlers stay synchronous; the get-or-create is a plain check-then-write safe only under
   `instances: 1` (CLAUDE.md) — state it in the code comment.

**Acceptance criteria (matrix, each row its own token/fixture — the 410-cacheability lesson in
`guest-invite-dead.spec.js`):** standing + open cycle ⇒ 200 listing whose `cycle.id` is the open cycle
and whose body contains no `token` key; the host's `GET /guest-links/cycle/:id` then returns a row
`created_at` ≥ the visit; a second visit creates no second row; a sub-order submitted through the
standing URL appears under that row in the host view; standing + no open cycle ⇒ 200 `page:'preopen'`;
standing + per-cycle row deactivated ⇒ 410 `inactive`; inactive host ⇒ 410; legacy + locked cycle ⇒ 200
`preopen` with `stale_cycle.name`; legacy + locked while a newer cycle is open ⇒ `preopen` with
`open_elsewhere: true`; unknown ⇒ 404 with the one message (`new Set` of the 404 messages across
garbage / retired-per-cycle / retired-standing tokens has size 1); submit through a standing token with
no open cycle ⇒ 409 `closed`.

---

## UC-GL-003 Pre-open payload — `GET /api/guest/:token` when nothing is orderable (Guest)

**Goal:** everything the pre-open page (UC-GL-006) renders, in one read, under `guestReadLimiter`.

**Response `200`:**

```
{
  page: 'preopen',
  host: { first_name },                       // firstName(), the shipped rule: first name only
  next: {
    kind: 'planned_date' | 'planned_note' | 'unknown' | 'open_elsewhere',
    opens_at: 'YYYY-MM-DD' | null,            // module 17 column; null when absent
    plan_note: string | null,
    cycle_name: string | null                 // the planned (or, for open_elsewhere, the open) cycle
  },
  stale_cycle: { id, name } | null,           // legacy-token case only (UC-GL-002 rule 4)
  preview: { cycle: { id, name }, products: [...] } | null,
  waitlist: { available: boolean }
}
```

**Business rules:**

1. **`next`** — computed server-side so both token spaces and both clients agree:
   - `open_elsewhere` when UC-GL-002 reported `openElsewhere` (legacy token only): `cycle_name` = the open
     cycle's name; `opens_at`/`plan_note` null.
   - else the next planned cycle: `SELECT … WHERE status = 'planned' ORDER BY (opens_at IS NULL),
     opens_at ASC, id ASC LIMIT 1` — `planned_date` when it has `opens_at`, `planned_note` when it has
     only `plan_note`, `unknown` when there is no planned cycle or it has neither.
   - ⚠ `opens_at` is module 17's column. If 17 has not landed, the column is absent: read it defensively
     (`SELECT` guarded by a `PRAGMA table_info` check, or `COALESCE` behind a try) and report
     `planned_note`/`unknown`. **Open dependency on 17 for the date variant** — the page works without it.
2. **`preview`** — the last round's catalogue, read-only: `preview.cycle` = `SELECT … WHERE status IN
   ('locked','completed') ORDER BY id DESC LIMIT 1` (null ⇒ `preview: null`, the page hides the block);
   `products` = the shipped `PRODUCT_COLUMNS` query for that cycle, `p.active = 1`, `ORDER BY p.purpose,
   p.name`, **`LIMIT 12`** (bounded — a public read of historical data), prices through `withMarkup()`
   exactly as the live listing (the prototype shows priced, disabled cards). **No `availability`**
   (R1.3: stock badges hidden when closed) and no `stock_limit_g` semantics on the client.
3. **`waitlist.available`** = `next.kind !== 'open_elsewhere'` (when a round is open the guest should be
   ordering, not waiting — and a stale link must not collect contacts for a round already in progress).
   The server flag decides the form's presence (the „an affordance the server would refuse must never
   be on screen“ rule from `statusPayload`); `POST …/waitlist` enforces the same condition (UC-GL-004).
4. **No payment settings, no host contact data, no per-cycle token, no `invite_code`, no counts of other
   guests** — an anonymous read of a closed round carries strictly less than the live listing.
5. **`Cache-Control: no-store`** on this response (and on the live listing, one line in the same
   handler): the `guest-invite-dead.spec.js` lesson — Chromium served a cached 410 after the server's
   answer changed. A guest who bookmarked the standing URL and returns after the round opened must get
   the live page, not yesterday's „zatvorené“.
6. `stale_cycle` is the legacy row's cycle (`{id, name}` only); null for standing tokens.

**Acceptance criteria:** with one planned cycle carrying `opens_at` the payload says `planned_date` with
that date; with only `plan_note` ⇒ `planned_note`; with no planned cycle ⇒ `unknown`; `preview.products`
length ≤ 12 and each has a marked-up `price_*`; body has no `iban`, `revolut_username`, `token`,
`invite_code`, `availability` keys; response header `cache-control` contains `no-store`; the legacy-token
case with a newer open cycle returns `waitlist.available: false` and `next.kind: 'open_elsewhere'`.

---

## UC-GL-004 `guest_waitlist` — table + public write `POST /api/guest/:token/waitlist` (Guest)

**Goal:** R9.2 — a guest on the pre-open page leaves name + mobile + WhatsApp consent, once per (host,
phone), through the app's hostile-input boundary with the guest bounds and bucket.

**Schema (`schema.js`, guest tables block — a NEW table, CREATE only; later tasks add no migration for it
unless a column is genuinely new on a table already in prod):**

```
CREATE TABLE IF NOT EXISTS guest_waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_friend_id INTEGER NOT NULL,
  cycle_id INTEGER,                              -- the LAST round at signup (preview cycle), for the purge rule
  name TEXT NOT NULL,
  phone TEXT NOT NULL,                           -- as entered
  phone_e164 TEXT,                               -- derived; NULL when it does not normalise
  whatsapp_opt_in INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notified_at DATETIME,                          -- written by module 21 only
  FOREIGN KEY (host_friend_id) REFERENCES friends(id) ON DELETE CASCADE,
  FOREIGN KEY (cycle_id) REFERENCES order_cycles(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_waitlist_host_e164
  ON guest_waitlist(host_friend_id, phone_e164) WHERE phone_e164 IS NOT NULL;
```

**One home for phone normalisation: `backend/src/helpers/phone.js` → `toE164(raw, { defaultCountry =
'SK' } = {})`** — the implementation is module 21's UC-WA-002 (**`libphonenumber-js`**, `isValid()` gate,
returns E.164 or `null`, never throws); this module ships that exact helper if it lands first and 21 then
adopts it unchanged (orchestrator reconciliation 2026-09-19 — the earlier regex sketch is superseded). ⚠ Module 21 CONSUMES
this helper for `friends.phone_e164` (R5.4) — it is defined here because the waitlist's idempotency key
needs it first. Own-property, type-safe input (`String(raw ?? '')`).

**Route (`routes/guest.js`, `guestWriteLimiter` — the existing bucket; no new limiter, CLAUDE.md „never
collapse the five“):**

1. `resolveEntry(token)`: 404 / 410 as UC-GL-002 (uniform). `kind: 'order'` (a round is open for this
   host) ⇒ **409 `reason:'open'`**, „Objednávka je práve otvorená — môžete si objednať rovno.“ (the form
   is not shown in that state; this is the server-side half of UC-GL-003 rule 3). `preopen` with
   `openElsewhere` ⇒ the same 409 `open`.
2. **Body `{ name, phone, whatsapp_opt_in }`** — validated by the shipped `validateIdentity(body,
   WAITLIST_IDENTITY_FIELDS)` with a field map of `name`/`phone` only (name required, ≤ 120; phone
   required, ≤ 32; `asString()` coercion; the identical Slovak bound messages). E-mail is NOT accepted
   (ignored if sent). `whatsapp_opt_in` → `body.whatsapp_opt_in ? 1 : 0` (any truthy ⇒ 1; absent ⇒
   **0** — consent is never implied by omission, even though the checkbox defaults on in the UI).
   Unbindable body shapes (`{}`, `true`, `[1]`, `'abc'`) ⇒ 400, never 500 (CLAUDE.md).
3. `phone_e164 = toE164(phone)`; `cycle_id` = the preview cycle's id from UC-GL-003 rule 2 (null if none).
4. **Idempotency per (host, phone):** if `phone_e164` is non-null ⇒ look up `(host_friend_id,
   phone_e164)`; else ⇒ `(host_friend_id, phone)` exact on the raw string. Existing row ⇒ `UPDATE SET name
   = ?, whatsapp_opt_in = ?, cycle_id = ?, notified_at = NULL WHERE id = ?` (latest submission wins on
   name/consent; re-signing up after a past notification re-arms the row for the next round;
   `created_at` untouched). No row ⇒ INSERT with literal column names. A `SQLITE_CONSTRAINT*` on the
   unique index (lost race) is translated into the same UPDATE path — never a 500, never the SQLite
   message.
5. **Response: `200 { success: true }` for BOTH create and duplicate** (resolved conflict 3, D3). No ids,
   no count, nothing about other rows.
6. No `transactions` row, no `invitations` row, no mail, no notification — this is a contact record only.
7. Handler synchronous.
8. ⚠ PUBLIC by design; must **never** join `ADMIN_ENDPOINTS`; joins the guest zero-external-requests
   surface via the page (UC-GL-011 item 5). `api.js`: `joinGuestWaitlist(token, data)` via
   `guestRequest()` (no auth headers).

**Acceptance criteria:** a valid submit answers 200 and the admin list (UC-GL-009) shows one row with
`phone_e164 = '+421905123456'` for input `0905 123 456`; a second submit with `+421 905 123 456` and a new
name answers 200 and the list STILL has exactly one row for that host, carrying the new name; name of 121
chars ⇒ 400 and the list has NO row (refusal read back); phone of 33 chars ⇒ 400, no row; the four
unbindable shapes ⇒ 400; open cycle ⇒ 409 `open`, no row; unknown token ⇒ 404 whose message equals the
listing's 404 message; inactive host ⇒ 410, no row; `whatsapp_opt_in` omitted ⇒ stored 0; the 429 body
comes from the `guestWrite` bucket (extend `rate-limit-isolation.spec.js`'s route table — it self-skips
unless the env caps are low).

---

## UC-GL-005 Waitlist purge rules (system)

**Goal:** R9's privacy line — „purged when the guest orders or 2 rounds pass“. No scheduler exists
(01-architecture §Shared services), so both purges are synchronous hooks at the moment the condition
becomes true.

**Business rules:**

1. **On order.** Inside the submit transaction of `POST /api/guest/:token/orders` (after the sub-order
   INSERT commits its rows, still inside the same `db.transaction`): `DELETE FROM guest_waitlist WHERE
   phone_e164 = ? AND phone_e164 IS NOT NULL` with `toE164(guest_phone)`; when the guest's phone does not
   normalise, delete on `(link.host_friend_id, phone) exact` instead. **Across ALL hosts** when E.164
   matches (D5): the person is now a customer of this round; a second host's row would only produce a
   duplicate „objednávka je otvorená“ message. ⚠ The submit stays synchronous; the DELETE is one extra
   statement inside the existing transaction, not a new code path.
2. **After two rounds.** In `routes/cycles.js`, on the admin `PATCH /cycles/:id` transition to
   `status = 'completed'` (module 17 does not auto-complete — the admin presses „Ukončiť“), run once:
   `DELETE FROM guest_waitlist WHERE (SELECT COUNT(*) FROM order_cycles c WHERE c.status = 'completed'
   AND c.id > COALESCE(guest_waitlist.cycle_id, 0)) >= 2`. A row signed up „against“ round N (its
   `cycle_id` = the last closed round at signup) is purged when rounds N+1 and N+2 have both completed —
   i.e. the guest was offered two openings and ordered in neither. Rows with `cycle_id` NULL (no round
   existed at signup) count from 0.
3. Admin delete (UC-GL-009) is the manual third path.
4. No other writer deletes waitlist rows; `ON DELETE CASCADE` from `friends` covers a deleted host.

**Acceptance criteria:** a waitlist row for phone P under host A and another under host B; a guest
orders with phone P through host A's standing link ⇒ both rows gone, the sub-order exists; a row with
`cycle_id = N`; completing cycle N+1 leaves it, completing N+2 removes it; a row created while no round
ever existed (`cycle_id NULL`) is removed at the second completion.

---

## UC-GL-006 Pre-open page — `GuestOrder.vue` state `preopen` (Guest)

**Goal:** prototype `GLink2` sub-state **Zatvorené**, transcribed. The view gains a fourth top-level state
next to loading / dead / order / confirmation, keyed on `payload.page === 'preopen'`.

**Structure (source order, `.app` root, page column max-width 760, padding 16/28, gap 14 — the UC-GX-001
scaffold):**

1. **`GuestBrandHeader`** with `subtitle="Objednávka cez odkaz"` (resolved conflict 2) and a NEW boolean
   prop **`closed`** (default `false`). When `closed`: the `#trailing` chip becomes
   `span.chip` with `NeoIcon name="lock"`, `title="Objednávky sú zatvorené"` (no text), and the ticker
   switches to a SECOND module-level constant
   `GUEST_TICKER_CLOSED = '+++ OBJEDNÁVKY ZATVORENÉ +++ DÁME VEDIEŤ, KEĎ SA OTVORÍ +++'` (fixed text —
   the prototype's „O 4 TÝŽDNE“ is demo data; a constant cannot carry the count, and the date lives in
   the hero). ⚠ Still no free-text ticker prop — a boolean picks between two constants, so no caller can
   fork the ticker (06 §UC-GX-001's intent survives).
2. **Hero `.card.hl`** (`data-testid="preopen-hero"`): `span.badge` **„Zatvorené“** · `h1.h-screen`
   (30/38) **„Objednávky sú zatvorené“** (prototype breaks „zatvorené“ onto its own highlighted line) ·
   `.sub` 14.5px: **„<b>{host.first_name}</b> vás pozýva do spoločnej objednávky výberovej kávy.“**
   followed by the `next` sentence:
   - `planned_date`: **„Ďalšia objednávka sa otvorí približne <b>{d. mmmm}</b> ({o N týždňov}).“** —
     date formatted `sk-SK` day + month name (`3. októbra`); the parenthesis via a new
     `lib/plural.js` `weeksAwayLabel(days)`: days ≤ 6 ⇒ „už tento týždeň“, else N = `Math.round(days/7)`
     ⇒ „o 1 týždeň“ / „o 2–4 týždne“ / „o 5+ týždňov“; a past `opens_at` ⇒ omit the parenthesis.
     **(GL-T5: shipped as written, `days` = `lib/cycle-stages.js daysUntil()`. ⚠ It DIFFERS from 17's
     `inWeeksText()` for the same sentence on the friend side — 17's PO decision O6 prints „o n dní“
     under a week and nothing for today; this draft prints „už tento týždeň“ for 0–6. Two registers,
     one shared declension (`weeksLabel`); PO question raised in the GL-T5 report, not resolved at a
     call site.)**
   - `planned_note`: **„Ďalšia objednávka: {plan_note}“** (admin text verbatim).
   - `unknown`: **„O ďalšej objednávke dáme vedieť.“** (resolved conflict 5).
   - `open_elsewhere` (stale legacy link): h1 becomes **„Táto objednávka je už uzavretá“**, `.sub`:
     **„{host.first_name} má práve otvorenú novú objednávku. Požiadajte {host.first_name} o aktuálny
     odkaz.“** (name repeated to avoid a gendered pronoun for the host).
   Then the **roasters line** (UC-GL-007 rule 4).
3. **„Ako to funguje“ card** — `div.field-lbl` „Ako to funguje“ + `GuestSteps` full layout (UC-GL-007).
4. **Waitlist card** (`data-testid="waitlist-form"`, rendered only when `waitlist.available`):
   `.display` 22px **„Dajte mi vedieť“** · `.sub` **„Pošleme jednu správu, keď sa objednávka otvorí. Nič
   viac.“** · field **Meno** (`inp`, placeholder „Meno a priezvisko“, `maxlength=120`, required) · field
   **Mobil** (`inputmode="tel"`, placeholder „09xx xxx xxx“, `maxlength=32`, required) · `NeoCheckbox`
   (three-zone label pattern, 02 §UC-DS-009) **„Súhlasím so správou cez WhatsApp“**, default CHECKED ·
   `button.btn.accent.block` **„Chcem vedieť, keď sa otvorí“**, disabled while pending or while either
   required field is empty. Client validation mirrors the server bounds (`maxlength`); server errors
   render in a `.banner.danger.slim` inside the card (`data-testid="waitlist-error"`).
   - Success ⇒ the card is REPLACED by `.banner.ok` (`data-testid="waitlist-done"`): **„<b>Dáme
     vedieť.</b> Keď sa objednávka otvorí, príde vám správa na WhatsApp s odkazom od {host.first_name}.“**
     when opted in; **„<b>Dáme vedieť.</b> Keď sa objednávka otvorí, {host.first_name} vám pošle odkaz.“**
     when the box was unticked (draft, §OPEN — see also the consent question there).
   - Success is remembered per token in `localStorage` (`gorifi_guest_waitlist` = ~~`{ [token]: iso }`~~
     **`{ [token]: { at: iso, whatsapp_opt_in, cycle_id } }` (GL-T5: the bare ISO string cannot say
     WHICH of the two banners to re-show, nor expire with the round — `cycle_id` is the preview round,
     i.e. the server row's own `cycle_id`; an entry for a different round shows the form again)**,
     try/catch, per-viewer convenience only) so a reload shows the banner, not the form again. Not a
     source of truth — the server's idempotency is.
5. **Preview block** (only when `preview` non-null): header row `span.field-lbl` **„Minulá ponuka ·
   {preview.cycle.name}“** + `span.sub.mono` 12px **„len na prezretie“**; then a `div.p2-ro` wrapper
   (opacity `.55`, `pointer-events: none`, `user-select: none` — scoped style) holding the shipped
   cat-tabs + `GuestProductGrid` in a **`disabled`** mode: steppers absent, add-to-cart absent, no stock
   badges (there is no `availability`), images and prices as delivered. ⚠ `GuestProductGrid.vue` +
   `lib/guest-cart.js` are one-home components — EXTEND with a `readonly` prop, never fork a preview grid.
   Cards beyond the server's 12 do not exist; no „zobraziť viac“.
6. **No cartbar, no checkout modal, no invite CTA** in this state (the CTA needs a sub-order).
7. `document.title` = **„Objednávky sú zatvorené – Podpultovka“** in this state (draft).

**Business rules:**

- The dead card (06 §UC-GX-010) keeps the `notfound` and `inactive` variants; the `closed` variant's copy
  and branch in `GuestOrder.vue` are REMOVED (unreachable: the listing never answers 410 `closed` any
  more). The „anything else“ fallback stays.
- The page never composes a token into the DOM beyond the URL it is on; the payload contains none.
- Phone-first: no horizontal overflow at 320 px; all controls ≥ 44 px; 16 px inputs under `pointer:
  coarse` (A12).
- Slovak copy is DRAFT, vy-form, no participle addressing the reader („vás pozýva“, „príde vám“ are
  fine; the host as a third party may carry a participle).

**Acceptance criteria:** against the prototype's Zatvorené state at 378 px: badge, split headline, host
sentence with the date variant, roasters line, three step tiles, form, preview at reduced opacity; the
form submit flips to the ok banner and a reload keeps the banner; the preview's cards expose no enabled
button (`preopen` root `button:enabled` count = the form's one button before submit, 0 after); 320 px
no h-overflow; the dead card still renders for 404 and 410 `inactive`.

---

## UC-GL-007 3-step guest explainer — `GuestSteps.vue`, compact strip on the open hero (Guest)

**Goal:** Q3.a (default: guests get 3 steps) + §3.3 + §13. One component, two layouts, consumed by the
pre-open page (full) and the open ordering page (compact strip + expandable full detail).

**Component `frontend/src/components/GuestSteps.vue`** — props `compact: Boolean`, `hostName: String`.
Content (prototype `G2.steps`, verbatim; `{host}` interpolated with `hostName`):

| # | icon | title (`.display` 19 / 14 compact) | detail (`.sub` 13.5, full layout only) |
|---|---|---|---|
| 1 | cup | Objednáte | Vyberiete kávu, zadáte meno a mobil. Bez registrácie. |
| 2 | box | Zabalíme | Kávu nakúpime v pražiarni a zabalíme. Vtedy zaplatíte cez QR alebo Revolut. |
| 3 | hand | Prevezmete | Od {host}, alebo si ju nechajte poslať cez Packetu. |

- Tile: 44 px (34 compact) white box, 3px ink border, radius 10, `3px 3px 0` ink shadow, inline SVG icon
  (self-hosted, CSP — new `NeoIcon` names `cup`, `box`, `hand` if absent), a 20 px magenta numbered dot
  at the top-left corner (`.mono`, 2px ink border). Full = vertical list, gap 14; compact = three columns,
  centred, gap 8, titles only.
- ⚠ Step 3's Packeta clause is TRUE only once module 20 ships guest Packeta. Until then the text reads
  **„Od {host}.“** — implemented as a prop `packeta: Boolean` (default `false`) that appends the clause;
  module 20 flips it on when `cycle.parcel_enabled`. Named here so 20 does not have to rediscover it.
- Content source: the step texts are constants in this component (they are guest-specific and do not
  exist in module 18's six-step content). The **roasters line** (rule 4) is NOT: it reads
  `lib/roasters.js` (module 18's one home for Goriffee / Robo texts). Open dependency: if 19 lands
  before 18, 19 creates `lib/roasters.js` with exactly the two prototype entries and 18 extends it — never
  a second copy.

**Open hero (`GuestOrder.vue`, `kind: 'order'` state — amends 06 §UC-GX-001 item 4):**

1. Below the „Spoločná objednávka · organizuje {host}“ line and above the badge row: `GuestSteps compact`
   (`data-testid="guest-steps-compact"`).
2. Below it a row: the roasters line (left) + `button.btn.ghost.sm` in accent colour
   (`data-testid="guest-steps-toggle"`) **„Viac o tom, ako to funguje“** ↔ **„Skryť“**, toggling a
   `GuestSteps` full layout under a 2px divider (`data-testid="guest-steps-detail"`), collapsed by
   default, state not persisted.
3. The badge row („Login netreba“ · „Platba prevodom“ · „Tovar odovzdá {host}“) and the helper sentence
   stay — the prototype v2 drops the badges, but the shipped pins in `guest-order-shell.spec.js` and
   `guest-order.spec.js` are not worth a retarget for a subtraction (D6; §OPEN for the PO).
4. **Roasters line** (`GuestRoastersLine.vue`, `.sub` 13px): **„Káva od <badge>Goriffee</badge>
   (pražiareň) a <badge class="acc-o">Robo</badge> (domáci pražič, SCA výbery).“** — texts from
   `lib/roasters.js`; PO polishes (Q13.a).

**Acceptance criteria:** the pre-open page shows three tiles with details; the open page shows three
titles without details, the toggle reveals the details and flips its label; with `packeta` false the
third detail ends after „Od {host}.“; the compact strip fits at 320 px without wrapping a title onto
two lines above 12 px.

---

## UC-GL-008 Host share dialog — standing link + „kto čaká“ count (Friend/host)

**Goal:** R9.4 — `GuestShareDialog.vue` shows the standing link first, with the waiting count; the
per-cycle link becomes the secondary, legacy section. Component API stays frozen (`open` / `cycleId` /
`cycleName`, `update:open`); ~~the standing section works with `cycleId = null` (module 18's menu entry
opens the dialog when no round is open)~~ **— CORRECTED by the GL-T6b review: the component supports
`cycleId = null`, ~~but that is source-pinned only: the drawer share item is `state === 'open'`-only (`FriendPortalSession.vue:1513,1539`), the ONE dialog instance lives in `FriendOrder.vue` bound to `activeCycleId`, and the closed landing has no `landingOrder` ref — so no UI path opens it with `cycleId = null`; the entry point is **GL-T6c**~~.** **— DONE by GL-T6c: the drawer row now opens the ONE instance on the locked and closed-with-catalogue landings, and `FriendOrder.vue` passes `cycleId = null` (`shareCycleId`) on its read-only mounts; a closed landing with no catalogue mounts no `FriendOrder` and keeps no row (recorded gap, learnings 11 §GL-T6c).**

**Data:** on open, `api.getStandingGuestLink()` (`loadSeq`-guarded like the existing GET; both requests
may run in parallel, each drops a stale result). `cycleId` present ⇒ the existing per-cycle GET runs too,
unchanged.

**Structure (additive; ~~the shipped pins in `share-dialog.spec.js` / `guest-link.spec.js` /
`guest-order-recovery.spec.js` must pass~~ **CORRECTED by GL-T6b (orchestrator sanction 2026-09-23, option (a)): they could not pass unmodified — a second `NeoCopyRow` breaks `.copyrow` counts and strict `Kopírovať` locators, and item 3 contradicts the per-cycle native-share url pins. Those exact pins were retargeted (scoped to `data-testid="per-cycle-link"`, native-share url → the standing token), each marked `// SANCTIONED RETARGET (GL-T6b, …)`; nothing else in the three files changed. Learnings 11 §GL-T6b.** — see the placement constraints below):**

1. **Standing section** at the top of the body (`data-testid="standing-link"`): `div.field-lbl` **„Stály
   odkaz pre kolegov“** · `NeoCopyRow :value="standingUrl" value-testid="standing-link-url"` (full origin
   + `url_path`, composed in JS) · `div.field-help` (`data-testid="standing-copy"`): **„Tento odkaz platí
   stále — pred otvorením objednávky, počas nej aj po nej. Kolegovia cez neho uvidia aktuálnu objednávku,
   alebo sa zapíšu, aby dostali správu, keď sa otvorí.“** · the **count line** (`data-testid=
   "waiting-count"`, rendered only when `waiting_count > 0`): `span.badge.acc` + text via a new
   `lib/plural.js` `waitingLabel(n)`: **„1 človek čaká na váš odkaz“ / „2–4 ľudia čakajú na váš odkaz“ /
   „5+ ľudí čaká na váš odkaz“**. ⚠ COUNT ONLY — the payload carries no names/phones (UC-GL-001), so the
   dialog cannot render them even by mistake; pinned by asserting the standing payload has no `name`,
   `phone`, `rows` keys.
2. **Regenerate (standing):** `button.btn.ghost.sm` **„Nový stály odkaz“** → inline `.confirmbox`-style
   box (`data-testid="standing-confirm"`, a `div` with its own class `standing-confirm`, NOT `.confirmbox`
   — that class's exact copy and single `<b>` are pinned): **„Starý stály odkaz prestane fungovať.
   Objednávky, ktoré kolegovia už vytvorili, zostanú funkčné.“** / **„Áno, vygenerovať“** / **„Nie“** →
   `POST /guest-links/standing/regenerate` → copy row updates in place. No `has_orders` gate (UC-GL-001
   D2), so no blocked state exists here.
3. **Native share** (`navigator.share`, when available) prefers the standing URL; `text` stays the
   shipped `'Pridajte sa k mojej objednávke - {cycleName || 'objednávka'}'` — ~~⚠ that fallback
   string says „cyklus“; module 18's wording pass owns it~~ **DONE by PI-T11 (18 §UC-PI-017): the
   fallback now reads „objednávka“.**
4. **Per-cycle section** (everything shipped) moves BELOW, under `div.field-lbl` **„Odkaz len na túto
   objednávku“**, rendered only when `cycleId` is set. All of its elements, testids, copy, the
   `regen-blocked` / `regen-guidance` / `share-standing-copy` lines and the `.confirmbox` are untouched.

**Placement constraints (verified against the shipped specs):**

- ⚠ No new `p.sub` in the dialog (`dialog.locator('p.sub')` is single-element pinned); the new lines are
  `field-help` / `field-lbl`.
- ⚠ No new `<b>` inside `#subtitle`; the count badge lives in the body.
- ⚠ `share-dialog.spec.js:602` pins that the rendered dialog HTML never contains a sub-order
  `order_token` — unchanged; the standing token IS rendered (it is a share URL, like the per-cycle one).
- ⚠ The unscoped `getByRole('button', {name: /Zdieľať/})` locators in `guest-host-view.spec.js:890,929`:
  the new buttons are „Nový stály odkaz“ / „Áno, vygenerovať“ / „Nie“ — none matches `/Zdieľať/`. Keep
  it so.
- The dialog stays `v-if`-mounted (the RD-KG-2 rule).

**Acceptance criteria:** opening the dialog with no open cycle shows the standing section and NOT the
per-cycle section ~~**(GL-T6b review: source-pinned only: the drawer share item is `state === 'open'`-only (`FriendPortalSession.vue:1513,1539`), the ONE dialog instance lives in `FriendOrder.vue` bound to `activeCycleId`, and the closed landing has no `landingOrder` ref — so no UI path opens it with `cycleId = null`; the entry point is **GL-T6c**; GL-T6c owns this clause)**~~ **(RESTORED by GL-T6c — now
behaviour-pinned in `portal-landing.spec.js` §3 from the drawer row on the locked and closed landings)**; with an open cycle both render in that order; the copy row value matches
`/\/g\/[A-Z2-9]{14}$/`; the count line is absent at 0 and reads „1 človek čaká na váš odkaz“ after one
waitlist submit; regenerate changes the row value and the old URL 404s; ~~every shipped share-dialog spec
passes unmodified~~ **— CORRECTED by GL-T6b: every shipped share-dialog spec passes with ONLY the
sanctioned retargets (see the Structure note above).**

---

## UC-GL-009 Admin — waitlist read + delete, `CycleDetail.vue` „Čakajúci hostia“ (Admin)

> ⚠ **Amended by PO decision 2026-09-19** (see §PO decisions at the end of this file): this admin surface also shows the host's standing link with „Vygenerovať nový“.

**Goal:** R9.3 („the admin sees the list under the cycle“) + the privacy line („to the admin in full;
deletable“).

**Routes — NEW router `routes/guest-waitlist.js`, ADMIN-only throughout, mounted behind `requireAdmin` in
`index.js` (a single-audience router, so wrapping the mount is correct here — unlike the MIXED routers):**

| Route | Behaviour |
|---|---|
| `GET /api/guest-waitlist` | `{ rows: [{ id, host_friend_id, host_name, name, phone, phone_e164, whatsapp_opt_in, cycle_id, cycle_name, created_at, notified_at }] }` — `JOIN friends`, `LEFT JOIN order_cycles`; `ORDER BY host_name COLLATE NOCASE, created_at DESC, id DESC`. Optional `?host_friend_id=` filter (integer, else ignored). |
| `DELETE /api/guest-waitlist/:id` | 404 unknown; else DELETE ⇒ `200 { success: true }`. |

- `ADMIN_ENDPOINTS` += `GET /api/guest-waitlist`, `DELETE /api/guest-waitlist/1` (the standing CLAUDE.md
  rule). `api.js`: `getGuestWaitlist(params)`, `deleteGuestWaitlistRow(id)`.
- No admin write of `notified_at` here (module 21 owns it) and no admin create.

**UI — `CycleDetail.vue` orders tab, a card „Čakajúci hostia ({N})“ below the guest sections (admin
shadcn skin, no `neo/` classes):** loaded non-blocking with a `loadSeq` guard (the `loadGuestUnpaid`
precedent). Rows grouped by `host_name`; columns **Meno · Mobil · WhatsApp (áno/nie) · Zapísané (date) ·
Upozornené (date or —)**; per-row **„Odstrániť“** with inline confirm and per-row pending (`rowSeq`).
Empty state **„Nikto nečaká.“**. The card is cycle-independent data — it renders on every cycle's orders
tab identically (the PO asked for it „under the cycle“; the data has no cycle owner). Draft copy, §OPEN.

**Acceptance criteria:** anonymous / friend Bearer ⇒ 401 on both routes; the list shows `phone_e164` and
`host_name`; delete removes the row and the host's `waiting_count` drops by one; the card renders the
row and the empty state.

---

## UC-GL-010 Seams — module 17 fields in, module 21 segment out (system)

**Consumed from 17 (read-only):** `order_cycles.opens_at` for `next.kind = 'planned_date'` (UC-GL-003);
nothing else. This module never writes a cycle column.

**Exposed to 21 (defined here so the composer builds against a contract, not a guess):**

- **Segment `waitlist`** (`helpers/segments.js`, module 21's home — the SQL is stated here for the seam):
  `SELECT w.id, w.host_friend_id, w.name, w.phone_e164, f.name AS host_name, f.guest_link_token FROM
  guest_waitlist w JOIN friends f ON f.id = w.host_friend_id WHERE w.notified_at IS NULL AND
  w.whatsapp_opt_in = 1 AND w.phone_e164 IS NOT NULL AND f.active = 1`. Rows with `phone_e164 IS NULL` or
  `whatsapp_opt_in = 0` are listed by the composer as „bez platného čísla“ / „bez súhlasu“ (R5.4/R5.5) —
  never sent.
- **Recipient kind** `waitlist`, `recipient_id = guest_waitlist.id` in the outbox (01-architecture's
  `notifications` shape already names it).
- **Template key `waitlist`**: **„{host} vám otvoril objednávku kávy: {odkaz}“** (R9.3; the participle
  refers to the host, a third party). `{odkaz}` = `` `${PUBLIC_BASE_URL}${standingUrlPath(
  ensureStandingToken(host_friend_id))}` `` — the STANDING link, minted lazily if the host never opened
  the dialog (UC-GL-001 helper), never a per-cycle token.
- **`notified_at`** is written by 21 when a row's message reaches `sent`; 19 resets it to NULL on
  re-signup (UC-GL-004 rule 4). Nothing in 19 sends.
- **Trigger moment:** the segment is meaningful when a cycle turns `open`; 21 decides whether opening
  *proposes* the message (nothing fires without an admin „Poslať“ — 00-overview).

---

## UC-GL-011 Verification — e2e obligations, supersessions, CSP sweep (system)

**1. `api-security.spec.js`:** `ADMIN_ENDPOINTS` += `GET /api/guest-waitlist`, `DELETE
/api/guest-waitlist/1`. `FRIEND_IDENTITY_ENDPOINTS` += `GET /api/guest-links/standing`, `POST
/api/guest-links/standing/regenerate`. ⚠ `POST /api/guest/:token/waitlist` and the pre-open read are
PUBLIC and must NOT join `ADMIN_ENDPOINTS` (the `/api/guest/o/…` precedent).

**2. Sanctioned retargets (case (a) of the immutability rule — re-point, cite the UC in a comment):**
- `guest-order.spec.js:174-185` „410 when the cycle is not open (locked or planned)“ ⇒ both cases now 200
  with `page: 'preopen'`; ADD the counter-pin that `POST /api/guest/:token/orders` on the same locked
  cycle is still 409 `closed` (UC-GL-002 rule 5).
- `guest-invite-dead.spec.js` `COPY.closed` + the `deadLink(…, 'closed')` variant (:379-383, :403-405,
  :428-431) ⇒ the locked-cycle link renders `preopen-hero` with „Objednávky sú zatvorené“ and NO
  `guest-unavailable` card; the `notfound` and `inactive` variants stay verbatim.
- ~~Everything else in `guest-order`, `guest-status`, `guest-host-view`, `guest-admin-view`,
  `guest-order-recovery`, `share-dialog`, `guest-link`, `guest-order-shell` passes UNMODIFIED~~
  **CORRECTED by GL-T2 (orchestrator sanction 2026-09-23): two more assertions pinned the retired
  listing 410 as a side fact and are retargeted to 200 `page:'preopen'` (§UC-GL-002 rule 4 / D7) —
  `guest-status.spec.js:598` and `guest-order-recovery.spec.js:1296` (+ a submit-409 counter-pin);
  see learnings 11 GL-T2 §9. Everything else in those files passes unmodified** — the
  open-state chip/subtitle/ticker pins hold (resolved conflict 2), the dialog's per-cycle section is
  untouched (UC-GL-008), and standing-token visitors create ordinary rows. **⚠ CORRECTED AGAIN by GL-T6b:
  „untouched" is true of the per-cycle section's own DOM, not of the three dialog specs — the standing
  section's second `NeoCopyRow` + item 3 forced sanctioned retargets in `share-dialog` (12 pins),
  `guest-link` (2) and `guest-order-recovery` (2); see UC-GL-008's Structure note.**

**3. New `e2e/tests/guest-standing-link.spec.js`** (fixtures per test, never a shared `beforeAll`; one
token per matrix row — the cached-410 lesson): UC-GL-001 mint idempotency + regenerate (old 404, per-cycle
token/sub-orders/order_tokens byte-identical, 401s); the UC-GL-002 matrix incl. get-or-create (host GET
returns the row; guest body has no `token`; a submit through the standing URL lands in the host view and
in `helpers/stock.js` availability); the UC-GL-003 payload shape/`no-store`; UI: pre-open page fidelity
testids, preview has no enabled control, dead card still for 404/410 `inactive`; the open hero's compact
strip + toggle (UC-GL-007); the dialog's standing section and order of sections (UC-GL-008).

**4. New `e2e/tests/guest-waitlist.spec.js`:** the UC-GL-004 acceptance list — MUST include (a) the
**refusal test that reads the row back** (121-char name ⇒ 400 AND `GET /api/guest-waitlist` filtered by
the host has zero rows; same for the 33-char phone, the 409 `open` and the 410 `inactive` cases — every
refusal proves nothing was written), (b) the **idempotency case** (`0905 123 456` then `+421 905 123 456`
⇒ two 200s, ONE row, `phone_e164 = '+421905123456'`, name = the second submission), (c) uniform 404
message equality with the listing 404, (d) `whatsapp_opt_in` omitted ⇒ 0, (e) the UC-GL-005 purges
(across-host purge on order; two-completions purge with a `cycle_id NULL` row), (f) the host count via
`GET /guest-links/standing` (`waiting_count` increments; body has no `name`/`phone` keys), (g) admin
delete → count decrements, (h) unbindable bodies ⇒ 400, (i) `rate-limit-isolation.spec.js` route table +=
the waitlist POST under the `guestWrite` bucket (self-skipping as documented).

**5. `self-hosted-fonts.spec.js` — the zero-external-requests sweep:** add a route row **`/g/:token
(preopen)`** = a standing token of a host in a DB state with no open cycle (or a legacy token on a locked
cycle) with allowlist `[]`. The existing `/g/:token` row keeps rendering the LIVE page — both states of the
one public route are swept, because the pre-open page pulls its own components (steps SVGs, roasters
line, form). Inline SVG only; no new font, no new external asset; CSP in the THREE copies unchanged.

**6. `node --check`** on every changed backend file; the UC-GR-011 describe's „zero `async`/`await` in
`routes/guest.js`“ pin must still pass — the new handler and the resolver rewrite stay synchronous.

**Procedure:** targeted files first (`guest-standing-link`, `guest-waitlist`, `guest-order`,
`guest-invite-dead`, `guest-order-shell`, `share-dialog`, `guest-link`, `guest-host-view`,
`guest-order-recovery`, `api-security`, `self-hosted-fonts`, `rate-limit-isolation`); full suite at the
module milestone with `--workers=1`, all five `RATE_LIMIT_*_MAX` raised, output to a file.

---

## Decisions (module-level, recorded)

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | The standing token is minted lazily by the host's `GET /guest-links/standing` (one idempotent `UPDATE … WHERE guest_link_token IS NULL`). | A separate „Vytvoriť stály odkaz“ POST + empty state — R9.4 wants the link copyable any time; an extra click and an extra state buy nothing. |
| D2 | Standing regenerate has NO `has_orders` gate. | Mirroring 14 D12 — that gate protects colleagues mid-order on the per-cycle URL, which the standing rotation does not touch; sub-orders resolve by `order_token` alone. |
| D3 | Waitlist POST answers `200 { success: true }` on create AND duplicate. | 201/200 split — a phone-membership oracle for anyone holding the token; R9.2's „no oracle“ outranks REST convention. |
| D4 | A standing token inherits the per-cycle row's `active` flag (deactivated ⇒ 410 `inactive`). | Treating the standing link as a second, independent door — two gates for one host's round drift, and „deaktivovať“ would silently stop meaning „no new colleague orders“. |
| D5 | On order, waitlist rows are purged by `phone_e164` across ALL hosts. | Same-host only — a second host's row would only produce a duplicate „objednávka je otvorená“ message for a person who already ordered. |
| D6 | The open hero KEEPS the shipped badge row and helper sentence; the compact strip is added above them. | Prototype v2's badge-less hero — a subtraction that would force retargets in `guest-order-shell.spec.js`/`guest-order.spec.js` for no information gain; PO may still drop them (§OPEN). |
| D7 | Legacy per-cycle links whose cycle is closed render the pre-open page in a `stale` variant (no waitlist when a newer round is open) and never resolve to the newer round. | Evergreen old links — an unrevocable door class (no host affordance lists past links). |
| D8 | The pre-open listing sends `Cache-Control: no-store`. | Relying on default caching — the 410-cache incident in `guest-invite-dead.spec.js` shows a guest would see yesterday's state after the round opened. |
| D9 | `toE164` lives in `helpers/phone.js` from module 19 on; module 21 consumes it. | Waiting for 21 — the idempotency key needs it now; two normalisers would produce two keys. |

---

## Accepted risks / follow-ups (recorded, not silently implemented)

- **A standing URL is a perpetual door** until the host regenerates it (that is its purpose); a leak
  costs the host one „Nový stály odkaz“ click and a re-send. Same risk class as the per-cycle link, now
  without the natural expiry at lock. Mitigated by per-cycle `active` (D4) and by the 14-char CSPRNG token.
- **The pre-open page discloses a host's first name and the last round's catalogue with prices to any
  holder of any past per-cycle token** — the live listing already disclosed more to the same holders
  while the round was open. Accepted.
- **A public GET writes a row** (get-or-create of the per-cycle link, UC-GL-002 rule 3) — only for a valid
  standing token of an active host with an open round; the row is inert data the host's own POST would
  create identically. Rides `guestReadLimiter`. **(GL-T2:) the SUBMIT (`POST …/orders`, `guestWriteLimiter`)
  gets-or-creates the same row BEFORE identity/items validation, so a rejected standing submit may still leave
  that (identical, inert) row behind — same bound: a valid standing token, an active host, an open round.**
- **Waitlist rows are contact data of non-members without a channel until module 21 lands**; until then
  the admin reaches them manually from the „Čakajúci hostia“ card. The two-round purge bounds retention.
- **`opens_at` date variant is dark until module 17 lands** — the page degrades to `plan_note`/`unknown`.
- ~~**The share-sheet `text` still says „objednávkový cyklus“** in its fallback — module 18's wording pass.~~ **DONE by PI-T11: „objednávka“.**
- **Step 3's Packeta clause is gated off until module 20** (`packeta` prop) — named so 20 flips it, and
  nobody „fixes“ the missing clause early.
- **CLAUDE.md staleness when this lands:** the Auth & boundaries bullet „`order_token` alone resolves a
  guest order … `routes/guest.js` is the ONLY place it authenticates“ stays true; ADD one line: „a
  `/g/:token` token is a per-cycle link token OR a `friends.guest_link_token`; `helpers/standing-link.js`
  is the one home for minting both spaces uniquely; the per-cycle token never reaches a standing
  visitor“; and the 06 §UC-GX-010 `closed` variant row must be struck (`~~…~~ SUPERSEDED by 19
  §UC-GL-002`). **DONE: the CLAUDE.md line landed with GL-T2 (the resolver bullet) + GL-T1 (the
  one-home bullet), GL-T7 added „the per-cycle token never reaches a standing visitor“ to it; the 06 row
  was struck by GL-T2 and its remaining copies (06's scope line, the UC title, the acceptance clause,
  `guest-invite-dead.spec.js`'s describe) by GL-T7.**

---

## OPEN items

- `OPEN:` PO sign-off on ALL drafted Slovak strings (hoist them as constants in the new spec files, the
  14-module two-place-edit precedent): the closed ticker, „Zatvorené“ / „Objednávky sú zatvorené“ /
  „Táto objednávka je už uzavretá“, the four `next` sentences incl. „O ďalšej objednávke dáme vedieť.“
  and the `weeksAwayLabel` forms, the waitlist card copy + button + the two success banners, „Minulá
  ponuka“ / „len na prezretie“, the standing-section lines in the dialog + confirm box + „Nový stály
  odkaz“, `waitingLabel` forms, the admin card labels, the server's 409 `open` message, and
  `document.title`. **+ GL-T7's vocabulary re-wordings (the four `routes/guest.js` 409s, the two host
  409s in `routes/guest-orders.js`, `GuestProductGrid`'s empty message — learnings 11 §GL-T7 table).** Roaster texts are Q13.a (PO polishes in `lib/roasters.js`, module 18).
- `OPEN:` **WhatsApp consent unticked** — default here: the submit is still accepted, the row is stored
  with `whatsapp_opt_in = 0`, module 21's segment excludes it, and the success banner omits WhatsApp.
  Alternative: require the tick to submit (the form then has no purpose without consent, but the admin
  could still call). PO decides; the default needs no schema change either way.
- `OPEN:` **Guest chrome in the open state** — keep the shipped „Bez účtu“ chip + „Objednávka cez odkaz“
  subtitle (this spec's default, resolved conflict 2) or adopt prototype v2's „Otvorené“ chip and
  „Objednávka cez {host}“ subtitle (two retargets in `guest-order-shell.spec.js:170-172`)? Also D6 (keep
  the badge row).
- `OPEN:` **Admin powers over standing tokens** — v1 gives the admin none (read via the friend row is
  possible in the DB, no route). Module 14 §UC-GR-004's forwarding use case („preposlať link“) is served
  by the admin's per-cycle create route, which the standing resolver materialises identically. Should the
  admin be able to read/regenerate a host's standing link (e.g. a host who lost access)? Default: not in
  v1; add as `GET/POST /guest-links/standing/host/:friendId[/regenerate]` under `requireAdmin` if asked.
  **→ RESOLVED YES (PO 2026-09-19, block below); GL-T1 shipped it on the PO's path
  `/api/friends/:id/guest-link/standing[/regenerate]`, NOT the `/guest-links/standing/host/…` sketch here.**
- `OPEN:` **Preview size** — 12 products (this spec). The prototype shows 2 per category tab; a per-tab
  cap needs the tabs' purposes server-side. Default stands unless the PO wants the full last catalogue.
- `OPEN:` **`cycle_id` semantics for the two-round purge** — this spec keys it to the last closed round at
  signup („offered two openings, ordered in neither“). Alternative: count from the first round that
  OPENS after signup. Same schema, one predicate; PO confirms the reading of „2 rounds pass“.

## PO decisions 2026-09-19 — OPEN items resolved

> Recorded by the orchestrator from the PO walkthrough. Each line resolves the `OPEN:` of the same name above; where a default was overturned the affected UC carries an amendment note.

- **Unticked WhatsApp consent** = accepted; row stored with `whatsapp_opt_in = 0`, excluded from 21's segment.
- **Open-state guest chrome** = keep the SHIPPED chrome („Bez účtu“ chip, „Objednávka cez odkaz“); only the closed state gets the lock chip. No sanctioned edits for the open state.
- **Admin powers over standing tokens** = **YES — read + regenerate** (default OVERTURNED). ⚠ Amends UC-GL-001/UC-GL-009: add admin `GET /api/friends/:id/guest-link/standing` and `POST …/standing/regenerate` (both `requireAdmin` + `ADMIN_ENDPOINTS`; regenerate keeps sub-orders byte-identical exactly like the host path — one helper, two guards) and a read-only row + „Vygenerovať nový“ on AdminFriends' friend detail.
- **Preview size** = 12 products (default).
- **Two-round purge keying** = as specified (last closed round at signup).
- **Slovak strings** = staging sign-off.
