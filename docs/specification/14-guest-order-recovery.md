# 14 — Guest order recovery + admin guest controls

> Scope: The recovery layer for guest sub-orders, opened by the Martina Tomašová
> production incident (a paid guest lost her status URL to a host's link regeneration,
> and nobody — guest, host or admin — could reach or cancel the order). Six areas:
> (a) the guest's status/edit URL is DECOUPLED from the share link — new canonical form
> `/g/o/:orderToken` (SPA route + API), with the old pair form kept working forever and
> resolving by `order_token` alone; (b) admin READ + CREATE of every host's share link
> (revocation stays host-only, an explicit non-capability); (c) an admin soft-cancel of
> a guest sub-order with NO paid blockade (paid+cancelled lands in the existing refund
> queue); (d) `order_token` published to the host and the admin for resending — a
> conscious reversal of the GSO-T2 exclusion rule; (e) standing copy in the share
> dialog (one link for all colleagues; regeneration is for a leak); (f) a guest
> order-confirmation e-mail on submit when the guest entered an e-mail, carrying the
> canonical status URL "aby link mali uložený" (PO follow-up, same session —
> UC-GR-011, riding module 08's mail seam unchanged). ⚠ Unlike modules
> 02–06 this module INCLUDES backend changes (routes + helpers + `api.js`), but **NO
> schema change** — `guest_orders.order_token TEXT UNIQUE NOT NULL` already exists
> (`backend/src/db/schema.js`, guest tables block).
> Out of scope (handoffs): **cart-contents statistics** (PO: "Neskôr môžeme dorobiť
> samostatnú štatistiku, ktorá zobrazí čo ľudia majú v košíku" — explicitly later);
> **admin cancel of a registered friend's order** (friends self-cancel already; PO
> narrowed requirement 2 to guests only); **any payment-flow change**; **any change to
> stock/pricing/packing/aggregation seams** (`helpers/stock.js`, `helpers/pricing.js`,
> `helpers/packing.js`, `helpers/guest-aggregation.js` are untouched — the cancelled
> status predicate remains the release mechanism everywhere).
> Actors: **Guest** — holds the status URL; their surfaces gain the canonical URL form
> but no new capability; additionally receives a confirmation e-mail on submit when
> they entered an e-mail (UC-GR-011). **Friend (host)** — gains a per-sub-order copy affordance
> (resend); keeps sole revocation power over their link; their DELETE keeps the paid
> 409. **Admin** — gains link read/create, sub-order cancel, and the resend URL; still
> the sole owner of `paid` (Decision 2), never a writer of `delivered`.
> Sources: `docs/raw-sources/2026-08-26-guest-order-recovery.md` (the incident + PO
> decisions, confirmed 2026-08-26 — the NEWEST source; wins every conflict below);
> `docs/superpowers/specs/2026-07-18-guest-shared-orders-design.md` (Decisions 1, 2, 6,
> 7, 8 — Decision 6's URL model is amended here); `docs/specification/08-transactional-email.md`
> (the mail seam UC-GR-011 consumes: `renderEmail`/`sendMail`, the three mailer rules,
> `PUBLIC_BASE_URL`); repo `CLAUDE.md` (GSO-T2..T10 rules,
> ADMIN_ENDPOINTS rule, mixed-router rule, `loadSeq`/per-row-pending conventions,
> Slovak vy-form register); repo code (`backend/src/routes/guest.js`,
> `guest-links.js`, `guest-orders.js`, `orders.js:640-681`,
> `backend/src/helpers/guest-orders.js`, `backend/src/helpers/mailer.js`,
> `backend/src/helpers/credentials-message.js` (`resolveLoginUrl`),
> `backend/src/routes/magic-link.js` (the fire-and-forget send precedent),
> `e2e/mailgun-harness.js`, `backend/src/db/schema.js`,
> `frontend/src/router.js`, `frontend/src/api.js`, `GuestShareDialog.vue`,
> `GuestSubOrders.vue`, `GuestOrder.vue`, `GuestOrderStatus.vue`, `CycleDetail.vue`);
> shipped e2e specs (`guest-status`, `guest-host-view`, `guest-admin-view`,
> `guest-order`, `guest-payment-modal`, `guest-invite-dead`, `share-dialog`,
> `guest-link`, `api-security`). The most recent decision wins on conflict.
> **Design reference:** no prototype screen exists for this module. Friend-surface
> additions compose from module 02 primitives inside module 05's shipped structures;
> admin additions keep the current shadcn look (01-architecture §Design system scope
> rule — admin views never use `neo/` classes or theme tokens).

---

## Resolved conflicts (recency / canonicity)

1. **GSO-T2's "never expose `order_token`" vs PO requirement 3.** The 2026-08-26 PO
   decision wins: `order_token` is published to the host and the admin for resending
   (UC-GR-006). The GSO-T2 rule's *credential* half survives: `routes/guest.js`
   remains the ONLY place `order_token` authenticates anything.
2. **GSO-T4 / Decision 6's "the PAIR is the credential" vs the decouple decision.**
   The pair-strict model is REJECTED: it is precisely what stranded the incident's
   guest (her URL's link half died with the regeneration while her order lived on),
   and the PO decision says regeneration "no longer kills links to already-created
   orders". `order_token` alone is the credential from this module on (UC-GR-001/002)
   — it has the same entropy as the link token (both `generateGuestToken()`, 14 chars,
   `crypto.randomInt` over `CODE_ALPHABET`, SEC-S2), so nothing is weakened.
   The alternative (keep the pair strict, rely on the new form only) is REJECTED
   because nobody migrates the guests: the old URL lives in their messages and in
   `localStorage.gorifi_guest_orders`, and a strict pair leaves every
   pre-regeneration URL 404 forever — the incident unfixed.
3. **GSO-T5's "escalate a paid cancel to the admin" was a dead end** — the admin had
   no cancel route at all (`guest-orders.js` admin surface is only `/paid` and
   `/unpaid`). UC-GR-005 gives the escalation a working target. The host's own
   `DELETE /api/guest-orders/:id` keeps its 409 `reason:'paid'` unchanged
   (`guest-orders.js:172-177` and the in-transaction re-check at :194).
4. **Old URLs are not migrated; the canonical form is handed out from now on**
   (raw source). Spec-author decision recorded in UC-GR-002: the legacy pair PAGE
   route additionally re-canonicalises the address bar via `router.replace` after a
   successful load, so re-copied URLs converge on the canonical form over time.

---

## UC-GR-001 Canonical order URL — resolver + API routes `/api/guest/o/:orderToken` (Guest)

**Goal:** the guest's status/edit surface becomes reachable by `order_token` alone,
independent of the share link's current token.

**New resolver (in `routes/guest.js`):** `resolveGuestOrderByOrderToken(orderToken)` —
looks the sub-order up by `order_token` (`String(orderToken || '')` coercion, as the
shipped `resolveGuestOrder` at guest.js:336-349 does), then joins its link
(`guest_orders.link_id → guest_order_links`, which always exists — FK) with the host
row (`host_name`, `host_active`) and the cycle. **404-only** (the GSO-T4 read
asymmetry, preserved verbatim): an unknown order token, and the degenerate missing-
cycle case, both answer `{ status: 404, error: 'Táto objednávka neexistuje' }` — the
same message the pair resolver uses, so the endpoint is not an oracle. It returns the
same `{ link, cycle, order }` shape as `resolveGuestOrder`, so `statusPayload()`
(guest.js:369-441) is consumed unchanged — including `items_editable` (the pinned
GSO-T6 shape) and `invite_request`.

**New routes (all in `routes/guest.js` — mounted BARE at `/api/guest`, the URL token
IS the credential; hostile input boundary, GSO-T3 contract):**

| Route | Limiter | Behaviour |
|---|---|---|
| `GET /api/guest/o/:orderToken` | `guestReadLimiter` | `statusPayload` — 404-only read, byte-identical payload to the pair GET |
| `PUT /api/guest/o/:orderToken` | `guestWriteLimiter` | the shipped edit contract, verbatim |
| `POST /api/guest/o/:orderToken/invite-request` | `guestWriteLimiter` | the shipped lead-capture contract, verbatim |

**Business rules:**

- **Shared handlers, never forked.** The existing GET/PUT/invite-request handler
  bodies (guest.js:568-575, :592-766, :801-861) are extracted into functions taking a
  resolved `{ link, cycle, order }`; both URL forms call the same functions. Two
  copies of the paid-freeze guard or the `items: []` cancel-only rule is how one of
  them stops enforcing it.
- **Every write gate survives verbatim** (the GSO-T4 read/write asymmetry): PUT
  re-applies 410 inactive link/host, 409 `closed` (cycle not open), 409 `cancelled`
  (terminal), 409 `paid` for a non-empty edit (re-checked inside the write
  transaction), 400 bounds/malformed-`items`; only a literal `items: []` cancels.
  invite-request keeps its 404/410/409/400 gating exactly (a locked cycle and a
  cancelled sub-order still 201; a dead link/host 410s).
- **Route-ordering hazard, stated for the implementer:** Express matches in
  registration order, so the `/o/…` routes MUST be registered BEFORE `GET /:token` /
  `POST /:token/orders` / the pair routes in `routes/guest.js`. No collision is
  possible: `generateGuestToken()` emits 14 chars from the unambiguous uppercase
  `CODE_ALPHABET`, which can never equal the literal segment `o`.
- **No new limiter buckets** — the routes join the existing `guestReadLimiter` /
  `guestWriteLimiter` (the office-NAT reasoning in CLAUDE.md §Rate-limit buckets is
  unchanged by the URL form).
- ⚠ These routes are PUBLIC by design and must **never** join `ADMIN_ENDPOINTS`
  (the same warning api-security.spec.js:42-48 carries for the Google login routes).

**Acceptance criteria:** `GET /api/guest/o/<token>` returns the identical payload as
the pair GET for the same order; a PUT through the new form edits/cancels under
exactly the shipped gates; an unknown token answers 404 with `'Táto objednávka
neexistuje'`; a locked cycle still GETs 200 with `editable: false` and the payment
block (the incident's guest can always see what she owes).

---

## UC-GR-002 Legacy pair form — resolves by `order_token`, link half ignored (Guest)

**Goal:** every URL already sitting in a message or in `localStorage` keeps working
**forever**, including after the host regenerates their share link (the incident's
exact state).

**Business rules:**

- The three pair routes (`GET`/`PUT /:token/orders/:orderToken`,
  `POST /:token/orders/:orderToken/invite-request`) delegate to the SAME shared
  handlers as UC-GR-001, resolved by `resolveGuestOrderByOrderToken(orderToken)`. The
  `:token` half is **ignored for resolution and authorization** — it is legacy URL
  carriage, nothing more. `resolveGuestOrder(token, orderToken)` (the pair-strict
  resolver, guest.js:336-349) is retired.
- **Stale-half log:** when the URL's link half differs from the order's CURRENT link
  token, the handler MAY log one line carrying `guest_orders.id` only — ⚠ **never a
  token** (either half): a token in a log line is a credential in logs.
- **The no-oracle property is restated, not lost:** an unknown `order_token` answers
  the same 404 message regardless of the link half; a VALID `order_token` under any
  link half (current, retired, foreign, garbage) resolves to the same order and the
  same payload. What is retired is only the cross-link 404 — `order_token` is a full
  standalone credential of identical entropy (resolved conflict 2), so resolving it
  under a foreign link half grants nothing the canonical form does not.
- **Regeneration keeps its whole purpose on the ORDERING surface:** `resolveLink()`
  (guest.js:182-207) is untouched, so `/g/:oldToken` (listing) and
  `POST /:oldToken/orders` (new submits) still 404 after a regeneration — nobody new
  can order through a leaked link. Only links to *already-created* orders survive it.
- **SPA route `/g/:token/o/:orderToken` stays registered** (router.js:25-29) and its
  component (`GuestOrderStatus.vue`) reads only `orderToken`. After a successful
  load, the view `router.replace`s to `/g/o/:orderToken` (resolved conflict 4) so the
  address bar — and anything re-copied from it — is canonical. On a 404 there is no
  replace: the dead card (06 §UC-GX-010) keeps the URL the guest actually followed.

**Acceptance criteria (the incident, as a test):** guest submits through link token
T1 → host regenerates (token becomes T2, same row — guest-links.js:51-59) → the
guest's saved `/g/T1/o/<orderToken>` URL **still renders their order** (page and API),
the guest can still cancel it, and `/g/T1` itself still 404s for a new visitor;
`/g/T2/o/<orderToken>` and `/g/o/<orderToken>` resolve the same order.

---

## UC-GR-003 Handing out the canonical URL (Guest)

**Goal:** every place the app itself composes or hands out a status URL switches to
the canonical `/g/o/:orderToken` form. Guests holding old URLs are not migrated.

**Business rules:**

- **Submit response:** `status_path` (guest.js:557) becomes
  `` `/g/o/${order.order_token}` ``. `GuestOrder.vue` consumes `status_path` verbatim
  (confirmation copy row, `status_url` in localStorage, the "Zobraziť stav objednávky"
  `router.push` — GuestOrder.vue:211-213, :262), so the confirmation screen follows
  automatically; no composed URL exists there (06 §UC-GX-004 item 6's rule holds).
- **Status page self-composition:** `GuestOrderStatus.vue:227` composes
  `status_url` from route params — it becomes `` `${origin}/g/o/${orderToken}` ``.
- **localStorage (`gorifi_guest_orders`): SHAPE UNCHANGED.** Entries stay keyed by
  link token with `order_token` inside — old entries keep working because the pair
  form keeps working (UC-GR-002). On the canonical route (no `token` param),
  `refreshStoredEntry` must **update-by-scan** — find any stored entry whose
  `order_token` matches and refresh its fields (writing the canonical `status_url`)
  — and must **never create a new entry** (there is no link token to key one on).
- The host/admin copy affordances (UC-GR-007/008) compose the canonical form ONLY —
  the pair form is legacy carriage, never newly emitted.

**Acceptance criteria:** the confirmation copy row and the stored `status_url` match
`/g\/o\/[A-Z2-9]{12,}$/`; "Zobraziť stav objednávky" lands on the same URL the copy
row shows; a pre-existing pair-form localStorage entry still opens the order.

---

## UC-GR-004 Admin reads + creates host share links (Admin)

**Goal:** PO requirement 1 — "Ja ako administrátor by som mal vedieť link pre hosťa
každého užívateľa (aby som im ho mohol v prípade potreby preposlať)."

**Router placement:** both routes live in `routes/guest-links.js`, which thereby
becomes a **MIXED router** (the `guest-orders.js` precedent): mounted BARE, gated
PER ROUTE — the existing three routes stay on `requireHost()` identity, the two new
ones carry `requireAdmin` on their own line. ⚠ Never wrap the mount in either guard;
the router's header comment must state the mix (the guest-orders.js:17-27 idiom).

**`GET /api/guest-links/cycle/:cycleId/all`** — `requireAdmin`.

- 404 unknown cycle. Otherwise `{ links: [{ id, token, active, created_at,
  host_friend_id, host_name, host_active }] }` — every share link of the cycle
  (`JOIN friends` for the host name/active flag). `LINK_COLUMNS`
  (guest-links.js:8) is reused; **`order_token` is not link data and does not appear
  here** (it rides the sub-order rows, UC-GR-006).
- **Deliberately a separate endpoint, not a fold into the orders-tab payload**
  (`GET /api/orders/cycle/:cycleId`, orders.js:640-681): that payload is built over
  friend orders and already carries the nested `guest_orders`; link data has its one
  home in `guest-links.js`, and keeping it out of `orders.js`/`cycles.js` avoids the
  whole JOIN-multiplication class the GSO-T6/T8 notes warn about. The frontend joins
  the two payloads by `host_friend_id` (UC-GR-008). Alternative (folding) REJECTED.

**`POST /api/guest-links/cycle/:cycleId/host/:friendId`** — `requireAdmin`,
create-if-missing:

- 404 unknown cycle; 404 unknown friend; **409 `reason:'inactive_host'`** for a
  deactivated friend (their link 410s for every guest — guest.js:192-194 — so
  creating one would hand the admin a dead URL as if it worked).
- Link exists for `(friendId, cycleId)` ⇒ **200 `{ link, created: false }`** — the
  row is returned untouched: ⚠ **the token is NEVER regenerated and `active` is
  NEVER written** by this route (see the non-capability below). An inactive existing
  link is returned with `active: 0` so the admin sees the state.
- No link ⇒ INSERT via the existing `uniqueToken()` with `active = 1` ⇒
  **201 `{ link, created: true }`**. The host sees it on their next dialog open
  (`GET /guest-links/cycle/:id` returns it) — no notification mechanism exists or is
  added.
- No cycle-status gate, mirroring the host's own POST (guest-links.js:40-68 checks
  only existence) — a link for a non-open cycle is inert anyway (`resolveLink` 410s).

**Explicit NON-capability (PO decision, verbatim intent):** the admin has **no
regenerate and no deactivate/reactivate** on guest links. Revocation stays host-only
(`PATCH /guest-links/:id`, `requireHost` + ownership). Reason: the host is the one who
distributed the URL and the only person who knows who holds it — an admin regenerate
would silently sever colleagues mid-order, and an admin *reactivate* would republish a
link the host deliberately revoked after a leak. Any future admin route on this router
that writes `token` or `active` violates this UC.

**`ADMIN_ENDPOINTS` additions (the standing CLAUDE.md rule — UC-GR-010 item 1):**
`GET /api/guest-links/cycle/1/all` and `POST /api/guest-links/cycle/1/host/1`.
⚠ The three existing host routes stay in `FRIEND_IDENTITY_ENDPOINTS`
(api-security.spec.js:143-159) — the two sweeps must not be merged.

**Acceptance criteria:** anonymous and admin-token-less calls 401; the read returns
every host's link with the token; POST on an existing link returns the SAME token
(regenerate-proof: token asserted unchanged) and flips nothing; POST for a linkless
friend creates an active link the host's own GET then returns; a friend Bearer token
gets 401 on both.

---

## UC-GR-005 Admin cancels a guest sub-order (Admin)

**Goal:** PO requirement 2 (narrowed to guests): the admin can call off a guest
sub-order — including a PAID one, which the host's DELETE refuses by design.

**Route:** `POST /api/guest-orders/:id/cancel` — `requireAdmin`, added to the MIXED
`/api/guest-orders` router (guard stated on the route's first lines, per the router's
header contract at guest-orders.js:17-27). ⚠ Never wrap the mount.

**Contract:**

- **404** — unknown sub-order (`findSubOrderWithLink`).
- **Already cancelled ⇒ 200** with `already_cancelled: true` — idempotent, the
  GSO-T5 precedent (guest-orders.js:149-151): the requested end state is already the
  current one; a double click must not error.
- **NO paid blockade.** A paid sub-order cancels cleanly, and `paid = 1 AND
  status = 'cancelled'` lands in the EXISTING refund queue
  (`GET /api/guest-orders/cycle/:cycleId/unpaid` → `refunds`, guest-orders.js:341,
  with `amount` recomputed from the kept item rows at :311-313). **The refund queue
  is the INTENDED landing**, not a side effect — this is the admin acting on the
  escalation the host's paid-409 points at ("Zrušenie vyriešte so správcom"). The
  admin refunds out-of-band and then clears `paid`, which takes the row off the queue.
- **Cycle gate:** available while the cycle is `open` (the incident's state — the PO's
  "Rušenie objednávky musí byť dostupné ešte pred uzavretím cyklu"). A non-open cycle
  answers **409 `reason:'closed'`** — the SAME gate as the host's DELETE
  (guest-orders.js:179-184), decided and recorded here (Decision D5 below): post-lock
  the coffee is already bought from the roastery and distribution has begun, so
  calling an order off no longer releases anything real; the money question is
  handled by the `paid` flag and the refund queue, both of which the admin can work
  post-lock without cancelling.
- **Write (inside one transaction, re-checking the cycle is still open — the
  guest-orders.js:186-204 template):**
  `UPDATE guest_orders SET status = 'cancelled', total = 0 WHERE id = ? AND
  COALESCE(status,'submitted') <> 'cancelled'` — a **SOFT cancel**: the
  `guest_order_items` rows are **KEPT** (the status predicate is the release
  mechanism in `helpers/stock.js` and the filter every consumer applies — GSO-T4/T5
  rule), and `paid`/`paid_at`/`delivered`/`delivered_at` are **untouched** (the
  record of what had already happened; `paid` staying 1 is exactly what routes the
  row to the refund queue).
- ⚠ **NO `transactions` row, ever** (Decision 1 / the GSO-T6 lesson): guests have no
  `friend_id` and no balance; a stray row would corrupt a real friend's balance.
  Pinned by a before/after row count in the module's e2e (UC-GR-010).
- **Response:** `mutationPayload(row)` (guest-orders.js:64-69) — the same enriched
  shape as every other mutation on this router.
- **The host's `DELETE /api/guest-orders/:id` is UNCHANGED** — 409 `reason:'paid'`
  stays (resolved conflict 3), 409 `closed` stays, idempotent-200 stays. The guest's
  own `items: []` cancel path (incl. of a paid order) is also unchanged.
- **Guest visibility:** an admin-cancelled sub-order renders through the guest's
  existing terminal cancelled state (06 §UC-GX-006 — the read resolver is 404-only,
  so the page still loads) — no client change needed on the guest surface.

**`ADMIN_ENDPOINTS` addition:** `POST /api/guest-orders/1/cancel` (UC-GR-010 item 1).

**Acceptance criteria:** cancel of an unpaid order releases its stock
(`remaining_g` recovers) and drops it from `unpaid`; cancel of a PAID order appears
in `refunds` with the item-recomputed amount; a second cancel is 200
`already_cancelled`; a locked cycle answers 409 `closed`; the `transactions` row
count is unmoved; anonymous/friend-token calls 401.

---

## UC-GR-006 `order_token` published to host and admin (system)

**Goal:** PO requirement 3 — the host (and the admin) can resend a colleague's
personal order URL. **This is a conscious reversal of the GSO-T2 exclusion rule**
("`order_token` is deliberately absent from every column list in
`helpers/guest-orders.js`").

**Security reasoning (recorded, the reversal's justification):** the host already
sees the guest's full identity (name, phone, e-mail), every item, the totals, the
paid flag, and can cancel any UNPAID sub-order outright (`DELETE`). The admin sees
strictly more. The marginal capability the token adds is **acting on the guest's
items through the guest surface**: editing them while the cycle is open and unpaid,
and cancelling — including a PAID sub-order via the guest's own `items: []` path,
which the host's DELETE refuses. That last edge is accepted because the guest path's
cancel leaves the refund-queue trace (guest.js paid-freeze commentary at :657-666):
money can never go invisible, which was the paid-409's actual purpose; the
escalation etiquette is bypassable, the money-visibility invariant is not. Recorded
in §Accepted risks.

**Business rules:**

- **`helpers/guest-orders.js`: add `'order_token'` to `GUEST_ORDER_FIELDS`**
  (:18-21). The one-list rule is the point ("a column can never be published on one
  surface and missing on another" — :25-27): every consumer of these loaders is a
  host- or admin-authenticated surface (guest-links GET/POST/PATCH, guest-orders
  mutations, `cycleSubOrders`/`cycleSubOrdersByHost` → the admin orders tab via
  orders.js:646-649). The header comment at :13-16 is REWRITTEN to the new rule:
  *published to the host and the admin for resending (module 14); `routes/guest.js`
  remains the only place `order_token` is a CREDENTIAL — no other route may
  authenticate by it.*
- **The unpaid overview** (`GET /guest-orders/cycle/:cycleId/unpaid`) adds
  `order_token` to its hand-picked row mapping (guest-orders.js:317-333) and deletes
  the now-false comment at :315-316 — the refund/receivables screen is where the
  admin most needs to reach a guest whose URL died.
- **URL composition:** anywhere host/admin UI turns the token into a URL it is the
  canonical `` `${origin}/g/o/${order_token}` `` — never the pair form (UC-GR-003).
- **What does NOT change:** no guest-facing or public payload gains anything (the
  guest already receives their own `order_token`); the invite-request 201 body stays
  the bare `{ success: true }` (guest-lead-capture.spec.js:402-414 passes
  unchanged); `friends.js` responses are untouched.

**Acceptance criteria:** the host view payload (`GET /guest-links/cycle/:id`) and the
admin orders payload carry each sub-order's `order_token`; opening
`/g/o/<that token>` as an anonymous browser renders the guest's order; no route
outside `routes/guest.js` accepts an `order_token` as authentication.

---

## UC-GR-007 Host copy affordance — `GuestSubOrders.vue` (Friend/host)

**Goal:** PO requirement 3's UI half: "Registrovaný užívateľ by mal mať možnosť
kolegovi preposlať jeho unikátnu linku na už vytvorenú objednávku."

**Structure (amends 05 §UC-KG-003's card):** each sub-order card gains one
`button.btn.ghost.sm`, `data-testid="guest-copy-url-{id}"`, label
**"Kopírovať odkaz"** → **"Skopírované!"** for 2 s (the UC-DS-011 flip pattern;
`navigator.clipboard` in try/catch, error surfaced in the card's existing banner). It
copies the full canonical URL `` `${origin}/g/o/${subOrder.order_token}` ``.

**Business rules:**

- **Present on EVERY row** — live, paid, delivered, cancelled, and when the cycle is
  locked. Resending is precisely a post-lock / lost-URL activity, and a cancelled
  order's URL still renders the guest's terminal record (the read side is 404-only).
  This is deliberately unlike "Odstrániť" (hidden when locked/cancelled).
- It is a **button, not a badge** — the "exactly ONE badge" rule scoped to
  `data-testid="sub-order-badges"` (05 §UC-KG-003 / CartLineList note) is untouched.
- Label collision check (done): every shipped `{ name: 'Kopírovať' }` lookup is
  dialog- or row-scoped (share-dialog.spec.js:341,356; guest-link.spec.js:282,323;
  guest-order.spec.js:907; order-modals.spec.js:931), so an unscoped match cannot
  swallow this button. The new button must still get its own testid (above) so
  future specs never rely on the label.
- Slovak: vy-form register; the label carries no participle. `title` attribute:
  **"Odkaz na stav objednávky pre kolegu"** (draft, PO sign-off — §OPEN).
- Per-row pending is NOT needed (clipboard is local, no server call); the button is
  never disabled by another row's mutation.

**Acceptance criteria:** clicking copies the canonical URL (clipboard asserted, the
share-dialog.spec.js clipboard-permission idiom); the button renders on a cancelled
row and on a locked cycle; `sub-order-badges` still counts exactly one badge.

---

## UC-GR-008 Admin UI — links, resend, cancel in `CycleDetail.vue` (Admin)

**Goal:** the orders tab is where the admin already sees hosts and nested sub-orders
(orders.js:646-649; CycleDetail.vue:1694 nested `v-for`, :1753 "Zrušené") — the three
new admin capabilities land there. Admin skin: shadcn, **no `neo/` classes, no theme
tokens** (01-architecture scope rule).

**Data:** on orders-tab load, fetch `api.getGuestLinksForCycle(cycleId)` (UC-GR-004)
**non-blocking** (failure must not stop the tab rendering — the `loadGuestUnpaid`
precedent at CycleDetail.vue:342) and with a **`loadSeq` guard** (repo convention).
Links join to rows client-side by `host_friend_id`.

**Per friend row — the share link ("Hosťovský odkaz"):**

- Link exists: show a compact copy control copying `` `${origin}/g/${link.token}` ``
  (the ORDERING link — this is what the admin forwards to a friend who lost it), with
  a muted **"neaktívny"** marker when `active = 0` or the host is inactive. ⚠ No
  admin deactivate/reactivate/regenerate control exists (UC-GR-004 non-capability).
- No link: button **"Vytvoriť hosťovský odkaz"** → `POST
  /guest-links/cycle/:id/host/:friendId`, updating the row in place (per-row pending,
  the `rowSeq` convention — two rows may be created concurrently). The orders payload
  lists EVERY active friend (placeholder rows `status: 'none'`, orders.js:612-635),
  so a friend who has neither ordered nor shared is reachable here.

**Per nested sub-order row — resend + cancel:**

- Copy control for the guest's status URL `` `${origin}/g/o/${sub.order_token}` ``
  (label draft: **"Odkaz na objednávku"**).
- **"Zrušiť"** button on non-cancelled rows → inline confirm → `POST
  /guest-orders/:id/cancel` → patch the row in place from the response (per-row
  pending + `loadSeq`, the money-screen rule from GSO-T6). Confirm copy (draft, PO
  sign-off — §OPEN): unpaid — **"Objednávka hosťa sa zruší. Hosť ju uvidí ako zrušenú
  a už si ju nebude môcť upraviť."**; paid — prepend **"Objednávka je zaplatená — po
  zrušení sa zobrazí medzi platbami na vrátenie."** (the refund queue named, so the
  admin cancels a paid order knowingly).
- **The cancelled row STAYS listed** with the existing neutral "Zrušené" rendering
  (CycleDetail.vue:1753) — now a pinned REQUIREMENT, not an accident: the PO wants it
  "ako potvrdenie, že objednávka existovala (a kto ju vytvoril) a že bola zrušená".
  The host's view keeps the same property for free (GuestSubOrders lists cancelled
  rows out-of-totals — helpers/guest-orders.js:84-98).

**`api.js` additions** (all admin `adminRequest`/`request` with X-Admin-Token, next
to the existing guest-orders admin block at api.js:487-496):
`getGuestLinksForCycle(cycleId)`, `createGuestLinkForHost(cycleId, friendId)`,
`cancelGuestOrderAdmin(id)`.

**Acceptance criteria:** a host row shows a copyable link; a linkless friend row
creates one without a reload; cancelling an unpaid sub-order flips the row to
"Zrušené" in place and it remains listed; cancelling a paid one shows the refund
warning first and the refund queue card then lists it; no `neo/` class appears in the
diff to `CycleDetail.vue`.

---

## UC-GR-009 Share dialog standing copy (Friend/host)

**Goal:** the PO's two must-say lines in `GuestShareDialog.vue` — the incident's host
almost certainly regenerated because "Vygenerovať nový odkaz" read as "share with one
more colleague". Amends 05 §UC-KG-006.

**New copy (DRAFT — impersonal vy-form, no participle addresses the reader;
PO sign-off pending, §OPEN):** two standing lines in the **link-exists** state:

1. Under the `NeoCopyRow`, `div.field-help` with
   `data-testid="share-standing-copy"`:
   **"Ten istý odkaz platí pre všetkých kolegov — každý si cez neho vytvorí vlastnú
   objednávku. Pre ďalšieho kolegu nevytvárajte nový odkaz."**
2. Directly above the actions row, `div.field-help` with
   `data-testid="regen-guidance"`:
   **"Nový odkaz vygenerujte len vtedy, ak sa pôvodný dostal k nesprávnym ľuďom —
   kolegom potom treba poslať nový."**
   ("dostal" refers to *odkaz*, a third-party noun, not the reader — allowed per the
   GSO-T10 register pin.)

**Placement constraints — what makes this ADDITIVE against
`share-dialog.spec.js`'s pins (verified against the shipped spec):**

- ⚠ Neither line may be a `p.sub`: `dialog.locator('p.sub')` is asserted with
  single-element `toHaveText('Odkaz ešte nie je vytvorený.')`
  (share-dialog.spec.js:239, :579) — a second `p.sub` in the DIALOG would be a
  strict-mode violation whenever both states' elements coexist, and `field-help` is
  the correct primitive anyway.
- ⚠ No new `<b>` inside the `#subtitle` slot (`subtitle.locator('b')` is a
  single-element `toHaveText(cycleName)`, :200) — the new lines live in the body.
- ⚠ The `.confirmbox` is UNTOUCHED: its exact copy and its single `<b>` are pinned
  (:417-418). The regeneration guidance is standing text OUTSIDE the box, which is
  the PO's intent anyway (visible BEFORE the host clicks).
- Button labels, states, the `loadSeq` watcher and the whole component API are
  untouched (05 §UC-KG-006 rules all hold).
- The no-link state gains nothing (there is no link to mis-share yet).

**Acceptance criteria:** both testids render in the link-exists state with the exact
strings; the full `share-dialog.spec.js` passes UNMODIFIED; the strings render on
both entry points (one shared dialog — GSO-T2 rule).

---

## UC-GR-010 Verification — e2e obligations (system)

**Goal:** exactly which shipped assertions this module supersedes, which it retargets,
and what the new spec file must pin. Retargets are case (a) of the e2e-immutability
rule (03 §UC-FL-013): each edit re-points the assertion at the mandated behaviour,
never weakens the protected property, and cites the mandating UC in a comment.

**1. `api-security.spec.js` — `ADMIN_ENDPOINTS` +=** (the standing CLAUDE.md rule):

- `GET /api/guest-links/cycle/1/all`
- `POST /api/guest-links/cycle/1/host/1`
- `POST /api/guest-orders/1/cancel`

⚠ The new `/api/guest/o/…` routes are PUBLIC by design and must NOT join the list
(the api-security.spec.js:42-48 precedent). The three host guest-links routes stay in
`FRIEND_IDENTITY_ENDPOINTS`.

**2. `guest-status.spec.js` — the pair-credential tests (UC-GR-002 supersessions):**

- **Superseded, rewrite:** `:203` *"a valid order token does NOT resolve under a
  different link token"* — the property it pins ("the pair, not either token alone,
  is the credential", :215) is retired by resolved conflict 2. Rewrite to pin the NEW
  contract: a valid order token resolves 200 with the identical payload under its own
  link half, a foreign one, and a garbage one; the PUT acts the same way; an unknown
  order token stays 404 with the same message (the no-oracle property, restated).
- **Stays, plus one addition:** `:230` *"404 for an unknown order token…"* — the
  valid-link + unknown-order (:234), both-unknown (:235) and blank-pair (:236-238)
  cases all still 404. Add the inverse pin: unknown link half + VALID order token ⇒
  200.
- The file's header comment (:5-6) is updated to name both URL forms.
- **Everything else in the file passes unchanged** — edits, bounds, cancel,
  terminal-cancelled, lock read-only, deactivated-link read/write asymmetry, and the
  whole UI describe (pair page URLs keep working).

**3. `guest-host-view.spec.js`:**

- **Superseded, invert:** `:214-218` — the `order_token` absence pin on the host view
  becomes a PRESENCE pin (UC-GR-006): the payload carries each sub-order's
  `order_token`, asserted equal to the one the guest received.
- **Superseded, retarget:** `:605-630` *"Regenerated link (the case GSO-T4 left
  open)"* — `:624`'s `underOld` 404 ("the retired token resolves nothing at all")
  becomes 200: that recovery IS this module. Keep `:620`'s under-new 200; add the
  ordering-surface counter-pin (old token's listing/submit still 404) so
  regeneration's revocation purpose stays proven.

**4. `guest-admin-view.spec.js`:** `:494` and `:625` — the two `order_token` absence
pins on admin payloads invert to presence pins (UC-GR-006).

**5. `guest-order.spec.js`:** `:286` (host view must not contain `order_token`)
inverts; `:885`'s `status_path` regex retargets `/g/${link.token}/o/…` →
`/g\/o\/[A-Z2-9]{12,}$/` (UC-GR-003). `:264` (order token ≠ link token) and `:458`
(server-owned token) stay.

**6. `guest-payment-modal.spec.js`:** `:671`'s copy-row regex retargets to the
canonical form; `:684`'s `toHaveURL(shown)` then passes as-is (both sides canonical).

**7. `guest-invite-dead.spec.js`:** `:648`'s stored `status_url` equality retargets to
the canonical form. The many direct `page.goto` pair URLs across this file and
`guest-lead-capture.spec.js`/`guest-admin-view.spec.js` stay VALID (UC-GR-002 keeps
the pair page working) — do not "modernise" them; they are now the regression net for
the legacy form.

**8. `share-dialog.spec.js`: NO edits** — UC-GR-009's placement constraints exist
precisely so this file passes unmodified. `share-dialog.spec.js:594-595` (the
guest-links payload absence pin inside the dialog test) inverts with UC-GR-006;
`:602` (the rendered dialog HTML never contains the order token) **stays** — the
dialog still never prints it. ⚠ If :594-595 prove to live in this file (they do),
that is the one sanctioned edit here: payload pin inverts, HTML pin stays.

**9. New spec file `e2e/tests/guest-order-recovery.spec.js`** (fixtures per test,
never a shared `beforeAll` — the GSO-T8 worker-restart lesson):

- **The incident end-to-end:** submit → pay-mark (admin) → regenerate → the guest's
  OLD pair URL still renders (API + UI) → admin cancel → refund queue shows the
  item-recomputed amount → clearing `paid` empties the queue.
- Canonical/pair parity: GET/PUT/invite-request payloads byte-equal across forms.
- Admin links: read-all; create-if-missing idempotency with the token asserted
  UNCHANGED on repeat (the no-regenerate proof); 409 `inactive_host`; friend-token
  401s.
- Admin cancel: idempotent 200; locked 409 `closed`; stock release (`remaining_g`
  recovers); ⚠ `transactions` row count unmoved before/after (the GSO-T6 pin).
- UI: host copy button (clipboard, cancelled row, locked cycle); admin link + cancel
  flow in CycleDetail; the dialog standing copy testids; the pair page
  `router.replace` to canonical after load (and NOT on a 404).

**10. The confirmation mail (UC-GR-011) — the module 08/09 stub-harness precedent.**
Mail is verified against the shared Mailgun stub in **`e2e/mailgun-harness.js`**
(`withMailHarness` / `startMailgunStub` / `multipartFields` — the extraction 08
§UC-EM-005 item 1 mandated and `invitation-approval.spec.js` / `magic-link.spec.js`
already consume; **reuse it, never fork it**). Its shape: a throwaway backend whose
`MAILGUN_BASE_URL` points at a 127.0.0.1 stub, env blanked first so an ambient real
key can never be inherited, the raw multipart body captured as one UTF-8 string.
These tests live in a mail describe of `guest-order-recovery.spec.js` (self-skipping
via `CAN_SPAWN_BACKEND`/`CAN_SPAWN_MAILER`, the harness convention) and pin:

- submit **with** an e-mail ⇒ exactly ONE stub request; its `text` field carries the
  payment reference (`guestPaymentReference` output), the total, and the canonical
  `/g/o/<orderToken>` URL whose token equals the 201's `status_path` token; the
  `html` field is present, carries the same href, and no other `http(s)://` host
  (the 08 §UC-EM-005 item 3 no-remote-assets pin);
- submit **without** an e-mail ⇒ ZERO stub requests, 201 byte-shape unchanged;
- stub answering **500** ⇒ the submit still 201s with the full payment payload
  (fire-and-forget proven), and the guest order exists;
- an edit (`PUT`) and a cancel (`items: []`) after the submit ⇒ NO further stub
  request (send-on-create only, UC-GR-011);
- the harness's `PUBLIC_BASE_URL` is the origin of the mailed URL regardless of the
  request's Origin header (the 08 §UC-EM-004 mechanism, restated for a guest URL).

⚠ The rest of this module's suite runs with **no `MAILGUN_*` env at all** (the
mailer's rule 1 no-op), so every non-mail test is untouched by UC-GR-011 — that
default is itself part of what item 10's zero-request assertions rely on.

**Procedure:** `node --check` on every changed backend file (no unit runner — do not
add one); targeted files first (`guest-order-recovery` incl. its mail describe,
`guest-status`, `guest-host-view`, `guest-admin-view`, `guest-order`,
`guest-payment-modal`, `guest-invite-dead`, `share-dialog`, `guest-link`,
`api-security`), full suite only
at the module milestone (project memory: e2e gate frequency), with all five
rate-limit env vars raised and output piped to a file, never `| tail`.

---

## UC-GR-011 Guest order-confirmation e-mail on submit (Guest)

*(Added by the same-session PO follow-up, after UC-GR-010 was drafted — hence the
number; UC-GR-010 item 10 carries its e2e obligations.)*

**Goal:** PO requirement 4 — "Neregistrovaným užívateľom, ktorí vytvorili objednávku
a zadali email, by mal prísť email s potvrdením objednávky a s linkom na vytvorenú
objednávku, aby link mali uložený." The mail is the guest's durable copy of the
canonical status URL — the recovery this whole module exists for, delivered
proactively instead of depending on the guest saving the confirmation screen.

**Trigger:** a successful `POST /api/guest/:token/orders` (guest.js:516-558) whose
validated identity carries a non-null `guest_email`. **Send-on-CREATE only** — the PO
asked for a confirmation of the created order; a `PUT` edit or an `items: []` cancel
sends **nothing** (Decision D10; edit/cancel notification mails are a named follow-up
in §Accepted risks, not silently implemented). `paid`/locked states are irrelevant at
create time (a fresh submit is by construction unpaid on an open cycle).

**Business rules:**

1. **The third consumer of module 08's seam, through the seam exactly** —
   `renderEmail({ text, blocks })` + `sendMail({ to, subject, text, html })` from
   `helpers/email-templates.js` / `helpers/mailer.js`; no layer change, no new block
   type, no new dependency. The implementation template is `deliverMagicLink()`
   (magic-link.js:175-228) **verbatim in structure**: one `deliver…` helper, outer
   `try/catch` around the render (a `renderEmail` throw degrades to "no mail",
   logged as a message only), the send **not awaited** — a floating promise whose
   result vocabulary is consumed in `.then` and logged token-free on failure, with a
   `.catch` backstop.
2. ⚠ **Fire-and-forget is a hard contract, stated twice because each half has its own
   failure mode.** (a) A mail failure — or an unconfigured Mailgun, the normal
   dev/staging/e2e state (`skipped:'not_configured'`, mailer.js:105) — must NEVER
   fail the 201: no `await` on the send, no throw path from it into the handler
   (the mailer's own rule 3 guarantees `sendMail` never throws; the render throw is
   caught in the helper). (b) ⚠ **The GA-T8 hazard class:** the submit handler's
   stock check sits OUTSIDE the insert transaction (guest.js:507-514), safe only
   while the handler is fully synchronous under `instances: 1`. The handler
   therefore stays a plain `(req, res)` function — **no `async` keyword, no `await`
   anywhere in it** — and the send fires **strictly AFTER the insert transaction has
   committed** (after `create()` returns and the order row exists), never between
   validation and insert. The floating-promise pattern satisfies both halves; an
   awaited send would violate both.
3. **Recipient gating — the existing validation suffices; none is invented.**
   `validateIdentity` (guest.js:114-151) already bounds the e-mail (≤ 160 chars,
   string-typed, optional ⇒ `null`); it deliberately has no shape check, and this UC
   does not add one to it. The gates on the send are: the route calls the deliver
   helper **only when `guest_email` is non-null** (no e-mail ⇒ no build, no log —
   an omitted optional field is not a failure); past that, the mailer's own
   plausibility gate applies — `EMAIL_SHAPE` (mailer.js:39, "deliberately loose —
   the authority on deliverability is Mailgun") answers `error:'invalid_recipient'`
   without a network call, consumed and logged like every other non-sent result.
   The stored `guest_email` is never mutated by any of this.
4. **URL construction:** `` `${resolveLoginUrl(req)}/g/o/${order.order_token}` `` —
   `resolveLoginUrl` from `helpers/credentials-message.js:88`, the magic-link
   precedent (magic-link.js:177-181): guest routes have no session, the mail goes to
   a third party, so the origin must be server-derived (the 08 §UC-EM-004
   `PUBLIC_BASE_URL` pin covers it automatically; an attacker-chosen Origin must
   never mint the domain, and the URL is never taken from the request body). ⚠ The
   mailed URL is the **canonical form only** — never the pair form (UC-GR-003's
   "never newly emitted" rule).
5. **Content — the same facts the 201 carries (guest.js:545-558), no more:**
   the order summary (each item line from `loadItems()`: quantity × product name,
   variant/`variant_label`, frozen line price; plus the total), the payment block
   (reference via the shared `guestPaymentReference()` — one formatter, the GSO-T6
   rule; IBAN and/or Revolut as configured; amount), and the canonical status URL.
   Composition within the closed block vocabulary: `paragraph` (intro), `kv` rows
   for the item lines and the payment fields (values in mono — references and
   amounts are exactly what `kv` exists for), `button` with the status URL and the
   URL-as-label default (an invented button label is new unsigned copy — the 08
   §UC-EM-003 OPEN precedent), `small` for the save-this-link note. **The guest's
   name is deliberately unused** in both parts (the magic-link precedent: one fewer
   escaping surface, and the mail then works for every register) — though
   `renderEmail` escapes every interpolated value anyway (product names and variant
   labels are admin-supplied, but the rule holds regardless of trust). The
   plain-text part carries all of the same content including the bare URL (the
   deliverability baseline — the mailer drops `html` without `text`).
6. **Slovak copy (DRAFT — vy-form, no participle addresses the reader; PO sign-off
   pending, §OPEN):**
   - Subject: **"Potvrdenie objednávky – Podpultovka"**
   - Text part (structure; item/payment lines interpolated):
     ```
     Dobrý deň, vaša objednávka bola prijatá.

     Objednávka:
     {2× Názov produktu (250g) — 15.20 €, one line per item}
     Spolu: {total} EUR

     Platba:
     Referencia: {G<id> / Meno / Cyklus}
     IBAN: {iban}
     Suma: {total} EUR

     Stav objednávky uvidíte na tomto odkaze - uložte si ho:
     {url}
     ```
     (The save-the-link line reuses the confirmation screen's own signed copy —
     "Na tomto odkaze uvidíte stav objednávky - uložte si ho!", plain hyphen —
     recast declaratively; one voice for one fact across mail and screen.)
7. **No new rate-limit exposure.** The send rides `guestWriteLimiter` (60/window) on
   the already-limited submit — no new bucket. This deliberately differs from the
   magic-link split (its own bucket for outbound-send cost): there, an anonymous
   POST with a guessed identifier triggers a send; here a send happens only behind a
   fully valid order (identity + priced items + stock + open cycle), so the write
   limiter bounds outbound cost sufficiently. Recorded in §Accepted risks.
8. **Route surface unchanged:** no new endpoint, no `ADMIN_ENDPOINTS` change, no
   `api.js` change, no frontend change — the confirmation screen (06 §UC-GX-004) and
   the localStorage fallback stay the primary mechanism; the mail is additive.

**Acceptance criteria:** see UC-GR-010 item 10 (stub-harness: one send with both
parts carrying reference/total/canonical URL; zero sends without an e-mail; 201
survives a stub 500; no send on edit/cancel; `PUBLIC_BASE_URL` wins over Origin).
Plus `node --check` on `routes/guest.js`, and the mail describe self-skips — never
sends — on a default-env run.

---

## Deploy continuity (module-level requirement — PO, 2026-08-26)

The module MUST be deployable **mid-open-cycle** without breaking anything guests or
hosts already hold. Explicit criteria (each already implied by a UC, gathered here
because the PO made the property itself a requirement):

- **No schema change.** `guest_orders.order_token TEXT UNIQUE NOT NULL` already
  exists (schema.js); no migration runs at all.
- **Additive routes only.** Every new endpoint is new (`/api/guest/o/…`, the two
  admin guest-links routes, the admin cancel); every changed endpoint (the pair
  routes) only widens what resolves — no request that succeeded before the deploy
  fails after it.
- **Existing tokens untouched.** No link token and no `order_token` is regenerated,
  rewritten or re-keyed by the deploy; `localStorage.gorifi_guest_orders` entries and
  URLs sitting in messages are not migrated (UC-GR-003).
- **Previously dead pair URLs COME BACK TO LIFE** at the moment the backend restarts
  — including the incident's own `/g/T1/o/<orderToken>` (UC-GR-002's acceptance test
  is the proof); recovery requires no data fix-up, only the deploy.
- **The mail (UC-GR-011) is additive too:** with no `MAILGUN_*` env the mailer is a
  no-op, so a mid-cycle deploy changes nothing observable until the operator enables
  mail; enabling it later needs no redeploy of this module.
- Mechanically: backend restart required as always (PM2), frontend rsync as always;
  no `.env` edit is required by this module (`PUBLIC_BASE_URL` is already pinned per
  08 §UC-EM-004 — verify it is present before enabling guest mail, since the mailed
  URL rides it).

---

## Decisions (module-level, recorded)

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | The legacy pair form resolves by `order_token`; the link half is ignored (logged as `guest_orders.id` only, never tokens). | Strict pair + rely on the new form only — fails the incident: nobody migrates URLs already in messages/localStorage. |
| D2 | `order_token` alone is a full credential (same generator/entropy as the link token, SEC-S2); the no-oracle property is restated as "unknown order token ⇒ uniform 404". | Treating the pair as extra security — it was availability-fragile (the incident) and added no entropy. |
| D3 | Admin link powers are READ + CREATE only; regenerate/deactivate/reactivate stay host-only. | Full admin control — an admin regenerate severs colleagues silently; a reactivate republishes a deliberately revoked (leaked) link. |
| D4 | Admin cancel has NO paid blockade; paid+cancelled lands in the existing refund queue, intentionally. | Mirroring the host's paid-409 — that guard exists to force escalation TO the admin; blocking the admin too recreates the dead end. |
| D5 | Admin cancel on a non-open cycle ⇒ 409 `reason:'closed'`, same as the host's DELETE (recommendation from the raw source, adopted). | Allowing post-lock cancel — the coffee is already bought; the refund workflow (`paid` + refund queue) covers the money without falsifying the order record. |
| D6 | `order_token` joins the shared `GUEST_ORDER_FIELDS` list (one list, every host/admin surface) rather than per-surface picks. | Per-surface exposure — the one-list rule exists because per-surface picks drift. |
| D7 | The pair PAGE route re-canonicalises via `router.replace` after a successful load; never on a 404. | Leaving the address bar on the pair form — re-copied URLs would propagate the legacy form indefinitely. |
| D8 | New dialog copy is `field-help` + testids, additive against every share-dialog pin (no `p.sub`, no new `<b>` in subtitle/confirmbox). | Editing pinned copy — would force retargeting exact-text assertions for no product gain. |
| D9 | The resend-URL affordance in the admin view lives on the **nested sub-order rows only** (PO accepted the minimal-placement default, 2026-08-26 — was §OPEN). The refund-queue payload still carries `order_token` (UC-GR-006), so widening later is UI-only. | Also rendering it on the refund card — no PO ask names that surface; two affordances for one action drift. |
| D10 | The confirmation mail (UC-GR-011) fires on CREATE only — the PO asked for confirmation of a created order. | Also mailing on edit/cancel — not asked for; recorded as a named follow-up, never silently implemented. |
| D11 | The mail send is a post-commit floating promise from a helper (the magic-link `deliverMagicLink` template); the submit handler stays synchronous — no `async`, no `await`. | Awaiting the send in the handler — fails the 201 on mail trouble AND reopens the GA-T8 check-then-write hazard on the out-of-transaction stock check. |

---

## Supersedes / amends (for CLAUDE.md and the sibling specs when this lands)

- **GSO-T2 rule** "`order_token` … is never exposed to the host" — REVERSED
  (UC-GR-006); the credential half of the rule survives in the rewritten
  `helpers/guest-orders.js` header.
- **GSO-T4** "An `orderToken` only resolves under its own link `:token` (cross-link →
  404 …)" — SUPERSEDED (UC-GR-002). The read/write asymmetry and `statusPayload` as
  the pinned shape are UNCHANGED.
- **GSO-T5 / Decision 2 escalation** — the "escalate to the admin" path gains its
  missing capability (UC-GR-005); the host-side guard itself is unchanged.
- **GSO design doc Decision 6** (URL model `/g/:token/o/:orderToken`) — amended: the
  canonical form is `/g/o/:orderToken`; the pair form is legacy carriage.
- **05 §UC-KG-003** — the sub-order card gains the copy affordance (UC-GR-007).
- **05 §UC-KG-006** — the "order_token is never exposed to the host anywhere in this
  module (GSO-T2 hard invariant)" sentence is superseded; the dialog gains the two
  standing lines (UC-GR-009).
- **05 §UC-KG-007** — the preserved-pins table stays valid; the new controls carry
  their own testids.
- **06 §UC-GX-004 / §UC-GX-006** — the copy row / status page URL becomes canonical;
  the page is additionally served at `/g/o/:orderToken` (UC-GR-003).
- **06 §UC-GX-010** — the status-404 card's "incl. a cross-link `orderToken`" example
  is superseded (a cross-link pair now resolves); the card itself and its copy stay.
- **00-overview §Glossary** — "Status URL / pair token" definition becomes stale;
  update to name the canonical form.
- **08 §Scope "any new mail trigger" (out of scope there)** — UC-GR-011 adds the
  THIRD send (after 07's credentials mail and 09's magic link), consuming the
  §Seam-for-module-09 contract exactly as written: own subject/text/blocks, called
  inside its own try/catch, no layer change. Nothing in 08 is reopened.

---

## Accepted risks / follow-ups (recorded, not silently implemented)

- **A host or admin holding `order_token` can act as the guest** on the guest
  surface: edit items (open + unpaid) and cancel — including a PAID sub-order via
  `items: []`, bypassing the host DELETE's paid-409 etiquette. Accepted: the guest
  path's cancel leaves the refund-queue trace, so the money-visibility invariant the
  guard protects is intact; the token's publication is the PO's explicit ask.
- **The resend URL travels through whatever channel the host/admin pastes it into** —
  the same accepted risk class as the share link itself and IA's temp password.
- **An admin-created link exists without the host's knowledge** until they next open
  the share dialog (no notification mechanism exists; none added). Accepted — the
  admin forwards it on the host's behalf, which is the PO's stated purpose.
- **Old pair URLs display a retired link half forever** — cosmetic; the half is
  ignored (and re-copied URLs converge on canonical via D7).
- **`localStorage` entries keep the pair-keyed shape** — a deliberate non-migration;
  the pair form working forever is what makes it safe.
- **The confirmation mail hands the full order credential to a client-supplied
  address** (UC-GR-011): a typo'd e-mail at checkout delivers the guest's edit URL to
  a stranger. Accepted — same class as the guest pasting their own URL anywhere, the
  `EMAIL_SHAPE` gate catches only obvious garbage by design, and the URL grants
  nothing beyond what the confirmation screen already showed its holder.
- **Outbound-send cost rides `guestWriteLimiter`, not a dedicated bucket**
  (UC-GR-011 rule 7): up to 60 sends/window per IP is possible, but only behind
  fully valid submits (priced items, stock, open cycle) — each spam send costs the
  attacker a real order row the host and admin see. Revisit only if guest-submit
  abuse materialises.
- **Edit/cancel notification mails are a possible follow-up, not implemented**
  (Decision D10) — named here so nobody "completes" UC-GR-011 by adding them.
- **CLAUDE.md staleness:** the GSO-T2/T4 bullets quoted above must be superseded-noted
  when this module lands (the module-11 `~~…~~ SUPERSEDED` idiom).

---

## OPEN items

- `OPEN:` PO sign-off on ALL drafted Slovak strings: the two dialog standing lines
  (UC-GR-009), the host copy button label + title (UC-GR-007), the admin confirm
  copy incl. the paid/refund warning and "Vytvoriť hosťovský odkaz" / "Hosťovský
  odkaz" / "neaktívny" / "Odkaz na objednávku" (UC-GR-008), and the confirmation
  mail's subject + body copy (UC-GR-011 rule 6). All are marked draft; none is
  pinned by a shipped spec, so sign-off can land as a copy-only change.
