// Money formatting for the friend/guest surfaces (UC-DS-012, resolved conflict #3).
//
// THE FORMAT IS THE CONTRACT, not this function: `<value>.toFixed(2) + " EUR"` —
// DOT decimal and a trailing ` EUR`, exactly as the prototype's `Money` primitive
// renders it. Slovak locale would want a decimal comma; the prototype copy is final
// (00-overview), so `12.40 EUR` it is. Do NOT reach for `Intl.NumberFormat('sk-SK')`
// here — it produces "12,40 €" and breaks fidelity on every screen at once.
//
// The other half of the convention is typographic and lives in the templates, not
// here: money renders in Courier Prime via `.mono` (or `.neg` / `.neg.pill` / `.zero`
// for signed balance states), with `white-space:nowrap` so the amount never breaks
// away from its unit. Large display prices (`.vbox .vprice`, `.cartbar .sum`,
// `.suborder .total`) use the DISPLAY font per their own classes — they are not mono.
// Mono is for money, counts, IDs, references and links; never for running body text.
//
// ⚠ Admin surfaces are out of scope. They format money their own way today and must
// stay pixel-identical — do not import this into an admin view.
//
// Non-finite input formats as `0.00 EUR` rather than `NaN EUR`: a missing total is a
// data problem, and rendering "NaN EUR" on a payment screen is strictly worse than
// rendering zero. Same fail-closed reflex as `variantGrams()` server-side.
//
// ⚠ THE DUPLICATE IS CLOSED. `lib/guest-cart.js` used to export `formatPrice`, which
// emitted the same format but was NOT equivalent on bad input — its `price || 0`
// guard passed a truthy non-numeric value straight through, so `formatPrice('abc')`
// yielded "NaN EUR" (and `'1e400'` yielded "Infinity EUR"), the exact failure mode
// this function exists to prevent. RD-GX-1 re-pointed `GuestProductGrid.vue` and
// RD-GX-3 re-pointed `views/GuestOrderStatus.vue`, its last consumer, then deleted
// the export. This is now the ONE home for money formatting on the friend/guest
// surfaces — do not add a second.
export function fmtEur(value) {
  const n = Number(value)
  return `${(Number.isFinite(n) ? n : 0).toFixed(2)} EUR`
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE HOME FOR THE 2-DECIMAL MONEY RULE ON THE CLIENT (PO: "Všetky sumy by
// mali byť zaokrúhlené na 2 desatinné miesta"). The server has its own —
// `backend/src/helpers/pricing.js roundMoney()` — and it is NOT enough on its own.
//
// ⚠ WHY A CLIENT COPY IS NECESSARY, NOT DUPLICATION. Money is re-derived here after
// it leaves the database: `FriendOrder.paymentTotal` is `cartTotal + delivery_fee`,
// where `cartTotal` is the browser's own sum over the cart lines. So the last
// arithmetic before the Pay-by-Square encode happens in the browser, and:
//
//     15.00 + 11.19                      →  26.189999999999998
//     9.04 + 13.33 + 11.19 + 3.50        →  37.059999999999995
//
// A real user's banking app refused her QR with `Nesprávna suma:
// 26.189999999999998` while the same screen read `26.19 EUR`, because `fmtEur` /
// `toFixed(2)` above hides the noise and `bysquare` does not — it serialises the
// number verbatim (measured). Formatting is not rounding.
//
// ⚠ THIS IS FOR VALUES, NEVER FOR DISPLAY. Every visible amount already goes
// through `fmtEur` / `toFixed(2)` and must keep rendering byte-identically — do not
// reach for this to "tidy up" a template. Use it where a number is handed to
// something that does not format: a payment payload, a QR, an API body.
//
// ⚠ NON-NUMBERS PASS THROUGH UNCHANGED — same contract as the server helper, and for
// the same reason. `PaymentModal` is fed an `amount` prop that may legitimately be
// absent while the order loads, and it has a shipped `'-'` guard for exactly that
// state (§UC-GX-005). Coercing here would turn `null` into a `0` amount in a QR
// payload — a payment request for nothing, which is strictly worse than the
// pre-existing behaviour of encoding the missing value as-is.
export function roundMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  return Math.round(value * 100) / 100
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ONE HOME FOR „does this person owe money?" (PI-T7 review, 2026-09-20)
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ PI-T7 shipped `balance < -0.01` in THREE live places on the friend surface —
// `DebtBanner.vue` (whether the banner appears), `FriendBalanceCard.vue` (the card's
// colour, its „Nedoplatok" copy AND whether Zaplatiť is offered) and
// `FriendPortalSession.vue` (the drawer badge's tone) — and then declared itself the
// single home in FOUR documents. They are not three questions sharing a constant: every
// one asks „is this friend in debt?" and only the RENDERING differs. §UC-PI-008 had
// already pointed the banner's gate at the card's thresholds.
//
// ⚠⚠ The split was not merely untidy, it was UNTESTABLE: only the banner's copy had a
// boundary fixture (−0.004 / −0.02). The card's stubs were 0, 12.5, −5, −30, −74.24, so a
// banner-versus-card disagreement anywhere between −0.01 and −1.00 rendered a debt banner
// above a card that did not call it debt, and no test could see it.
//
// So the predicate lives here once. If the PO ever moves the threshold — „ignore sub-50-cent
// dust", say — this is the only edit, and `portal-balance.spec.js`'s source pin counts the
// literal ONCE across `frontend/src`, truthfully.
//
// ⚠ `BalanceBadge.vue` keeps its own copy ON PURPOSE: it is shared with the ADMIN skin,
// which has no business importing a friend-portal lib, and the admin's badge is a different
// audience's rendering of the same number. That exception is named here so it reads as a
// decision rather than a miss.

/** The debt threshold. One cent of float dust is not a debt. */
export const DEBT_EPSILON = -0.01

/** `true` when the friend owes money. Non-finite input is NOT debt (fails closed: a
 *  balance that failed to load must never paint a „you owe" banner). */
export function isInDebt(balance) {
  const n = Number(balance)
  return Number.isFinite(n) && n < DEBT_EPSILON
}

/** `'neg' | 'zero' | 'pos'` — the rendering states that hang off the same predicate.
 *  `zero` absorbs both float dust and an unreadable balance. */
export function balanceState(balance) {
  const n = Number(balance)
  if (!Number.isFinite(n)) return 'zero'
  if (isInDebt(n)) return 'neg'
  if (n <= 0.01) return 'zero'
  return 'pos'
}
