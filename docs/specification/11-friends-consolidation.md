# 11 — Friends consolidation (canonical field set)

> Scope: Consolidation of the `friends` table's admin-facing field set to the canonical
> seven fields the product owner named (2026-08-14): Meno a priezvisko (`name`),
> užívateľské meno (`username`), password STATE (`password_hash` + `must_change_password`
> — never a visible value), Google auth on/off (derived from `friends.google_sub`, column
> OWNED by module 10), mobil (`phone`), e-mail (`email`), admin note (`display_name`).
> This is an information-architecture consolidation of the ADMIN surface —
> `AdminFriends.vue` (table + modal), the `friends.js` admin routes' request/response
> shapes, and one admin-side unlink-Google action — plus backend validation hardening.
> **Relabel/reconcile only: no new columns (module 10 owns the Google columns), no column
> drops, no destructive migration.** The admin app stays on the current shadcn skin — no
> Podpultovka re-skin (01-architecture §Design system scope rule).
> Out of scope (handoffs): **friend-side profile editing** — the "Upraviť profil" modal
> (`FriendPortalSession.vue`, module 03 §UC-FL-009) including its pinned "Prihlasovacie
> meno" label and the `PATCH /friends/:id/profile` backend message that serves it;
> **friend-side Google link/unlink and the `google_*` schema** — module 10 (UC-GA);
> **magic-link recovery itself** — module 09 (UC-ML; this module only makes a missing
> `email` VISIBLE, since it blocks that recovery path); **the invitation → friend approval
> flow** — module 07 (this module owns where the approved data lands and is edited
> afterwards); **transactional e-mail** — module 08 (UC-EM).
> Actors: **Admin** — sole operator of every surface in this module; sees all friend data
> except stripped credential material. **Friend** — context only: their row is what is
> being consolidated; they never see these screens. (Module 10's Applicant/Friend Google
> flows are referenced as seams, not specified here.)
> Sources: product-owner brief 2026-08-14 (verbatim: "consolidation of friends table —
> each friend should have at least these fields: 'Name and Surname', 'username',
> 'password', 'google-auth on/off', 'mobile phone', 'email', 'note - entered by admin'");
> `00-overview.md` §Scope extension (confirmed field mapping: `name` → "Meno a
> priezvisko", `display_name` = admin note, no destructive migration);
> `01-architecture.md` §Auth extensions (module 10's `google_sub`/`google_email`/
> `google_prompt_dismissed` columns — consumed as a seam); `07-invitation-approval.md`
> (§UC-IA-007 relabel history, §Follow-ups #2 and #3 — both folded in here); repo
> `CLAUDE.md` ("Pending Invitations Dashboard Alert + Prefill" superseded bullets — the
> field-mapping history and the `prihlasovac`-grep guard; GSO-T3 bounded-inputs
> precedent); repo code (`backend/src/db/schema.js` friends migrations,
> `backend/src/routes/friends.js`, `backend/src/helpers/friend-create.js`,
> `frontend/src/views/AdminFriends.vue`, `frontend/src/api.js`); shipped e2e specs
> (`admin-friends-labels.spec.js`, `invitation-approval.spec.js`, `api-security.spec.js`).
> The most recent decision wins on conflict.
> **Design reference:** no prototype screen exists for the admin app. `AdminFriends.vue`
> keeps its current shadcn Table/Dialog composition; this module changes labels, columns
> and data shape, not the visual language.

---

## Resolved conflicts (recency / canonicity)

1. **Phone label is "Mobil", not "Telefón", on the admin surface.** The brief says
   "mobile phone" and 00-overview's module-11 row (2026-08-14, newest) names the field
   "mobil (`phone`)"; the current AdminFriends label "Telefón" loses. The `/invite/:code`
   form's "Telefón" is module 07's surface and **stays** — a label divergence across
   surfaces is accepted, the column (`friends.phone`) is one and the same.
2. **Email label stays "Email".** 00-overview's prose spells "e-mail", but that is prose,
   not label copy; every shipped surface (AdminFriends, InviteRegister, AdminInvitations)
   says "Email". Consistency with shipped copy wins over prose orthography.
3. **`hasCredentials` keeps its API meaning `!!password_hash`.** 07 follow-up #3 recorded
   that the "Prihlásenie" badge lies for a friend with a password but no username. The
   fix here is presentation-side: the truthful three-state rendering (UC-FC-002) is
   derived in the view from `username` + `hasCredentials`, which the admin list already
   returns — the boolean's semantics do NOT move, because `login-list` and the friend
   profile also consume it and module 03's surfaces pin it.
4. **The reset-password placeholder "Minimálne 4 znaky" is corrected here** (07
   follow-up #2 — the same copy-vs-behaviour lie on the same screen this module
   consolidates). `resetPassword()` enforces ≥ 8; the copy follows (UC-FC-003).
5. **The name column stays `friends.name`** — the "Name and Surname" field in the brief
   is the EXISTING column relabelled, never a new `full_name` column (00-overview
   confirmed decision). The data-cleanup pass is **manual, via the relabelled surface**:
   existing values that are nicknames get corrected by the admin by hand; no automated
   rewrite of `name` values ships (that would be the destructive migration the decision
   forbids).

---

## UC-FC-001 Canonical field set + column mapping (system)

**Goal:** one authoritative mapping from the product owner's seven fields to columns,
labels and owners — the reference every other UC in this module renders from.

| Brief field | Column(s) | Slovak label (admin) | Required | Writable where | Notes |
|---|---|---|---|---|---|
| Name and Surname | `friends.name` | **Meno a priezvisko** | yes | AdminFriends modal; friend profile (module 03) | Display label shown to admin + colleagues. **Never a login** (07 §UC-IA-007 history). Relabel of the current "Meno". |
| username | `friends.username` | Užívateľské meno | no (nullable) | per-row "Nastaviť username" (`PUT /:id/admin-username`); approve dialog (07 §UC-IA-005); friend setup-credentials | UNIQUE partial index `idx_friends_username`. Rendered in the "Prihlásenie" column. |
| password | `friends.password_hash` + `friends.must_change_password` | Heslo — **state only** | — | per-row "Resetovať heslo" (`PUT /:id/reset-password`); friend change-password; approve dialog | Plaintext is never displayed after the one-time approve/reset dialog (07's rule). Admin sees derived state, never a value. |
| google-auth on/off | `friends.google_sub` (+ `google_email`) — **columns owned by module 10** | Google | — | link/unlink: module 10 (friend-side); UC-FC-006 (admin unlink) | READ-ONLY state here, derived as `google_sub IS NOT NULL`. Graceful when the column has not shipped (UC-FC-005). |
| mobile phone | `friends.phone` | **Mobil** | no | AdminFriends modal | Free-form text, length-bounded only (resolved conflict #1). |
| email | `friends.email` | Email | no | AdminFriends modal | Lenient `@` check only. ⚠ Its ABSENCE blocks module 09's magic-link recovery — must be visible in the table (UC-FC-002). |
| note — entered by admin | `friends.display_name` | Poznámka | no | AdminFriends modal | Internal admin note; never shown to the friend. IS the existing column — despite its misleading name, `display_name` has been the note since the "Ivet a Peto" migration comment. |

**Business rules:**

- **No schema change in this module.** Every mapping above targets an existing column;
  the Google columns arrive with module 10 and are only *consumed* here.
- **Legacy dead-weight columns stay:** `cycle_id` (NOT NULL FK, satisfied via
  `getPlaceholderCycleId()` — `helpers/friend-create.js`, never re-inline), `access_token`
  (UNIQUE NOT NULL, still populated at insert for backwards compatibility), `uid`
  (immutable system id, shown read-only), `is_root`/`root_friend_id` (rewards grouping,
  GSO-T9 rules apply), `invite_code` (stripped from every response), `onboarding_source`
  (provenance, read-only badge), `packeta_address` (friend-owned, module 03),
  `created_at`, `active`. **Do not spec or perform their removal** — `access_token` is
  NOT NULL so removal is not trivially safe; recorded as accepted dead weight.
- **No column may serve two fields.** The historical bug this module descends from was
  `name` moonlighting as a login; after this module each brief field has exactly one
  column and each admin-editable column exactly one label.

**Acceptance criteria:** the mapping table above is reflected 1:1 by UC-FC-002/003's
surfaces; a schema diff for this module's implementation shows zero `ALTER TABLE
friends` statements.

---

## UC-FC-002 AdminFriends table — consolidated columns (Admin)

**Goal:** the friends table shows every canonical field's state at a glance, truthfully.

**Column set (left to right):**

| Header | Content |
|---|---|
| ID | `uid`, mono, `-` fallback (unchanged) |
| **Meno a priezvisko** | `name` + the existing `onboarding_source` outline badge (unchanged behaviour, relabelled header — was "Meno") |
| Poznámka | `display_name` or `-` (unchanged) |
| Kontakt | **new** — email on the first line (small text); when `email` is NULL/empty, an **amber outline badge "Bez e-mailu"** replaces it (⚠ seam: a missing email blocks module 09's magic-link recovery — this badge is the admin's visibility into that). `phone` on a second, muted line when present. |
| Zostatok | `BalanceBadge` (unchanged) |
| Stav | active Switch + badge (unchanged) |
| Prihlásenie | credential state, **three states** (below). Header name KEPT — it reports real credential state and makes no claim about the name field (the `admin-friends-labels.spec.js` deliberate-keep assertion). |
| Google | **new** — read-only. Linked (`googleLinked === true`, UC-FC-005): green outline badge showing `google_email` when present, else "Prepojené". Not linked OR column not shipped: muted `-` — the two are rendered identically, by design (graceful degradation). |
| Káva / Pekáreň | subscription checkboxes (unchanged) |
| Akcie | row menu (unchanged actions + UC-FC-006's "Odpojiť Google" when linked) |

**The three credential states (fixes 07 follow-up #3):**

Derived in the view from fields the admin list already returns (`username`,
`hasCredentials = !!password_hash`, `must_change_password` — all present via `SELECT f.*`
after `sanitizeFriend`; no backend change for this half, resolved conflict #3):

1. **Full** — `username && hasCredentials`: green outline badge with the username
   (current rendering). When `must_change_password` is set, an additional small amber
   text **"dočasné heslo"** under the badge — the admin can see who never completed
   their forced change.
2. **Partial** — `hasCredentials && !username` (password reset on a friend who never got
   a username — the exact 07 follow-up #3 repro) OR `username && !hasCredentials`:
   **amber outline badge "Neúplné"** with a `title` naming the missing half ("chýba
   užívateľské meno" / "chýba heslo"). ⚠ The old rendering (`username || 'Nastavené'`,
   green) displayed the first case as credentialed while the friend could not log in
   under modern auth — that lie is what this state retires.
3. **None** — neither: muted `-` (unchanged).

**Business rules:**

- The header relabel "Meno" → "Meno a priezvisko" carries the manual data-cleanup pass
  (resolved conflict #5): the surface is the cleanup tool, there is no migration.
- No string anywhere in `AdminFriends.vue` may claim the name field is used for login —
  the standing 07 §UC-IA-007 rule; testable as `grep -i prihlasovac
  frontend/src/views/AdminFriends.vue` returning nothing (the "Prihlásenie" header does
  not match that pattern and is the one legitimate login-related string).
- Admin skin: shadcn Table/Badge as shipped; no `neo/` classes, no theme tokens.

**Acceptance criteria:** the header row reads "Meno a priezvisko", "Kontakt", "Google";
a seeded friend with a password but no username renders the amber "Neúplné" badge, never
the green one; a friend with `must_change_password = 1` shows "dočasné heslo"; a friend
without an email shows "Bez e-mailu"; a DB without the `google_sub` column renders the
Google column as `-` on every row with zero console errors.

---

## UC-FC-003 AdminFriends modal — consolidated fields (Admin)

**Goal:** the add/edit modal edits exactly the four admin-writable fields, correctly
labelled, bounded, with hints that tell the truth.

**Field group (writable):**

| Field | Label | Required | Input constraints | Hint (`text-xs text-muted-foreground`) |
|---|---|---|---|---|
| `name` | **Meno a priezvisko *** | yes | `maxlength="120"` | **"Celé meno. Vidí ho správca a kolegovia; na prihlásenie slúži užívateľské meno."** (⚠ deliberately avoids the substring "prihlasovac" — "prihlásenie" does not match the grep guard; verify before shipping any rewording) |
| `display_name` | Poznámka (voliteľné) | no | `maxlength="200"` | "Interná poznámka pre admina (nezobrazuje sa priateľovi)" — unchanged |
| `phone` | **Mobil** | no | `maxlength="32"`, keep the `+421 900 000 000` placeholder | — |
| `email` | Email | no | `type="email"`, `maxlength="160"` | **"Bez e-mailu sa priateľovi nedá poslať odkaz na obnovenie prístupu."** (module 09 seam, phrased without module jargon and without the guarded substring) |

`maxlength` values mirror UC-FC-004's server bounds (the GSO-T3 mirror convention).

**Read-only blocks (edit mode only, unchanged where they exist today):**

- Jedinečné ID (`uid`, mono) — existing.
- Pôvod onboardingu (`onboarding_source`) — existing.
- **New: Prihlásenie** — one read-only line rendering the same three-state derivation as
  UC-FC-002 (full: username; partial: "Neúplné — …"; none: "Nenastavené"), followed by
  the pointer copy **"Spravuje sa cez akcie Nastaviť username / Resetovať heslo."** The
  modal itself contains NO credential inputs — creating or editing a friend here never
  touches `username`/`password_hash` (the standing rule from CLAUDE.md / 07: a friend
  gets a login only via approval or the per-row actions).
- **New: Google** — read-only line matching the table's rendering; omitted entirely when
  not linked/not shipped (no empty label).

**Adjacent copy fixes on the same screen (folded-in 07 follow-ups):**

- Reset-password modal placeholder **"Minimálne 4 znaky" → "Minimálne 8 znakov"**
  (resolved conflict #4; `resetPassword()` client check and the server both enforce ≥ 8).
- The reset-password and set-username modals are otherwise unchanged — they remain the
  manual credentials path.

**Business rules:**

- Save behaviour unchanged: `name` required (button disabled while blank), other fields
  trim-to-null. ~~Errors from UC-FC-004 render via the existing error `Alert`.~~
  **AMENDED (FC-T2 review, 2026-08-15):** save errors render in a dedicated
  **in-dialog Alert** (`modalError`) — the radix overlay hides the page-level
  `Alert`, so the original letter would render errors invisibly (the FriendPortal
  suppressed-shared-`error` precedent). `error` keeps its non-modal writers
  (load/toggle/delete); nothing writes both. Do not "fix" the code back to the
  page-level Alert.
- ⚠ `@keyup.enter` on these inputs predates the 07 keydown lesson but these dialogs are
  opened by pointer, not by an Enter-activated button, and the action is a non-destructive
  save — leave as-is; do NOT copy this pattern into any dialog that can open via Enter.

**Acceptance criteria:** the modal shows exactly 4 writable fields labelled per the
table; each input's `maxlength` matches the server bound; edit mode shows the read-only
Prihlásenie line; `grep -i prihlasovac frontend/src/views/AdminFriends.vue` returns
nothing; the reset-password placeholder reads "Minimálne 8 znakov".

---

## UC-FC-004 Backend — `POST /api/friends` + `PATCH /api/friends/:id` hardening (Admin)

**Goal:** the two admin write routes stop 500-ing on malformed bodies and enforce the
bounds the UI mirrors — the UC-IA-003 hardening pattern applied to `friends.js`.

**Business rules (both routes unless stated):**

- **Type guards:** `name`, `display_name`, `phone`, `email` must each be a string when
  present — any non-string (number, object, array, boolean) ⇒ **400**, never a 500 from
  `.trim()` on a non-string. (Today `POST` with `{email: 123}` throws — `123` is truthy,
  `.trim()` is not a function.) `active` keeps its existing truthy coercion.
- **Length bounds (after trim):** `name` ≤ **120**, `phone` ≤ **32**, `email` ≤ **160**
  (the GSO-T3 / UC-IA-003 constants — one convention across invitations, guests and
  friends), `display_name` ≤ **200** (new constant; the note field had no precedent —
  bound chosen to match the modal's practical size). Local constants in `friends.js`;
  ⚠ do NOT import guest.js's `validateIdentity` (module-private, pinned to the GSO-T3
  money path).
- **Errors:** 400 with a Slovak message + a `field` marker (the guest.js contract), e.g.
  `{ error: 'Meno a priezvisko je povinné', field: 'name' }`.
- **`name` required, both routes:** `POST` without a non-empty trimmed `name` ⇒ 400
  (message relabelled from the current `'Prihlasovacie meno je povinné'` — the last
  backend string claiming this field is a login on the ADMIN path). `PATCH` with
  `name` present but empty after trim ⇒ **400** (today it silently writes `''`,
  blanking the display name of every list the friend appears in). `name` absent from a
  PATCH body ⇒ untouched, as today.
- **Email leniency stays:** the existing `includes('@')` check, nothing stricter
  (confirmed: format leniency is deliberate — the field is admin-entered contact data,
  not a deliverability guarantee; module 08/09 surface real bounces operationally).
  Phone gets NO format validation — length only.
- ⚠ **Do NOT touch `PATCH /friends/:id/profile`** (line ~552's
  `'Prihlasovacie meno je povinné'` message): it serves `FriendPortalSession.vue`'s
  pinned label and belongs to module 03. Only the admin route's message is relabelled.
- Everything else preserved verbatim: `requireAdmin`, uid/invite-code collision loops,
  `getPlaceholderCycleId()`, `access_token = nanoid(12)`, session invalidation on
  deactivate, the 201/200 `sanitizeFriend` responses.
- `POST /api/friends` **still sets no credentials** — approval (07) and the per-row
  actions are the only credential mints. This is a rule, not an omission.

**Acceptance criteria:** `POST {name:123}` ⇒ 400 `field:'name'`; `POST` with a 200-char
name ⇒ 400 `field:'name'`; `PATCH {email:{}}` ⇒ 400 `field:'email'`; `PATCH {name:'  '}`
⇒ 400 and the row's name is unchanged; a valid `POST` still creates a friend with
`username`/`password_hash` NULL; the 400 message for a missing name no longer contains
"Prihlasovacie".

---

## UC-FC-005 Response invariants — stripping + Google state derivation (system)

**Goal:** the consolidation widens what the admin *sees* without widening what leaves
the server.

**Business rules:**

- **`sanitizeFriend()` in `friends.js` stays the ONE home for response stripping.**
  `password_hash`, `access_token`, `invite_code` never leave the server on any friend
  response — unchanged invariant, now pinned by this module's e2e (raw-text regex over
  the full response body, the UC-IA-005 pattern, catching a future `SELECT *` leak).
- **`google_sub` joins the strip list now** (a no-op delete until module 10 adds the
  column — deleting an absent key is harmless). The raw Google subject is an identity
  key, not display data; nothing client-side needs it.
- **Server-derived boolean:** `GET /api/friends` (admin list) and
  `GET /api/friends/:id/detail` attach **`googleLinked = !!row.google_sub`** (computed
  BEFORE the strip) and pass `google_email` through untouched (display-only per
  01-architecture §Auth extensions). On a DB where module 10's migration has not run,
  `row.google_sub` is `undefined` ⇒ `googleLinked: false` and `google_email` absent —
  the same code path, no feature flag, no error. This is the graceful-rendering
  mechanism UC-FC-002 keys on.
- ⚠ **Seam to module 10:** module 10's own login/link endpoints must apply the SAME
  strip rule (`google_sub` never in a response body) — recorded here because this module
  ships the rule first; module 10 inherits it, not the other way around.
- `hasCredentials` stays `!!password_hash` (resolved conflict #3);
  `must_change_password` continues to ship on admin responses (it is state, not
  credential material — it is what the "dočasné heslo" marker renders from).

**Acceptance criteria:** the full JSON of `GET /api/friends` and `/:id/detail` matches
`/(password_hash|access_token|invite_code|google_sub)/` zero times; every row carries a
boolean `googleLinked`; against a pre-module-10 DB the endpoints return 200 with
`googleLinked: false` throughout.

---

## UC-FC-006 Admin unlink Google (Admin) — `[!]` blocked on module 10 schema

**Goal:** the admin can sever a friend's Google link (support case: friend lost the
Google account, wrong account linked, offboarding). The friend-side link/unlink UX
belongs to module 10 — this is the admin-surface counterpart only.

**Route contract:**

- `DELETE /api/friends/:id/google`, guarded by **`requireAdmin`**. ⚠ MUST be added to
  the canonical anonymous-401 list `ADMIN_ENDPOINTS` in `e2e/tests/api-security.spec.js`
  (the standing CLAUDE.md rule).
- **404** — unknown friend id.
- **200, idempotent** — sets `google_sub = NULL`, `google_email = NULL`. Calling it on a
  friend who is not linked converges on the requested end state and returns 200 (the
  GSO-T5 DELETE precedent), never a 409.
- **RESOLVED by module 10:** unlink does **NOT** reset `google_prompt_dismissed` — the
  friend said "už sa nepýtať" and an admin action doesn't override that; the manual
  profile-modal link (UC-GA-007) remains the friend's way back in. This UC follows
  10's rule: the DELETE touches `google_sub`/`google_email` only.
- No session invalidation: the Google link is a login *method*, not the session — an
  existing session stays valid, matching how `admin-username` changes behave differently
  (those DO invalidate) because a username change orphans the credential the session was
  minted against, while unlink leaves password auth intact.

**UI (`AdminFriends.vue` row menu):**

- Menu item **"Odpojiť Google"**, rendered ONLY when `googleLinked` (so a pre-module-10
  deployment never shows it — the gating is data-driven, not a feature flag).
- `confirm()` before the call. When the friend has NO password (`!hasCredentials`), the
  confirm text must additionally warn that the friend will have no way to log in until
  the admin resets a password — the endpoint still allows it (admin authority; the
  recovery path is the existing reset), the warning is the guard.

**Dependency:** `[!]` this UC cannot land before module 10's schema UC (**UC-GA-001**)
creates `friends.google_sub`/`google_email` — the UPDATE would fail on missing columns. The rest
of this module (UC-FC-001..005, 007) has no module-10 dependency and ships first;
UC-FC-002/005's rendering half is deliberately built to be correct in both worlds.

**Acceptance criteria:** anonymous `DELETE /api/friends/:id/google` ⇒ 401 via the
api-security sweep; unlinking a linked friend nulls both columns (verified by re-reading
the row, not the response) and a second call returns 200; the menu item is absent for an
unlinked friend; the no-password confirm warning appears for a friend without
`hasCredentials`.

---

## UC-FC-007 Interplay with invitations — where approved data lands (Admin)

**Goal:** the seam with module 07 stated from this side: approval writes, this module
edits.

**Business rules:**

- `POST /api/invitations/:id/approve` (07 §UC-IA-005) writes `name`, `phone`, `email`,
  `username`, `password_hash`, `must_change_password = 1`, `display_name` (the admin's
  note) onto the friend row. **From that moment the friend row is the single source of
  truth** — AdminFriends edits it via this module's surfaces.
- **No back-propagation:** editing a friend NEVER writes to the `invitations` row. The
  invitation (incl. its `username` request and `admin_note`) is the frozen historical
  record; `created_friend_id` is the informational back-link (07 §UC-IA-001, no FK,
  tolerate dangling).
- The consolidated modal's fields correspond 1:1 to what approval prefilled — an admin
  correcting a typo in an approved applicant's name/phone/email does it in AdminFriends,
  not by re-approving.
- The `onboarding_source` badge ('invitation' / 'guest_order' / onboarding-link note) is
  read-only provenance on this surface — no UC may make it editable.

**Acceptance criteria:** after an approval, editing the created friend's name/phone/email
in AdminFriends changes the friend row and leaves the invitation row byte-identical
(status, username, admin_note, created_friend_id all unchanged).

---

## UC-FC-008 Verification — spec-impact obligations + procedure (Admin)

**Goal:** how the implementing tasks prove this module correct. No unit-test runner
exists (01-architecture §Testing) — the bar is Playwright e2e + `node --check`.

**Numbered spec obligations:**

1. **`admin-friends-labels.spec.js` — retarget, do not weaken.** It pins the header as
   exact `'Meno'` and the modal label as exact `'Meno *'`; this module MANDATES the
   relabel to "Meno a priezvisko" / "Meno a priezvisko *", so both assertions are
   re-pointed (e2e-immutability case (a); cite this UC in a code comment). The
   properties it protects survive unweakened: the `/Prihlasovacie/i` **absence**
   assertions (header, modal, whole page) and the deliberate-keep `'Prihlásenie'`
   header assertion stay verbatim.
2. **`api-security.spec.js`:** `ADMIN_ENDPOINTS` += `DELETE /api/friends/:id/google`
   (with UC-FC-006's task, not before the route exists).
3. **`invitation-approval.spec.js` must pass unchanged** — it creates friends via
   `POST /api/friends` with valid string names and asserts approval-side columns; none
   of this module's guards touch its inputs.
4. **New `e2e/tests/friends-consolidation.spec.js`:**
   - API: type guards (`POST {name:123}` ⇒ 400; `PATCH {email:{}}` ⇒ 400 `field`
     markers); bounds (121-char name, 33-char phone, 161-char email, 201-char note each
     ⇒ 400); `PATCH {name:'  '}` ⇒ 400 with the row unchanged; the stripping regex of
     UC-FC-005 on `GET /` and `/:id/detail`; `googleLinked: false` present on every row
     of a pre-module-10 DB.
   - UI: header set incl. "Meno a priezvisko"/"Kontakt"/"Google"; the three credential
     states (seed the partial state via `reset-password` on a friend with no username —
     the 07 follow-up #3 repro); "dočasné heslo" marker; "Bez e-mailu" badge for a
     friend without email and its absence for one with; modal labels + `maxlength`
     mirror; "Minimálne 8 znakov" placeholder.
   - **Fixtures per test, not a shared `beforeAll`** (the GSO-T8 worker-restart lesson);
     any UI admin login must adopt the browser's token if mixed with API `admin()` calls
     (there is exactly ONE admin token app-wide — the IA harness trap).
5. **Implementer gate (not e2e):** `grep -i prihlasovac frontend/src/views/AdminFriends.vue`
   returns nothing — run it after every copy change in this file, including the new hints
   (UC-FC-003 chose its wording specifically to pass it).
6. UC-FC-006's task adds unlink API + UI tests per its acceptance criteria, gated on
   module 10's schema task having landed.

**Procedure:** `node --check` on changed backend files; local e2e recipe per CLAUDE.md
(build → `backend/public`, free port, fresh `DB_PATH` + `e2e/seed.mjs`, `CORS_ORIGIN`
incl. the gate's origin, **all four** rate-limit env vars raised, output to a file —
never `| tail`); targeted files first (`friends-consolidation`, `admin-friends-labels`,
`invitation-approval`, `api-security`), then the full suite.

---

## UC-FC-009 Friend self-edit of Mobil + Email in the portal profile modal (Friend)

Sources: product-owner decision 2026-08-15 (resolving this module's OPEN item: "Yes,
friends edit both"); `FriendPortalSession.vue` "Upraviť profil" modal;
`PATCH /api/friends/:id/profile` (module 03 §UC-FL surface); UC-FC-004 bounds.

**Goal:** friends keep their own contact data fresh — and can unblock their own
magic-link recovery (module 09's prerequisite) without asking the admin.

- The **"Upraviť profil"** modal (`FriendPortalSession.vue`) gains two fields under the
  existing `packeta_address` one: **Mobil** (`maxlength="32"`, placeholder
  `+421 900 000 000`) and **Email** (`type="email"`, `maxlength="160"`, field-help
  **"Bez e-mailu vám nevieme poslať odkaz na obnovenie prístupu."** — vy-form variant of
  UC-FC-003's admin hint). Podpultovka skin, no placeholder on Email (the 2026-08-10
  no-placeholder login decision; Mobil keeps its format-example placeholder as the admin
  modal does — a format example, not a label substitute).
- `PATCH /api/friends/:id/profile` accepts `phone` and `email` with **UC-FC-004's exact
  bounds and type guards** (trim; ≤ 32 / ≤ 160; email `@`-leniency; non-string → 400
  with `field` marker). Ownership enforcement unchanged (`requireFriendOwner` — a friend
  edits only their own row). Both nullable: clearing a field is allowed (⚠ clearing
  email removes the recovery path — no confirm required, the admin badge in UC-FC-002
  is the operational signal).
- The admin remains able to edit both (UC-FC-003); **last write wins**, no locking —
  same as `packeta_address` today.
- ⚠ Any new friend-authenticated fetch here obeys the existing session-boundary rules
  (`FriendPortalSession.vue` is keyed on the auth handshake — modal state must not leak
  across friends; the six-leak history in CLAUDE.md is the cautionary source).

**Acceptance criteria (e2e):** friend logs in → opens Upraviť profil → sets email →
admin's AdminFriends row loses the "Bez e-mailu" badge; bounds rejected with 400 +
Slovak message; friend A cannot PATCH friend B's profile (existing ownership spec
extended to the new fields); clearing the email restores the badge.

---

## Accepted risks / follow-ups (recorded, not silently implemented)

- **Legacy dead columns stay** (`cycle_id`, `access_token`, unused width) — removal is
  not trivially safe (NOT NULL constraints, insert paths); accepted dead weight
  (UC-FC-001).
- **Email leniency** (`includes('@')`) accepted — real deliverability surfaces via
  module 08's send outcomes, not input validation.
- ~~OPEN: may friends edit their own phone/email in the portal profile modal?~~ —
  **RESOLVED (product owner, 2026-08-15): YES, both fields.** Specified as **UC-FC-009**
  above (profile modal + `PATCH /friends/:id/profile` with UC-FC-004's bounds).
- ~~OPEN (UC-FC-006): `google_prompt_dismissed` reset on admin unlink~~ — **RESOLVED**:
  module 10 decided NO reset (see UC-FC-006 and 10's §Decisions).
- **Global JSON-parse 500** (07 follow-up #1) — still reproduces on these routes with an
  unparsable body; app-wide fix, its own row, NOT this module's scope.
- **CLAUDE.md staleness on landing:** the "Pending Invitations Dashboard Alert +
  Prefill" superseded bullets describe the `Meno *` label this module renames again —
  supersede that note (and the `admin-friends-labels` description of exact-'Meno'
  assertions) when this module ships.
