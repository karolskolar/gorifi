import db from '../db/schema.js';

// ⚠ THE ONE HOME for "how does this bag leave, and where" (DP-T1, 16 §UC-DP-001).
//
// Consumed by the distribution payload (§UC-DP-003), the enqueue hook
// (§UC-DP-008), module 20's guest Packeta party and module 21's segments. One
// home for the same reason `helpers/stock.js`, `helpers/pricing.js`,
// `helpers/packing.js`, `helpers/guest-aggregation.js`, `helpers/pickup.js` and
// `helpers/payment.js` are: a second copy of a classification rule is how one of
// the two stops agreeing with the other, and here the disagreement would be an
// admin driving to a pickup point for a bag the board filed under Packeta.
//
// ⚠ READ-ONLY, AND THAT IS A BOUNDARY, NOT A HABIT. `helpers/pickup.js` remains
// the SOLE WRITER of `pickup_location_id` / `pickup_location_note` /
// `packeta_address` / `delivery_fee`, and the sole decider of WHICH ROW stores a
// party's pickup (`orders` when one exists, else `guest_order_links` — the
// two-store model of docs/learnings/06-pickup-point.md). Nothing here writes, and
// nothing here re-implements that choice: callers hand this module a row that
// `pickup.js` already resolved (`readPickup()` / `linkPickupsByHost()` merged onto
// the party). This module only NAMES what is already on the row.
//
// It takes ROWS, not ids, and issues no query at all except the pickup-location
// name/address lookup — which a caller may pre-resolve by passing
// `locationsById`, because the payload renders a whole cycle and would otherwise
// run one lookup per party (§UC-DP-001, the N+1 escape UC-DP-003 uses).

/**
 * The only two literal target labels in the module; a pickup point labels itself
 * with its own name.
 */
export const TARGET_LABELS = { packeta: 'Packeta', in_person: 'Osobne' };

// ── hostile-input readers ────────────────────────────────────────────────────
// Rows reach this helper from the database, but also from module 20's not-yet-
// existing `guest_orders.packeta_address` (today `undefined` on every row) and
// from whatever a caller merges onto a synthetic party. So every read is
// OWN-PROPERTY + TYPE-SAFE, the `variantGrams()` discipline (helpers/stock.js):
// an inherited property is not data, and a non-string is not an address.

function ownValue(row, key) {
  if (row === null || typeof row !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(row, key)) return undefined;
  return row[key];
}

/** A non-empty string after `trim()`, or null. Returns the value AS STORED. */
function ownText(row, key) {
  const value = ownValue(row, key);
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

/**
 * A positive INTEGER id, or null — and deliberately strict: `'3'`, `2.5`, `NaN`,
 * `0`, `-3` and an inherited property all fail CLOSED to "no pickup point", the
 * way `helpers/stock.js` compares `!(a + b <= limit)`. SQLite hands an INTEGER
 * column back as a JS number, so nothing legitimate is refused here.
 */
function ownPositiveInt(row, key) {
  const value = ownValue(row, key);
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

// The recipient's phone. A guest party carries its OWN number (`guest_phone`) —
// it is the guest who gets told their bag is on its way, not their host — and a
// friend party carries `friends.phone` (module 11 "Mobil", added to the
// distribution SELECT by DP-T2).
function phoneOf(party) {
  return ownText(party, 'guest_phone') || ownText(party, 'phone') || null;
}

// A pickup point's name/address. `locationsById` may be a Map or a plain object
// keyed by id; anything else is ignored and the lookup falls back to the query.
function locationRow(id, locationsById) {
  if (locationsById instanceof Map) {
    const hit = locationsById.get(id);
    if (hit) return hit;
  } else if (locationsById && typeof locationsById === 'object') {
    const hit = ownValue(locationsById, String(id)) ?? ownValue(locationsById, id);
    if (hit) return hit;
  }
  // ⚠ Looked up WITHOUT `active = 1`: a location soft-deleted after a party chose
  // it must still name itself, or a perfectly well defined bag goes nameless on
  // the board (`DELETE /api/pickup-locations/:id` deactivates rather than deletes
  // once an order references it).
  //
  // ⚠ SECOND HOME OF THAT ONE RULE, ON PURPOSE — `helpers/pickup.js` `pickupOf()`
  // holds the other. Reuse is not clean (it answers the admin badge's
  // `{ pickup_location_id, pickup_location_note, pickup_location_name }` shape,
  // this one answers a group label + address), but the RULE is identical, so the
  // two must move together: change the `active` filter here and you have silently
  // desynchronised the board's group title from the orders tab's badge for the
  // same party. The matching cross-reference is at `pickupOf()`.
  return db.get('SELECT id, name, address FROM pickup_locations WHERE id = ?', [id]);
}

/**
 * Is this row a GUEST sub-order? `guest_orders.link_id` is the share link a
 * sub-order hangs off; it is in `GUEST_ORDER_FIELDS`, so every guest row on every
 * surface carries it. A friend party never does: the distribution query selects
 * `FROM orders`, and the synthetic no-own-order host (routes/cycles.js) is built
 * from literal keys that do not include it.
 *
 * ⚠ This exists so the guest branch can FAIL CLOSED — see `deliveryOf` below.
 */
function isGuestRow(party) {
  return ownPositiveInt(party, 'link_id') !== null;
}

// A host delivery is usable for inheritance only if it really is one of ours.
function usableHost(host) {
  if (!host || typeof host !== 'object') return null;
  const key = ownValue(host, 'target_key');
  if (typeof key !== 'string') return null;
  if (key !== 'packeta' && key !== 'in_person' && !/^loc[1-9][0-9]*$/.test(key)) return null;
  return host;
}

/**
 * Classify one party's bag.
 *
 * @param {object} party  a friend party (a row in the shape the distribution query
 *   yields, with `pickup.js`'s resolved pickup columns merged on) or a
 *   `guest_orders` row.
 * @param {object} [options]
 * @param {object} [options.host] the HOST party's already-derived delivery, when
 *   `party` is a guest sub-order. ⚠ CALL-SITE CONTRACT: every consumer MUST pass
 *   it for a guest row (§UC-DP-003 does). A guest whose host is missing or
 *   unusable is still never classified as a standalone bag — see the fail-closed
 *   branch below — but its group is then a guess, so a payload that omits `host`
 *   is a bug in the payload.
 * @param {Map|object} [options.locationsById] pre-resolved pickup locations.
 * @returns {{type: string, target_key: string, target_label: string|null,
 *   target_detail: string|null, phone: string|null}}
 *   `type` is exactly one of `packeta` | `pickup` | `in_person` | `via_host`;
 *   `target_key` is exactly `packeta` | `loc<int>` | `in_person`. No other value
 *   is ever emitted, so a consumer switching on them needs no default branch.
 */
export function deliveryOf(party, { host, locationsById } = {}) {
  // 1. PACKETA WINS, on the party's own address — a friend's `orders.packeta_address`
  //    or (from module 20) a guest's own. A row carrying both an address and a
  //    pickup point classifies `packeta`, mirroring the exclusive-by-construction
  //    write rule in `helpers/pickup.js` (switching to pickup clears the address).
  const address = ownText(party, 'packeta_address');
  if (address) {
    return {
      type: 'packeta',
      target_key: 'packeta',
      target_label: TARGET_LABELS.packeta,
      target_detail: address,
      phone: phoneOf(party),
    };
  }

  // 2. A GUEST WITHOUT ITS OWN ADDRESS TRAVELS WITH ITS HOST. It is not a bag of
  //    its own on the plan — the host collects it — so it inherits the host's key
  //    and label, and keeps its own phone, because it is the guest who is written
  //    to when the bag moves.
  //
  //    ⚠ AND IT FAILS CLOSED. If the host delivery is missing or unusable, a guest
  //    row must NOT fall through to the friend branches below: that would classify
  //    it as its own standalone collection, and a standalone party is one the board
  //    renders as its own bag and the hand-over routes let an admin tick
  //    independently — which §UC-DP-001 grants to exactly ONE kind of guest, the
  //    module-20 one with its own `packeta_address` (handled above). So a guest with
  //    no usable host stays `via_host` and is parked on the `in_person` group; it can
  //    never become its own bag. `isGuestRow()` is what tells the two apart — the
  //    same posture as `helpers/stock.js`'s `!(a + b <= limit)` and
  //    `variantGrams()`'s zero: when the input is not good enough to decide, refuse
  //    the permissive answer.
  const hostDelivery = usableHost(host);
  const guestRow = isGuestRow(party);
  if (hostDelivery || guestRow) {
    const inherited = hostDelivery || { target_key: 'in_person', target_label: TARGET_LABELS.in_person };
    const hostName = ownText(party, 'host_name');
    return {
      type: 'via_host',
      target_key: inherited.target_key,
      target_label: inherited.target_label ?? null,
      target_detail: hostName ? `cez ${hostName}` : null,
      phone: phoneOf(party),
    };
  }

  // 3. A PICKUP POINT.
  const locationId = ownPositiveInt(party, 'pickup_location_id');
  if (locationId) {
    const location = locationRow(locationId, locationsById);
    return {
      type: 'pickup',
      target_key: `loc${locationId}`,
      // A dangling id (the location row is gone outright) keeps its key — the
      // party's pickup IS defined — but has no name to render.
      target_label: location ? (ownText(location, 'name') ?? null) : null,
      target_detail: location ? (ownText(location, 'address') ?? null) : null,
      phone: null,
    };
  }

  // 4. IN PERSON — with or without a note.
  return {
    type: 'in_person',
    target_key: 'in_person',
    target_label: TARGET_LABELS.in_person,
    target_detail: ownText(party, 'pickup_location_note'),
    phone: null,
  };
}

/**
 * The ordered list of `target_key`s the plan cards, the board groups and the
 * cycle-header plan line all use: Packeta first, then the pickup points by
 * ASCENDING id (the prototype's order), then "Osobne" last.
 *
 * `locations` is the pickup-location rows the caller already loaded; anything
 * that is not an array, and any entry without a positive integer id, is ignored
 * rather than emitted as a key no consumer can switch on.
 */
export function deliveryGroupOrder(locations) {
  const ids = [];
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const id = ownPositiveInt(location, 'id');
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  ids.sort((a, b) => a - b);
  return ['packeta', ...ids.map((id) => `loc${id}`), 'in_person'];
}
