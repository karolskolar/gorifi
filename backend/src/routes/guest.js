import { Router } from 'express';
import db, { generateGuestToken } from '../db/schema.js';
import { guestReadLimiter, guestWriteLimiter } from '../middleware/rate-limit.js';
import { gramsByProductFromItems, stockViolations, cycleAvailability } from '../helpers/stock.js';
import { basePriceForVariant, applyMarkup, VARIANT_PRICE_COLUMNS, roundMoney } from '../helpers/pricing.js';
import { guestOrderStatus, softCancelGuestOrder } from '../helpers/guest-orders.js';
import { bindValue } from '../helpers/bind-value.js';
import { guestPaymentBlock } from '../helpers/payment.js';
// 14 §UC-GR-011 — the guest order-confirmation mail. Module 08's seam, consumed
// through the seam exactly: no layer change, no new block type, no new dependency.
import { renderEmail } from '../helpers/email-templates.js';
import { sendMail, EMAIL_SHAPE } from '../helpers/mailer.js';
import { resolveLoginUrl } from '../helpers/credentials-message.js';
// 19 §UC-GL-002: the link-token generator for BOTH spaces (the get-or-create below
// mints a per-cycle row) and „the current round".
import { uniqueGuestToken, currentOpenCycle } from '../helpers/standing-link.js';
// 19 §UC-GL-004/005: the waitlist's one writer home (signup + the on-order purge).
import { joinWaitlist, purgeWaitlistOnOrder } from '../helpers/guest-waitlist.js';

const router = Router();

// Public guest ordering (§UC-GSO-001..003). The URL token IS the credential:
// no session, no password, no account — a colleague follows the host's link,
// picks products and pays the admin directly (Decision 1).
//
// Mounted BARE (no requireAdmin, no friend auth) but rate-limited, because these
// are unauthenticated write/lookup surfaces (Decision 6).
//
// ⚠ These routes use their OWN buckets — `guestReadLimiter` for page loads and
// `guestWriteLimiter` for submits/edits — deliberately NOT the shared
// `abuseLimiter` that guards the invite-code lookup and onboarding submit. This
// link is shared privately at office scale, so a whole team usually arrives
// behind ONE NAT'd IP; on the shared bucket a busy order could lock colleagues
// out of registering, and vice versa. Reads get the generous limit because a page
// load is cheap and repeats (every colleague opening the link, every refresh);
// writes stay moderate. Do not collapse these back onto one limiter.
//
// Because the body of a POST here is entirely attacker-controlled (the URL token
// is the only credential), NOTHING from it is trusted: identity strings go
// through asString(), quantities through asQuantity(), prices come from the DB
// snapshot, and status/paid/delivered/total/order_token are server-set.
//
// Status codes, deliberately distinct so the page can say the right thing:
//   404 — no such token (typo / never existed / revoked beyond recognition)
//   410 — the token is real but the door is closed: link or host deactivated
//         (~~or the cycle is not `open`~~ — SUPERSEDED by 19 §UC-GL-002: a non-open
//         cycle is now a 200 `page: 'preopen'` on the listing; see resolveEntry)
//   409 — the cycle closed between loading the page and submitting (lock race),
//         and any submit that resolves to the pre-open state
//   400 — identity validation, empty cart, stock limits

// PC-T8 (12 §UC-PC-012 image fallback): `image` COALESCEs to the catalog
// product's image when the snapshot carries none — a READ-ONLY column change on
// this hostile-boundary route; nothing about its gates, bounds or pricing
// moves. Queries using this list must alias `products` as `p` and LEFT JOIN
// `coffee_products cp ON cp.id = p.source_coffee_product_id`.
const PRODUCT_COLUMNS = [
  'id', 'cycle_id', 'name', 'description1', 'description2', 'roast_type', 'purpose',
  'price_150g', 'price_200g', 'price_250g', 'price_500g', 'price_1kg', 'price_20pc5g', 'price_8pc12g', 'price_unit',
  'image', 'roastery', 'weight_grams', 'composition', 'variant_label',
  'source_bakery_product_id', 'source_variant_id', 'stock_limit_g',
]
  .map((c) => (c === 'image' ? 'COALESCE(p.image, cp.image) AS image' : `p.${c}`))
  .join(', ');
const PRODUCT_JOIN = 'products p LEFT JOIN coffee_products cp ON cp.id = p.source_coffee_product_id';

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
// 20 §UC-GP-002 — the free-text Packeta point (Z-BOX / branch + town). The same 160 as
// `friends.packeta_address` (the profile PATCH's bound); mirrored as `maxlength` in
// GP-T3's `GuestDeliveryChoice.vue`.
const MAX_PACKETA_ADDRESS_LENGTH = 160;

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

// Decision 7's identity rule, in ONE place: non-empty name, phone with at least 9
// digits, e-mail optional — plus the bounds above, because every caller here is an
// unauthenticated write.
//
// `fields` maps the logical field to the body key, because the two surfaces that
// capture the same contact details name them differently: checkout carries
// `guest_name/guest_phone/guest_email` (the columns it writes), while the
// lead-capture CTA carries `name/phone/email` (the invitations flow it feeds).
// One rule, two vocabularies — the alternative is two copies that drift, and the
// second one is the one that stops validating.
//
// Returns `{ error, field }` (a ready 400 payload) or `{ identity: { name, phone, email } }`.
function validateIdentity(body, fields) {
  // asString() (not String()) because the body is attacker-controlled: an object
  // with a non-callable `toString` makes String()/parseInt() throw, which would
  // answer this endpoint's 400-with-field contract with a 500 and a stack trace.
  // `null` (an object where text was expected) and `''` are both falsy here, so
  // one check covers "not text" and "not filled in".
  const name = asString(body?.[fields.name]);
  if (!name) {
    return { error: 'Zadaj meno', field: fields.name };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `Meno je príliš dlhé (najviac ${MAX_NAME_LENGTH} znakov)`, field: fields.name };
  }

  const phone = asString(body?.[fields.phone]);
  if (!phone) {
    return { error: 'Zadaj telefónne číslo (aspoň 9 číslic)', field: fields.phone };
  }
  if (phone.length > MAX_PHONE_LENGTH) {
    return { error: `Telefónne číslo je príliš dlhé (najviac ${MAX_PHONE_LENGTH} znakov)`, field: fields.phone };
  }
  if (phone.replace(/\D/g, '').length < 9) {
    return { error: 'Zadaj telefónne číslo (aspoň 9 číslic)', field: fields.phone };
  }

  // A surface that accepts NO e-mail (the waitlist, 19 §UC-GL-004 rule 2) has no
  // `email` in its field map: whatever the body carries under any key is ignored.
  if (!fields.email) {
    return { identity: { name, phone, email: null } };
  }

  // E-mail is optional, so '' is fine — but `null` means "present and not text",
  // which is invalid input rather than an omitted field.
  const emailInput = asString(body?.[fields.email]);
  if (emailInput === null) {
    return { error: 'Neplatný e-mail', field: fields.email };
  }
  const email = emailInput || null;
  if (email && email.length > MAX_EMAIL_LENGTH) {
    return { error: `E-mail je príliš dlhý (najviac ${MAX_EMAIL_LENGTH} znakov)`, field: fields.email };
  }

  return { identity: { name, phone, email } };
}

const CHECKOUT_IDENTITY_FIELDS = { name: 'guest_name', phone: 'guest_phone', email: 'guest_email' };
const INVITE_IDENTITY_FIELDS = { name: 'name', phone: 'phone', email: 'email' };
// 19 §UC-GL-004 rule 2 — name + phone ONLY; an e-mail is not accepted (ignored if sent).
const WAITLIST_IDENTITY_FIELDS = { name: 'name', phone: 'phone' };

// Only the host's first name is published to strangers — the guest needs to know
// whose order they are joining, not the host's contact details.
// The two parcel flags every guest `cycle` block publishes (listing + status payload),
// in ONE place so the two blocks cannot drift. `parcel_fee` goes through
// `roundMoney()` — it is already rounded at the admin write (`cycles.js`), and the
// published figure must be the one the submit will charge.
function publishedParcelFlags(cycle) {
  return {
    parcel_enabled: cycle.parcel_enabled ? 1 : 0,
    parcel_fee: roundMoney(Number(cycle.parcel_fee) || 0),
  };
}

// 20 §UC-GP-002 — the delivery choice out of an attacker-controlled body. Returns
// `{ error, field }` (a ready 400 payload) or `{ delivery: { packeta, address } }`.
//
// ⚠ STRICT TYPE GATE on `use_parcel_delivery` (D1): absent / `null` / `false` ⇒
// „Prevezmem od {host}", boolean `true` ⇒ Packeta, ANYTHING else (`'true'`, `1`,
// `[true]`, `{}`) ⇒ 400. The friend route coerces truthily; a PUBLIC write does not.
// ⚠ Parcel availability is checked BEFORE the address (rule 1), and the address's
// `typeof === 'string'` check comes before `.trim()` (the FUP-T12 fold: a number or an
// object never reaches a string method). ⚠ The e-mail requirement is NOT here — the
// submit and the edit (GP-T2) disagree about where the e-mail comes from, so each
// caller applies its own (`validateIdentity()` is shared with the invite CTA and stays
// UNCHANGED, D9).
// ⚠ Guest-facing copy says „objednávka", never „cyklus" (resolved conflict 5 / D10).
const DELIVERY_METHOD_ERROR = 'Neplatný spôsob prevzatia';
const PARCEL_UNAVAILABLE_ERROR = 'Doručenie Packetou nie je pre túto objednávku dostupné';
const PACKETA_ADDRESS_MISSING_ERROR = 'Zadaj výdajné miesto Packety';
const PACKETA_ADDRESS_TOO_LONG_ERROR =
  `Výdajné miesto je príliš dlhé (najviac ${MAX_PACKETA_ADDRESS_LENGTH} znakov)`;
const PACKETA_EMAIL_MISSING_ERROR = 'Pri doručení Packetou zadaj e-mail';

function validateDeliveryChoice(body, cycle) {
  const flag = body?.use_parcel_delivery;
  if (flag === undefined || flag === null || flag === false) {
    return { delivery: { packeta: false, address: null } };
  }
  if (flag !== true) {
    return { error: DELIVERY_METHOD_ERROR, field: 'use_parcel_delivery' };
  }
  if (!cycle.parcel_enabled) {
    return { error: PARCEL_UNAVAILABLE_ERROR, field: 'use_parcel_delivery' };
  }
  const raw = body.packeta_address;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: PACKETA_ADDRESS_MISSING_ERROR, field: 'packeta_address' };
  }
  const address = raw.trim();
  if (address.length > MAX_PACKETA_ADDRESS_LENGTH) {
    return { error: PACKETA_ADDRESS_TOO_LONG_ERROR, field: 'packeta_address' };
  }
  return { delivery: { packeta: true, address } };
}

// GP-T7 — PO decision (1) 2026-09-24: does a STORED `guest_email` satisfy Packeta?
// Only when it passes the mailer's `EMAIL_SHAPE` (one home). A via_host checkout may
// store an UNSHAPED optional e-mail (§Accepted risks — the submit shape-checks only
// Packeta), and Packeta must never proceed on it: an unshaped stored value is treated
// as ABSENT. ~~GP-T2: „any non-null stored e-mail counts"~~ → SUPERSEDED here.
function storedEmailUsable(value) {
  return typeof value === 'string' && EMAIL_SHAPE.test(value);
}

// 20 §UC-GP-005 rule 3 — the edit's e-mail for a switch to Packeta on an order that
// has no USABLE e-mail stored (D3, PO 2026-09-19: write-once; GP-T7: „usable" =
// `storedEmailUsable()`, so NULL or unshaped). Called ONLY then: when the row already
// carries a valid e-mail, the body's value is ignored — never validated, never an
// error, never written — because identity is frozen on edit (GSO-T4) and the freeze's
// one exception is filling a hole (or replacing an address Packeta cannot use), not
// rewriting a contact. Returns `{ error, field }` or `{ email }`. Same bounds and
// messages as the submit: 160 chars (`validateIdentity`'s), `EMAIL_SHAPE` (one home).
function packetaEditEmail(raw) {
  if (raw === undefined || raw === null) {
    return { error: PACKETA_EMAIL_MISSING_ERROR, field: 'guest_email' };
  }
  if (typeof raw !== 'string') {
    return { error: 'Neplatný e-mail', field: 'guest_email' };
  }
  const email = raw.trim();
  if (!email) {
    return { error: PACKETA_EMAIL_MISSING_ERROR, field: 'guest_email' };
  }
  if (email.length > MAX_EMAIL_LENGTH) {
    return { error: `E-mail je príliš dlhý (najviac ${MAX_EMAIL_LENGTH} znakov)`, field: 'guest_email' };
  }
  if (!EMAIL_SHAPE.test(email)) {
    return { error: 'Neplatný e-mail', field: 'guest_email' };
  }
  return { email };
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

const LINK_SELECT = `
  SELECT gl.id, gl.token, gl.active, gl.cycle_id, gl.host_friend_id,
         f.name AS host_name, f.active AS host_active
  FROM guest_order_links gl
  JOIN friends f ON f.id = gl.host_friend_id
`;

function findLink(token) {
  return db.prepare(`${LINK_SELECT} WHERE gl.token = ?`).get(String(token || ''));
}

// The link a sub-order hangs off, reached from `guest_orders.link_id` — the row
// always exists (FK), whatever the link's CURRENT token is. This is what makes
// `order_token` resolvable without the link token (14 §UC-GR-001).
function findLinkById(linkId) {
  return db.prepare(`${LINK_SELECT} WHERE gl.id = ?`).get(linkId);
}

function findCycle(cycleId) {
  return db.prepare(
    'SELECT id, name, status, type, expected_date, plan_note, markup_ratio, opens_at, closes_at, stage, parcel_enabled, parcel_fee FROM order_cycles WHERE id = ?'
  ).get(cycleId);
}

// ═══════════════════════════════════════════════════════════════════════════
// resolveEntry(token, { forSubmit }) — 19 §UC-GL-002. It REPLACED GSO-T3's
// `resolveLink(token, closedStatus)`. ONE resolver over BOTH token spaces:
//
//   1. `guest_order_links.token` (a per-cycle, „legacy" link) first, then
//      `friends.guest_link_token` (the host's STANDING link). Both miss ⇒ the ONE
//      uniform 404 — same message and shape whichever table was consulted, so the
//      endpoint is no oracle about which space a string belongs to.
//   2. A STANDING hit resolves to the host's per-cycle row for „the current round"
//      (`currentOpenCycle()`), which it GETS OR CREATES — so every shipped mechanism
//      downstream (stock, pricing, sub-orders, pickup store, host/admin views,
//      distribution, aggregation, rewards, recovery) sees an ordinary row and nothing
//      else in this file needed a second code path. No open round ⇒ the pre-open page.
//   3. A LEGACY hit on a cycle that is not open ⇒ the pre-open page in its STALE
//      variant, never the newer round (D7: an old per-cycle link must not become an
//      evergreen door). It creates nothing.
//
// Returns `{ kind: 'order', link, cycle }`, `{ kind: 'preopen', hostId, host,
// staleCycle, openCycle }` (`hostId` = the friend the door belongs to — the waitlist's
// `host_friend_id`, never published; `openCycle` = the open round a stale link does NOT resolve to, or
// null — `openElsewhere` in the spec is `!!openCycle`), or a refusal
// `{ status, error, reason? }`.
//
// `forSubmit: true` (the submit route) turns a pre-open outcome into the shipped 409
// `closed` — the lock-race contract is unchanged for both spaces (rule 5).
//
// ⚠ The standing token is looked up HERE and nowhere else in this file. It is never
// SELECTed into a payload: `LINK_SELECT` must not carry it (a source pin in
// guest-standing-link.spec.js reads that template literal), and the per-cycle row's
// OWN token never reaches a standing visitor either — no payload in this file carries
// a link token, and the page keeps calling the API with the token it was opened
// with. So a standing visitor cannot learn the per-cycle URL, and rotating the
// standing token fully revokes it for new visitors (UC-GL-001 rule 3).
// ═══════════════════════════════════════════════════════════════════════════

const NOT_FOUND = Object.freeze({ status: 404, error: 'Tento odkaz na objednávku neexistuje' });
// A deactivated link OR a deactivated host both close the door. The host is the one
// who hands the goods over and who every friend order path already refuses when
// inactive (orders.js), so their link must not keep taking new sub-orders — and
// consuming stock — after they can no longer log in. Existing sub-orders survive
// either case; only new visits break. The standing token inherits BOTH gates (D4,
// UC-GL-002 rule 3): it is a resolver, not a second door around them.
const INACTIVE = Object.freeze({
  status: 410,
  error: 'Tento odkaz už nie je aktívny. Požiadaj kolegu o nový.',
  reason: 'inactive',
});
// The submit's lock race (UC-GL-002 rule 5). ⚠ The ONLY remaining caller is the
// submit: the LISTING no longer answers `closed` at all (19 resolved conflict 1 —
// a non-open cycle is the pre-open page), so this string now renders only through
// GuestOrder.vue's `checkout-error` banner.
// GL-T7 (19 §UC-GL-011, 18 §UC-PI-017's vocabulary rule): ~~„Objednávanie v tomto
// cykle je už uzavreté."~~ → the text below (PO DRAFT). Status + `reason` unchanged.
// Every message in this file is a GUEST's, so the whole file is swept by
// `portal-vocabulary.spec.js` §6 — no „cyklus"/„kolo" in any string here.
const CLOSED = Object.freeze({
  status: 409,
  error: 'Objednávky sú už uzavreté, objednávku už nie je možné odoslať.',
  reason: 'closed',
});

// The standing half of rule 1: a LOOKUP by the token, never a column in a payload.
// `id`/`name`/`active` only — the host's first name is all a stranger is shown.
function findStandingHost(token) {
  return db.prepare('SELECT id, name, active FROM friends WHERE guest_link_token = ?').get(token);
}

function findLinkForHostCycle(hostFriendId, cycleId) {
  return db.prepare(`${LINK_SELECT} WHERE gl.host_friend_id = ? AND gl.cycle_id = ?`).get(hostFriendId, cycleId);
}

// GET-OR-CREATE the host's per-cycle row for a standing visitor (rule 3). The INSERT
// is the host's own `POST /guest-links/cycle/:id` statement verbatim, so a row born
// here is indistinguishable from one the host created — the host view, the admin
// view and the pickup store (`helpers/pickup.js`) all read it as theirs.
//
// ⚠ CHECK-THEN-WRITE, safe ONLY under `instances: 1` + this handler being
// synchronous (CLAUDE.md, GA-T8): nothing can run between the SELECT and the INSERT.
// `UNIQUE(host_friend_id, cycle_id)` is the DB-side backstop — should a second
// process ever race this (cluster mode), its `SQLITE_CONSTRAINT*` falls through to
// the re-SELECT, which then finds the winner's row. A constraint error the re-SELECT
// cannot explain (a token clash `uniqueGuestToken()` is there to prevent) is
// re-thrown, never swallowed into an `undefined` link.
function getOrCreateCycleLink(hostFriendId, cycleId) {
  const existing = findLinkForHostCycle(hostFriendId, cycleId);
  if (existing) return existing;
  try {
    db.prepare(
      'INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES (?, ?, ?, 1)'
    ).run(uniqueGuestToken(), hostFriendId, cycleId);
  } catch (e) {
    if (!(typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT'))) throw e;
    const winner = findLinkForHostCycle(hostFriendId, cycleId);
    if (winner) return winner;
    throw e;
  }
  return findLinkForHostCycle(hostFriendId, cycleId);
}

function orderOrPreopen(entry, forSubmit) {
  if (entry.kind === 'preopen' && forSubmit) return CLOSED;
  return entry;
}

function resolveStanding(host, forSubmit) {
  if (!host.active) return INACTIVE;
  const open = currentOpenCycle();
  if (!open) {
    return orderOrPreopen({
      kind: 'preopen', hostId: host.id, host: { name: host.name }, staleCycle: null, openCycle: null,
    }, forSubmit);
  }
  const link = getOrCreateCycleLink(host.id, open.id);
  // D4: the round's own `active` flag still decides. A host who deactivated this
  // round's link said „no new colleague orders this round", and the standing URL
  // must not route around that. (`host_active` is re-read with the row — the same
  // gate, from the same JOIN, as a legacy hit.)
  if (!link.active || !link.host_active) return INACTIVE;
  const cycle = findCycle(link.cycle_id);
  if (!cycle) return NOT_FOUND;
  return { kind: 'order', link, cycle };
}

function resolveLegacy(link, forSubmit) {
  if (!link.active || !link.host_active) return INACTIVE;
  const cycle = findCycle(link.cycle_id);
  if (!cycle) return NOT_FOUND;
  if (cycle.status === 'open') return { kind: 'order', link, cycle };
  // D7 — the STALE variant. The legacy token creates nothing and resolves to nothing
  // newer; it only learns WHETHER a newer round is open (`open_elsewhere`), so the
  // page can say „ask the host for the current link" instead of offering a waitlist.
  return orderOrPreopen({
    kind: 'preopen',
    hostId: link.host_friend_id,
    host: { name: link.host_name },
    staleCycle: { id: cycle.id, name: cycle.name },
    openCycle: currentOpenCycle(),
  }, forSubmit);
}

function resolveEntry(token, { forSubmit = false } = {}) {
  const value = String(token || '');
  const link = findLink(value);
  if (link) return resolveLegacy(link, forSubmit);
  const host = findStandingHost(value);
  if (host) return resolveStanding(host, forSubmit);
  return NOT_FOUND;
}

// ── The pre-open payload (19 §UC-GL-003) ─────────────────────────────────────
// Everything the pre-open page renders, in one read. ⚠ Strictly LESS than the live
// listing (rule 4): no payment settings, no host contact data, no link token of
// either space, no `invite_code`, no availability, no counts of other guests.

// A read of historical data on a public route — bounded (rule 2, PO 2026-09-19).
const PREVIEW_LIMIT = 12;

// Rule 1 — the next planned round: dated ones first (earliest date), then undated,
// id breaking ties. `opens_at` is module 17's column, shipped (CS-T1) and selected
// unguarded by `findCycle()` above, so no `PRAGMA table_info` guard is needed here.
function nextPlannedCycle() {
  return db.prepare(`
    SELECT id, name, opens_at, plan_note FROM order_cycles
    WHERE status = 'planned'
    ORDER BY (opens_at IS NULL), opens_at ASC, id ASC
    LIMIT 1
  `).get();
}

// Rule 2 — „the last round": the newest locked or completed cycle. Also the cycle a
// waitlist signup is keyed to — GL-T3's POST …/waitlist (UC-GL-004 rule 3) must
// read THIS function, never a second copy of the query.
function lastClosedCycle() {
  return db.prepare(`
    SELECT id, name, markup_ratio FROM order_cycles
    WHERE status IN ('locked', 'completed')
    ORDER BY id DESC
    LIMIT 1
  `).get();
}

// GP-T7 — PO decision (3) 2026-09-24 + orchestrator decision 2026-09-25:
// `next.parcel_enabled` (ADDITIVE) is published ONLY where it is a real flag — the
// OPEN round an `open_elsewhere` names (`0|1`). Every other kind carries `null`: a
// PLANNED round's `parcel_enabled` is not a decision yet (the column DEFAULTS to 0 and
// `POST /cycles` never writes it), so the pre-open card ALWAYS shows the Packeta clause
// for planned_date / planned_note / unknown (PO: Packeta in ~all future rounds).
const parcelFlag = (value) => (value ? 1 : 0);

function preopenNext(openCycle) {
  if (openCycle) {
    const open = db.prepare('SELECT parcel_enabled FROM order_cycles WHERE id = ?').get(openCycle.id);
    return {
      kind: 'open_elsewhere', opens_at: null, plan_note: null, cycle_name: openCycle.name,
      parcel_enabled: open ? parcelFlag(open.parcel_enabled) : null,
    };
  }
  const planned = nextPlannedCycle();
  if (!planned) return { kind: 'unknown', opens_at: null, plan_note: null, cycle_name: null, parcel_enabled: null };
  const opensAt = planned.opens_at || null;
  const planNote = planned.plan_note || null;
  let kind = 'unknown';
  if (opensAt) kind = 'planned_date';
  else if (planNote) kind = 'planned_note';
  return { kind, opens_at: opensAt, plan_note: planNote, cycle_name: planned.name, parcel_enabled: null };
}

function preopenPreview() {
  const cycle = lastClosedCycle();
  if (!cycle) return null;
  const markupRatio = cycle.markup_ratio || 1.0;
  // The shipped listing query, capped. Prices through `withMarkup()` exactly as the
  // live listing (the prototype shows priced, disabled cards) — and NO availability.
  // ⚠ `stock_limit_g` is STRIPPED (review decision, GL-T2): rule 2 says „no
  // `stock_limit_g` semantics on the client", and a closed round's stock caps are
  // nothing a stranger needs — the preview carries strictly less than the listing.
  const products = db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM ${PRODUCT_JOIN} WHERE p.cycle_id = ? AND p.active = 1 ORDER BY p.purpose, p.name LIMIT ?`
  ).all(cycle.id, PREVIEW_LIMIT).map((product) => {
    const { stock_limit_g: _omitted, ...rest } = withMarkup(product, markupRatio);
    return rest;
  });
  return { cycle: { id: cycle.id, name: cycle.name }, products };
}

function preopenPayload({ host, staleCycle, openCycle }) {
  const next = preopenNext(openCycle);
  return {
    page: 'preopen',
    host: { first_name: firstName(host.name) },
    next,
    stale_cycle: staleCycle ? { id: staleCycle.id, name: staleCycle.name } : null,
    preview: preopenPreview(),
    // Rule 3: while a round is open the guest should be ordering, not waiting — and a
    // stale link must not collect contacts for a round already in progress. The
    // SERVER decides the form's presence (GL-T3's POST enforces the same condition).
    waitlist: { available: next.kind !== 'open_elsewhere' },
  };
}

// The LIVE listing — the shipped payload, byte-identical (UC-GL-002: „byte-identical
// downstream behaviour").
function orderListing({ link, cycle }) {
  const markupRatio = cycle.markup_ratio || 1.0;
  const products = db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM ${PRODUCT_JOIN} WHERE p.cycle_id = ? AND p.active = 1 ORDER BY p.purpose, p.name`
  ).all(cycle.id).map((product) => withMarkup(product, markupRatio));

  return {
    cycle: {
      id: cycle.id,
      name: cycle.name,
      status: cycle.status,
      type: cycle.type,
      expected_date: cycle.expected_date,
      plan_note: cycle.plan_note,
      // CS-T1 (17 §UC-CS-004): the three stage-model fields ride the payload the
      // guest already fetches, so their timeline needs no second request. Read-only
      // and not sensitive — no admin-only column joins them.
      opens_at: cycle.opens_at,
      closes_at: cycle.closes_at,
      stage: cycle.stage,
      // GP-T1 (20 §UC-GP-001): whether this round sends parcels and what one costs.
      // Not secrecy — both are already public on `GET /api/cycles/:id/public`. DISPLAY
      // only: the submit re-reads the cycle row server-side and never trusts a client
      // fee.
      ...publishedParcelFlags(cycle),
    },
    host: { first_name: firstName(link.host_name) },
    products,
    // Stock limits count friend orders AND other guests' sub-orders.
    availability: cycleAvailability(cycle.id),
  };
}

// `GET /:token`'s whole answer as `{ status, body }` — a pure function of the token
// and the database, so e2e/tests/guest-standing-link.spec.js can drive it in a
// throwaway boot for the DB states the shared e2e target never reaches (no open
// round at all; no planned round).
function listingResponse(token) {
  const resolved = resolveEntry(token);
  if (resolved.status) {
    return { status: resolved.status, body: { error: resolved.error, reason: resolved.reason } };
  }
  if (resolved.kind === 'preopen') return { status: 200, body: preopenPayload(resolved) };
  return { status: 200, body: orderListing(resolved) };
}

// ⚠ ONE HOME (15 §UC-PL-001/003). This file composes NO payment data of its own any
// more: the private `paymentSettings()` that used to sit here (two hand-written
// `SELECT value FROM settings` reads) and the two hand-written `payment` blocks that
// used it are all one `guestPaymentBlock(order, cycle.name)` call now — the status
// payload's, the submit 201's, and therefore the confirmation mail's. It is also why
// `guestPaymentReference()` is no longer imported here: the helper calls it.
// ⚠ A second guest payment block appearing in this file is the defect, whatever it is
// called — the two that were here drifted apart in review more than once.

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
           paid, paid_at, delivered, delivered_at, created_at, delivery_fee, packeta_address
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

// Bounds + pricing for a client-supplied `items` array, shared by the submit and
// the edit: an edit is the SAME unauthenticated write surface, so it must apply
// the same caps and the same "price from the DB snapshot" rule. Returns either
// `{ error, field }` (a ready 400 payload) or `{ lines }` — deliberately NOT a
// verdict on emptiness, because the two callers disagree about what an empty cart
// means (submit: 400, edit: cancel).
function priceRequestedItems(body, cycle, markupRatio) {
  // Cap the row count BEFORE any per-line work: the pricing loop does one SELECT
  // per line.
  const requestedItems = Array.isArray(body?.items) ? body.items : [];
  if (requestedItems.length > MAX_ITEM_LINES) {
    return {
      error: `Objednávka obsahuje priveľa položiek (najviac ${MAX_ITEM_LINES})`,
      field: 'items',
    };
  }

  // Cap the per-line quantity too. Products with a stock_limit_g are protected by
  // the stock check, but an UNLIMITED product would otherwise accept
  // `quantity: 1e9` and persist a billions-of-euro total that then feeds the
  // admin cycle views and (per GSO-T8) kilos and tier progress. Decision 6's
  // "no cap" is about sub-orders per link, not units per line.
  if (requestedItems.some((item) => asQuantity(item?.quantity) > MAX_ITEM_QUANTITY)) {
    return {
      error: `Množstvo je príliš vysoké (najviac ${MAX_ITEM_QUANTITY} na položku)`,
      field: 'items',
    };
  }

  // Price every line from the cycle's own snapshot products, marked up here and
  // then FROZEN on the row (same contract as order_items.price). An edit
  // re-freezes at edit-time prices, exactly as the friend cart PUT does.
  const lines = [];
  for (const item of requestedItems) {
    const quantity = asQuantity(item?.quantity);
    if (quantity <= 0) continue;
    // Scoped to this cycle: a token for cycle A can never order a product from B.
    //
    // ⚠ FUP-T15 — THE APP'S ONLY UNAUTHENTICATED WRITE, and `product_id` was the
    // one field on it that reached a bind unchecked (name/phone/e-mail go through
    // asString(), the quantity through asQuantity(), the variant through
    // basePriceForVariant()'s `typeof === 'string'` gate, and the price comes from
    // the DB). `{"product_id":{}}` was a 500 plus ~870 bytes of stack per request
    // from anyone holding an office-wide share link — the FUP-T3/T7 log-flood rule.
    // `bindValue` yields `undefined`, which binds as NULL, matches no product and
    // therefore DROPS the line, exactly as an unknown product id already did.
    const product = db.prepare(
      'SELECT * FROM products WHERE id = ? AND cycle_id = ? AND active = 1'
    ).get(bindValue(item?.product_id), cycle.id);
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
  return { lines };
}

// Write `lines` as THE items of an existing sub-order and return the new total.
// Replace-in-full (delete + insert), like the friend cart PUT: the request
// carries the whole cart, not a delta.
function replaceItems(guestOrderId, lines) {
  db.prepare('DELETE FROM guest_order_items WHERE guest_order_id = ?').run(guestOrderId);
  const insertItem = db.prepare(`
    INSERT INTO guest_order_items (guest_order_id, product_id, variant, quantity, price)
    VALUES (?, ?, ?, ?, ?)
  `);
  let total = 0;
  for (const line of lines) {
    insertItem.run(guestOrderId, line.product_id, line.variant, line.quantity, line.price);
    total += line.price * line.quantity;
  }
  return roundMoney(total);
}

// Resolve a sub-order from its `order_token` ALONE — WITHOUT any of the
// open/active gating `resolveEntry` applies (14 §UC-GR-001; it was `resolveLink`
// until 19 §UC-GL-002 — this function is untouched by that rewrite, rule 6).
//
// That asymmetry is the point of §UC-GSO-004: the product listing stops once the
// cycle closes or the host deactivates the link, but the guest must still be able
// to open their own status URL and see what they ordered, what it costs and the
// payment reference. Read stays open; the write half re-applies the gates.
//
// ⚠ WHY THE LINK TOKEN IS NOT PART OF THE CREDENTIAL ANY MORE (module 14, D1/D2 —
// this SUPERSEDES GSO-T4's "an orderToken only resolves under its own link
// :token"). The pair-strict form resolved `order_token AND link_id` where the
// `link_id` came from the URL's CURRENT link token, so a host regenerating their
// share link permanently 404'd every status URL their colleagues already held —
// the Martina Tomašová incident: she had paid, and her order sat in the DB
// unreachable by her, the host and the admin alike. The share link and the
// per-order URL are two credentials with DIFFERENT LIFETIMES: regeneration must
// keep revoking the former (see `resolveEntry`, formerly `resolveLink` — a retired link still
// lists nothing and takes no new sub-orders) without killing the latter.
//
// Nothing is weakened by the change: `order_token` comes from the same
// `generateGuestToken()` as the link token (14 chars of `CODE_ALPHABET`, SEC-S2),
// so it is a full standalone credential of identical entropy. The no-oracle
// property is preserved verbatim — every miss, including the degenerate
// missing-link/missing-cycle cases, answers the SAME 404 with the SAME message,
// so the endpoint never reveals that an order token exists somewhere.
function resolveGuestOrderByOrderToken(orderToken) {
  const notFound = { status: 404, error: 'Táto objednávka neexistuje' };
  const order = db.prepare(`
    SELECT id, link_id, order_token, guest_name, guest_phone, guest_email, status, total,
           paid, paid_at, delivered, delivered_at, created_at, delivery_fee, packeta_address
    FROM guest_orders WHERE order_token = ?
  `).get(String(orderToken || ''));
  if (!order) return notFound;
  const link = findLinkById(order.link_id);
  if (!link) return notFound;
  const cycle = findCycle(link.cycle_id);
  if (!cycle) return notFound;
  return { link, cycle, order };
}

// The LEGACY pair form (`/:token/orders/:orderToken`, 14 §UC-GR-002). Every URL
// already sitting in a colleague's messages or in `localStorage.gorifi_guest_orders`
// keeps working FOREVER, so the `:token` half is resolved by nothing and authorizes
// nothing — it is URL carriage. Resolution goes through the same
// `resolveGuestOrderByOrderToken` as the canonical form, and the same shared
// handlers run afterwards.
function resolveLegacyPairForm(req) {
  const resolved = resolveGuestOrderByOrderToken(req.params.orderToken);
  // ⚠ Log the stale half by `guest_orders.id` ONLY. A token in a log line is a
  // credential in logs — neither half may ever appear here.
  if (!resolved.error && String(req.params.token || '') !== String(resolved.link.token || '')) {
    console.log(`Guest status URL carried a stale link half (guest_order ${resolved.order.id})`);
  }
  return resolved;
}

// GSO-T10 (§Lead Capture): the value stored in `invitations.source` for a lead that
// came from a guest sub-order. Server-owned — the admin's invitations view keys its
// "prišiel cez hosťovskú objednávku" tag on exactly this string.
const INVITE_SOURCE_GUEST_ORDER = 'guest_order';

// The invitations pipeline keys on phone: one PENDING registration per number
// (`idx_invitations_phone_pending`, a partial unique index — so this is a DB
// constraint as well as an app check). Used both to answer a duplicate CTA with a
// clean 409 and to tell the status page not to offer a second submission.
function pendingInvitationByPhone(phone) {
  return db.prepare(
    "SELECT id FROM invitations WHERE phone = ? AND status = 'pending'"
  ).get(String(phone || ''));
}

// Everything the status page needs, and the response of both GET and PUT (so an
// edit needs no follow-up round trip — fewer calls also means less of the guest
// write budget spent per interaction).
function statusPayload(link, cycle, order) {
  const items = loadItems(order.id);
  // A cancelled sub-order is terminal, and a closed cycle or a dead link both
  // shut the write half — see the PUT below, which enforces exactly this.
  const editable = cycle.status === 'open'
    && !!link.active && !!link.host_active
    && guestOrderStatus(order) !== 'cancelled';
  // ITEM changes stop once the admin records the payment (see the PUT's paid guard):
  // what is owed may not be rewritten after the money arrived. `editable` itself is
  // deliberately NOT narrowed — the cancel path stays open, and the status page needs
  // it to keep offering that — so the client gets a second, finer flag. An affordance
  // the server would refuse must never be on screen.
  const itemsEditable = editable && !order.paid;

  const payload = {
    cycle: {
      id: cycle.id,
      name: cycle.name,
      status: cycle.status,
      type: cycle.type,
      expected_date: cycle.expected_date,
      plan_note: cycle.plan_note,
      // CS-T1 (17 §UC-CS-004): the three stage-model fields ride the payload the
      // guest already fetches, so their timeline needs no second request. Read-only
      // and not sensitive — no admin-only column joins them.
      opens_at: cycle.opens_at,
      closes_at: cycle.closes_at,
      stage: cycle.stage,
      // GP-T1 (20 §UC-GP-001): whether this round sends parcels and what one costs.
      // Not secrecy — both are already public on `GET /api/cycles/:id/public`. DISPLAY
      // only: the submit re-reads the cycle row server-side and never trusts a client
      // fee.
      ...publishedParcelFlags(cycle),
    },
    host: { first_name: firstName(link.host_name) },
    order,
    items,
    // Decision 1: the guest pays the ADMIN directly, and the "Zaplatiť" button
    // re-opens the same PaymentModal until `paid` is set (by the admin, GSO-T6).
    // ⚠ ONE COMPOSER (15 §UC-PL-003 item 1, PL-T2): this block and the submit 201's
    // are the SAME object from `helpers/payment.js` — amount, reference, variable
    // symbol and the admin's bank details. Two guest surfaces quoting different
    // payment data for one sub-order is the bug that helper exists to make
    // impossible, so nothing is composed here. Change it there.
    payment: guestPaymentBlock(order, cycle.name),
    editable,
    items_editable: itemsEditable,
    // GSO-T10 (§Lead Capture): the low-key "ask for your own account" CTA. The
    // BACKEND decides whether it is offered, exactly as it does for `editable` — an
    // affordance the server would refuse must never be on screen, and the page
    // cannot tell a locked cycle from a dead link on its own (both only make
    // `editable` false).
    //
    // `available` deliberately ignores the cycle lock AND the cancelled state: a
    // guest asks for an account precisely when the coffee has just arrived, and a
    // guest whose sub-order was called off is still a lead. A dead link or a
    // deactivated host DOES withdraw it — see the endpoint below.
    //
    // `requested` is keyed on the sub-order's OWN phone, so a guest who edits the
    // number in the CTA form still gets the endpoint's 409; this flag only stops the
    // pointless second submission on the common path (e.g. after a reload).
    invite_request: {
      available: !!link.active && !!link.host_active,
      requested: !!pendingInvitationByPhone(order.guest_phone),
    },
  };

  if (editable) {
    // The edit screen reuses the ordering grid, so it needs the same product +
    // availability data — but only while editing is actually possible. A locked
    // cycle publishes no orderable product list (its listing endpoint answers the
    // pre-open page instead, 19 §UC-GL-003 — whose read-only preview carries no
    // availability either).
    const markupRatio = cycle.markup_ratio || 1.0;
    payload.products = db.prepare(
      `SELECT ${PRODUCT_COLUMNS} FROM ${PRODUCT_JOIN} WHERE p.cycle_id = ? AND p.active = 1 ORDER BY p.purpose, p.name`
    ).all(cycle.id).map((product) => withMarkup(product, markupRatio));
    // ⚠ excludeGuestOrderId: the grams THIS sub-order already holds must not be
    // shown as taken, or the guest cannot even re-pick what they already have.
    payload.availability = cycleAvailability(cycle.id, { excludeGuestOrderId: order.id });
  }

  return payload;
}

// ---------------------------------------------------------------------------
// The CANONICAL guest order URL (14 §UC-GR-001): `order_token` alone, independent
// of the share link's current token. Public by design — the URL token IS the
// credential, exactly as on the pair form; ⚠ these routes must NEVER join
// `ADMIN_ENDPOINTS` in e2e/tests/api-security.spec.js.
//
// ⚠ REGISTERED BEFORE `GET /:token` / `POST /:token/orders` ON PURPOSE. Express
// matches in registration order, and putting these last would invite the listing
// route to swallow them. (No collision is actually possible — `generateGuestToken()`
// emits 14 chars of the uppercase `CODE_ALPHABET`, which can never equal the
// literal segment `o` — but the ordering is the guarantee, not the alphabet.)
//
// All three delegate to the SAME shared handlers the legacy pair routes use
// (defined below), over a resolved `{ link, cycle, order }`. One copy of the
// paid-freeze guard, one copy of the literal-`items: []`-only cancel rule: two
// copies is how one of them stops enforcing it.
router.get('/o/:orderToken', guestReadLimiter, (req, res) => {
  const resolved = resolveGuestOrderByOrderToken(req.params.orderToken);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  handleStatusRead(res, resolved);
});

router.put('/o/:orderToken', guestWriteLimiter, (req, res) => {
  const resolved = resolveGuestOrderByOrderToken(req.params.orderToken);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  handleStatusEdit(req, res, resolved);
});

router.post('/o/:orderToken/invite-request', guestWriteLimiter, (req, res) => {
  const resolved = resolveGuestOrderByOrderToken(req.params.orderToken);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  handleInviteRequest(req, res, resolved);
});

// GET /guest/:token — everything the public order page needs.
// No payment details here: Decision 1 gives the guest the IBAN, but only once
// they have a sub-order to pay for (see the submit response). An anonymous
// product listing must not carry it.
//
// 19 §UC-GL-002/003: 200 with the live listing (`kind: 'order'`), 200 with
// `page: 'preopen'` when nothing is orderable (a standing token with no open round,
// or a legacy token whose cycle is not open — the 410 `closed` of GSO-T3 is
// RETIRED), 404 unknown, 410 `inactive`.
//
// ⚠ `Cache-Control: no-store` on EVERY answer of this handler (rule 5, D8). The
// guest-invite-dead.spec.js incident: Chromium served a cached 410 after the
// server's answer had changed. A guest who bookmarked the standing URL and comes
// back once the round opened must get the live page, not yesterday's „zatvorené" —
// and the refusals are the answers most likely to be re-served stale.
router.get('/:token', guestReadLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { status, body } = listingResponse(req.params.token);
  res.status(status).json(body);
});

// ---------------------------------------------------------------------------
// POST /guest/:token/waitlist — „Dajte mi vedieť" (19 §UC-GL-004). ⚠ PUBLIC, the
// app's second unauthenticated write: the URL token is the only credential and the
// body is hostile. `guestWriteLimiter`, the existing guest WRITE bucket (CLAUDE.md:
// five buckets, never collapsed, no new one). Never in ADMIN_ENDPOINTS.
//
//   1. `resolveEntry()` — the ONE resolver, so 404 (uniform, the listing's own
//      message) / 410 `inactive` are exactly the listing's. A round open for this
//      host (`kind: 'order'`), or open ELSEWHERE for a stale legacy link, is 409
//      `open`: the guest should be ordering, not waiting (the server half of
//      UC-GL-003 rule 3 — the same condition as `waitlist.available`).
//   2. `validateIdentity()` with name + phone only (the shipped bounds 120 / 32 and
//      messages). Consent is `whatsapp_opt_in ? 1 : 0` — ABSENT ⇒ 0 (PO: consent is
//      never implied by omission, although the UI checkbox defaults on).
//   3. `cycle_id` = `lastClosedCycle()` — THAT function (the preview's „last round"),
//      never a second copy of the query; null when no round has closed.
//   4. Create OR re-arm (idempotent per host + E.164, else host + raw phone) —
//      helpers/guest-waitlist.js.
//   5. ⚠ `200 { success: true }` for BOTH create and duplicate — no ids, no count,
//      nothing about other rows: the response is no oracle about who signed up.
//
// No ledger row, no invitation, no mail, no notification — a contact record only.
// ⚠ Synchronous — UC-GR-011's zero-concurrency-keyword pin covers this file (GA-T8). Note that a
// STANDING token with an open round get-or-creates the per-cycle row inside
// `resolveEntry()` before the 409 — the same row a page load creates (19 §Accepted
// risks: „a public GET writes a row").
const OPEN = Object.freeze({
  status: 409,
  error: 'Objednávka je práve otvorená — môžeš si objednať rovno.',
  reason: 'open',
});

// The signup's whole answer as `{ status, body }` — a pure function of the token, the
// body and the database (the `listingResponse()` pattern), so
// e2e/tests/guest-waitlist.spec.js can drive the PRE-OPEN states the shared e2e target
// never reaches (it always has an open round, and an open round is a 409).
function waitlistResponse(token, reqBody) {
  const resolved = resolveEntry(token);
  if (resolved.status) {
    return { status: resolved.status, body: { error: resolved.error, reason: resolved.reason } };
  }
  if (resolved.kind === 'order' || resolved.openCycle) {
    return { status: OPEN.status, body: { error: OPEN.error, reason: OPEN.reason } };
  }

  const validated = validateIdentity(reqBody, WAITLIST_IDENTITY_FIELDS);
  if (validated.error) {
    return { status: 400, body: { error: validated.error, field: validated.field } };
  }
  const { name, phone } = validated.identity;

  joinWaitlist({
    hostId: resolved.hostId,
    cycleId: lastClosedCycle()?.id ?? null,
    name,
    phone,
    optIn: reqBody?.whatsapp_opt_in ? 1 : 0,
  });
  return { status: 200, body: { success: true } };
}

router.post('/:token/waitlist', guestWriteLimiter, (req, res) => {
  const { status, body } = waitlistResponse(req.params.token, req.body);
  res.status(status).json(body);
});

// ---------------------------------------------------------------------------
// THE CONFIRMATION MAIL (14 §UC-GR-011)
//
// The THIRD consumer of module 08's `renderEmail` / `sendMail` seam. The
// implementation template is `deliverMagicLink()` (magic-link.js:175) verbatim in
// STRUCTURE: one `deliver…` helper, an outer try/catch around the render, and a
// FLOATING promise whose result vocabulary is consumed in `.then` and logged
// token-free, with a `.catch` backstop.
//
// ⚠ TWO HARD RULES, stated separately because each has its own failure mode
// (§UC-GR-011 rule 2 / Decision D11):
//
//  (a) A mail failure — or an unconfigured Mailgun, which is the normal dev,
//      staging and e2e state (`skipped:'not_configured'`) — must NEVER fail the
//      201. Nothing below is ever blocked on; the mailer's own rule 3 guarantees
//      `sendMail` never throws, and a `renderEmail` throw is caught here.
//
//  (b) ⚠ THE GA-T8 HAZARD CLASS, and the reason this comment is long. The
//      submit's stock check sits OUTSIDE the insert transaction (see the note at
//      that call site), which is safe ONLY while the handler cannot yield —
//      `instances: 1` in deploy/ecosystem.config.cjs plus fully synchronous
//      handlers. So: THIS WHOLE FILE MUST CONTAIN ZERO OCCURRENCES OF THE TWO ES
//      CONCURRENCY KEYWORDS.
//      ⚠ THAT IS A GATED RULE, NOT A COMMENT: the UC-GR-011 describe in
//      e2e/tests/guest-order-recovery.spec.js reads this file off disk and
//      asserts zero word-boundary matches. It is the ONLY check that covers the
//      case the rule exists for — a yield inserted between the stock check and
//      the insert transaction, which reopens overselling on the app's only
//      unauthenticated write and which NO behavioural test in this repo can see.
//      A blocking send would both fail the 201 on mail trouble and reopen the
//      check-then-write race. The send fires strictly AFTER the insert
//      transaction has committed AND after the response has gone out.

const ORDER_CONFIRMATION_SUBJECT = 'Potvrdenie objednávky - Podpultovka';

// ⚠ DRAFT copy, PO sign-off pending (14 §OPEN). Mirrored as constants at the top of
// the UC-GR-011 describe in e2e/tests/guest-order-recovery.spec.js, so sign-off is a
// known TWO-PLACE edit rather than a grep for quoted Slovak across the suite.
// TY-form since PO 2026-09-29 (the whole guest surface), no participle addressing the reader. The save-the-link line is the
// confirmation screen's own signed copy (plain hyphen), recast declaratively — one
// voice for one fact across mail and screen.
const MAIL_INTRO = 'Ahoj, tvoja objednávka bola prijatá.';
const MAIL_ORDER_HEADING = 'Objednávka:';
const MAIL_TOTAL_LABEL = 'Spolu';
const MAIL_PAYMENT_HEADING = 'Platba:';
const MAIL_REFERENCE_LABEL = 'Referencia';
// 15 §UC-PL-003 item 2. Slovak banking's own name for the field — the payer types it
// into the transfer form, which is why it is plain TEXT here and never a payment link
// (see the IBAN/Revolut note at the rows below).
const MAIL_VARIABLE_SYMBOL_LABEL = 'Variabilný symbol';
const MAIL_IBAN_LABEL = 'IBAN';
const MAIL_REVOLUT_LABEL = 'Revolut';
const MAIL_AMOUNT_LABEL = 'Suma';
// 20 §UC-GP-004 (GP-T1) — ADDITIVE; the existing constants and their spec mirrors are
// untouched. The fee is its own row, never an item line; the point follows `Spolu`.
const MAIL_DELIVERY_LABEL = 'Doručenie Packetou';
const MAIL_PACKETA_LABEL = 'Výdajné miesto';
const MAIL_SAVE_LINK = 'Stav objednávky uvidíš na tomto odkaze - ulož si ho:';

function eur(value) {
  return Number(value || 0).toFixed(2);
}

// The human size of one ordered line, mirroring the frontend's `variantText`
// (lib/guest-cart.js): a bakery line carries its own snapshot `variant_label`, a
// coffee line is named by its variant. Presentation only — nothing prices or weighs
// by this string.
function variantLabelFor(item) {
  if (item.variant_label) return item.variant_label;
  if (item.variant === 'unit') return 'ks';
  if (item.variant === '20pc5g') return '20 ks × 5g';
  if (item.variant === '8pc12g') return '8 ks × 12g';
  return item.variant;
}

function deliverOrderConfirmation(req, { order, items, payment }) {
  try {
    // ⚠ Server-derived origin (rule 4), the magic-link precedent: guest routes have
    // no session and this mail goes to a third party, so an attacker-chosen Origin
    // must never mint its domain and the URL is never taken from the request body.
    // 08 §UC-EM-004's `PUBLIC_BASE_URL` pin therefore covers it automatically.
    // ⚠ The CANONICAL form ONLY — the pair form is never newly emitted (UC-GR-003).
    const url = `${resolveLoginUrl(req)}/g/o/${order.order_token}`;

    // One ordered line, split so that `qty` + ' ' + `rest` is the plain-text line AND
    // the html kv row states the same thing in the same words. The quantity is the kv
    // LABEL because that cell is uppercase + nowrap and must stay short — product
    // names are unbounded admin text. `€` on item lines, `EUR` on totals, exactly as
    // on the friend/guest screens (the CartLineList rule).
    const itemLines = items.map((item) => ({
      qty: `${item.quantity}×`,
      rest: `${item.product_name} (${variantLabelFor(item)}) - ${eur(item.price * item.quantity)} €`,
    }));

    // ⚠ `payment` is the 201's block, i.e. `guestPaymentBlock()`'s output — one
    // formatter for the reference AND the variable symbol, so the guest's mail, the
    // guest's screen and the admin's unpaid overview can never disagree about what to
    // look for on the bank statement (the GSO-T6 rule, 15 §UC-PL-003). Never rebuilt
    // here.
    const paymentRows = [{ label: MAIL_REFERENCE_LABEL, value: payment.reference }];
    // ⚠ Directly AFTER the reference, and only when the helper produced one: an empty
    // VS is a degraded payment (`helpers/payment.js` fails closed), and a row reading
    // "Variabilný symbol: " would be worse than no row at all.
    if (payment.variable_symbol) {
      paymentRows.push({ label: MAIL_VARIABLE_SYMBOL_LABEL, value: payment.variable_symbol });
    }
    // IBAN and/or Revolut, as configured. ⚠ The Revolut USERNAME, never a
    // revolut.me URL — and, since module 15, never a payme.sk one either: a second
    // host in the html would break 08 §UC-EM-005 item 3's no-remote/one-origin pin,
    // and the mail is not a payment button. The links live on the payment MODAL
    // (15 §UC-PL-005/006); this mail carries the symbol as text and nothing more.
    if (payment.iban) paymentRows.push({ label: MAIL_IBAN_LABEL, value: payment.iban });
    if (payment.revolut_username) paymentRows.push({ label: MAIL_REVOLUT_LABEL, value: payment.revolut_username });
    // ⚠ The amount to pay is `payment.amount` (= total + delivery_fee, the ONE
    // composer). For a via_host order that equals `order.total`, so the shipped mail
    // is byte-identical; a Packeta order's `Spolu`/`Suma` include the fee.
    paymentRows.push({ label: MAIL_AMOUNT_LABEL, value: `${eur(payment.amount)} EUR` });

    // 20 §UC-GP-004: the fee row after the item lines and before `Spolu` (only when a
    // fee was charged), and the Packeta point after `Spolu` (whenever it IS Packeta —
    // `packeta_address` is the marker, a fee of 0 is legal). `€` on the fee line (a
    // line), `EUR` on the totals.
    const orderRows = [
      ...itemLines.map((line) => ({ label: line.qty, value: line.rest })),
      ...(order.delivery_fee > 0
        ? [{ label: MAIL_DELIVERY_LABEL, value: `${eur(order.delivery_fee)} €` }]
        : []),
      { label: MAIL_TOTAL_LABEL, value: `${eur(payment.amount)} EUR` },
      ...(order.packeta_address
        ? [{ label: MAIL_PACKETA_LABEL, value: order.packeta_address }]
        : []),
    ];

    // The plain part carries ALL of the same content including the bare URL — the
    // deliverability baseline (the mailer drops `html` without `text`).
    const text = [
      MAIL_INTRO,
      '',
      MAIL_ORDER_HEADING,
      ...itemLines.map((line) => `${line.qty} ${line.rest}`),
      ...orderRows.slice(itemLines.length).map((row) => `${row.label}: ${row.value}`),
      '',
      MAIL_PAYMENT_HEADING,
      ...paymentRows.map((row) => `${row.label}: ${row.value}`),
      '',
      MAIL_SAVE_LINK,
      url,
    ].join('\n');

    // ⚠ The guest's NAME is deliberately unused in both parts (the magic-link
    // precedent: one fewer escaping surface, and the mail then works for every
    // register) — `renderEmail` escapes every interpolated value anyway.
    const { html } = renderEmail({
      text,
      blocks: [
        { type: 'paragraph', text: MAIL_INTRO },
        { type: 'paragraph', text: MAIL_ORDER_HEADING },
        {
          type: 'kv',
          rows: orderRows,
        },
        { type: 'paragraph', text: MAIL_PAYMENT_HEADING },
        { type: 'kv', rows: paymentRows },
        // The note introduces the button + the plain URL line the renderer prints
        // under it, which is why it sits above rather than below.
        { type: 'small', text: MAIL_SAVE_LINK },
        // URL-as-label default kept: an invented button label would be new unsigned
        // Slovak copy (the 08 §UC-EM-003 OPEN).
        { type: 'button', url },
      ],
    });

    // ⚠ A FLOATING promise (rule 2 / D11) — see (a) and (b) above. The result
    // vocabulary (sent / skipped:'no_recipient'|'not_configured' / error:*) is
    // CONSUMED HERE and never surfaced: the 201 has already gone out.
    // `not_configured` is the normal local-dev and e2e state; `invalid_recipient` is
    // what the mailer's own loose `EMAIL_SHAPE` gate answers for a typo'd checkout
    // address, without a network call — this route adds no shape check of its own.
    sendMail({ to: order.guest_email, subject: ORDER_CONFIRMATION_SUBJECT, text, html })
      .then((result) => {
        if (!result || result.sent) return;
        // ⚠ DELIBERATE DIVERGENCE FROM `deliverMagicLink`, and the reason is
        // FREQUENCY. `not_configured` is not a failure: it is the documented state
        // of dev, staging, the e2e gate, and production itself until the operator
        // enables mail (14 §Deploy continuity). The magic-link precedent logs it at
        // error level because a recovery request is rare; a guest submit is two
        // orders of magnitude more common, so the same line would fill the log with
        // errors describing a known-normal configuration. Level, not silence — a
        // real transport failure (`error:*`) stays an error.
        const line =
          `[guest-order] confirmation mail not sent for G${order.id}: ${result.error || result.skipped || 'unknown'}`;
        // Terse and token-free: the order token, the URL and the address never
        // reach the log. `G<id>` is the same identifier every admin screen shows.
        if (result.skipped === 'not_configured') console.log(line);
        else console.error(line);
      })
      .catch((e) => {
        // Unreachable per the mailer's rule 3; kept so a future regression there
        // cannot become an unhandled rejection.
        console.error(`[guest-order] confirmation mail send threw for G${order.id}: ${e?.message || 'unknown error'}`);
      });
  } catch (e) {
    // A `renderEmail` throw (08 §UC-EM-002's one acceptable failure mode) degrades to
    // "no mail", logged as a message only.
    console.error(`[guest-order] could not build the confirmation mail for G${order.id}: ${e?.message || 'unknown error'}`);
  }
}

// POST /guest/:token/orders — submit a guest sub-order.
router.post('/:token/orders', guestWriteLimiter, (req, res) => {
  // A submit into a closed cycle is the lock race → 409 (not 410) — for BOTH token
  // spaces (19 §UC-GL-002 rule 5): `forSubmit` turns the pre-open state into 409
  // `closed`. A standing token with an open round lands here on the host's per-cycle
  // row (got or created), so the sub-order hangs off an ordinary link.
  const resolved = resolveEntry(req.params.token, { forSubmit: true });
  if (resolved.status) {
    return res.status(resolved.status).json({ error: resolved.error, reason: resolved.reason });
  }
  const { link, cycle } = resolved;
  const markupRatio = cycle.markup_ratio || 1.0;

  // Identity (Decision 7): name + mobile required, email optional, no SMS
  // verification. Every guest is thereby a contactable lead — which is what
  // GSO-T10's CTA promotes to an invitation, through the same validateIdentity().
  const validated = validateIdentity(req.body, CHECKOUT_IDENTITY_FIELDS);
  if (validated.error) {
    return res.status(400).json({ error: validated.error, field: validated.field });
  }
  const { name: guestName, phone: guestPhone, email: guestEmail } = validated.identity;

  // 20 §UC-GP-002 — the delivery block, AFTER identity and BEFORE pricing (rule 1).
  // A standing-token submit reaches here through the same `resolveEntry` and the same
  // `cycle` row, so it gets the identical contract.
  const chosen = validateDeliveryChoice(req.body, cycle);
  if (chosen.error) {
    return res.status(400).json({ error: chosen.error, field: chosen.field });
  }
  const { delivery } = chosen;
  // R4.3 — Packeta ⇒ an e-mail is REQUIRED (Packeta mails the guest about the parcel).
  // A SEPARATE check after the shared `validateIdentity()`, which stays unchanged
  // (D9: it is also the invite CTA's validator). The shape is the mailer's own
  // `EMAIL_SHAPE` — one home — so an address accepted here is one the confirmation
  // mail will actually try. A via_host submit keeps today's optional, unshaped e-mail
  // (§Accepted risks).
  if (delivery.packeta) {
    if (!guestEmail) {
      return res.status(400).json({ error: PACKETA_EMAIL_MISSING_ERROR, field: 'guest_email' });
    }
    if (!EMAIL_SHAPE.test(guestEmail)) {
      return res.status(400).json({ error: 'Neplatný e-mail', field: 'guest_email' });
    }
  }

  // Bounds + snapshot pricing, shared with the edit (PUT) below.
  const priced = priceRequestedItems(req.body, cycle, markupRatio);
  if (priced.error) {
    return res.status(400).json({ error: priced.error, field: priced.field });
  }
  const { lines } = priced;

  // On the SUBMIT an empty cart is a 400 — a phantom sub-order with no items is
  // worse than no sub-order. (On an edit the same input means "cancel"; see PUT.)
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
    //
    // ⚠ `parcel_fee` is re-read HERE, with the status (20 §UC-GP-002 rule 2): the fee
    // charged is the row's value at the moment of the write, never the one the
    // resolver read earlier and never a client figure. `roundMoney` (pricing.js, one
    // home) — an unrounded fee would seed the QR drift the friend route warns about.
    const current = db.prepare('SELECT status, parcel_fee FROM order_cycles WHERE id = ?').get(cycle.id);
    if (current?.status !== 'open') return { conflict: true };

    // Literal columns (never a spread body). Packeta: the fee + the trimmed point;
    // otherwise 0 / NULL. `total` is written exactly as before — product-only.
    const deliveryFee = delivery.packeta ? roundMoney(Number(current.parcel_fee) || 0) : 0;
    const result = db.prepare(`
      INSERT INTO guest_orders (link_id, order_token, guest_name, guest_phone, guest_email, status, total,
                                delivery_fee, packeta_address)
      VALUES (?, ?, ?, ?, ?, 'submitted', 0, ?, ?)
    `).run(link.id, uniqueOrderToken(), guestName, guestPhone, guestEmail, deliveryFee, delivery.address);
    const guestOrderId = result.lastInsertRowid;

    const total = replaceItems(guestOrderId, lines);
    db.prepare('UPDATE guest_orders SET total = ? WHERE id = ?').run(total, guestOrderId);

    // 19 §UC-GL-005 rule 1 — the guest is now a customer of this round, so their
    // waitlist rows go: ACROSS ALL HOSTS by E.164 (D5), else this host's row by the
    // exact raw phone. ⚠ INSIDE this transaction, after the sub-order rows — one
    // extra statement, so a rolled-back submit purges nothing.
    purgeWaitlistOnOrder(guestPhone, link.host_friend_id);

    return { guestOrderId };
  });

  const created = create();
  if (created.conflict) {
    return res.status(409).json({
      error: 'Objednávky boli práve uzavreté, objednávku už nie je možné odoslať.',
      reason: 'closed',
    });
  }

  const order = loadOrder(created.guestOrderId);
  const items = loadItems(order.id);
  // Decision 1: the guest pays the admin directly. `G<id>` disambiguates
  // duplicate first names when the admin matches incoming payments, and the variable
  // symbol (`9` + the padded id) is what the admin's bank statement shows.
  // ⚠ ONE COMPOSER with the `statusPayload` block above (15 §UC-PL-003 item 1) —
  // the confirmation screen, the status page and the mail below all quote THIS object.
  const payment = guestPaymentBlock(order, cycle.name);

  res.status(201).json({
    order,
    items,
    payment,
    // The guest's personal status/edit page, in the CANONICAL form (14 §UC-GR-003).
    // ⚠ The link token is deliberately NOT in here: binding the status URL to a share
    // token is exactly what stranded the incident's guest when her host regenerated.
    // `GuestOrder.vue` consumes this path verbatim (copy row, localStorage
    // `status_url`, the "Zobraziť stav objednávky" push), so the whole confirmation
    // screen follows this line and composes no URL of its own.
    status_path: `/g/o/${order.order_token}`,
  });

  // 14 §UC-GR-011 — the confirmation mail. ⚠ FIRED HERE AND ONLY HERE: after the
  // insert transaction has committed (the order row exists) and after the response
  // has gone out, so nothing about the 201 can depend on it (rule 2 / D11).
  //
  // ⚠ SEND-ON-CREATE ONLY (Decision D10). The edit and the `items: []` cancel below
  // deliberately have NO counterpart — edit/cancel notification mails are a NAMED
  // follow-up in 14 §Accepted risks, never to be "completed" by adding one here.
  //
  // Gated on the address being present: the field is optional at checkout, and an
  // omitted optional field is not a failure — no build, no log. Everything past
  // this point is the mailer's own plausibility gate (§UC-GR-011 rule 3); nothing
  // here validates the address, and the stored value is never mutated.
  if (order.guest_email) {
    deliverOrderConfirmation(req, { order, items, payment });
  }
});

// ---------------------------------------------------------------------------
// The three SHARED handlers (14 §UC-GR-001). Each takes an already-resolved
// `{ link, cycle, order }` and is reached by BOTH URL forms — the canonical
// `/o/:orderToken` above and the legacy `/:token/orders/:orderToken` pair below.
// Nothing in them reads a link token, so the two forms cannot drift.

// The guest's personal status page (§UC-GSO-004). Items, total, the paid/delivered
// flags, the cycle status and the payment info needed to re-open the payment modal.
//
// Deliberately NOT gated on the cycle being open or the link being active: this
// is the guest's only record of what they ordered and what they owe. See
// resolveGuestOrderByOrderToken for why that differs from the product listing.
function handleStatusRead(res, { link, cycle, order }) {
  res.json(statusPayload(link, cycle, order));
}

// Edit the sub-order's items while the
// cycle is open (§UC-GSO-004). Replace-in-full: the body carries the whole cart.
//
// Items only. Identity (name/phone/email) is FROZEN at submit time — it is the
// contact lead Decision 7 captures and GSO-T10 promotes to an invitation, and this
// endpoint is unauthenticated, so anyone holding the URL could otherwise rewrite
// somebody else's name and phone number. `paid` (admin, GSO-T6), `delivered`
// (host, GSO-T5), `status`, `total` and `order_token` are all server-owned too.
// ⚠ Module 20 (GP-T2) adds the DELIVERY block (`use_parcel_delivery` +
// `packeta_address`, §UC-GP-005) and the freeze's ONE exception: a switch to Packeta
// on an order with NO usable e-mail stores the body's `guest_email` (D3, write-once;
// GP-T7: NULL or an UNSHAPED stored value counts as none, and is replaced — the write
// is a compare-and-swap `WHERE guest_email IS ?` on the value read). A body e-mail
// beside a stored VALID one is ignored (200).
//
// Status codes:
//   404 — the order token does not resolve (applied by the callers, before this)
//   410 — the link or the host is deactivated: same closed door the submit sees
//   409 — the cycle is not open (edits end at the lock), or the sub-order is
//         already cancelled
//   409 `paid` — a non-empty edit of a paid sub-order (its delivery method with it)
//   400 — bounds or stock limits; the delivery block (method type, parcels off,
//         point, the Packeta e-mail)
function handleStatusEdit(req, res, { link, cycle, order }) {
  // A dead link or a deactivated host closes writes exactly as it closes the
  // submit — the host is the person who hands the goods over. Reading stays open.
  if (!link.active || !link.host_active) {
    return res.status(410).json({
      error: 'Tento odkaz už nie je aktívny, objednávku už nie je možné upraviť.',
      reason: 'inactive',
    });
  }
  // Decision 6 / §Edge Cases: locked cycle ⇒ read-only status page. 409 rather
  // than 410 because the sub-order itself is very much still there (the GET above
  // renders it) — it is the request that conflicts with the cycle's state.
  if (cycle.status !== 'open') {
    return res.status(409).json({
      error: 'Objednávky sú už uzavreté, zmenu už nie je možné uložiť.',
      reason: 'closed',
    });
  }
  // `cancelled` is TERMINAL: the lifecycle diagram has submitted → cancelled →
  // [*] and no edge back, so an edit must not resurrect it. 409 (a conflict with
  // the resource's current state) rather than 410 — the sub-order is still
  // readable, it just cannot change any more. GSO-T5's host-delete produces the
  // same state, so this is also what protects a sub-order the host removed.
  if (guestOrderStatus(order) === 'cancelled') {
    return res.status(409).json({
      error: 'Táto objednávka bola zrušená a už ju nie je možné upraviť.',
      reason: 'cancelled',
    });
  }

  // ⚠ Cancelling is IRREVERSIBLE (`cancelled` is terminal above), so only an
  // EXPRESSED intent to empty the cart may trigger it — never a malformed request.
  //
  // A missing `items`, a non-array `items`, or no body at all used to fall through
  // `priceRequestedItems` as "zero lines" and destroy the sub-order with a 200. On
  // the app's only unauthenticated write, a client bug, a proxy that strips the
  // body or a wrong content-type would have been enough. The sibling POST answers
  // exactly these inputs with a non-destructive 400, and the spec's rule is
  // "*empty cart* ⇒ cancelled", not "malformed body ⇒ destroy".
  //
  // So: `items` must be an array, and only a literal `items: []` cancels.
  if (!Array.isArray(req.body?.items)) {
    return res.status(400).json({
      error: 'Chýba zoznam položiek objednávky. Ak chceš objednávku zrušiť, pošli prázdny zoznam.',
      field: 'items',
    });
  }
  const requestedCount = req.body.items.length;

  // ⚠ A PAID sub-order is FROZEN against item changes (GSO-T6). `paid` records that
  // an amount arrived, and there is nowhere to record a DIFFERENT amount — so an
  // edit after the admin matched the payment would leave the guest owing (or being
  // owed) a difference that appears on NO surface: the sub-order is already excluded
  // from `unpaid_count` and from the unpaid overview, and the admin's nested row
  // would simply read the new total next to a paid tick. Same money-visibility class
  // as the guard on the host's DELETE, and it also keeps the refund amount honest —
  // a refund is recomputed from the item rows, so a post-payment edit would silently
  // rewrite how much is owed back.
  //
  // Deliberately NARROW: only a NON-EMPTY edit is refused. The literal `items: []`
  // CANCEL stays open — it is the guest's own money, this surface has no account to
  // escalate from, and a cancellation does leave a trace (the refund queue), which is
  // exactly what the host's DELETE case lacked. So: the whole thing may be called
  // off, but what is owed may not be quietly changed.
  //
  // State-based, not terminal: the admin clearing `paid` (a mis-matched payment)
  // unfreezes the order. Re-checked inside the write transaction below, because the
  // admin may mark it paid mid-request.
  if (order.paid && requestedCount > 0) {
    return res.status(409).json({
      error: 'Objednávka je už zaplatená, jej obsah už nie je možné zmeniť. Zmenu vyrieš so správcom.',
      reason: 'paid',
    });
  }

  // 20 §UC-GP-005 — the DELIVERY BLOCK (R4.5, the friend rules), additive.
  //
  // ⚠ Only alongside a NON-EMPTY `items` (rule 1): a literal `items: []` is a cancel,
  // and a cancel body's delivery keys are IGNORED — never validated, never written (the
  // destructive action is the whole request's meaning). And only AFTER the paid gate
  // above (rule 2 / D2): the delivery method is frozen with the items, so a paid row
  // answers 409 `paid` whatever the delivery keys say.
  //
  // `use_parcel_delivery` absent or `null` ⇒ `delivery` stays null ⇒ BOTH columns
  // untouched (resolved conflict 4 — the shipped items-only PUT is byte-identical).
  // `false` / `true` / anything else go through the submit's validator (one home):
  // `false` ⇒ fee 0 + point NULL, `true` ⇒ parcels on + a valid point, else 400.
  // Before pricing, as on the submit.
  let delivery = null;
  let emailToStore = null;
  let emailToReplace = null;
  if (requestedCount > 0 && req.body.use_parcel_delivery !== undefined && req.body.use_parcel_delivery !== null) {
    const chosen = validateDeliveryChoice(req.body, cycle);
    if (chosen.error) {
      return res.status(400).json({ error: chosen.error, field: chosen.field });
    }
    delivery = chosen.delivery;
    // R4.3 — Packeta needs an e-mail. A stored SHAPED one satisfies it (whatever the
    // body says); otherwise — NULL or unshaped (GP-T7) — the body's is REQUIRED and
    // stored (D3, see the helper). `emailToReplace` is the exact value read, the
    // compare-and-swap operand of the write below.
    if (delivery.packeta && !storedEmailUsable(order.guest_email)) {
      const mail = packetaEditEmail(req.body.guest_email);
      if (mail.error) {
        return res.status(400).json({ error: mail.error, field: mail.field });
      }
      emailToStore = mail.email;
      emailToReplace = order.guest_email ?? null;
    }
  }

  const markupRatio = cycle.markup_ratio || 1.0;
  const priced = priceRequestedItems(req.body, cycle, markupRatio);
  if (priced.error) {
    return res.status(400).json({ error: priced.error, field: priced.field });
  }
  const { lines } = priced;

  // Lines were sent but none of them could be priced (a product went inactive, or
  // every variant/quantity was unusable). "I sent you lines and you deleted my
  // order" is never what the caller meant — refuse instead, non-destructively.
  if (lines.length === 0 && requestedCount > 0) {
    return res.status(400).json({
      error: 'Žiadnu z položiek sa nepodarilo spracovať. Obnov stránku a skús to znova.',
      field: 'items',
    });
  }

  const cancelling = lines.length === 0; // ⇒ requestedCount === 0: an explicit empty cart

  // Stock limits count friend orders AND other guests' sub-orders — but NOT the
  // sub-order being edited, or it would block itself (a re-save of an unchanged
  // cart that already sits at the limit would be refused). Cancelling needs no
  // check at all: it only ever releases grams.
  //
  // NOTE: like every other caller, this check sits outside the write transaction
  // below — safe only while the app is single-process, see helpers/stock.js.
  if (!cancelling) {
    const violations = stockViolations(cycle.id, gramsByProductFromItems(lines), {
      excludeGuestOrderId: order.id,
    });
    if (violations.length > 0) {
      return res.status(400).json({ error: 'Prekročený limit zásob', details: violations });
    }
  }

  const apply = db.transaction(() => {
    // Re-read inside the transaction: the admin may have locked the cycle, or the
    // host may have deleted the sub-order (GSO-T5), while this request was being
    // validated.
    //
    // ⚠ `parcel_fee` is re-read HERE, with the status (20 §UC-GP-005 rule 3, the
    // submit's rule 2 mirrored): every PUT carrying `true` charges the row's fee AT THE
    // WRITE — a fee the admin changed after submit is picked up by the next such save
    // (rule 6), never by one that omits the delivery keys.
    const current = db.prepare('SELECT status, parcel_fee FROM order_cycles WHERE id = ?').get(cycle.id);
    if (current?.status !== 'open') return { conflict: 'closed' };
    const currentOrder = db.prepare('SELECT status, paid FROM guest_orders WHERE id = ?').get(order.id);
    if (!currentOrder) return { conflict: 'gone' };
    if (guestOrderStatus(currentOrder) === 'cancelled') return { conflict: 'cancelled' };
    // The admin may have matched an incoming payment while this request was being
    // validated — the same re-read GSO-T5's DELETE does for exactly the same reason.
    // Only a non-empty edit is affected; a cancellation stays allowed.
    if (!cancelling && currentOrder.paid) return { conflict: 'paid' };

    // An empty cart cancels (task row + lifecycle diagram): status flips and the
    // total goes to 0, but the ITEM ROWS ARE KEPT.
    //
    // The status predicate is the mechanism, not row deletion. `helpers/stock.js`
    // already releases the grams via `COALESCE(status,'submitted') <> 'cancelled'`,
    // and GSO-T7/T8/T9 have to filter on that status anyway — a cancelled
    // sub-order must not appear as a distribution party, in the unpaid overview or
    // as a rewards contributor, and no amount of row deletion achieves that.
    // Deleting would therefore buy nothing beyond belt-and-braces, at the price of
    // permanently destroying the host's and the admin's record of what was ordered
    // and then called off — on an endpoint nobody has to authenticate to.
    //
    // ⚠ ONE shared write with the host's DELETE and the admin's cancel
    // (`softCancelGuestOrder`, helpers/guest-orders.js). This door's hand-written
    // copy had already drifted — it omitted the `<> 'cancelled'` guard the other two
    // carry. That is a NO-OP here, because the terminal-cancelled 409 above returns
    // before this line can ever run on a cancelled row (pinned by
    // guest-status.spec.js's "cancelled is TERMINAL — a PUT cannot revive it"), so
    // adopting the shared statement changes no behaviour on this route — it removes
    // the divergence rather than fixing a live bug.
    if (cancelling) {
      softCancelGuestOrder(order.id);
    } else {
      const total = replaceItems(order.id, lines);
      if (delivery) {
        // Literal columns in ONE statement with the items write (rule 4) — never a
        // spread body. `total` stays product-only; the fee is its own column.
        // `delivery_fee_paid` is NOT written here (its two writers are the soft cancel
        // and the admin paid toggle, learnings 12 §6) — and a paid row never gets this
        // far anyway (the paid gates above).
        const deliveryFee = delivery.packeta ? roundMoney(Number(current.parcel_fee) || 0) : 0;
        db.prepare(
          "UPDATE guest_orders SET total = ?, status = 'submitted', delivery_fee = ?, packeta_address = ? WHERE id = ?"
        ).run(total, deliveryFee, delivery.address, order.id);
        // D3 write-once, GP-T7 widened: the PREDICATE is the guard. ~~`AND guest_email
        // IS NULL`~~ → `AND guest_email IS ?` bound to the value the handler READ and
        // judged unusable (NULL, or that one unshaped string — `IS` matches NULL too):
        // a compare-and-swap, so this statement can only replace the exact value that
        // was checked, never an e-mail it did not see.
        if (emailToStore) {
          db.prepare('UPDATE guest_orders SET guest_email = ? WHERE id = ? AND guest_email IS ?')
            .run(emailToStore, order.id, emailToReplace);
        }
      } else {
        db.prepare("UPDATE guest_orders SET total = ?, status = 'submitted' WHERE id = ?").run(total, order.id);
      }
    }
    return {};
  });

  const applied = apply();
  if (applied.conflict === 'gone') {
    return res.status(404).json({ error: 'Táto objednávka neexistuje' });
  }
  if (applied.conflict === 'closed') {
    return res.status(409).json({
      error: 'Objednávky boli práve uzavreté, zmenu už nie je možné uložiť.',
      reason: 'closed',
    });
  }
  if (applied.conflict === 'cancelled') {
    return res.status(409).json({
      error: 'Táto objednávka bola zrušená a už ju nie je možné upraviť.',
      reason: 'cancelled',
    });
  }
  if (applied.conflict === 'paid') {
    return res.status(409).json({
      error: 'Objednávka bola práve označená ako zaplatená, jej obsah už nie je možné zmeniť. Zmenu vyrieš so správcom.',
      reason: 'paid',
    });
  }

  res.json(statusPayload(link, cycle, loadOrder(order.id)));
}

// "Chcete si nabudúce
// objednať sami?" (§UC-GSO-015, §Lead Capture). Creates a row in the EXISTING
// `invitations` table so the lead lands in the queue the admin already works,
// attributed to the host and tagged with its source.
//
// WHY A DEDICATED ENDPOINT rather than reusing the public POST
// /invitations/register: that route resolves the inviter from the host's
// `friends.invite_code`, so reusing it would mean publishing the host's referral
// code into a page any stranger holding the link can read (`friends.js` strips
// `invite_code` from every friend response for exactly that reason). The guest
// already holds a credential that identifies the host server-side — the link token —
// so the code never has to leave the server. Everything else here IS the register
// route's logic: same table, same pending-phone rule, same 409.
//
// WHY THE ORDER TOKEN and not just the link token: the link token is shared with a
// whole office, the ORDER token is the individual guest's. Requiring it means only
// somebody who actually placed a sub-order can create a lead, and it lets the
// contact details be prefilled from that sub-order. (Module 14 dropped the link
// half from the credential; the order half — the one that carries this property —
// is unchanged.)
//
// GATING — deliberately the READ half's asymmetry
// (resolveGuestOrderByOrderToken, 404-only), not the write half's:
//   404 — the order token does not resolve (applied by the callers, before this)
//   410 — the link or the host is deactivated: the invitation would be credited to
//         a host who can no longer log in, and every other write on this surface
//         treats that as a closed door
//   409 — this phone already has a PENDING invitation
//   400 — identity validation / bounds
// A LOCKED cycle and a CANCELLED sub-order both still succeed: those are the moments
// a guest is most likely to want an account, and neither makes the lead less real.
//
// Nothing but name/phone/email is read from the body. `status`, `source`,
// `invited_by_friend_id`, `invite_code`, `admin_note` and `processed_at` are all
// server-owned — this is an unauthenticated write into an admin-facing queue.
function handleInviteRequest(req, res, { link }) {
  if (!link.active || !link.host_active) {
    return res.status(410).json({
      error: 'Tento odkaz už nie je aktívny. Požiadaj kolegu o nový.',
      reason: 'inactive',
    });
  }

  // Same rule as checkout (Decision 7), different body vocabulary: this payload is
  // an invitations-flow one (name/phone/email), and the guest may correct what was
  // prefilled from their sub-order.
  const validated = validateIdentity(req.body, INVITE_IDENTITY_FIELDS);
  if (validated.error) {
    return res.status(400).json({ error: validated.error, field: validated.field });
  }
  const { name, phone, email } = validated.identity;

  if (pendingInvitationByPhone(phone)) {
    return res.status(409).json({
      error: 'Žiadosť o účet s týmto telefónnym číslom už evidujeme. Správca sa ti ozve.',
      reason: 'exists',
    });
  }

  // The host's referral code, read from the friends row — never from the body, and
  // never published to the guest. `invitations.invite_code` is NOT NULL and the
  // legacy flow stores the code the registration came through, so the host's own is
  // the faithful value; a friend row without one (only possible for a row that
  // escaped the invite-code backfill) must not turn this into a 500.
  const host = db.prepare('SELECT invite_code FROM friends WHERE id = ?').get(link.host_friend_id);

  try {
    db.prepare(`
      INSERT INTO invitations (invite_code, invited_by_friend_id, name, phone, email, status, source)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(host?.invite_code || '', link.host_friend_id, name, phone, email, INVITE_SOURCE_GUEST_ORDER);
  } catch (e) {
    // The pending-phone rule is ALSO a partial unique index, and the check above
    // loses a race (two taps, two guests with one number). That is still a plain
    // conflict for the caller, so it must not surface as a 500 — and the SQLite
    // message must not surface at all.
    if (/UNIQUE/i.test(e.message || '')) {
      return res.status(409).json({
        error: 'Žiadosť o účet s týmto telefónnym číslom už evidujeme. Správca sa ti ozve.',
        reason: 'exists',
      });
    }
    console.error('Error creating guest invite request:', e.message);
    return res.status(500).json({ error: 'Žiadosť sa nepodarilo odoslať. Skús to znova.' });
  }

  // A bare acknowledgement: this is an anonymous write, so the response carries no
  // ids, no host details and nothing about the invitations queue.
  res.status(201).json({ success: true });
}

// ---------------------------------------------------------------------------
// The LEGACY PAIR FORM (14 §UC-GR-002) — `/g/:token/o/:orderToken`'s API half,
// kept working FOREVER. Every one of these URLs already sits in a colleague's
// messages and in `localStorage.gorifi_guest_orders`; nobody migrates them, so a
// strict pair would leave every pre-regeneration URL 404 forever — the incident
// unfixed. The `:token` half is therefore ignored for resolution AND
// authorization, and each route runs the very same shared handler as its
// canonical twin above.
router.get('/:token/orders/:orderToken', guestReadLimiter, (req, res) => {
  const resolved = resolveLegacyPairForm(req);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  handleStatusRead(res, resolved);
});

router.put('/:token/orders/:orderToken', guestWriteLimiter, (req, res) => {
  const resolved = resolveLegacyPairForm(req);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  handleStatusEdit(req, res, resolved);
});

router.post('/:token/orders/:orderToken/invite-request', guestWriteLimiter, (req, res) => {
  const resolved = resolveLegacyPairForm(req);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  handleInviteRequest(req, res, resolved);
});

// The listing's and the waitlist signup's pure cores, for guest-standing-link.spec.js's
// and guest-waitlist.spec.js's throwaway-boot probes only (DB states the shared e2e
// target cannot reach). No other module imports them.
export { listingResponse, resolveEntry, waitlistResponse };

export default router;
