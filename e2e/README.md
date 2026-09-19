# Gorifi E2E Tests (Playwright)

Target-agnostic end-to-end tests. They validate the Phase 1 security fixes
(server-side admin authorization, no credential leakage, CORS lockdown) plus
public-flow smoke tests and the admin login/guard/logout UI flow.

## Layout

- `tests/api-security.spec.js` — API-level: admin endpoints 401 without a token,
  public endpoints stay 200, valid token unlocks, no `access_token` /
  `password_hash` / `invite_code` in responses, CORS lockdown.
- `tests/admin-auth.spec.js` — UI: router guard redirect, login success/failure,
  data loads through the admin token, logout re-protects.
- `tests/public-flow.spec.js` — UI: friend portal + admin login load, SPA fallback.
- `tests/item-packed.spec.js` — GSO-T1: per-item packing persistence
  (`order_items.packed`) and the whole-order "Zabaliť" gate (API-level, plus a
  UI-level pass on the Distribution page: checkbox persists across reload,
  button disabled until every item is checked).
- `tests/guest-link.spec.js` — GSO-T2: the host's guest share link
  (`guest_order_links`) — create, regenerate (new token, same row id, so
  sub-orders survive), deactivate/reactivate, unknown cycle 404 — plus the auth
  boundaries (anonymous 401, shared-password-without-identity 401, foreign
  friend 403) and a UI pass on BOTH share entry points — the FriendOrder card
  and the FriendPortal cycle card (which must not appear on a locked cycle, and
  must not navigate into the cycle when clicked), incl. a stale-response race
  test: one dialog is reused across cycles, so a `page.route`-delayed GET for a
  closed cycle must not swap in its link (and its buttons must not act on it).
- `tests/guest-order.spec.js` — GSO-T3: the public guest ordering surface
  (`GET /api/guest/:token`, `POST /api/guest/:token/orders`) — link resolution
  (200 / 410 deactivated / 410 non-open cycle / 404 unknown token), identity
  validation (name + mobile required, ≥9 digits), a successful submit with
  frozen marked-up prices + `order_token` + payment info, the 409 lock race,
  and the **stock-limit UNION in both directions** (a guest order shrinks the
  friend-side availability and cart/submit gates; a friend order shrinks what a
  guest can submit). Plus a UI pass on `/g/:token` — which needs **no** auth
  workaround at all, since the page is genuinely public: cart, blocked submit,
  confirmation (payment reference + personal status URL + localStorage), bakery
  variant grouping, and the dead-link page.
- `tests/guest-status.spec.js` — GSO-T4: the guest's personal status/edit URL
  (`GET/PUT /api/guest/:token/orders/:orderToken`). The PAIR of tokens is the
  credential, so a real order token under a **different** link token must 404
  (same message as an unknown one — no existence oracle). Covers the three
  lifecycle decisions: `cancelled` is terminal (a PUT gets 409, it is not
  revived), an **explicit** empty cart ⇒ `cancelled` + total 0 + **stock
  released** while the item rows are KEPT (so the release is proven to come from
  the `<> 'cancelled'` status predicate in `helpers/stock.js`, not from deletion),
  and a locked cycle makes the page read-only — `GET` still 200s while the
  product listing 410s, `PUT` 409s. Because cancelling is irreversible, one test
  pins down that **only** a literal `items: []` triggers it: `PUT {}`, a bodyless
  `PUT`, a non-array `items`, and a non-empty `items` in which nothing prices are
  all non-destructive 400s. Plus the `excludeGuestOrderId` seam (a re-save at the
  stock limit must not block itself, while another guest's grams still count),
  the GSO-T3 bounds re-applied to the edit, and a UI pass on
  `/g/:token/o/:orderToken` (items/total/flags, "Zaplatiť" → PaymentModal,
  editing through the shared `GuestProductGrid` — incl. bakery variant grouping,
  since this is the grid's second consumer — the cancel confirmation, and
  read-only when locked).
- `tests/guest-host-view.spec.js` — GSO-T5: the host's "Objednávky kolegov" view.
  The enriched `GET /api/guest-links/cycle/:cycleId` (each sub-order now carries
  its `items`, plus `paid` read-only and `delivered`, with `order_token` still
  unexposed), and the two HOST-owned mutations on
  `/api/guest-orders/:id` — `PATCH .../delivered` and `DELETE`. Pins down
  Decision 2's single ownership from both sides: `delivered` toggles on/off
  (setting and CLEARING `delivered_at`, and still available after the lock,
  because the hand-over happens after distribution), while a host token cannot
  write `paid` — nor `status`/`total`/`link_id` — through the delivered body, and
  an **admin token is not a substitute for host identity** on either route
  (anonymous 401, shared-password-without-identity 401, foreign friend 403,
  missing row 404 before any 403). `DELETE` is a **soft cancel**: status
  `cancelled`, total 0, item rows KEPT, stock genuinely released
  (`remaining_g` recovers and is buyable again), refused with 409 once the cycle
  is not open, and idempotent on an already-cancelled sub-order. The T4↔T5
  handshake is asserted end to end — after a host removal the guest's own status
  URL renders cancelled and a `PUT` cannot revive it. Also covers the case
  GSO-T4 left open: a **regenerated** link (new token, same row id) still
  resolves an existing sub-order's status URL while the retired token 404s. UI
  pass on the section in FriendOrder: sub-orders with their items, a read-only
  paid badge (and no paid control), the delivered checkbox toggling and
  surviving a fresh load, and a removal rendering as "Zrušené". Note: the
  durability step re-enters through the portal rather than `page.reload()`,
  because a hard load of `/cycle/:id` bounces to the portal by design.
  One describe (`DELETE — a PAID sub-order is the admin's business`) pins the rule
  that a host may **not** soft-cancel a sub-order the admin already marked paid
  (409 `reason: 'paid'`) — cancelling zeroes the total and drops the row from every
  "not cancelled" aggregate, so paid money would go invisible. Since GSO-T6 it sets
  the flag through the admin endpoint, so this spec needs no database file and runs
  in full against any target.
- `tests/guest-admin-view.spec.js` — GSO-T6: the ADMIN side of guest sub-orders.
  `PATCH /api/guest-orders/:id/paid` (paid on/off with `paid_at` set and CLEARED,
  and **no `transactions` row** — guests have no balance account, so the friend
  endpoint's payment/reversal logic must NOT be copied; asserted by the host's
  transaction count and balance standing still, plus a global row count when
  `DB_PATH` happens to be exported), `GET /api/guest-orders/cycle/:id/unpaid` (the
  receivables list: amount, the **same** `G<id> / Name / Cycle` reference the guest
  is shown, host, contact — paid and cancelled excluded, and a `paid + cancelled`
  refund queue whose amount is recomputed from the kept item rows because
  cancelling zeroes `total`), and both new routes' auth boundaries (anonymous 401,
  and a **host token rejected** — the mirror of GSO-T5's "an admin token is not host
  identity"). Decision 2 is pinned from the admin side for the first time: the admin
  cannot write `delivered`/`status`/`total` through the paid body (verified by
  re-reading the row). `unpaid_count` in `GET /api/cycles` is asserted to include
  guest sub-orders **while `orders_count` and the roastery breakdown stay
  unchanged** — the guest tables join in as a correlated subquery precisely because
  a second `LEFT JOIN` would multiply the friend-order aggregate. Plus a UI pass on
  the admin cycle detail: sub-orders nested under their host with the
  "Hosť • pozval X" badge, the paid toggle persisting across a reload, `delivered`
  shown read-only (no control offered), and the unpaid overview reacting to the
  toggle. One describe (`A PAID sub-order is frozen against item edits`) pins the
  sibling of GSO-T5's DELETE guard: a **non-empty** `PUT` on a paid sub-order is
  409 `reason: 'paid'` (what is owed cannot change once the payment was recorded —
  otherwise the difference shows on no admin surface, and the refund amount drifts),
  while a literal `items: []` **still cancels**; clearing `paid` unfreezes it, and the
  guest's status page offers no edit affordance while paid, only the cancel the server
  accepts. A deactivated host's placeholder row (their guests must not vanish from the
  admin's orders tab) is pinned too. A separate describe pins the Orders tab's rendering across the three
  states its v-if/v-else-if/v-else chain (empty scaffold / product view / friend
  view) can be in — nothing submitted yet, orders with no guest sub-orders, and
  orders with an unpaid guest sub-order (i.e. the guest-unpaid Card visible) — and
  toggles BOTH the "Podľa priateľa" and "Podľa produktu" views in the last one.
  This is the regression an API test cannot see: the implementer's fix keeps the
  card as a sibling ABOVE the chain rather than an extra link inside it, and a
  temporary revert-to-buggy-placement check (Card re-inserted as a chain link,
  reverted byte-identical afterwards) confirmed the "card visible" test fails on
  the old placement while the other two states stay green, exactly matching the
  bug's conditional nature.
- `tests/guest-distribution.spec.js` — GSO-T7: the guest leg of the Distribution
  view. `PATCH /api/guest-order-items/:id/packed` (the per-bag checkbox, the mirror
  of GSO-T1's friend one: persists, toggles back, 404 unknown, 401 anonymous, and
  **400 on a cancelled sub-order** — whose item rows survive the cancel, so without
  the gate they could be ticked for a bag nobody hands over), the now-COMPLETED
  whole-order gate (every own item checked but a guest bag untouched is still a
  **409** — asserted to fail on the GSO-T1 gate and pass on the UNION, verified by a
  temporary revert — and a cancelled sub-order neither appears as a bag nor blocks
  the pack), and the money rules: a guest checkbox writes **no `transactions` row**
  and moves nobody's balance (GSO-T6's rule on a second endpoint, plus the global
  NULL-`friend_id` count when `DB_PATH` is exported), while unchecking a guest bag on
  a packed order **auto-unpacks the host's order** and posts the reversal of the
  HOST'S OWN total, so the balance nets back to exactly where it started. The
  §Edge-Cases host is pinned from three sides: with only guest bags they are still
  listed as the pickup party (`order_id: null`, `has_own_order: false`, so there is
  no whole-order flag to write and the UI offers no "Zabaliť"), an unsubmitted draft
  puts them in the same branch, and once their only sub-order is cancelled they are
  not a pickup party at all. UI pass on the Distribution page: bags grouped per guest
  under the host with the violet "Hosť • <name>" badge, taps persisting across a
  reload, rapid taps on two bags NOT dropped (the in-flight guard is per item — the
  `own:`/`guest:` key prefix matters, the two id sequences overlap), "Zabaliť"
  disabled until every own + guest checkbox is checked and then packing through the
  UI, and a second card for the host with no own order offering no whole-order button
  at all. One further describe (`The own:/guest: key prefix`) manufactures an actual
  numeric-id COLLISION between an own `order_items` row and a `guest_order_items` row
  — the two sequences never collide by chance, so this is the one test in the suite
  that requires DB_PATH not merely for an extra assertion but to build the scenario
  at all (a direct `UPDATE ... SET id = ?` after both rows exist; self-skips without
  DB_PATH). It proves the `own:`/`guest:` prefix the implementer added to
  `itemKey`/`pendingItems` actually matters: verified with a temporary revert to a
  bare `item.id` key, which makes this test fail (the second tap's pending guard gets
  silently swallowed by the first row's in-flight flag sharing the same collided
  key) while every other guest-distribution test stays green — an API-only test
  cannot see this because the bug is purely in the frontend's per-item in-flight
  bookkeeping.
- `tests/guest-rewards.spec.js` — GSO-T9: `GET /api/analytics/rewards` credits guest
  kilos to the **host** (§UC-GSO-014, Decision 5). Every figure is exact, because both
  failure modes here are money errors that survive a "greater than" check: the credit
  landing nowhere, and a kilo counted twice. Covers a host with no own submitted order
  (and an unsubmitted draft that must stay out), own + guest kilos summing to a total
  cross-checked against independently-sourced halves from a different route
  (`/api/analytics/coffee`: its per-friend table is own-orders-only, its per-cycle row
  counts the cycle's guests once — so this row is also proven not to have doubled
  GSO-T8's numbers), a cancelled sub-order contributing zero, guest kilos landing in
  the cycle they were ordered in, and the three buckets `rewards.js` mirrors — a host
  who is a group ROOT, a group MEMBER and one who is UNASSIGNED ("Ostatní") — each
  credited once, plus no leak into another group. Each read also sums the per-cycle
  column of EVERY bucket, which is what proves "exactly once" rather than "present".
  Two member lists are pinned separately and asserted disjoint: `orderedMembers` is
  own-submitted-orders only (it answers "who ordered", the per-friend question
  Decision 4 fences off — naming a guest-only host there would be a false claim on a
  money screen), while `guestOnlyMembers` names the hosts whose whole contribution is
  their guests' kilos, so the group's total stays accounted for; the MIXED group (one
  member ordered, one only hosted) is the case that needs both. A deactivated host
  keeps the credit (the report is history), and **deleting a group root** no longer
  makes its ex-members' volume disappear — `friends.root_friend_id` has no FK, so a
  member used to be left pointing at a deleted row, in neither the group nor the
  unassigned filter, silently zeroing their whole reward volume. Fixed at both ends
  (the delete route clears the pointers; the report treats an unresolvable pointer as
  unassigned) and tested at both: through the API, and — since no API call can create a
  dangling pointer any more, while existing databases already contain them — one
  DB_PATH-gated test that manufactures one directly and self-skips without it. One UI
  pass on `/admin/analytics/rewards` for the guest-share line. ⚠ Its cycles/hosts/
  groups are created per test, and the "Ostatní" bucket is global — so only its
  per-cycle column is asserted, never its cumulative total.
- `tests/guest-lead-capture.spec.js` — GSO-T10: the lead-capture CTA (§UC-GSO-015,
  §Lead Capture). `POST /api/guest/:token/orders/:orderToken/invite-request` is a
  DEDICATED endpoint rather than a reuse of the public `POST /invitations/register`,
  because that one resolves the inviter from the host's `friends.invite_code` and
  reusing it would mean publishing the host's referral code into a page any stranger
  holding the link can read — the link token already identifies the host server-side.
  It takes the (link, order) token PAIR, so only somebody who actually placed a
  sub-order can create a lead. The three properties the spec hammers on: the
  **attribution** (`invited_by_friend_id` = the host of the link, taken from the link,
  never from the body), the **source tag** (`invitations.source = 'guest_order'`, set
  server-side, rendered as "Prišiel cez hosťovskú objednávku" in the admin list), and
  a duplicate pending phone answering a **clean 409, never a 500** — the pending-phone
  rule is `idx_invitations_phone_pending`, a partial unique index, so the app check
  alone loses the race and the constraint has to be translated too (verified: removing
  either half turns both duplicate tests into 500s). Also covers the deliberate
  gating asymmetry (a **locked** cycle and a **cancelled** sub-order still succeed —
  that is exactly when a guest asks for an account — while a dead link or a
  deactivated host 410s, because the lead would be credited to a host who can no
  longer log in), the GSO-T3 bounds re-applied through the SHARED `validateIdentity()`
  the checkout now also uses, mass assignment (`status`/`invited_by_friend_id`/
  `source`/`admin_note`/`invite_code`/`id` all refused, re-read through the ADMIN api),
  the 404-only resolution (unknown link, unknown order token, and a real order token
  under a FOREIGN link token — same message, no oracle), the pending-only nature of
  the phone guard (a rejected lead frees the number), and that the endpoint is
  **anonymous by design** with a response that is a bare `{ success: true }` — it is
  not in `ADMIN_ENDPOINTS` because it is deliberately not admin-gated. UI pass on all
  three surfaces: the confirmation screen's CTA (prefilled from the checkout, submits,
  and then offers no second submission), the status screen's (same component — one
  `GuestInviteRequest.vue`, incl. the already-requested state served by
  `invite_request.requested` after a reload, so the page never offers an action the
  server would 409), a **cancelled** sub-order still offering it, and the admin
  invitations list showing the tag while the invitation → new-friend flow reaches the
  approval dialog. ⚠ That last test was RETARGETED in IA-T4: it used to pin the
  `?create=1&name=&phone=&email=` navigation-prefill, which IA-T4 replaced with an
  in-place approval dialog and IA-T5 deleted the receiver for
  (`tests/admin-friends-labels.spec.js` pins the absence).
- `tests/admin-friends-labels.spec.js` — IA-T5 / 07 §UC-IA-007: the "Nový priateľ"
  name field writes `friends.name`, a DISPLAY label, and never minted a login, so the
  "Prihlasovacie meno *" label was the original reported bug. Asserts the new copy
  ("Meno", "Meno *", the `Toto meno vidí správca a kolegovia.` hint) **and the
  absences** — no `/prihlasovac/i` anywhere in the page's rendered text **or its
  attributes** (the retired claim lived in a `placeholder=`, invisible to an
  innerText-only sweep), and `/admin/friends?create=1&name=X` opening the plain list
  with no modal. `Prihlásenie` (the credentials column) is deliberately kept and
  asserted present. Scoped to `/admin/friends`; the friend half of the SAME rule lives in
  `tests/portal-profile-modal.spec.js`. ⚠ This entry used to say the identical label in
  `FriendPortalSession.vue` "is correct there" — **it was not** (that field writes the same
  `friends.name` column, and it shipped the lie to production; FUP-T20). The guard is
  **two views**: `grep -i prihlasovac frontend/src/views/AdminFriends.vue
  frontend/src/views/FriendPortalSession.vue` must stay empty — no view that edits
  `friends.name` may call it a login.
- `tests/self-hosted-fonts.spec.js` — RD-DS-6: the brand webfonts must be
  **self-hosted**, and the CSP hole that hid it. The Podpultovka restyle loaded
  Darker Grotesque / Figtree / Courier Prime from `fonts.googleapis.com`, which
  production and staging nginx block with `style-src 'self'` + `font-src 'self'
  data:` — measured on staging, `document.fonts.size === 0` and the whole UI fell
  back to Inter. Nothing caught it because **every gate in the effort ran against
  Express with no nginx and therefore no CSP header at all**. Two halves: against
  `BASE_URL`, all three families load and **`/`, `/invite/:code` and `/g/:token`
  each fetch only same-origin subresources** — the assertion that generalises past
  fonts. ⚠ It sweeps three routes because sweeping only `/` demonstrably did not
  generalise: `InviteRegister.vue` was loading the Goriffee logo from
  `www.goriffee.com`, which the prod `img-src 'self' data:` blocks (and which
  404s upstream today), on a route this file never opened. **A new public route
  belongs in that list.** `revolut.me` is excluded on purpose — an `<a href>`
  navigation is not a subresource fetch. The invite logo is additionally asserted
  to *decode* (`naturalWidth > 0`), since a blocked or 404 image is still
  `complete` and still passes `toBeVisible()`. Then, against a throwaway static
  server over `frontend/dist` that sets `deploy/nginx-gorifi.conf`'s **exact** CSP header,
  zero `securitypolicyviolation` events plus the same font assertions. ⚠
  `document.fonts.check()` is NOT used — it returned `true` on staging with zero
  faces loaded; every probe goes through `FontFace.status === 'loaded'` or a real
  rendered-width measurement. Every family is asserted **per subset**, because
  `latin-ext` is where Slovak `č š ž ľ ť ď ň` live and shipping only `latin`
  breaks those letters mid-word — and **per shipped weight**, because one probe
  per family left `courier-prime-700-{latin,latin-ext}` never fetched, so deleting
  those two files kept the suite green. The width probe pre-`document.fonts.load()`s each
  face (a face nothing on screen uses — Courier Prime on the portal — is not
  fetched, and `font-display: swap` would measure it at fallback metrics), and
  measures Courier Prime against `sans-serif` rather than `monospace`: comparing a
  monospace brand face against the *generic* monospace invites a diff small enough
  to be noise, and how small depends on whatever the host resolves `monospace` to,
  so the comparison is made against a family that cannot collide. The last test **reproduces the original
  bug** against the fixture (a Google Fonts `<link>` must raise a `style-src-elem`
  violation), so a green run means "self-hosting works", not "the header never
  arrived". The CSP describe self-skips when `frontend/dist` is absent.
- `tests/portal-transactions-modal.spec.js` — the "Všetky transakcie" dialog, which
  had **no coverage of its own** before this file (the one shipped assertion that
  touched it, `portal-appbar.spec.js:403`, opens it and checks the title is visible).
  It also has **no canon screen** — `portal.jsx:114` has the button and nothing
  behind it — so the file pins the extrapolation: the `NeoModal` shell (teleported
  out of `.app`, `wide`, the × named "Zatvoriť dialóg" so exactly one control answers
  to "Zavrieť", and closing UNMOUNTS so the scrim stops eating clicks), one row per
  transaction with the `sk-SK` date + type label + `cycle_name || note` fallback, the
  `+`/`−` sign rule with `.neg`/danger for a charge and `--ok-deep` for a credit, the
  three-state balance in the subtitle (`.neg.pill` / `.zero` / green `.mono`), and the
  loading / empty / error states — including that a failed load must never read as
  "you have no transactions". ⚠ The 320px test measures the **row and the
  `.modal-scrim`**, not the document: `.modal-scrim` is `overflow-y:auto`, so CSS
  computes its `overflow-x` to `auto` as well and it silently absorbs any spill —
  with `overflow-wrap:anywhere` deleted the document reads a clean 320/320 while the
  row paints 342px inside a 206px column and the modal scrolls sideways by 79px. Any
  future overflow test **inside a modal** has the same trap. Closes with admin
  invariance: `BalanceBadge.vue` (shared with five admin views) is unchanged against
  `main` — a `git diff --stat` test that self-skips off a git checkout — and
  `/admin/friends`, which renders that badge, carries no theme/neo class.
- `seed.mjs` — seeds a backend with an admin password, legacy friends password,
  one cycle, one friend (idempotent; NOT for production). Also fills the payment
  settings (IBAN / Revolut username) **only if they are empty**, because guest
  confirmation needs them — a real environment's values are never overwritten.
- `fixtures.js` — credentials/constants, overridable via env.

## The database is an INPUT — copy the template, never reuse a working file

⚠ **This is the first thing to get right, because getting it wrong produces plausible
wrong results rather than errors.** Fixture accumulation degrades the suite: the same
tree failed 2/15 in 3.7 min against a long-lived `/tmp` DB and passed **15/15 in 19 s**
against a fresh one, and three separate wrong diagnoses were chased before the cause was
found — including a commit bisection for a regression that did not exist. If something
red looks suspicious, **reseed and re-measure before you believe it.**

`./e2e/make-test-db.sh` builds a **template** from production, scrubbed on the server so
unscrubbed data never leaves it. Result: 76 friends, 12 cycles, 226 orders, 20 guest
sub-orders, 486 ledger rows — the shape that shows up bugs a 1-friend seed cannot (an
unbounded list, an N+1, a fold that is fine with 3 rows and unusable with 76).

**Names are KEPT** (PO decision, 2026-08-31 — the screens read like the real thing).
Everything else identifying is regenerated deterministically from the row id, so a friend
keeps one number across rebuilds.

⚠ **Do not read the list of scrubbed columns from this paragraph — read it from
`e2e/scrub-template.sql`, and read what is actually checked from
`e2e/verify-scrub.sql`.** Those two files are the scrub; prose beside them is a fourth
copy waiting to drift, and this section already carried one. The fail-closed check now
covers **one line per column the scrub touches** and prints all 22, because twice it was
narrower than the scrub, which was narrower than the schema:

- **2026-08-31** — `payment_iban` / `payment_revolut_username` (the PO's real bank
  account and Revolut handle) were neither scrubbed nor checked.
- **2026-09-19, GR-T9 review** — `friends.access_token` (76 production values,
  `routes/friends.js:18` calls it "a live auth credential"), `friends.google_email`
  (**11 real third-party Gmail addresses**, sitting beside a `friends.email` that WAS
  correctly randomised), and `invitations.google_sub` / `invitations.google_email` — and
  the `google_sub` is not inert: `routes/invitations.js:572,653` copies it onto the
  friend row at approval and `:321,580` matches on it, so the file shipped a live Google
  identity. All four passed a check that confidently returned `0`.

**A verification narrower than the scrub does not weaken the claim, it launders it.**

```bash
./e2e/make-test-db.sh                      # once, or whenever you want fresher data

# Check (or re-apply) the scrub on a template you already have — same SQL files,
# no server and no sqlite3 CLI needed. Exits non-zero on any non-zero count.
node e2e/scrub-local.mjs --verify          # SQL checks + a raw byte scan
node e2e/scrub-local.mjs --scrub           # apply, then verify
```

The byte scan is there because the SQL checks only see live rows: the scrub ends in
`VACUUM`, and that is the only thing between a deleted row and someone running
`strings` on the file. It reports e-mail addresses whose domain is not `example.test`
and bcrypt prefixes, over the whole file including freed pages.

Then **the recipe in the next section copies it per run** — that block is the one to
follow, and its step order (stop the server → confirm the port is free → replace the
DB → start → seed) is part of the fix, not housekeeping.

⚠ `seed.mjs` is still required on top: the template has no `E2E Test Cycle`/`E2ETester`,
and the password columns are bcrypt hashes SQL cannot produce, so the script deletes them
and `seed.mjs` re-creates them from `fixtures.js`. Running the suite against the
**template itself** reintroduces exactly the accumulation this replaces — and leaves a
`prod-template.sqlite-wal`/`-shm` pair beside it as the evidence. Copy only the
`.sqlite`; if that stray `-wal` is ever non-empty, rebuild the template rather than
copying a file whose newest pages live in a WAL you are not copying.

⚠ **The per-run copy is the whole fix; do NOT add teardown to the `makeCycle`/`makeHost`
helpers** (considered and rejected, GR-T9, 2026-09-19). Two reasons, both checkable:
**24 spec files define their own private `makeCycle` and/or `makeHost`** (21 and 16, with
13 defining both), so teardown means 24 edits with 24 chances to diverge — the multi-copy failure this row is about; and a
helper that deleted its cycle would have to unwind the same cascade the app owns
(orders, guest links, sub-orders, ledger rows), which no helper does today. Measured:
four back-to-back `share-dialog` runs against one already-used copy took 15.8 / 16.1 /
16.4 s, all 15/15 — against the 3.7 min and 2 failures that started this row. The copy
buys that isolation with no new code.

## Run against a local prod-like backend

⚠ **The database in this recipe is a PER-RUN COPY, and the numbered order is
load-bearing** — see the section above for why, and the "replace the DB, not under a
running server" gotcha below for what happens when you do steps 2–4 in any other
order. This block is verified end-to-end (GR-T9, 2026-09-19); run it as written.

```bash
# 1 — build the frontend into backend/public (git-ignored; a missing one answers 503)
cd frontend && npm run build && rm -rf ../backend/public && cp -r dist ../backend/public && cd ..

# 2 — STOP whatever holds the port, BY THE PID THAT OWNS IT, and confirm it is free.
#     `pkill -f node` self-matches; `ss` names the one process that actually matters.
PID=$(ss -lptnH 'sport = :3997' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ -n "$PID" ] && kill "$PID"
# ⚠ `kill` returns before the process is gone — WAIT for the port, don't just look.
for i in $(seq 1 10); do ss -lptnH 'sport = :3997' | grep -q . || break; sleep 1; done
ss -lptnH 'sport = :3997'        # ⚠ must print NOTHING before you go on

# 3 — a PER-RUN database. ONLY NOW, with nothing holding the old one open.
RUN_DB=$(mktemp -u /tmp/gorifi-run-XXXXXX.sqlite)
cp e2e/fixtures/prod-template.sqlite "$RUN_DB"   # no template? omit this line:
                                                 # a nonexistent path is created and
                                                 # seeded from scratch (1 friend, 1
                                                 # cycle) — still per-run.

# 4 — start the backend on that copy
DB_PATH="$RUN_DB" PORT=3997 CORS_ORIGIN=http://localhost:3997 \
  GOOGLE_CLIENT_ID=test-client GOOGLE_AUTH_TEST_MODE=1 \
  RATE_LIMIT_AUTH_MAX=1000 RATE_LIMIT_ABUSE_MAX=2000 \
  RATE_LIMIT_GUEST_READ_MAX=5000 RATE_LIMIT_GUEST_WRITE_MAX=5000 \
  RATE_LIMIT_MAGIC_MAX=5000 \
  setsid node backend/src/index.js > /tmp/gorifi-e2e-server.log 2>&1 </dev/null &
# ⚠ /api/health, NOT /api/cycles — `cycles` is requireAdmin and answers 401, so
#   `curl -sf` there NEVER succeeds and the wait degrades into a silent 15 s sleep.
#   The trailing re-check is what makes a dead backend loud instead of a confusing
#   seed failure ten seconds later.
for i in $(seq 1 30); do curl -sf http://localhost:3997/api/health >/dev/null && break; sleep 1; done
curl -sf http://localhost:3997/api/health >/dev/null \
  || { echo "!! backend never came up — read /tmp/gorifi-e2e-server.log"; exit 1; }

# 5 — the suite's own fixtures ON TOP of the template
cd e2e
npm install && npx playwright install --with-deps chromium   # first time only
BASE_URL=http://localhost:3997 node seed.mjs
# ⚠ It must say `cycle: created` / `friend: created`. `exists` means you are talking
#   to a server that is NOT on your fresh copy — stop and read the gotcha below.

# 6 — run. DB_PATH is optional: no spec requires it any more. When it points at the
#     same file the server was started with, guest-admin-view.spec.js adds one extra
#     assertion (a GLOBAL `transactions` row count around the guest paid toggle,
#     which also catches a row written with a NULL friend_id).
DB_PATH="$RUN_DB" BASE_URL=http://localhost:3997 npm test -- --workers=1
```

Gotchas in that recipe that look like app bugs when you skip them:

- ⚠ **Free the port BEFORE you start the new server — that is why step 2 comes before
  step 4, and the failure is silent.** Leave the old backend running and the new one
  dies instantly with `EADDRINUSE` **in its own log only**; the port stays owned by
  the old process, so every request — `seed.mjs` included — lands on **its** database,
  not the fresh copy you just made. Nothing errors. The run measures the wrong data.
  **The tell is `seed.mjs` printing `cycle: exists` / `friend: exists` (and
  `admin: already set up`) on what should be a fresh copy** — if you see that, stop.
  Order: **stop by the owning PID → confirm the port is free → copy the DB → start →
  seed.** Verified 2026-09-19 (GR-T9).
  ⚠ Related, if you reuse a fixed DB path instead of `mktemp`: `rm` + `cp` over a file
  a server still holds open leaves that process on the **deleted inode**
  (`/proc/<pid>/fd/20 → …run.sqlite (deleted)`, measured) while your copy sits unused,
  and a plain `cp` onto the path is worse — it truncates in place and corrupts an open
  database. A fresh `mktemp -u` name per run, as in step 3, has neither problem.
- **`CORS_ORIGIN=http://localhost:PORT` is required**, not optional. The built
  SPA uses `crossorigin` script tags, so serving it from `backend/public` on a
  bare `localhost:PORT` without that origin allow-listed makes the asset
  requests 500 — every UI spec then fails on a blank page.
- **Start a fresh server.** A backend left running from an earlier session keeps
  serving from a `backend/public` whose hashed asset files have since been
  replaced under it (`rm -rf` + rebuild), so `express.static` 500s and the UI
  specs fail for reasons that have nothing to do with your diff. Check the port
  is actually free (`ss -ltnp | grep PORT`) — a stale process silently keeps the
  old CODE too, which reads as a mass regression in whatever you just changed.
- ⚠ **`invitation-approval.spec.js` is mail-aware: prefer a LOCAL target for it.**
  Approval mails the credentials to the invitation's address, and the documented
  staging target (`BASE_URL=https://gorifi-dev.skolar.sk`) HAS the Mailgun secrets
  in its `.env` — so run naively there, every approval in that file would fire a
  real send to an `@example.test` address, which hard-bounces on the brand's only
  sending domain. Two guards make that safe: off a local `BASE_URL` the fixtures
  carry **no** e-mail address (approval reports `no_recipient`, the transport is
  never touched), and the handful of tests that need a real send outcome
  `test.skip` with `NEEDS_LOCAL_TARGET`. Consequence to know: against staging that
  file runs with a couple of skips and its "e-mail carried over to the friend"
  assertion compares NULL to NULL. **Any new test there that approves an
  e-mail-bearing invitation must use `fixtureEmail()` or carry the same skip.**
- ⚠ **`PUBLIC_BASE_URL` on the target must match its `BASE_URL`, or leave it unset.**
  The credential message (clipboard *and* e-mail body) is rendered by the server,
  and the dialog's copy assertion compares it against `window.location.origin`. A
  target that sets `PUBLIC_BASE_URL` to some other host makes that mismatch — a
  real config difference, not a bug in the view. ⚠ Since 08 §UC-EM-004 the STAGING
  `.env` pins `PUBLIC_BASE_URL=https://podpultovka.biz` (same value as prod —
  resolved 2026-08-15), so against `BASE_URL=https://gorifi-dev.skolar.sk` that
  mismatch is now the EXPECTED state, and the affected copy assertions fail there
  by design; the server's boot line (`[mail] PUBLIC_BASE_URL=…` in out.log) tells
  you which way the target resolved.
- ⚠ **NEVER give the server under test any `MAILGUN_*` env var** (07 §UC-IA-009).
  `backend/src/helpers/mailer.js` is a no-op unless `MAILGUN_API_KEY`,
  `MAILGUN_DOMAIN` and `MAILGUN_BASE_URL` are ALL set, and that no-op is the only
  thing standing between an approval in `invitation-approval.spec.js` and a real
  e-mail to a real address. The two tests that need a live transport
  (`Approval + Mailgun — the stubbed transport`) spawn their OWN throwaway backend
  with a FAKE key and `MAILGUN_BASE_URL` on 127.0.0.1, and blank the three vars
  first so an operator's real key cannot be inherited from the ambient
  environment. They self-skip when the backend source is not beside `e2e/`
  (i.e. when `BASE_URL` points at a deployment).
- **`GOOGLE_CLIENT_ID` / `GOOGLE_AUTH_TEST_MODE` (10 §UC-GA-002, GA-T2).** The
  second outbound dependency follows the mailer's model: with `GOOGLE_CLIENT_ID`
  absent the whole feature is off and `helpers/google-auth.js` makes **no network
  call at all**, so a gate server with neither var set is Google-free by
  construction. `google-auth-verifier.spec.js` needs BOTH states, so it never
  depends on how the gate server is configured — it spawns its own throwaway
  backends (`startBackend`, which now blanks both vars first, the `MAILGUN_*`
  rule) and drives the helper itself in a child process (the `sendViaMailer`
  precedent; there is no unit runner). ⚠ Once module 10 ships an ENDPOINT
  (GA-T4 onward) the gate server does need `GOOGLE_CLIENT_ID=test-client` +
  `GOOGLE_AUTH_TEST_MODE=1` per §UC-GA-013 — that is additive and does not move
  anything asserted here. ⚠ `GOOGLE_AUTH_TEST_MODE` must NEVER appear in a
  deployed `.env`: it makes `TEST:<sub>:<email>` tokens verify without any
  signature check. The audit signal is the boot line, which always names the
  resolved mode (`mode=off` / `mode=google` / `mode=TEST`). ⚠ The var is an
  **allow-list** — only `1` and `true` turn it on, so `GOOGLE_AUTH_TEST_MODE=off`
  is genuinely off. Two further vars are honoured **only** while it is on and
  exist purely for this spec: `GOOGLE_AUTH_TEST_CERTS_URL` (⚠ **loopback hosts
  only**) and `GOOGLE_AUTH_TEST_TIMEOUT_MS`.

### Friend-portal UI specs and the friends-list stub

**⚠ The stub is DEAD. Do not copy it into new specs.** This section used to say
friend-UI specs must `page.route`-stub `GET /api/friends?active=true`, because
`FriendPortal.loadInitialData()` resolved the stored session against it and that
endpoint is `requireAdmin`-gated (SEC-A*). **That is no longer what the view
does**, and hasn't been since the login-list split:

- the legacy name dropdown reads the **public** `GET /api/friends/login-list`
  (`backend/src/routes/friends.js`) — id + name + `hasCredentials` only, and an
  empty array in modern mode, so no admin gate is involved;
- the session restore builds `currentFriend` straight from the stored
  `gorifi_friend_auth` entry and then hydrates it over
  `GET /api/friends/:id/profile`, which is **owner-token** gated, not admin;
- `api.getFriends()` (the admin-only list) now has exactly one caller left,
  `AdminFriends.vue`.

So the stub matches a request the portal never sends. It is harmless — an
unmatched `page.route` just never fires — but it advertises a dependency that
does not exist. `guest-link.spec.js:224` and `guest-host-view.spec.js:637` still
carry it and its stale comment; they were left untouched rather than edited
under an unrelated row, so **read them as legacy, not as the pattern**.
`portal-appbar.spec.js` is the current idiom: seed the session, stub nothing but
the responses actually under test.

What IS still true, and is why specs seed `localStorage` instead of clicking
through a login: a **cold deep-link** to `/cycle/:id` bounces to `/` regardless
of a valid stored session, because `FriendOrder.vue`'s `onMounted` deliberately
delegates restore to `FriendPortal` rather than doing it itself. Signing in and
then navigating from the portal works fine.

`forced-change-ui.spec.js` is `test.fixme` for its own unrelated reason (stated
in the file): the legacy login is a radix-vue `Select` that needs a robust
interaction, and the flow is already covered at API level in
`auth-ownership.spec.js`. It is **not** blocked on any friends-list gap — specs
that need the redesigned username/password card stub `GET /friends/auth-mode`
per page instead (see `modern-login.spec.js`, which explains at length why
flipping `auth_mode` for real is unsafe).

### Full-suite runs and the shared auth-limiter budget

`authLimiter` (`backend/src/middleware/rate-limit.js`) guards both
`/admin/login` and `/friends/auth` behind ONE shared per-IP bucket
(`RATE_LIMIT_AUTH_MAX`, default 20 per 15 min window). Every spec runs from
the same test-runner IP, and several specs each perform their own
login/friend-auth calls — run the **full** suite repeatedly against the same
long-lived server (e.g. iterating locally without restarting it) and the
shared bucket exhausts, producing real `429`s that look like unrelated
failures (wrong-password checks, invite-code lookups, `item-packed.spec.js`'s
`beforeAll` admin login, etc.) even though nothing is actually broken. This
is suite/environment fragility, not a spec bug — a single run against a
freshly-seeded server passes cleanly.

Mitigations:
- Prefer a **fresh** DB + freshly-started server per full-suite run (matches
  the recipe above) rather than re-running against a server that has already
  served many earlier runs.
- If you must re-run repeatedly against the same long-lived server, start it
  with a generous budget, e.g. `RATE_LIMIT_AUTH_MAX=1000`, to get a true
  pass/fail signal (`rate-limit.spec.js` still self-skips above 10, so this
  doesn't weaken that check).

The same applies to the other limiters, each of which is its **own** bucket:

- `abuseLimiter` (`RATE_LIMIT_ABUSE_MAX`, default 40) — invite-code lookup and
  onboarding submit.
- `guestReadLimiter` (`RATE_LIMIT_GUEST_READ_MAX`, default 300) — guest page loads.
- `guestWriteLimiter` (`RATE_LIMIT_GUEST_WRITE_MAX`, default 60) — guest submits,
  edits and invite requests.
- `magicLinkLimiter` (`RATE_LIMIT_MAGIC_MAX`, default 10) — `POST
  /api/magic-link/request`; `magic-link-rate-limit.spec.js` self-skips above 10.
  ⚠ The lowest default of the five, and the easiest to trip: `magic-link.spec.js`
  issues **20** requests to that route and the limiter counts the 400s too, so
  without this raised you get `429` from request 11 onward.

The guest surface has its own buckets on purpose (a whole office shares one NAT'd
IP, so it must not compete with registrations), but the suite still drives far more
guest traffic than a real office does — `guest-order.spec.js` alone makes ~35 calls
— so a full run against the defaults can 429 in unrelated-looking places. Give every
limiter a generous budget:

⚠ **All five are already on the server-start line in step 4 of the recipe above, and
there is deliberately NO second copy of that command here.** Two sections of this file
disagreeing about how to start the backend is exactly what created GR-T9 — and a copy
in this section would be worse than merely redundant: it would reference `$RUN_DB`,
which is only defined by step 3, and it would omit the Google vars, `setsid`, the log
redirect and the stdin redirect. Raise the limits there, in the one runnable block.

⚠ With all five raised, `rate-limit*.spec.js` and `magic-link-rate-limit.spec.js`
self-skip — those are the documented skips, not a hole.

**`backend/public` is git-ignored build output** — the build step in the recipe
above is mandatory, not a convenience. Production never uses it (nginx serves
`frontend/dist`), and if it is missing the backend answers non-API routes with a
503 telling you to build. It used to be committed, which silently served a
months-old frontend against current API code.

## Run against staging

```bash
cd e2e
# staging must already be seeded; pass the real credentials so auth'd tests work
BASE_URL=https://gorifi-dev.skolar.sk \
  ADMIN_PASSWORD='<staging admin pw>' \
  FRIENDS_PASSWORD='<staging friends pw>' \
  FRIEND_NAME='<an existing friend>' \
  CYCLE_NAME='<an existing cycle>' \
  npm test
```

Without staging credentials you can still run the anonymous checks, which must
all pass once Phase 1 is deployed:

```bash
BASE_URL=https://gorifi-dev.skolar.sk npx playwright test api-security \
  --grep "without an admin token|stays public"
```
