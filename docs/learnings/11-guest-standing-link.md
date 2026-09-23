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
one on GL-T3 for `guest_waitlist` (non-member PII). ⚠ Rule of thumb for the next credential
column on a prod table: the scrub lines ship WITH the first row that can put a real value in
production, and only once production already has the column.

### Seams left for the next rows

- GL-T2: `uniqueGuestToken()` for the get-or-create per-cycle row; `currentOpenCycle()` is
  rule 2 (widen its column list additively, keep it one query); the standing-token lookup goes
  in `resolveEntry`, never in `LINK_SELECT`.
- GL-T3: the first `guest_waitlist` writer; `waitingCount()` already counts it (un-notified
  rows). ⚠ BLOCKING: `guest_waitlist.name` / `phone` / `phone_e164` are NON-MEMBER PII — the
  scrub + verify pair must cover them before the public writer reaches production (§13; ask the
  PO whether the „names are kept" rule, made for friends, extends to strangers).
- GL-T6: `api.getStandingGuestLink` / `regenerateStandingGuestLink` (host dialog) and
  `adminGetFriendStandingLink` / `adminRegenerateFriendStandingLink` (AdminFriends) exist.
  ⚠ BLOCKING: `scrub-template.sql` + `verify-scrub.sql` must NULL / check
  `friends.guest_link_token` before any production mint (§13 — the exact lines are in the GL-T6
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
