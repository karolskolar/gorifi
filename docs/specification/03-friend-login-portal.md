# 03 — Friend login + portal (f-login, f-portal)

> Scope: The redesign of `FriendPortal.vue` (one view, three states: loading / login /
> authenticated cycle list) and its component `FriendBalanceCard.vue`, plus the portal
> modals: profile, subscription settings, invite link, and the forced password-change
> dialog. Re-skin only — every auth flow, endpoint call, state transition and storage
> format in the current code is the behavior contract and stays as-is. Out of scope
> (handoffs): design tokens, `friends-theme.css` and the `neo/` primitives → `02`
> (consumed here, never re-derived); the order screen behind a cycle-card click
> (`/cycle/:cycleId`) → `04`; the share DIALOG internals (`GuestShareDialog.vue`) → `05`
> (this module specs only its two portal entry points); guest surfaces (`/g/…`) → `06`;
> the voucher modal and the admin app → out of this effort entirely (00-overview).
> Actors: Friend (host) — the only actor on these screens; Admin — appears only as the
> author of `must_change_password` resets and as "správca" in copy; Guest — never sees
> these screens.
> Sources: `docs/design/friends-portal-redesign/README.md` (§Screens 1–2, §Shared modals,
> §Interactions, §Business rules), `docs/design/friends-portal-redesign/friends/portal.jsx`
> (reference implementation — all Slovak copy transcribed verbatim from it),
> `friends/ui.jsx` (Field/Input/CopyRow/Checkbox primitives), `friends/data.js` (demo data
> shapes), repo `frontend/src/views/FriendPortal.vue`, `frontend/src/components/
> FriendBalanceCard.vue`, `frontend/src/api.js`, `frontend/src/router.js`,
> `backend/src/routes/friends.js` (`GET /friends/cycles` payload), `e2e/tests/*`
> (pinned selectors), repo `CLAUDE.md` (Friend Ordering Flow, GSO-T2, Packeta, Pending
> Invitations). The handoff bundle (2026-08) is canonical for visuals/copy; repo code is
> canonical for behavior. The most recent decision wins.
> ⚠ **`02-shot.png` is CROPPED mid-card**, immediately after the plan block — it does
> **not** reach the cycle card's badge row or its share row (UC-FL-007). Verify those two
> against `friends/portal.jsx:73-81` and the live prototype served **over HTTP** instead
> (`file://` breaks it — Babel XHRs the `.jsx` and CORS blocks it); reading computed
> values off the running prototype beats eyeballing a raster anyway. Everything above the
> plan block — appbar, balance card, card header, plan block — the shot does answer.
> **Design reference:** `screenshots/01-shot.png` (login), `screenshots/02-shot.png`
> (portal), `screenshots/17-shot.png` (desktop centering); live prototype
> `Podpultovka Friends.html` → screens "Prihlásenie" and "Portál — cykly". Match
> pixel-perfectly per 00-overview §Fidelity.

---

## Resolved conflicts (recency / canonicity)

1. **Portal delivery-method badge dropped.** The current cycle card shows a red Packeta /
   blue pickup badge (2026-05 Packeta feature, CLAUDE.md "Friend portal shows delivery
   method badge"). The 2026-08 prototype card (canonical, newer) has no such badge.
   Resolution: **dropped from the portal cycle card** — the delivery method remains
   visible on the order screen and in its pickup modal (module 04). Do not silently
   re-add it.
2. **Share-button copy vs. e2e pin.** `e2e/tests/guest-link.spec.js` locates the portal
   entry point by accessible name `'Zdieľať s kolegami'`; the prototype's visible label
   is **"Zdieľať"** (share icon + text). Resolution: visible text per prototype, pinned
   accessible name kept via `aria-label="Zdieľať s kolegami"` — both contracts hold,
   **zero e2e spec edits** (UC-FL-007).
3. **Copy refreshes — prototype wins** over current production strings:
   subscription help "Ak nevyberiete nič, **zobrazia sa** všetky cykly." (was "budú sa
   zobrazovať"); invite modal "Po registrácii ho **správca** pridá do skupiny." (was
   "admin") and vy-form "**Pošlite** tento odkaz priateľovi." (was "Pošli"); profile
   name help "Toto meno **vidí správca a kolegovia**." (was "sa zobrazuje pri
   prihlasovaní"); balance button "**Transakcie**" (was "Zobraziť transakcie");
   login subtitle "Prihláste sa užívateľským menom a heslom." (unchanged in meaning,
   now under the "Kto klope?" headline).
4. **Archive rows stay clickable.** The prototype's archive rows have no click handler;
   the repo navigates to the cycle on click. Repo is canonical for behavior → archived
   rows keep navigating via `goToCycle` (UC-FL-008); visuals per prototype.
5. **"Pozvi priateľa" modal title stays verbatim** (prototype + current production both
   use it). The i18n vy-form rule's hard pin is about gendered participles addressing
   the reader (01-architecture §i18n); the title is transcribed as-is, body copy is
   vy-form.
6. **"Objednané" quantity folds into the badge.** Current UI renders kilos/items on a
   separate "☕ 0.25 kg" line; the prototype puts it inside the ok badge:
   `Objednané · 0.25 kg` (coffee) / `Objednané · 3 ks` (bakery). Prototype wins; the
   separate line is dropped.

---

## UC-FL-001 View scaffold — `.app` root, brand chrome, state machine survival (Friend)

**Goal:** `FriendPortal.vue` becomes a Neobrutal screen without touching its state
machine: `authState` `'loading' | 'login' | 'authenticated'`, session restore, and all
data loading stay byte-identical in logic.

**Preconditions:** module 02 landed (`friends-theme.css` imported, `neo/` primitives,
fonts, `--ui-*` de-collision).

**Main flow:**

1. Add `class="app"` to the view's root `div` (replacing `min-h-screen bg-background`).
   This is the module's "first step" per UC-DS-001 — from here the ported stylesheet
   applies to this route.
2. Replace the current `<header>` with `BrandChrome` (UC-DS-006), rendered in **every**
   state (loading, login, authenticated) as the first child of `.app`, full-bleed:
   - **login / loading state:** `#titles` slot = wordmark
     `<span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>` +
     `<span class="s">Členský vstup</span>`; `#trailing` = `<span class="chip acc">Len
     pre svojich</span>`; `ticker` = `"+++ VSTUP LEN PRE SVOJICH +++ HESLO NEDÁVAJ ĎALEJ +++"`.
   - **authenticated state:** per UC-FL-004; `ticker` =
     `"+++ ČLENSKÝ OKRUH +++ PRE TÝCH, ČO VEDIA +++"`.
3. All script-section logic (`loadInitialData`, `hydrateCurrentFriend`, `authenticate`,
   `authenticatePersonal`, `loadCycles`, `checkPendingVouchers`, `resolveVoucher`,
   `switchUser`, `saveProfile`, `saveSubscriptions`, `saveCredentials`,
   `changePassword`, `submitForcedPasswordChange`, `openInviteModal`, `copyInviteLink`,
   `openShareDialog`, computed `dropdownFriends`/`activeCycles`/`archivedCycles`)
   is kept — this module edits templates and adds the UC-FL-007 count fetch only.

**Business rules:**

- **`document.title` stays `'Gorifi - Objednávky'`** (the existing `watchEffect`).
  `public-flow.spec.js` pins `toHaveTitle(/Gorifi/)`. `OPEN:` rebranding the title to
  Podpultovka is the same product decision as 02's `index.html` OPEN (title/favicon);
  until decided, Gorifi stays.
- **Session restore is untouched:** localStorage key `gorifi_friend_auth` with shape
  `{ friendId, friendName, friendUid, token, expiresAt }`, the `expiresAt` local-expiry
  check, the in-memory fallback when remember-me was off, `window.scrollTo(0, 0)` after
  auth, and fire-and-forget `hydrateCurrentFriend`. Three e2e suites sign in by writing
  this key directly (`guest-host-view.spec.js:649`, `guest-link.spec.js:236`,
  `mobile-no-h-overflow.spec.js:65`).
- The loading state renders `Načítavam...` centered (`.sub`, `padding: 48px 0`); the
  load-failure state renders the error in a `.banner danger` inside the page column
  (prototype has no design for these; `.banner danger` follows 02 §UC-DS-013 semantic
  grammar — red = error).
- Voucher modal + `voucherResolved` banners: **functionally unchanged, visually
  untouched** (00-overview: voucher modal is out of scope/next task). They keep their
  current markup and render inside `.app` with the transitional look UC-DS-002
  guarantees.
- Tailwind's `h-screen` utility must not be used anywhere in this view (inside `.app`
  it is the display-heading class — UC-DS-001 consequence).

**Acceptance criteria:**

- `/` shows `#fff8f3` halftone background and black appbar in all three states.
- Reload while authenticated (valid stored token) lands on the cycle list without
  a login flash beyond the loading state; expired `expiresAt` falls back to login.
- e2e suite stays at baseline **238 passed / 3 skipped** with zero spec edits.

---

## UC-FL-002 f-login — redesigned personal login (modern auth mode) (Friend)

**Goal:** when the server reports `auth_mode = 'modern'`, the login state renders the
prototype's f-login screen (username + password only).

**Preconditions:** `authState === 'login'` and `authMode === 'modern'` (fetched via
`api.getAuthMode()`, default `'legacy'` on failure — existing logic, keep).

**Layout (from portal.jsx, all values pinned):** below the chrome, a centered column
`max-width: 480px`, padding **20 px phone / 32 px desktop**, `flex-direction: column`,
`gap: 20px`, containing:

1. **Headline block** (centered, `margin-top` 8 phone / 24 desktop):
   `<h1 class="h-screen" >Kto <span class="hl">klope?</span></h1>` — font-size **40 px
   phone / 52 px desktop**; below it `<div class="sub">Prihláste sa užívateľským menom
   a heslom.</div>` (`margin-top: 12px; font-size: 14px`).
2. **Login card** — `div.card`, padding 18 phone / 24 desktop, column `gap: 16px`.
3. **Invite explainer card** — `div.card.dashed`, padding 14, `font-size: 13.5px`,
   `color: var(--ink-dim)`, `display:flex; gap:10px; align-items:flex-start`:
   `NeoIcon name="lock"` (in a flex span, `margin-top: 1px`) + verbatim copy:
   **"Nemáte účet? Podpultovka je na pozvánky — požiadajte kamoša, ktorý už objednáva,
   alebo si objednajte cez jeho odkaz bez účtu."**

**Field group — login card contents (native elements + theme classes; no `ui/input`):**

| Field | Markup / constraints |
|---|---|
| Užívateľské meno | `label.field-lbl` "Užívateľské meno" + `input.inp` `type="text"`, placeholder `napr. lego`, `autocapitalize="none"`, `autocorrect="off"`, `autocomplete="username"`, bound to `loginUsername` |
| Heslo | `label.field-lbl` "Heslo" + wrapper `position:relative`: `input.inp` `type="password"`/`"text"` (eye toggle), placeholder `Zadajte heslo`, `padding-right: 48px`, `autocomplete="current-password"`, Enter submits; eye = `NeoIcon name="eye"` in a span `position:absolute; right:14px; top:50%; translateY(-50%)`, `cursor:pointer`, color `var(--accent)` while revealed else `var(--ink-dim)` |
| Zapamätať | `<label>` row (`display:flex; align-items:center; gap:10px; font-size:14px; cursor:pointer`): `NeoCheckbox` bound to `rememberMe` + text **"Zapamätať si ma na tomto zariadení"** |
| Submit | `button.btn.accent.block` **"Prihlásiť sa"** → `authenticatePersonal()`; label **"Overujem..."** and `disabled` while `loading`; also `disabled` when either field is empty |

**Business rules:**

- Behavior is the existing `authenticatePersonal()` verbatim: username lowercased before
  the call, token stored via `setFriendsToken`, localStorage written only when
  `rememberMe`, `mustChangePassword` → UC-FL-012, error message shown from the thrown
  `e.message`. Client-side empty-field message stays "Zadajte užívateľské meno a heslo".
- `rememberMe` default stays `true` (repo + prototype's checked box agree).
- **Error display:** `authError` renders as `.banner.danger.slim` at the top of the login
  card (prototype has no login-error state; `.banner danger` per 02 §UC-DS-013 semantic
  grammar; `.slim` keeps the card compact).
- The eye toggle only switches the input's `type` — it never clears the value and is
  not part of the tab order's form submission (plain `span`, `@click`).
- The `/coffee-cup.png` hero image and the shadcn login card are **removed from the
  modern branch** (replaced by this design). They remain in the legacy branch
  (UC-FL-003).
- The redesigned modern login **does not contain the literal text "Prihlásenie"**.
  `public-flow.spec.js:11` and `friend-login-list.spec.js:42` assert that text, but both
  run against the **legacy** seed (`e2e/seed.mjs` sets `authMode: 'legacy'`), where the
  untouched legacy card still renders it — no spec change now. Pinned for the future:
  if the e2e environment ever seeds `modern`, those two assertions must be re-targeted
  (e.g. to the "Kto klope?" heading or the "Prihlásiť sa" button).

**Acceptance criteria:**

- Side-by-side with `screenshots/01-shot.png` at 378 px: wordmark appbar with rotated
  "LEN PRE SVOJICH" chip, ticker, "KTO **KLOPE?**" display headline with magenta `.hl`
  highlight, 3px-ink input fields, magenta block button, dashed explainer card.
- Successful login lands on the cycle list; wrong password shows the server message in
  the danger banner; Enter in the password field submits.
- `input.inp:focus` shows the `3px 3px 0 var(--accent)` focus shadow (from the ported CSS).

---

## UC-FL-003 Legacy / transition login — pinned non-redesign (Friend)

**Goal:** pin exactly what happens when the server reports `auth_mode` `'legacy'` or
`'transition'` — the confirmed decision (00-overview §Scope decisions): **not
redesigned**.

**Business rules:**

- When `authMode !== 'modern'`, the login state renders the **existing** shadcn login
  card unchanged — coffee-cup image, "Prihlásenie" CardTitle, name `Select` dropdown fed
  by `getFriendsLoginList()`, shared-password input (placeholder "Zadajte heslo"),
  transition-mode tab switcher ("Spoločné heslo" / "Osobné prihlásenie"), remember-me,
  and the existing buttons/copy. **No theme classes, no `neo/` components, no copy
  edits** in this branch.
- It renders inside `.app` under the BrandChrome from UC-FL-001 — the shadcn components
  keep working there (UC-DS-002's transitional guarantee). The paper background behind
  the old card is accepted; nothing else changes.
- The credential-setup modal (transition mode, `showCredentialSetup`) is part of this
  legacy surface: **kept as the existing shadcn Dialog, unmodified.**
- These branches retire with `auth_mode=modern` (existing follow-up, out of this
  effort). Do not invest design work here; do not delete them either.
- e2e pins that live in this branch and must stay green: `getByText('Prihlásenie')`,
  `getByRole('combobox')` + populated options (`friend-login-list.spec.js:40-49`),
  `getByPlaceholder('Zadajte heslo')`, button "Prihlásiť sa".

**Acceptance criteria:** with a legacy-mode server, the login screen diff vs. today is
only the header/background (chrome + `.app` paper); `friend-login-list.spec.js` and
`public-flow.spec.js` pass unmodified.

---

## UC-FL-004 Portal appbar — name, code, edit, Pozvať chip, logout (Friend)

**Goal:** the authenticated appbar per `screenshots/02-shot.png`.

**Structure (BrandChrome slots, order fixed):**

- `#titles` slot: `<span class="t">{{ getCurrentFriendName() }}</span>` +
  `<span class="s">{{ getCurrentFriendUid() }}</span>` — the whole titles block is
  clickable (`cursor:pointer`) and opens the profile modal.
- Immediately after titles (before `.grow`, via the `#titles` slot content or a
  leading-position element): `NeoIcon name="pencil"` in a span (`opacity:.75`,
  `cursor:pointer`, flex) — also opens the profile modal (`title="Upraviť profil"`).
- `#trailing`: `<span class="chip acc">` with `NeoIcon name="invite"` + text
  **"Pozvať"** (`display:inline-flex; align-items:center; gap:6px; cursor:pointer`) →
  opens the invite modal; then `NeoIcon name="logout"` in a span (`opacity:.85`,
  `cursor:pointer`, `title="Odhlásiť sa"`) → `switchUser()`.

**Business rules:**

- Name/uid come from the existing helpers (`getCurrentFriendName`,
  `getCurrentFriendUid`) — login name, never `display_name` (admin-only). The uid
  renders in the `.s` slot (uppercased, letter-spaced by CSS — it is an ID; the mono
  convention does not apply inside `.appbar .s`, whose CSS is canonical).
- `switchUser()` behavior unchanged: clears storage + memory auth and returns to the
  login state (prototype navs to f-login — same thing).
- The appbar is not sticky (UC-DS-006); no other element joins it.

**Acceptance criteria:** matches `02-shot.png` top bar: LEGO / X42KPGZZ-style block,
pencil, rotated magenta "POZVAŤ" chip, logout glyph; tapping name or pencil opens the
profile modal; chip opens invite; logout returns to login.

---

## UC-FL-005 Balance card — `FriendBalanceCard.vue` restyle (Friend)

**Goal:** the "Môj účet" card per the prototype.

**Structure:** `div.card`, padding 16 phone / 20 desktop, `display:flex;
align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap`:

- Left: `div.field-lbl` **"Môj účet"** (`margin-bottom: 4px`) above the balance value.
- Balance value, `font-size: 16px`:
  - negative (`< -0.01`): `<span class="neg pill">{{ balance.toFixed(2) }} EUR</span>`
  - zero (|balance| ≤ 0.01): `<span class="zero">0.00 EUR</span>`
  - positive: `OPEN:` the prototype only shows a negative balance and theme.css defines
    no positive-money class. Proposed default: `<span class="mono"
    style="color:var(--ok-deep); font-weight:700">+{{ balance.toFixed(2) }} EUR</span>`
    (green = money-good per 02 semantic grammar, `+` sign kept from current
    `BalanceBadge` behavior). Needs a design confirmation.
- Right: `button.btn.sm` **"Transakcie"** → `showModal = true` (opens
  `FriendTransactionsModal` exactly as today).

**Business rules:**

- Data flow unchanged: `api.getFriendBalance(friendId)` on mount + on `friendId` change;
  loading renders "Načítavam..." (`.sub`); error renders the message in
  `.banner.danger.slim` inside the card.
- **`BalanceBadge.vue` is NOT modified** — it is shared with admin views
  (`AdminFriends.vue`, `FriendDetail.vue`, …). `FriendBalanceCard` stops importing it
  and renders the three-state span above instead.
- `FriendTransactionsModal` keeps opening and functioning unchanged. `OPEN:` the
  transactions modal has **no design reference** in the handoff bundle (no screenshot,
  not in §Shared modals). Proposed default: leave the existing shadcn modal untouched
  this effort (transitional look; tokens don't leak — it teleports outside `.app` and
  carries its own shadcn classes). If the client wants it in-theme, it becomes a small
  follow-up composing `NeoModal` + the reserve `.tbl` class (02 §UC-DS-013).
- Money format per UC-DS-012: `toFixed(2) + ' EUR'`, dot decimal.

**Acceptance criteria:** with a negative balance the value renders as the bordered
red pill exactly as in `02-shot.png` ("-74.24 EUR"); "Transakcie" opens the existing
transactions modal; admin screens using `BalanceBadge` are pixel-unchanged.

---

## UC-FL-006 Cycle list — heading, gear, cycle cards (Friend)

**Goal:** the portal's main content: section header + active cycle cards.

**Page column:** padding **16 px phone / 28 px desktop**, `max-width: 760px`, centered,
column `gap: 20px` (UC-DS-005 standard column). Order: balance card (UC-FL-005) →
cycles section. That horizontal padding **must be expressed with `px-*`**, and the
column **must never carry the literal class `p-4`** (nor `p-4 sm:p-7`): the cycle card
below is pinned on that exact class token, so an all-sides `p-4` on the column would
make `cardFor()` match both the column and the card and trip Playwright strict mode.
Use UC-DS-005's canonical idiom — `mx-auto w-full max-w-[760px] px-4 sm:px-7` — plus a
separate vertical utility (`py-6`) where the column needs one; that satisfies the
prohibition by construction.

**Section header** (`display:flex; justify-content:space-between; align-items:center;
margin-bottom: 14px`):

- `<h2 class="h-screen">Objednávkové <span class="hl">cykly</span></h2>` — font-size
  **28 px phone / 34 px desktop**. **Pinned: it must stay a real `<h2>`** — five e2e
  specs locate `getByRole('heading', { name: 'Objednávkové cykly' })` (the accessible
  name concatenates across the `.hl` span, so the markup above satisfies it).
- Right: `NeoIcon name="gear"` in a span (`color: var(--ink-dim)`, `cursor:pointer`,
  `title="Nastavenia odberu"`) → opens the subscription modal.

**Empty states (existing copy, restyled minimally):** `cycles.length === 0` → centered
`.sub` "Žiadne dostupné cykly" (`padding: 48px 0`); `activeCycles.length === 0` →
centered `.sub` "Žiadne aktívne cykly" (`padding: 32px 0`).

**Cycle card** — one card per `activeCycles` entry, column `gap: 16px` between cards.
Root: `div.card.p-4` (+ class `hl` when `status === 'open'`); `cursor:pointer` and
`@click → goToCycle(cycle.id)` unless `status === 'planned'` (then `cursor:default`,
`opacity: .85`, no click). **Pinned structure for `guest-link.spec.js`:** the card root
(or its immediate body wrapper) must be a `div` carrying the literal class **`p-4`**
(= the prototype's 16 px padding) that contains BOTH the cycle-name heading and the
share button — the spec's `cardFor()` is
`page.locator('div.p-4', { has: getByRole('heading', { name, exact: true }) })`.

Card contents, top to bottom:

1. **Header row** (`display:flex; justify-content:space-between;
   align-items:flex-start; gap:10px`):
   - Left (`min-width:0`): `<h3 class="display" style="font-size:22px;
     line-height:1">{{ cycle.name }}</h3>` — **pinned: an `<h3>` whose text content is
     exactly the cycle name** (the `exact: true` heading locator; no extra spans inside).
     Clicking the name navigates (card-level click; `mobile-no-h-overflow.spec.js:73`
     clicks `getByText(CYCLE_NAME)`).
   - Below the name: `div.mono.sub` (`font-size:12px; margin-top:7px; display:flex;
     align-items:center; gap:6px`): `NeoIcon name="cal"` + `{{ cycle.expected_date }}`
     — rendered only when `expected_date` is set.
   - Right (non-planned only, `flex-shrink:0`, `display:flex; align-items:center;
     gap:8px`): when `hasOrder`, `<span class="display" style="font-size:18px">
     {{ cycle.orderTotal.toFixed(2) }} EUR</span>`; always `NeoIcon name="chev"` in a
     span with `color: var(--accent)`.
2. **Plan block** — when `plan_note` is set: `div.mono` (`font-size:12px;
   color:var(--ink-faint); margin-top:10px; line-height:1.7; white-space:pre-line`)
   rendering `plan_note` (the multiline admin text; prototype shows one line per row).
3. **Badge row** (`display:flex; gap:6px; flex-wrap:wrap; margin-top:12px`):
   - Type: bakery → `span.badge.acc-o` "Pekáreň"; coffee → `span.badge.solid` "Káva".
   - Status: planned → `span.badge.muted` "Plánovaný"; open → `span.badge.acc`
     "Otvorený"; locked → `span.badge` "Uzamknutý".
   - Order: `hasOrder` → `span.badge.ok` "Objednané · {qty}" where qty =
     `formatKilos(orderKilos)` for coffee (existing helper, "0.25 kg") /
     `` `${orderItemCount} ks` `` for bakery; else if open → `span.badge.warn`
     "Neobjednané"; locked without order → no badge (prototype rule).
   - **No delivery-method badge** (resolved conflict #1) and **no separate kilos line**
     (resolved conflict #6).
4. **Share row** — open cycles only (UC-FL-007).

**Business rules:**

- List composition unchanged: `activeCycles = status !== 'completed'` (planned, open
  and locked all listed here), ordered as the API returns them; `archivedCycles =
  completed` → UC-FL-008.
- Locked cycles remain clickable (read-only order view is module 04's business).
- `orderTotal` already includes the delivery fee (backend sums `total + delivery_fee`) —
  display as-is.

**Acceptance criteria:** matches `02-shot.png`: open cycle = white card with magenta
`6px 6px 0` shadow, display-font name, mono date + plan lines, rotated "Otvorený" badge;
planned card dimmed and inert; tapping an open/locked card navigates to
`/cycle/:cycleId`; heading + `div.p-4` + `<h3>` pins verified by running
`guest-link.spec.js` and `mobile-no-h-overflow.spec.js` unmodified.

---

## UC-FL-007 Share row + colleague count — GuestShareDialog entry point (Friend, host)

**Goal:** the open-cycle card's footer row: colleague-count context + the share entry
point into the (module 05) dialog.

**Structure (open cycles only):** row separated by `border-top: 2px solid
rgba(10,10,10,0.12)`, `padding-top: 12px; margin-top: 12px`, `display:flex;
align-items:center; justify-content:space-between; gap:8px`:

- Left: `span.sub` (`display:flex; align-items:center; gap:6px`):
  - when the cycle has ≥1 non-cancelled sub-order: `<span class="tabbadge">{{ n }}</span>`
    + text **"kolegovia cez váš odkaz"**;
  - otherwise: text **"Objednávate aj pre kolegov?"** (no badge).
- Right: `button.btn.sm` with `NeoIcon name="share"` + visible text **"Zdieľať"** and
  **`aria-label="Zdieľať s kolegami"`** (resolved conflict #2), `@click.stop` →
  `openShareDialog(cycle)`.

**Colleague count — new fetch (frontend only, no API change):**

- Source: `GET /api/guest-links/cycle/:cycleId` (existing friend-authenticated endpoint,
  GSO-T2) → `totals.count`, which already excludes cancelled sub-orders (GSO-T5) —
  matching the prototype's `liveSubs.length` semantics.
- After `loadCycles()` succeeds in the authenticated state, fire one request per **open**
  cycle (open cycles are the only cards with the row; typically 1–2). Non-blocking and
  error-swallowing — a failed/missing count renders the "Objednávate aj pre kolegov?"
  fallback, never an error. Store counts keyed by cycle id.
- **Sequence-guard the batch** (the GSO-T2 `loadSeq` rule): bump a counter on every
  `loadCycles`/logout; a stale response must not write counts after `switchUser()` or a
  reload — otherwise a logged-out or re-logged user could briefly see another session's
  counts.
- Badge shows only when `count > 0` (`.tabbadge` — mono, bordered, per theme.css).

**Entry-point contract (dialog internals → module 05):**

- ONE `GuestShareDialog` instance for the whole view (existing pattern), fed
  `:open="!!shareCycle"`, `:cycle-id="shareCycle?.id"`,
  `:cycle-name="shareCycle?.name || ''"` — the dialog names the cycle it shares
  (GSO-T2 rule; several open cycles can sit side by side).
- `@click.stop` is mandatory — the card's own click navigates; the share tap must not
  (pinned by `guest-link.spec.js`: after the click the URL stays `/`).
- The row (and button) exists **only** for `status === 'open'` — a locked cycle offers
  no share affordance (pinned: `toHaveCount(0)` on the locked card).
- The dialog's internal seq-guard, copy and controls are module 05's spec; this module
  must not modify `GuestShareDialog.vue` beyond what 05 defines.

**Business rules:**

- e2e pins that must pass unmodified: `cardFor(...).getByRole('button', { name:
  'Zdieľať s kolegami' })` (matches via `aria-label`), locked-card `toHaveCount(0)`,
  open-dialog flow (`Vytvoriť odkaz`, `guest-link-url` testid, `Kopírovať` — module 05
  owns those), and the slow-load race test (one dialog instance + Escape closes it —
  `NeoModal`'s Esc handling per UC-DS-010 keeps `getByRole('dialog')` count at 0 after
  Escape, which requires the restyled dialog to keep `role="dialog"`; seam noted to 05).
- The count is context only — it never gates anything on this screen (the host's own
  totals are unaffected; §Business rules "colleague totals are context").

**Acceptance criteria:** an open cycle with 3 non-cancelled sub-orders shows `3` in a
mono badge + "kolegovia cez váš odkaz"; with none, "Objednávate aj pre kolegov?";
share tap opens the dialog titled with that cycle's name and does not navigate;
`guest-link.spec.js` passes without edits.

---

## UC-FL-008 Archive fold (Friend)

**Goal:** completed cycles behind a fold, per the prototype.

**Structure:**

- Toggle row (rendered only when `archivedCycles.length > 0`): `display:flex;
  align-items:center; gap:8px; margin-top:18px; cursor:pointer; font-weight:600;
  font-size:14px; color:var(--ink-dim)` — `<span class="chev" :class="{ open:
  showArchive }"><NeoIcon name="chev" /></span>` + text `Archív ({{
  archivedCycles.length }})`. Clicking toggles `showArchive` (default closed —
  existing behavior).
- Expanded: column `gap: 12px`, `margin-top: 12px`; one row per archived cycle:
  `div.card.flat` (`padding: 14px`, `display:flex; justify-content:space-between;
  align-items:center; gap:10px; opacity:.85`):
  - Left (`min-width:0`): name (`font-weight:700; font-size:15px`); below
    (`display:flex; gap:6px; margin-top:7px; flex-wrap:wrap`): small type badge —
    a plain `span.badge` carrying the type label ("Káva" or "Pekáreň") for **both**
    types, with **no** `acc-o` / `solid` modifier (archive rows are muted, so unlike
    the active card's badge row above they do not colour-code the type);
    `font-size:10.5px; padding:2px 7px` + `span.badge.muted` "Dokončený" (same
    small sizing).
  - Right: when `hasOrder`, `<span class="mono" style="font-size:13px;
    flex-shrink:0">{{ cycle.orderTotal.toFixed(2) }} EUR</span>`; otherwise nothing
    (repo behavior — the prototype's demo data always has totals).
- Rows stay clickable → `goToCycle(cycle.id)` (resolved conflict #4).

**Business rules:** the fold is plain `v-if`/`v-show` UI state, not persisted, not in
the URL (matches current behavior). No print rule applies here (the fold pre-exists and
this is not a distribution listing).

**Acceptance criteria:** chevron rotates 90° and turns accent when open; archived rows
render flat 2px-border cards with mono totals; clicking a row opens the cycle.

---

## UC-FL-009 Profile modal (Friend)

**Goal:** "Upraviť profil" via `NeoModal`.

**Trigger:** appbar titles block or pencil (UC-FL-004) → `openProfileModal()` (prefills
`profileName`, `profilePacketaAddress` — unchanged).

**Composition:** `NeoModal` `title="Upraviť profil"`, footer = `button.btn` **"Zrušiť"**
(closes, disabled while saving) + `button.btn.accent` **"Uložiť"** (label
**"Ukladám..."** while saving; disabled when `!profileName.trim() || profileSaving`) →
`saveProfile()`.

**Field group (body, top to bottom — copy verbatim from portal.jsx):**

| Field | Markup / rules |
|---|---|
| Jedinečné ID + Užívateľské meno | one row `display:flex; gap:10px`, two read-only value boxes: each a `label.field-lbl` over `div.copyrow > div.val` containing `getCurrentFriendUid()` / `currentFriend.username` (no copy button — the `.copyrow .val` box is the prototype's read-only style). The username field renders **only when `currentFriend.username` exists** (repo behavior: legacy friends may have none; prototype demo always has one — behavior wins). |
| Prihlasovacie meno * | `label.field-lbl` "Prihlasovacie meno *" + `input.inp` bound to `profileName`, `field-help` **"Toto meno vidí správca a kolegovia."** Required (trimmed non-empty) — enforced by the disabled save button as today. |
| Adresa Packeta výdajného miesta | `label.field-lbl` + `input.inp` bound to `profilePacketaAddress`, placeholder **"napr. Z-BOX Hlavná 15, Bratislava"**, `field-help` **"Predvolená adresa pre doručenie Packetou (voliteľné)."** Saved as `null` when blank (existing `saveProfile`). |
| Password-change fold | section separated by `border-top: 2px solid rgba(10,10,10,0.12); padding-top: 12px`. Rendered **only when `currentFriend.hasCredentials`** (repo behavior). Toggle: `button.btn.ghost.sm` (`color:var(--accent); font-weight:700; padding:0`) — label **"Zmeniť heslo"** closed / **"Skryť zmenu hesla"** open. Fold content (column `gap:12px; margin-top:12px`): three `field-lbl` + `input.inp type="password"` fields **"Aktuálne heslo"**, **"Nové heslo"**, **"Potvrdiť nové heslo"** (Enter in the last submits), then `button.btn.sm.dark` **"Zmeniť heslo"** (label "Mením heslo..." while saving; disabled until all three filled). |

**Business rules:**

- `saveProfile()` behavior unchanged: `PATCH /friends/:id/profile` with
  `{ name, packeta_address }`; updates `currentFriend`, the legacy dropdown list entry,
  and the stored `friendName` in localStorage; closes on success; errors surface via
  the view's `error` (render inside the modal body as `.banner.danger.slim` so the user
  sees it in context).
- `changePassword()` behavior unchanged: client validation messages verbatim ("Zadajte
  aktuálne heslo", "Nové heslo musí mať aspoň 8 znakov", "Nové heslá sa nezhodujú"),
  token rotation into localStorage, success text **"Heslo bolo úspešne zmenené"**
  auto-hidden after 3 s. Error → `.banner.danger.slim`, success → `.banner.ok.slim`
  above the password fields (prototype silent; 02 semantic grammar).
- Inputs must have programmatic label association (`for`/`id`) — the theme's
  `label.field-lbl` is a real `<label>`; getByLabel-style queries must keep working.
- ID and username are **read-only by design** (uid immutable; username changes are not
  a friend-facing feature). The old helper texts ("Toto ID sa nedá zmeniť") are dropped
  — prototype shows none for the read-only row.

**Acceptance criteria:** modal matches the prototype (side-by-side with the live
prototype's profile modal — no numbered screenshot exists; the prototype shell is the
reference per 00-overview); saving a new name updates the appbar immediately; the
password fold appears only for credentialed friends; a wrong current password shows the
server error inside the fold.

---

## UC-FL-010 Subscription modal (Friend)

**Goal:** "Nastavenia odberu" via `NeoModal`, gear-triggered (UC-FL-006).

**Composition:** `NeoModal` `title="Nastavenia odberu"`; body: `div.sub` **"Vyberte,
ktoré typy objednávok chcete vidieť:"**; then one selectable row per type — `<label
class="card flat">` (`padding: 12px 14px; display:flex; align-items:center; gap:12px;
cursor:pointer`) containing `NeoCheckbox` + `<span style="font-weight:700">` **"Káva"**
/ **"Pekáreň"**; then `div.field-help` **"Ak nevyberiete nič, zobrazia sa všetky
cykly."** Footer: `button.btn` **"Zrušiť"** + `button.btn.accent` **"Uložiť"**
(label **"Ukladám..."** while saving, both disabled while saving).

**Business rules (existing behavior, unchanged):**

- `openSubscriptionModal()` presets: empty subscription list ⇒ both boxes checked;
  otherwise checked per stored types.
- `saveSubscriptions()` builds `types` from the two booleans, `PUT
  /subscriptions/friend/:id`, then **reloads the cycle list** (the filter applies
  immediately). Unchecking both saves `[]` ⇒ all cycles show (backend rule).
- Cycles where the friend already has an order always show regardless of filter
  (backend rule — no UI implication here, recorded for the tester).
- Checkbox default color (magenta) — the green `ok` variant is reserved for hand-over
  semantics (UC-DS-009), not used here.

**Acceptance criteria:** unchecking "Pekáreň" and saving hides order-less bakery cycles
from the list without a reload; reopening the modal shows the persisted state; the
row's whole label surface toggles the checkbox.

---

## UC-FL-011 Invite modal (Friend)

**Goal:** "Pozvi priateľa" via `NeoModal` + `NeoCopyRow`.

**Trigger:** appbar "Pozvať" chip (UC-FL-004) → `openInviteModal()` (fetches
`api.getMyInviteCode(friendId)` on every open — unchanged).

**Composition:** `NeoModal` `title="Pozvi priateľa"`; body: `div.sub` **"Pošlite tento
odkaz priateľovi. Po registrácii ho správca pridá do skupiny."**; while loading,
"Načítavam..." (`.sub`, centered); when loaded, `NeoCopyRow :value="getInviteUrl()"`.
Footer: `button.btn` **"Zavrieť"**.

**Business rules:**

- Invite URL stays `` `${window.location.origin}/invite/${inviteCode}` `` (the
  `/invite/:code` route → `InviteRegister.vue`, out of scope here).
- `NeoCopyRow` replaces the bespoke copy button + `inviteCopied` state — the 2 s
  "Skopírované!" flip and clipboard fallback live in the primitive (UC-DS-011); delete
  the view's `copyInviteLink()`/`inviteCopied` once unused.
- A fetch failure surfaces the message as `.banner.danger.slim` in the modal body
  (currently it leaks into the page-level `error`; keeping the user in context is the
  restyle's one permitted UX correction here — same data, same call).
- The prototype's demo URL (`https://podpultovka.sk/invite/LEGO-9F2K`) is sample data —
  never hardcode a host.

**Acceptance criteria:** chip → modal → mono ellipsized link + "Kopírovať" button;
copy flips green "Skopírované!" for 2 s; clipboard holds the exact URL.

---

## UC-FL-012 Forced password change — `must_change_password` (Friend)

**Goal:** the non-dismissable "set a new password" gate, restyled with `NeoModal`.
(Not in the prototype's screen list — composed from 02 primitives; no pixel reference.)

**Trigger (unchanged):** a login response with `mustChangePassword: true` (either auth
path) sets `forcedPasswordChange = true` and prefills `changeCurrentPassword` with the
just-used password.

**Composition:** `NeoModal` with `closable: false` (no ×, no scrim-close, no Esc —
UC-DS-010), `title="Nastavte si nové heslo"`. The modal's content root carries
**`data-testid="forced-password-change"`** (pinned by `forced-change-ui.spec.js` —
currently `test.fixme`, but the hook is free to keep). Body: explanatory copy verbatim
from the current view — **"Administrátor vám resetoval heslo. Pred pokračovaním si
prosím nastavte vlastné nové heslo."** — then labelled fields **"Nové heslo"** and
**"Potvrdiť nové heslo"** (`label.field-lbl` with `for`/`id` association +
`input.inp type="password"`; Enter in the confirm field submits). Errors →
`.banner.danger.slim`. Footer: `button.btn.accent.block` **"Nastaviť heslo a
pokračovať"** (label "Ukladám..." while saving; disabled until both fields filled).

**Business rules:**

- `submitForcedPasswordChange()` unchanged: min-8 + match validation (messages
  verbatim), calls `changeFriendPassword` with the prefilled current password (the
  backend skips the current-password check under `must_change_password`), rotates the
  token into localStorage, clears the flag and the fields.
- The dialog blocks the portal until resolved — there is no "later" path (repo
  behavior; the credential-setup modal's "Neskôr" is a different, transition-mode
  surface — UC-FL-003).
- Note for the e2e follow-up: the fixme spec's regex `/resetoval vaše heslo/` does not
  match the current (kept) copy — whoever un-fixmes that spec updates the regex to the
  copy above, not vice versa.

**Acceptance criteria:** after logging in with an admin-reset password the modal appears
and cannot be dismissed by Esc/scrim; setting a valid password lands on the cycle list;
`getByTestId('forced-password-change')` resolves.

---

## UC-FL-013 Verification — behavior net, pinned selectors, fidelity (Friend)

**Goal:** how the implementing task proves this module correct.

**Pinned selectors / structures (must pass with ZERO e2e spec edits):**

| Pin | Where asserted | Satisfied by |
|---|---|---|
| `toHaveTitle(/Gorifi/)` on `/` | `public-flow.spec.js:9` | UC-FL-001 title rule |
| `getByText('Prihlásenie')` on anonymous `/` | `public-flow.spec.js:11`, `friend-login-list.spec.js:42` | legacy branch untouched (UC-FL-003); e2e seed is legacy |
| `getByRole('combobox')` + populated options | `friend-login-list.spec.js:44-48` | legacy branch untouched |
| `getByRole('heading', { name: 'Objednávkové cykly' })` | `guest-link.spec.js` ×3, `guest-host-view.spec.js:667` | `<h2 class="h-screen">` (UC-FL-006) |
| `div.p-4` card wrapper + `heading` exact cycle name + share button inside it | `guest-link.spec.js:301-320` | `div.card.p-4` + `<h3>` + button (UC-FL-006/007) |
| button accessible name `'Zdieľať s kolegami'`, absent on locked cards, `@click.stop` (URL stays `/`) | `guest-link.spec.js:287-322` | `aria-label` + open-only row (UC-FL-007) |
| one share-dialog instance, Escape closes (`role="dialog"` count 0), race-guarded | `guest-link.spec.js:325+` | UC-FL-007 entry contract + module 05 |
| `localStorage['gorifi_friend_auth']` restore shape | `guest-host-view.spec.js:649`, `guest-link.spec.js:236`, `mobile-no-h-overflow.spec.js:65` | UC-FL-001 session rules |
| click on cycle-name text navigates to the order page | `mobile-no-h-overflow.spec.js:73` | card-level click (UC-FL-006) |
| `data-testid="forced-password-change"` + field labels | `forced-change-ui.spec.js` (fixme) | UC-FL-012 |

**Procedure:**

1. Full Playwright suite green at baseline **238 passed / 3 skipped**.

   **⚠ AMENDMENT (RD-FL-7) — the e2e-immutability rule, reformulated.** As written
   ("no spec files modified by this task") this clause was self-contradictory: the
   same document's `UC-FL-011` *mandates* moving the invite-fetch failure into the
   modal body, which invalidates an assertion RD-FL-3 wrote — so obeying UC-FL-011
   requires editing a spec, and obeying this line requires not implementing
   UC-FL-011. The rule it was reaching for is:

   - **Pre-existing specs are immutable.** Everything in the pin table above, and
     every spec file this redesign pipeline did not author, must pass **unchanged**.
     If one of them fails, the implementation is wrong — full stop.
   - **A pipeline-authored spec may be edited in exactly two cases:** (a) a module
     spec **mandates** the behaviour change that invalidates the assertion, or (b)
     the assertion is **structurally unsatisfiable** against a primitive the spec
     mandates (e.g. it queries an `input` in a modal that UC-DS-011 turns into a
     `div.copyrow`). In both cases the edit must **re-point** the assertion at the
     mandated structure and protect the same property — never weaken or delete it.
   - **Every such edit cites the mandating clause in the code comment, and the PR
     reports the exact count of existing spec files edited.** Zero remains the
     expected number; a non-zero count is a claim that needs the citation to stand.

   The failure mode this guards against is a row silently re-pointing an assertion
   at whatever it happened to build. The failure mode the ORIGINAL wording created
   is worse — it makes a mandated behaviour change unimplementable, and the cheapest
   way out of that bind is to not implement it.
2. New e2e coverage this module adds (per 02 §UC-DS-014 item 6 — 03 is the primitives'
   first regression net): modern-mode login happy path + error banner
   (BrandChrome/NeoIcon/NeoCheckbox), portal share-row count rendering, invite modal
   copy flip (NeoCopyRow/NeoModal), profile save reflected in the appbar. Modern-mode
   specs must provision their own `auth_mode='modern'` state (settings API) and restore
   `legacy` after, or run against a dedicated seed — the shared legacy seed must stay
   legacy for the pinned login specs.
3. Fidelity: Playwright screenshots at 378 px and 1180 px side-by-side with
   `01-shot.png` / `02-shot.png` / `17-shot.png` + the live prototype for the modals
   (manual check, recorded in the PR — no visual CI).
4. No horizontal overflow at 320 px (`mobile-no-h-overflow.spec.js` covers the order
   page; eyeball the portal at 320 px too — long cycle names must ellipsize inside
   `min-width:0` blocks, the appbar `.t` ellipsizes by CSS).
5. Admin invariance re-assertion per 02 §UC-DS-014 item 2 (no `pp-*`/`neo/`/theme
   classes added under admin views; `BalanceBadge.vue` untouched).

---

## Dropped / Phase 2 (named so nothing is silently implemented)

- **Voucher modal redesign** — out of scope (00-overview); current markup kept.
- **Legacy/transition login + credential-setup modal redesign** — deliberately not
  designed; retire with `auth_mode=modern`.
- **Portal delivery-method badge** (Packeta/pickup on cycle cards) — dropped by the
  redesign (resolved conflict #1).
- **Separate kilos line under badges** — folded into the "Objednané ·" badge
  (resolved conflict #6).
- **Transactions modal restyle** — OPEN in UC-FL-005; default keep as-is.
- **Prototype-only demo strings** (`podpultovka.sk` URLs, "LEGO-9F2K", `X42KPGZZ`,
  balance `-74.24`) — sample data, never hardcoded.
