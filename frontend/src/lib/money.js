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
