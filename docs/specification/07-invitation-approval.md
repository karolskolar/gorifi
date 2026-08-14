# 07 — Invitation → friend with login (one-click approval)

> Scope: The end-to-end path from a public invitation registration (`/invite/:code`) to a
> friend row that can actually log in: the `invitations` schema additions (`username`,
> `created_friend_id`), the `generateTempPassword()` export, the
> `helpers/friend-create.js` extraction of `getPlaceholderCycleId()`, the hardening of
> `POST /invitations/register` (type guards, length bounds, optional username), the new
> atomic `POST /api/invitations/:id/approve` endpoint, the `InviteRegister.vue` username
> field, the `AdminInvitations.vue` approval dialog, the `AdminFriends.vue` relabel +
> retirement of the `?create=1` prefill, and `api.js approveInvitation`. ⚠ Unlike modules
> 02–06 this module INCLUDES backend/schema changes (00-overview §Specification files).
> Out of scope (handoffs): **SMTP email delivery** of credentials — recorded phase-2
> follow-up, the dialog's copy button is the whole delivery mechanism in this phase;
> **digit-normalised phone dedupe at approval** — accepted risk (see §Accepted risks);
> **`FriendPortalSession.vue`'s identical "Prihlasovacie meno" label** — pinned ~10× by
> `portal-profile-modal.spec.js`, DO NOT touch it (module 03 §UC-FL-009 owns that modal);
> **the forced-change gate itself** — already shipped and e2e-covered (module 03
> §UC-FL-012 + `modern-login.spec.js` §"Forced password change"); this module only SETS
> `must_change_password = 1`.
> Actors: **Applicant** — the invitee filling `/invite/:code`; friend-surface register,
> addressed in vy-form. **Admin** — sole operator of the approval dialog; sees all
> invitation data. **Inviter** — context only: their name appears in the note prefill
> "Pozval/a: X" (a third-party participle, allowed per the GSO-T10 register pin — the pin
> is about the reader, not all participles).
> Sources: `/home/karolskolar/.claude/plans/home-karolskolar-claude-uploads-52aa99d-quizzical-neumann.md`
> (the validated design, confirmed with the product owner 2026-08-13 — authoritative
> brief; its §Context describes the bug report's two screenshots: the "Nový priateľ"
> modal's "Prihlasovacie meno *" field writing `friends.name` with no login created, the
> "Prihlásenie" column showing `-`); repo `CLAUDE.md` (SEC-S2, ADMIN_ENDPOINTS rule,
> GSO-T10 provenance follow-up, `instances: 1` concurrency, A12 iOS input rule,
> 2026-08-10 no-placeholder decision); repo code (`backend/src/db/schema.js`,
> `backend/src/routes/invitations.js`, `backend/src/routes/onboarding.js`,
> `backend/src/middleware/friend-auth.js`, `frontend/src/views/InviteRegister.vue`,
> `AdminInvitations.vue`, `AdminFriends.vue`, `frontend/src/api.js`); shipped e2e specs
> (`api-security`, `guest-lead-capture`, `invite-register-shell`, `ios-input-zoom`,
> `portal-profile-modal`). The most recent decision wins on conflict.
> **Design reference:** no prototype screen exists for this module. The applicant-facing
> username field copies the existing `InviteRegister.vue` field group verbatim (module 02
> primitives: `.field-lbl` / `.inp` / `.field-help`). The admin dialog follows the
> existing shadcn Dialog conventions of `AdminInvitations.vue` — admin views stay on the
> current look (01-architecture §Design system scope rule).

---

## Resolved conflicts (recency / canonicity)

1. **The `?create=1` navigation-prefill flow is RETIRED.** The 2026-07-07 feature
   ("Vytvoriť" → `router.push('/admin/friends?create=1&name=…&phone=…&email=…')` →
   `AdminFriends.vue onMounted` prefill, documented in CLAUDE.md "Pending Invitations
   Dashboard Alert + Prefill") is superseded by the approval dialog (UC-IA-006). The
   plan (2026-08-13, newest) wins. Consequence: the prefill block in `AdminFriends.vue`
   is **deleted** (UC-IA-007), `guest-lead-capture.spec.js:538-565` — which pins the old
   navigation — is retargeted (UC-IA-008), and the CLAUDE.md 2026-07-07 note becomes
   partially stale (the "Vytvoriť → query params" half).
2. **"Prihlasovacie meno" in AdminFriends is a misnomer and is relabelled; the same
   string in `FriendPortalSession.vue` is pinned and stays.** The label promises a login
   but writes `friends.name` (a display label). Resolution: relabel only the admin
   surface (UC-IA-007); the friend-portal profile modal's label is protected by
   ~10 assertions in `portal-profile-modal.spec.js` and belongs to module 03.
3. **`generateTempPassword()` wraps `randomCode(12)`, never `generateGuestToken()`.**
   SEC-S2 says one RNG home; `generateGuestToken()` is that same RNG but is a
   guest-token *concept* (14 chars, exported for guest links). The temp password gets
   its own named export over the same private `randomCode` — no second RNG, no concept
   reuse.
4. **Approval never rewrites `invitations.username`.** The applicant's requested
   username stays on the invitation row as the historical record; the admin's override
   (`body.username`) lands only on the created friend. The back-link
   (`created_friend_id`) is how the two are correlated.

---

## UC-IA-001 Schema — invitation columns + `generateTempPassword()` (system)

**Goal:** the two `invitations` columns and the temp-password generator, in
`backend/src/db/schema.js`.

**Business rules:**

- Migrations use the repo's try/catch `ALTER TABLE` pattern (column exists ⇒ ignore):
  - `ALTER TABLE invitations ADD COLUMN username TEXT` — the applicant's requested
    login name, NULL when none was requested.
  - `ALTER TABLE invitations ADD COLUMN created_friend_id INTEGER` — back-link to the
    friend row an approval created; NULL until approved.
- `created_friend_id` has **no FK** (the bare-`ALTER TABLE` pattern cannot add one).
  It is an informational back-link only: consumers must tolerate an unresolvable
  pointer (a hard-deleted friend leaves it dangling — the GSO-T9 tolerance precedent).
  Nothing may gate behaviour on it resolving.
- **`generateTempPassword()`** is a new named export from `schema.js` returning
  `randomCode(12)` — 12 chars over the existing 32-char unambiguous `CODE_ALPHABET`
  (≈60 bits), which clears the ≥8-char password policy. SEC-S2: it MUST delegate to
  the module-private `randomCode`; never a second RNG, and never a re-export of
  `generateGuestToken()` (resolved conflict #3).

**Acceptance criteria:** backend restart on an existing DB adds both columns without
error and is idempotent; `generateTempPassword()` returns 12 chars, all from
`CODE_ALPHABET`, different across calls.

---

## UC-IA-002 `helpers/friend-create.js` — one home for `getPlaceholderCycleId()` (system)

**Goal:** extract the placeholder-cycle resolver that exists twice today.

**Business rules:**

- New `backend/src/helpers/friend-create.js` exports `getPlaceholderCycleId()` with the
  exact behaviour of `onboarding.js:23-32`: SELECT the first `order_cycles` row by id;
  if none, INSERT `('_placeholder', 'completed')` and return its id.
- Both existing copies switch to the helper: `onboarding.js` (the function) and
  `friends.js` `POST /` (the inlined equivalent at ~471-475). Behaviour byte-identical;
  this is a pure extraction, no logic change.
- UC-IA-005's approve endpoint is the third consumer. Never re-inline this query.

**Acceptance criteria:** `node --check` passes; onboarding self-signup and admin friend
creation still create friends on an empty-cycles DB (placeholder cycle auto-created
exactly once).

---

## UC-IA-003 `POST /invitations/register` — hardening + optional username (Applicant)

**Goal:** the public registration endpoint stops 500-ing on malformed bodies (the
recorded `{name:123} → 500` follow-up) and accepts an optional username.

**Business rules:**

- **Type guards:** `invite_code`, `name`, `phone`, `email`, `username` must each be a
  string when present — any non-string (number, object, array, boolean) ⇒ **400**,
  never a 500 from `.trim()` on a non-string. `{name: 123}` ⇒ 400.
- **Length bounds (after trim):** `name` ≤ **120**, `phone` ≤ **32**, `email` ≤ **160** —
  local constants in `invitations.js` mirroring guest.js's checkout bounds. ⚠ Do NOT
  import guest.js's `validateIdentity` — it is module-private and pinned to the GSO-T3
  money path (`guest-order.spec.js` is its regression net); editing or exporting it is
  out of scope here.
- **Errors:** 400 with Slovak vy-form message + a `field` marker (the guest.js
  contract), e.g. `{ error, field: 'name' }`.
- **Optional username:** lowercase + trim first. When the result is **empty/absent** ⇒
  stored as NULL, no validation runs (`validateUsername` returns "povinné" on empty —
  it must only be called for a non-empty value). When **non-empty** ⇒
  `validateUsername()` (`middleware/friend-auth.js`: 3–30 chars, `[a-z0-9._-]`) ⇒ 400
  with `field: 'username'`; then `isUsernameTaken()` ⇒ **409** with `field: 'username'`.
- The INSERT gains the `username` column; everything else is preserved verbatim:
  `abuseLimiter`, uppercase invite-code lookup (400 "Neplatný kód pozvánky"), the
  pending-phone dedupe 409 ("Registrácia s týmto číslom už existuje"), 201
  `{ success: true }`.
- A username being taken at *registration* time does not block later approval with a
  different one — the 409 is a courtesy check; the authoritative check is at approval
  (UC-IA-005).

**Acceptance criteria:** `{name:123}` ⇒ 400; a 200-char name ⇒ 400 `field:'name'`;
`username: 'AB'` ⇒ 400 `field:'username'`; a taken username ⇒ 409; a valid registration
with `username: ' Lego '` stores `lego`; without username stores NULL.

---

## UC-IA-004 InviteRegister.vue — the username field (Applicant)

**Goal:** the applicant can request their login name on the public form.

**Field group (one new field, inserted between Telefón and Email):**

| Field | Markup / constraints |
|---|---|
| Prihlasovacie meno | `label.field-lbl` "Prihlasovacie meno" with `for`/`id` association (`ir-username`, matching the view's `ir-*` convention) + `input.inp` `type="text"`, `maxlength="30"`, **no placeholder** (2026-08-10 decision), `autocapitalize="none"`, `autocorrect="off"`; below it `div.field-help` **"Nepovinné. 3–30 znakov: malé písmená, čísla, bodka, podčiarknik, pomlčka."** |

**Business rules:**

- `.inp` is mandatory, not stylistic: the A12 iOS rule — any new text input on the
  friend surface must be `.inp` so the coarse-pointer 16px font rule prevents iOS zoom.
  `ios-input-zoom.spec.js` counts `.inp` elements (UC-IA-008 item 4).
- Submitted value: lowercased + trimmed; **omitted from the body when empty**
  (`submitInvitation` already forwards arbitrary body fields — no `api.js` change for
  this half).
- Server 400/409 with `field: 'username'` surfaces through the view's existing error
  display; the form stays filled so the applicant can retry.
- Following the GSO-T3 mirror convention, the three existing inputs also gain
  `maxlength` matching UC-IA-003's bounds: name 120, phone 32, email 160.
- Register: vy-form, impersonal (the `field-help` above is the template — no gendered
  participle addresses the reader).

**Acceptance criteria:** the form shows 4 labelled fields; the username input has no
placeholder and 16px font at coarse pointer; submitting "Lego" registers `lego`;
leaving it blank still registers (unchanged happy path).

---

## UC-IA-005 `POST /api/invitations/:id/approve` — atomic friend creation (Admin)

**Goal:** one admin call converts a pending invitation into a friend **with working
credentials**, atomically.

**Route contract:**

- `POST /api/invitations/:id/approve`, guarded by **`requireAdmin` per-route** — the
  invitations router is a MIXED mount (public `/code/:code` + `/register`, admin rest);
  never wrap the whole mount. ⚠ The endpoint MUST be added to the canonical
  anonymous-401 list `ADMIN_ENDPOINTS` in `e2e/tests/api-security.spec.js` (CLAUDE.md
  rule; UC-IA-008 item 1).
- **404** — unknown invitation id.
- **409** — invitation not `pending`; the body carries `created_friend_id` when the row
  has one (so the dialog can say who already exists).
- **Username resolution:** `body.username ?? invitation.username`, lowercased +
  trimmed. Missing/empty after that ⇒ **400** `field:'username'` (a friend with a login
  is the whole point — there is no username-less approval). Then `validateUsername()`
  ⇒ 400 `field:'username'`; `isUsernameTaken()` ⇒ **409** `field:'username'`.
- **Note:** `body.note` (string, optional) → the new friend's `display_name`
  (`note || null`) AND the invitation's `admin_note` (`note ?? existing admin_note` —
  absent means keep).

**Ordering rule (concurrency + CPU):** bcrypt `hashPassword(tempPassword)` and the
uid/invite-code collision-retry loops run **BEFORE** the transaction — bcrypt is
~100 ms of CPU and better-sqlite3 transactions are synchronous; the transaction itself
must stay tight. `tempPassword = generateTempPassword()` (UC-IA-001).

**ONE `db.transaction` containing exactly two writes:**

1. **INSERT friend** — template is `onboarding.js:203-276`:
   `cycle_id = getPlaceholderCycleId()` (UC-IA-002), `name = invitation.name`,
   `display_name = note || null`, generated `uid`, `access_token = nanoid(12)`,
   generated `invite_code`, `active = 1`, `phone = invitation.phone`,
   `email = invitation.email`, resolved `username`, bcrypt `password_hash`,
   **`must_change_password = 1`** (the shipped forced-change gate — module 03
   §UC-FL-012 — fires on first login; this module only sets the flag), and
   **`onboarding_source = invitation.source === 'guest_order' ? 'guest_order' : 'invitation'`**
   — this closes the recorded GSO-T10 provenance follow-up ("a guest-sourced lead
   converted via Vytvoriť writes no `friends.onboarding_source`").
2. **UPDATE invitation:** `status = 'processed'`, `processed_at = CURRENT_TIMESTAMP`,
   `admin_note` per the note rule, `created_friend_id = <new friend id>`
   (back-link; UC-IA-001).

**Deliberate non-writes (each is a rule, not an omission):**

- **No `friend_subscriptions` row** — no rows means the friend sees everything
  (`friends.js:310-322`, `live-cycle.js:136-137`). This deliberately diverges from
  onboarding's bakery auto-subscribe: an invited friend starts unfiltered.
- **No session mint** — the friend logs in themselves with the temp password.
- **No `transactions` row** — creation is not a financial event (the GSO-T6 lesson).

**Failure + response:**

- `SQLITE_CONSTRAINT` on `idx_friends_username` inside the transaction ⇒ clean **409**
  (the GSO-T10 dual-layer pattern: the app-level `isUsernameTaken` check is
  load-bearing under `instances: 1` + synchronous better-sqlite3; the constraint→409
  translation stays for the PM2-cluster scenario). Nothing is written on failure —
  the transaction is the mechanism.
- **201** `{ friend: { id, name, uid, username }, username, tempPassword }` — the
  plaintext temp password exists in exactly this one response: never persisted, never
  logged, never returned by any other endpoint. The friend object is **hand-picked**
  — never `sanitizeFriend` (module-local to `friends.js`) and never `SELECT *`
  (`invite_code` etc. stay unpublished).

**Acceptance criteria:** approving a pending invitation creates a friend whose row has
all columns above; logging in with the returned username + tempPassword yields
`mustChangePassword: true`; the invitation row reads `processed` with
`created_friend_id` set; a second approve returns 409 carrying that id; anonymous call
returns 401 via the api-security suite.

---

## UC-IA-006 AdminInvitations.vue — the approval dialog (Admin)

**Goal:** "Vytvoriť" becomes a one-click approval, with the dialog as the only holder
of the plaintext credentials.

**Trigger:** the "Vytvoriť" button on a pending invitation row opens the dialog —
**no navigation** (the `router.push('/admin/friends?…')` in
`createFriendFromInvitation` is deleted; resolved conflict #1).

**Dialog — form state:**

- **Invitation summary** (read-only): name, phone, email, inviter, created date, and
  the existing source badge (guest-sourced rows keep their "Prišiel cez hosťovskú
  objednávku" badge — GSO-T10).
- **Username input**, prefilled: `inv.username` when present; otherwise a **slugify
  suggestion** from `inv.name` — NFD normalise → strip combining marks (diacritics) →
  lowercase → whitespace runs → `.` → drop every char outside `[a-z0-9._-]` → clamp to
  30 chars; if the result is shorter than 3, prefill empty instead. (Example:
  "Ján Kováč" → `jan.kovac`.) The input stays editable — the admin has the last word.
- **Note input**, prefilled **"Pozval/a: {inviter_name}"** when `inviter_name` exists,
  else empty. The participle is third-party (describes the inviter, not the reader) —
  allowed per the GSO-T10 register pin. Editable; lands in `friends.display_name` +
  `invitations.admin_note` (UC-IA-005).
- **NO legacy-mode warning line** — RESOLVED by the product owner (2026-08-13): the
  portal no longer uses the shared password, so the warning would describe a dead
  state. The dialog renders no auth-mode-dependent content at all. (The wider cleanup —
  retiring `auth_mode = 'legacy'`/`'transition'` machinery — is a recorded follow-up in
  §Accepted risks, NOT part of this module.)
- Confirm button → `api.approveInvitation(id, { username, note })`.

**Dialog — error handling:** a 400/409 from the endpoint renders **inline in the
dialog** with the username field still editable — the admin fixes the username and
retries without reopening (the "two pending invitations race" lands here as an
editable 409).

**Dialog — success state (same dialog, swapped content):**

- Username + temp password in a mono block, plus the login URL
  (`window.location.origin`).
- **Copy button** placing this message on the clipboard — VERBATIM, signed by the
  product owner (2026-08-13):
  *"Ahoj, tvoj účet je pripravený. Prihlás sa na {url} - užívateľské meno: {username},
  dočasné heslo: {tempPassword}. Po prvom prihlásení si nastav vlastné heslo."*
  ⚠ Deliberately **ty-form**, overriding the module's vy-form register for this ONE
  string: it is the admin's personal message to a friend they invited, not app copy
  addressing an anonymous reader — the vy-form rule (GSO-T10) governs UI text, and the
  product owner chose the informal register here explicitly. Plain hyphen, exact
  punctuation as written.
- **The list refreshes BEHIND the dialog** (the row leaves pending) while the dialog
  stays open — the dialog is the ONLY holder of the plaintext and closes **only on
  explicit user action** (close button / Esc / scrim — never auto-close, never a
  timeout). After close the plaintext is unrecoverable by design; the recovery path is
  the admin's existing per-friend password reset.

**Business rules:**

- `api.js` gains `approveInvitation(id, data)` → `POST /invitations/:id/approve` via
  the standard admin `request()` (X-Admin-Token attached as for every admin call).
- "Spracované", "Zamietnuť", "Vymazať" row actions are **unchanged** — approval is a
  new path beside them, not a replacement for the status PATCH.
- Admin surface: existing shadcn Dialog conventions, no `neo/` classes, no theme tokens
  (01-architecture scope rule — admin views keep the current look).

**Acceptance criteria:** "Vytvoriť" on a pending row opens the dialog with username +
note prefilled; approve shows the credentials block; copy puts the full message on the
clipboard; the row is gone from the pending list behind the still-open dialog; a taken
username shows an inline 409 and the field stays editable; no navigation occurs at any
point.

---

## UC-IA-007 AdminFriends.vue — relabel + retire the `?create=1` prefill (Admin)

**Goal:** the misleading "this field is your login" strings go away, and the dead
prefill path is deleted.

**Business rules:**

- **Relabel** (the name field writes `friends.name`, a display label — never a login):
  - Modal label `Prihlasovacie meno *` → **`Meno *`**.
  - Table header `Prihlasovacie meno` → **`Meno`**.
  - The placeholder `Zobrazuje sa v prihlasovacom dropdowne` is **removed** (the
    dropdown exists only in the retiring legacy mode; the claim is stale).
  - The hint `Toto meno sa zobrazuje pri prihlasovaní` → **`Toto meno vidí správca a
    kolegovia.`** (aligned with module 03 §UC-FL-009's profile help — same field, same
    truth). The governing rule, testable: after this UC **no string in
    `AdminFriends.vue` may claim the name field is used for login**.
- **Delete the `?create=1` prefill block** in `onMounted` (the
  `route.query.create === '1'` branch incl. the `router.replace` cleanup) — its only
  caller was retired in UC-IA-006 (resolved conflict #1). Cite by content, not line
  number (the plan's 53-63 has drifted; the block currently sits ~293-303).
- ⚠ **Do NOT touch `FriendPortalSession.vue`** — its "Prihlasovacie meno" label is
  pinned ~10× by `portal-profile-modal.spec.js` and belongs to module 03 (resolved
  conflict #2).
- The per-friend username/password menu actions and their endpoints are unchanged —
  they remain the manual credentials path for pre-existing friends.

**Acceptance criteria:** the friends table header and the modal label read "Meno";
grep for "prihlasovac" in `AdminFriends.vue` returns nothing; `/admin/friends?create=1&name=X`
opens the plain list with no modal; `portal-profile-modal.spec.js` passes unmodified.

---

## UC-IA-008 Verification — spec-impact obligations + procedure (Admin/Applicant)

**Goal:** how the implementing tasks prove this module correct. The obligations below
are carried verbatim from the plan's confirmed spec-impact analysis; they drive the
backlog.

**Numbered spec obligations:**

1. **`api-security.spec.js`:** `ADMIN_ENDPOINTS` += `POST /api/invitations/:id/approve`
   (the CLAUDE.md canonical-list rule — every new admin route joins the anonymous-401
   sweep).
2. **`guest-lead-capture.spec.js:538-565`:** pins the OLD "Vytvoriť" navigation-prefill
   — retarget it to the approval dialog, and **upgrade** it to also pin
   `onboarding_source === 'guest_order'` on the created friend (the provenance rule
   UC-IA-005 closes).
3. **`invite-register-shell.spec.js`:** `.field-lbl` count 3→4; extend the
   no-placeholder loop over the new input; the single-element `.field-help` assertion
   becomes strict-mode-ambiguous with the second help text — **scope it to the email
   field** rather than weakening it.
4. **`ios-input-zoom.spec.js`:** `.inp` count 3→4 in **BOTH** tests (phone + desktop).
5. **New `e2e/tests/invitation-approval.spec.js`:**
   - API: happy path asserting every friend column from UC-IA-005 + the invitation
     back-link; login with the temp password → `mustChangePassword: true`; taken
     username 409; invalid username 400; non-pending 409 (with `created_friend_id`);
     unknown id 404; register bounds incl. `{name:123}` → 400; **zero**
     `friend_subscriptions` and **zero** `transactions` rows for the new friend.
   - UI: dialog flow (prefills, approve), credentials block, copy button, the row
     leaving the pending list behind the open dialog.
   - **Fixtures per test, not a shared `beforeAll`** — Playwright restarts the worker
     after a failure and re-runs `beforeAll` (the GSO-T8 lesson).

Items 2–4 edit **pipeline-authored** spec files under case (a) of the e2e-immutability
rule (module 03 §UC-FL-013 amendment): this module *mandates* the behaviour/structure
changes that invalidate those assertions. Each edit re-points the assertion at the
mandated structure and protects the same property — never weakens it — and cites the
mandating UC in a code comment. All other pre-existing specs (notably
`portal-profile-modal.spec.js`) must pass **unchanged**.

**Procedure:**

1. `node --check` on every changed backend file (no unit runner exists; do not add one).
2. Local e2e recipe per CLAUDE.md: build frontend → `backend/public`; confirm port 3997
   free first; fresh `DB_PATH` + `e2e/seed.mjs`; `CORS_ORIGIN` incl. the gate's own
   origin; **all four** rate-limit env vars raised (the invite-code lookup and register
   sit on `abuseLimiter`). Targeted files first (`invitation-approval`,
   `invite-register-shell`, `ios-input-zoom`, `api-security`, `guest-lead-capture`),
   then the full suite piped to a file (never `| tail` — it returns tail's status).
3. Manual walkthrough: register with a username via a real `/invite/:code` link →
   approve in the dialog → copy credentials → log in with the temp password → forced
   change gate → new password works; the friend row shows the green credentials pill
   with the username.

---

## Accepted risks / follow-ups (recorded, not silently implemented)

- **Temp-password channel:** the plaintext travels via whatever channel the admin
  pastes it into (WhatsApp, mail, …). Accepted — bounded by `must_change_password`
  forcing a rotation on first login. **SMTP delivery is the phase-2 follow-up.**
- **No digit-normalised phone dedupe at approval** — the admin sees the invitation
  summary (incl. phone) in the dialog before approving; the register-time pending
  dedupe (`idx_invitations_phone_pending`) still holds. Accepted risk.
- **Two pending invitations may request the same username** — first approval wins; the
  second gets the editable inline 409 (UC-IA-006). Accepted by design.
- **`created_friend_id` has no FK** (UC-IA-001) — dangling after a hard friend delete;
  tolerated read-side, informational only.
- **TODO (product owner, 2026-08-13): retire the legacy shared-password mode.** "Portal
  does not use shared password anymore. This feature can be removed." — i.e. remove the
  `auth_mode = 'legacy'`/`'transition'` machinery (shared-password auth branch,
  login-list dropdown, the AdminInvitations amber banner, the legacy login card).
  Deliberately NOT in this module's scope — it is its own effort with its own spec
  impact (multiple shipped specs pin legacy behavior). Matches the pre-existing
  "retire shared password (auth_mode=modern)" follow-up in the project memory.
- ~~`OPEN:` final Slovak copy~~ — RESOLVED 2026-08-13: both strings signed by the
  product owner (clipboard message verbatim in UC-IA-006, ty-form by explicit choice;
  legacy warning dropped entirely).
- **CLAUDE.md staleness:** the 2026-07-07 "Invitation → new friend flow" note describes
  the retired `?create=1` path — supersede it when this module lands.

---

## Follow-ups discovered during implementation (IA-T1..T5, not in this module's scope)

Each was found by a review or e2e pass, judged out of scope, and left unfixed
deliberately. They are recorded here so they are not re-discovered from scratch.

1. **Global 500 on an unparsable JSON body** (found in IA-T2). `-d 'null'` or `-d '"hi"'`
   returns `500` from the global handler in `backend/src/index.js` — body-parser rejects
   before any route, so it reproduces identically on `/api/admin/login` and
   `/api/friends/auth`. Fix = translate `err.type === 'entity.parse.failed'` / `err.status`
   to 400 in the global error handler. App-wide, so it needs its own row.
2. **`AdminFriends.vue`'s reset-password placeholder says "Minimálne 4 znaky"** while
   `resetPassword()` rejects anything under 8 (found in IA-T5 review). The same
   copy-vs-behaviour lie this module was opened to remove, on the same screen.
3. **The "Prihlásenie" badge reads `friend.username || 'Nastavené'`**, so a friend with a
   `password_hash` but no `username` displays as credentialed while being unable to log in
   under modern auth (found in IA-T5 review). Pre-existing; reachable via the per-friend
   "Resetovať heslo" action on a friend who never got a username.
4. **SMTP delivery of the credentials** — the phase-2 half of §UC-IA-006's copy button,
   already recorded in §Accepted risks. Needs a mail dependency + env plumbing; the repo
   has no mailer today.
5. **Retire the legacy shared-password mode** — recorded in §Accepted risks from the
   product owner's 2026-08-13 decision ("Portal does not use shared password anymore").
   Its own effort: multiple shipped specs pin legacy behaviour.
