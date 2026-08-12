// The order purpose groups ("Espresso", "Filter", …) are presented in, for the
// screens that need the list but do not own it.
//
// `CartLineList` groups cart/order lines by purpose and takes a preferred order so a
// cart cannot list its groups in a different order from the category strip above it.
// `FriendOrder.vue` already has that list as `availablePurposes` and passes it
// straight through; the two GUEST screens do not — there, the list is computed inside
// `GuestProductGrid.vue`, which never exposes it — so they build it here instead of
// growing a fourth copy of the rule.
//
// ⚠ Deliberately NOT wired into `FriendOrder.vue`'s or `GuestProductGrid.vue`'s own
// `availablePurposes`, even though the rule is the same. Those two feed a LOOKUP —
// `groupedProducts[activeTab]` — whose keys come from `product.purpose || 'Ostatne'`
// (no diacritic, in both), while every other site in the app falls back to 'Ostatné'.
// Routing the strip through a helper that normalises differently would make a
// purposeless product's tab select an empty group, i.e. silently hide product. Here
// the fallback only affects the ORDER of line groups, and `CartLineList` appends any
// purpose it was not given rather than dropping it, so a mismatch costs nothing.
const PREFERRED = ['Espresso', 'Filter', 'Kapsule']

// `products` is any array of rows carrying `purpose`. Unknown purposes keep their
// first-appearance order and are APPENDED, never dropped — a purpose the roastery
// invents tomorrow must still show up, just after the three we know.
export function purposeOrder(products) {
  const seen = []
  for (const product of products || []) {
    const purpose = product?.purpose || 'Ostatné'
    if (!seen.includes(purpose)) seen.push(purpose)
  }
  return [
    ...PREFERRED.filter((p) => seen.includes(p)),
    ...seen.filter((p) => !PREFERRED.includes(p)),
  ]
}
