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
2. The verification is now **one line per column the scrub touches**, printing all 22
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
