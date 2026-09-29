// THE ONE HOME for turning „what somebody ordered" into `CartLineList`'s normalized
// line shape — 18 §UC-PI-007 item 2 („the same normaliser FriendOrder feeds it —
// hoist to `lib/order-lines.js` if it is inline today").
//
// ⚠ WHY IT IS A LIB AND NOT A COMPUTED IN `FriendOrder.vue` ANY MORE. The mapping
// used to live there because that view was the only screen with an ordered-items
// list of its own. Module 18 gives it two more consumers that are NOT that view and
// never will be:
//
//   · the LOCKED landing's own-order card (§UC-PI-007, PI-T5) — it renders the
//     SUBMITTED order while the grid beside it is `readonly` and its cart is
//     deliberately EMPTY, so it cannot read `cartItems` even though it is mounted
//     inside the same component;
//   · „Moje objednávky" (§UC-PI-009, PI-T6) — it lists the lines of rounds whose
//     catalogue it never loads at all.
//
// `CartLineList.vue` stays the one home of the PRESENTATION (grouping, the columns,
// the ellipsis, the `€`). This file is the one home of the MAPPING into it. Two
// files, two jobs, neither duplicated — extend them, never fork.
//
// ⚠ IT IS DEPENDENCY-FREE (no Vue, no `@/` alias, no fetch) for the same reason
// `lib/cycle-stages.js` is: this project has no unit runner, so a Playwright spec
// importing the module with plain `node` IS the unit test, and that only keeps
// working while the file stays pure.

/**
 * The size label of one ordered line — the shipped rule verbatim (04 §UC-FO-009):
 * `variant_label` when the snapshot carries one (bakery variants), `'ks'` for the
 * zero-gram `'unit'` variant, else the raw variant key (`'250g'`, `'20pc5g'`, …).
 *
 * ⚠ Own-property-safe on purpose: the rows come from an API payload, so a product
 * named through a prototype key must not reach through to `Object.prototype`. The
 * same reflex as `variantGrams()` server-side (CLAUDE.md §Money & data).
 */
export function lineSize(item) {
  if (!item || typeof item !== 'object') return ''
  const label = own(item, 'variant_label')
  if (label) return label
  const variant = own(item, 'variant')
  if (variant === 'unit') return 'ks'
  return variant == null ? '' : String(variant)
}

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
}

const FALLBACK_PURPOSE = 'Ostatné'

function baseLine(item, key, amount) {
  return {
    key,
    name: own(item, 'product_name') ?? '',
    purpose: own(item, 'purpose') || FALLBACK_PURPOSE,
    size: lineSize(item),
    quantity: Number(own(item, 'quantity')) || 0,
    amount,
  }
}

/**
 * `FriendOrder`'s LIVE cart rows (its `cartItems` computed) ⇒ `CartLineList` lines.
 * `total` is already the marked-up line amount there, so it is quoted, not re-derived.
 */
export function cartLines(items) {
  if (!Array.isArray(items)) return []
  return items.map((item) => baseLine(item, own(item, 'key'), Number(own(item, 'total')) || 0))
}

/**
 * SERVER `order_items` rows (`GET /orders/cycle/:id/friend/:id`'s `items`) ⇒
 * `CartLineList` lines.
 *
 * ⚠ `price × quantity`, and `price` is the SNAPSHOT the server stored at submit
 * (`routes/orders.js` writes `applyMarkup(basePrice, markupRatio)` into the column).
 * That is deliberately NOT the same number as recomputing from today's `products`
 * row: a price the admin edited after the round locked must not retroactively change
 * what the friend is told they ordered.
 *
 * ⚠ NOT ROUNDED HERE. `paymentTotal`'s note in `FriendOrder.vue` explains the rule:
 * the round belongs at the boundary the noise escapes through (the bank payload,
 * `lib/payment-links.js`), not at an intermediate. Every DISPLAY of these amounts
 * goes through `CartLineList`'s own `toFixed(2)`.
 */
export function orderLines(items) {
  if (!Array.isArray(items)) return []
  return items.map((item, i) => {
    const quantity = Number(own(item, 'quantity')) || 0
    const price = Number(own(item, 'price')) || 0
    // `order_items.id` is stable and unique; the product/variant pair is the
    // fallback for any caller that projects the rows without it.
    const id = own(item, 'id')
    const key = id != null ? `oi-${id}` : `${own(item, 'product_id')}-${own(item, 'variant')}-${i}`
    return baseLine(item, key, price * quantity)
  })
}

/** The one spelling of the Packeta fee line. */
export const DELIVERY_LINE_NAME = 'Doručenie Packetou'

/**
 * The Packeta fee as a `CartLineList` EXTRA — never an item.
 *
 * `orders.delivery_fee` is a field ON the order and has never been an `order_items`
 * row (CLAUDE.md 2026-05-01), so it carries no purpose, no quantity and no size; it
 * keeps only the amount column so its figure stays aligned with the lines above.
 * `0`/null/absent ⇒ no line at all.
 */
export function deliveryExtras(deliveryFee) {
  const fee = Number(deliveryFee) || 0
  return fee ? [{ key: 'delivery', name: DELIVERY_LINE_NAME, amount: fee }] : []
}
