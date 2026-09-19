import db from '../db/schema.js';
import { guestPaymentReference } from './guest-orders.js';
import { roundMoney } from './pricing.js';

// 15 §UC-PL-001 — THE ONE SERVER HOME FOR PAYMENT DATA.
//
// Everything a payer is ever handed (a variable symbol, the admin's bank details, the
// guest `payment` block, the balance one) is composed here, so no route, view or mail
// template invents its own. `helpers/pricing.js`, `helpers/stock.js` and `helpers/packing.js`
// are the precedent; CLAUDE.md §Money & data calls this the "ONE HOME each" rule.
//
// ⚠ WHY THIS FILE DOES NOT SWALLOW `guestPaymentReference()`, WHICH LIVES NEXT DOOR
// IN `helpers/guest-orders.js` AND IS A PAYMENT FORMATTER TOO (PL-T1 decision, and
// §UC-PL-001 states it as a rule). The reference is the GUEST DOMAIN's string: it is
// built from `order.guest_name` + the `G<id>` disambiguator, it is pinned by four
// shipped specs, and its four call sites all already import `helpers/guest-orders.js`
// for the surrounding row loaders. Moving it here would touch every one of those call
// sites, every spec header that names its home and CLAUDE.md's one-home list — a wide
// diff whose only product is a different file name for an unchanged function. So the
// split is by CONCEPT, not by file: `guest-orders.js` owns "how a guest sub-order
// describes itself", `payment.js` owns "what the payer is told to do". This module
// IMPORTS the reference; it never re-implements it. ⚠ If a second formatter ever
// appears in either file, that is the defect — not the fact that there are two files.

// The admin setting keys this module owns. Named once so a typo cannot silently read
// an always-empty setting (`WHERE key = 'payment_ibn'` is a valid query).
//
// ⚠ EXPORTED, because the READS are not the only place they appear: `routes/admin.js`'s
// `PUT /settings` WRITES all three, and a write whose key literal drifted from the read's
// would store a setting nothing ever reads again — the same typo bug, one direction
// further along, and invisible to anything but a full round-trip. Reader and writer share
// these three names; `payment-links.spec.js` pins that `'payment_iban'` appears under
// `backend/src` in this file alone.
export const SETTING_IBAN = 'payment_iban';
export const SETTING_REVOLUT = 'payment_revolut_username';
export const SETTING_CREDITOR_NAME = 'payment_creditor_name';

// 15 §UC-PL-002 — the creditor name bound, mirrored as `maxlength` in AdminSettings.vue.
// 70 is the SEPA / ISO 20022 beneficiary-name length (`Nm`), which both the Pay by Square
// payload and the PayMe `CN` field inherit. ⚠ OPEN in the spec: the published PayMe
// Payment Link Standard PDF could not be text-extracted during PL-T1 (scanned/encoded
// fonts) and payme.sk's developer page states no caps at all, so this is the ISO bound,
// not a verified quote. If the standard turns out to be shorter, THIS constant and the
// `maxlength` move together — they are one number with one home.
export const MAX_CREDITOR_NAME_LENGTH = 70;

// The exclusive upper bound on any id a VS may be derived from. Above it the padded
// schemes stop being 7 digits and a friend order id would start with `8`/`9` — i.e.
// exactly where the three schemes could collide. Refusing here makes the collision
// unreachable instead of merely unlikely.
const MAX_VS_ID = 1_000_000;

// ⚠ FAILS CLOSED. An EMPTY VS is a degraded payment (the QR still carries the human
// reference, PayMe omits `PI`); a WRONG VS is money matched to the wrong person. So
// anything that is not a plain positive integer in range yields `''`.
//
// The log line carries the KIND and the offending value's type/shape only — never the
// row it belongs to, because a VS refusal is not a reason to write a friend's or a
// guest's data into the server log.
function variableSymbolFor(kind, prefix, id) {
  if (!Number.isInteger(id) || id <= 0 || id >= MAX_VS_ID) {
    console.warn(
      `[payment] refusing to derive a ${kind} variable symbol from an out-of-range id (${typeof id})`,
    );
    return '';
  }
  return prefix ? `${prefix}${String(id).padStart(6, '0')}` : String(id);
}

// R6.3 — a friend order pays under its own id, plain: `orders.id` is what the admin
// sees beside the friend in the orders tab.
export function friendOrderVariableSymbol(orderId) {
  return variableSymbolFor('friend order', '', orderId);
}

// A guest sub-order lives in its OWN table, so its id collides with an `orders.id` as a
// bare number. `9` + six digits keeps the two spaces disjoint.
export function guestOrderVariableSymbol(guestOrderId) {
  return variableSymbolFor('guest order', '9', guestOrderId);
}

// A friend settling their whole balance is a third debt with a third id space
// (`friends.id`), hence a third prefix.
export function balanceVariableSymbol(friendId) {
  return variableSymbolFor('balance', '8', friendId);
}

// THE ONE READER of the payment settings rows. `routes/guest.js` carried a private copy
// and `routes/admin.js` two hand-written pairs of `SELECT value FROM settings`; all of
// them read this now, so a fourth key (or a renamed one) is a single edit.
//
// Every value is `''` when the row is absent — a blank creditor name is legal and means
// "no PayMe button anywhere" (§UC-PL-002), never `null` reaching a template.
export function paymentSettings() {
  const rows = db
    .prepare(
      `SELECT key, value FROM settings WHERE key IN (?, ?, ?)`,
    )
    .all(SETTING_IBAN, SETTING_REVOLUT, SETTING_CREDITOR_NAME);
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    iban: byKey.get(SETTING_IBAN) || '',
    revolut_username: byKey.get(SETTING_REVOLUT) || '',
    creditor_name: byKey.get(SETTING_CREDITOR_NAME) || '',
  };
}

// THE ONE COMPOSER of the balance `payment` block (15 §UC-PL-003 item 4) — a friend
// settling their WHOLE balance rather than one order. PL-T4's „Zaplatiť" on the balance
// card and (module 21) any message that quotes the debt render this same object.
//
// ⚠ `amount` is what is OWED, never the balance: a friend in credit or exactly settled is
// asked for `0`, and the surfaces then offer no payment control at all (§UC-PL-007). The
// sign flip lives HERE, so no screen can quote the debt with the other sign.
//
// ⚠ `reference` is DRAFT copy, PO sign-off pending (§UC-PL-003 item 4 OPEN): the roadmap
// defines the balance VS but no balance reference text. It is one string in one place.
//
// Takes the `{ id, name, balance }` shape the balance query already produces; it reads no
// row of its own, so the caller's ownership guard stays the only gate on this data.
export function balancePaymentBlock(friend) {
  const settings = paymentSettings();
  return {
    amount: roundMoney(Math.max(0, -(friend.balance || 0))),
    reference: `${friend.name} / zostatok`,
    variable_symbol: balanceVariableSymbol(friend.id),
    iban: settings.iban,
    revolut_username: settings.revolut_username,
    creditor_name: settings.creditor_name,
  };
}

// THE ONE COMPOSER of the guest `payment` block — the confirmation 201, the status URL
// payload and (module 21) any message that quotes it all render the same object, so a
// guest can never be shown two different amounts or two different references for one
// sub-order.
export function guestPaymentBlock(order, cycleName) {
  const settings = paymentSettings();
  return {
    // ⚠⚠ MODULE-20 SEAM (GP-T1). THIS ONE LINE becomes
    //     `amount: roundMoney(order.total + (order.delivery_fee || 0))`
    // when guests gain a Packeta delivery fee (20 §UC-GP-004). `orders.total` stays
    // PRODUCT-ONLY on every write, for friends and guests alike, so the fee is added
    // HERE and nowhere else — no second file computes a guest amount, which is the
    // whole reason this block has one home. Until then: `total`, byte-identical to
    // the two hand-written blocks this replaced.
    amount: order.total,
    reference: guestPaymentReference(order, cycleName),
    variable_symbol: guestOrderVariableSymbol(order.id),
    iban: settings.iban,
    revolut_username: settings.revolut_username,
    creditor_name: settings.creditor_name,
  };
}
