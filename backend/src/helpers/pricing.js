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
  '8pc12g': 'price_8pc12g',
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

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE HOME FOR THE 2-DECIMAL MONEY RULE (PO: "Všetky sumy by mali byť
// zaokrúhlené na 2 desatinné miesta").
//
// ⚠ WHY THIS EXISTS AS A NAMED FUNCTION AND NOT AS AN EXPRESSION. It used to be an
// expression, and `applyMarkup` below was the only copy of it on the WRITE paths —
// so per-ITEM prices were rounded and the SUM of them was not:
//
//     routes/orders.js:  total += price * quantity   →   UPDATE orders SET total = ?
//     node -e "console.log(15.00 + 11.19)"           →   26.189999999999998
//
// A real user's banking app refused her Pay-by-Square QR with
// `Nesprávna suma: 26.189999999999998` while every screen in the app said
// `26.19 EUR`, because every screen formats with `toFixed(2)` and the QR does not.
// That is what two copies of a rule look like when one of them is missing: the
// defect is invisible on every surface except the one that matters.
//
// So: every place a money value is WRITTEN to the database, posted to the ledger,
// or handed to a payment payload goes through this function. Do not re-inline
// `Math.round(v * 100) / 100` — add a call site instead. (The frontend has its own
// one home for the same rule, `frontend/src/lib/money.js roundMoney()`; the QR is
// assembled client-side from `cartTotal + delivery_fee`, so it needs its own.)
//
// ⚠ NON-NUMBERS PASS THROUGH UNCHANGED, deliberately. Several call sites take a
// value that has already been through `bindValue()`, where a string, `null` or an
// absent key are all legitimate and each has established meaning at the SQL layer
// (column affinity, NULL, "leave the column out of the SET list"). Coercing here
// would quietly turn `null` into `0` and `''` into `0` on money columns — a shape
// change smuggled in behind a rounding fix. `NaN`/`Infinity` also pass through, for
// the same reason `variantGrams()` fails closed rather than inventing a value.
//
// ⚠ THE CAVEAT THAT FOLLOWS FROM THAT, stated because the header above reads as
// absolute: a numeric STRING is passed through too, so a body like
// `{"parcel_fee":"4.199999999999999"}` still stores full precision (REAL affinity
// converts it at the SQL layer, bypassing this function) where the same value sent as
// a NUMBER stores 4.2. Measured, on `PATCH /api/cycles/:id` and
// `POST /api/transactions/payment`. Unreachable from the app — `CycleDetail.vue` binds
// `v-model.number` and all three transaction dialogs `parseFloat` — so it is a
// follow-up ("parse numeric strings at the money routes"), not a hole to fix by
// coercing here, which is what the paragraph above rules out.
export function roundMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.round(value * 100) / 100;
}

// The cycle markup, applied and rounded exactly once. Same formula everywhere:
// friend order_items.price, guest_order_items.price, and the prices shown to a
// guest on /g/:token.
export function applyMarkup(value, markupRatio) {
  if (value === null || value === undefined) return value;
  return roundMoney(value * (markupRatio || 1.0));
}
