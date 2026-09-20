import { Router } from 'express';
import db from '../db/schema.js';
import { validateFriendAuth, getAuthMode } from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { packOrder, unpackOrder, packingItemStats } from '../helpers/packing.js';
import { gramsByProductFromItems, stockViolations } from '../helpers/stock.js';
import { basePriceForVariant, applyMarkup, roundMoney } from '../helpers/pricing.js';
import { cycleSubOrdersByHost, loadSubOrder } from '../helpers/guest-orders.js';
import {
  readHandedOverFlag, partyDelivery, inheritingGuests, orderStage, guestOrderStage,
} from '../helpers/handover.js';
import { enqueueForHandOver, cancelForUnHandOver } from '../helpers/outbox.js';
import { markCycleReady } from '../helpers/cycle-stage.js';
import { friendOrderVariableSymbol, guestOrderVariableSymbol } from '../helpers/payment.js';
import { bindValue } from '../helpers/bind-value.js';
import { pickupTargetFor, activeLocation, applyPickup, readPickup, linkPickupsByHost } from '../helpers/pickup.js';

const router = Router();

// Helper: Validate password from Bearer token, X-Friends-Password (global), or X-Cycle-Password (legacy) header
function validateCyclePassword(req, cycleId) {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return { error: 'Cyklus nebol najdeny', status: 404 };
  }

  // Try Bearer token first (new token-based auth)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const authResult = validateFriendAuth(req);
    if (authResult.valid) {
      return { cycle };
    }
  }

  // Try global friends password (shared password system) — blocked in modern mode
  const friendsPassword = req.headers['x-friends-password'];
  if (friendsPassword) {
    if (getAuthMode() === 'modern') {
      return { error: 'Spolocne heslo nie je povolene. Prihlaste sa menom a heslom.', status: 401 };
    }
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'friends_password'").get();
    if (setting && setting.value && friendsPassword === setting.value) {
      return { cycle };
    }
  }

  // Fall back to per-cycle password (legacy)
  const cyclePassword = req.headers['x-cycle-password'];
  if (cycle.shared_password && cyclePassword === cycle.shared_password) {
    return { cycle };
  }

  // Check if any auth was provided
  if (!authHeader && !friendsPassword && !cyclePassword) {
    return { error: 'Heslo nie je poskytnuté', status: 401 };
  }

  return { error: 'Nespravne heslo', status: 401 };
}

// SEC-A3: bind an order operation to the authenticated friend. When a Bearer
// token is present its friendId must equal the :friendId in the URL (closes the
// friend-vs-friend IDOR). Shared/cycle-password auth carries no identity and is
// permitted only in legacy mode as a migration window; in 'modern' mode a token
// is required. validateCyclePassword still validates the password itself.
function enforceOrderOwnership(req, friendId) {
  const auth = validateFriendAuth(req);
  if (auth.friendId != null) {
    if (String(auth.friendId) !== String(friendId)) {
      return { error: 'Nemáte oprávnenie na túto objednávku', status: 403 };
    }
    return {};
  }
  if (getAuthMode() === 'modern') {
    return { error: 'Prihláste sa svojím menom a heslom', status: 401 };
  }
  return {};
}

// Get order by cycle and friend (password protected)

// 15 §UC-PL-003 item 3 — what the friend is told to type into their transfer.
//
// ⚠ A TOP-LEVEL `payment`, NOT a field on the `order` row. The order row is a
// `SELECT *` result, and a derived value spliced into one is how it ends up looking
// like a column to the next reader (and, eventually, like one to write to).
//
// ⚠ NO `iban`/`revolut_username` here, deliberately: `FriendOrder.vue` reads those
// from `api.getPaymentSettings()`, which is the endpoint `money-rounding.spec.js`
// mocks to make the friend QR hermetic. Moving the settings into this payload would
// silently turn that mock dead.
//
// `null` — never an empty-string VS — when there is no order to pay for: the GET
// before anything was ordered, and the PUT that emptied the cart and deleted the row.
function friendOrderPayment(order) {
  return order ? { variable_symbol: friendOrderVariableSymbol(order.id) } : null;
}

router.get('/cycle/:cycleId/friend/:friendId', (req, res) => {
  const { cycleId, friendId } = req.params;

  // Validate password
  const validation = validateCyclePassword(req, cycleId);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // SEC-A3: the authenticated friend may only act on their own order
  const ownership = enforceOrderOwnership(req, friendId);
  if (ownership.error) {
    return res.status(ownership.status).json({ error: ownership.error });
  }

  // Validate friend exists and is active (global, no cycle check)
  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  // Get existing order for this friend in this cycle (don't auto-create)
  const order = db.prepare('SELECT * FROM orders WHERE friend_id = ? AND cycle_id = ?').get(friendId, cycleId);

  // Get order items if order exists
  const items = order ? db.prepare(`
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1, p.variant_label
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id) : [];

  res.json({
    order: order || null,
    items,
    friend: { id: friend.id, name: friend.name, packeta_address: friend.packeta_address || null },
    cycle: validation.cycle,
    payment: friendOrderPayment(order)
  });
});

// Update cart by cycle and friend (password protected)
router.put('/cycle/:cycleId/friend/:friendId', (req, res) => {
  const { cycleId, friendId } = req.params;

  // Validate password
  const validation = validateCyclePassword(req, cycleId);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // SEC-A3: the authenticated friend may only act on their own order
  const ownership = enforceOrderOwnership(req, friendId);
  if (ownership.error) {
    return res.status(ownership.status).json({ error: ownership.error });
  }
  const cycle = validation.cycle;

  // Check if cycle is locked
  if (cycle.status === 'locked' || cycle.status === 'completed') {
    return res.status(403).json({ error: 'Objednavky su uzamknute' });
  }

  // Validate friend exists and is active (global, no cycle check)
  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  // Get or create order for this friend in this cycle
  let order = db.prepare('SELECT * FROM orders WHERE friend_id = ? AND cycle_id = ?').get(friendId, cycleId);

  if (!order) {
    const result = db.prepare(`
      INSERT INTO orders (friend_id, cycle_id) VALUES (?, ?)
    `).run(friendId, cycleId);
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  }

  const { items } = req.body; // Array of { product_id, variant, quantity }

  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'items musia byt pole' });
  }

  // Get markup ratio for price calculation (default to 1.0 if not set)
  const markupRatio = cycle.markup_ratio || 1.0;

  // Stock limit validation — counts OTHER friends' submitted orders AND every
  // live guest sub-order in this cycle (helpers/stock.js). Runs outside the write
  // transaction below: safe only single-process, see the warning in that helper.
  const violations = stockViolations(cycleId, gramsByProductFromItems(items), { excludeFriendId: friendId });
  if (violations.length > 0) {
    return res.status(400).json({
      error: 'Prekročený limit zásob',
      details: violations
    });
  }

  // Update items in a transaction
  const updateItems = db.transaction((orderItems) => {
    // Clear existing items
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);

    let total = 0;

    for (const item of orderItems) {
      // ⚠ FUP-T15 — every one of the three client values on this line reached a
      // bind unchecked, and the route creates the order row BEFORE it reads
      // `items` (see the get-or-create above), so the resulting 500 left an empty
      // `draft` order committed — a HALF-WRITE the admin then saw in the cycle's
      // order list as a friend who "ordered nothing".
      //
      // `item?.` (not `item.`) because a literal `null` element was a TypeError on
      // `.quantity` — same body, same route, same 500 + stack. `guest.js`'s
      // `priceRequestedItems` already reads its items this way; the two disagreed.
      //
      // `variant` needs no guard: `basePriceForVariant` refuses anything that is
      // not a known STRING (helpers/pricing.js), so the line is dropped before the
      // insert — proven, not assumed, by the variant shapes in the shape matrix.
      //
      // ⚠ ORDER MATTERS: the sanitizing must come BEFORE the `<= 0` test, not
      // after. `<=` on an object is a ToPrimitive call, and `{"quantity":{"toString":1}}`
      // throws there ("Cannot convert object to primitive value") — the FUP-T12
      // review's lesson, one line earlier than the bind everyone was looking at.
      // (`{}` and `true` are merely NaN/1 in that comparison, so the shape matrix
      // needs `{toString:1}` to see it at all.)
      const quantity = bindValue(item?.quantity);
      if (quantity === undefined) continue;
      if (quantity <= 0) continue;

      // Unbindable ⇒ `undefined` ⇒ binds as NULL ⇒ matches no product ⇒ the line is
      // dropped, exactly as an unknown product id already was.
      const productId = bindValue(item?.product_id);

      // Get product and base price
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) continue;

      // An UNKNOWN variant is dropped, not silently priced at the 250g price:
      // that old fallback let a client buy real goods under a made-up variant
      // that helpers/stock.js scores at 0 g, walking straight past
      // products.stock_limit_g. ('unit' stays priceable — see helpers/pricing.js.)
      const basePrice = basePriceForVariant(product, item?.variant);
      if (!basePrice) continue;

      // Apply markup to get final price (round to 2 decimal places)
      const price = applyMarkup(basePrice, markupRatio);

      db.prepare(`
        INSERT INTO order_items (order_id, product_id, variant, quantity, price)
        VALUES (?, ?, ?, ?, ?)
      `).run(order.id, productId, item.variant, quantity, price);

      total += price * quantity;
    }

    // Update order total
    // If cart is now empty, delete the order entirely (order was canceled)
    // Otherwise preserve existing status
    // ⚠ THE PRODUCTION MONEY BUG. `applyMarkup` rounds each `price`, but this loop
    // ACCUMULATES them, and `15.00 + 11.19` is `26.189999999999998` in IEEE-754. The
    // raw sum used to be stored here, every screen hid it behind `toFixed(2)`, and
    // the friend's banking app refused the Pay-by-Square QR with
    // `Nesprávna suma: 26.189999999999998`. Rounded once, at the write.
    //
    // ⚠ THE ZERO TEST STAYS ON THE RAW SUM. `total === 0` means "the cart is empty",
    // and this branch DELETES the order — rounding first would make a sub-cent total
    // (unreachable today, but one price change away) destroy a real order instead of
    // storing it. Rounding belongs on the value being written, not on the guard.
    if (total === 0) {
      db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
      return { total: 0, deleted: true };
    } else {
      const storedTotal = roundMoney(total);
      db.prepare('UPDATE orders SET total = ? WHERE id = ?').run(storedTotal, order.id);
      return { total: storedTotal, deleted: false };
    }
  });

  const result = updateItems(items);

  // If order was deleted (canceled), return empty response
  if (result.deleted) {
    return res.json({
      order: null,
      items: [],
      friend: { id: friend.id, name: friend.name },
      cycle,
      payment: null
    });
  }

  // Return updated order
  const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const updatedItems = db.prepare(`
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1, p.variant_label
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);

  res.json({
    order: updatedOrder,
    items: updatedItems,
    friend: { id: friend.id, name: friend.name },
    cycle,
    payment: friendOrderPayment(updatedOrder)
  });
});

// Submit order by cycle and friend (password protected)
router.post('/cycle/:cycleId/friend/:friendId/submit', (req, res) => {
  const { cycleId, friendId } = req.params;

  // Validate password
  const validation = validateCyclePassword(req, cycleId);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // SEC-A3: the authenticated friend may only act on their own order
  const ownership = enforceOrderOwnership(req, friendId);
  if (ownership.error) {
    return res.status(ownership.status).json({ error: ownership.error });
  }
  const cycle = validation.cycle;

  // Check if cycle is locked
  if (cycle.status === 'locked' || cycle.status === 'completed') {
    return res.status(403).json({ error: 'Objednavky su uzamknute' });
  }

  // Validate friend exists and is active (global, no cycle check)
  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE friend_id = ? AND cycle_id = ?').get(friendId, cycleId);

  if (!order) {
    return res.status(404).json({ error: 'Objednavka neexistuje' });
  }

  // Check if order has items
  const itemCount = db.prepare('SELECT COUNT(*) as count FROM order_items WHERE order_id = ?').get(order.id);
  if (itemCount.count === 0) {
    return res.status(400).json({ error: 'Objednavka je prazdna' });
  }

  // Stock limit validation on submit — a draft that was legal when it was saved
  // must not slip through after other friends OR guests took the rest of the
  // stock in the meantime (helpers/stock.js). Same single-process caveat as the
  // cart PUT: the check is not inside a transaction with the write.
  const orderItems = db.prepare('SELECT product_id, variant, quantity FROM order_items WHERE order_id = ?').all(order.id);
  const submitViolations = stockViolations(cycleId, gramsByProductFromItems(orderItems), { excludeFriendId: friendId });
  if (submitViolations.length > 0) {
    return res.status(400).json({
      error: 'Prekročený limit zásob',
      details: submitViolations
    });
  }

  // Handle pickup location / parcel delivery
  const { pickup_location_id, pickup_location_note, use_parcel_delivery, packeta_address } = req.body || {};

  if (use_parcel_delivery) {
    // Validate parcel is enabled for this cycle
    if (!cycle.parcel_enabled) {
      return res.status(400).json({ error: 'Doručenie Packetou nie je pre tento cyklus dostupné' });
    }
    // ⚠ FUP-T12: the type guard is folded into the route's EXISTING required rule —
    // same status, same message. `?.` only covers null/undefined, so a number or an
    // object reached `.trim()` and threw a TypeError ⇒ 500 plus a stack in the log.
    if (typeof packeta_address !== 'string' || !packeta_address.trim()) {
      return res.status(400).json({ error: 'Adresa výdajného miesta je povinná' });
    }
    // Submit with parcel delivery — clear pickup fields.
    //
    // `delivery_fee` is a money column of its own, and `paymentTotal` on the client
    // is `total + delivery_fee` — so an unrounded cycle fee would seed the drift into
    // the QR of every parcel order in the cycle even with a correct total.
    db.prepare(`
      UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
        delivery_fee = ?, packeta_address = ?,
        pickup_location_id = NULL, pickup_location_note = NULL
      WHERE id = ?
    `).run(roundMoney(cycle.parcel_fee || 0), packeta_address.trim(), order.id);
  } else {
    // Standard pickup — clear parcel fields
    //
    // ⚠ FUP-T15 — both fields below were bound unchecked (500 + ~1.1 KB of stack).
    // The presence test stays on the RAW value so a present-but-unbindable id still
    // enters the lookup and is refused with this route's own 400; mapping it to
    // "absent" would submit the order with no pickup location and a 200.
    const pickupLocationId = bindValue(pickup_location_id);
    if (pickup_location_id !== undefined && pickup_location_id !== null) {
      // ⚠ FUP-T25 — ASK `helpers/pickup.js`, and for the same reason FUP-T23 made the
      // DELETE guard ask it. This line used to be a BYTE COPY of `activeLocation()` —
      // the same SELECT on id plus the active flag, refused the same way with the
      // same sentence — while the sibling `PATCH …/pickup` already called the helper
      // for this exact gate. (The statement itself is NOT repeated here, not even in
      // a comment: FUP-T25's acceptance is a grep that must return exactly one hit.)
      //
      // It was never a defect — both copies agreed — but this route and that PATCH
      // are the ONLY writers of `pickup_location_id`, and FUP-T23's claim that "no
      // sequence of API calls can leave a party pointing at a row that does not
      // exist" rests on BOTH of them refusing a non-active point. With two copies, a
      // mutation in the helper reddened only one of them; with one home it reddens
      // both, which is the property that makes that claim testable at all.
      //
      // ⚠ A DIFFERENT QUESTION FROM `pickupLocationInUse()`, and they must not be
      // merged: that one asks "is this point REFERENCED?" and fails CLOSED (broad,
      // both stores, unbindable ⇒ "in use"); this one asks "is it CHOOSABLE?" and
      // fails to `null` (narrow, `active = 1`, unbindable ⇒ the caller's own 400).
      //
      // ⚠ BEHAVIOUR-IDENTICAL, including the FUP-T15 bind semantics: the helper runs
      // the SAME `bindValue()` internally, so an unbindable id still lands here as a
      // 400 rather than as "absent". The presence test above stays on the RAW value.
      // The refusal keeps NO `field` marker — the PATCH's envelope carries one
      // because its body has two candidate fields; this one never has.
      if (!activeLocation(pickup_location_id)) {
        return res.status(400).json({ error: 'Vybrané miesto vyzdvihnutia neexistuje alebo nie je aktívne' });
      }
    }

    db.prepare(`
      UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
        pickup_location_id = ?, pickup_location_note = ?,
        delivery_fee = 0, packeta_address = NULL
      WHERE id = ?
    `).run(
      // `pickupLocationId` is already proved bindable by the gate above (an
      // unbindable one returned 400). The NOTE has no rule of its own, so an
      // unbindable one is treated as ABSENT — which on this UPDATE means the same
      // NULL an absent note already writes, byte for byte. It is not "coercion on
      // an update": this statement writes the column on every submit regardless.
      pickupLocationId || null,
      pickupLocationId ? null : (bindValue(pickup_location_note) || null),
      order.id
    );
  }

  const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const items = db.prepare(`
    SELECT oi.*, p.name as product_name, p.roast_type, p.description1, p.variant_label
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);

  res.json({
    order: updatedOrder,
    items,
    friend: { id: friend.id, name: friend.name },
    cycle,
    payment: friendOrderPayment(updatedOrder)
  });
});

// Admin: Mark order as paid/unpaid (creates payment transaction)
router.patch('/:id/paid', requireAdmin, (req, res) => {
  const { paid } = req.body;
  const order = db.prepare(`
    SELECT o.*, c.name as cycle_name
    FROM orders o
    JOIN order_cycles c ON c.id = o.cycle_id
    WHERE o.id = ?
  `).get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Objednavka neexistuje' });
  }

  // ⚠ A DRAFT MAY NOT BE MARKED PAID. Marking paid INSERTs a `payment` transaction
  // for `order.total` (below), which moves the friend's real balance — so on a draft
  // it turned the value of a cart nobody ever submitted into a real payment record,
  // invisible to every aggregate that filters on `status = 'submitted'` (the Sumár
  // sheet, the analytics, the stock counter) while still sitting in the ledger.
  // Reachable through the UI: the checkbox rendered for every row that was not
  // 'none', and a failed submit leaves a draft behind (`doSubmitOrder` PUTs the cart
  // first, and the get-or-create above inserts it as 'draft').
  //
  // Mirrors the guard `PATCH /:id/packed` has always had — same shape, same reason:
  // a whole-order flag only means something once there IS an order.
  if (order.status !== 'submitted') {
    return res.status(400).json({ error: 'Len odoslané objednávky môžu byť označené ako zaplatené' });
  }

  // ⚠ `roundMoney` on BOTH legs, even though `orders.total` is written rounded from
  // this release on: rows created BEFORE the fix still hold unrounded totals, and
  // this toggle is how one of them enters the friend's real balance. Rounding at the
  // ledger boundary is what stops a legacy row leaving 1e-14 on a balance forever.
  // (The reversal negates the ROUNDED value, so the pair still cancels exactly.)
  const paymentAmount = roundMoney(order.total);

  // Use transaction to ensure consistency
  const togglePaid = db.transaction(() => {
    if (paid && !order.paid) {
      // Marking as paid - create payment transaction
      db.prepare(`
        INSERT INTO transactions (friend_id, order_id, type, amount, note)
        VALUES (?, ?, 'payment', ?, ?)
      `).run(order.friend_id, order.id, paymentAmount, order.cycle_name);
    } else if (!paid && order.paid) {
      // Marking as unpaid - create reversal transaction (negative payment)
      db.prepare(`
        INSERT INTO transactions (friend_id, order_id, type, amount, note)
        VALUES (?, ?, 'payment', ?, ?)
      `).run(order.friend_id, order.id, -paymentAmount, `${order.cycle_name} - storno`);
    }

    db.prepare('UPDATE orders SET paid = ? WHERE id = ?').run(paid ? 1 : 0, req.params.id);
  });

  togglePaid();

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);

  // Get updated balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(order.friend_id);

  res.json({
    ...updated,
    friend_balance: balanceResult.balance
  });
});

// Admin: Toggle order packed status (creates charge/reversal transaction)
router.patch('/:id/packed', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Objednávka neexistuje' });
  }

  if (order.status !== 'submitted') {
    return res.status(400).json({ error: 'Len odoslané objednávky môžu byť označené ako zabalené' });
  }

  const newPackedStatus = order.packed ? 0 : 1;

  // ⚠ STAGE ORDER (DP-T4, 16 §UC-DP-007): `handed` IMPLIES `packed`, so a bag that
  // already left the admin's hands cannot be un-packed. Un-packing posts the LEDGER
  // REVERSAL and re-opens the bag for changes — neither may happen to something the
  // friend is already holding, without the admin first taking the hand-over back
  // (resolved conflict 4). Packing (0 → 1) is unaffected: it cannot contradict a
  // hand-over, it can only catch up with one.
  if (newPackedStatus === 0 && order.handed_over_at) {
    return res.status(409).json({
      error: 'Balíček je už odovzdaný — najprv zrušte odovzdanie.',
      reason: 'handed_over',
    });
  }

  // Gate: an order may only be marked packed once every one of its items has
  // been individually checked off in the Distribution view (persisted
  // order_items.packed). This makes the "Zabaliť" button a deliberate final
  // step and matches the server-side rule in the spec (Decision 3 / UC-GSO-011).
  //
  // GSO-T7 completed the rule: `packingItemStats()` UNIONs the guest items placed
  // through this host's share link for this cycle (cancelled sub-orders excluded),
  // so a colleague's untouched bag blocks the pack exactly like an own item does.
  // The requirement is therefore "at least one item across own + guest, and all of
  // them packed" — a host with zero own items but guest items IS packable, which is
  // why the count is no longer taken over `order_items` alone.
  //
  // Zero items overall still 409s: there is nothing to check off, so nothing to
  // confirm. (Unreachable through the API today — emptying a friend's cart deletes
  // the order row instead of leaving a zero-item one — but it keeps the endpoint
  // agreeing with the frontend, whose "Zabaliť" is disabled in that state.)
  if (newPackedStatus === 1) {
    const itemStats = packingItemStats({
      orderId: order.id,
      friendId: order.friend_id,
      cycleId: order.cycle_id,
    });
    if (itemStats.total === 0 || (itemStats.packed_count || 0) < itemStats.total) {
      return res.status(409).json({ error: 'Najprv označ všetky položky ako zabalené' });
    }
  }

  // Use transaction to ensure consistency
  const togglePacked = db.transaction(() => {
    if (newPackedStatus === 1) {
      packOrder(order);
      return { ok: true };
    }
    // ⚠ THE §UC-DP-007 GATE, REPEATED AS A PREDICATE INSIDE THE TRANSACTION. On the
    // other two doors it rides on the route's own UPDATE; here the only write is
    // `unpackOrder()`, and `helpers/packing.js` is deliberately OUT OF SCOPE (its
    // two ledger writes are the one home for the packing moment and must not learn
    // about hand-overs). So the predicate is asserted as its own statement, FIRST
    // and before any write, and the abort leaves the transaction with nothing to
    // roll back. Redundant with the pre-check under `instances: 1`, and kept for the
    // same reason every other check-then-write here keeps its inner half: it is the
    // layer that survives PM2 cluster mode and the day an `await` lands between them.
    const still = db.prepare(
      'SELECT id FROM orders WHERE id = ? AND handed_over_at IS NULL'
    ).get(order.id);
    if (!still) return { conflict: 'handed_over' };
    unpackOrder(order);
    return { ok: true };
  });

  const toggled = togglePacked();
  if (toggled.conflict === 'handed_over') {
    return res.status(409).json({
      error: 'Balíček je už odovzdaný — najprv zrušte odovzdanie.',
      reason: 'handed_over',
    });
  }

  const updated = db.prepare(`
    SELECT o.*, f.name as friend_name
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    WHERE o.id = ?
  `).get(req.params.id);

  // Get updated balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(order.friend_id);

  res.json({
    ...updated,
    friend_balance: balanceResult.balance
  });
});

// Admin: STAGE 3 — the friend's bag left my hands (DP-T3, 16 §UC-DP-004).
//
// „Dropped at Packeta, left at the pickup point, handed to the friend." It sits
// next to `PATCH /:id/packed` above because the two are the same checklist one step
// apart — and the difference between them is the whole point of this route:
//
// ⚠ **STAGE 2 IS THE LEDGER MOMENT. STAGE 3 IS LEDGER-NEUTRAL BY CONSTRUCTION.**
// `PATCH /:id/packed` posts the charge and its reversal through
// `helpers/packing.js`; this handler writes `handed_over_at` and the outbox, and
// NOTHING ELSE — no `transactions` row in either direction, and no `total` /
// `paid` / `packed` / `delivered` / `delivery_fee` write. There is no path through
// it that reaches a money column, and `distribution-handover.spec.js` pins that
// from two sides (the friend's own ledger through `GET /friends/:id/detail`, and a
// `MAX(id)` watermark filtered to the friend and the order).
//
// ⚠ **AN EXPLICIT BOOLEAN, NEVER A TOGGLE.** Unlike the host's `delivered` tick,
// an absent field does not flip the state: a hand-over enqueues messages, so the
// intent has to be stated. `readHandedOverFlag()` is the one binder; `{}`, `true`,
// `[id]`, `'abc'`, `'true'` and `1` are all 400 and write nothing.
//
// ⚠ **NO CYCLE-STATUS GATE** — the same basis as `PATCH /:id/packed` and the pickup
// PATCH above: the action is needed while the cycle is `locked` (that is when the
// admin distributes), and a correction may be needed after `completed`.
//
// ⚠ **ONE SYNCHRONOUS TRANSACTION, RE-CHECKED INSIDE IT.** The pre-checks below are
// redundant under TODAY's runtime (`instances: 1` + a fully synchronous handler), and
// that is not a reason to drop the predicate in the UPDATE: it is the layer that
// survives PM2 cluster mode, and the day this handler gains an `await` between a
// check and its write it becomes the only thing standing between two admins on two
// phones and a bag handed over twice (GA-T8). There is deliberately no `await`
// anywhere in here.
//
// Reversal (`false`) has NO `packed` dependency and no gate of its own — the
// mis-click case is always allowed.
router.patch('/:id/handed-over', requireAdmin, (req, res) => {
  const handedOver = readHandedOverFlag(req.body);
  if (handedOver === undefined) {
    return res.status(400).json({
      error: 'Zadajte, či je balíček odovzdaný',
      field: 'handed_over',
    });
  }

  const order = db.prepare(`
    SELECT id, friend_id, cycle_id, status, packed, packed_at, handed_over_at
      FROM orders WHERE id = ?
  `).get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Objednávka neexistuje' });
  }

  // Same family as the packed route's guard, and for the same reason: a whole-order
  // flag only means something once there IS an order. A draft cart is not a bag.
  if (order.status !== 'submitted') {
    return res.status(400).json({ error: 'Len odoslané objednávky môžu byť označené ako odovzdané' });
  }

  // PO Q8.a: no partial-bag hand-over. An ALREADY handed-over bag skips this (it is
  // the idempotent case, and re-checking `packed` there would refuse a second click
  // on a bag that has demonstrably already left).
  if (handedOver && !order.packed && !order.handed_over_at) {
    return res.status(409).json({
      error: 'Najprv označte balíček ako zabalený',
      reason: 'not_packed',
    });
  }

  const apply = db.transaction(() => {
    const current = db.prepare('SELECT id, packed, handed_over_at FROM orders WHERE id = ?').get(order.id);
    if (!current) return { conflict: 'gone' };

    // The party's delivery, resolved through `helpers/pickup.js` (which row stores
    // the pickup) + `helpers/delivery.js` (what it is). It decides the friend's
    // template key AND which guest bags travel inside this one.
    const delivery = partyDelivery(order.cycle_id, order.friend_id);
    const guests = inheritingGuests(order.friend_id, order.cycle_id, delivery);

    const friendBag = {
      kind: 'friend',
      cycleId: order.cycle_id,
      orderId: order.id,
      friendId: order.friend_id,
      delivery,
    };
    const guestBags = guests.map((guest) => ({
      kind: 'guest',
      cycleId: order.cycle_id,
      guestOrderId: guest.id,
      hostFriendId: order.friend_id,
      delivery: guest.delivery,
    }));

    if (!handedOver) {
      // ⚠ Literal columns, one statement each — the request body is never spread
      // into an UPDATE, so nothing outside `handed_over_at` can be written here.
      db.prepare('UPDATE orders SET handed_over_at = NULL WHERE id = ?').run(order.id);

      // ⚠ A REVERSAL OF NOTHING REVERSES NOTHING. The spec's reversal is
      // unconditional, and taken literally that means a `false` on a bag that was
      // NEVER handed over still clears every live guest's stamp and deletes their
      // queued rows — so a per-bag hand-over (§UC-DP-005 case c, the withheld bag,
      // and case b's synthetic-host party in full) could be silently undone by a
      // no-op click on the host row. Inheritance is symmetric, and that is exactly
      // the reason: the guests are cleared because the HOST's hand-over is being
      // taken back, so when there was none to take back there is nothing to
      // propagate. The host's own dequeue still runs (it is scoped to this
      // `order_id` and finds nothing when the bag was never handed over).
      const reverted = !!current.handed_over_at;
      if (reverted) {
        const clear = db.prepare('UPDATE guest_orders SET handed_over_at = NULL WHERE id = ?');
        for (const guest of guests) clear.run(guest.id);
      }
      return {
        guestIds: reverted ? guests.map((guest) => guest.id) : [],
        queued: 0,
        dequeued: cancelForUnHandOver(reverted ? [friendBag, ...guestBags] : [friendBag]),
        cycleStage: null,
      };
    }

    // ⚠ WHAT THIS CALL ACTUALLY STAMPED — and the ONLY thing it may enqueue for.
    // `changes` from each UPDATE, never "the bag ended up handed over".
    let orderStamped = false;
    if (!current.handed_over_at) {
      // THE RE-CHECK, as a predicate rather than a second read: `changes === 0`
      // after the pre-check above means the bag was un-packed between them.
      const written = db.prepare(`
        UPDATE orders SET handed_over_at = CURRENT_TIMESTAMP
         WHERE id = ? AND packed = 1 AND handed_over_at IS NULL
      `).run(order.id);
      if (written.changes === 0) return { conflict: 'not_packed' };
      orderStamped = true;
    }

    // ONE timestamp for the whole bag — read back, then BOUND to every guest, so the
    // host and their colleagues carry the identical string. Already-handed guests
    // keep their own first record (`handed_over_at IS NULL` in the predicate): the
    // first hand-over time is the record, here as on the order itself.
    const stamp = db.prepare('SELECT handed_over_at FROM orders WHERE id = ?').get(order.id).handed_over_at;
    const stampGuest = db.prepare(
      'UPDATE guest_orders SET handed_over_at = ? WHERE id = ? AND handed_over_at IS NULL'
    );
    const stampedBags = [];
    if (orderStamped) stampedBags.push(friendBag);
    for (let i = 0; i < guests.length; i += 1) {
      if (stampGuest.run(stamp, guests[i].id).changes > 0) stampedBags.push(guestBags[i]);
    }

    // ⚠ ENQUEUE ONLY FOR THE BAGS THIS CALL ACTUALLY STAMPED — not for every bag
    // that happens to be handed over. `enqueueForHandOver` dedupes on a `queued` row,
    // which is enough ONLY while every earlier row is still `queued`: the moment
    // module 21 moves one to `released`/`sent` (WA-T5), a second `handed_over: true`
    // on an ALREADY-handed bag would stop being deduped and mint a fresh full set —
    // duplicate „your coffee is at X" messages to real people, for a request that
    // changed no state at all. A no-op hand-over is not an event, so it queues
    // nothing. The case that matters is preserved by construction: a guest whose
    // sub-order arrived AFTER the host was handed over is stamped by this call, so
    // it IS in `stampedBags` and does get its message.
    //
    // ⚠ RECORDED, not a defect: `segment_key` freezes at enqueue time. Correcting a
    // party's pickup point after the hand-over leaves the queued row pointing at the
    // old target, and a delivery-type change plus a genuine re-hand-over can leave
    // two rows under different templates. Only module 21's GROUPING is affected — it
    // renders every body from the live row at release time — so this is 21's call to
    // refine (WA-T5), not a reason to rewrite history here.
    const queued = enqueueForHandOver(stampedBags);

    // §UC-DP-009 — the module-17 seam, called INSIDE the transaction, once per
    // request. LIVE since CS-T1: the first hand-over on a LOCKED cycle promotes it
    // to `ready` and this response echoes that string; on a cycle that is not
    // locked it is a no-op and `cycle_stage` is the cycle's unchanged stage (NULL
    // for an open one). ⚠ The response publishes the STAGE, not the helper's
    // `changed` flag — `cycle_stage` is a `<string|null>` by 16 §UC-DP-009, so read
    // `.stage` and never hand the whole return value to `res.json`.
    // ⚠ Nothing in module 16 writes `order_cycles.status` — completion is the
    // admin's button (§UC-DP-014), and `markCycleReady()` never touches it either.
    const { stage: cycleStage } = markCycleReady(order.cycle_id);

    return { guestIds: guests.map((guest) => guest.id), queued, dequeued: 0, cycleStage };
  });

  const applied = apply();
  if (applied.conflict === 'gone') {
    return res.status(404).json({ error: 'Objednávka neexistuje' });
  }
  if (applied.conflict === 'not_packed') {
    return res.status(409).json({
      error: 'Najprv označte balíček ako zabalený',
      reason: 'not_packed',
    });
  }

  const updated = db.prepare(
    'SELECT id, packed, packed_at, handed_over_at FROM orders WHERE id = ?'
  ).get(order.id);

  // Enough for the board to patch its rows in place without a reload (§UC-DP-004).
  res.json({
    order: { ...updated, stage: orderStage(updated) },
    guests: applied.guestIds.map((id) => {
      const row = loadSubOrder(id);
      return { id, handed_over_at: row ? row.handed_over_at : null, stage: guestOrderStage(row) };
    }),
    queued_notifications: applied.queued,
    dequeued_notifications: applied.dequeued,
    cycle_stage: applied.cycleStage,
  });
});

// Admin: set a PARTY'S PICKUP POINT — under all circumstances.
//
// Why this exists: `pickup_location_id` / `pickup_location_note` used to be written
// EXACTLY ONCE, by the friend, in `POST /cycle/:cycleId/friend/:friendId/submit`
// above. Friends pick the wrong place and the place genuinely changes afterwards, so
// the packing sheet (Distribúcia) disagreed with where the bags actually go.
//
// ⚠ KEYED ON (cycle, friend), NOT ON AN ORDER ID — this REPLACES the `PATCH
// /orders/:id/pickup` shipped on 2026-09-02 (PO decision, 2026-09-03: "chcem, aby …
// bolo adminovi umožnené za každých okolností zmeniť pickup point"). The reported hole
// was a host who ordered nothing themselves while their unregistered colleague did:
// they are still the pickup party — they collect the bags — but they have NO `orders`
// row, so an order-id route could not even address them. Two more cases came with it:
// a DRAFT own order (the old submitted-only gate refused it) and a PACKETA order (the
// old route refused it outright).
//
// ⚠ `helpers/pickup.js` CHOOSES THE STORE, and it must stay the only thing that does.
// A party's pickup lives on their `orders` row when one exists (any status) and on
// their `guest_order_links` row otherwise. That choice cannot be made per surface: the
// orders tab lists a party with an order OR guest bags, while the Distribution sheet
// synthesises its no-own-order rows from `status = 'submitted'` — so a host on a draft
// is "has an own order" to one screen and not to the other, and a per-surface choice
// would write to one store and read back the other.
//
// ⚠ STILL NO CYCLE-OPEN GATE. The correction is needed exactly when the cycle is
// LOCKED — that is when the admin packs. `PATCH /:id/packed` has none either.
//
// ⚠ STILL NO `transactions` ROW, and no `total`/`status`/`paid`/`packed` write. The
// one money column this can now move is `delivery_fee`, and only on a Packeta order
// being switched to personal pickup — see `applyPickup`, which records why that is
// ledger-neutral (both ledger legs use `order.total` alone; the fee has never entered
// `transactions`). The response reports the clearance so the UI can say what happened.
router.patch('/cycle/:cycleId/friend/:friendId/pickup', requireAdmin, (req, res) => {
  const { cycleId, friendId } = req.params;

  const cycle = db.prepare('SELECT id FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  const target = pickupTargetFor(cycleId, friendId);
  if (!target) {
    // Nowhere to record a pickup: this friend neither ordered in this cycle nor ever
    // shared a link for it. Such a party is not listed on the orders tab either, so
    // the UI cannot reach this — it is the honest answer rather than a silent no-op.
    return res.status(404).json({ error: 'Pre tohto priateľa nie je v tomto cykle čo upraviť' });
  }

  const { pickup_location_id, pickup_location_note } = req.body || {};

  // EXPLICIT INTENT, exactly one of the two (the `items: []` rule from GSO-T4 in its
  // non-destructive form). `{}`, both, or neither is a 400 that writes nothing — a
  // route that treated "no field" as "clear the column" would wipe a real pickup on a
  // malformed request and answer 200.
  //
  // Consequence, recorded: there is deliberately NO way to clear a pickup back to
  // empty. The admin's job here is to name the FINAL place.
  const wantsLocation = pickup_location_id !== undefined && pickup_location_id !== null;
  const wantsNote = pickup_location_note !== undefined && pickup_location_note !== null;

  if (wantsLocation === wantsNote) {
    return res.status(400).json({
      error: 'Zadajte buď miesto vyzdvihnutia, alebo poznámku',
      field: 'pickup_location_id'
    });
  }

  let value;
  if (wantsLocation) {
    const location = activeLocation(pickup_location_id);
    if (!location) {
      return res.status(400).json({
        error: 'Vybrané miesto vyzdvihnutia neexistuje alebo nie je aktívne',
        field: 'pickup_location_id'
      });
    }
    // The row's own integer id, never the bound request value: it can then not land
    // in the column as the text `'3'`.
    value = { locationId: location.id };
  } else {
    // The "Iné" case — free text, so it gets the module 11 treatment: a type gate
    // folded into the required rule, plus a server bound the frontend mirrors as
    // `maxlength`.
    if (typeof pickup_location_note !== 'string' || !pickup_location_note.trim()) {
      return res.status(400).json({ error: 'Poznámka je povinná', field: 'pickup_location_note' });
    }
    const note = pickup_location_note.trim();
    if (note.length > 200) {
      return res.status(400).json({ error: 'Poznámka je príliš dlhá (max 200 znakov)', field: 'pickup_location_note' });
    }
    value = { note };
  }

  const effects = applyPickup(target, value);

  // The uniform shape both admin surfaces patch their row from — same three fields
  // whichever store was written, plus what the switch had to clear.
  res.json({
    friend_id: Number(friendId),
    cycle_id: Number(cycleId),
    stored_on: target.kind,
    ...readPickup(cycleId, friendId),
    ...effects,
  });
});

// Admin: Get all orders for a cycle (includes all active friends)
router.get('/cycle/:cycleId', requireAdmin, (req, res) => {
  const cycleId = req.params.cycleId;

  // Get all active friends with balance
  const allFriends = db.prepare(`
    SELECT f.id, f.name, COALESCE(SUM(t.amount), 0) as balance
    FROM friends f
    LEFT JOIN transactions t ON t.friend_id = f.id
    WHERE f.active = 1
    GROUP BY f.id
    ORDER BY f.name
  `).all();

  // Get existing orders for this cycle
  const existingOrders = db.prepare(`
    SELECT o.*, f.name as friend_name, pl.name as pickup_location_name
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    LEFT JOIN pickup_locations pl ON pl.id = o.pickup_location_id
    WHERE o.cycle_id = ?
  `).all(cycleId);

  // Create a map of friend_id to order
  const ordersByFriend = {};
  for (const order of existingOrders) {
    ordersByFriend[order.friend_id] = order;
  }

  // Build combined list
  // Friends with orders always appear; friends without orders only for non-submitted view
  const balanceByFriend = {};
  for (const f of allFriends) {
    balanceByFriend[f.id] = f.balance;
  }

  const orders = [];

  // Add friends who have orders in this cycle
  for (const order of existingOrders) {
    order.items = db.prepare(`
      SELECT oi.*, p.name as product_name, p.purpose, p.variant_label
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
      ORDER BY
        CASE p.purpose
          WHEN 'Espresso' THEN 1
          WHEN 'Filter' THEN 2
          WHEN 'Kapsule' THEN 3
          ELSE 4
        END,
        p.name, oi.variant
    `).all(order.id);

    order.count_150g = order.items
      .filter(i => i.variant === '150g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_200g = order.items
      .filter(i => i.variant === '200g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_250g = order.items
      .filter(i => i.variant === '250g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_500g = order.items
      .filter(i => i.variant === '500g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_1kg = order.items
      .filter(i => i.variant === '1kg')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_20pc5g = order.items
      .filter(i => i.variant === '20pc5g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_8pc12g = order.items
      .filter(i => i.variant === '8pc12g')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.count_unit = order.items
      .filter(i => i.variant === 'unit')
      .reduce((sum, i) => sum + i.quantity, 0);
    order.friend_balance = balanceByFriend[order.friend_id] ?? 0;

    orders.push(order);
  }

  // Add friends without orders as placeholders
  const friendsWithOrders = new Set(existingOrders.map(o => o.friend_id));
  for (const friend of allFriends) {
    if (!friendsWithOrders.has(friend.id)) {
      orders.push({
        id: null,
        friend_id: friend.id,
        friend_name: friend.name,
        friend_balance: friend.balance,
        cycle_id: parseInt(cycleId),
        status: 'none',
        paid: 0,
        packed: 0,
        total: 0,
        items: [],
        count_150g: 0,
        count_200g: 0,
        count_250g: 0,
        count_500g: 0,
        count_1kg: 0,
        count_20pc5g: 0,
        count_8pc12g: 0,
        count_unit: 0
      });
    }
  }

  // GSO-T6 (§UC-GSO-009): the guest sub-orders placed through each host's share
  // link, NESTED under that host's row — the admin sees them where the money and
  // the bags are, not in a separate list. Each carries its items plus both
  // single-owner flags: `paid` (the admin toggles it via
  // `PATCH /api/guest-orders/:id/paid`) and `delivered` (the HOST's hand-over tick,
  // read-only here).
  //
  // Always an array, never undefined, so the client has one shape to render.
  const subOrdersByHost = cycleSubOrdersByHost(cycleId);
  for (const order of orders) {
    order.guest_orders = subOrdersByHost.get(order.friend_id) || [];
  }

  // §Edge Cases, "host has no own order at lock time": a host whose colleagues
  // ordered but who ordered nothing themselves must still appear, or their guests
  // (and the guests' money) would be invisible on this screen. The placeholder loop
  // above only covers ACTIVE friends, so a deactivated host — whose link 410s for
  // new guests while the existing sub-orders live on — needs one built here.
  const listedFriends = new Set(orders.map(o => o.friend_id));
  for (const [hostFriendId, subOrders] of subOrdersByHost) {
    if (listedFriends.has(hostFriendId)) continue;
    orders.push({
      id: null,
      friend_id: hostFriendId,
      friend_name: subOrders[0].host_name,
      friend_balance: balanceByFriend[hostFriendId] ?? 0,
      cycle_id: parseInt(cycleId),
      status: 'none',
      paid: 0,
      packed: 0,
      total: 0,
      items: [],
      count_150g: 0,
      count_200g: 0,
      count_250g: 0,
      count_500g: 0,
      count_1kg: 0,
      count_20pc5g: 0,
      count_8pc12g: 0,
      count_unit: 0,
      guest_orders: subOrders
    });
  }

  // The pickup point of a party who has NO `orders` row (PO decision, 2026-09-03).
  // Both placeholder loops above build such rows with `id: null` and no pickup at
  // all, which is exactly the reported bug: a host whose only stake is their
  // colleague's bags is the party who collects them, and the screen said nothing
  // about where. Their pickup lives on the share link — `helpers/pickup.js` is the one
  // place that decides that, and this fills the same three fields an `orders`-backed
  // row already carries, so the frontend has ONE shape to render and one to patch.
  const linkPickups = linkPickupsByHost(cycleId);
  for (const order of orders) {
    if (order.id) continue;
    const pickup = linkPickups.get(order.friend_id);
    order.pickup_location_id = pickup ? pickup.pickup_location_id : null;
    order.pickup_location_note = pickup ? pickup.pickup_location_note : null;
    order.pickup_location_name = pickup ? pickup.pickup_location_name : null;
  }

  // 15 §UC-PL-003 item 6 — the symbol the admin matches a bank statement line by,
  // on the friend row AND on every nested guest row. Done in ONE pass here, after both
  // placeholder loops and the link-pickup fill, so every row shape this endpoint can
  // emit goes through the same line.
  //
  // ⚠ A PLACEHOLDER CARRIES `null`, NOT `''`: `id: null` is a friend who has not
  // ordered (or a host whose only stake is their colleague's bags), so there is no debt
  // to quote. The empty string is what `helpers/payment.js` returns when it REFUSES an
  // out-of-range id, and the two must stay distinguishable on this screen.
  //
  // ⚠ The guest half is mapped into NEW objects rather than mutated in place: the rows
  // come from the shared `cycleSubOrdersByHost()`, and this endpoint is not the only
  // caller of it.
  for (const order of orders) {
    order.variable_symbol = order.id ? friendOrderVariableSymbol(order.id) : null;
    order.guest_orders = (order.guest_orders || []).map((sub) => ({
      ...sub,
      variable_symbol: guestOrderVariableSymbol(sub.id),
    }));
  }

  // Sort: submitted first, then draft, then none (by name within each group)
  orders.sort((a, b) => {
    const statusOrder = { submitted: 0, draft: 1, none: 2 };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    return a.friend_name.localeCompare(b.friend_name);
  });

  res.json(orders);
});

export default router;
