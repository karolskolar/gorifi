# Security, auth and CSP — self-hosted fonts, GA-T3/T5/T8, invitation approve endpoint, module 07

> Moved verbatim out of `CLAUDE.md` on 2026-09-03 (it had grown to 153 KB). These are the full per-task learnings; the load-bearing rules are summarised in `CLAUDE.md` → Hard rules. **Append new learnings for this area HERE, and add only the one-line rule to `CLAUDE.md`.**

### ⚠ Brand webfonts are SELF-HOSTED, and the gate had no CSP at all (RD-DS-6, 2026-08-09)

The Podpultovka restyle shipped with a `<link>` to `fonts.googleapis.com` in
`frontend/index.html`. Production **and** staging nginx send
`style-src 'self' 'unsafe-inline'; font-src 'self' data:`, which blocks the Google
stylesheet **and** the `fonts.gstatic.com` woff2 files. Measured live on staging:
`document.fonts.size === 0`, one `style-src-elem` violation, and every screen rendering
in the `Inter, sans-serif` fallback. The whole 25-row restyle was verified in the wrong
typeface.

- **Fixed by self-hosting, never by relaxing the CSP.** `font-src 'self'` already permits
  it, so there is **no deploy-config change** — `frontend/public/fonts/*.woff2` (Vite
  copies `public/` to `dist/` verbatim, so `/fonts/x.woff2` is the runtime URL and it is
  **not** hashed or bundled) plus `frontend/src/fonts.css`, imported from `main.js`.
  `friends-theme.css` was deliberately **not** touched — it is a byte-for-byte design-canon
  port with a numbered adaptation list, and this belongs to none of it.
- ⚠ **`latin-ext` is a SEPARATE subset and is NOT optional.** `á é í ó ú ý ô` are `latin`
  (U+0000–00FF), but **`č š ž ľ ť ď ň ĺ ŕ` are U+0100–017F**. Ship only `latin` and every
  one of those falls back to another typeface **mid-word** — "Zrušiť", "Späť", "Prihlásiť",
  "Objednávky kolegov". Both subsets ship for all three families, with Google's
  `unicode-range` descriptors preserved verbatim so the browser still picks per character.
  Any future face added here needs both.
- Figtree is a **variable** font: Google emits five `@font-face` blocks (400–800) that all
  point at **one file per subset**. Kept verbatim — 17 rules, 9 files, ~118 KB. Darker
  Grotesque's `vietnamese` subset is kept too: `unicode-range` means it is never fetched by
  a Slovak UI, so it costs nothing at runtime.
- ⚠ **`document.fonts.check()` is not a valid probe** — it returned `true` on staging while
  zero faces were loaded (it answers "would this family be used", not "did the bytes
  arrive"). Use `FontFace.status === 'loaded'` or a rendered-width measurement.
- ⚠ **THE ROOT CAUSE IS THE GATE, NOT THE LINK: every e2e run in the whole effort went
  against Express on `localhost:3997`, which sends NO security headers.** The suite could
  not see a CSP failure of any kind. `e2e/tests/self-hosted-fonts.spec.js` closes it by
  standing up a throwaway static server over `frontend/dist` that sets
  `deploy/nginx-gorifi.conf`'s exact header, and asserting zero
  `securitypolicyviolation` events — **if that header ever changes, change the copy in the
  spec too.** Verified non-vacuous — reverted to the pre-fix build, 4 of its tests fail.
- ⚠ **The same CSP was blocking a SECOND asset, and the first version of this entry
  overstated the sweep that should have caught it.** `InviteRegister.vue` loaded the
  Goriffee logo from `https://www.goriffee.com/...png`, which `img-src 'self' data:`
  blocks — a broken logo on the **public** registration page. (That URL also 404s
  upstream now, so it was dead twice over; the replacement is the brand's current
  official mark, self-hosted at `frontend/public/goriffee-logo.svg`. ⚠ Its colour
  treatment differs from the retired PNG — white wordmark on a black plate — and is
  **pending design sign-off**.) The spec's "zero non-same-origin requests" assertion only
  ever visited `/`, so it could not have caught it. It now sweeps **`/`, `/invite/:code`
  and `/g/:token`** — every public unauthenticated route that renders its own chrome —
  which is what makes "this catches the next CDN link somebody adds, font or not" a true
  claim rather than an aspiration. **Any new public route must be added to that list**; an
  authenticated one is covered for chrome by its own spec. `revolut.me` in
  `FriendOrder.vue`/`PaymentModal.vue` is deliberately out of scope: those are `<a href>`
  navigations, not subresource fetches, so no CSP directive applies and nothing is
  requested until the user clicks.
- Residual, not introduced here: `friends-theme.css:207` `.pimg .lbl` asks for `'Anton'`,
  which was never loaded by any `<link>` and is not self-hosted either. RD-FO-2 made `.lbl`
  unreachable (the no-photo `.pimg` is a bare frame), so it is dead, not broken.
- Nginx caching was left alone: `/fonts/` falls through to `location /`, so it gets
  ETag/Last-Modified 304s rather than `/assets`' `expires 1y; immutable`. Deliberate — the
  filenames are **not** content-hashed, so `immutable` would pin a stale face forever if the
  subsets are ever refreshed from Google.


### ⚠⚠ GA-T8 — `await` in a handler BREAKS the `instances: 1` atomicity assumption (2026-08-17)

The standing concurrency note says non-transactional check-then-write is safe because
`deploy/ecosystem.config.cjs` sets `instances: 1` **and the handlers are fully
synchronous** (better-sqlite3). Module 10 is the first code to put an `await` — a network
call to Google — **between a uniqueness check and its INSERT**, and that second clause is
what the safety actually rested on. It no longer holds anywhere an `await` appears.

`POST /api/invitations/register` is the first instance: request A carrying a Google token
yields at `verifyGoogleIdToken`, request B passes the same phone dedupe during that
window and inserts, and A's INSERT then hits `idx_invitations_phone_pending` and falls
into the generic catch — **500 on a public endpoint whose contract is a 409.** No bad row
is written (the index holds); the failure is the wrong status and a stack in the log.

- **The fix is BOTH layers, and neither alone is enough.** Re-run the check immediately
  before the INSERT inside the async branch (keeps the synchronous path untouched), **and**
  translate `SQLITE_CONSTRAINT*` + the exact index message into the same 409 — the GSO-T10
  pattern, which is also the layer that survives a future PM2 cluster.
- ⚠ **Match on `code.startsWith('SQLITE_CONSTRAINT')` PLUS the exact message**, never a
  bare `/UNIQUE/i` — a future index on the same table would otherwise start answering 409
  for the wrong reason.
- ⚠ **`node:sqlite` and `better-sqlite3` report DIFFERENT error codes for the same
  violation** (`ERR_SQLITE_ERROR` vs `SQLITE_CONSTRAINT_UNIQUE`). The e2e helpers use
  `node:sqlite`; the routes use better-sqlite3. **A probe written against the test driver
  will "pass" while proving nothing about the route.** Verify a constraint-translation
  guard against the driver the route actually loads.
- ⚠ The window is **unreachable over HTTP in this suite** — only `TEST:` tokens verify and
  they resolve in a microtask, which never yields to another request. So it is provable
  only by a direct probe, and a green suite says nothing about it.
- **Rule going forward:** any handler that gains an `await` must be re-read for
  check-then-write pairs that were previously atomic by virtue of being synchronous.
  GA-T4/T5/T7 added `await`s to handlers with no such pair; that was luck, not design.

### ⚠ GA-T5 — shared-password mode is a credential-planting surface (2026-08-16)

`PUT /api/friends/:id/google-link` carries a **modern-mode guard** (409
`field:'auth_mode'`). It is not decoration and it is not symmetry with the login route —
without it, **two requests using only the office-wide shared password plant an
attacker-controlled Google credential on any friend's row**, reproduced live:

```
POST /api/friends/auth {password: <shared>, friendId: <victim>}  → 200, Bearer token
PUT  /api/friends/<victim>/google-link {id_token: <attacker's>}  → 200, google_sub planted
```

The legacy dropdown login mints a per-friend session for **anybody** from the shared
password alone (`friends.js:226`), so `requireFriendOwner` + a resolved-identity gate stop
only the ONE-request (`X-Friends-Password`) form. The planted link is inert while legacy —
then becomes a **permanent alternative credential the moment `auth_mode` flips to modern**,
surviving the victim's own password change, which no other legacy primitive does. The
migration window does not cover it, because the blast radius outlives the window (the
UC-FC-009 reasoning at `friends.js:967-990`).

- ⚠ **Any future route that writes a CREDENTIAL needs this guard**, not just an ownership
  guard. Ownership is meaningless while a shared password can mint anyone's session.
- ⚠ **Recorded residual:** the same two-request form still reaches **unlink** and
  **prompt-dismiss** in legacy mode. Neither plants a credential (sever a login method,
  silence a prompt — both recoverable, and in legacy nobody logs in via Google anyway), and
  §UC-GA-004 mandates no mode guard on either. Revisit if either gains destructive weight.
- ⚠ `requireFriendOwner` returns `{friendId: null}` for bare shared-password auth whenever
  `auth_mode !== 'modern'` — **the spec's "guarded … with a RESOLVED friendId" describes a
  guard that does not exist.** `friends.js:398/745/958`, `subscriptions.js:10,21` and
  `transactions.js:55` share the hole; all read or write self-correcting data, which is why
  only the contact half of `PATCH /:id/profile` was hardened before.
- ⚠ **The app-level 409 pre-check is load-bearing independently of `instances: 1`:**
  `schema.js:663-667` creates `idx_friends_google_sub` inside a **swallowing** try/catch, so
  on any DB where creation ever failed the pre-check is the ONLY defence. The two layers are
  HTTP-**indistinguishable** (deleting the pre-check leaves every HTTP test green — the
  single-statement UPDATE rolls back atomically), so layer 2 is provable only by calling
  `writeGoogleLink()` directly against a real migrated DB.
- The 409 body is frozen at `{error, field}` and names **no** friend — id, name, uid, email
  and sub are all asserted absent, or linking becomes a friend-table enumeration oracle.

### ⚠ GA-T3 — the ONE sanctioned CSP exception, and the THIRD policy copy (2026-08-16)

Google Identity Services needs four **scoped** path sources. They are added to
`script-src` / `style-src` / `connect-src` and a **new** `frame-src`, per Google's current
docs (`developers.google.com/identity/gsi/web/guides/get-google-api-clientid`, §CSP —
the older `/guides/csp` URL is stale). **Nothing else is relaxed**: `font-src 'self' data:`
and `img-src 'self' data:` are byte-identical to RD-DS-6. Fixing a CSP problem by
loosening is still forbidden; this is the one exception and it stays minimal.

- ⚠ **THE POLICY LIVES IN THREE FILES, NOT TWO.** `deploy/nginx-gorifi.conf` (3 lines),
  `deploy/nginx-gorifi-staging.conf` (3), **and `docs/deploy/nginx-proxy-manager.md`**
  (report-only). That third one is the dangerous one: NPM is a real hop in front of
  **both** prod and staging, and the runbook's own Notes tell the operator to promote it
  from `-Report-Only` to enforcing. Promoting the pre-GIS version would have killed
  Google sign-in in production — the RD-DS-6 failure mode exactly, invisible to every
  gate. All seven lines are now machine-checked: `self-hosted-fonts.spec.js` reads all
  three files off disk and string-equals every line against `PROD_CSP`, so drift in
  either direction reddens and names the file.
- ⚠ **The residual is what an operator PASTED into NPM's web UI** — that lives in a
  database on the proxy host, not the repo, and no suite can reach it. The manual check
  is `docs/deploy/nginx-proxy-manager.md` §2b's `curl -sI … | grep -i content-security`.
- ⚠ **`frame-src` is a NEW directive and it REPLACES the `default-src 'self'` fallback**,
  so **same-origin iframes are now blocked too**. Free today (the app renders none — the
  only `'iframe'` token in `frontend/src` is `NeoModal.vue`'s focus-trap selector), and
  pinned by a test, so the day someone legitimately needs one they get a red test rather
  than a blank frame. Add `'self'` to all three copies if that day comes.
- **`frontend/src/lib/gis.js` is the ONE home for GIS script loading** — never
  `index.html`, never guest routes. Idempotent, dedupes concurrent callers onto one
  promise and one tag, **times out rather than hanging** (a blocked Google must degrade
  to the password form), clears itself after failure so a retry works, and **resolves
  `null` when `googleClientId` is null** so call sites need no separate guard. It does
  NOT call `initialize()`. ⚠ Options apply only to the call that *starts* the load.
- Route sweep: `accounts.google.com` allowed on `/` and `/invite/:code` **only**;
  **`/g/:token` and `/magic/:token` stay at ZERO external requests**. Nothing imports the
  loader yet and *that zero is asserted*, so GA-T4 turning it on is a loud, self-
  describing failure rather than a silent drift.
- ⚠ **Use `BASE_URL=http://localhost:3997`, never the IP.** `CORS_ORIGIN` allows
  `localhost` but not `127.0.0.1`, and the built `index.html` loads its assets with
  `crossorigin` — so the IP gives a **500 on the stylesheet** and `document.fonts.size
  === 0`, which reads exactly like a font regression.
- For a future hardening pass: Google wants `Referrer-Policy:
  strict-origin-when-cross-origin` (both confs already send it), and if anyone ever adds
  `Cross-Origin-Opener-Policy` it **must** be `same-origin-allow-popups` or the GIS popup
  goes blank. None is sent today.


### ⚠ `POST /api/invitations/:id/approve` — two invariants no test can hold (IA-T3, 2026-08-13)

The approve endpoint (module 07) converts a pending invitation into a friend **with a
working login** in ONE `better-sqlite3` transaction. Two of its properties are
**structural, not behavioural — a refactor can break either with the ENTIRE SUITE
GREEN**, so they live here:

1. **bcrypt `hashPassword()`, both collision-retry loops and `getPlaceholderCycleId()`
   run OUTSIDE the transaction.** better-sqlite3 transactions are synchronous and
   bcrypt is ~62 ms of CPU (measured over 9 approvals: 61.8–64.7 ms hashing, then a
   **0.13–0.21 ms** transaction — the tx holds the write lock ~400× shorter than the
   hashing it follows). Moving `hashPassword` into the `db.transaction` callback is
   undetectable by any test in this repo.
2. **Exactly TWO writes inside the transaction** — INSERT friend, UPDATE invitation.
   Nothing else may join them.

Same class as the standing `instances: 1` concurrency caveat. The comment at
`invitations.js:326` is the only in-code guard.

Also load-bearing, and each proved rather than assumed:
- ⚠ **The `SQLITE_CONSTRAINT` → 409 translation is real, not decorative.** Deleting
  the app-level `isUsernameTaken` check leaves the suite **15/15 green** — the UNIQUE
  index catches it and the catch produces the identical `409 field:'username'`. The
  regex matches better-sqlite3's actual `UNIQUE constraint failed: friends.username`;
  a `friends.uid` collision correctly falls through to 500.
- ⚠ **THREE deliberate non-writes**, each a rule with a reason: **no
  `friend_subscriptions` row** (no rows = sees everything, so an invited friend starts
  UNFILTERED — deliberately diverging from onboarding's bakery auto-subscribe), **no
  session mint** (the friend logs in themselves), **no `transactions` row** (creation
  is not a financial event — the GSO-T6 lesson). All three are asserted as zero rows
  and mutation-verified, with a non-vacuity test proving onboarding DOES create
  `['bakery']` in the same run.
- ⚠ **The temp password is UPPERCASE-ONLY** (`randomCode(12)` over the unambiguous
  alphabet) and `friends.js:35` lowercases **only the username, never the password** —
  which is exactly why it authenticates unmangled. Do not "normalise" the password.
- The plaintext exists in **exactly one place repo-wide** outside `schema.js`: the 201
  body. Never persisted, never logged (error paths log `e.message` only). The 201
  friend object is hand-picked and pinned by an exact-keys assertion PLUS a raw-text
  regex for `invite_code|access_token|password_hash`, so a later `SELECT *` fails loudly.
- **`requireAdmin` is PER-ROUTE.** `routes/invitations.js` is a MIXED mount — public
  `/code/:code` + `/register`, admin for the rest. Wrapping the mount breaks the public
  registration flow.

### Module 07 — invitation → friend WITH a login (IA-T1..T5, 2026-08-13)

The reported bug: the "Nový priateľ" modal's `Prihlasovacie meno *` field wrote
`friends.name` and `POST /api/friends` set no credentials, so approving an invitation
produced a friend who **could not log in** (the "Prihlásenie" column showed `-`). Spec:
`docs/specification/07-invitation-approval.md`; backlog rows in `PROGRESS.md` §5.

The shipped flow: applicant optionally requests a username on `/invite/:code` →
admin clicks "Vytvoriť" → **approval dialog** (username prefilled from the request or a
slugify of the name, editable note) → `POST /api/invitations/:id/approve` creates the
friend with a generated temp password and `must_change_password = 1` → the dialog shows
the credentials with a copy button → the friend logs in and is forced to set their own
password. **No email** — the copy button is the whole delivery mechanism (SMTP is a
recorded phase-2 follow-up).

⚠ **Two UI hazards this module discovered, both fixed, both worth not reintroducing:**
- **`@keyup.enter` on an input inside a dialog opened by an Enter keypress fires on
  open.** The browser's native "Enter activates a focused button" delivers `keydown` to
  the BUTTON, Radix synchronously focuses the dialog's first input, and the **keyup half
  of that same physical press** lands on the input. On the approval dialog this silently
  approved before the admin saw anything — minting an account and a one-time password
  nobody read. Use **`@keydown.enter`** (structurally cannot see a keyup targeting
  another element) plus an **`event.repeat` guard** (auto-repeat delivers genuine
  keydowns to the newly focused input ~500 ms later).
- **A one-time secret on screen needs a route-leave guard.** Browser Back unmounted the
  dialog and destroyed an uncopied temp password with no warning. `onBeforeRouteLeave` +
  `confirm()` while `approveResult` is set. Reload is deliberately unguarded.

⚠ **e2e harness traps recorded here because they cost real time:**
- **There is exactly ONE admin token app-wide** (`admin.js` does `INSERT OR REPLACE …
  'admin_token'`), so a UI admin login **invalidates** a token minted earlier by an API
  `beforeAll`. Any spec mixing `loginAsAdminUI(page)` with API `admin()` calls must adopt
  the browser's token (`localStorage.getItem('adminToken')`).
- **A back-navigation test cannot use `page.goto` to reach the page** — backing out of a
  document-loaded entry is a real document navigation that a vue-router guard never
  sees, so the test passes for the wrong reason. Navigate in-SPA instead.



### FUP-T19 — `POST /api/admin/logout` was an unauthenticated denial of the admin surface (2026-09-19)

`router.post('/logout', …)` deleted the `settings('admin_token')` row **unconditionally**.
There is exactly ONE admin token app-wide, so any anonymous caller could end the admin's
session, and a loop of anonymous POSTs could keep the admin permanently logged out —
indistinguishable from a bug. It leaked nothing and granted nothing: a **denial**, not an
escalation. Surfaced by GA-T10's review (that row's "ONE admin token app-wide" reasoning
makes it visible), pre-existing since Phase 1.

**The shape that shipped, and why it is not `requireAdmin`.** The route stays **PUBLIC**
and keeps answering a byte-identical idempotent `{ success: true }` 200; it deletes the
row only when the caller presents the **current** token, read exactly as the middleware
reads it (`req.headers['x-admin-token']` through the shared `isValidAdminToken`, expiry
check included, so the two cannot drift). A 401 would have been the obvious fix and would
have been wrong: **four** admin views carry the same three-line `logout()`
(`AdminDashboard.vue:173`, `AdminFriends.vue:279`, `AdminCatalog.vue:812`,
`AdminBakeryProducts.vue:193`) and **not one has a try/catch**, while `api.js`'s
`request()` throws on a non-ok response — a 401 would abort before
`localStorage.removeItem('adminToken')` and before the redirect, leaving an admin holding
a **stale** token stuck on a dead dashboard with no way to log out. Stale tokens are
routine since module 10: `POST /api/admin/google-login` mints and **rotates** the same
single row, so a second browser holding the previous token is exactly that case. The
idempotent 200 (the GSO-T5 convergence idiom, as on the guest DELETE) closes the denial
**and** lets the stale client finish its own cleanup. **Frontend-free**: `request()`
already attaches `X-Admin-Token` on every call, so no caller changed — and because the
route binds no body, the unbindable-body-shape family cannot reach it.

⚠ **It must NOT join `ADMIN_ENDPOINTS`** in `api-security.spec.js` — that sweep asserts
401-without-a-token and this route deliberately answers 200 to everyone, so listing it
would pin the opposite of its contract. The standing rule is "every new **guarded** admin
route joins the sweep", so the omission needs a reason on record: it is written at the
route itself, and the route's real invariant (the **effect**, not the status code) is
pinned in two `FUP-T19` describes at the bottom of `api-security.spec.js`.

⚠ **Testing a route that destroys the app-wide token.** The two NON-destructive cases
(anonymous caller, stale/garbage token → 200 with the session provably still usable) run
against whatever `BASE_URL` points at. The destructive one (current token → row gone →
next admin call 401 → a second logout still 200 → a fresh login recovers) runs on a
**throwaway backend** (`startBackend`, self-skipping without the backend source), so the
gate's single admin session can never be left destroyed for the next spec file. The
session row is read straight out of the DB there, which is what makes the two no-op cases
non-vacuous: they are proven by the row surviving, not by a status code.

### FUP-T19 item 2 — a corrupt `admin_google_subs` was silently destroyed by the next write

`readAdminGoogleSubs()` treats an unparsable allowlist as EMPTY (correct — it fails
closed), but `writeAdminGoogleSubs()` then `INSERT OR REPLACE`d straight over it,
destroying entries a human could have salvaged from truncated JSON.

- The raw value is now **parked byte-for-byte** under the sibling settings key
  `admin_google_subs_corrupt` **before** the overwrite. `settings` is a key-value table
  (`key TEXT PRIMARY KEY, value TEXT NOT NULL`), so no migration.
- **Parking happens only when the read discards the value WHOLE** — `JSON.parse` throws,
  or the parse result is not an array. A well-formed array whose individual members the
  read's filter drops is **not** parked: the read salvaged everything salvageable and
  showed it to the admin, so the write that follows is a decision taken over what they
  saw. Parking those too would file a "corruption" on ordinary edits and the slot would
  stop meaning anything.
- **A parked value is never clobbered.** The slot holds the OLDEST unsalvageable copy: a
  second corruption arriving while the first is still parked means nobody has looked yet,
  so overwriting would destroy the only salvageable copy. The newer value is logged
  (bounded) and dropped; clearing the slot is a human's decision, taken in the database.
- Both the read-site `console.error` and the two write-site lines carry a **bounded**
  200-char excerpt plus the value's length (the FUP-T3/FUP-T7 log rule) — the read line
  runs on every settings-page load, so an unbounded dump would be its own flood.
- ⚠ `DELETE /api/admin/google-allowlist` writes **unconditionally** (it is idempotent when
  nothing matched), so it parks too — an admin revoking an address they can no longer see
  would otherwise wipe the evidence. Both halves are pinned in `google-auth.spec.js`.

⚠ **`POST /api/admin/logout` carries NO rate limiter, deliberately** (FUP-T19 review).
`authLimiter` is a per-IP bucket shared with `/login` and `/google-login`, so a flood of
anonymous logouts would spend the office's NAT budget and lock the admin out of **logging
in** — the failure mode the five-bucket split exists to prevent, and the exact inversion
of the denial this row fixed. A sixth bucket buys nothing: without the current token the
handler is a pure no-op doing strictly less work than before, and it answers
byte-identically either way, so there is no oracle to meter. Recorded at the route too.

⚠ **`/api/admin` has SEVEN unguarded routes**, not the five the old sweep comment listed:
`GET /setup-status` (:367), `POST /setup` (:373), `POST /login` (:393), `POST /verify`
(:423), `POST /logout` (:480), `GET /payment-settings` (:503), `POST /google-login`
(:333). `POST /setup` is public but **self-limiting** — it 400s `Admin uz je nastaveny`
once `settings('admin_password')` exists — which is why it is not a hole. The
enumeration in `api-security.spec.js` is now exhaustive: it is the comment a reader
trusts when deciding whether an absent route is an oversight.

Two known, untouched behaviours recorded so they are not rediscovered as bugs:
`POST /api/admin/verify` is public, unrated and distinguishes `{valid:true}` from 401 —
a pre-existing token oracle, the natural companion to a future "bound the admin-token
check surface" row; and a stale-token admin's own logout now leaves a dead `admin_token`
row until it expires or the next login overwrites it (harmless — the expiry check
already rejects it).

### ⚠ GA-T11 — the FIRST password: `POST /api/friends/:id/set-password` (2026-09-19)

**The gap.** `hasCredentials` gates the CHANGE-password fold in the profile modal, so a
friend whose `password_hash` is NULL saw **no password control at all**;
`needsCredentialSetup` fires only in transition mode, and the forced gate only when an
admin reset a password that already exists. GA-T4 found it, GA-T7 could not close it
(the fix is a backend route with its own security review), and the absence was pinned in
`google-auth.spec.js` with "delete this when the follow-up row lands" — this row.

**Why neither existing route fits, and the two reasons are different.**
`PUT /:id/change-password` answers **400** `Nemáte nastavené osobné heslo` for exactly
this friend. `POST /:id/setup-credentials` would **not** refuse them (its 409 needs
`password_hash` **AND** `username`) — the mismatch is **security**: that route serves the
TRANSITION-mode flow, i.e. it runs by definition while `auth_mode` is not modern, so it
cannot carry the modern-mode guard without breaking the one flow it exists for. Adding
the guard there is the obvious simplification and it is wrong.

**⚠ THE MEASURED REACHABILITY FINDING — it decided the route's shape.** Every
modern-mode session mint was walked, against a real server, not just read:

| mint | can it produce `hasCredentials: false`? |
|---|---|
| `POST /friends/auth` personal | no — needs `username` + `password_hash` |
| `POST /friends/auth` shared | no — 401 in modern mode |
| `POST /magic-link/redeem` | no — `magic-link.js:130,337` require `password_hash` |
| `POST /onboarding/:token` | no — always writes BOTH columns |
| 07 approval (incl. GA-T9 Google) | no — the INSERT always writes `username`, `password_hash`, `must_change_password = 1` |
| a session minted before a mode flip | **no — `PUT /api/admin/settings` DELETEs every `friend_sessions` row on a mode change** (`admin.js:556`; measured: the legacy token 401s straight after the flip) |
| `POST /friends/auth/google` | **yes** — it needs `google_sub` and nothing else |

So the ONE modern-mode session a credential-less friend can hold is a **Google login**,
and a password-only route would therefore refuse 100 % of the friends who can reach the
screen — hence the optional `username`.

⚠ **CORRECTED BY THIS ROW'S SECURITY REVIEW — the first draft of this finding claimed
"nothing that leaves `password_hash` NULL ever writes a `username`", and that is FALSE.**
`PUT /api/friends/:id/admin-username` (`friends.js:1679`) runs `UPDATE friends SET
username = ? WHERE id = ?` and never touches `password_hash`, so an admin can hand a
password-less friend a username. It is the ONLY counterexample — every `UPDATE friends
SET` and `INSERT INTO friends` in `backend/src` was walked to confirm it, and the admin
PATCH's allow-list is name/display_name/active/phone/email only. The code was always
right (the branch is `if (username == null)`) and `first-password.spec.js` builds
exactly that row through `giveUsername()`, i.e. through that admin route — **the test
was already proving the sentence wrong.** ⚠ Why it mattered enough to chase into six
files: that sentence was the stated justification for the guard, so a reader taking it
at face value could delete the branch as dead code and reintroduce a portal-side rename
on a credential route — the decision FUP-T20 took against. The true form is: `username`
may be non-NULL on such a row, which is exactly why a supplied one is honoured **only
while NULL** and **never** as a rename. Documentation discipline in practice: a claim
repeated in six places is six places to correct, and the e2e was the honest witness.
⚠ Today that `google_sub` can only come from a migration/restore or an operator (the
link route demands a modern session first, and approval mints a password), so the state
is currently constructed, not walked into — but it is one admin-side "link Google" row
away from routine, and the e2e harness already constructs it.

**The route.** Owner gate (`requireGoogleLinkOwner`, its fourth caller) → modern-mode
409 `field: 'auth_mode'` → 404 → **409** `Heslo je už nastavené…` (409, not 400: the
body is fine and the caller is authorised; it conflicts with account STATE, and without
it this would be a password change with no `currentPassword` proof) → username
(400 `field: 'username'` / 409 taken) → FUP-T11 type guard → bcrypt **outside** the
transaction → one UPDATE + `invalidateLoginTokens` inside → `invalidateFriendSessions`
+ re-mint carrying the presenting session's expiry, `via` NULL (`change-password`'s
ending, copied — and the re-mint is not optional: the invalidate deletes the very token
the request presented).

- ⚠ **The modern-mode guard is the load-bearing control, not the ownership check**
  (GA-T5's finding, re-verified): in legacy/transition mode `POST /friends/auth` with
  `{password: <shared>, friendId: <anyone>}` mints a session that IS the victim's
  resolved identity, so every ownership check downstream passes. The e2e asserts the
  409 **with a perfectly resolved owner**, in legacy AND transition, and re-reads the
  row. The guard sits AFTER the owner gate so an anonymous caller still gets the uniform
  401 the `api-security.spec.js` sweep asserts (the route joined
  `FRIEND_IDENTITY_ENDPOINTS`, not `ADMIN_ENDPOINTS` — an admin token must not mint a
  friend a credential here; `PUT /:id/reset-password` is the admin path and it raises
  `must_change_password`).
- ⚠ **No rate limiter, deliberately** (§UC-GA-013's one-sentence rule): the route
  verifies nothing attacker-suppliable — it demands the friend's own session, minted
  behind `authLimiter` — so there is no secret to probe. Both siblings hash a password
  with no limiter for the same reason. The five buckets stay five.
- ⚠ **No `await` anywhere in the handler**, which is what keeps the check-then-write
  atomic under `instances: 1`; the `SQLITE_CONSTRAINT`→409 translation on
  `idx_friends_username` is the GSO-T10 second layer for PM2 cluster mode. Adding an
  await later re-opens both races.

**Frontend** (`FriendPortalSession.vue`): a fold labelled **`Nastaviť heslo`** (never
"Zmeniť heslo" — the deleted pin was written on `/heslo/i` precisely so it would catch
that difference), gated on `props.friend?.hasCredentials === false && authMode ===
'modern'`. ⚠ **Strict `=== false`**, the `googlePromptEligible` trap again: the field is
ABSENT until the profile fetch lands, and `!undefined` would offer a first-password form
to a friend who has a good password and whose every submit the server would 409. The
username input renders only when `friends.username` is missing, `maxlength="30"` mirrors
`validateUsername`. Success emits `token` (or the friend is logged out by succeeding)
then `friend-merged` with `hasCredentials: true`, so the change-password fold replaces
it in place with no reload.

**Left open, deliberately, and none is a placeholder:**
0. ⚠ **The GA-T7 unlink warning and the new fold are on screen TOGETHER** — a
   contradiction the friend can see, not a stale sentence (the framing this row's review
   sharpened). The warning is gated on `googleNoPassword` =
   `googleUnlinkWarned || hasCredentials === false` (`FriendPortalSession.vue:2170`,
   `:2204`), which is **exactly** the population that now also gets "Nastaviť heslo" in
   the same open modal: it says *"…kým vám správca nenastaví nové heslo"* one section
   above a button that sets one. Neither half is false (the warning describes doing
   nothing; the fold survives the unlink, so the session is recoverable either way), and
   the copy is **product-owner text pinned in three e2e places** — so it ships unchanged
   until a new sentence is signed. Tell the product owner the two appear together, not
   that one is out of date. Likely fix: point the warning at the fold, not at the admin.
1. **Legacy mode still has no answer.** A credential-less friend on a legacy deployment
   can log in (shared password + dropdown) and still has no way to a personal password —
   and the modern-mode guard is exactly why they must not. `setup-credentials` +
   transition mode is the specced migration path; the real fix is finishing the
   migration (`auth_mode=modern`), which is already an open follow-up.
2. **Transition mode's dialog is dismissible** (`@close="showCredentialSetup = false"`),
   so a friend who closes it has no way back that session. Same guard, same reasoning;
   re-opening it from the profile would be an additive UI row, not a new route.
