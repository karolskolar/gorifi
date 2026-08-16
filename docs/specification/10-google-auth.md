# 10 — Google sign-in (friend + admin)

> Scope: "Sign in with Google" across both portals: the friend login screen gains a GIS
> button, an existing friend can explicitly link/unlink their Google account (post-login
> prompt with áno / teraz nie / už sa nepýtať + a manual trigger in the profile modal),
> an Applicant can attach their Google identity during `/invite/:code` registration so
> approval creates the friend already linked, and the admin portal gains Google login
> against a settings-stored allowlist with password auth kept as backup. This module OWNS
> the Google schema (`friends.google_sub` / `google_email` / `google_prompt_dismissed`,
> plus the two new `invitations` columns), the server-side ID-token verifier, the
> sanctioned CSP additions for GIS, and the e2e testing seam.
> Out of scope (handoffs): **admin-side unlink** — `DELETE /api/friends/:id/google` is
> module 11 §UC-FC-006 (dependency-gated on THIS module's UC-GA-001; this module answers
> its open question in §Resolved decisions #3); **the AdminFriends Google column /
> `googleLinked` derivation / response-strip rule** — module 11 §UC-FC-002/005 (this
> module INHERITS the strip rule and applies it to its own endpoints); **magic-link
> recovery + remember-me** — module 09 (UC-ML; same login screen, changes here are
> additive and referenced generically); **the approve endpoint's structure** — module 07
> §UC-IA-005 (this module only widens the friend INSERT's column list, see UC-GA-009);
> **guests** — untouched entirely (00-overview §Scope extension).
> Actors: **Friend** — logs in with Google once linked; owns link/unlink/prompt state.
> **Applicant** — may attach Google at `/invite/:code`; vy-form surface. **Admin** —
> allowlist member logging into the admin portal with Google; manages the allowlist;
> password auth stays as backup. **Google** — external IdP; the backend's second
> outbound-call dependency (after Mailgun).
> Sources: product-owner brief 2026-08-14 (verbatim: "Google authentication — be able to
> login with my google account (friend and admin portal as well)… (1) selecting google
> auth when creating a new account (based on invitation from friend); (2) linking google
> account to existing account — popup… yes-now, not-now, never-ask-again — but should
> still be possible to invoke somewhere under their account; (3) for admin, there still
> should be password auth as a backup solution"); `00-overview.md` §Scope extension
> (explicit-link only, allowlist + password backup — confirmed decisions);
> `01-architecture.md` §Auth extensions (the module-10 contract: GIS → ID token → server
> verification, `sub` as identity key, the three columns, no client secret),
> §Integrations (GIS = the ONE sanctioned CSP exception; verification = second outbound
> call, timeout-bounded), §Dependencies (`google-auth-library` pre-approved, never
> hand-roll JWT verification); `11-friends-consolidation.md` (schema ownership seam,
> strip rule, UC-FC-006's open question); `07-invitation-approval.md` (approve
> invariants, register hardening, InviteRegister conventions); repo code
> (`backend/src/middleware/friend-auth.js`, `backend/src/routes/friends.js` `/auth`,
> `backend/src/routes/admin.js` `/login`, `backend/src/middleware/rate-limit.js`,
> `frontend/src/views/FriendPortal.vue`, `FriendPortalSession.vue`, `InviteRegister.vue`,
> `AdminLogin.vue`, `deploy/nginx-gorifi{,-staging}.conf`); repo `CLAUDE.md`
> (session-boundary rule, ONE-admin-token trap, RD-DS-6 CSP gate lesson, Mailgun env
> no-op precedent). The most recent decision wins on conflict.
> **Design reference:** no prototype screen exists for Google auth. The GIS button is
> Google's own rendered iframe button — Google's brand guidelines forbid restyling it to
> the Podpultovka language; this divergence is accepted on every surface. Everything
> around it (dividers, prompt modal, profile section) uses module 02 primitives on friend
> surfaces and the current shadcn look on admin surfaces.

---

## Resolved decisions (the recommend-marked points, decided here)

1. **Google login honours `must_change_password`.** A Google-linked friend with
   `must_change_password = 1` gets the same forced-password-change gate (module 03
   §UC-FL-012) after a Google login as after a password login. Rationale: the flag means
   an admin-known password exists on the row; a login path that bypasses the gate leaves
   that password valid indefinitely. Architecturally consistent with 01's magic-link rule
   ("honours `must_change_password` exactly like password login"). Consequence for
   Google signups (UC-GA-009): first login — via Google or password — forces setting an
   own password, so every friend ends up with a working password backup. Deliberate.
2. **Google login is modern-mode only** (consistent with module 09's magic link). While
   `auth_mode` ≠ `modern` the endpoint answers **409** `{ error: 'Prihlásenie cez Google
   je dostupné až po prechode na osobné prihlasovanie', field: 'auth_mode' }` and no
   Google button renders on the legacy login card.
3. **Admin unlink does NOT reset `google_prompt_dismissed`** — answering 11 §UC-FC-006's
   OPEN (this module owns the column). The friend said "už sa nepýtať"; an admin support
   action on the *link* must not re-enable nagging. The manual profile trigger
   (UC-GA-007) remains the friend's way back in. 11's UC-FC-006 follows this rule.
4. **`GOOGLE_CLIENT_ID` is served config, not a Vite build-time var.** It lives in
   `/var/www/gorifi{,-staging}/.env` (the Mailgun home, loaded via
   `--env-file-if-exists`) and reaches the frontend through the existing public
   `GET /api/friends/auth-mode` response, which gains `googleClientId: string|null`.
   Rationale: `deploy.sh` builds the frontend locally — a `VITE_*` var would live on the
   operator's machine, fork staging/prod artifacts, and break the "one build" property;
   runtime config keeps one env home and lets the button hide itself when unconfigured
   (the UC-FC-005 graceful-degradation pattern). No client secret exists in this flow.
5. **Approval keeps the temp-password flow unchanged** for Google-attached invitations:
   username still required, temp password still generated, `must_change_password = 1`
   still set, the credentials mail/copy still sent — the Google link just pre-exists on
   the created friend (UC-GA-009). The backup credential is the point of decision #1.
6. **Prompt trigger is login-time only.** The brief's "logs in or does an action" is
   resolved to: shown once after a successful non-Google modern login (UC-GA-006).
   **Dropped: action-triggered prompts** — interrupting an ordering flow with an auth
   upsell is worse UX and has no defined trigger set; the manual profile entry covers
   discoverability. Called out so it is not silently implemented.
7. **No Google One Tap.** The confirmed three-option prompt is OUR modal (confirmed
   labels), not Google's overlay; One Tap would bypass the "teraz nie / už sa nepýtať"
   semantics and add CSP/UX surface. Only the explicit GIS button flow ships.

---

## UC-GA-001 Schema — Google columns on `friends` + `invitations` (system)

**Goal:** the columns every other UC (and module 11's UC-FC-006) keys on, in
`backend/src/db/schema.js`, repo try/catch `ALTER TABLE` pattern.

**Business rules:**

- `friends`:
  - `ALTER TABLE friends ADD COLUMN google_sub TEXT` — the ID token's `sub` claim, the
    ONLY identity key (01 §Auth extensions: stable, never reassigned; **never e-mail**).
    NULL = not linked.
  - `ALTER TABLE friends ADD COLUMN google_email TEXT` — display only, refreshed on
    Google login (UC-GA-003); never used for matching.
  - `ALTER TABLE friends ADD COLUMN google_prompt_dismissed INTEGER DEFAULT 0` — the
    "už sa nepýtať" flag.
  - `CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_google_sub ON friends(google_sub)
    WHERE google_sub IS NOT NULL` — a bare `ALTER TABLE` cannot add UNIQUE; the partial
    index is the `idx_friends_username` precedent and the mechanism behind every
    already-linked 409 in this module.
- `invitations`:
  - `ALTER TABLE invitations ADD COLUMN google_sub TEXT` and
    `ALTER TABLE invitations ADD COLUMN google_email TEXT` — the Applicant's attached
    identity (UC-GA-008), verified at registration time, frozen historical record
    thereafter (the 07 resolved-conflict-#4 convention: approval never rewrites them).
    No unique index on invitations — the authoritative uniqueness check is the friends
    index at approval (UC-GA-009), with courtesy checks at registration.
- ⚠ Seam (module 11): UC-FC-006 (`DELETE /api/friends/:id/google`) is dependency-gated
  on exactly this UC; UC-FC-002/005's `googleLinked` derivation starts returning `true`
  values once this lands. Nothing else in 11 moves.

**Acceptance criteria:** backend restart on an existing DB adds all five columns + the
index without error, idempotently; inserting two friends with the same non-NULL
`google_sub` throws `SQLITE_CONSTRAINT`; two rows with NULL `google_sub` coexist.

---

## UC-GA-002 Config + verifier — `helpers/google-auth.js` (system)

**Goal:** one home for ID-token verification, config plumbing, and the e2e seam.

**Config:**

- `GOOGLE_CLIENT_ID` env var (public config, no secret) in
  `/var/www/gorifi{,-staging}/.env`. Absent ⇒ the whole feature is OFF: every Google
  endpoint in this module answers **503** `{ error: 'Prihlásenie cez Google nie je
  nakonfigurované' }`, `auth-mode` reports `googleClientId: null`, and no frontend
  surface renders a Google control (the mailer no-op precedent — this is what keeps
  local dev and any e2e run without the var Google-free). One boot line reports which
  way it resolved (the mailer convention).
- `GET /api/friends/auth-mode` (public, existing) gains `googleClientId` (resolved
  decision #4). Both login screens, the invite register and the profile modal read it;
  `null` hides every Google control.
- **Deployment requirement (recorded, operator work):** the Google Cloud OAuth client's
  authorized JavaScript origins must include `https://podpultovka.biz`,
  `https://www.podpultovka.biz`, `https://gorifi.skolar.sk`,
  `https://dev.podpultovka.biz`, `https://gorifi-dev.skolar.sk` and
  `http://localhost:5173` (dev). One client covering all origins is the recommended
  setup (one env value everywhere); a separate staging client is an acceptable operator
  choice — either way the env var per environment is the contract.

**Verifier — `backend/src/helpers/google-auth.js`:**

- Dependency: **`google-auth-library`** (pre-approved, 01 §Dependencies) —
  `new OAuth2Client()` + `verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })`, which
  performs signature-against-JWKS (with built-in key caching), `aud`, `iss`
  (`accounts.google.com` both bare and `https://` forms) and `exp` checks. **Never
  hand-roll JWT verification** (01's rule). ⚠ **Pinned to `^10.9.1` (GA-T2): v11
  declares `engines: {"node": ">=22"}` and production runs Node 20.20.2**
  (`deploy/setup-server.sh` installs the Node 20 line; 07 §UC-IA-009 records the
  version). `npm ci --omit=dev` treats that as an EBADENGINE *warning*, so a v11 deploy
  would proceed and could start failing login silently on a patch bump. 10.9.1 is the
  newest line whose `engines` covers Node 20 (`>=18`), and its `OAuth2Client` /
  `verifyIdToken` / `transporterOptions` / `endpoints` / `getFederatedSignonCertsAsync`
  surface is identical to v11's. Revisit only when the server moves to Node 22.
- Exports `verifyGoogleIdToken`. ⚠ **AMENDED AT IMPLEMENTATION (GA-T2, 2026-08-16) — the
  paragraph below described a `… | null` return that cannot carry this UC's own
  401-vs-503 distinction, and GA-T4/T5/T8/T10 point here.** The SHIPPED shape is the
  repo's standard guard shape (`requireHost` / `requireFriendOwner`):
  `verifyGoogleIdToken(idToken, { field? })` → **`{ identity: { sub, email,
  emailVerified } }`** on success, else **`{ error, status, reason, field? }`** with
  `reason ∈ 'not_configured' (503) | 'bad_request' (400) | 'invalid' (401) |
  'unavailable' (503)`. ⚠ **The result is ALWAYS TRUTHY — branch on `.error`, never on
  falsiness; `if (!v) return 401` is now never true** and would let an unverified request
  through. The original intent is unchanged and still binding:
  on any verification failure callers answer 401 — it **never throws
  into a request handler unhandled** (01 §Integrations: this is the backend's second
  outbound call; same rules as the mailer). The JWKS fetch is timeout-bounded (~10 s,
  `AbortSignal`-style or the library's transport timeout); a timeout/network failure is
  a **503** `{ error: 'Overenie Google účtu momentálne nie je dostupné, skúste to
  neskôr' }`, distinguished from a 401 (an invalid token) — a Google outage must not
  read as "wrong credentials". ⚠ Also shipped, and required for that distinction to
  survive: a JWKS response that succeeds but carries **no usable keys** (captive portal,
  proxy error page) is an **outage**, not an invalid token; and the ~10 s is ONE budget
  for the whole call, not one per awaited step.
- `email` is used ONLY when `email_verified` is true in the token; otherwise the stored
  `google_email` is NULL. `sub` is the key regardless.
- Type guard: `id_token` must be a non-empty string ≤ **4096** chars
  ⇒ else 400 `field:'id_token'` (the GSO-T3 bounded-inputs convention; ID tokens are
  ~1–2 KB). ⚠ **Shipped inside `verifyGoogleIdToken`, not "at every call site"** — a
  future route cannot forget a guard it never has to write. The 400's `field` is
  overridable (`{ field: 'google_id_token' }`) for §UC-GA-008's register attach.
- ⚠ **Structural rule (the IA-T3 class):** verification is network I/O and MUST run
  outside any `db.transaction` on every call site in this module. No test can hold this
  — it is a rule, recorded here and as a code comment at each call site.

**e2e testing seam (env-gated test verifier — the Mailgun-stub precedent):**

- When `GOOGLE_AUTH_TEST_MODE=1` is set, `verifyGoogleIdToken` accepts tokens of the
  literal form `TEST:<sub>:<email>` without any network call, returning
  `{ identity: { sub, email, emailVerified: true } }` (shape per the amendment above);
  any other input still takes the real path.
  Honoured ONLY when the var is set — production/staging `.env` files must never
  contain it, and the boot line names the mode so a misconfigured prod is visible in
  logs. The e2e suite starts the gate with `GOOGLE_CLIENT_ID=test-client` +
  `GOOGLE_AUTH_TEST_MODE=1` (UC-GA-013).
- ⚠ **Shipped detail (GA-T2): the var is parsed as a STRICT ALLOW-LIST** — only `1` and
  `true` (case-insensitive) enable the seam. A deny-list reads `off` / `no` / `disabled`
  as ON, which is a total authentication bypass, and this parser is the only barrier
  (the boot line is an audit signal, not a gate). Two further test-mode-gated vars exist
  for e2e observability and nothing else: `GOOGLE_AUTH_TEST_CERTS_URL` (⚠ **loopback
  hosts only** — an attacker-hosted JWKS would turn "test mode accidentally on" from a
  loud bypass into a silent one, since they could then sign a token with our `aud` and
  `iss` for any `sub`) and `GOOGLE_AUTH_TEST_TIMEOUT_MS`.

**Acceptance criteria:** with no `GOOGLE_CLIENT_ID`, every module endpoint returns 503
and `auth-mode` carries `googleClientId: null`; with test mode on, `TEST:sub1:a@b.c`
verifies and a garbage string does not; `{ id_token: 123 }` ⇒ 400 never a 500.

---

## UC-GA-003 Friend Google login — `POST /api/friends/auth/google` (Friend)

**Goal:** a linked friend logs into the portal with Google alone.

**Route contract (public, `authLimiter` — see the rate-limit rule in UC-GA-013):**

- Body `{ id_token }` (+ the same optional `remember` flag module 09 adds to password
  login, once UC-ML lands — the session mint forwards it; seam, coordinated at backlog).
- Order of checks:
  1. Config guard (503 per UC-GA-002); legacy-mode guard (409, resolved decision #2).
  2. `verifyGoogleIdToken` ⇒ null → **401** `{ error: 'Prihlásenie cez Google zlyhalo' }`;
     verifier outage → 503 per UC-GA-002.
  3. `SELECT * FROM friends WHERE google_sub = ?` (⚠ no `active` filter — two-step on
     purpose):
     - no row ⇒ **401** `{ error: 'Tento Google účet nie je prepojený so žiadnym účtom.
       Prihláste sa menom a heslom a prepojte ho v profile.', code: 'not_linked' }` —
       the explicit-link hint 01 mandates. (Accepted, recorded: this is a linked/unlinked
       oracle per Google account; 01's contract requires the hint, and probing costs an
       `authLimiter` slot per attempt.)
     - row with `active = 0` ⇒ **401** `{ error: 'Nesprávne prihlasovacie údaje' }` —
       the same generic message password login gives; an inactive friend must neither
       log in nor learn their linked/deactivated state from this endpoint.
  4. Success: refresh `google_email` when the verified token's differs (display-only
     column, UC-GA-001), `createFriendSession(friend.id)`, response **byte-compatible
     with the password login's shape** (`friends.js` `/auth` personal branch): `success,
     friend {id, name, uid, username, packeta_address}, token, expiresAt,
     hasCredentials: !!friend.password_hash, mustChangePassword:
     !!friend.must_change_password` — plus `googleLinked: true,
     googlePromptDismissed: !!friend.google_prompt_dismissed`. `mustChangePassword`
     true ⇒ the frontend fires the existing forced-change gate (resolved decision #1).
- ⚠ Response is hand-picked, never `SELECT *` spread — **`google_sub` never appears in
  any API response** (module 11 §UC-FC-005's rule, inherited and enforced here; pinned
  by the raw-text regex pattern in UC-GA-013).
- The password login response (`POST /friends/auth`, personal branch) also gains
  `googleLinked` + `googlePromptDismissed` — UC-GA-006's prompt keys on the login
  handshake, not on an extra request. Additive fields only; nothing existing moves
  (module 09 touches the same response for remember-me — additive on both sides, the
  orchestrator reconciles).

**Acceptance criteria:** a linked active friend's `TEST:` token logs in with the full
response shape above; an unlinked sub gets the 401 hint with `code: 'not_linked'`; a
linked friend with `active = 0` gets the generic 401; a linked friend with
`must_change_password = 1` gets `mustChangePassword: true`; the response body matches
`/google_sub/` zero times.

---

## UC-GA-004 Friend link / unlink / prompt-dismiss endpoints (Friend)

**Goal:** the explicit link is created, severed and silenced only by its owner.

**Routes (all in `friends.js`, all guarded by `requireFriendOwner(req, req.params.id)`
with a RESOLVED friendId — shared-password identity-less auth is rejected, the
`requireHost` precedent; all answer 503 when unconfigured except prompt-dismiss, which
has no Google dependency):**

- **`PUT /api/friends/:id/google-link`** (`authLimiter` — it processes
  attacker-suppliable tokens): body `{ id_token }` → verify (UC-GA-002 guards) →
  - the verified `sub` already on ANOTHER friend ⇒ **409** `{ error: 'Tento Google účet
    je už prepojený s iným účtom', field: 'google' }` — no information about WHICH
    friend, ever. Dual-layer: app-level pre-check + the `SQLITE_CONSTRAINT` →
    409 translation on `idx_friends_google_sub` (the GSO-T10 pattern — the app check is
    load-bearing under `instances: 1`; the translation covers the PM2-cluster scenario).
  - same `sub` already on THIS friend ⇒ **200** idempotent (refreshes `google_email`).
  - this friend already linked to a DIFFERENT `sub` ⇒ the link is **replaced** (a friend
    re-linking a new Google account needs no unlink ceremony; the write is one UPDATE).
  - success: `UPDATE friends SET google_sub = ?, google_email = ? WHERE id = ?` →
    200 `{ googleLinked: true, googleEmail }`.
- **`DELETE /api/friends/:id/google-link`**: sets `google_sub = NULL,
  google_email = NULL`; **200 idempotent** on an unlinked friend (the GSO-T5 DELETE
  convergence precedent). Does NOT touch `google_prompt_dismissed` (resolved decision
  #3 applies to the friend side too — symmetric with the admin unlink). **No session
  invalidation** — the link is a login *method*, not the session (11 §UC-FC-006's
  reasoning, mirrored). ⚠ When the friend has no `password_hash`, the response carries
  `warning: 'no_password'` so the UI can warn before/after — the endpoint still allows
  it (the friend's account, the admin reset is the recovery path).
- **`POST /api/friends/:id/google-prompt-dismissed`**: sets
  `google_prompt_dismissed = 1`; 200 idempotent; no body. One-way by design — the
  manual profile trigger (UC-GA-007) is the way back, not a flag reset. ("Teraz nie" is
  client-side only and never reaches the server — UC-GA-006.)
- ⚠ Path note: the admin unlink is `DELETE /api/friends/:id/google` (module 11
  §UC-FC-006, `requireAdmin`) — a DIFFERENT path from the friend-owned
  `…/google-link` routes, deliberately, so neither guard needs to multiplex and the
  api-security anonymous-401 sweep stays unambiguous.

**Acceptance criteria:** friend A cannot link/unlink friend B (403); linking a sub held
by another friend ⇒ 409 whose body names no friend; re-linking the same sub ⇒ 200;
unlink twice ⇒ 200 + 200 and both columns NULL (verified by re-reading the row);
prompt-dismiss persists across logins; no response in this UC contains `google_sub`.

---

## UC-GA-005 Friend login screen — the Google button (Friend)

**Goal:** the modern login card offers Google as a first-class login.

**Business rules (`FriendPortal.vue`, login state, personal tab / modern mode only):**

- Below the existing username+password form: a divider (module 02 style, text
  **"alebo"**) and the GIS-rendered button (Google's own iframe button, `locale: 'sk'`,
  full available width up to GIS's 400 px cap). Rendered ONLY when
  `googleClientId` is non-null AND `authMode === 'modern'` (resolved decision #2) —
  in legacy mode and unconfigured deployments the card is byte-identical to today.
- The GIS callback receives the credential client-side and POSTs it to
  `POST /api/friends/auth/google` via a new `api.js` method (no auth headers — public
  endpoint). Success takes the EXACT post-login path of the password login: store
  `gorifi_friend_auth` (same `{friendId, friendName, token…}` shape — the stored shape
  does not change), fire the forced-change gate on `mustChangePassword`, hand the
  handshake to `FriendPortalSession`.
- Errors render in the existing `authError` slot: the `not_linked` 401 shows its hint
  verbatim; 503 shows its message; anything else the generic failure. Vy-form
  throughout (all Slovak strings in this module already are).
- ⚠ Module 09 owns "Zabudol som heslo" and "Zapamätať si ma" on this same card — this
  UC adds ONLY the divider + button and must compose with whatever 09 places here
  (additive; the orchestrator reconciles layout order).
- The GIS script loads lazily per UC-GA-012's loader — never on guest routes.

**Acceptance criteria:** with `googleClientId: null` the login card renders no Google
control and no request to `accounts.google.com` occurs; with it set, the button
container renders on the modern card and not on the legacy card. (The GIS iframe's
internals are untestable — UC-GA-013.)

---

## UC-GA-006 Post-login link prompt — áno / teraz nie / už sa nepýtať (Friend)

**Goal:** brief item 2 — an unlinked friend is offered the link once per login, and can
silence it forever.

**Trigger rule (testable):** the prompt modal (NeoModal, friend skin) opens after a
successful **non-Google modern login** when ALL hold: `googleClientId` non-null,
`googleLinked === false`, `googlePromptDismissed === false` (both from the login
response, UC-GA-003), AND no blocking gate (forced password change §UC-FL-012 /
credential setup) was shown for this login — **one modal per login, maximum**; when a
gate fired, the prompt simply skips this login. It never opens on session restore
(restore is not a login), never for a Google login (already linked), never on guest or
admin surfaces.

**Content + the three options (confirmed labels):**

- Title **"Prepojiť Google účet?"**, one line of body copy: **"Nabudúce sa prihlásite
  jedným klikom, bez hesla."** (vy-form, no gendered participle).
- **"Áno, teraz"** — swaps the modal body to the GIS button; its callback calls
  `PUT /api/friends/:id/google-link` (UC-GA-004). Success shows the linked
  `google_email` + closes; a 409 renders inline in the modal (the account belongs to
  another friend — message verbatim from UC-GA-004, no retry loop needed).
- **"Teraz nie"** — closes the modal. **Client-side only, no server write**; the prompt
  may return at the next login.
- **"Už sa nepýtať"** — calls `POST /api/friends/:id/google-prompt-dismissed`
  (UC-GA-004), then closes. The prompt never auto-opens again on any device; the
  profile modal (UC-GA-007) remains the manual path — the modal's small print says so:
  **"Prepojenie nájdete kedykoľvek v profile."**

**⚠ Session-boundary rule (the CLAUDE.md FriendPortalSession hazard, restated as a
requirement):** the prompt's state lives where the handshake dies — visibility derives
from the handshake `entry` (seeded once at `FriendPortalSession` setup, exactly like
`needsCredentialSetup`/`mustChangePassword` today) plus a local declined-ref; **no
module-level state, no localStorage, no state keyed on friend id**. Friend B logging in
after friend A on the same device must get their own prompt decision — a "teraz nie"
must not leak across the handshake in either direction. Pinned by a two-friend e2e
(UC-GA-013).

**Acceptance criteria:** fresh password login of an unlinked friend shows the prompt;
"Teraz nie" → logout → login shows it again; "Už sa nepýtať" → logout → login shows
nothing and the flag is 1 in the DB; a friend with `must_change_password = 1` sees the
forced gate and NO prompt that login; friend A "teraz nie" then friend B login on the
same page instance ⇒ B still gets the prompt.

---

## UC-GA-007 Profile modal — Google section, manual link/unlink (Friend)

**Goal:** the always-available manual trigger the brief requires ("should still be
possible to invoke somewhere under their account").

**Business rules (`FriendPortalSession.vue`, inside the existing "Upraviť profil" modal
— module 03 §UC-FL-009 owns the modal; this UC owns only the new section):**

- A **"Google"** section under the existing fields, rendered only when `googleClientId`
  is non-null (unconfigured deployments show no trace):
  - **Unlinked:** helper line **"Prepojte si Google účet a prihlasujte sa jedným
    klikom."** + the GIS button → `PUT /api/friends/:id/google-link`. A 409 renders in
    the modal's existing error slot.
  - **Linked:** the `google_email` (or **"Prepojené"** when NULL) + a
    **"Odpojiť Google účet"** button → confirm → `DELETE /api/friends/:id/google-link`.
    When the endpoint returns `warning: 'no_password'` (UC-GA-004) — or the client
    already knows `hasCredentials` is false — the confirm text must warn that without a
    password the friend will not be able to log in until the admin resets one.
  - Linking or unlinking here updates the section in place and the handshake-scoped
    `googleLinked` state (so UC-GA-006's prompt logic stays consistent within the
    session). It does NOT touch `google_prompt_dismissed` in either direction.
- ⚠ `portal-profile-modal.spec.js` pins this modal's existing labels ~10× (07's
  standing warning) — the section is purely additive; every existing assertion must
  pass unchanged.
- Section state is seeded from the handshake/profile data (`googleLinked`,
  `google_email` via the owner-scoped profile fetch — module 11's UC-FC-005 derivation
  serves it); the session-boundary rule of UC-GA-006 applies identically.

**Acceptance criteria:** an unlinked friend links from the profile and the section flips
to the linked state without a reload; unlink flips it back; the no-password warning
appears exactly when `hasCredentials` is false; all pre-existing profile-modal
assertions pass unmodified.

---

## UC-GA-008 Invite registration — sign up with Google (Applicant)

**Goal:** brief item 1 — the Applicant attaches their Google identity while registering,
so the account created at approval is born linked.

**Business rules:**

- **No new endpoint.** `InviteRegister.vue` gains an optional GIS step; the obtained
  credential travels as `google_id_token` in the existing
  `POST /api/invitations/register` body (`abuseLimiter`, unchanged — the attach rides
  the endpoint's existing bucket).
- Server side (`invitations.js` register handler, which becomes `async`):
  - `google_id_token` absent/empty ⇒ today's flow byte-identical.
  - Present ⇒ type/length guard (UC-GA-002) ⇒ `verifyGoogleIdToken` ⇒ invalid → 400
    `{ error: 'Overenie Google účtu zlyhalo, skúste to znova', field: 'google' }`
    (registration is not a login — a bad token is a bad field, the form stays filled);
    verifier outage → 503 per UC-GA-002.
  - Courtesy dedupe (the UC-IA-003 courtesy-check convention — authoritative check is
    at approval): verified `sub` already on a `friends` row ⇒ **409** `{ error: 'Tento
    Google účet je už prepojený s existujúcim účtom. Prihláste sa cez Google.',
    field: 'google' }`; already on another **pending** invitation ⇒ 409 `{ error:
    'Registrácia s týmto Google účtom už existuje', field: 'google' }` (the
    pending-phone-dedupe precedent, app-check only — no partial index; the friends
    UNIQUE at approval is the backstop).
  - Success: the INSERT carries `google_sub` + `google_email` (UC-GA-001 columns).
  - ⚠ The verification (network) runs before any write — and there is no transaction on
    this path to violate, but the UC-GA-002 structural rule is restated at the call site.
- **UI (`InviteRegister.vue`, Podpultovka skin, vy-form, no placeholders):** below the
  existing four fields, a bordered optional block — `.field-lbl`
  **"Prihlásenie cez Google"** + `.field-help` **"Nepovinné. Po schválení sa budete môcť
  prihlásiť svojím Google účtom."** + the GIS button. After the callback verifies
  client-side possession, the block shows the captured e-mail + a **"Zrušiť"** control
  to detach before submitting; the token is held in memory and sent only with the
  submit. Rendered only when `googleClientId` is non-null. A `field: 'google'` 400/409
  from the submit renders in the view's existing error display with the form kept
  filled (the UC-IA-003/004 convention).
- The attached identity is **frozen on the invitation row** — AdminInvitations may
  display it (badge **"Google"** with the e-mail as `title`, next to the existing source
  badge) but nothing edits it; approval copies it (UC-GA-009), it never back-propagates.

**Acceptance criteria:** registration without the block is byte-identical to today;
with a valid `TEST:` token the invitation row carries `google_sub` + `google_email`;
a sub already on a friend ⇒ 409 `field:'google'`; the form survives the 409 filled;
`{ google_id_token: 123 }` ⇒ 400 never 500; the block is absent when unconfigured.

---

## UC-GA-009 Approval of a Google-attached invitation (Admin)

**Goal:** approval creates the friend already linked — without touching module 07's
invariants.

**Business rules (all changes are inside `POST /api/invitations/:id/approve`,
07 §UC-IA-005, which stays the owner of the endpoint):**

- **The friend INSERT simply carries two more columns** — `google_sub` and
  `google_email` copied from the invitation row (NULL when the invitation has none).
  ⚠ This is still **ONE insert**; the transaction still holds **exactly two writes**
  (INSERT friend, UPDATE invitation) and bcrypt/collision loops still run outside it —
  both IA-T3 structural invariants are explicitly preserved, stated here so no
  implementer reads "add Google to approve" as licence to add a third write or a
  network call. **No verification happens at approval** — the token was verified at
  registration; the stored `sub` is data, not a credential to re-check.
- **Pre-check outside the transaction** (the UC-IA-005 username pattern): the
  invitation's `google_sub` already on a `friends` row ⇒ **409** `{ error: 'Google účet
  z tejto registrácie je medzičasom prepojený s iným účtom', field: 'google' }` — the
  admin approves again after clearing the conflict, **and the dialog offers "approve
  without the Google link"** (resolved by the product owner, 2026-08-15 — see below):
  re-submitting with `drop_google_link: true` approves via the unchanged 07 path, the
  friend row carrying NO `google_sub`/`google_email`; approval is never dead-ended on a
  collision. The `SQLITE_CONSTRAINT` on
  `idx_friends_google_sub` inside the transaction translates to the same 409
  (dual-layer, nothing written on failure — the transaction is the mechanism).
- Everything else is UNCHANGED per resolved decision #5: username required, temp
  password generated, `must_change_password = 1`, subscriptions/session/transactions
  non-writes, the 201 shape (which gains nothing — `google_sub` stays out of the
  response per the strip rule; the dialog learns the link state from the invitation
  row it already has).
- **Approval dialog (`AdminInvitations.vue`):** the read-only invitation summary gains
  a **"Google"** line (the attached e-mail) when present — the admin sees what they are
  approving. Success state unchanged.
- OPEN: should the credentials message (07 §UC-IA-006's clipboard copy + §UC-IA-009's
  e-mail — both product-owner-signed VERBATIM) gain a sentence for Google signups
  ("…alebo sa prihlás svojím Google účtom")? Copy changes to signed strings need the
  product owner; until decided, the message ships unchanged.
- **RESOLVED (product owner, 2026-08-15): the dialog OFFERS "approve without the Google
  link"** on the 409 — it explains the collision (never naming the other friend) and a
  secondary action re-submits with `drop_google_link: true`; the temp-password path is
  then exactly 07's, and the applicant can link Google later via UC-GA-004/007.

**Acceptance criteria:** approving a Google-attached invitation creates a friend whose
row carries the invitation's `google_sub`/`google_email` plus every UC-IA-005 column;
that friend's `TEST:` Google login immediately works and returns
`mustChangePassword: true`; approving when the sub was linked elsewhere in the interim
⇒ 409 and NO friend row exists; a non-Google invitation approves byte-identically to
today; the 201 body matches `/google_sub/` zero times.

---

## UC-GA-010 Admin allowlist management (Admin)

**Goal:** which Google identities may enter the admin portal, stored in settings,
managed without anyone ever typing a `sub` by hand.

**Storage:** settings key **`admin_google_subs`** (01's named key) — JSON array of
`{ sub, email, added_at }`. Empty/absent ⇒ nobody logs into admin via Google.

**Routes (`admin.js`, all `requireAdmin` ⇒ all THREE join `ADMIN_ENDPOINTS` in
`api-security.spec.js` — the standing CLAUDE.md rule):**

- **`GET /api/admin/google-allowlist`** → `{ entries: [{ email, added_at }] }` —
  ⚠ the `sub` values are deliberately OMITTED from the response (the module-11 strip
  rule extended to admin subs: a raw `sub` is an identity key, nothing client-side
  needs it; `email` is the display + deletion handle).
- **`POST /api/admin/google-allowlist`** — body `{ id_token }`: the admin (already
  password-authenticated) proves possession of the Google account being added; verify
  per UC-GA-002 (503/401/400 guards apply) → append `{ sub, email, added_at }`;
  duplicate `sub` ⇒ 200 idempotent (refreshes the stored e-mail). Confirming at link
  time is what 01's "e-mails confirmed at link time" means — no hand-typed identities,
  no e-mail-based matching ever.
- **`DELETE /api/admin/google-allowlist`** — body `{ email }`: removes the entry with
  that e-mail; 200 idempotent when absent. Removing the LAST entry is allowed —
  password auth is the permanent backup (brief item 3), so Google lockout is
  recoverable by design.

**UI (`AdminSettings.vue`, current shadcn look):** a "Prihlásenie cez Google" section —
the entries list (e-mail + added date + remove button with `confirm()`), and a GIS
button labelled by helper text "Pridať Google účet, ktorým sa chcete prihlasovať" that
drives the POST. Hidden entirely when `googleClientId` is null.

**Acceptance criteria:** anonymous calls to all three routes ⇒ 401 via the api-security
sweep; POST with a `TEST:` token appends an entry; the GET body matches `/"sub"/` zero
times; DELETE removes by e-mail idempotently; with an empty allowlist the admin Google
login (UC-GA-011) always 401s.

---

## UC-GA-011 Admin Google login — `POST /api/admin/google-login` (Admin)

**Goal:** brief item 3 — the admin logs in with Google; password stays as backup.

**Route contract (public, `authLimiter`, in `admin.js`):**

- Body `{ id_token }` → config guard (503) → verify (UC-GA-002: 400 type guard, 401
  invalid, 503 outage) → verified `sub` ∈ `admin_google_subs` ⇒ mint; else **401**
  `{ error: 'Tento Google účet nemá prístup do administrácie' }`. No auth-mode
  dependency — `auth_mode` governs the FRIEND surface only.
- **The mint is byte-identical to the password login's** (`admin.js:80-89`): 32-byte
  random token, 7-day expiry, `INSERT OR REPLACE INTO settings ('admin_token', …)`,
  response `{ token }`. ⚠ There is exactly ONE admin token app-wide — a Google login
  therefore invalidates any token minted earlier by a password login, exactly as a
  second password login does today. Known behaviour, not a bug; restated because the
  e2e harness trips on it (CLAUDE.md IA trap — UI login invalidates API-minted tokens).
- No new session machinery, no allowlist mutation, no settings write beyond the token.

**UI (`AdminLogin.vue`, current look):** the password form stays primary (backup
guarantee = it is never removed or hidden); below it, an "alebo" divider + the GIS
button, rendered only when `googleClientId` is non-null. Success stores the token in
`localStorage.adminToken` and navigates exactly as the password path does. A 401
renders in the existing error slot.

**Acceptance criteria:** a `TEST:` token whose sub is allowlisted returns a token that
passes `POST /api/admin/verify` and reaches an admin route; a non-allowlisted sub ⇒
401; password login still works after a Google login and vice versa (each invalidating
the other's token); with `googleClientId: null` the login screen is byte-identical to
today.

---

## UC-GA-012 CSP + GIS script loading (system)

**Goal:** the ONE sanctioned CSP exception (01 §Integrations), landed without
regressing the RD-DS-6 discipline.

**Business rules:**

- **CSP additions** (per Google's published GIS CSP guidance — re-verify against the
  current GIS docs at implementation time):
  - `script-src` += `https://accounts.google.com/gsi/client`
  - `frame-src https://accounts.google.com/gsi/` — ⚠ a NEW directive: the shipped
    policy has none, so today GIS iframes fall to `default-src 'self'` and are blocked.
  - `connect-src` += `https://accounts.google.com/gsi/`
  - `style-src` += `https://accounts.google.com/gsi/style`
- Applied to **every** `add_header Content-Security-Policy` line in BOTH
  `deploy/nginx-gorifi.conf` (3 occurrences) and `deploy/nginx-gorifi-staging.conf`
  (3 occurrences) — six lines, one identical policy string. Scoped additions only; the
  self-hosted-fonts rule (`font-src 'self' data:` etc.) is NOT relaxed.
- ⚠ **`e2e/tests/self-hosted-fonts.spec.js` carries a VERBATIM copy of the prod header
  and MUST be updated in the SAME change** (01's explicit obligation; the spec's own
  comment says so). Its "zero non-same-origin requests" route sweep additionally needs
  a scoped allowlist for `accounts.google.com` on `/` and `/invite/:code` — an
  e2e-immutability case (a) edit, citing this UC. The `/g/:token` assertion stays at
  **zero external requests**: guests never see Google (see the loader rule).
- **GIS script loading — `frontend/src/lib/gis.js`, ONE home:** an idempotent async
  loader that injects `<script src="https://accounts.google.com/gsi/client">` on first
  use and resolves when `window.google.accounts.id` exists, with a timeout rejection
  (a blocked/offline Google must degrade to the password form, never hang a login
  screen). ⚠ **Never in `index.html`** — the script must load ONLY on surfaces that
  render a Google control (`FriendPortal` login, `AdminLogin`, `InviteRegister`,
  profile modal, AdminSettings), and never on guest routes, keeping the guest sweep at
  zero. Loader no-ops (resolves null) when `googleClientId` is null so call sites need
  no separate guard.
- The GIS iframe button inherits none of the app's theme (cross-origin iframe) —
  accepted; see the Design reference note.

**Acceptance criteria:** with the updated header served (the self-hosted-fonts spec's
throwaway-static-server pattern), a page rendering the GIS button logs zero
`securitypolicyviolation` events; `/g/:token` still makes zero non-same-origin
requests; the spec's header copy string-equals the nginx one.

---

## UC-GA-013 Verification — spec obligations, rate-limit rule, e2e strategy (system)

**Goal:** how the implementing tasks prove this module correct. No unit runner exists
(01 §Testing) — the bar is Playwright e2e + `node --check`.

**Rate-limit rule (one sentence, applied module-wide):** every endpoint that ACCEPTS an
ID token for verification sits on **`authLimiter`** (friend Google login, friend link,
admin allowlist POST, admin Google login) — token verification is the credential-check
step, so forged-token probing is credential guessing and belongs in the strict 20/window
bucket beside `/friends/auth` and `/admin/login`; the registration attach rides
`POST /invitations/register`'s existing **`abuseLimiter`** (one endpoint, one bucket);
prompt-dismiss and friend unlink verify nothing and need no limiter beyond their auth
guard. No new bucket — the four-bucket set and its NAT'd-office reasoning (CLAUDE.md)
are untouched.

**⚠ What e2e CANNOT test, stated up front:** the GIS button flow itself — the iframe,
Google's popup, credential issuance — cannot run against a stub Google in Playwright.
The e2e boundary is the ID token POST. Everything from that POST inward IS tested, via
the UC-GA-002 seam: the suite's server runs with `GOOGLE_CLIENT_ID=test-client` +
`GOOGLE_AUTH_TEST_MODE=1`, accept paths use `TEST:<sub>:<email>` tokens, reject paths
use malformed/garbage tokens against the real verifier (which fails locally at decode,
no network). Wrong-`aud`/wrong-`iss`/expired against REAL Google tokens is untestable
here and is delegated to `google-auth-library` (the not-hand-rolling dividend) plus one
manual staging walkthrough. Button *presence/absence* logic (configured vs not, modern
vs legacy) is testable and pinned.

**Numbered spec obligations:**

1. **`api-security.spec.js`:** `ADMIN_ENDPOINTS` += the three allowlist routes
   (UC-GA-010). The friend/admin Google LOGIN endpoints are public and must NOT join
   the list.
2. **`self-hosted-fonts.spec.js`:** header copy + scoped `accounts.google.com`
   allowlist per UC-GA-012 — same change as the nginx edit, never separately.
3. **`portal-profile-modal.spec.js` passes UNCHANGED** (UC-GA-007 is additive).
4. **`invitation-approval.spec.js` passes unchanged**; its file or a new one gains the
   Google-attached approval cases (UC-GA-009).
5. **New `e2e/tests/google-auth.spec.js`:**
   - API: friend login happy path + not-linked hint + inactive-generic-401 +
     `mustChangePassword` propagation (UC-GA-003); link 409 collision naming no friend,
     idempotent unlink, prompt-dismiss persistence, cross-friend 403 (UC-GA-004);
     register attach + both dedupe 409s + `{google_id_token:123}` ⇒ 400 (UC-GA-008);
     approve-linked + interim-collision 409 with no friend row written (UC-GA-009);
     allowlist CRUD + admin Google login + token interchangeability with password
     login (UC-GA-010/011); 503s with the feature unconfigured (a second server run or
     a targeted expectation — the suite default HAS the var set).
   - **Strip-rule pins (the UC-IA-005 pattern):** raw-text regex `/google_sub/` over
     the FULL bodies of the friend login response, the link/unlink responses, the
     approve 201 and the allowlist GET (`/"sub"/` for the latter) — a future
     `SELECT *` fails loudly.
   - UI: button absence when unconfigured (friend login, admin login, invite register,
     profile — zero `accounts.google.com` requests, the RD-DS-6 lesson: assert the
     REQUEST, not just the DOM); prompt trigger matrix incl. the forced-gate skip and
     the two-friend session-boundary leak test (UC-GA-006); profile section link/unlink
     flips (via API-seeded state where the GIS iframe would be needed).
   - Fixtures per test, not shared `beforeAll` (GSO-T8); any UI admin login adopts the
     browser's token (ONE admin token — the IA trap, doubly relevant now that Google
     logins also rotate it).
6. **Structural rules no test can hold**, recorded as code comments at the sites +
   CLAUDE.md on landing: verification-outside-transaction (UC-GA-002); the approve
   transaction still holding exactly two writes (UC-GA-009 / IA-T3);
   `GOOGLE_AUTH_TEST_MODE` never in a deployed `.env` (the boot line is the audit).

**Procedure:** `node --check` on changed backend files; local e2e recipe per CLAUDE.md
(fresh `DB_PATH` + seed, `CORS_ORIGIN` incl. the gate's origin, all four rate-limit
vars raised, plus the two Google test vars; output to a file, never `| tail`); targeted
files first (`google-auth`, `api-security`, `self-hosted-fonts`, `portal-profile-modal`,
`invitation-approval`, `invite-register-shell`, `modern-login`), then the full suite.
Manual staging walkthrough with a REAL Google account: friend link → logout → Google
login; admin allowlist add → Google login; invite register with Google → approve →
Google login → forced password change.

---

## Accepted risks / follow-ups / OPEN items (recorded, not silently implemented)

- **Linked/unlinked oracle:** the `not_linked` login hint (UC-GA-003) reveals whether a
  Google account is linked. Mandated by 01's contract; bounded by `authLimiter`.
  Accepted.
- **GIS button styling:** Google's iframe button cannot wear the Podpultovka skin —
  accepted on every surface (see Design reference).
- **Dropped: action-triggered link prompts** (resolved decision #6) and **Google One
  Tap** (resolved decision #7) — named so they are not silently implemented.
- **`google_email` staleness:** refreshed only on Google login (UC-GA-003) and re-link;
  a renamed Google account shows a stale display e-mail elsewhere. Display-only column,
  accepted.
- **OPEN (UC-GA-009): credentials-message copy for Google signups** — the clipboard/
  e-mail strings are product-owner-signed verbatim (07 §UC-IA-006/009); adding an
  "…alebo sa prihlás cez Google" sentence needs sign-off. Ships unchanged until then.
- ~~OPEN (UC-GA-009): the mid-flight sub-collision 409 at approval~~ — **RESOLVED
  (2026-08-15): the dialog offers "approve without the Google link"
  (`drop_google_link: true` re-submit); see UC-GA-009.**
- **OPEN (deployment): one OAuth client for all origins vs a separate staging client**
  — operator choice; one-client-all-origins recommended (UC-GA-002). Either way the
  Google Cloud console work is outside the repo and gates the first staging verify.
- **Seam to module 09 (not open, for the consistency pass):** the same login card and
  login-response payload change in both modules — both are specified additive
  (UC-GA-003/005); the Google login endpoint forwards 09's `remember` flag to the
  session mint once UC-ML lands.
- **Answered for module 11:** UC-FC-006's OPEN — admin unlink does NOT reset
  `google_prompt_dismissed` (resolved decision #3); 11's "module 10 must decide and
  this UC follows" clause is hereby satisfied.
- **CLAUDE.md on landing:** record the GIS CSP additions beside the RD-DS-6 entry (the
  header copy in `self-hosted-fonts.spec.js` moves again) and the `GOOGLE_AUTH_TEST_MODE`
  seam beside the Mailgun no-op note.
