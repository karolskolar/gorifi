# 09 — Magic-link recovery + remember-me session length

> Scope: The "Zabudli ste heslo?" recovery path and the re-semantics of "Zapamätať si ma
> na tomto zariadení": the `login_tokens` schema + token primitives, the public
> `POST /api/magic-link/request` endpoint (enumeration-safe), the magic-link e-mail
> built on module 08's `renderEmail`/`sendMail`/`resolveLoginUrl` seam, the `/magic/:token`
> frontend route + `POST /api/magic-link/redeem` endpoint, the
> `createFriendSession(friendId, { remember })` TTL change (24 h default / 60 days
> opt-in), the non-blocking "set a new password" prompt after a magic-link login (with
> the `currentPassword` waiver that makes it actually completable), and the token/session
> invalidation rules. **Passwords are preserved as the primary login — the link is a
> recovery/login path, not a reset ceremony** (product decision 2026-08-14, 00-overview
> §Scope extension). ⚠ Like 07/08 this module INCLUDES backend + schema changes.
> Out of scope (handoffs): the **e-mail rendering layer itself** (module 08 owns
> `renderEmail`/`sendMail` — a new need here becomes a new block type there, never a
> special case); the **forced-change gate** (module 03 §UC-FL-012 — this module only
> routes into it); **Google sign-in** on the same login card (module 10 — layout seam
> noted in UC-ML-006); **admin visibility of missing `friends.email`** (module 11 — the
> operational remedy when a friend has no e-mail on file, since this module's UI can
> never say so); the **legacy shared-password login card** (03 §UC-FL-003: not
> redesigned; the recovery affordance simply does not exist there); **guests** (untouched
> by modules 08–11 per 00-overview).
> Actors: **Friend** — requests the link on the login screen, clicks it in their inbox,
> is logged in, optionally sets a new password; vy-form, no gendered participle
> addresses them. **Admin** — no new surface in this module; appears only as the
> operational fallback (per-friend password reset, setting a friend's e-mail).
> **Operator** — no new pins; `PUBLIC_BASE_URL` (08 §UC-EM-004) already covers the
> magic-link URL's domain. **System** — the fire-and-forget mail send.
> Sources: user brief 2026-08-14 (verbatim: magic link on "Zabudol som heslo", e-mail
> prerequisite, passwords preserved, remember-me on this device) + product decisions
> confirmed 2026-08-14 (log-in + non-blocking prompt, not a forced reset;
> `must_change_password=1` forced flow wins; 24 h default / 60 d opt-in);
> `00-overview.md` §Scope extension + file index row 09; `01-architecture.md` §Auth
> extensions → Magic link + Remember me (the binding contract this file elaborates);
> `08-transactional-email.md` §Seam for module 09 (the e-mail foundation consumed here);
> `03-friend-login-portal.md` §UC-FL-002 (login card, remember-me row) + §UC-FL-012
> (forced-change gate); repo code (`backend/src/middleware/friend-auth.js` —
> `createFriendSession`, `validateFriendAuth`, the `must_change_password` waiver comment
> at `friends.js:192-200`; `backend/src/middleware/rate-limit.js` — the four-bucket
> rule; `backend/src/routes/friends.js` — `POST /friends/auth`, `change-password`,
> `setup-credentials`, `reset-password`; `backend/src/db/schema.js` — `friend_sessions`;
> `frontend/src/views/FriendPortal.vue` / `FriendPortalSession.vue`; `frontend/src/api.js`,
> `router.js`); shipped e2e (`modern-login.spec.js`, `portal-fidelity.spec.js`,
> `portal-profile-modal.spec.js`, `invitation-approval.spec.js`'s Mailgun stub harness);
> repo `CLAUDE.md`. The most recent decision wins on conflict.
> **Design reference:** no prototype screen exists for recovery (03 designed f-login
> only). The request form reuses the modern login card's own primitives (02:
> `.card`/`.field-lbl`/`.inp`/`.btn`, no placeholders per the 2026-08-10 decision, A12
> `.inp` rule); the `/magic/:token` page follows the `InviteRegister.vue` precedent
> (2026-08-12): 480 px branded column, centred g-dead-style composition for terminal
> states.

---

## Resolved conflicts (recency / canonicity)

1. **Remember-me = TTL, not storage** (01-architecture §Remember me, 2026-08-14 — wins
   over 03 §UC-FL-002's "localStorage written only when `rememberMe`" and over
   `modern-login.spec.js`'s "remember-me off keeps the session in memory only" test).
   The frontend writes `gorifi_friend_auth` to localStorage in **both** cases; the
   session TTL (24 h vs 60 d) is the mechanism. The in-memory-only fallback is retired
   (UC-ML-007). The two pinning tests are retargeted under case (a) of the
   e2e-immutability rule (UC-ML-010).
2. **The checkbox default flips to UNCHECKED.** 03 §UC-FL-002 says "`rememberMe`
   default stays `true`", and `modern-login.spec.js:214` pins `aria-checked="true"` at
   rest — but the 2026-08-14 product decision names 60 days "the **opt-in**" and 24 h
   "the default". A pre-checked box would make 60 days the effective default and the
   decision a dead letter. Newest decision wins: unchecked at rest (UC-ML-007); the two
   default-ON assertions are retargeted under case (a).
3. **The affordance label is NOT the brief's literal "Zabudol som heslo".** The brief's
   string is the *user describing the feature*, not signed UI copy; as a first-person
   masculine participle it would violate the register rule (01-architecture §i18n:
   never a gendered participle addressing the reader). Shipped label: **"Zabudli ste
   heslo?"** (vy-form, gender-neutral). All new Slovak copy in this module is proposed,
   not signed — see the consolidated `OPEN:` in UC-ML-006.
4. **Magic link is a LOGIN, not a reset** (product decision 2026-08-14). The old
   password keeps working unless the friend changes it; the post-login prompt is
   non-blocking and dismissible. Exception, confirmed: an account already carrying
   `must_change_password = 1` keeps its **forced** flow — the link logs the friend in
   and the existing forced password-set gate (03 §UC-FL-012) appears exactly as it
   would after a password login; the non-blocking prompt is suppressed (UC-ML-005/008).
5. **"Mints a normal `friend_sessions` row" (01) vs the prompt's need to know how the
   session was born.** Resolved by a provenance column, not a parallel session type:
   `friend_sessions.via` (UC-ML-001) — the row stays normal (same token, same
   `expires_at` semantics, same `validateFriendAuth` path); `via` only feeds the
   `currentPassword` waiver (UC-ML-008), on the exact justification the code already
   uses for `must_change_password` (`friends.js:192-195`: "the valid session token
   already proves the friend just authenticated" — here it proves control of the
   account's e-mail, which is the recovery trust anchor).

---

## UC-ML-001 Schema — `login_tokens`, `friend_sessions.via`, token primitives (system)

**Goal:** the storage and crypto primitives, in `backend/src/db/schema.js`, exactly per
01-architecture's contract.

**Business rules:**

- New table (CREATE TABLE IF NOT EXISTS, the house pattern):

  ```sql
  CREATE TABLE IF NOT EXISTS login_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    friend_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,   -- ms epoch, mirrors friend_sessions.expires_at
    used_at INTEGER,               -- ms epoch, NULL = outstanding
    created_at INTEGER NOT NULL,   -- ms epoch (cooldown math, UC-ML-003)
    FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE
  )
  ```

  `created_at` deviates from `friend_sessions`' `DATETIME DEFAULT CURRENT_TIMESTAMP`
  deliberately: the per-friend cooldown (UC-ML-003) compares in ms, and second-resolution
  timestamps are the documented tiebreak trap (CLAUDE.md GSO-T8). The CASCADE relies on
  `foreign_keys = ON` as already established (GSO-T9 precedent).
- Migration: `ALTER TABLE friend_sessions ADD COLUMN via TEXT` via the try/catch
  pattern. NULL (default, and every pre-existing row) = password-or-legacy session;
  `'magic_link'` = minted by UC-ML-005. No other value in this module (module 10 may
  add `'google'` — its decision).
- **Raw token:** `crypto.randomBytes(32).toString('hex')` — 64 lowercase hex chars,
  256-bit. Exists in exactly two places, ever: the URL inside the outbound e-mail and,
  transiently, the redeeming request body. **Never persisted raw, never logged, never
  in any API response** (the temp-password discipline, 07 §UC-IA-005).
- **At rest:** `token_hash = sha256(rawToken)` hex, via `node:crypto`
  `createHash('sha256')`. SHA-256, NOT bcrypt — the input is already 256-bit random, a
  slow hash buys nothing (01-architecture, verbatim). Lookups are by `token_hash` only.
- **TTL: 15 minutes** (`expires_at = Date.now() + 15*60*1000`). A module-level constant,
  not env-tunable (nothing in the sources asks for tunability; the e2e manufactures
  expiry by writing the row, not by shrinking the TTL — UC-ML-010).
- SEC-S2 note: `crypto.randomBytes` is already the house RNG for session tokens
  (`friend-auth.js:15`); this reuses that call, it does not add a second RNG concept.

**Acceptance criteria:** backend restart on an existing DB creates the table and adds
`via` without error, idempotently; a generated raw token matches `/^[a-f0-9]{64}$/`;
the stored `token_hash` differs from the raw token and equals its SHA-256.

---

## UC-ML-002 `createFriendSession(friendId, { remember })` — the TTL split (system)

**Goal:** the 30-day flat session becomes 24 h default / 60 days opt-in, with every
existing mint site accounted for. No schema change (01-architecture: `expires_at`
already exists).

**Business rules:**

- Signature grows an options argument: `createFriendSession(friendId, opts = {})`.
  - `opts.remember === true` ⇒ TTL **60 days**.
  - otherwise ⇒ TTL **24 hours** (the new default; the 30-day constant is retired).
  - `opts.expiresAt` (ms epoch) ⇒ use that exact expiry — the re-mint carry-over below.
  - `opts.via` (string) ⇒ written to the new `via` column; NULL when absent.
- **Mint-site inventory** (every caller must be visited; this list is the checklist):
  1. `POST /friends/auth` — both branches (personal + legacy shared-password) pass
     `{ remember: req.body.remember === true }`. Strict boolean check — a truthy string
     `"false"` must not buy 60 days.
  2. `POST /friends/:id/setup-credentials` and `PUT /friends/:id/change-password` —
     these invalidate all sessions and re-mint mid-session. They pass
     `{ expiresAt: <the presenting session's expires_at> }`, captured **before**
     `invalidateFriendSessions()` runs: a remembered friend changing their password
     keeps their opted-in horizon (never extended, never silently shortened to 24 h).
     `via` is NOT carried over — the re-minted session proves a fresh password and its
     `via` is NULL, which is what retires the UC-ML-008 waiver after a password change.
  3. UC-ML-005's redemption — `{ via: 'magic_link' }`, default 24 h TTL (see the
     decision there).
- Existing rows are untouched — a session minted under the 30-day rule keeps its
  stored `expires_at` until it expires or is invalidated.
- The response shape of every minting endpoint is unchanged (`token`, `expiresAt`);
  the frontend's existing local-expiry check on `expiresAt` (03 §UC-FL-001) already
  handles the shorter horizon with zero changes.

**Acceptance criteria:** `POST /friends/auth` with `remember: true` returns
`expiresAt − Date.now()` within a minute of 60 days; with `remember` absent or `false`,
within a minute of 24 h; a password change performed on a remembered session returns an
`expiresAt` equal to the pre-change session's (±0 — carry-over, not re-derivation).

---

## UC-ML-003 `POST /api/magic-link/request` — enumeration-safe request (Friend, public)

**Goal:** anyone can ask for a link; nobody can learn from the answer whether an
account, an e-mail, or anything else exists.

**Route contract:**

- New `backend/src/routes/magic-link.js`, mounted **bare** at `/api/magic-link` (public
  surface — never behind `requireAdmin` or friend auth; the invitations mixed-mount
  lesson in reverse).
- Body: `{ identifier }` — **one field**. The login screen collects a username, the
  link goes to an e-mail, and a friend who forgot their password may have forgotten
  which they registered — so both matching paths ship (they are one extra SELECT):
  1. Type/bounds first: non-string ⇒ **400** `{ error, field: 'identifier' }`
     (Slovak vy-form, the guest.js contract); after trim, empty ⇒ 400; length > **160**
     (the e-mail bound, GSO-T3 mirror) ⇒ 400. These 400s are input-shape errors, not
     existence signals — they fire identically for any account state.
  2. `lower = identifier.trim().toLowerCase()`.
  3. **Username path:** `SELECT * FROM friends WHERE username = ? AND active = 1`
     with `lower`. (Usernames are `[a-z0-9._-]` — no `@`, so the paths cannot collide.)
  4. **E-mail path** (only when no username matched and `lower` contains `@`):
     match `friends` rows with `active = 1` and `lower(trim(email)) = lower`. ⚠ **AMENDED
     BY ML-T2 — the implementation deliberately does NOT use this literal SQL.** SQLite's
     `lower()` is **ASCII-only** and its `trim()` strips only U+0020, while the identifier
     arrives through JS `toLowerCase()`, which is Unicode-aware: `lower('ŽOFIA@Example.TEST')`
     is `'Žofia@example.test'` and can never equal the JS-lowercased form. A friend whose
     stored address carries an uppercase diacritic — unremarkable for this user base — could
     therefore never recover, and the enumeration guarantee below means **nothing could ever
     tell them**: they would keep requesting links that are silently never sent. `friends` is
     tens of rows, so `routes/magic-link.js` selects the active friends with a non-null e-mail
     and normalises **both sides in JS**. The rule below (exactly one active match) is
     unchanged. The match
     counts **only when exactly one** active friend has that e-mail — `friends.email`
     has no UNIQUE constraint, and mailing a shared inbox a login link for an ambiguous
     account would log in "whoever clicks first" as an arbitrary friend. Zero or ≥2
     matches ⇒ treated as no match (see §Accepted risks).
- **Eligibility** (all checked after a match; any failure ⇒ the neutral 200, no mail):
  - `active = 1` (already in the match),
  - `email` present and non-empty (the brief's prerequisite),
  - `password_hash` present — recovery presupposes a password to recover; a
    credential-less legacy friend must not gain a login side-door here (their path is
    the admin's credentials actions, 07).
- **`auth_mode` gate:** when `getAuthMode() !== 'modern'`, the endpoint does no work
  and returns the same neutral 200 (the feature is modern-mode only per
  01-architecture; the mode is public via `/friends/auth-mode`, but a second response
  shape buys nothing).

**On a full match — inside ONE `db.transaction` (synchronous writes only, no hashing
concern — SHA-256 is microseconds, the IA-T3 bcrypt rule is not implicated):**

1. **Cooldown:** if the friend's newest `login_tokens.created_at` is < **60 s** old,
   write nothing (mail-bomb bound: one outbound mail per friend per minute, regardless
   of how many requests the limiter lets through). Still the neutral 200.
2. **Invalidate predecessors:** `DELETE FROM login_tokens WHERE friend_id = ? AND
   used_at IS NULL` — only the newest outstanding link works (conservative; also what
   makes "the mail didn't arrive, request again" self-consistent).
3. INSERT the new row (UC-ML-001 shapes). Opportunistic cleanup of expired rows
   (`DELETE … WHERE expires_at < ?`), mirroring `createFriendSession`'s pattern.

**⚠ The response is the SAME `200 { success: true }` on every path** — match, no
match, no e-mail, no password, inactive, ambiguous e-mail, cooldown, legacy mode,
**and every mailer outcome**. Two mechanisms, both mandatory:

- **Body identity:** the handler has exactly one success response literal; nothing
  variable may reach it (08's seam text: the mail outcome must not leak whether an
  account matched — "that mapping is 09's rule").
- **⚠ Fire-and-forget send — the timing-oracle killer.** `sendMail()` awaits a network
  round-trip with a 10 s timeout; awaiting it would make a matched identifier
  measurably slower than an unmatched one. The handler responds **immediately after
  the transaction** and lets the send settle in the background (`sendMail` never
  throws per its rule 3; wrap the whole render+send in the UC-ML-004 try/catch anyway
  so a `renderEmail` throw cannot become an unhandled rejection). Consequence,
  accepted: a mail failure is visible only in the server log — the requester retries
  from the same screen.

**Rate limiting:**

- New **own bucket** in `middleware/rate-limit.js`: `magicLinkLimiter`, env
  `RATE_LIMIT_MAGIC_MAX`, default **10**/window. Justification against the two
  alternatives 01 allows: (a) an accepted request triggers an outbound Mailgun send —
  a cost profile no other bucket has; (b) the office-NAT coupling that motivated the
  guest split (CLAUDE.md §Rate-limit buckets): on `authLimiter`, a recovery-spammer
  behind the shared IP would lock colleagues out of **password login** — exactly the
  moment they need it — and vice versa. Extend the file's "do not collapse" comment
  to five buckets.
- The redemption endpoint (UC-ML-005) sits on **`authLimiter`** — it mints sessions;
  it IS a login.

**Acceptance criteria:** the 200 status + body are byte-identical (JSON-stringify
equal) across: matching username, matching unique e-mail, unknown identifier, matching
friend without e-mail, without `password_hash`, inactive friend, and a Mailgun stub
returning 500; a matched request creates exactly one outstanding `login_tokens` row and
deletes prior unused ones; two requests within 60 s produce one mail; `{identifier: 5}`
⇒ 400; a 200-char identifier ⇒ 400; anonymous access works (public route).

---

## UC-ML-004 The magic-link e-mail (system — consumes 08's seam)

**Goal:** the second consumer of `renderEmail`/`sendMail`, exactly as 08 §Seam for
module 09 anticipated. This module supplies subject, text, blocks; the layer supplies
everything else.

**Business rules:**

- **URL:** `` `${resolveLoginUrl(req)}/magic/${rawToken}` `` — built on
  `resolveLoginUrl(req)` so the 08 §UC-EM-004 `PUBLIC_BASE_URL` pin covers it
  automatically, and the same origin-allowlist reasoning applies (an attacker-chosen
  Origin must never mint the link's domain — the resolver already guards this). The
  URL is server-derived, satisfying 08's "button.url never from a request body" rule.
- **Subject:** `Prihlásenie do Podpultovky`.
- **`text` (the plain part, this module's own copy — vy-form, no gendered participle):**

  ```
  Dobrý deň, na prihlásenie do Podpultovky použite tento odkaz: {url}
  Odkaz platí 15 minút a dá sa použiť len raz. Ak ste o prihlásenie nežiadali, tento e-mail ignorujte - vaše heslo sa nezmenilo.
  ```

- **`blocks`** (exactly 08's anticipated shape — no new block types needed):
  1. `{ type: 'paragraph', text: 'Na prihlásenie do Podpultovky použite toto tlačidlo. Odkaz platí 15 minút a dá sa použiť len raz.' }`
  2. `{ type: 'button', url }` — URL-as-label default kept (08: an unsigned button
     label is new copy; none is invented here).
  3. `{ type: 'small', text: 'Ak ste o prihlásenie nežiadali, tento e-mail ignorujte. Vaše heslo sa nezmenilo.' }`
- No interpolated user-supplied string appears in any block (the URL is server-minted;
  the friend's name is deliberately not used — one fewer personalization is one fewer
  escaping surface and the mail works for every register).
- Render + send sit in one try/catch per 08 §UC-EM-002 (a render throw degrades to "no
  mail", logged `e.message` only) — and per UC-ML-003 the whole thing runs after the
  response, fire-and-forget.
- ⚠ **The mailer result vocabulary is consumed, never surfaced:** `sent` / `skipped:
  'no_recipient'|'not_configured'` / `error:*` all map to the already-sent neutral 200.
  `not_configured` is the normal local-dev/e2e state (the mailer's rule 1) — the
  request flow must behave identically there, which the enumeration rule already
  forces.
- Copy status: **proposed, not signed** — see the consolidated OPEN in UC-ML-006.

**Acceptance criteria (stub harness):** a matched request produces ONE stub request
whose `text` field contains the URL and the 15-minute sentence; the `html` field
contains the button whose `href` equals the URL, the same origin as the harness's
`PUBLIC_BASE_URL`, and no other `http(s)://` host (08 §UC-EM-005 item 3); the raw
token in the mail matches `/\/magic\/([a-f0-9]{64})/` and its SHA-256 equals the stored
`token_hash`; subject field equals the constant.

---

## UC-ML-005 Redemption — `/magic/:token` + `POST /api/magic-link/redeem` (Friend)

**Goal:** clicking the mailed link logs the friend in — once, within 15 minutes, with
no failure oracle.

**Frontend route:**

- `router.js` gains `{ path: '/magic/:token', component: MagicLogin }` — new view
  `frontend/src/views/MagicLogin.vue`, consistent with the existing public token routes
  (`/g/:token`, `/invite/:code`). Podpultovka skin per the InviteRegister precedent:
  `.app` scope, BrandChrome, 480 px column, **centred** composition for the terminal
  states (the 2026-08-12 lesson: a two-line terminal state top-aligned is a headline
  stranded over empty halftone).
- ⚠ **Redemption is a POST fired by the page's JS, never a GET side effect.** Corporate
  mail scanners and link-prefetchers (Outlook SafeLinks class) follow GET links; if the
  SPA GET burned the token, the human's click would always land on "already used". The
  SPA document GET is side-effect-free; `MagicLogin.vue` auto-redeems **on mount** via
  `api.redeemMagicLink(token)` behind a single-shot guard (a module-scope
  `redeemAttempted` ref — one POST per mount, ever; re-navigation must not double-fire
  a single-use credential). Residual risk — a scanner that executes JS — is accepted
  and recorded (§Accepted risks).
- States: mounting shows `Overujem odkaz...` (`.sub`, the house loading register);
  success stores the session and `router.replace('/')` to the portal; failure shows the
  neutral message below with a `.btn` **"Späť na prihlásenie"** → `/`.
- An **already-authenticated** visitor redeems anyway: the new session replaces the
  stored one (`gorifi_friend_auth` overwritten). Clicking a valid login link means
  "log in as this link's owner" — including when the device held someone else's
  session.

**Backend contract — `POST /api/magic-link/redeem`, body `{ token }`, on `authLimiter`:**

- Input bounds: non-string or length > 128 ⇒ the neutral failure (below), not a
  distinct 400 — the failure surface is deliberately single-shaped.
- `getAuthMode() !== 'modern'` ⇒ the neutral failure (modern-mode only, 01-architecture).
- **The atomic single-use write** (01's contract: `used_at` set atomically). Inside one
  `db.transaction`:

  1. `UPDATE login_tokens SET used_at = ? WHERE token_hash = sha256(token) AND
     used_at IS NULL AND expires_at > ?` — **the `used_at IS NULL` predicate inside the
     write IS the single-use mechanism**; never a read-then-write pair without it.
     `changes !== 1` ⇒ neutral failure (unknown, expired, and used are
     indistinguishable by design).
  2. Load the row's friend: `active = 1` and `password_hash` non-NULL required —
     otherwise neutral failure. (The token is burned first even then — deliberate: a
     token that reached an ineligible account must not stay redeemable.)
  3. Mint the session: `createFriendSession(friend.id, { via: 'magic_link' })` —
     **24 h TTL, no remember opt-in at redemption** (the conservative choice: a link
     can be opened on any device that has the friend's mailbox, including a borrowed
     one; the long session stays an explicit checkbox on the login screen).
     **RESOLVED (product owner, 2026-08-15): always 24 h — no opt-in at redemption.**
     The `/magic/:token` page never offers the checkbox; the friend opts into the
     60-day session at their next password login.
     All writes here are synchronous and sub-ms (no bcrypt anywhere in this flow), so
     sharing the transaction does not violate the IA-T3 tight-transaction invariant.

- **200 response mirrors `POST /friends/auth`'s personal branch** (`friends.js:45-53`)
  so the frontend reuses its login handling verbatim:
  `{ success: true, friend: { id, name, uid, username, packeta_address }, token,
  expiresAt, hasCredentials: true, mustChangePassword: !!friend.must_change_password,
  viaMagicLink: true }`. Hand-picked fields, never `SELECT *` in the response (the 07
  §UC-IA-005 rule; `invite_code`/`access_token`/`password_hash` stay unpublished).
- **`mustChangePassword` interplay (resolved conflict #4):** the frontend routes a
  `mustChangePassword: true` redemption into the existing forced-change gate (03
  §UC-FL-012) exactly as password login does, and the UC-ML-008 prompt is suppressed —
  the forced flow wins.
- **Neutral failure — ONE status, ONE message** for unknown / expired / used /
  inactive / ineligible / legacy-mode / malformed: `401 { error: 'Odkaz na prihlásenie
  už nie je platný. Požiadajte o nový na prihlasovacej obrazovke.' }`. No `reason`
  field, no differing status codes — any distinction is an oracle over token state.
- `api.js` gains `requestMagicLink(identifier)` and `redeemMagicLink(token)` via the
  standard `request()` (an ambient Bearer header is harmless on both).

**Acceptance criteria:** the captured token redeems: 200 with the login shape,
`expiresAt` ≈ 24 h, and the minted Bearer token passes `GET /friends/:id/profile`; a
second redeem of the same token returns the neutral 401; a garbage token, a
DB-manufactured expired token, and a token whose friend was deactivated after issue all
return **byte-identical** 401 bodies; redeeming as friend with `must_change_password=1`
returns `mustChangePassword: true` and the UI lands in the forced gate; `/magic/<bad>`
renders the neutral message with the back button, no auto-retry loop.

---

## UC-ML-006 Login screen — the recovery affordance + request form (Friend)

**Goal:** the "Zabudli ste heslo?" entry point and the request flow, on the modern
login card only.

**Placement & markup (modern branch of `FriendPortal.vue` only — the legacy card is
untouched per 03 §UC-FL-003):**

- A text-button **"Zabudli ste heslo?"** inside the login card, under the remember-me
  row and above the submit button — small (13.5 px), `var(--ink-dim)`, underlined,
  with the house zero-pixel ARIA layer (role="button" + tabindex + Enter/Space — the
  RD-FO-1 rule: a pointer-only span is an accessibility regression). Module 10 will
  add its Google button to this same card; this affordance stays attached to the
  password field group so the two do not contest one slot (seam noted for 10).
- Clicking it swaps the **login card's content** to the request form (same `.card`,
  same 480 px column — no route change):

| Field | Markup / constraints |
|---|---|
| Užívateľské meno alebo e-mail | `label.field-lbl` + `input.inp` `type="text"`, `maxlength="160"`, **no placeholder** (2026-08-10 decision), `autocapitalize="none"`, `autocorrect="off"`; `.inp` is mandatory (A12 iOS rule — `ios-input-zoom.spec.js` counts `.inp`) |
| Submit | `button.btn.accent.block` **"Poslať odkaz na prihlásenie"** → `api.requestMagicLink(identifier)`; `disabled` while empty or loading |
| Back | text-link **"Späť na prihlásenie"** — restores the login form, state preserved |

- **Success state** (replaces the form in the card, regardless of what the server
  matched): the neutral sentence **"Ak máme k vášmu účtu e-mail, poslali sme naň odkaz
  na prihlásenie. Skontrolujte si schránku."** + "Späť na prihlásenie". The client
  never renders a different sentence for any 200 — the enumeration guarantee has a
  client half too.
- A 400 (input-shape) or 429 renders the server message in the card's existing
  `.banner.danger.slim` slot (03 §UC-FL-002 error convention).
- The affordance renders **only** when `authMode === 'modern'` — in legacy/transition
  the recovery UI does not exist (confirmed decision).
- `OPEN:` **product-owner sign-off of every new Slovak string in this module** — the
  affordance label, the field label, both buttons, the neutral success sentence, the
  neutral 401 message (UC-ML-005), the mail subject + text + blocks (UC-ML-004), and
  the prompt banner strings (UC-ML-008). All proposed above per the register rules
  (vy-form, no gendered participle addressing the reader); the 07/08 precedent is that
  user-facing copy ships signed.

**Acceptance criteria:** the modern login card shows the affordance; clicking swaps to
the one-field form with no placeholder and 16 px font at coarse pointer; submitting an
unknown identifier and a known one render the identical success sentence; the legacy
seed (`e2e/seed.mjs` `authMode: 'legacy'`) renders **no** recovery affordance anywhere.

---

## UC-ML-007 Remember-me — checkbox semantics + storage rule (Friend)

**Goal:** "Zapamätať si ma na tomto zariadení" stops meaning "persist to localStorage"
and starts meaning "keep me signed in for 60 days".

**Business rules:**

- The checkbox row's markup, label and `NeoCheckbox` primitive are unchanged (03
  §UC-FL-002 pins them). Two behaviours change:
  1. **Default unchecked** (resolved conflict #2). `rememberMe = ref(false)`.
  2. **`rememberMe.value` is sent to the server** as `remember` in the
     `POST /friends/auth` body — both `authenticatePersonal()` and the legacy shared
     password path (`api.js` `authenticateFriendsPersonal`/`authenticateFriends` each
     gain the parameter). The server TTL (UC-ML-002) is the mechanism.
- **localStorage is written on EVERY successful login** — checked or not (resolved
  conflict #1; 01-architecture verbatim: "the TTL, not the storage, is the mechanism").
  The `rememberMe`-gated `localStorage.setItem` branches and the in-memory-only
  fallback are retired. The stored shape keeps its pinned keys
  (`{ friendId, friendName, friendUid, token, expiresAt }` — three e2e suites write it
  directly) and may gain the optional UC-ML-008 flags; consumers already tolerate
  optional fields (`guest-host-view.spec.js:641-647` proves `friendUid` optional).
- The existing restore-time `expiresAt` check (03 §UC-FL-001) is what expires the
  24-hour session on-device — no new logic.
- Logout behaviour unchanged: `localStorage.removeItem` + token clear.

**Acceptance criteria:** at rest the checkbox reads `aria-checked="false"`; login with
it unchecked writes `gorifi_friend_auth` with `expiresAt` ≈ 24 h and survives a reload;
with it checked, `expiresAt` ≈ 60 d; a stored payload with a past `expiresAt` still
falls back to the login screen.

---

## UC-ML-008 The non-blocking "set a new password" prompt + `currentPassword` waiver (Friend)

**Goal:** a friend who logged in via the link — because they forgot their password —
can actually set a new one without knowing the old one; and is invited to, without
being forced.

**The server half — the waiver (without it the prompt is a dead end):**

- `PUT /friends/:id/change-password` gains a second waiver branch beside the existing
  `must_change_password` one (`friends.js:192-200`), on the same stated justification:
  when the **presenting Bearer session row** has `via = 'magic_link'`, the
  `currentPassword` check is skipped. The endpoint resolves the session row by the
  presented token (the ownership check via `validateFriendAuth` is unchanged); the
  waiver keys on the session, never on a body field.
- The waiver dies with the session: change-password re-mints with `via` NULL
  (UC-ML-002 item 2), so after one successful change the account is back on
  password-proof rules. It also dies at the 24 h expiry. ⚠ Accepted, recorded risk:
  for up to 24 h, a device holding a magic-link session can set a new password without
  knowing the old one — inherent to the trust model (holding the mailbox already
  grants exactly this power via a fresh link), bounded by the short non-opt-in TTL
  (UC-ML-005) and by every password change invalidating all sessions (existing
  behaviour).

**The frontend half — the prompt:**

- On a successful redemption the stored auth payload gains `viaMagicLink: true`
  (from the 200); dismissal state is a sibling flag `magicPromptDismissed`.
- **Where:** a banner at the top of the portal cycle list (`FriendPortalSession.vue`),
  `.banner` per 02 §UC-DS-013's semantic grammar (informational — not `danger`/`warn`;
  nothing is wrong). Copy (proposed, in the UC-ML-006 OPEN):
  **"Prihlásenie cez e-mailový odkaz prebehlo úspešne. Chcete si nastaviť nové
  heslo?"** with two actions: `.btn` **"Nastaviť nové heslo"** and a dismiss
  **"Teraz nie"**.
- **Visibility rule (testable):** rendered while `viaMagicLink && !magicPromptDismissed`
  in the stored payload — i.e. it re-appears on every portal load of that session until
  dismissed, the password is changed, or the session ends. "Teraz nie" sets
  `magicPromptDismissed: true` (persisted into `gorifi_friend_auth`, so the dismissal
  survives reload); a **new** redemption writes a fresh payload and the prompt returns.
  Suppressed entirely when `mustChangePassword` routed into the forced gate (resolved
  conflict #4).
- **"Nastaviť nové heslo"** opens the existing change-password UI (the profile modal's
  password section) with the **"Aktuálne heslo" field hidden** while `viaMagicLink` —
  including its client-side "Zadajte aktuálne heslo" validation
  (`FriendPortalSession.vue:530`), which must become conditional. The server is
  authoritative regardless (it checks `via` itself). ⚠ `portal-profile-modal.spec.js`
  pins this modal heavily — the field is *conditionally hidden*, never removed;
  password-login sessions must render the modal byte-identically to today, so the
  pinned specs pass **unchanged** (only magic-link sessions see the difference).
- On success the modal's existing behaviour runs (new token stored — now with `via`
  NULL, so `viaMagicLink` is cleared from the payload and the banner is gone for good).

**Acceptance criteria:** after redemption the portal shows the banner; reload — still
shown; "Teraz nie" — gone, and still gone after reload; "Nastaviť nové heslo" opens
the modal without the current-password field, and a change succeeds with only the new
password; after the change the banner never returns and a subsequent change-password
demands `currentPassword` again (waiver retired); a password-login session shows no
banner and an unmodified modal; a `must_change_password` friend redeeming sees the
forced gate and no banner.

---

## UC-ML-009 Invalidation & lifecycle rules (system)

**Goal:** every event that should kill outstanding magic links does, conservatively.

**Business rules (each testable):**

1. **A new request invalidates all older outstanding tokens** for that friend
   (UC-ML-003 step 2) — at most one redeemable link exists per friend at any moment.
2. **Any write to `friends.password_hash` deletes the friend's outstanding tokens** in
   the same transaction/statement group as the write. Call-site inventory (the
   checklist): `PUT /friends/:id/change-password`, `POST /friends/:id/setup-credentials`,
   admin `POST /friends/:id/reset-password` (`friends.js:581`), and 07's approve
   endpoint is exempt only because a brand-new friend cannot have tokens. Rationale: a
   password change is the "I have secured my account" event — a link mailed before it
   must not outlive it.
3. **Deactivation:** `PATCH /friends/:id` with `active: 0` already invalidates
   sessions (`friends.js:508`); it additionally deletes the friend's `login_tokens`
   rows. Belt-and-braces — the redemption's own `active = 1` check (UC-ML-005) is the
   load-bearing gate; an inactive friend can neither request (UC-ML-003 match) nor
   redeem.
4. **Hard delete** cascades via the FK (UC-ML-001), `foreign_keys = ON` as established.
5. Expired and used rows are garbage-collected opportunistically on each request
   (UC-ML-003) — no scheduler exists in this stack (01-architecture §Shared services)
   and none is added.

**Acceptance criteria:** request → password change → the captured token's redemption
returns the neutral 401; request → admin reset-password → same; request → deactivate →
same; request twice → the first mail's token 401s, the second redeems.

---

## UC-ML-010 Verification (system)

**Goal:** how the implementing tasks prove this module. No unit runner exists and none
is added (01-architecture §Testing & gate) — acceptance is Playwright e2e plus
`node --check` on every changed backend file (`schema.js`, `friend-auth.js`,
`rate-limit.js`, `friends.js`, `magic-link.js`, `index.js`).

**The stub token-capture trick (for the e2e-tester, spelled out):** the raw token never
appears in any API response — the ONLY place a test can obtain it is the Mailgun stub's
captured body. Reuse 08 §UC-EM-005's harness (`startMailgunStub()` +
`withMailHarness()` from `invitation-approval.spec.js` — extract, don't fork): the stub
captures the raw `multipart/form-data` body as one UTF-8 string; extract with
`captured.match(/\/magic\/([a-f0-9]{64})/)[1]` (the URL appears in the `text` field,
the html button `href`, and the html's visible-URL line — all three must be the same
token, which is itself an assertion). The harness's throwaway backend gets
`PUBLIC_BASE_URL` set, so the captured origin is deterministic.

**Obligations:**

1. **New `e2e/tests/magic-link.spec.js`** covering the API criteria of UC-ML-001/003/
   004/005/009 (enumeration byte-identity across all listed cases; capture → redeem →
   authenticated profile call; single-use; invalidation matrix; the 24 h/60 d
   `expiresAt` windows of UC-ML-002) and the UI criteria of UC-ML-006/007/008 (request
   form flow, neutral success, `/magic/:token` happy + neutral-failure pages, prompt
   banner lifecycle, the waived password change). Fixtures per test, never a shared
   `beforeAll` (the GSO-T8 worker-restart lesson).
2. **Expired-token case** manufactures expiry by writing `login_tokens.expires_at`
   directly — requires `DB_PATH`, self-skips without it (the established 213/214
   pattern). Never by waiting 15 minutes and never by adding a TTL env knob.
3. **Enumeration:** assert status + body byte-identity, NOT response timing (a timing
   assertion is flaky by construction); the fire-and-forget rule is instead pinned by
   the stub-500 case — a failing mailer still yields the identical 200.
4. **Pre-existing spec edits, case (a) of the e2e-immutability rule, each citing the
   mandating UC in a comment:** `modern-login.spec.js:214` (default-ON `aria-checked`
   → default-OFF, cites UC-ML-007) and its "remember-me off keeps the session in
   memory only" test (retargeted to "unchecked ⇒ stored `expiresAt` ≈ 24 h", cites
   UC-ML-007/resolved conflict #1); any `portal-fidelity.spec.js` remember-me
   assertion touching the checked state likewise. **`portal-profile-modal.spec.js`
   passes UNCHANGED** (UC-ML-008's conditional hiding is invisible to password
   sessions).
5. **Rate limit:** the new bucket joins the local-run instructions — **five** env vars
   raised now (`RATE_LIMIT_MAGIC_MAX` beside the four in CLAUDE.md); a low-limit
   isolation test (exhaust `magicLinkLimiter`, assert password login still reaches its
   handler) follows the `rate-limit-isolation.spec.js` self-skip pattern.
6. The suite still **never sets real `MAILGUN_*` vars** (the mailer's rule 1 is what
   keeps every one of these tests offline).

**Manual procedure (operator/product owner, after deploy):** on staging with the
Mailgun env present: request with a real username → mail arrives branded, links
`https://…podpultovka.biz/magic/…` → click on a phone → logged in, prompt banner shown
→ set a new password without the old one → old password rejected, new accepted →
request again with the e-mail identifier → same flow; verify a second click of a used
link shows the neutral page.

---

## Accepted risks / follow-ups (recorded, not silently implemented)

- **Shared e-mail across friends** (`friends.email` is not UNIQUE): the e-mail
  identifier path refuses ambiguous matches (UC-ML-003), so those friends can recover
  only by username. Neutral 200 hides this; the remedy is operational — module 11
  makes e-mail state visible to the admin. Accepted.
- **Friends without an e-mail cannot use recovery, and the UI cannot tell them so**
  (enumeration guarantee). Remedy: module 11 (admin sees/fills missing e-mails) + the
  admin's existing per-friend password reset. Cross-referenced, not solved here.
- **JS-executing mail scanners** could burn a token by auto-redeeming (UC-ML-005's
  POST-behind-JS defeats GET-prefetchers only). Cheap to recover (request again),
  accepted; if it bites in practice, the fix is a confirm-click before the POST — the
  same lever as the OPEN 60-day checkbox.
- **24 h waiver window** on `change-password` for magic-link sessions (UC-ML-008) —
  accepted with rationale there.
- **Shared/public computers:** with storage always written (resolved conflict #1), an
  unchecked login persists for up to 24 h where it used to die with the tab. Product
  decision 2026-08-14 (TTL is the mechanism); recorded so it is not re-litigated as a
  bug.
- **Concurrency caveat inherited:** the cooldown check and the request transaction are
  safe under `instances: 1` + synchronous better-sqlite3 (the standing GSO-T3 note);
  PM2 cluster mode would need revisiting here like everywhere else.
- **Legacy-mode retirement** (07 §Accepted risks TODO) will delete this module's two
  `getAuthMode()` gates as dead code — nothing else here depends on legacy.
- **Phase 2, named so it is not silently implemented:** magic-link login for
  credential-less friends (deliberately excluded, UC-ML-003 eligibility); a "log in on
  another device" QR flow; admin-triggered "send login link" from AdminFriends; session
  provenance surfaced in a sessions list. None are in scope.
