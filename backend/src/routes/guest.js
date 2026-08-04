import { Router } from 'express';
import db, { generateGuestToken } from '../db/schema.js';
import { abuseLimiter } from '../middleware/rate-limit.js';
import { gramsByProductFromItems, stockViolations, cycleAvailability } from '../helpers/stock.js';
import { basePriceForVariant, applyMarkup, VARIANT_PRICE_COLUMNS } from '../helpers/pricing.js';

const router = Router();

// Public guest ordering (§UC-GSO-001..003). The URL token IS the credential:
// no session, no password, no account — a colleague follows the host's link,
// picks products and pays the admin directly (Decision 1).
//
// Mounted BARE (no requireAdmin, no friend auth) but behind the shared
// `abuseLimiter` (Decision 6, same family as /invitations/code/:code), because
// these are unauthenticated write/lookup surfaces.
//
// ⚠ That limiter is ONE bucket (default 40 per IP per window) now shared by the
// public invite-code lookup, the onboarding submit and every `/g/:token` page
// load. A whole office behind a single NAT address therefore shares one budget
// and can exhaust it for each other. Spec-mandated for v1; if it bites, the fix
// is a separate limiter instance for the guest routes, not a higher global max.
//
// Because the body of a POST here is entirely attacker-controlled (the URL token
// is the only credential), NOTHING from it is trusted: identity strings go
// through asString(), quantities through asQuantity(), prices come from the DB
// snapshot, and status/paid/delivered/total/order_token are server-set.
//
// Status codes, deliberately distinct so the page can say the right thing:
//   404 — no such token (typo / never existed / revoked beyond recognition)
//   410 — the token is real but the door is closed: link deactivated, or the
//         cycle is not `open` (spec is explicit about 410 on GET)
//   409 — the cycle closed between loading the page and submitting (lock race)
//   400 — identity validation, empty cart, stock limits

const PRODUCT_COLUMNS = [
  'id', 'cycle_id', 'name', 'description1', 'description2', 'roast_type', 'purpose',
  'price_150g', 'price_200g', 'price_250g', 'price_500g', 'price_1kg', 'price_20pc5g', 'price_unit',
  'image', 'roastery', 'weight_grams', 'composition', 'variant_label',
  'source_bakery_product_id', 'source_variant_id', 'stock_limit_g',
].join(', ');

// Guests are shown FINAL prices: the markup is applied server-side (same formula
// and rounding as friend orders, helpers/pricing.js) and the ratio is not
// repeated here, so nothing downstream can apply it twice.
function withMarkup(product, markupRatio) {
  const out = { ...product };
  for (const column of Object.values(VARIANT_PRICE_COLUMNS)) {
    out[column] = applyMarkup(product[column], markupRatio);
  }
  return out;
}

// Bounds on an UNAUTHENTICATED write. Without them a single 10mb request body
// (index.js express.json limit) can persist hundreds of thousands of item rows,
// and a 200k-character name/phone would later be rendered in the host's and the
// admin's views. Generous enough that no real cart or contact detail hits them.
const MAX_ITEM_LINES = 100;
const MAX_ITEM_QUANTITY = 100;
const MAX_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 32;
const MAX_EMAIL_LENGTH = 160;

// Trimmed text out of an attacker-controlled body field. Returns:
//   ''    — field absent (null/undefined)
//   null  — field present but NOT text (object/array/function/symbol): invalid
//           input, and the reason this exists at all. `String(value)` throws a
//           TypeError on e.g. `{ toString: 1 }`, which would turn this
//           endpoint's 400-with-field contract into a 500 plus a logged stack.
// Callers treat falsy (both '' and null) as "missing", except for the optional
// e-mail, which distinguishes them.
function asString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return null;
}

// Integer quantity out of an attacker-controlled body field; 0 (⇒ line dropped)
// when it is not a usable number. Never throws — `parseInt(objectWithBadToString)`
// would.
function asQuantity(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// Only the host's first name is published to strangers — the guest needs to know
// whose order they are joining, not the host's contact details.
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function findLink(token) {
  return db.prepare(`
    SELECT gl.id, gl.token, gl.active, gl.cycle_id, gl.host_friend_id,
           f.name AS host_name, f.active AS host_active
    FROM guest_order_links gl
    JOIN friends f ON f.id = gl.host_friend_id
    WHERE gl.token = ?
  `).get(String(token || ''));
}

function findCycle(cycleId) {
  return db.prepare(
    'SELECT id, name, status, type, expected_date, plan_note, markup_ratio FROM order_cycles WHERE id = ?'
  ).get(cycleId);
}

// Resolve a token to an orderable (link, cycle) pair.
// `closedStatus` is the status to report when the cycle is not open: 410 for the
// listing (the door was already shut when the guest arrived), 409 for a submit
// (the door shut while they were shopping).
function resolveLink(token, closedStatus) {
  const link = findLink(token);
  if (!link) {
    return { status: 404, error: 'Tento odkaz na objednávku neexistuje' };
  }
  // A deactivated link OR a deactivated host both close the door. The host is
  // the one who hands the goods over and who every friend order path already
  // refuses when inactive (orders.js), so their link must not keep taking new
  // sub-orders — and consuming stock — after they can no longer log in.
  // Existing sub-orders survive either case; only new visits break.
  if (!link.active || !link.host_active) {
    return { status: 410, error: 'Tento odkaz už nie je aktívny. Požiadajte kolegu o nový.', reason: 'inactive' };
  }
  const cycle = findCycle(link.cycle_id);
  if (!cycle) {
    return { status: 404, error: 'Tento odkaz na objednávku neexistuje' };
  }
  if (cycle.status !== 'open') {
    return {
      status: closedStatus,
      error: 'Objednávanie v tomto cykle je už uzavreté.',
      reason: 'closed',
    };
  }
  return { link, cycle };
}

function paymentSettings() {
  const iban = db.prepare("SELECT value FROM settings WHERE key = 'payment_iban'").get();
  const revolut = db.prepare("SELECT value FROM settings WHERE key = 'payment_revolut_username'").get();
  return { iban: iban?.value || '', revolut_username: revolut?.value || '' };
}

// The guest's personal status/edit token (GSO-T4 serves the page). Same generator
// and unguessability requirement as the link token (SEC-S2), with a collision
// retry against the `order_token UNIQUE` constraint.
function uniqueOrderToken() {
  let token = generateGuestToken();
  while (db.prepare('SELECT id FROM guest_orders WHERE order_token = ?').get(token)) {
    token = generateGuestToken();
  }
  return token;
}

function loadOrder(id) {
  return db.prepare(`
    SELECT id, link_id, order_token, guest_name, guest_phone, guest_email, status, total,
           paid, paid_at, delivered, delivered_at, created_at
    FROM guest_orders WHERE id = ?
  `).get(id);
}

function loadItems(guestOrderId) {
  return db.prepare(`
    SELECT gi.id, gi.product_id, gi.variant, gi.quantity, gi.price,
           p.name AS product_name, p.purpose, p.roast_type, p.description1, p.variant_label
    FROM guest_order_items gi
    JOIN products p ON p.id = gi.product_id
    WHERE gi.guest_order_id = ?
    ORDER BY gi.id
  `).all(guestOrderId);
}

// GET /guest/:token — everything the public order page needs.
// No payment details here: Decision 1 gives the guest the IBAN, but only once
// they have a sub-order to pay for (see the submit response). An anonymous
// product listing must not carry it.
router.get('/:token', abuseLimiter, (req, res) => {
  const resolved = resolveLink(req.params.token, 410);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error, reason: resolved.reason });
  }
  const { link, cycle } = resolved;
  const markupRatio = cycle.markup_ratio || 1.0;

  const products = db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE cycle_id = ? AND active = 1 ORDER BY purpose, name`
  ).all(cycle.id).map((product) => withMarkup(product, markupRatio));

  res.json({
    cycle: {
      id: cycle.id,
      name: cycle.name,
      status: cycle.status,
      type: cycle.type,
      expected_date: cycle.expected_date,
      plan_note: cycle.plan_note,
    },
    host: { first_name: firstName(link.host_name) },
    products,
    // Stock limits count friend orders AND other guests' sub-orders.
    availability: cycleAvailability(cycle.id),
  });
});

// POST /guest/:token/orders — submit a guest sub-order.
router.post('/:token/orders', abuseLimiter, (req, res) => {
  // A submit into a closed cycle is the lock race → 409 (not 410).
  const resolved = resolveLink(req.params.token, 409);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error, reason: resolved.reason });
  }
  const { link, cycle } = resolved;
  const markupRatio = cycle.markup_ratio || 1.0;

  // Identity (Decision 7): name + mobile required, email optional, no SMS
  // verification. Every guest is thereby a contactable lead.
  //
  // asString() (not String()) because the body is attacker-controlled: an object
  // with a non-callable `toString` makes String()/parseInt() throw, which would
  // answer this endpoint's 400-with-field contract with a 500 and a stack trace.
  // `null` (an object where text was expected) and `''` are both falsy here, so
  // one check covers "not text" and "not filled in".
  const guestName = asString(req.body?.guest_name);
  if (!guestName) {
    return res.status(400).json({ error: 'Zadajte meno', field: 'guest_name' });
  }
  if (guestName.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `Meno je príliš dlhé (najviac ${MAX_NAME_LENGTH} znakov)`, field: 'guest_name' });
  }
  const guestPhone = asString(req.body?.guest_phone);
  if (!guestPhone) {
    return res.status(400).json({ error: 'Zadajte telefónne číslo (aspoň 9 číslic)', field: 'guest_phone' });
  }
  if (guestPhone.length > MAX_PHONE_LENGTH) {
    return res.status(400).json({ error: `Telefónne číslo je príliš dlhé (najviac ${MAX_PHONE_LENGTH} znakov)`, field: 'guest_phone' });
  }
  const phoneDigits = guestPhone.replace(/\s/g, '').replace(/\D/g, '');
  if (phoneDigits.length < 9) {
    return res.status(400).json({ error: 'Zadajte telefónne číslo (aspoň 9 číslic)', field: 'guest_phone' });
  }
  // E-mail is optional, so '' is fine — but `null` means "present and not text",
  // which is invalid input rather than an omitted field.
  const emailInput = asString(req.body?.guest_email);
  if (emailInput === null) {
    return res.status(400).json({ error: 'Neplatný e-mail', field: 'guest_email' });
  }
  const guestEmail = emailInput || null;
  if (guestEmail && guestEmail.length > MAX_EMAIL_LENGTH) {
    return res.status(400).json({ error: `E-mail je príliš dlhý (najviac ${MAX_EMAIL_LENGTH} znakov)`, field: 'guest_email' });
  }

  // Cap the row count BEFORE any per-line work: this is an unauthenticated write,
  // and the pricing loop does one SELECT per line.
  const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (requestedItems.length > MAX_ITEM_LINES) {
    return res.status(400).json({
      error: `Objednávka obsahuje priveľa položiek (najviac ${MAX_ITEM_LINES})`,
      field: 'items',
    });
  }

  // Cap the per-line quantity too. Products with a stock_limit_g are protected by
  // the check below, but an UNLIMITED product would otherwise accept
  // `quantity: 1e9` and persist a sub-order with a billions-of-euro total, which
  // then feeds the admin cycle views and (per GSO-T8) kilos and tier progress —
  // with no host/admin delete UI before GSO-T5. Decision 6's "no cap" is about
  // sub-orders per link, not units per line.
  if (requestedItems.some((item) => asQuantity(item?.quantity) > MAX_ITEM_QUANTITY)) {
    return res.status(400).json({
      error: `Množstvo je príliš vysoké (najviac ${MAX_ITEM_QUANTITY} na položku)`,
      field: 'items',
    });
  }

  // Price every line from the cycle's own snapshot products, marked up here and
  // then FROZEN on the row (same contract as order_items.price).
  const lines = [];
  for (const item of requestedItems) {
    const quantity = asQuantity(item?.quantity);
    if (quantity <= 0) continue;
    // Scoped to this cycle: a token for cycle A can never order a product from B.
    const product = db.prepare(
      'SELECT * FROM products WHERE id = ? AND cycle_id = ? AND active = 1'
    ).get(item?.product_id, cycle.id);
    if (!product) continue;
    const basePrice = basePriceForVariant(product, item?.variant);
    if (!basePrice) continue;
    lines.push({
      product_id: product.id,
      variant: item.variant,
      quantity,
      price: applyMarkup(basePrice, markupRatio),
    });
  }

  if (lines.length === 0) {
    return res.status(400).json({ error: 'Košík je prázdny' });
  }

  // Stock limits count friend orders AND other guests' sub-orders. NOTE: this
  // check sits outside the insert transaction below, which is only safe while the
  // app runs single-process (`instances: 1` in deploy/ecosystem.config.cjs) with
  // synchronous handlers — see the warning in helpers/stock.js.
  const violations = stockViolations(cycle.id, gramsByProductFromItems(lines));
  if (violations.length > 0) {
    return res.status(400).json({ error: 'Prekročený limit zásob', details: violations });
  }

  const create = db.transaction(() => {
    // Re-read the status inside the transaction: the admin may have locked the
    // cycle while this request was being validated.
    const current = db.prepare('SELECT status FROM order_cycles WHERE id = ?').get(cycle.id);
    if (current?.status !== 'open') return { conflict: true };

    const result = db.prepare(`
      INSERT INTO guest_orders (link_id, order_token, guest_name, guest_phone, guest_email, status, total)
      VALUES (?, ?, ?, ?, ?, 'submitted', 0)
    `).run(link.id, uniqueOrderToken(), guestName, guestPhone, guestEmail);
    const guestOrderId = result.lastInsertRowid;

    let total = 0;
    const insertItem = db.prepare(`
      INSERT INTO guest_order_items (guest_order_id, product_id, variant, quantity, price)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const line of lines) {
      insertItem.run(guestOrderId, line.product_id, line.variant, line.quantity, line.price);
      total += line.price * line.quantity;
    }
    total = Math.round(total * 100) / 100;
    db.prepare('UPDATE guest_orders SET total = ? WHERE id = ?').run(total, guestOrderId);

    return { guestOrderId };
  });

  const created = create();
  if (created.conflict) {
    return res.status(409).json({
      error: 'Cyklus bol práve uzavretý, objednávku už nie je možné odoslať.',
      reason: 'closed',
    });
  }

  const order = loadOrder(created.guestOrderId);
  const settings = paymentSettings();

  res.status(201).json({
    order,
    items: loadItems(order.id),
    // Decision 1: the guest pays the admin directly. `G<id>` disambiguates
    // duplicate first names when the admin matches incoming payments.
    payment: {
      amount: order.total,
      reference: `G${order.id} / ${order.guest_name} / ${cycle.name}`,
      iban: settings.iban,
      revolut_username: settings.revolut_username,
    },
    // The guest's personal status/edit page (served by GSO-T4).
    status_path: `/g/${link.token}/o/${order.order_token}`,
  });
});

export default router;
