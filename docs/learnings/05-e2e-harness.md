# E2E harness traps — running playwright from the wrong cwd

> Moved verbatim out of `CLAUDE.md` on 2026-09-03 (it had grown to 153 KB). These are the full per-task learnings; the load-bearing rules are summarised in `CLAUDE.md` → Hard rules. **Append new learnings for this area HERE, and add only the one-line rule to `CLAUDE.md`.**

### ⚠ Running playwright from the repo ROOT is a FALSE-GREEN vector (GA-T10, 2026-08-17)

`npx playwright test` **must** be run from `/home/karolskolar/projects/gorifi/e2e`. From the
repo root it resolves a **second** `@playwright/test`, dies with *"did not expect
test.beforeAll() to be called here"*, and reports **`Error: No tests found`** — which a
script checking only for `✘` lines reads as a clean run. A GA-T10 mutation probe
"passed" that way and proved nothing; both affected runs had to be redone.

⚠ The general form: **`No tests found` is not a pass.** Any wrapper that greps for
failures must also assert a non-zero test count, or a wrong cwd, a bad `-g` filter and a
typo'd path all look identical to success.

⚠ **And the failure GLYPH is REPORTER-DEPENDENT — never grep for it alone** (measured on
this repo's Playwright 1.61, GR-T4): **`list`** (the config default,
`e2e/playwright.config.js:18`) emits `✓` / `✘` / `-`; **`line`** emits **no glyphs at
all** — progress as `[k/n]`, failures as `1) [chromium] › …`; **`dot`** emits `·` / `F`
/ `°` and no `✘`. A `grep -c "✘"` therefore returns **0 on a run with real failures**
under `line` or `dot`. The reporter-independent check is the summary: assert there is no
`N failed` line **and** that an `N passed` with N > 0 exists. Same class as the rule
above — a green-looking wrapper that measured nothing.



### ⚠ The DB is an INPUT — and the recipe that said so contradicted itself (GR-T9, 2026-09-19)

`97b29de` (2026-08-31) landed most of this row: `e2e/make-test-db.sh` (a production-shaped
template, scrubbed on the server, fail-closed before download), the README section headed
*"The database is an INPUT — copy the template, never reuse a working file"*, and a fix to
`item-packed.spec.js`. What it did **not** do is reconcile the recipe people actually copy:
thirty lines below the new section, *"Run against a local prod-like backend"* still said
`DB_PATH=/tmp/gorifi-e2e.sqlite` — one fixed, reused path. **The document argued with
itself and the losing half was the one inside the code block.** Prose loses to a code block
every time; when a rule changes, the runnable copy of it is the one that must change first.

The recipe is now numbered, and the numbers are load-bearing: **build → stop the server by
the owning PID → confirm the port free → copy the template to a per-run path → start →
`seed.mjs` → run**. It was executed literally, from a clean shell, before being written
down — which is the actual deliverable here, since *a recipe nobody executed is the defect*.

**⚠ The per-run copy makes a NEW trap more likely, and it was reproduced deliberately
before being documented.** ~~Replace the DB file under a server that is still running and
the kernel keeps that process on the **deleted inode** — `/proc/<pid>/fd/20 →
…/run.sqlite (deleted)`, measured — while the fresh copy sits on disk, untouched.~~
**SUPERSEDED in review — wrong mechanism for this recipe; see "GR-T9 review round 2" at
the end of this file.** Step 3 copies to a fresh `mktemp -u` name per run, so no file is
ever swapped under the running server, and a plain `cp` onto an existing path truncates in
place rather than unlinking. The deleted-inode state is real but needs an `rm`/`mv` first,
which only the fixed-path variant does. What is right, and is the actionable half: start a
second server while the old one holds the port and it dies with `EADDRINUSE` **in its own
log only**; the port stays owned by the old process, so every request, `seed.mjs`
included, lands on the old accumulated data. Nothing errors. **The only tell is `seed.mjs`
printing `cycle: exists` / `friend: exists` / `admin: already set up` on what should be a
fresh copy.** CLAUDE.md already said to kill by the PID owning the port; what was missing
was that this rule also fixes an *ordering* — stop, confirm, THEN start.

**⚠ `item-packed.spec.js` was still broken, because the fix landed on ONE of TWO identical
sites in the same file.** `97b29de` fixed the API describe block's `beforeAll` (unique
product names + an asserted 201) and left the UI describe block's `beforeAll` 70 lines
below on fixed names (`'GSO-T1 UI Coffee A'`) with an unchecked response. Same four-step
chain, same misleading landing point: 409 `duplicate_in_cycle` → `p1.id` undefined → cart
prices nothing → `total 0` deletes the order → `expect(submit.status()).toBe(200)` sees a
404. Measured against one DB before the fix: **pass / fail / fail**; after: **3/3, three
times**, on a database that had already served four `share-dialog` runs. The commit's claim
of "3 consecutive runs pass" was true of the half it touched. This is the repo's own
documentation-discipline rule (FUP-T20, GR-T5) in *code*: **a fix stated once must be
applied to every copy of the construct, and the grep is `beforeAll` in the file you just
edited.**

**⚠ The template was leaking the PO's real IBAN.** `make-test-db.sh`'s settings scrub
deleted the password rows but not `payment_iban` / `payment_revolut_username`, and its
fail-closed verification did not check them — so every template built before 2026-09-19
shipped a real bank account and Revolut handle under a banner saying the file is scrubbed.
It stayed invisible because `seed.mjs` step 3b fills payment settings only when **both**
are empty, so it printed *"payment details already present, left untouched"* and moved on.
Both keys are now in the DELETE and in the verification; no spec hardcodes the IBAN (they
all read it back from `/api/admin/payment-settings`), so `seed.mjs` writing the fixture
value is a pure improvement. **A "scrubbed" claim is only as good as the fail-closed check
behind it — the check is the claim.**

**The 1500 ms budget in `share-dialog.spec.js:275` was left alone, on measurement.** The
row asked whether it is still too tight once the DB is controlled. Against per-run copies:
**15/15 in 15.9 / 15.8 / 15.7 s**, the `page.route`-delayed loading test costing **2.3 s
every single time** (1.5 s of it the deliberate delay). Re-run four more times against one
already-used copy: 15.8 / 16.1 / 16.4 s, loading still 2.3 s, 15/15 throughout. There is no
spread to widen for, and a timeout widened without need is a slower suite and a weaker
test. `guest-admin-view` + `guest-host-view`, the row's sporadic 30 s casualties, ran
**59/59 in 24.6 s** on the accumulated copy.

**Fixture cleanup in the heavy helpers — considered and rejected.** The row offered it as
the "and/or" alternative. **24 spec files define their own `makeCycle` and/or
`makeHost`** (21 define `makeCycle`, 16 define `makeHost`, 13 define both — counted, and
the round-1 write-up said "21", which was the `makeCycle` figure and understated the
argument), so teardown is 24 edits with 24 chances to diverge — the multi-copy failure this row is
about — and a helper that deleted its cycle would have to unwind the cascade the app owns
(orders, guest links, sub-orders, ledger rows), which no helper does today. The per-run
copy buys the same isolation with no new code; measured above.

⚠ **The first draft of that paragraph cited `share-dialog.spec.js:538` as "a test that
reads state an earlier test created". It does not** — it makes its own host and cycle,
navigates to that one cycle, and counts share BUTTONS; grepping the file finds no
assertion that counts portal cycles at all. Caught in review. A decision is only as
durable as its citation: the reasoning survived, but a future reader who checked the
pointer would have reopened the whole question. **Check the line you cite, especially
when it is the evidence for NOT doing something.**


### ⚠ GR-T9 review round 2 — the scrub was narrower than it claimed, twice (2026-09-19)

The blocker: the template built **after** the payment-keys fix above still carried
**76 `friends.access_token`s, 11 real third-party Gmail addresses in
`friends.google_email`, and a live `invitations.google_sub` + `google_email`** — while
`friends.email` beside them was correctly randomised and `friends.google_sub` was
correctly nulled. The fail-closed check returned a confident `0`, because it covered
**9 of the 22 things the scrub writes**. The README paragraph promising "a fail-closed
check that refuses to download anything while a single row still carries production
contact data or a credential" was therefore false about the artifact it described — and
the GR-T9 diff had just STRENGTHENED that sentence.

⚠ `invitations.google_sub` is not inert: `routes/invitations.js:572,653` copies it onto
the friend row created at approval and `:321,580` matches on it. A template holding it is
a live Google identity, not a stale string.

⚠ **`friends.google_email` is the instructive one.** `friends.email` was scrubbed; the
column next to it, holding the same class of data for the same people, was not. That is
the whole failure mode in one row: **the scrub enumerates columns, and an enumeration
drifts from the schema silently.** Same shape as the payment keys, found the same way —
by querying the artifact instead of reading the script.

Three structural fixes, not just three more columns:
1. The SQL moved out of the script's heredoc into **`e2e/scrub-template.sql`** and
   **`e2e/verify-scrub.sql`**, piped over ssh. One copy, so the local re-scrub runs the
   same bytes the server runs — and the quoted-heredoc trap (bash expanding backticked
   SQL comments and executing `node e2e/seed.mjs` from inside one) is retired rather than
   commented around.
2. The verification is now **one line per column the scrub touches**, printing all ~~22~~ **26 since GL-T6** (the standing token + three `guest_waitlist`
   columns — learnings 11 §GL-T6)
   named counts on success and naming the offenders on failure. The contract is written
   at the top of both files: add a column there ⇒ add a line here.
3. **`e2e/scrub-local.mjs`** re-scrubs or verifies a template locally, using those same
   SQL files, with no sqlite3 CLI needed — plus a **raw byte scan** over the whole file
   including freed pages, because `VACUUM` is the only thing between a deleted row and
   `strings`.

`friends.access_token` was **regenerated rather than argued safe.** No route
authenticates with it (it is INSERTed at creation and stripped by `sanitizeFriend`), but
`routes/friends.js:18` calls it "a live auth credential" and 76 production values were
leaving the server. **A comment and an artifact that disagree is the defect; pick one.**

⚠ The byte scan's first version reported **36 false leaks**: SQLite packs a row's values
end to end with no separator, so an e-mail regex runs on into the next column and
`friend21@example.test` reads as `friend21@example.testgfriend21`. Testing the tail
(`endsWith('.test')`) flagged every scrubbed address. Judge the DOMAIN's head instead.

Three more review findings, all the same species as the row itself:
- ⚠ **The readiness probe in the new recipe could never succeed.** It polled
  `GET /api/cycles`, which is `requireAdmin` (`routes/cycles.js:52`) and answers 401, so
  `curl -sf` always failed and the loop was a blind 15 s sleep wearing a health check's
  clothes — in a recipe whose stated deliverable is that it was executed literally.
  **Executing a script is not the same as observing each step do its job.** Now
  `/api/health` (public, `index.js:126`), with a trailing re-check that fails loudly.
- ⚠ **The inode mechanism documented in round 1 was wrong for this recipe**, and it had
  already been copied into `CLAUDE.md`. Step 3 uses `mktemp -u`, a NEW name per run, so
  nothing is ever swapped under the running server; and a plain `cp` onto an existing
  path truncates in place rather than unlinking, corrupting an open database instead of
  orphaning an inode. The deleted-inode state is real — it was reproduced — but it needs
  `rm`/`mv` first, which only the fixed-path variant does. The ACTIONABLE half (free the
  port first, `EADDRINUSE` hides in the second server's log, the tell is `seed.mjs`
  saying `exists`) was right and stays; the mechanism is now stated for the recipe that
  exists. **A wrong mechanism in the canonical rules file is worse than none.**
- A fourth runnable copy of the server-start line in the limiter section referenced
  `$RUN_DB`, undefined for anyone who jumps there, and omitted the Google vars, `setsid`
  and both redirects. Replaced with a pointer. **Two sections disagreeing about how to
  start the backend is what created this row.**

**Round-2 review approved the above and found three more, all the same species (2026-09-19):**

⚠ **The shell gate was fail-OPEN on the SHAPE of its input** — the exact mistake the
blocker was about, one level up. It checked "output non-empty" and "no line has a
non-zero second field", so any line with `NF != 2` was silently ignored: a lost
`.mode`/`.separator` dot-command, a changed separator or a truncated run yields an empty
offender list and a **download under a "verified" banner**. It now asserts the shape too
— every line must be `name|integer`, and there must be as many lines as
`verify-scrub.sql` has checks, a count **derived** by grepping that file for its
one-`SELECT '<name>'`-per-line convention (stated in its header) rather than hardcoded.
`scrub-local.mjs` was already immune: its rows come from a prepared statement, not from
parsing text. **A gate that validates values but not the shape of what it was handed can
only ever be as trustworthy as the thing feeding it.**

Proved non-vacuous by extracting the shipped block and feeding it eight synthetic
shapes: clean 22 → exit 0; one non-zero → 1; 21 lines → 1; tab separator → 1; empty → 1;
non-numeric count → 1; a leaked header row (23 lines) → 1; count mismatch *and* a
non-zero together → 1, printing both messages.

⚠ That last case exposed a second bug in the reporting path: `[ "$ACTUAL" != "$EXPECTED" ]
&& echo …` looks like a guarded print, but under `set -e` a **false left operand makes the
whole AND-list fail**, which exits the script right there — so whenever the count matched
but a real leak was found, the script would have aborted before printing the offender.
`if/fi` instead. **A reporting path has to survive its own guard**, and `set -e` turns
`cond && report` into `cond || abort`.

⚠ **`make-test-db.sh` could leave an UNSCRUBBED production snapshot on the server.**
`$REMOTE_TMP` is a full copy for the seconds between `.backup` and the scrub; if either
ssh failed, `set -e` aborted *before* the cleanup line and left it in the server's `/tmp`
indefinitely. Now a `trap cleanup_remote_tmp EXIT` installed immediately after the
assignment (so the variable is always in scope when it fires), and it is the ONLY home
for that `rm` — the success and failure paths no longer repeat it. Pre-existing, but this
row is about the gap between a "scrubbed" claim and the artifact, and a snapshot that
never reached the scrub is the widest version of that gap.

⚠ **"21 spec files define their own `makeCycle`/`makeHost`" was wrong** — 21 is the
`makeCycle` figure alone. **24** define at least one (21 `makeCycle`, 16 `makeHost`, 13
both). The error *understated* the argument it was supporting, which is the easiest kind
to leave standing. Counted, not estimated, and corrected in both copies.

⚠ **A bare positional filter is a SUBSTRING match, so the file list you TYPED is not the
file list that RAN** (CS-T1, 2026-09-20 — caught by the orchestrator's count differing
from mine by exactly 89). `npx playwright test guest-order …` collects
`guest-order.spec.js` **and** `guest-order-shell.spec.js` **and**
`guest-order-recovery.spec.js` (28 + 13 + 89 = 130). Both runs were green and both counts
were right; the gap was one whole spec file I never named. Two consequences, and the
second is the dangerous one:

- **Report the files that RAN, not the ones you passed.** `grep -oE 'tests/[a-z0-9-]+\.spec\.js'
  <run log> | sort | uniq -c` is the per-file breakdown, and it is the only honest answer
  to „which files did you run". A reported list assembled from the command line is a
  claim about intent, not about measurement — the same class as the DP-T2 false clean
  (`N passed` with DB_PATH silently empty) that §Running the e2e suite already warns about.
- ⚠ **The inverse was CLAIMED here and it is FALSE — measured, not reasoned (2026-09-20).**
  The first draft of this entry said a filter matching no file "collects nothing and Playwright
  reports that as a clean pass". It does not: `npx playwright test tests/zzz-nonexistent.spec.js`
  answers `Error: No tests found.` on **exit 1**, both as a run and under `--list`.
  ⚠⚠ ~~Under-collection is LOUD. **The asymmetry is the whole lesson: over-collection is the
  silent one.**~~ **THAT CORRECTION WAS ITSELF INCOMPLETE — falsified by PI-T5 (2026-09-20), and
  the incomplete half is the DANGEROUS one.** Measured: loudness holds only when EVERY filter
  matches nothing. In a list where ONE entry misses **and the others match**, Playwright runs the
  matches, DROPS the missing entry in silence and exits **0**. That is the ordinary shape of a
  targeted gate, so a deleted or mistyped spec leaves a row's verification with the summary still
  reading „N passed". PI-T5 passed `tests/order-flow.spec.js`, which does not exist, and the run
  said nothing. **Both directions are silent in the case you will actually hit; the only defence
  is to reconcile the files that RAN against the files you asked for.** See CLAUDE.md
  §Running the e2e suite. ⚠ Note what happened here: a correction written to fix an over-broad
  claim was itself stated more broadly than it had been measured, in the file whose job is to stop
  that. Measure the case you are about to generalise over. A filter that
  matches more files than you meant runs them, passes them, and inflates a count that nobody
  reconciles — which is exactly how this 89-test gap was born. Anchor with the `.spec.js` suffix
  to bound the match, and read the files that RAN off the log rather than off your command line.
  (The genuinely silent failures in this harness stay the ones §Running the e2e suite already
  names: a lost `DB_PATH` removing assertions, and a wrapper that greps for „N failed" instead of
  asserting „N passed" — a wrapper like that would indeed read `No tests found` as success, but
  Playwright itself never does.)

⚠ Related non-finding, checked and ruled out before blaming the data: `nonstring-body-shape`
(272) and `api-security` (81) generate their cases from arrays, so a differently-populated
template or a different `ADMIN_ENDPOINTS` length WOULD move them. Both matched the other
run byte-for-byte, which is what proved the gap was a file and not fixture state. Compare
per-file counts before reaching for a data-driven explanation.


### ⚠⚠ ONE `admin_token` row, 42 cached copies of it — the load-sensitive false regression (FUP-T27, 2026-09-20)

**The defect, in one line.** The backend keeps exactly ONE `admin_token` row and every
`POST /api/admin/login` REPLACES it, so a login anywhere in the suite — including one whose
response lands *after its own test already timed out* — kills the token every other spec
file cached in its own `beforeAll`. Those files then 401 on their next fixture
(`POST /api/friends`, `POST /api/cycles`), and the run reads as „a dozen unrelated admin
files regressed".

⚠ **The first failure in the cascade is a 10 s TIMEOUT on the admin login redirect, not a
401.** The 401s are downstream. That inversion is why PI-T3 spent a day building a theory
about spec-file ordering: the same tree ran 115-failed and 33-failed on a loaded box and
0-failed on an idle one (`10-portal-ia.md` §10). It is a LOAD-SENSITIVE LATENT DEFECT, not
a regression, and it has been in the suite as long as the convention that mitigated it.

**What shipped.** `e2e/helpers/admin.js` — `makeAdmin({ ctx, token, adopt, timeout })`,
ONE home for the admin request path, which re-authenticates **exactly once** on a 401 and
publishes the fresh token back into the calling file's own `adminToken` variable. The 42
spec files that carried a private `async function admin(path, opts)` adopt it; their
`admin()` definition becomes a six-line `makeAdmin({…})` call, so the diff is a swap, not a
rewrite. `e2e/tests/admin-token-retry.spec.js` is the row's real deliverable.

#### 1. ⚠⚠ THE ACCEPTANCE BAR WAS A REPRODUCTION, NOT A GREEN SUITE — and that was right

PI-T3's implementer refused to write this fix because it could not reproduce the failure.
The reproduction turned out to be four lines: **a second `APIRequestContext` that logs in**
is the rotation, in full. No load, no timing, no ordering.

`admin-token-retry.spec.js` therefore pins, in this order:

| § | Property | Why it is there |
|---|---|---|
| §1 | a cached token that worked a moment ago 401s after a login from another context | **THE DEFECT ITSELF**, and the non-vacuity gate for everything below — without it §2 proves only that a working token works |
| §2 | the same rotation, through `makeAdmin()`, succeeds — in exactly ONE login — and the refreshed token is published back | the fix |
| §3 | a 401 re-authentication CANNOT fix (`GET /api/friends/1/profile` — an admin token is not friend identity) comes back 401 after ONE login attempt | not a loop; a loop hides a real auth failure behind a timeout |
| §4 | the retry, applied to `api-security.spec.js`'s staleness assertion, answers **200 where that test needs 401** — plus a source pin that the file does not import the helper | the exclusion, DEMONSTRATED |
| §5 | no spec file keeps a private `admin(path, …)` copy | 42 copies is how one of them stops working |

⚠ **§1 is the part to keep.** A harness fix whose only evidence is „the full suite went
green" is unfalsifiable, and this module has paid for that pattern repeatedly. §1 keeps the
pre-fix shape (`cachedAdmin`) alive in the file on purpose, so the defect stays reproducible
*after* the fix.

#### 2. ⚠ THE EXCLUSION IS A LIVE TEST, NOT A COMMENT

`api-security.spec.js:377` asserts „a STALE token (rotated out by a later login) logs out
nothing", and its non-vacuity line is `expect(stale → GET /api/friends).toBe(401)`. A
retrying helper turns that into a 200 and **deletes the test's meaning while leaving it
green**. „Remember not to adopt it there" is not a guard, so it is pinned twice: §4 runs the
assertion through the helper and asserts the 200 (so the hazard is measured, not described),
and a source pin asserts the file contains neither `helpers/admin.js` nor `makeAdmin`.

**M4 proved both halves on demand**: routing that one line through `makeAdmin` reds
`api-security.spec.js:377` with *Expected 401 / Received 200* **and** reds the source pin in
the same run — i.e. the guard fires before a human has to notice the deletion.

#### 3. ⚠⚠ THE SWEEP MATCHED ITSELF — the `pgrep -f` trap in a new costume

§5's first version filtered spec files on `/async function admin\s*\(\s*path/` and reported
**itself** as an offender: the regex literal *and the test title* both contain that text, and
the sweep reads every file in `tests/`. Same shape as the `pgrep -f "playwright test"`
watcher that matches its own command line — the rule this repo already documents, arriving
from a completely different direction. Fixed the same way: a bracket class
(`[a]dmin`) the file cannot contain, **and the title reworded**, because a title is file text
too. Its non-vacuity gate now asserts the pattern still matches the retired shape,
assembled from two string halves so the control cannot resurrect the self-match.

#### 4. Small things measured rather than assumed

- **42, not 48.** The measured count of files carrying a private `async function admin(`
  is 42, all at column 0, all one of four near-identical shapes (± `timeout: TIMEOUT`,
  ± `...(opts.headers || {})`, ± `opts.data !== undefined`). A scripted swap matched all 42
  with zero unmatched.
- ⚠ **The import insertion broke two files and `--list` is what caught it.** A naive „insert
  after the last `import` line" put the new import INSIDE the multi-line
  `import { CAN_SPAWN_BACKEND, … }` of `guest-order-recovery.spec.js` and
  `invitation-approval.spec.js` — a `SyntaxError` at collection, which `--list` reports as
  **`Total: 0 tests in 0 files`**. That is the „`No tests found` is not a pass" rule paying
  for itself: a wrapper grepping for `✘` would have called it a clean run. **Run `--list`
  after any scripted edit of the suite** — it is 20 s and it type-checks the whole tree.
- **`adopt` is not bookkeeping.** Most adopting files use `adminToken` in more places than
  their `admin()` helper (seeding `localStorage` for a UI admin test, raw `ctx.*` headers).
  Without publishing the refreshed token back, the retry fixes one call and leaves the next
  eleven stale — **M3 reds three tests**, not one.
- **The files that inline `headers: { 'X-Admin-Token': adminToken }` are NOT converted** — ⚠ MEASURED, because „31“ was wrong under every reading: **41** spec files mention `X-Admin-Token`, **34** do not adopt the helper, **28** carry the exact inline shape and **23** of those do not adopt. ⚠⚠ FIVE files BOTH adopt AND still inline (`cycle-stages`, `distribution-handover`, `guest-order-recovery`, `invitation-approval`, and this row's own spec) — so a file appearing in the „adopted“ list is NOT thereby protected: `cycle-stages`' and `distribution-handover`'s PATCH matrices still build their own header and get no retry.
  and are the remaining gap, named here rather than left to be rediscovered:
  `catalog-admin`, `magic-link`, `image-upload`, `ssrf`, `modern-login`, `session-expiry`,
  `first-password`, … Adopting them is a bigger, less mechanical diff (147 assignment sites
  suite-wide); the home exists and `makeAdmin` takes them unchanged when someone does — ⚠ **EXCEPT where the file ROTATES the admin password mid-test** (`bcrypt-nonstring-shape.spec.js:529-545`, `admin-password.spec.js`): there the retry logs in with the DEFAULT password, 401s and **throws** rather than returning the route's answer, so adoption there needs the helper's `password` option. Loud, not silent — but „unchanged“ was too strong (review, 2026-09-20).
  ⚠ `api-security.spec.js` is on that list and must STAY on it.
- **`stripComments()` is now exported from `helpers/source-pins.js`.** The §4 source pin is
  about a SPEC file, which that helper (rooted at `frontend/src`) could not read — and a
  second copy of the strip rule is how the ordering trap documented at the top of that file
  got written in the first place.
- **The re-login inside the retry rotates the row itself.** That is fine under
  `--workers=1` (files run one at a time) and is why the helper never re-mints on a healthy
  token — pinned: „a call that needs no retry makes no login at all".
- **`refreshAdminToken()`-style per-block re-logins were left in place** in the files that
  had them. They are now belt-and-braces rather than the only guard; removing them is churn
  with no measured benefit.

#### 5. The mutation matrix (all reverted from a scratchpad copy, never `git checkout`)

| # | Mutation | Reds |
|---|---|---|
| M1 | the retry removed — trust the cached token, as before this row | **3** — §2 recovery, §3 one-login count, §4 the exclusion demo |
| M2 | the ONE retry becomes a loop | 1 — §3 „ONE login attempt, then the answer stands" |
| M3 | `adopt(fresh)` removed (the fresh token is not published back) | **3** — §2 recovery, §3, §4 |
| M4 | the retry wrongly applied inside `api-security.spec.js`'s staleness test | **2** — `api-security.spec.js:377` *(Expected 401 / Received 200)* **and** §4's source pin |

⚠ **What the reproduction does NOT prove.** It proves the mechanism (one row, replaced by
any login) and the recovery. It does **not** reproduce the ORIGINAL trigger — a login whose
response arrives after its own test timed out — because that needs a loaded box, which is
exactly the thing that cannot be made deterministic. The claim „this makes the full suite
stable under load" therefore rests on the mechanism being the same one, which §10 of
`10-portal-ia.md` measured, not on this file.
