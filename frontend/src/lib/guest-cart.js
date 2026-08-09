// Shared guest-cart primitives — plain functions, no Vue.
//
// Extracted in GSO-T4 because the public ordering screen (`/g/:token`) and the
// personal status/edit screen (`/g/:token/o/:orderToken`) render the SAME product
// grid and the same cart footer. GSO-T3 had already copied the grid out of
// FriendOrder.vue once; a third copy for the edit screen would have guaranteed
// the three drift apart on prices, variant labels or gram weights.
//
// Everything here is a pure function of (cart, products): the cart itself is a
// flat `{ "<productId>-<variant>": quantity }` map, owned by whichever screen is
// on show, so nothing is hidden in module state.

// Variant → grams, for the client-side stock counter only. The server is the
// authority (backend/src/helpers/stock.js); this just keeps the +/- buttons and
// the "Zostáva" bar honest while a cart is being built.
export const VARIANT_GRAMS = {
  '150g': 150, '200g': 200, '250g': 250, '500g': 500, '1kg': 1000, '20pc5g': 100
}

// Coffee weight variants in display order. Data-driven so the near-identical
// price boxes stay one template block.
export const COFFEE_VARIANTS = [
  { variant: '150g', label: '150g', priceKey: 'price_150g' },
  { variant: '200g', label: '200g', priceKey: 'price_200g' },
  { variant: '250g', label: '250g', priceKey: 'price_250g' },
  { variant: '500g', label: '500g', priceKey: 'price_500g' },
  { variant: '1kg', label: '1kg', priceKey: 'price_1kg' },
  { variant: '20pc5g', label: '20 ks × 5g', priceKey: 'price_20pc5g' }
]

// ⚠ `formatPrice` USED TO LIVE HERE and is deliberately GONE (RD-GX-3, closing the
// pointer RD-DS-3 left). It emitted the same `<n>.toFixed(2) + " EUR"` as
// `lib/money.js`'s `fmtEur`, but was NOT equivalent on bad input: its `price || 0`
// guard passed a truthy non-numeric value straight through, so `formatPrice('abc')`
// rendered "NaN EUR" and `formatPrice('1e400')` rendered "Infinity EUR" — on a
// payment screen. `fmtEur` is fail-closed ("0.00 EUR"), so it is the one home for
// money formatting on the friend/guest surfaces. Do not reintroduce a second one.

// Guest prices arrive from the server with the cycle markup already applied, so
// nothing here ever multiplies by markup_ratio.
export function priceFor(product, variant) {
  if (!product) return null
  if (variant === 'unit') return product.price_unit
  const def = COFFEE_VARIANTS.find((v) => v.variant === variant)
  return def ? product[def.priceKey] : null
}

// Human label for a cart/order line. Bakery lines carry their own variant_label
// (e.g. "1/2"); coffee lines are named by their variant.
export function variantText(item) {
  if (item?.variant_label) return item.variant_label
  if (item?.variant === 'unit') return 'ks'
  if (item?.variant === '20pc5g') return '20 ks × 5g'
  return item?.variant
}

export function cartKey(productId, variant) {
  return `${productId}-${variant}`
}

// The variant may itself contain '-' ("20pc5g" does not, but variant labels are
// data), so split on the LAST separator, as GSO-T3 did.
export function parseCartKey(key) {
  const separator = String(key).lastIndexOf('-')
  return {
    productId: parseInt(String(key).slice(0, separator), 10),
    variant: String(key).slice(separator + 1)
  }
}

export function quantityIn(cart, productId, variant) {
  return cart?.[cartKey(productId, variant)] || 0
}

// Priced cart lines for the footer/summary. Lines whose product or price cannot
// be resolved are dropped — the same rule the server applies when it prices a
// submit, so the displayed total always matches what will be charged.
export function cartLines(cart, products) {
  const lines = []
  for (const [key, quantity] of Object.entries(cart || {})) {
    if (quantity <= 0) continue
    const { productId, variant } = parseCartKey(key)
    const product = (products || []).find((p) => p.id === productId)
    if (!product) continue
    const price = priceFor(product, variant)
    if (!price) continue
    lines.push({
      key,
      product_id: productId,
      product_name: product.name,
      variant_label: product.variant_label || null,
      variant,
      quantity,
      price,
      total: price * quantity
    })
  }
  return lines
}

export function linesTotal(lines) {
  return Math.round((lines || []).reduce((sum, line) => sum + line.total, 0) * 100) / 100
}

// Grams of one product already in this cart — the client half of the stock check.
export function cartGramsForProduct(cart, productId) {
  let grams = 0
  for (const [key, quantity] of Object.entries(cart || {})) {
    if (quantity <= 0) continue
    const parsed = parseCartKey(key)
    if (parsed.productId !== productId) continue
    grams += (VARIANT_GRAMS[parsed.variant] || 0) * quantity
  }
  return grams
}

// Persisted `guest_order_items` → a cart map, so the edit screen opens with what
// was already ordered instead of an empty grid.
export function cartFromOrderItems(items) {
  const cart = {}
  for (const item of items || []) {
    if (!item || !(item.quantity > 0)) continue
    const key = cartKey(item.product_id, item.variant)
    cart[key] = (cart[key] || 0) + item.quantity
  }
  return cart
}

// `[{ product_id, stock_limit_g, ordered_g, remaining_g }]` → keyed by product id.
export function availabilityMap(entries) {
  const map = {}
  for (const entry of entries || []) {
    map[entry.product_id] = entry
  }
  return map
}

// The request body both write endpoints expect: server-priced, so only the
// identity of each line travels.
export function itemsPayload(lines) {
  return (lines || []).map((line) => ({
    product_id: line.product_id,
    variant: line.variant,
    quantity: line.quantity
  }))
}
