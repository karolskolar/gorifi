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
