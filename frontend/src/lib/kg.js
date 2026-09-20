// THE ONE HOME FOR THE KILOGRAM DISPLAY RULE on the friend/guest/admin-board
// surfaces (04 §UC-FO-006, resolved conflict #6: repo gram MATH, kg DISPLAY).
//
// Grams in, the printed label out: 250 → "0.25 kg", 1000 → "1 kg",
// 1250 → "1.25 kg", 1500 → "1.5 kg". Up to two decimals, DOT decimal, an
// ordinary space before the unit.
//
// ⚠ FOUR SURFACES PRINTED THIS EXPRESSION BY HAND until FUP-T24: `FriendOrder.vue`
// (the stock bar's „Zostáva X z Y"), `GuestProductGrid.vue` (the same bar on the
// public guest grid and the guest edit page), `FriendPortalSession.vue` (the cycle
// card's „N kolegovia · X kg" share row) and `Distribution.vue` (the admin board's
// plan lines and per-party „{n} pol. · X kg"). All four agreed, which is exactly
// why it needed a home: four edits, four chances to diverge, and the same number
// is what a friend reads as their SHARE of a group order. Do not inline a fifth.
//
// ⚠ WHY THIS RETURNS THE WHOLE STRING, unit included, and not a number: the
// "trailing zeros stripped" half of the rule is not a strip at all — nothing in
// here removes anything. It is `Number#toString`, which emits the shortest
// representation that round-trips, so a two-decimal value can never come out as
// "1.50" or "1.00". That property survives only while the number goes STRAIGHT
// into a template literal; hand the raw number to `toFixed(2)` at a call site and
// „1 kg" becomes „1.00 kg" on that screen alone — the drift this module exists to
// prevent. Verified exhaustively over 0–200000 g: no trailing zero, no float
// artifact (the rounded numerator is an integer, so `/100` is exact to the
// shortest repr). Compare `lib/money.js fmtEur`, which owns the OPPOSITE
// convention — money is always two decimals, `12.40 EUR`, and must never lose them.
//
// ⚠ Fail-closed on junk, like the three grid call sites always did: `null`,
// `undefined` and `NaN` render „0 kg" rather than „NaN kg". A missing weight is a
// data problem; printing NaN next to a price is strictly worse than printing zero.
// (`FriendPortalSession` reached the same place from the other side — it returns an
// empty string before it ever calls this, because „ · 0 kg" beside a live colleague
// count reads as a failure rather than as "no weight yet". That guard stays at its
// call site: it is that row's copy decision, not this rule.)
//
// ⚠ NOT THIS RULE, deliberately left alone: `CycleDetail.vue`'s catalog badge
// („max {limit}") switches UNIT at a threshold — `>= 1000` prints kg by dividing
// by 1000 with no rounding, below that it prints raw grams with no space („500g").
// Different output, different audience (an admin reading back the stock limit they
// typed) and a different contract (1234 g reads „1.234 kg" there, „1.23 kg" here).
// Folding it in would silently change an admin's screen. Two rules, two homes.
export function kgLabel(grams) {
  return `${Math.round((grams || 0) / 10) / 100} kg`
}
