// Slovak count phrases that more than one surface prints.
//
// `colleaguesLabel` was private to `components/GuestSubOrders.vue` (the host's
// "Objednávky kolegov" tab, which counts its own loaded rows) until the portal
// cycle card's share row started printing the same phrase from a different
// source (the link's server-side `totals.count`). Two copies of a three-branch
// declension is exactly how one screen ends up reading "3 kolegov".
//
// 1 kolega / 2-4 kolegovia / 5+ kolegov.
export function colleaguesLabel(count) {
  const n = Number(count) || 0
  if (n === 1) return '1 kolega'
  if (n >= 2 && n <= 4) return `${n} kolegovia`
  return `${n} kolegov`
}

// 1 položka / 2-4 položky / 5+ položiek — the cart-line count in the `.cartbar`
// fold's own label. 0 takes the same form as 5+ ("0 položiek"), which is the
// correct Slovak genitive plural and not a fallback.
export function itemsLabel(count) {
  const n = Number(count) || 0
  if (n === 1) return '1 položka'
  if (n >= 2 && n <= 4) return `${n} položky`
  return `${n} položiek`
}
