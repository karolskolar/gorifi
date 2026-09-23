# 11 — Guest standing link, pre-open page, waitlist (module 19)

Per-task lessons for `docs/specification/19-guest-standing-link.md`. Read this before touching
`friends.guest_link_token`, `backend/src/helpers/standing-link.js`, `guest_waitlist`, the
standing-link routes (host `/api/guest-links/standing[/regenerate]`, admin
`/api/friends/:id/guest-link/standing[/regenerate]`), or anything that mints a guest-link token.
The guest-order machinery these build on (per-cycle links, sub-orders, `order_token`, the
rate-limit buckets) is `02-guest-shared-orders.md`.

---

## GL-T1 — the standing token, its one home, the host + admin routes, the inert waitlist (2026-09-23)

**What shipped.** `friends.guest_link_token` (ALTER, nullable) + `idx_friends_guest_link_token`
(unique, its own try/catch); the `guest_waitlist` table + `idx_guest_waitlist_host_e164`
(partial unique) with NO writer; `helpers/standing-link.js` (`uniqueGuestToken`,
`ensureStandingToken`, `regenerateStandingToken`, `standingUrlPath`, `currentOpenCycle`,
`waitingCount`, and the two payload composers `standingPayload` / `regeneratedPayload`);
`guest-links.js` lost its private `uniqueToken()`; host `GET /api/guest-links/standing` +
`POST …/standing/regenerate`; admin `GET /api/friends/:id/guest-link/standing` +
`POST …/regenerate`; `sanitizeFriend` strips the token; four `api.js` clients (no caller yet —
GL-T6 builds the UI). API-only: **no screen changes in this row.** New spec file
`e2e/tests/guest-standing-link.spec.js` (28 tests after the review round).

### 1. ⚠ The cross-space uniqueness is an IN-PROCESS guarantee, and only a scripted RNG can test it

There is no DB constraint ACROSS `guest_order_links.token` and `friends.guest_link_token` —
SQLite cannot express one. `uniqueGuestToken()`'s single `UNION ALL … LIMIT 1` check and the
write that consumes its value are indivisible only because better-sqlite3 is synchronous and
PM2 runs `instances: 1` (the GA-T8 class again). The unique index backs the standing half
alone; its `SQLITE_CONSTRAINT*` is translated into a bounded retry (5), unreachable today.

With 70 bits of entropy no behavioural test can collide by chance, so a helper that checked
ONE table would pass everything — which is exactly what the replaced `uniqueToken()` did. The
spec drives it in a throwaway boot with `crypto.randomInt` **scripted**: the probe imports
`node:crypto` FIRST and overwrites `randomInt`; `schema.js`'s `randomCode()` calls it through
the same CJS exports object at call time, so `generateGuestToken()` yields `AAAA…`, `BBBB…`,
`CCCC…` on demand. Seed `A` in one space and `B` in the other, and the helper must return
`C` — in both orders. ⚠ This is the reusable technique for any future „unique across two
tables" rule here.

⚠ **Mutation trap, measured:** the obvious one-table mutant — delete one half of the
`UNION ALL` — goes red for the WRONG reason. `.get(token, token)` then binds two values to one
placeholder and better-sqlite3 throws `RangeError`, so every probe that mints reds with a
crash, the logic untested. The honest mutant keeps the bind count: `WHERE 0 AND token = ?`
(each half in turn). Measured that way, exactly ONE test reds per half — the cross-space
test, on its assertion (`AAAA…` / `BBBB…` returned where `CCCC…` was required).

### 2. ⚠ `sanitizeFriend` DOES strip it — the spec said „no change", and was wrong

19 §UC-GL-001 said „`sanitizeFriend` needs no change (the token is not a login credential)" in
the sentence right after „the friend's OWN payloads do not gain the token". Both cannot hold:
`GET /api/friends/:id/profile` is `SELECT *` → `sanitizeFriend`, so „no change" publishes the
token on the friend's own profile the moment the column exists. „Not a login credential" is
true but it is not the function's test — `sanitizeFriend` already strips `invite_code`, which
is not one either. The rule it applies is „a credential of ANY surface"; the standing token is
the bearer credential of the public guest surface, i.e. `invite_code`'s class exactly — and
like `invite_code` (`GET /api/invitations/my-code`) it gets DEDICATED publishing routes
instead — ⚠ FOUR of them, every route that answers `standing.token`: host `GET` +
`POST …/regenerate` on `/api/guest-links/standing`, admin `GET` + `POST …/regenerate` on
`/api/friends/:id/guest-link/standing` (the first write-up said „two", counting only the
GETs; the review caught it — a regenerate response publishes the new token too). Consequence, deliberate: the admin friend list/detail/PATCH no longer carry it either;
the admin reads it through `GET /api/friends/:id/guest-link/standing`, which also mints (a raw
`null` in the list would be a „not created yet" state D1 says the link does not have). The spec
line is struck in place with a pointer; `CLAUDE.md` carries the one-liner.

### 3. No modern-mode 409 guard — decided, with the reason written at the route

GA-T5's rule covers routes that write a LOGIN credential (password, username, Google link),
because under legacy auth the shared password can mint anyone's session and such a write is
account takeover. The standing token authenticates nobody as the friend; it opens the guest
surface only — exactly the power of the per-cycle token that `POST /guest-links/cycle/:id` has
always minted and rotated with no mode guard. And production runs `auth_mode = legacy`: a guard
would 409 every host, i.e. ship the feature to nobody. `requireHost()` already refuses the bare
shared password (no friendId ⇒ 401) in BOTH modes — pinned in the refusal test.

### 4. `friends` gets the ALTER only — NOT also a column in the CREATE

The orchestrator brief (and 01-architecture's general „a column on a table already in prod
needs CREATE **and** ALTER") said CREATE and ALTER. For `friends` specifically that conflicts
with both 19 §UC-GL-001 („`friends` has no fresh CREATE path for it") and the PI-T9 convention
recorded at `explainer_seen_at` (the friends CREATE is the 2024 shape; every column since
arrives by ALTER, which a fresh DB runs too). The spec + the in-code convention won; the fresh
AND pre-existing paths are both proven (§6). ⚠ The rule „CREATE and ALTER" is about GUEST
tables, whose CREATE is the live definition — `guest_waitlist` is a NEW table, so CREATE only.

### 5. The index try/catch LOGS, it does not swallow

The GA-T1 lesson says „its OWN try/catch, never folded into the ALTER's"; the GA-T5 lesson
(coffee_products) says a silently skipped unique index leaves the app check as the only
defence. Both indexes therefore sit in their own try/catch whose catch is
`console.error('Migration error (<index>)…')` — boot never dies on it, and a skip is visible.
Neither can fail on valid data (a just-added NULL column; a new empty table).

### 6. Migration proof on an EXISTING database — real server boots

`e2e/fixtures/prod-template.sqlite` IS a pre-GL-T1 database (76 friends, no column, no table),
so every gate run migrates an existing DB. Measured explicitly on a copy with the real
`backend/src/index.js` on :3998:

| step | column | friends index | waitlist table + index | minted |
|---|---|---|---|---|
| template | — | — | — | — |
| boot 1 | `TEXT`, nullable, no default | ✓ | ✓ ✓ | 0 of 76 |
| strip column + index + table, boot 2 | ✓ | ✓ | ✓ ✓ | 0 |
| drop both indexes only (ALTER now throws „duplicate column"), boot 3 | ✓ | ✓ | ✓ ✓ | 0 |

Step 3 is the case the own-try/catch rule exists for. The spec's §1 repeats all of it in a
throwaway boot, so it is a regression net and not a one-off.

### 7. `waiting_count` — the dangling „UC-GL-008 rule 1", resolved to „not yet told"

UC-GL-001 defines `waiting_count` „per UC-GL-008 rule 1", and UC-GL-008 has no numbered rules.
~~Resolved to the literal reading of 19's Actors line: `COUNT(*)` of every row, notified or
not.~~ **REVISED in the same row (orchestrator decision on the GL-T1 review):
`… AND notified_at IS NULL`.** The first reading took one sentence („sees the waitlist as a
COUNT") and ignored three that point the other way: UC-GL-004 rule 4 RE-ARMS a row by
resetting `notified_at = NULL` (meaningless unless NULL is „still waiting"); UC-GL-010's
segment is `WHERE w.notified_at IS NULL`, and 21 §UC-WA-007's acceptance says that after
release „the segment then counts 0"; and the copy the number feeds is „N ľudí čaká na váš
odkaz". ⚠ The lesson: a dangling cross-reference is resolved by reading EVERY passage that uses
the field, not the nearest sentence. The spec-19 note at the table now cites all three; §2's
probe inserts a notified row that must NOT count, an un-notified one that does, and re-arms
one. A notified row still exists for the admin until a purge (UC-GL-005).

### 8. The admin routes: lazy mint, and rule 1 enforced IN THE HELPER

„One helper, two guards" (PO): the admin bodies are the host's composers verbatim.
- The admin READ mints lazily too. The PO's case is a host who cannot reach their own dialog;
  a read answering „none yet" would leave the admin nothing to forward.
- ~~No `inactive_host` gate on either route~~ **REVISED on review: rule 1 („Minting requires
  an ACTIVE host") was being honoured on the host side only — by accident of session
  deletion — while the admin read would happily mint a door for a deactivated host.** It now
  lives in `helpers/standing-link.js` (`mayMint()`), so it binds every caller including module
  21's `ensureStandingToken`: an INACTIVE friend with NO token is never minted one — admin GET
  and admin regenerate both answer 409 `inactive_host`, the per-cycle admin CREATE's refusal
  (`reason` key, message in the same style). An inactive friend WITH a token keeps it readable
  and ROTATABLE — the per-cycle admin REGENERATE's precedent: revocation matters most for a
  deactivated host. The refusal bodies are ONE frozen map (`STANDING_REFUSALS`) sent through one
  `sendStanding()` by both routers. ⚠ The orchestrator's instruction said `code:
  'inactive_host'`; the cited precedent and 48 of 49 refusals in `backend/src/routes` say
  `reason:`, so `reason` it is — and a mutant that renames it reds two tests.
- Pinned with read-back: inactive+NULL GET → 409 and inactive+NULL regenerate → 409, then
  RE-ACTIVATE and read again: `created: true` proves neither refusal wrote (plus a direct
  `DB_PATH` read); inactive+existing → read returns it, regenerate rotates. Mutants: mint on
  GET, mint on regenerate, and the over-broad „inactive may not even rotate" each red.

Host side: deactivation deletes the friend's sessions inside the admin PATCH's transaction, so
their Bearer 401s before the helper is reached. Pinned (deactivate → host GET/POST 401 → admin
read shows the token unmoved).

### 9. `currentOpenCycle()` — one statement, and a noisy log on the gate

„ONE query" is literal: `SELECT … , COUNT(*) OVER () AS open_count … ORDER BY id DESC LIMIT 1`
(the window is evaluated before the LIMIT; bundled SQLite is 3.49). No type filter. When two
rounds are open it warns `[standing-link] N open cycles — using the newest (id X)` — ⚠ **once
per call**, and the shared e2e DB always holds many open cycles (every spec's `makeCycle`), so
the gate server log carries dozens of these lines. That is the data, not a defect; production
has at most one open round. The `current: null` branch is proven only in a throwaway boot —
never by closing the shared target's rounds under other spec files.

### 10. Fixture trap: the legacy `friends.cycle_id` FK CASCADES

A probe that deleted „the cycle" to prove `guest_waitlist.cycle_id … ON DELETE SET NULL` saw
the waitlist row vanish — because the probe's friends hung off that same cycle through the
2024 `friends.cycle_id NOT NULL … ON DELETE CASCADE`, so the delete took the FRIEND, whose
waitlist row then cascaded. The anchor is now a separate cycle, with a non-vacuity check that
the row really pointed at it. (Real-world echo: `getPlaceholderCycleId()` hangs every friend
off the lowest-id cycle, so deleting that cycle would delete friends — pre-existing, recorded
not touched.)

### 11. Where the token may not go — and how that is pinned

- `routes/guest.js` `LINK_SELECT` must never select it: a source pin extracts the template
  literal (non-vacuity: it contains `gl.token`) and also bans `f.*` inside it. GL-T2 will add a
  `friends.guest_link_token = ?` LOOKUP to that file; the pin is on LINK_SELECT, not the file.
- No `/api/guest/*` body (listing, submit 201, status) contains the token or the column name.
- No friend payload (own profile, admin list/detail/PATCH) has the key or the value.
- The host payload's key sets are pinned EXACTLY at every level — so a waitlist name or phone
  has no slot. ⚠ A blanket „no `"name"` key" sweep is WRONG: `current.name` is the cycle's
  name by the spec's own shape (it reddened the first green run).
- The ONLY writers: §6 walks all of `backend/src` for `UPDATE friends SET … guest_link_token` /
  `INSERT INTO friends … guest_link_token` and expects `helpers/standing-link.js` alone, with
  exactly two statements, the ensure one carrying `AND guest_link_token IS NULL`.

### 12. „Old token 404s after regenerate" is forward-compatible, not discriminating — yet

Until GL-T2's `resolveEntry()` a standing token never resolves, so the old one 404s trivially.
The pin is kept (it is the permanent contract, and the uniform-message `Set` of size 1 is
real), but GL-T1's discriminating regenerate proof is „nothing else moves": per-cycle links
(token + `active`, including a DEACTIVATED one), every sub-order (including a CANCELLED one),
every item row and the friends row minus the token, read back through the host view, the admin
detail AND `DB_PATH`, after a host regenerate and again after an admin one — plus the status
URLs and the per-cycle listing still answering (a byte-identical row that 404s would pass a
snapshot alone). GL-T2 must add the „new token resolves" half next to it.

### 13. The e2e SCRUB does not cover the token yet — deliberately, and blocking on GL-T6

The review caught that `friends.guest_link_token` is a live bearer credential for `/g/:token`
(`invite_code`'s and `guest_order_links.token`'s class) and that neither
`e2e/scrub-template.sql` nor `e2e/verify-scrub.sql` touches it. The obvious fix is two lines —
and it cannot go in yet, for a reason worth knowing before anyone „just adds them":

- The template is built on the PRODUCTION host: `make-test-db.sh` pipes both files into the
  `sqlite3` CLI over ssh. `scrub-local.mjs` (node:sqlite) is only the LOCAL re-scrub/verify.
- SQL resolves column names at prepare time and has no dynamic SQL, so neither file can say
  „if the column exists". Production gains the column only when GL-T1 is DEPLOYED there, so an
  unconditional line breaks every template build until then (fail-closed — the verify's
  line-count gate or the CLI's exit code aborts before the download — so a blocked build, not a
  leak).
- A column-existence pre-step is possible only in each DRIVER (a bash `pragma_table_info` check
  over ssh, and a node one), i.e. transitional code in two places, and the bash half cannot be
  exercised on the dev box (no `sqlite3` CLI, no `runuser`; the real run reads production and
  overwrites the template). Unprovable code on the credential-scrub path is worse than a named
  gap.
- Exposure until then is nil in practice: nothing mints before GL-T6 (the first UI), and a
  template built from a pre-GL-T1 production has no column at all.

So it is a BLOCKING note on GL-T6 (the first minter) with the exact two lines, and the matching
one on GL-T3 for `guest_waitlist` (non-member PII). **→ LANDED in GL-T6 (§GL-T6 §1 below): both
pairs are in the two SQL files, and `make-test-db.sh` now fails closed until production has the
migrations.** ⚠ Rule of thumb for the next credential
column on a prod table: the scrub lines ship WITH the first row that can put a real value in
production, and only once production already has the column.

### Seams left for the next rows

- GL-T2: `uniqueGuestToken()` for the get-or-create per-cycle row; `currentOpenCycle()` is
  rule 2 (widen its column list additively, keep it one query); the standing-token lookup goes
  in `resolveEntry`, never in `LINK_SELECT`.
- GL-T3: the first `guest_waitlist` writer; `waitingCount()` already counts it (un-notified
  rows). ⚠ BLOCKING: `guest_waitlist.name` / `phone` / `phone_e164` are NON-MEMBER PII — the
  scrub + verify pair must cover them before the public writer reaches production (§13; ~~ask the
  PO whether the „names are kept" rule, made for friends, extends to strangers~~ **resolved by the
  orchestrator in GL-T3: the STRICTER default, all three scrubbed, no PO question — and the exact
  lines MOVED to the GL-T6 row, to land with the token pair; see GL-T3 §6 below**).
- GL-T6: `api.getStandingGuestLink` / `regenerateStandingGuestLink` (host dialog) and
  `adminGetFriendStandingLink` / `adminRegenerateFriendStandingLink` (AdminFriends) exist.
  ~~⚠ BLOCKING: `scrub-template.sql` + `verify-scrub.sql` must NULL / check
  `friends.guest_link_token` before any production mint~~ **DONE in GL-T6 (§GL-T6 §1)** (§13 — the exact lines are in the GL-T6
  row). ⚠ For GL-T6/PO: the admin GET mints lazily, so rendering the standing row on every
  AdminFriends detail = a GRADUAL BACK-FILL of every friend the admin browses (19 deliberately
  has no back-fill). Behaviour unchanged by GL-T1; decide it where it becomes visible. An
  inactive friend's detail gets the 409 `inactive_host` (render „nie je vytvorený" or hide).
- FUP-T4 (the modern-auth flip, `[!]`): standing tokens minted during the legacy window —
  while the shared password can mint anyone's session and therefore read anyone's standing
  URL — OUTLIVE the flip, because the flip deletes SESSIONS, not `friends.guest_link_token`.
  The runbook closes it by rotating every standing token at the flip (per friend,
  `regenerateStandingToken`; a host's old URL then 404s for new visitors, orders are
  untouched). One line recorded on the FUP-T4 row.
- Module 21: `{odkaz}` = `standingUrlPath(ensureStandingToken(host_friend_id))` — both return
  STRINGS (`''` / `null` on a miss), exactly the UC-GL-010 composition.

---

## GL-T2 — `resolveEntry()`, the per-cycle get-or-create, the pre-open payload, the placeholder (2026-09-23)

**What shipped.** `routes/guest.js`: `resolveLink(token, closedStatus)` is REPLACED by
`resolveEntry(token, { forSubmit })` over both token spaces; a standing hit gets-or-creates
the host's `guest_order_links` row for „the current round" (`currentOpenCycle()`, unwidened);
`GET /api/guest/:token` answers the pre-open payload (`page:'preopen'`, UC-GL-003) for every
non-orderable state and sends `Cache-Control: no-store` on EVERY answer; the handler body is
one pure `listingResponse(token)` (exported, with `resolveEntry`, for the spec's probes only).
`GuestOrder.vue` gains a MINIMAL `preopen` state (`data-testid="preopen-hero"`: badge, headline,
host sentence, `next` sentence) and loses the dead card's `closed` variant. `guest-links.js`:
comments only. 19 new tests in `guest-standing-link.spec.js` + the GL-T1 regenerate pin's
„new token resolves" half; the two sanctioned retargets.

### 1. The resolution table, as shipped

| token hit | state | listing `GET` | submit `POST …/orders` |
|---|---|---|---|
| neither space | — | 404 uniform `{error}` | 404 |
| per-cycle | link or host inactive | 410 `inactive` | 410 |
| per-cycle | cycle missing | 404 | 404 |
| per-cycle | cycle open | 200 live listing (byte-identical) | proceeds |
| per-cycle | cycle NOT open | 200 preopen, `stale_cycle`, `open_elsewhere` iff any round is open | 409 `closed` |
| standing | host inactive | 410 `inactive`, **no row created** | 410 |
| standing | no open round | 200 preopen, `stale_cycle: null` | 409 `closed` |
| standing | open round, host's row inactive | 410 `inactive` (D4), row untouched | 410 |
| standing | open round | 200 live listing of the NEWEST open round; row got-or-created | proceeds on that row |

The inactive-host gate on a standing hit is checked BEFORE the get-or-create. Without it the
JOIN's `host_active` would still 410 the visit — the mutant is invisible in the status code —
but it would have WRITTEN a row for a deactivated host first. Only the read-back
(`adminLinksFor(...) === []`) sees that; the status assertion alone passes the mutant.

### 2. ⚠ The UNIQUE fallthrough cannot be forced with a trigger

The obvious way to force the (unreachable-under-`instances:1`) race — a TEMP `BEFORE INSERT`
trigger that inserts the „winner" row — does not work: the trigger's INSERT is part of the
failing statement, so SQLite rolls it back WITH the constraint failure, the re-SELECT finds
nothing and the resolver (correctly) re-throws. Measured: the first version of the test went
red for that reason with the code right. The working probe patches `db.prepare` on the shared
`dbHelpers` object (routes read it at call time): the FIRST `(host_friend_id, cycle_id)` SELECT
returns `null` and inserts the winner at that moment — the exact window between the check and
the write. A `armedLeft === false` non-vacuity gate proves the forced miss happened. Mutant
„re-throw every constraint error" reds exactly that test.

The fallthrough adopts only a row the re-SELECT can SEE; any other constraint error (a token
clash `uniqueGuestToken()` exists to prevent) is re-thrown, never turned into an `undefined`
link.

### 3. Why most of the matrix is a PROBE — „current round" and „next planned" are GLOBAL

The shared e2e target always has many open and planned cycles (every spec's `makeCycle`), so
„a standing token with no open round", „no planned round ⇒ `unknown`" and „a stale link with
nothing open elsewhere" are unreachable over HTTP without closing other files' rounds. They
run in throwaway boots that import `listingResponse()` / `resolveEntry()` (the GL-T1 probe,
extended with a `guest` import — same `schema.js` module instance, so the probe's `db` IS the
router's). What only HTTP can prove — the `no-store` header, the status/body plumbing, the
host view seeing the got-or-created row, stock counting a standing sub-order — is pinned
against the server, each row on its own fixture. ⚠ An HTTP test is deterministic here only for
facts about the NEWEST cycle: a test that creates its cycle last owns „the current round" and
„the newest closed round" (the preview) for as long as it runs `--workers=1`.

### 4. `no-store` on the refusals too

Rule 5 says „on this response and on the live listing". It is set on EVERY answer of the
handler, 404/410 included: the `guest-invite-dead.spec.js` incident was a cached **410**, i.e.
the refusal is exactly the answer most likely to be re-served stale. One line, first in the
handler.

### 5. ⚠ `stale` is NOT a `next.kind` — the row's list vs the spec's shape

The PROGRESS row lists `next` kinds „planned_date/planned_note/unknown/open_elsewhere/stale".
19 §UC-GL-003's shape has FOUR kinds, and the stale variant is `stale_cycle` (non-null only for
a legacy token), orthogonal to `next`: a stale link with nothing open elsewhere still reports
the next PLANNED round. Implemented per the spec's shape; **accepted by the orchestrator
(2026-09-23) — „stale" is struck from the row's kind list with a pointer.**

### 6. The dead card's `closed` variant is gone — and with it one of the „cyklus" strings

`GuestOrder.vue:170` („Cyklus sa medzičasom uzamkol …") was one of the three guest „cyklus"
strings CLAUDE.md, `e2e/helpers/vocabulary.js`, 18's hand-off list and learnings 09 named.
§UC-GL-006 removes the branch (the listing cannot answer 410 `closed` any more), so every copy
of that inventory is rewritten to TWO (strike + pointer). The server string „Objednávanie
v tomto cykle je už uzavreté." survives as the submit 409 `CLOSED` only — its „also a 410 on
GET" half is retired. The new placeholder copy is swept with the ONE `BANNED` regex, rendered.

### 7. The retarget text in 19 §UC-GL-011 holds only on an EMPTY target

„the locked-cycle link renders `preopen-hero` with „Objednávky sú zatvorené"" — on the shared
target a newer round is almost always open, so §UC-GL-006's `open_elsewhere` headline („Táto
objednávka je už uzavretá") applies. Both the sanctioned `guest-invite-dead` retarget and the
new UI test read the expected headline off the payload the page itself receives, which stays
right under GL-T5's full page too.

### 8. The placeholder is deliberately thin

Badge „Zatvorené", the kind's headline, the host sentence and the `next` sentence —
`planned_date` uses module 17's LONG `fmtDay()` („3. októbra"), so the date variant renders from
day one; the „(o N týždňov)" parenthesis is GL-T5's `weeksAwayLabel()`. No ticker flip, no
steps, no roasters line, no waitlist form, no preview, no `document.title` — all GL-T5. The
host name is marked `data-user-copy` (FUP-T22) for the day the guest views join a sweep.

### 9. ⚠ The sanctioned-retarget list was INCOMPLETE — two more files pin the retired 410

19 §UC-GL-011 item 2 says „everything else in … `guest-status`, … `guest-order-recovery` …
passes UNMODIFIED". Measured, it does not: two tests assert the listing's 410 on a non-open
cycle as a SIDE fact, and both go red (200) under the spec's own rule:
- `guest-status.spec.js:598` — „listing closes" `toBe(410)` inside the locked-status-URL test;
- `guest-order-recovery.spec.js:1296` — „Inert … `resolveLink` 410s a non-open cycle" inside
  the admin-create-on-a-locked-cycle test.
~~Neither is in the row's sanctioned list, so neither was edited; both are reported for an
orchestrator sanction~~ **SANCTIONED by the orchestrator (2026-09-23) and retargeted to `200` +
`page: 'preopen'` (+ `products` absent); the recovery test also gained the submit-409 `closed`
counter-pin, so it still proves the inert link grants no ordering. 19 §UC-GL-011's „passes
UNMODIFIED" is struck with a pointer.** ⚠ The lesson is the
GL-T1 one again: a supersession map written from the spec's viewpoint misses assertions whose
SUBJECT is something else — grep `e2e/` for the retired status, not for the test titles.

### 10. Review round (APPROVE with minors)

- `stock_limit_g` is STRIPPED from preview products (added to `PREOPEN_FORBIDDEN_KEYS`; the
  probe's rows carry 1000 in the DB, so the absence is not vacuous).
- Every submit-409 counter-pin now reads back „zero sub-orders" through the host view.
- The preview probe's „an OLDER completed cycle must not win" half was vacuous (that cycle
  had no products, so nothing could leak); it now has one.
- Accepted risk added to 19 §Accepted risks: a standing SUBMIT gets-or-creates the per-cycle
  row BEFORE validation, so a rejected submit (bad phone, empty cart) may leave the inert row
  a page load would have created anyway.
- Stale „the listing 410s on a non-open cycle" copies struck with pointers (README ×2,
  `api.js`, `GuestProductGrid.vue`, 14 ×2, learnings 09, two spec headers/comments), and the
  name-only `resolveLink` references now say „formerly `resolveLink`".

### Seams left for the next rows

- GL-T3 (`POST /:token/waitlist`): call `resolveEntry(token)` (no `forSubmit`) and map
  `kind:'order'` and `preopen` with `openCycle` to the 409 `open`; `cycle_id` = `lastClosedCycle()`
  — THAT function, never a second copy of the query.
- GL-T5: replaces the `preopen` template block; keeps `preopen-hero`; owns the
  `self-hosted-fonts.spec.js` `/g/:token (preopen)` row (a legacy token on a locked cycle is the
  cheapest fixture — it is preopen on any target).
- `preview` is the newest locked/completed cycle GLOBALLY (the spec's rule), so a stale link can
  preview a different round than its own `stale_cycle`. ~~`stock_limit_g` still rides the product
  columns~~ **stripped on review (§10)**; availability does not ride either.

---

## GL-T3 — the waitlist write path: `toE164()`, the public signup, the purges, the admin routes (2026-09-23)

**What shipped.** `helpers/phone.js toE164()` (21 §UC-WA-002's contract — `libphonenumber-js/min`,
`isValid()` gate, never throws; `libphonenumber-js` added to `backend/package.json`);
`helpers/guest-waitlist.js`, the ONE home of every statement that writes `guest_waitlist`
(`joinWaitlist`, `purgeWaitlistOnOrder`, `purgeWaitlistAfterTwoCompletions`, `deleteWaitlistRow`)
plus the admin list reader and the module-21 segment SQL as a code-comment contract; public
`POST /api/guest/:token/waitlist` (`guestWriteLimiter`, pure core `waitlistResponse()`); the
on-order purge inside the guest submit transaction; the after-two-completions purge in the admin
`PATCH /api/cycles/:id` (transition only, same transaction as the status write); admin
`routes/guest-waitlist.js` (`GET /`, `DELETE /:id`) behind a `requireAdmin` MOUNT; three `api.js`
clients (`joinGuestWaitlist`, `getGuestWaitlist`, `deleteGuestWaitlistRow`). API-only: **no screen
changes** (GL-T5 builds the form, GL-T6 the admin card). New `e2e/tests/guest-waitlist.spec.js`
(26 tests); `rate-limit-isolation.spec.js` alternates the two guest writes; `api-security` +2.

### 1. ⚠ The happy path is UNREACHABLE over HTTP on the shared target — so the core is a pure function

The signup is accepted only in the pre-open state, and the shared e2e target always has an open
round — so every valid token answers 409 `open` BEFORE the body is read (rule 1 precedes rule 2).
Over HTTP that leaves the 404/409/410 refusals, the parser-level 400s, and nothing else. The handler
is therefore `waitlistResponse(token, body) → { status, body }`, exported beside GL-T2's
`listingResponse()` and driven in throwaway boots for the happy path, the idempotency key, the
bounds, consent, the state gates and `cycle_id`. HTTP proves only what the core cannot: the status
plumbing, the admin routes, the purge hooks in the REAL submit and the REAL complete PATCH, and the
host's count. HTTP-level rows are PLANTED through `DB_PATH` — there is no public writer the shared
target can reach — and every refusal reads the rows back.

### 2. Idempotency: the key is (host, E.164), else (host, exact raw phone)

`0905 123 456` then `+421 905 123 456` ⇒ two byte-identical 200s, ONE row, the second NAME, the
FIRST phone (rule 4's UPDATE names `name`/`whatsapp_opt_in`/`cycle_id`/`notified_at` only —
`phone` as first entered and `created_at` stay). The raw lookup adds `AND phone_e164 IS NULL`
(`toE164()` is deterministic, so a raw-phone row never has one) and compares the TRIMMED phone
(`asString()` trims): `'0000 000 000'` and `'  0000 000 000 '` are one row, `'0000000000'` is a
second — pinned as the rule reads. The partial unique index backs the E.164 half; its
`SQLITE_CONSTRAINT*` is translated into the UPDATE path only when the message names
`guest_waitlist.host_friend_id, guest_waitlist.phone_e164` (a FOREIGN KEY failure is re-thrown —
pinned). The lost race is forced with GL-T2's `db.prepare` patch (§2 of GL-T2), with the
`armedLeft === false` non-vacuity gate.

### 3. `notified_at`: RESET here, WRITTEN by module 21 only

The one assignment in `backend/src` is `notified_at = NULL` in the re-arm UPDATE — a source pin
walks every file and expects exactly that, so a module-19 timestamp write reds. Re-signup also
moves `cycle_id` to the CURRENT `lastClosedCycle()`, which restarts the two-completion clock —
the rule's intent (the guest asked again), recorded here because it means an eager re-signer is
never purged by rule 2.

### 4. The purges

- **On order**, inside the submit's `db.transaction`, after the item rows: E.164 ⇒ every host's row
  (D5); no E.164 ⇒ this host's row with the exact raw phone. A refused submit (empty cart) purges
  nothing — pinned as a counter-pin. The raw path is proven with `0000 xxxxxx` (10 digits passes
  `validateIdentity`, fails `isValid()`).
- **After two completions**, on `status === 'completed' && cycle.status !== 'completed'` only:
  `completed → completed` re-saves and name edits purge nothing (pinned with a NULL row that
  already qualifies on the shared target — the one fixture that tells transition from any-save).
  ⚠ `POST /api/cycles` accepts a `status` and can CREATE a cycle already `completed`: that runs no
  purge (19 names the PATCH only), but the cycle COUNTS at the next transition. Recorded, not
  changed.
- Helper-level semantics (N survives N+1, goes at N+2; NULL goes at the SECOND completion ever;
  locked never counts) run in a throwaway boot — on the shared target „completion #2 ever" is long
  past.

### 5. `validateIdentity()` grew one branch, not a copy

The waitlist field map has no `email`. Without a guard `body?.[undefined]` reads the key
`"undefined"`, so `{ "undefined": {} }` would 400 „Neplatný e-mail" on a form with no e-mail
field. `if (!fields.email) return { identity: { name, phone, email: null } }` — the two shipped
maps both carry `email`, so checkout and lead-capture are unchanged; an e-mail sent to the
waitlist (even an unbindable one) is ignored, pinned.

### 6. The scrub: the STRICTER default, and the lines live on GL-T6

Orchestrator decision: `name` / `phone` / `phone_e164` are all scrubbed (name included — the
„names are kept" rule was made for friends), which is stricter than the friends rule and so needs
no PO question. Sequencing is §13's problem again: an unconditional `UPDATE guest_waitlist` fails
every template build from a production that predates GL-T1. So NOTHING was added to either SQL
file; the exact UPDATE and three verify lines (each a `SELECT '<name>'` line, so EXPECTED rises by
3) are on the GL-T6 row's BLOCKING note, to land in one change with the token pair. Measured on a
copy with node:sqlite: a real-shaped row + a non-normalising one ⇒ verify `2|2|1` before, `0|0|0`
after. ⚠ `phone_e164` is re-derived from the SAME expression as `phone`, because an UPDATE's
right-hand side reads the OLD value of `phone`; the verify ties it to the scrubbed phone
(`'+421' || substr(phone, 2)`), so a real number cannot survive in it.

⚠ Considered and NOT taken — reported to the orchestrator: a pure-SQL conditional exists for the
TABLE half (`CREATE TABLE IF NOT EXISTS guest_waitlist (…)` at the top of the scrub makes the
UPDATE and the verify valid on any snapshot, in BOTH drivers). It was not used because it is half
a solution (SQL has no `ADD COLUMN IF NOT EXISTS`, so the `friends.guest_link_token` pair still
needs the sequencing), and because it changes the template's SHAPE — a pre-GL-T1 template would
arrive with the table but without the column/index, and GL-T1 §6's „the template IS a pre-GL-T1
database" migration proof would then only half hold.

### 7. Gate notes

- `guest-order-recovery.spec.js`'s D11 pin greps `routes/guest.js` RAW — comments included — for
  `async`/`await`. The first gate run went red on a COMMENT that quoted „zero async in
  routes/guest.js". Reworded. ⚠ Any comment in that file must avoid both words.
- `rate-limit-isolation.spec.js` self-skips under the gate's 100000 caps. Run separately on a
  throwaway :3998 server with `RATE_LIMIT_GUEST_WRITE_MAX=3`: green, and the mutant „waitlist on
  `guestReadLimiter`" reds it (`guest write limiter should engage past its max`).
- Mutations run (each red, then restored): raw-only lookup; re-arm without `notified_at = NULL`;
  consent defaulting to 1; no 409 for `openCycle`; re-throw every constraint; `cycle_id: null`;
  waitlist on the read limiter (source pin); on-order purge deleted; per-host E.164 purge;
  purge on every `completed` save; `parseInt` id on DELETE (`12x` deleted row 12); mount without
  `requireAdmin`.

### Seams left for the next rows

- GL-T5: `api.joinGuestWaitlist(token, { name, phone, whatsapp_opt_in })` — the 200 is the SAME
  for a new and a repeat signup (render one success state); 409 `reason:'open'` means reload into
  the live page; 400 carries `field` (`name`/`phone`) for the inline error; mirror `maxlength`
  120/32.
- GL-T6: `api.getGuestWaitlist({ host_friend_id })` / `deleteGuestWaitlistRow(id)`; rows carry
  `host_name`, `cycle_name`, `phone_e164`, `notified_at`, ordered host NOCASE → newest first.
  ~~⚠ BLOCKING: the scrub lines (token + waitlist) are on the GL-T6 row.~~ **Landed in GL-T6 (§GL-T6 §1).**
- WA-T1: adopt `helpers/phone.js` UNCHANGED (`grep -rn parsePhoneNumber backend/src` → that file
  only — pinned in `guest-waitlist.spec.js`). The waitlist INSERT already writes `phone_e164`
  through it, so WA-T1's writer table row for module 19 is DONE; the segment SQL is in the header
  of `helpers/guest-waitlist.js`. ⚠ The contract's `String(raw ?? '')` coercion is literal: an
  ARRAY stringifies and parses (`['0905123456','x']` ⇒ `+421905123456`) — callers pass
  validated strings; pinned as written.


## GL-T4 — `GuestSteps.vue`, `GuestRoastersLine.vue`, the open hero's strip + fold (2026-09-23)

19 §UC-GL-007. Two new components, one extended library field, one hero edit. No backend.

### 1. What shipped

- `components/GuestSteps.vue` — props `compact` (Boolean), `hostName` (String), `packeta`
  (Boolean, **default `false`** — GP-T3 flips it when `cycle.parcel_enabled`). The three step
  texts are constants IN the component (19: guest-specific). Step 3 = „Od {host}." until
  `packeta`, then the prototype sentence byte for byte (`PACKETA_CLAUSE`). The host name renders
  in its own `data-user-copy` span. Testids: `guest-step`, `guest-step-n`, `guest-step-title`,
  `guest-step-detail` (full layout only).
- `components/GuestRoastersLine.vue` — no props, no products: it names every `ROASTERS` entry in
  library order (19 transcribes it as a fixed sentence). Testids `guest-roasters`,
  `guest-roaster-badge`. Imports `../lib/roasters.js`; types none of the roaster words (pinned).
- `lib/roasters.js` gains a `short` field per entry (`'pražiareň'`, `'domáci pražič, SCA
  výbery'`) — the parenthesis of the roasters line. Added to the ONE home rather than typed into
  the component. `portal-explainer.spec.js` §2 maps `[key,label,badgeClass]`, so the new field
  breaks nothing there.
- `GuestOrder.vue` open hero: after the „organizuje" line AND its deadline row, before the badge
  row: `<GuestSteps compact data-testid="guest-steps-compact">`, then a flex-wrap row
  (`GuestRoastersLine` + `button.btn.ghost.sm` `guest-steps-toggle`, accent, `padding:0`,
  `aria-expanded`, `aria-controls` only while open), then `v-if="showHow"` detail
  (`guest-steps-detail`, `border-top:2px solid rgba(10,10,10,.12)`, full `GuestSteps`). `showHow`
  is a plain `ref(false)` — not persisted. Badge row, helper sentence, `plan_note` untouched (D6).
- `NeoIcon` needed NOTHING: `cup`/`box`/`hand` already exist in `neo/icons.js` (PI-T8's I2 set).
  The row's „NeoIcon gains cup/box/hand" was satisfied by PI-T8; 19's „if absent" applied.

### 2. ⚠ The two canon deviations — a selector, not pixels

The prototype's step dot is `className="mono"` and the roaster badges are `className="badge"`.
Both would break SHIPPED pins that 19 §UC-GL-011 item 2 says pass unmodified, because both new
elements sit INSIDE `.card.hl`:

- `guest-order-shell.spec.js:202` resolves `hero.locator('.mono')` (the deadline) — Playwright
  strict mode: three more `.mono` dots = a strict-mode violation;
- `guest-order-shell.spec.js:207` counts `hero.locator('.badge')` = 3;
- (GL-T5's hero) `guest-invite-dead.spec.js:450` / `guest-standing-link.spec.js` GL-T2 resolve
  `preopen-hero .badge` strictly („Zatvorené") — the roasters line goes into THAT hero next.

So the dot is `.gs-n` with `.mono`'s two declarations (`font-family:var(--font-mono)`,
`letter-spacing:.01em`) and the badges are `.gr-badge` with the theme `.badge` rule + the
prototype's inline 11px / `2px 7px` + A10's `line-height:normal`; `acc-o`'s fill is re-declared
as `.gr-badge.acc-o`. The GL-T4 tests pin BOTH halves: the shipped counts hold with the fold
OPEN (3 `.badge`, exactly 1 `.mono`), and the substitutes are computed-style-equal to the
hero's own real `.badge` (face, weight, case, border, radius, colour; letter-spacing compared
per-em since the sizes differ; Robo's fill equals the real `.badge.acc-o`'s). Review minors
(applied): the badge comparison also covers `display`, `lineHeight` and `backgroundColor`
against the real „Platba prevodom" `.badge` (no literal colour), and the dot's `fontFamily` +
per-em `letterSpacing` are measured against the hero's own deadline `.mono` (no font regex) —
mutating `.gr-badge` line-height or `.gs-n` letter-spacing now reds. Mutations adding
`mono` / `badge` back each red `guest-order-shell` AND the GL-T4 pins.

### 3. Measured details worth knowing

- The dot's canon `top:-9;left:-9` is from the tile's PADDING edge: with the 3px border it sits
  **6px** outside the tile's outer box (the first test expected -9 and was wrong).
- The canon DECLARES line-heights for the titles (1) and details (1.4) — used verbatim (PI-T12).
- `overflow-wrap:anywhere` is on the DETAIL only: a 60-char unbreakable host name wraps inside
  step 3 at 320px. Titles deliberately get none — breaking „PREVEZMETE" mid-word is exactly what
  §UC-GL-007's 320px criterion forbids. Measured at 320 and 378: each compact title is one line
  box (Range client-rect tops), 14px, no spill; nothing this row adds paints outside the hero.
- The roasters line's text runs are explicit `<span>` flex items (the prototype's anonymous
  items), so the 6px gap, not a space, separates them — `textContent` of the line therefore
  has no spaces between runs; assert per child, never the concatenation.

### 4. Tests (`guest-standing-link.spec.js`, three `GL-T4 ·` describes, 12 tests)

Open hero (5): position (DOM order AND geometry: organizuje → strip → roasters → badge row; first
`.badge` is still „Login netreba"), compact geometry; toggle open/close/label/aria/not persisted +
full layout geometry + „Od {host}." with no „Packet"; tile + dot fidelity in both layouts; roasters
line runs vs the library + computed-style equality; shipped pins with the fold open. Phone/CSP/
vocabulary (5): 320 + 378 overflow/one-line titles, long unbreakable host name, zero third-party
requests with a non-vacuity count, `BANNED` over the hero text with non-vacuity. Source pins (2).
`portal-explainer.spec.js` §7: the importer SET gains `components/GuestRoastersLine.vue` (sweep
regex and allow-list unchanged).

Mutations run (each red, then restored): `packeta` default true; dot `class="mono"`; badge
`class="badge"`; fold open by default; strip MOVED below the badge row; roaster texts copied
into the component (source pin + §7 importer set); `overflow-wrap` removed from the detail.

### Seams left for the next rows

- GL-T5: mount `<GuestSteps :host-name="…" />` (FULL, the default) inside the „Ako to funguje"
  card and `<GuestRoastersLine />` at the end of `preopen-hero`. Neither takes more props. The
  `.badge`/`.mono` deviation above is what keeps `preopen-hero .badge` strict-resolvable.
- GP-T3: pass `:packeta="Boolean(cycle?.parcel_enabled)"` on BOTH `GuestSteps` mounts in the open
  hero (and GL-T5's). The GL-T4 source pin „`GuestOrder.vue` does not pass `packeta`" is the
  sanctioned retarget for that row.


## GL-T5 — the full pre-open page (`GLink2 Zatvorené`, transcribed) (2026-09-23)

19 §UC-GL-006 + §UC-GL-011 item 5. Frontend only; no backend, no migration.

### 1. What shipped

- `GuestOrder.vue` `preopen` state REPLACES GL-T2's placeholder (keeps `preopen-hero`), in the
  prototype's card order: hero (`.badge` „Zatvorené" · split headline with the last word in
  `.hl` on its own line · host + next sentence · `GuestRoastersLine`) → „Ako to funguje"
  (`preopen-steps`, the FULL `GuestSteps`) → „Dajte mi vedieť" (`waitlist-form`, only when
  `waitlist.available`; success REPLACES it with `waitlist-done`, one of two banners by the
  consent SENT) → the preview (`preopen-preview-head` + `preopen-preview`, only with products).
  Page column testid `preopen-page`. `document.title` = „Objednávky sú zatvorené – Podpultovka"
  in every preopen variant (en dash). No cartbar/checkout/invite CTA — the branch simply has none.
- `GuestBrandHeader.vue` `closed` Boolean: lock chip `.chip.p2-lock` (the friend appbar's A13
  class, glyph only, `title`, `aria-hidden` like the friend one) + `GUEST_TICKER_CLOSED`. Still no
  ticker prop — a boolean picks one of two module constants.
- `GuestProductGrid.vue` `readonly` Boolean (EXTENDED, never forked): steppers REMOVED (not
  disabled), no stock bar, no `.sel`, the photo loses role/tabindex/aria-label/cursor and never
  opens the lightbox, tabs leave the tab order (`aria-disabled`); every one has a JS guard too
  (`selectTab`, `openPhoto`, `setQuantity`). The `.p2-ro` fade is the CALLER's wrapper (it covers
  the strip AND the cards, as in the prototype — unlike FriendOrder's readonly, where `.cat-tabs`
  stays browsable); `user-select:none` is a scoped `.gx-ro` in the view, not a theme edit.
  Product fields (name, descriptions, composition, roast type, roastery, a real `variant_label`)
  now carry `data-user-copy` on BOTH guest screens (admin-typed data, FUP-T22).
- `lib/plural.js weeksAwayLabel(days)` — 19's rule verbatim; `days` from `cycle-stages.js
  daysUntil()`, the weeks declined by the existing `weeksLabel`.
- `self-hosted-fonts.spec.js`: `/g/:token (preopen)` in BOTH sweeps (third-party allowlist `[]`,
  and the Google-host sweep `false`), fixture = a legacy per-cycle link on a LOCKED cycle with one
  product; the row asserts `preopen-hero` rendered before sweeping (a 404 card would sweep clean).

### 2. ⚠ `weeksAwayLabel` vs 17's `inWeeksText` — two drafted registers for ONE sentence

„Ďalšia objednávka sa otvorí približne {d. mmmm} (…)." exists on the friend side too
(`nextOpeningText()`), and 17 §UC-CS-005 item 6 said 19's page would print it from there. 19
§UC-GL-006 item 2 specifies its OWN parenthesis: 0–6 days ⇒ „už tento týždeň" (17's PO decision
O6: „o n dní", and NOTHING for today). The row and the orchestrator named `weeksAwayLabel`, so it
shipped as 19 writes it and the page composes the sentence itself (`fmtDay` + `daysUntil` +
the label; the date is `<b>`, which a finished string cannot carry anyway). Both copies of the
„consumers never re-compose" claim (17 §UC-CS-005 item 6, `cycle-stages.js` header) and
`plural.js`'s „19 prints it from `nextOpeningText()`" are struck with pointers (review: also
17 §→19 hand-off and the PROGRESS CS-T2 consumer list). **PO question:** one register or two? If
one, exactly one of `weeksAwayLabel` / `inWeeksText` is the edit. ⚠ Reviewer's point for the PO:
„už tento týždeň" is a DAY count, not a calendar week — at 5–6 days out (e.g. Wednesday → next
Tuesday) it is often literally NEXT calendar week, i.e. the phrase can be false as written.

### 3. ⚠ The waitlist memory's SHAPE deviates from 19 — `{ at, whatsapp_opt_in, cycle_id }`

19 writes `gorifi_guest_waitlist = { [token]: iso }`. A bare string cannot say which of the TWO
banners to re-show on reload, and never expires — a guest who signed up, got notified, ordered
(row purged) and came back at the next closed period would see „Dáme vedieť." for a signup that
no longer exists. `cycle_id` = the preview round's id, which IS the server row's `cycle_id`
(`lastClosedCycle()` at signup), so an entry for another round shows the form again. Per-viewer
convenience only, every access try/catch'd; the token lives in storage, never the DOM. 19's line
is struck with a pointer. Garbage / non-object JSON ⇒ `{}`.

### 4. Other decisions

- **409 `open`** on submit ⇒ `load()` (GL-T3's seam: the round opened, re-read into the live
  page). Every other refusal is the server's own sentence in `waitlist-error`
  (`.banner.danger.slim`), typed values kept, nothing remembered.
- **Empty preview** (`products: []`) renders NOTHING — never the grid's empty banner, whose
  shipped copy says „V tomto cykle…" (BANNED vocabulary) and has nothing to show anyway.
- **The stale headline** gets the same split as the canon's („Táto objednávka je už" / `.hl`
  „uzavretá") — the prototype draws only the „zatvorené" one; this is the structural analogue.
  The stale sentence keeps 19's nominative „Požiadajte {host}" (PO question, not a fix).
- **Multiline `plan_note`**: the note span is `white-space:pre-line` (17 §UC-CS-005 item 6 —
  the consumer preserves newlines), pinned by a two-line-box test (review).
- **„cykle" line reference** `GuestProductGrid.vue:76` → `:88` updated in CLAUDE.md, `vocabulary.js`,
  18 and learnings 09; the empty-grid string is reachable on the LIVE listing too (open round,
  zero products), named in CLAUDE.md and the GL-T7 row (review).
- **Tap targets**: the consent row is `min-height:44px` (the box is the canon 24px); inputs are
  46, the button 44. No GL-T4 `btn.ghost.sm` toggle on this page, so its 38px is not reused.
- **Headline line-heights** are the canon's declared values (1.12 / .95 on the `.hl` span,
  1.45 on the host sentence, 1 on the 22px title — the PI-T12 rule); unclassed wrappers get
  `line-height:normal`. `overflow-wrap:anywhere` on every sentence that interpolates a name.

### 5. Retargets (own module, sanctioned by the row)

- GL-T2 `the four next sentences`: `planned_date` fixture moved to a PAST `opens_at`
  (`2020-10-03`) — a fixed future date would now grow „(o N týždňov)" with the wall clock; the
  parenthesis has its own GL-T5 tests with `gl5Day(n)` dates relative to now.
- GL-T4 source pin: `<GuestSteps` 2 → 3 and `<GuestRoastersLine` 1 → 2 (this row mounts them).

### 6. Tests (`guest-standing-link.spec.js`, six `GL-T5 ·` describes, 28 tests)

`weeksAwayLabel` (plain-node import, 20 cases); mocked-payload page: chrome + title, hero
structure/order/bold/`.hl`, the parenthesis (3 / −2 / 10 days), steps card, card order, form
fidelity + three-zone toggle, submit (disabled rules, trimmed body, NO auth headers, `button:enabled`
1 → 0, banner replaces card, reload keeps it), unticked consent (second banner, reload keeps
THAT one), JS guard (dispatched clicks on disabled + while pending), 400 banner, 409 reload,
throwing storage, memory per token/round/garbage, `available:false`, no cart/CTA + token not in
DOM; preview (header, `.p2-ro` computed opacity/pointer-events/user-select, readonly: 0 buttons,
0 steppers, 0 stock bars, no `[role=button]`, no tab stop, dispatched photo click opens nothing,
empty/NULL preview); 320/378 overflow with a long host; ≥44px controls; A12 16px in a
`hasTouch/isMobile` context with a non-vacuity `matchMedia` gate; BANNED over `collectAppCopy()`
for all four variants and both banners; one REAL-server test (legacy link, locked cycle: closed
chrome, form iff `available`, preview iff products, zero third-party requests, token not in DOM);
source pins (`readonly` prop, grid mounted twice, no forked grid file; `closed` + two constants,
no ticker prop).

Mutations (each red, then restored): stepper kept in readonly; JS guard removed; unguarded
storage READ; closed ticker ignored; lock chip dropped; `weeksAwayLabel` counting days;
memory ignoring the round; `.p2-ro` dropped; consent default off; 409 not reloading; empty
preview shown; form ignoring `available`; tab stops kept in readonly; `role=button` kept on the
photo. **Survivors (recorded):** an unguarded storage WRITE is caught by `joinWaitlist`'s own
catch after the banner is already set (benign — the banner shows, the memory is lost); the
`openPhoto` guard alone is masked by the second layer (`ProductImageModal v-if … && !readonly`)
— defence in depth, the observable property holds with either one.

### Seams left for the next rows

- GP-T3: pass `:packeta` on the THIRD `GuestSteps` mount too (the pre-open card).
- GL-T6: nothing here — the host dialog/admin card are separate surfaces.
- GL-T7 (vocabulary guard over guest files): the pre-open copy is already swept rendered here;
  the source guard's closure will reach `GuestOrder.vue`'s new strings for free.

---

## GL-T6 — the scrub pair, the admin waitlist card, the admin standing row; the DIALOG half SPLIT to GL-T6b (2026-09-23)

**What shipped (the ADMIN half + the scrub).** `e2e/scrub-template.sql` + `e2e/verify-scrub.sql`
cover `friends.guest_link_token` and `guest_waitlist.name/phone/phone_e164` (the BLOCKING note
of GL-T1 §13 / GL-T3 §6), plus the padding-precedence fix on the three shipped phone lines;
`lib/plural.js waitingLabel()`; `CycleDetail.vue`'s „Čakajúci hostia (N)" card (19 §UC-GL-009 UI);
`FriendDetail.vue`'s standing-link row + „Vygenerovať nový" (19 PO block — „AdminFriends' friend
detail" is `/admin/friends/:id`, reached from AdminFriends' „Detail"). **NOT shipped: the host
share dialog's standing section (§UC-GL-008) — see §4.**

### 1. The scrub — landed, and what it now costs

- Scrub: `guest_link_token = NULL` joins the credentials `UPDATE friends` (NULL = „not minted";
  the unique index ignores NULLs); the `guest_waitlist` UPDATE sits in CONTACT DATA with the
  STRICTER default (name too). Verify: +4 `SELECT '<name>'` lines (22 → 26; `make-test-db.sh`'s
  EXPECTED is DERIVED by `grep -c`, so nothing else moved).
- ⚠ **`make-test-db.sh` now FAILS CLOSED until PRODUCTION carries the GL-T1/GL-T3 migrations**
  (`no such table: guest_waitlist` — the first unconditional line it reaches). Deliberate, written
  into `e2e/README.md` beside the make-test-db instructions, the verify header and CLAUDE.md.
  Deploy module 19 first (a restart migrates), then rebuild the template. The existing
  `prod-template.sqlite` keeps working — the gate server migrates the per-run COPY on boot — but
  `node e2e/scrub-local.mjs` on that raw pre-GL-T1 file now errors the same way (measured).
- ⚠ Padding precedence: `'00000000' || (X) % 100000000` padded FIRST (SQLite `||` binds tighter
  than `%`), so past X ≥ 1e8 the phone lost digits and the verify's GLOB failed (friends from id
  ~11365, guest_orders ~12055, invitations ~12459 — closed, not leaking). All four phone
  expressions are now `substr('00000000' || ((X) % 100000000), -8)`; a comment at the block says why.
- **Verified on a COPY** (never the template): copy → boot the real backend once on :3996
  (⚠ checkpoint the WAL before copying the copy again — the migrations sat in `-wal`, and a bare
  `cp` of the main file lost them) → plant 4 high-id clones each of friends / invitations /
  guest_orders (ids 12066, 13000, 20000, 99999, real-shaped phones and tokens), 7 standing tokens,
  4 waitlist rows (normalised, non-normalising with e164 NULL, ids 12066 and 99999).
  Before any scrub, the new verify reports friends.phone 4 · invitations.phone 4 ·
  guest_orders.guest_phone 4 · waitlist 4|4|3 · guest_link_token 7 (+ the usual credentials).
  HEAD's scrub + the new verify: friends.phone **2**, invitations.phone **1**, guest_phone **2**
  (the precedence bug, measured) + waitlist 4|4|3 + token 7. The NEW scrub via
  `scrub-local.mjs --scrub`: all **26** checks 0, byte scan clean, and a `grep -a` for the planted
  real values (`Skuto…`, `REALSTANDING`, `905123456`, the planted tokens, `944000111`) finds 0 —
  id 12066's waitlist phone is `0900004218` (the old form would have yielded `094218`).

### 2. The admin waitlist card (`CycleDetail.vue`, orders tab, below the all-friends fold)

- `loadGuestWaitlist()` runs inside `loadAll()` after `loadGuestLinks()` (the precedent), guarded
  by `guestWaitlistSeq`; it re-runs on every `loadAll()` because the complete PATCH is a purge
  path. ⚠ „Non-blocking" in this view means „a failure never blocks", NOT „no latency": `loadAll`
  awaits it behind the page's own „Načítavam...", so no in-flight state ever renders (a hold test
  proved it — the card simply appears later). `guestWaitlistLoaded` therefore only governs the
  „(N)" after a FAILED load (no count claimed); the error branch wins over „Nikto nečaká.".
- Grouped by `host_friend_id` (never the name — two friends may share one) in the server's
  order. Mobil = `phone_e164 || phone` (a non-normalising number is still a number to call).
  Dates are the admin's local day of the UTC timestamp, `1. 9. 2026`, via a local
  `formatWaitlistDate` — ⚠ NOT `lib/dates.js`: the PI-T12 admin-closure pin bans it from admin.
  `lib/plural.js` IS admin-legal (Distribution imports it), though the card needs no plural.
- Per-row `waitlistRowSeq` + `waitlistDeletePending` + ⚠ a per-row CONFIRM map too: with one
  shared `confirmId`, opening row B's confirm hid row A's held „Odstraňujem..." — the pending
  test caught it. And ⚠ **a ref passed to a helper FROM THE TEMPLATE arrives unwrapped**:
  `@click="clearRowFlag(waitlistConfirmOpen, row.id)"` handed the helper the plain object, so
  `bag.value = …` wrote a property and the confirm never closed. Script-side wrappers
  (`openWaitlistConfirm` / `closeWaitlistConfirm`) fix it; the „Nie" test is what went red.
- Every person-typed value (`name`, the phone, the host name) carries `data-user-copy`.

### 3. The admin standing row (`FriendDetail.vue`)

- ⚠ **No token in the DOM** — CycleDetail's §UC-GR-007 admin rule, not the host dialog's (which
  renders its own share URL by spec): `standingPath` is JS-only, „Kopírovať odkaz" composes
  `origin + url_path` at click time. Pinned by an `outerHTML` sweep for BOTH the old and the new
  token after a rotation, and a `:title` mutant reds it.
- ⚠ **PO-visible fact, kept (orchestrator):** opening a friend's detail MINTS their token (the
  admin GET is lazy, D1). Every friend the admin opens is back-filled; pinned by reading
  `friends.guest_link_token` NULL before and a token after the page load, and „a reload never
  re-mints".
- Inactive + no token ⇒ the 409 `inactive_host` message rendered as a muted refusal
  (`e.reason`, which `request()` already carries), no control, nothing minted (read back).
  Inactive + token ⇒ „Priateľ je deaktivovaný - odkaz teraz nefunguje." + copy + rotate.
- „Vygenerovať nový" → inline confirm with the host dialog's §UC-GL-008 item-2 copy (same fact,
  same rotation) → „Áno, vygenerovať" (disabled + JS-guarded, `standingSeq`) / „Nie".

### 4. ⚠⚠ BLOCKED — the host dialog's standing section cannot ship AND leave three specs unmodified

19 §UC-GL-008 audited the shipped pins for `p.sub`, `<b>` in `#subtitle`, `.confirmbox` and
`/Zdieľať/` — and missed four more, each of which a second `NeoCopyRow` (or the native-share
change) breaks in a spec the row says must pass UNMODIFIED:

1. `.copyrow` COUNTS in the dialog — `share-dialog.spec.js:271` (no link ⇒ 0), `:278`, `:309`
   (0 under the spinner), `:313`, `:503`, `:686` (cycle B has no link ⇒ 0), `:708`, `:731`;
   `guest-order-recovery.spec.js:316,358`.
2. Strict-mode singletons: `dialog.getByRole('button', {name:'Kopírovať'})` (`share-dialog:368`,
   `guest-link:291,342` — substring match, so any second copy button collides) and
   `dialog.locator('.copyrow button')` (`share-dialog:382`).
3. §UC-GL-008 item 3 „native share prefers the standing URL" vs `share-dialog.spec.js:540-548`
   and `:590-596`, which pin `url: ${origin}/g/${link.token}` — the PER-CYCLE token.
4. `share-dialog.spec.js:345` pins the error banner as the FIRST `.m-body` child (a standing
   section „at the top of the body" must sit below it — solvable, but it is another pin).

Options for the orchestrator/PO: (a) sanctioned retargets — scope the per-cycle assertions to a
`data-testid` wrapper around the per-cycle section and re-point the native-share URL at the
standing token (a case-(a) retarget citing §UC-GL-008); (b) render the standing section only when
`cycleId` is null — contradicts „with an open cycle both render in that order"; (c) a non-
`NeoCopyRow` standing row with a differently named button — forks the one-home component.
`waitingLabel()` is shipped for whichever lands. Nothing in `GuestShareDialog.vue` was touched.
**→ Option (a) SANCTIONED by the orchestrator 2026-09-23 — see the GL-T6b row in PROGRESS.md.**

### 5. Tests + mutations

`guest-waitlist.spec.js` +6 (`GL-T6 ·` describe: full rows + grouping + columns + markers;
cycle-independence across an open and a completed cycle; delete with „Nie"/„Áno" read back +
(N) + the host's `waiting_count`; per-row pending with a 15 s hold + a dispatched click ⇒ ONE
DELETE; a refused delete keeps the row; empty via route.fetch-and-edit + failed-load ≠ empty).
`guest-standing-link.spec.js` +7 (`waitingLabel` branches + BANNED sweep; mint-on-open + no DOM
token + clipboard + no re-mint; regenerate confirm/„Nie"/„Áno" + old 404 + new clipboard;
inactive-no-token refusal read back; inactive-with-token rotatable; a failed REGENERATE in its own sentence (review round, own ref `standingRegenError`); failed read + ONE POST).
Mutations, each red then restored: no delete JS guard; no in-place removal; raw phone instead of
E.164; group key off by one; count shown after a failed load; token in a `:title`; no regenerate
JS guard; `inactive_host` treated as an error; regenerate not updating the path.

### Seams left for the next rows

- The dialog half (§4) — needs the orchestrator's decision first. `api.getStandingGuestLink()`
  answers `{standing:{token,url_path,created}, waiting_count, current}`; `waitingLabel(n)` is the
  count line; the admin row's confirm copy is §UC-GL-008 item 2's, so the two stay in step.
- GL-T7 (guest vocabulary guard): the admin card/row copy is admin-only; `waitingLabel` passes
  `BANNED` (pinned).

---

## GL-T6b — the host share dialog's standing section (19 §UC-GL-008) (2026-09-23)

**What shipped.** `GuestShareDialog.vue` now renders, after the (still FIRST) per-cycle error
banner: `standing-link` — `div.field-lbl` „Stály odkaz pre kolegov" · `NeoCopyRow
value-testid="standing-link-url"` · the ONE native-share button · `standing-copy` (`div.field-help`,
PO copy verbatim) · `waiting-count` (only when > 0: `span.badge.acc` holding the whole
`waitingLabel(n)`) · „Nový stály odkaz" → `div.standing-confirm` („Áno, vygenerovať" / „Nie") →
`POST /guest-links/standing/regenerate`, row updated in place. Below it, only with a `cycleId`:
`per-cycle-label` „Odkaz len na túto objednávku", the loading `.sub`, and `per-cycle-link` wrapping
the shipped body verbatim. API frozen; one mount (FriendOrder) unchanged.

### 1. Decisions

- ⚠ **Structure is dictated by `.m-body > …` pins.** The per-cycle loading `.sub` must stay a DIRECT
  `.m-body` child (`share-dialog.spec.js` `.m-body > .sub` — NOT in the sanctioned list), so the
  testid wrapper wraps only the post-load states; the label and the spinner sit between. The error
  banner stays the first body child, so the `:346` pin needed NO retarget.
- ⚠ **Its own `standingSeq`, never `loadSeq`** — the two reads run in parallel and each drops only
  its own stale result; bumped on open AND close. Pinned by holding a `route.fetch()`ed (old-token)
  response past a reopen — a `route.continue()` after the delay would fetch the NEW token and prove
  nothing.
- **Native share prefers the standing URL** and falls back to the per-cycle URL ONLY after a FAILED
  standing read (`shareUrl`), never „not loaded yet" (a fast tap would share the other URL). The
  button renders in the standing section, or — fallback only — in the per-cycle section; never both.
- **The standing URL IS rendered** (NeoCopyRow text + `title`), like the per-cycle one — spec
  placement bullet 3. The admin's never-in-the-DOM rule (FriendDetail, GL-T6a) is a different surface.
- The two confirms share „Áno, vygenerovať", so opening one closes the other (`openStandingConfirm`/
  `openCycleConfirm`) — no strict-mode collision is reachable.
- Failed read ⇒ `.banner.danger.slim` `standing-error` in the section, no copy row, no rotation.
  Failed rotation ⇒ its own `standing-regen-error` sentence, confirm + old URL kept (GL-T6a lesson).
  Both strings are DRAFT copy („Stály odkaz sa nepodarilo načítať: …" / „Nový stály odkaz sa
  nepodarilo vygenerovať: …").
- ~~⚠ **`cycleId = null` has no reachable trigger** (drawer row + cartbar icon are `state === 'open'`
  only; the Kolegovia card is on an order screen).~~ **— DONE by GL-T6c (below): the drawer row now
  reaches the one instance on the locked / closed landings with `cycleId = null`.** The dialog supports it (the standing watcher never
  reads the cycle; every per-cycle node is `cycleId`-gated) and that is SOURCE-pinned. Wiring module
  18's closed-round menu entry is **GL-T6c** (PROGRESS.md) — it needs an entry point, since the one
  instance lives in `FriendOrder.vue`, and must keep the ONE-mount pin in `portal-landing.spec.js`.

### 2. Sanctioned retargets (option (a), each with a `// SANCTIONED RETARGET (GL-T6b, …)` line)

`share-dialog.spec.js`: `.copyrow` counts at 271, 278, 309, 313, 503, 686, 708, 731 and the
`Kopírovať`/`.copyrow button` locators at 368, 382 → scoped to `getByTestId('per-cycle-link')`;
the share-sheet `url` at 547 and 596 → `${origin}${standing.url_path}` via a new `standingOf(host)`
helper. `guest-link.spec.js:291,342` and `guest-order-recovery.spec.js:316,358` → scoped likewise.
`:346` untouched (passes). The „UNMODIFIED" claim is struck in 19 (three spots), 14:587, the
PROGRESS GL-T6 row and the `guest-order-recovery.spec.js` additivity-guard comment.

### 3. Tests + mutations

`guest-standing-link.spec.js` +10 (`GL-T6b ·`): order of sections + exact copy + clipboard + count
absent at 0 + payload has no `name`/`phone`/`rows`; count 1 → 2 with a notified row excluded and no
name in the DOM (planted rows — the shared target always has an open round, so the public POST 409s);
regenerate confirm/„Nie"/„Áno" + old URL 404 + per-cycle token untouched; confirm exclusivity; failed
+ pending (15 s hold, dispatched click ⇒ ONE POST); failed read + per-cycle fallback share; native
share = standing URL; loadSeq; 320px with a 12-row badge + open confirm; source pin (cycleId null).
Mutations, each red then restored: no stale-drop in the standing GET; share uses the per-cycle URL;
count shown at 0; confirms not exclusive; no regenerate JS guard; fallback share button always on;
rotation failure written to the READ error; watcher gated on `cycleId`; regenerate not updating the row.

### Seams left for the next rows

- ~~**GL-T6c** — module 18's menu entry for a CLOSED/locked round (open the dialog with `cycleId = null`); the dialog is ready, the entry point is not.~~ **DONE — see §GL-T6c.**
- GL-T7: the new strings pass `BANNED` (the share-dialog sweep in `portal-vocabulary` covers them).

## GL-T6c — the drawer share row on the locked / closed landings (19 §UC-GL-008 clause 1) (2026-09-23)

### 1. Decision — reach the EXISTING instance, not relocate it (option (i))

- **Relocation (option ii) was not available**, not merely larger: `/cycle/:id` mounts `FriendOrder.vue`
  STANDALONE (router), and its Kolegovia card opens the dialog there. Moving the mount into
  `FriendPortalSession.vue` would leave the deep link with none, so it would have to be TWO source
  mounts — exactly the „moved from A to B" the per-file pin exists to refuse.
- **What already existed:** every non-open landing that has anything to show mounts `FriendOrder`
  read-only — the LOCKED landing (`ref="lockedOrder"`, PI-T5, always) and the CLOSED catalogue
  (PI-T4, only when `catalogCycle` exists; it was ref-less). GL-T6c gave the closed mount its own
  `ref="closedOrder"` and the session one `computed` `shareHost = landingOrder || lockedOrder ||
  closedOrder` (the three mounts are mutually exclusive `v-if` branches). `requestShareDialog()` and the
  pending-open `watch` read `shareHost`. `portal-landing.spec.js` §4's per-file mount counts are
  UNCHANGED (FriendOrder 1 / session 0 / parent 0) and the profile-modal overlay census (10 mounts,
  8 terms) is untouched — no mount was added or moved; the share dialog is click-raised, not a term.
  ⚠ The `watch(shareHost, …)` sits AFTER `const lockedOrder` — `watch()` reads its source at setup, so
  above that declaration it is a TDZ ReferenceError that blanks the session.
- **Which cycle:** `null` on BOTH non-open landings, decided INSIDE `FriendOrder`:
  `shareCycleId = isReadonly || isLocked ? null : activeCycleId`, and `cycleName` is `''` with it (a
  dialog with no per-cycle section must not name a round in its subtitle). Spec basis: 05 §UC-KG-002 /
  18 §UC-PI-011 — a per-cycle link invites ORDERING into that round, and none of the Kolegovia share
  controls exist on a locked round either (`!isLocked`). The hand-over ticks on a locked round are
  the Kolegovia TAB's (kept, PI-T5), not the dialog's. ⚠ `isReadonly` (a PROP) is the term the
  landing relies on: `isLocked` reads the LOADED cycle, so alone it hands the dialog the round's id
  until the order GET lands — and forever on the closed landing's stubbed rounds (measured, M6).
- **Row condition (`shareRowShown`)**: open ⇒ shown; locked ⇒ `!!currentCycle`; closed ⇒
  `!!catalogCycle`. ⚠ **RECORDED GAP:** a CLOSED landing with NO catalogue (no locked and no
  completed round has ever existed — `landing-empty`) mounts no `FriendOrder`, so it has no instance
  to reach and the row stays hidden there. Covering it needs a second dialog mount or a new mount
  site, i.e. a change to the one-instance rule — a PO/orchestrator call, not this row's. In
  production it is unreachable once the first round has ever locked.
- **Sub-line:** unchanged code path — the colleague count is fetched for the OPEN round only, so a
  non-open row reads „Pošlite odkaz kolegom" (no new copy). No standing GET is issued from the
  session: it MINTS, and a drawer render would back-fill every friend's token.
- **State-modal stacking:** the row chosen from ANOTHER view on a closed / no-order-locked round
  goes to `/`, whose state modal raises once per session — it would stack a `LandingStateModal` and
  the share dialog on one layer. The explicit request counts as the state modal's dismissal
  (`dismissStateModal()` before the push); the slim banner that replaces the modal still carries its
  sentence. On `/` itself the modal is necessarily dismissed already (its scrim covers the hamburger).
- **Supersession** (each struck with a pointer here; the CARTBAR icon stays open-only — it is inside
  `.actions`, `v-if="!isLocked"`):
  - 18 §UC-PI-004: item 4's „`state === 'open'` only" (table) and its acceptance clause („the
    conditional 4th present only on an open round");
  - 18 §UC-PI-011: the business rule „Both exist ONLY when `state === 'open'`" AND its acceptance
    criteria's „locked ⇒ neither exists" (the latter missed in the first pass, caught in review);
  - 18 §UC-PI-019 item 6 („locked/planned ⇒ no share affordance") and item 14 („share when open");
  - 19 §UC-GL-008: the Goal's GL-T6b „source-pinned only" note (struck, marked DONE) and acceptance
    clause 1 (restored as true, the GL-T6b note kept struck);
  - code comments: `GuestShareDialog.vue` („No trigger reaches that today…"), `FriendOrder.vue`'s
    cartbar note („no share affordance" → no CARTBAR icon / no per-cycle link), and the session's
    item-4 / `lockedOrder` / closed-mount notes.

### 2. Pins changed (each carries a `SANCTIONED` comment)

- `portal-landing.spec.js` §3 „⚠ a round that is not OPEN offers no share affordance at all" →
  REWRITTEN as „…no cartbar icon, but the drawer row opens the STANDING-only dialog": locked +
  closed, 7 rows, zero-count sub, standing URL rendered (the non-vacuity gate), no `per-cycle-label`
  / `per-cycle-link`, no `.m-head .sub b`, one `.modal-layer`, URL `/`, and NO
  `GET /api/guest-links/cycle/*` for the whole test.
- `portal-landing.spec.js` PI-T4 „„Ako to funguje" dismisses AND navigates…": `.p2-mi` 6 → 7.
- `portal-landing.spec.js` §4 bridge regex `landingOrder.value.openShareDialog()` →
  `shareHost.value.openShareDialog()` + a pin on `shareHost`'s exact three-ref definition. Mount
  counts untouched.
- `portal-menu.spec.js` §1 „seven rows on an OPEN round, six otherwise" → „seven on open AND locked",
  plus the closed-no-catalogue six-row shape (so an unconditional row still reds).
- `portal-menu.spec.js` §1b „no open round ⇒ no count request…": rows 6 → 7, the row's sub is the
  zero copy; the no-request assertion is unchanged.
- Comment-only: `portal-session-boundary.spec.js` (header + §7 + the walk non-vacuity note),
  `portal-vocabulary.spec.js:574`, `guest-standing-link.spec.js` GL-T6b source-pin note (struck).

### 3. Tests + mutations

New: `portal-landing.spec.js` „GL-T6c · from ANOTHER view on a closed round … does NOT stack the
state modal" and „GL-T6c · ⚠ the ONE state without the share row: closed with NO catalogue";
`guest-standing-link.spec.js` „GL-T6c · FriendOrder binds the dialog to `shareCycleId`" (source).
HEAD (pre-implementation) reds 7 of the 22 selected tests. Mutations, each red then restored: the
mount back on `activeCycleId`; the row back to `state === 'open'`; the closed mount without
`ref="closedOrder"`; no `dismissStateModal()` in the pending path; the closed branch `return true`;
the `isReadonly` term dropped.

## GL-T7 — module-19 closeout: the guest surface joins the vocabulary guard, the guest „cyklus" strings are swept (2026-09-23)

19 §UC-GL-011 + the row's five items. Orchestrator copy decision: 18 §UC-PI-017's rule („objednávka",
never „cyklus"/„kolo") IS the PO's rule, so applying it to the guest strings is in scope. The new
strings are **PO DRAFTS**.

### 1. Strings changed. Status codes and `reason` values are byte-identical

| file:line (after) | old | new (DRAFT) | status / reason |
|---|---|---|---|
| `routes/guest.js:264` `CLOSED` (submit on a pre-open outcome, both token spaces) | Objednávanie v tomto cykle je už uzavreté. | Objednávky sú už uzavreté, objednávku už nie je možné odoslať. | 409 `closed` |
| `routes/guest.js:1138` (submit, lost lock race inside the tx) | Cyklus bol práve uzavretý, objednávku už nie je možné odoslať. | Objednávky boli práve uzavreté, objednávku už nie je možné odoslať. | 409 `closed` |
| `routes/guest.js:1227` (status-page PUT, round not open) | Cyklus je už uzavretý, objednávku už nie je možné upraviť. | Objednávky sú už uzavreté, zmenu už nie je možné uložiť. | 409 `closed` |
| `routes/guest.js:1372` (status-page PUT, lost race) | Cyklus bol práve uzavretý, zmenu už nie je možné uložiť. | Objednávky boli práve uzavreté, zmenu už nie je možné uložiť. | 409 `closed` |
| `routes/guest-orders.js:200` host `DELETE /:id` (not open) | Cyklus je už uzavretý, objednávku kolegu už nie je možné odstrániť. | Objednávky sú už uzavreté, objednávku kolegu už nie je možné odstrániť. | 409 `closed` |
| `routes/guest-orders.js:241` host `DELETE /:id` (lost race) | Cyklus bol práve uzavretý, objednávku kolegu už nie je možné odstrániť. | Objednávky boli práve uzavreté, objednávku kolegu už nie je možné odstrániť. | 409 `closed` |
| `components/GuestProductGrid.vue:91` `emptyMessage` default | V tomto cykle zatiaľ nie sú žiadne produkty. | V ponuke zatiaľ nie sú žiadne produkty. | — |

- **The edit-409 does NOT reuse the read-only sentence.** The first draft was „Objednávky sú už
  uzavreté, objednávku už nie je možné upraviť.“, which is one word away from CS-T4's
  `readOnlyReason`. Measured on the page: after a 409 `submitEdit()` reloads into the READ view, and
  BOTH banners render stacked (`status-readonly` + `status-error`). So the server half now says what
  failed, the save, worded like its lost-race twin („…zmenu už nie je možné uložiť.“).
- ⚠ **PO DRAFT QUESTION — „uzavreté" vs „uzamknuté" (review).** The host DELETE 409 (`guest-orders.js:200`/`:241`)
  says „Objednávky sú už uzavreté / boli práve uzavreté“, but it renders on the FRIEND surface (Kolegovia tab),
  whose own lock copy says „uzamknuté" („Objednávky sú uzamknuté.“, the lock chip). The guest surface says
  „uzavreté" (CS-T4's `readOnlyReason`), so the draft matches the guest register, not the friend screen it
  lands on. The PO picks one register for the host pair; the status code and `reason` do not move either way.
- **The audience decision on the admin 409s: KEPT.** `POST /api/guest-orders/:id/cancel` (`:530` /
  `:567`, „Cyklus je už uzavretý / bol práve uzavretý, objednávku kolegu už nie je možné zrušiť.“) is
  `requireAdmin`, and only `CycleDetail.vue` calls it (`cancelGuestOrderAdmin`). „cyklus“ is the
  admin's word, the same rule as PI-T11 §3 (`cycles.js` and the admin `guest-links.js` routes). The
  admin `GET /cycle/:cycleId/unpaid` 404 („Cyklus nebol nájdený“) stays for the same reason. Both
  halves are pinned: a re-wording of the admin string reds too, so the decision can only move on purpose.
- **Row inventory vs. what was found.** The row named `CLOSED` plus the four `guest-orders.js`
  strings. The grep found three more in `routes/guest.js`: the submit race and the two status-page PUT
  409s. All three render verbatim, through `checkout-error` and through `edit-error`/`status-error`,
  so they were swept too. `routes/guest.js` is public end to end, so the guard sweeps the whole file.

### 2. The guard: a SEPARATE guest list, unioned. Not two more entries in `FRIEND_SURFACE_ROOTS`

The row (and the `vocabulary.js` header) said to add the guest views to `FRIEND_SURFACE_ROOTS`.
Deviation: `e2e/helpers/vocabulary.js` now exports `GUEST_SURFACE_ROOTS`
(`views/GuestOrder.vue`, `views/GuestOrderStatus.vue`) and `VOCABULARY_ROOTS` = friend ∪ guest.
`importClosure()`'s DEFAULT stays the friend closure. Why:
- `portal-vocabulary.spec.js` §2 reads `FRIEND_SURFACE_ROOTS` as „the friend surface". Its
  „derived ⊇ §UC-PI-017's hand list" and admin-only pins are about THAT surface. A guest view in a
  list named FRIEND is a lie that a later reader acts on.
- `portal-shell.spec.js` calls `importClosure(roots)` for its own shell rules. Changing the default
  would have silently changed what those callers measure.

§2's source sweep now walks `importClosure(VOCABULARY_ROOTS)`: 65 friend files plus the guest-only 8
(`GuestBrandHeader`, `GuestInviteRequest`, `GuestProductGrid`, `GuestRoastersLine`, `GuestSteps`,
`lib/purposes.js` and the two views). The new §6 of `portal-vocabulary.spec.js`:
- **Source.** `GUEST_SURFACE_ROOTS` is pinned EQUAL to the components `router.js` maps `/g/…` to. A
  third guest route reds instead of escaping. It checks that the closure resolves every import and
  walks through the views. The guest-closure sweep carries `assertReadable` gates.
- **Server source.** All of `routes/guest.js`, comments stripped. `routes/guest-orders.js` is split
  per `router.<verb>(` block: the preamble plus the non-`requireAdmin` blocks must be clean, and the
  admin cancel block must still contain the kept string (the audience pin).
  (Review:) two gates were added under it. First, the block count must equal every `router.<verb|route|use>(`
  registration in the RAW file, at any indentation. An indented registration mutation took it from 6 to 5
  blocks and turned it red. Second, every raw `error:`/`message:` literal must survive `stripComments`:
  32/32 in `guest.js`, 20/20 in `guest-orders.js`.
- **Live.** One locked-round fixture exercises the guest submit, the status PUT, the host DELETE and
  the admin cancel. It checks each exact body (`{error, reason}`) and each status code.
- **Rendered.** Three screens, each swept with `expectCleanCopy` (the ONE `BANNED`, copy-sweep):
  - the LIVE listing of an open round with zero products (the grid's empty banner);
  - the checkout refused by a lock (`CLOSED` in `checkout-error`);
  - the status page's EDIT mode, and its save refused by a lock (`status-error` after the reload).

**Red first (HEAD strings, new tests):** 7 of 11 selected red for the right reasons: the grid line
in both source sweeps, the `CLOSED` source token, the live bodies and the three rendered screens.
**Mutations** (each red, then restored):
- a banned word in `GuestSteps.vue`, a guest-only file: reds both the union sweep and the guest sweep;
- `GuestOrderStatus.vue` dropped from `GUEST_SURFACE_ROOTS`: reds the router-equality test and the
  closure test;
- the host race 409 restored to „Cyklus bol práve…“: reds the server-source test;
- the admin cancel re-worded: reds the audience pin;
- „Kolo“ in the guest edit-race string: reds the server-source test.

### 3. Pins re-pointed

- `guest-standing-link.spec.js` — the GL-T2 probe's `out.submit` body (`CLOSED` text, SANCTIONED
  comment) + the pre-open sentence comment („not in the source guard yet (GL-T7)" struck).
- `guest-invite-dead.spec.js` — the describe title „three variants" → „two variants (`closed`
  superseded by 19 §UC-GL-002)" + its 5xx-test comment. The test NAME changed, not an assertion.
- Nothing else in `e2e/` pinned any of the seven strings (grepped per message).
  `guest-order-recovery.spec.js:2653` stubs the ADMIN cancel 409, whose text is kept.

### 4. Supersessions written into every copy (strike + pointer)

- 06: the scope line's „three variants", the §UC-GX-010 title, its acceptance clause, and the
  §UC-GX-002 empty-state string. The `closed` table row was already struck by GL-T2.
- 18 §UC-PI-017's hand-off list: the client + `CLOSED` block (ALL SWEPT) and the `guest-orders.js`
  paragraph (DECIDED).
- 19: rule 5's „shipped message" (the §208 pin the row names, now at :217) and the „CLAUDE.md
  staleness" accepted risk (DONE). The OPEN PO sign-off list gains this row's strings.
- Learnings: 09 (the „THREE → TWO strings" inventory → RESOLVED) and 10 §PI-T11 §2/§3.
- The PI-T11 PROGRESS row's „to `FRIEND_SURFACE_ROOTS`", the `vocabulary.js` header, and CLAUDE.md's
  surviving-strings paragraph (→ SWEPT).
- `routes/guest.js` comments were already struck by GL-T2 (header status-code list, the listing's
  handler comment). No other `closed`-410 claim survives in `backend/src`.

### 5. CLAUDE.md one-liners — checked, not duplicated

„Two token spaces" and „one resolver" landed with GL-T2's `/g/:token` bullet. „`helpers/standing-link.js`
mints every link token" landed with GL-T1's `guest_link_token` bullet. GL-T7 adds only the missing
clause to the resolver bullet: „the per-cycle token NEVER reaches a standing visitor". It adds one new
rule line for the widened guard. The `guest_link_token` bullet's struck „not in the scrub yet" already
carries GL-T6's pointer.

### 6. Gate

- `node --check` on `routes/guest.js` and `routes/guest-orders.js`. `npx playwright test --list`:
  2490 tests in 94 files. Frontend built into `backend/public`.
- Gate server on :3997 with a fresh template copy per run. The seed ran WITH `DB_PATH` („pre-stamped
  77 friend(s); 1 left"), all five limiter maxima were at 100000, and the `GOOGLE_*` test env was set.
- Targeted run (11 files, reconciled against `--list`: 11 of 11, 501 tests): `portal-vocabulary`,
  `cycle-stages`, `guest-order`, `guest-order-recovery`, `guest-host-view`, `guest-status`,
  `guest-status-shell`, `guest-standing-link`, `colleagues-panel`, `guest-invite-dead`,
  `guest-order-shell` — **501 passed**.
- **FULL SUITE** (`--workers=1`, `DB_PATH` + `SERVER_LOG`): **2486 passed, 4 skipped, 0 failed,
  14.0 min**. The 4 skips are the documented ones: `forced-change-ui`'s fixme plus the three limiter
  specs. Files that ran reconcile against `--list`: 94 of 94. Box load average was 1.2–1.7 on 8 cores,
  so the ~14 min is load, not a regression. The server log has no `disk image is malformed`; its three
  „malformed" hits are the image-upload specs' own `multipart-malformed` 400s.
