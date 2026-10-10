# 14 — „Som na suchu!" (urgent-delivery wish, PO 2026-10-09)

**What.** A friend who is running out of coffee flags their SUBMITTED order as urgent; the admin
sees that order tinted light red with a „Na suchu" badge on the orders tab (`CycleDetail.vue`)
and on `/distribution`, and tries to deliver it first. No date is promised.

**Design.** Claude Design project „Podpultovka Friends" (`7d876484-…`): `Som na suchu.html` +
`friends/portal2.jsx` (`DryCard`, variant B — the card in the „Hotovo!" modal AFTER sending; the
cart-bar chip variant A exists in the prototype but was not chosen) + `friends/portal2.css`
§„Som na suchu!". No admin design exists — the tint + badge follow the PO's wording.

**Shape.**
- `orders.urgent_at DATETIME` (ALTER only — the `orders` CREATE carries none of the later
  columns). NULL = not asked, timestamp = first moment flagged (`COALESCE` keeps it on re-flag).
- ONE writer: `PATCH /api/orders/cycle/:cycleId/friend/:friendId/urgent` `{ urgent: <boolean> }` —
  the submit's auth pair (`validateCyclePassword` + SEC-A3 `enforceOrderOwnership`), strict
  boolean (`{}`/`1`/`'true'`/`null`/`[true]`/`'abc'`/`true` ⇒ 400), 409 `not_submitted` for a
  draft or no order, 409 `cycle_closed` unless the round is `open` or `locked` (the admin still
  packs a locked one). Writes `urgent_at` ONLY — no ledger row, no status, no stage.
- Readers: `GET /orders/cycle/:id` (`o.*`), the friend GET/submit (`SELECT *`), and
  `/distribution` (explicit `o.urgent_at` in the friend SELECT; the synthetic no-own-order host
  carries `urgent_at: null`; guest parties carry none — guests cannot flag).
- Re-submitting („Aktualizovať") never touches `urgent_at`: the two submit UPDATEs name their
  columns, so the wish survives an edit and the re-opened „Hotovo!" shows the stored state.

**Friend UI.** `components/DryOrderCard.vue` (presents + emits `change`), mounted ONCE in
`FriendOrder.vue`'s „Hotovo!" modal right under the sum and OUTSIDE the `hasPaymentSettings`
gate. `FriendOrder.setUrgent()` PATCHes and adopts the server's `urgent_at` — no optimistic flip,
a refusal shows `role="alert"` and the card stays unflagged. ~~⚠ COPY IS VY-FORM … rendered
„Dochádza vám káva? / Dajte vedieť…"~~ **⚠ COPY IS PO COPY, TY-FORM (PO 2026-10-10, after the
staging look)** — a sanctioned exception like „Ako to funguje": off = „NEMÁŠ UŽ ŽIADNU KÁVU?" /
„Klikni „SOM NA SUCHU!“ a ja sa to pokúsim kávu doniesť prednostne. Použi len v prípade núdze!" /
button „SOM NA SUCHU!"; on = „SI NA SUCHU - Viem." / „Držme si palce, aby si mal/a kávu čo
najskôr!" + „Zrušiť". Reproduce, never improve (the PO's straight quotes became „…“ only). The phone `stack` layout is a `max-width: 520px` query instead of a `phone` prop.

**Admin UI.** `CycleDetail.vue isUrgent(order)` = `isOrdered && urgent_at` (a draft never
counts) → `TableRow` `bg-red-50` + `data-urgent` + `urgent-badge-<friendId>` „Na suchu".
`Distribution.vue` → the bag `Card` gets `bg-red-50 print:bg-transparent` + `data-urgent`, and
`bag-urgent-badge-<rowTid>` „Na suchu" prints too (packing order is decided on the sheet).
Rows are NOT re-sorted — the PO asked for a highlight, not an order change.

**Tests.** `e2e/tests/urgent-order.spec.js` (10): route semantics + ledger-neutral, strict body,
ownership/anon/admin-token, draft/no-order/locked/completed, both admin payloads, the „Hotovo!"
card on/off read back from the server, a refused PATCH, the orders-tab and /distribution tint +
badge. Not in `api-security`'s `FRIEND_IDENTITY_ENDPOINTS`: like the submit, it validates the
cycle first, so a target without cycle 1 would answer 404, not 401.

**Not done.** The prototype's „Objednávka odoslaná … Si na suchu" landing banner has no
counterpart (production has no such banner); the local design mirror
(`docs/design/friends-portal-redesign/`) was not refreshed with the new files.
