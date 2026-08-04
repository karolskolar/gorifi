// Per-variant pricing of a cycle-snapshot `products` row, shared by the friend
// order routes and the public guest route so the two can never price the same
// variant differently.
//
// The variant is client-supplied on every order path, so an UNKNOWN variant must
// resolve to no price at all — the caller then drops the line. It must NOT fall
// back to the 250g price, which is what orders.js used to do: a line like
// `variant: 'zzz'` was charged at the 250g price while the stock accounting in
// helpers/stock.js scored it 0 g, so `products.stock_limit_g` could be walked
// straight past. Dropping the line closes that.
//
// NOTE for future edits: 'unit' (bakery) IS a legitimate priceable variant even
// though it has no gram weight in helpers/stock.js — zero-gram is not the same
// as unpriceable, and bakery ordering depends on it. Do not "tidy" it away.

// variant → the products column holding its base (pre-markup) price.
export const VARIANT_PRICE_COLUMNS = {
  '150g': 'price_150g',
  '200g': 'price_200g',
  '250g': 'price_250g',
  '500g': 'price_500g',
  '1kg': 'price_1kg',
  '20pc5g': 'price_20pc5g',
  unit: 'price_unit',
};

// Base price for this variant, or null when the variant is unknown to us or the
// product carries no price for it. Never guesses.
//
// The variant is client-supplied, so the lookup is own-property and type safe:
// a non-string key (e.g. `{ toString: 1 }`) would otherwise throw on property
// coercion and turn a 400 into a 500, and a prototype key ('constructor',
// 'valueOf', …) must resolve to "unknown variant", not to Object's members.
export function basePriceForVariant(product, variant) {
  if (!product || typeof variant !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(VARIANT_PRICE_COLUMNS, variant)) return null;
  const price = product[VARIANT_PRICE_COLUMNS[variant]];
  return typeof price === 'number' && Number.isFinite(price) && price !== 0 ? price : null;
}

// The cycle markup, applied and rounded exactly once. Same formula everywhere:
// friend order_items.price, guest_order_items.price, and the prices shown to a
// guest on /g/:token.
export function applyMarkup(value, markupRatio) {
  if (value === null || value === undefined) return value;
  return Math.round(value * (markupRatio || 1.0) * 100) / 100;
}
