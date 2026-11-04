import db from '../db/schema.js';
import { deliveryOf } from './delivery.js';
import { balancePaymentBlock, guestPaymentBlock } from './payment.js';
import { standingUrlPath } from './standing-link.js';
import { guestStatusUrlPath } from './guest-orders.js';
import { resolveLoginUrl } from './credentials-message.js';
import { getTemplate } from './templates.js';
import { NOTHING_OWED, firstName, formatDatum, sumaValue } from './template-render.js';
import { SEGMENT_KEY_MAX, bratislavaDateOf, handOverSegmentKey, isSegmentKey } from './segment-keys.js';

// WA-T4: the grammar, the bound, the Bratislava day and the hand-over key live in the PURE
// `segment-keys.js` (schema.js's boot re-key needs them and cannot import this file);
// re-exported here so WA-T3's surface is unchanged.
export { SEGMENT_KEY_MAX, bratislavaDateOf, handOverSegmentKey, isSegmentKey };

// ═══════════════════════════════════════════════════════════════════════════
// 21 §UC-WA-005 — WHO A MESSAGE GOES TO. ONE HOME for the recipient lists (R5.2),
// consumed by the hand-over enqueue (WA-T4, §UC-WA-006), the composer's compose /
// rerender (WA-T5, §UC-WA-008) and the two admin READ routes (WA-T3,
// routes/notifications.js). WA-T3 shipped it.
//
// ⚠ READ-ONLY. Nothing here writes, and that includes the two tempting side doors:
//   • `helpers/standing-link.js ensureStandingToken()` MINTS a token on first call —
//     this file reads `friends.guest_link_token` as stored and composes
//     `standingUrlPath(token)`; an un-minted host yields `vars.odkaz = ''`, so the
//     body keeps a literal `{odkaz}` and release refuses it (§UC-WA-007). (The GL-T3
//     code-comment contract in `helpers/guest-waitlist.js` said `ensureStandingToken`;
//     that line carries a strike note pointing here.)
//   • `helpers/outbox.js` is the ONLY writer of `notifications`.
// `whatsapp-segments.spec.js` §1 pins zero row changes across every builder.
//
// ── THE SIX KINDS (21 §UC-WA-005's table — the SPEC grammar; ~~DP-T3's hook still
//    writes `loc<id>` / `packeta` / `host:<id>` until WA-T4 moves it onto these~~ →
//    WA-T4: the hook writes these, and schema.js re-keyed DP-T3's rows at boot) ──
//   handed_over:pickup:<location_id>:<YYYY-MM-DD>  template `pickup`
//   handed_over:packeta:<YYYY-MM-DD>               template `packeta`
//   host_guests:<host_friend_id>:<YYYY-MM-DD>      template `host`
//   not_ordered:<cycle_id>                         template `closing`
//   waitlist:<cycle_id>                            template `waitlist`
//   all_active                                     template `custom`
// There is NO `in_person` segment: an `in_person` bag enqueues nothing (resolved
// conflict 4, §UC-WA-006) — `handOverSegmentKey()` answers null for it. (The WA-T3
// backlog row said „`handed_over:<target>` ×3"; the spec's table has two hand-over
// targets plus `host_guests`, six kinds in all, and the spec wins.)
//
// ── RULES (each one is a CLAUDE.md rule restated where it bites) ────────────────
//   • Consent predicate on every FRIEND row: `active = 1 AND whatsapp_opt_in = 1`.
//     Active friends without consent are NOT recipients; they are counted in
//     `excluded_opt_out` and handed IN-PROCESS as `opted_out` (WA-T4's D5 e-mail
//     rule needs them). `segmentForJson()` publishes the COUNT only — never names.
//     An inactive friend is neither. Guests have no flag (D6). A waitlist row with
//     `whatsapp_opt_in = 0` counts as `excluded_opt_out` too (no consent, same idea).
//   • Number predicate: a recipient with `phone_e164 IS NULL` is RETURNED with
//     `phone_e164: null` and counted in `no_phone` — never filtered, never guessed.
//     ⚠ The WA-T3 backlog row (and GL-T3's code-comment contract) filtered the
//     waitlist on `phone_e164 IS NOT NULL`; 21 §UC-WA-005 („returned, not filtered")
//     and §UC-WA-007 („a phone_e164 = NULL waitlist row is skipped/no_phone") say the
//     row must reach the enqueue to become its `skipped` to-do item. The spec wins.
//   • Guest aggregation discipline: the guest half is a SEPARATE query merged in JS,
//     never a second LEFT JOIN on `orders`. Cancelled sub-orders are excluded
//     everywhere — including the DP-T3 seam case of a sub-order cancelled AFTER its
//     hand-over, which keeps `handed_over_at`.
//   • Type/target come ONLY from `helpers/delivery.js deliveryOf()`. A guest row is
//     classified with no `host` option: segments read `.type` only, and the classifier
//     decides `packeta` (own address) vs `via_host` before any host inheritance — the
//     same call `routes/cycles.js isPacketaSubOrder()` makes.
//   • Hand-over date = `handed_over_at` (UTC, as SQLite stores it) converted to its
//     Europe/Bratislava calendar day in JS — `template-render.js bratislavaDay()`, the
//     one home of that conversion.
//   • `{suma}`: friend = the LEDGER balance owed (PO 2026-09-19) through
//     `helpers/payment.js balancePaymentBlock().amount` (its sign flip and rounding —
//     no second formula); guest = `guestPaymentBlock().amount` (total + Packeta fee,
//     the module-20 seam) while unpaid, 0 once paid. Both then go through
//     `sumaValue()`, so ≤ 0 ⇒ the `NOTHING_OWED` Symbol (the renderer drops the
//     sentence) and a debt ⇒ `31,10 €`.
//   • `{odkaz}`: friend = the login root, guest = `<base>` + `guest-orders.js
//     guestStatusUrlPath(order_token)` (the ONE composer of `/g/o/<token>`), waitlist =
//     `<base>` + `standingUrlPath(guest_link_token)`. `<base>` = `options.baseUrl`, by
//     default `credentials-message.js resolveLoginUrl()` (PUBLIC_BASE_URL, else the
//     brand domain) — the same base the guest confirmation mail and the magic link use.
//
// ── THE SEAM (what WA-T4 / WA-T5 consume) ───────────────────────────────────────
//   buildSegment(cycleId, key, { baseUrl }) ⇒ segment | null (null = not a segment
//       of the six). `{ key, kind, name, template_key, cycle_id, recipients,
//       excluded_opt_out, no_phone, opted_out }`, each recipient
//       `{ recipient_kind, recipient_id, name, phone, phone_e164, email, opt_in,
//          order_id, guest_order_id, vars }` (§UC-WA-005's shape). `vars.suma` may be
//       the NOTHING_OWED Symbol — hand `vars` to `renderTemplate`/`unresolvedFor` as is.
//   computedSegments(cycleId, { baseUrl }) ⇒ the three composer-built summaries.
//   handOverSegmentKey({ delivery, handedOverAt, hostFriendId }) ⇒ the group key a
//       handed-over bag belongs to (null for `in_person` / no stamp). ~~WA-T4 computes
//       a bag's key with THIS, then picks its recipient out of `buildSegment()` by
//       `order_id` / `guest_order_id`.~~ → WA-T4 shipped it as
//   handOverRecipients(cycleId, { orderIds, guestOrderIds }) ⇒ the entries of the
//       handed bags out of the SAME two halves `buildSegment()` filters (each half
//       computes its rows' keys with `handOverSegmentKey()` from the ROW's own stamp),
//       so the outbox never runs a second recipient query or one `buildSegment()` per key.
//   segmentForJson(segment) ⇒ the JSON-safe preview (see that function).
//   isSegmentKey / parseSegmentKey / segmentName — the grammar and the titles.
// ═══════════════════════════════════════════════════════════════════════════

const TEMPLATE_BY_KIND = Object.freeze({
  handed_over_pickup: 'pickup',
  handed_over_packeta: 'packeta',
  host_guests: 'host',
  not_ordered: 'closing',
  waitlist: 'waitlist',
  all_active: 'custom',
});

// A positive safe integer out of a key segment, or null.
function positiveId(text) {
  if (!/^[1-9]\d{0,15}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

// A REAL calendar day `YYYY-MM-DD` (2026-02-31 is not one), or null.
function calendarDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return !Number.isNaN(utc.getTime()) && utc.toISOString().slice(0, 10) === text ? text : null;
}

/**
 * The six kinds of 21 §UC-WA-005, parsed: `{ kind, …qualifiers }`, or null for anything
 * else — including grammatical keys that are no segment (DP-T3's `loc5` / `host:7` /
 * `packeta`, an `in_person` key, a zero id, an impossible date).
 */
export function parseSegmentKey(key) {
  if (!isSegmentKey(key)) return null;
  const parts = key.split(':');
  const [head] = parts;
  if (head === 'all_active') return parts.length === 1 ? { kind: 'all_active' } : null;
  if (head === 'not_ordered' || head === 'waitlist') {
    const cycleId = parts.length === 2 ? positiveId(parts[1]) : null;
    return cycleId ? { kind: head, cycleId } : null;
  }
  if (head === 'host_guests') {
    const hostFriendId = parts.length === 3 ? positiveId(parts[1]) : null;
    const date = parts.length === 3 ? calendarDay(parts[2]) : null;
    return hostFriendId && date ? { kind: 'host_guests', hostFriendId, date } : null;
  }
  if (head === 'handed_over') {
    if (parts[1] === 'pickup' && parts.length === 4) {
      const locationId = positiveId(parts[2]);
      const date = calendarDay(parts[3]);
      return locationId && date ? { kind: 'handed_over_pickup', locationId, date } : null;
    }
    if (parts[1] === 'packeta' && parts.length === 3) {
      const date = calendarDay(parts[2]);
      return date ? { kind: 'handed_over_packeta', date } : null;
    }
  }
  return null;
}

// `24. 10.` — the group titles' short day (the prototype's `{d. m.}`).
const shortDay = (iso) => `${Number(iso.slice(8, 10))}. ${Number(iso.slice(5, 7))}.`;

/**
 * The Slovak group title the composer shows (21 §UC-WA-005, from the prototype), or
 * null for a key that is no segment. Reads the location / host NAME (one row) — never
 * the active-only picker feed: a retired point still names its group.
 */
export function segmentName(key) {
  const parsed = parseSegmentKey(key);
  if (!parsed) return null;
  switch (parsed.kind) {
    case 'handed_over_pickup': {
      const loc = db.get('SELECT name FROM pickup_locations WHERE id = ?', [parsed.locationId]);
      return `${loc?.name || 'Odberné miesto'} — odovzdané ${shortDay(parsed.date)}`;
    }
    case 'handed_over_packeta':
      return `Packeta — odovzdané ${shortDay(parsed.date)}`;
    case 'host_guests': {
      const host = firstName(db.get('SELECT name FROM friends WHERE id = ?', [parsed.hostFriendId])?.name);
      return host ? `Hostia ${host} — odovzdané hostiteľovi` : 'Hostia — odovzdané hostiteľovi';
    }
    case 'not_ordered':
      return 'Neobjednali (otvorená objednávka)';
    case 'waitlist':
      return 'Čakajúci hostia';
    case 'all_active':
      return 'Všetci aktívni priatelia';
    default:
      return null;
  }
}

// ── value builders ───────────────────────────────────────────────────────────

// The base every `{odkaz}` is composed from: no trailing slash, ever.
function baseOf(options) {
  const raw = typeof options?.baseUrl === 'string' && options.baseUrl.trim() ? options.baseUrl.trim() : resolveLoginUrl();
  return raw.replace(/\/+$/, '');
}

// A friend's `{suma}`: the ledger balance OWED. `balancePaymentBlock()` owns the sign flip
// and the rounding (`max(0, -balance)`); `sumaValue()` turns 0 into NOTHING_OWED.
function friendSuma(row) {
  return sumaValue(balancePaymentBlock({ id: row.id, name: row.name, balance: row.balance }).amount);
}

// A guest's `{suma}`: `guestPaymentBlock().amount` (total + Packeta fee) while unpaid,
// nothing once paid (PO 2026-09-19). `paid` is 0/1 in the column.
function guestSuma(row, cycleName) {
  if (row.paid) return NOTHING_OWED;
  return sumaValue(guestPaymentBlock(row, cycleName).amount);
}

// Every `vars` object carries only the placeholders that HAVE a source for that
// recipient; a missing key stays a literal placeholder in the body (D10).
function cycleVars(cycle) {
  return { 'objednávka': cycle?.name || '', datum: formatDatum(cycle?.closes_at) };
}

const FRIEND_COLUMNS = `
  f.id, f.name, f.phone, f.phone_e164, f.email, f.active, f.whatsapp_opt_in,
  COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.friend_id = f.id), 0) AS balance
`;

function friendRecipient(row, vars, orderId = null) {
  return {
    recipient_kind: 'friend',
    recipient_id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    phone_e164: row.phone_e164 || null,
    email: row.email || null,
    opt_in: row.whatsapp_opt_in === 1 ? 1 : 0,
    order_id: orderId,
    guest_order_id: null,
    vars,
  };
}

function guestRecipient(row, vars) {
  return {
    recipient_kind: 'guest',
    recipient_id: row.id,
    name: row.guest_name,
    phone: row.guest_phone ?? null,
    phone_e164: row.phone_e164 || null,
    email: row.guest_email || null,
    opt_in: null, // guests have no opt-in flag (D6)
    order_id: null,
    guest_order_id: row.id,
    vars,
  };
}

const hasConsent = (row) => row.whatsapp_opt_in === 1;

// Split friend candidates (already filtered to `active = 1`) by the consent predicate.
function consentSplit(candidates) {
  const recipients = [];
  const optedOut = [];
  for (const candidate of candidates) {
    (candidate.consent ? recipients : optedOut).push(candidate.recipient);
  }
  return { recipients, optedOut };
}

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'sk')
  || a.recipient_kind.localeCompare(b.recipient_kind) || a.recipient_id - b.recipient_id;

// ── the hand-over halves (one query each, merged in JS) ─────────────────────

// Friend orders of the cycle that were HANDED OVER, with their own pickup columns.
// The `orders` row IS where a party with an order keeps its pickup (helpers/pickup.js,
// learnings 06), so these columns are the resolved ones — the same SELECT shape
// `routes/cycles.js` hands `deliveryOf()` for the board.
function handedOverFriendRows(cycleId) {
  return db.all(`
    SELECT o.id AS order_id, o.handed_over_at, o.pickup_location_id, o.pickup_location_note, o.packeta_address,
           ${FRIEND_COLUMNS}
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    WHERE o.cycle_id = ? AND o.status = 'submitted' AND o.handed_over_at IS NOT NULL
    ORDER BY f.name COLLATE NOCASE, o.id
  `, [cycleId]);
}

// The cycle's LIVE handed-over guest sub-orders — the separate guest half. `link_id`
// is selected because it is what tells `deliveryOf()` this is a guest row.
function handedOverGuestRows(cycleId) {
  return db.all(`
    SELECT g.id, g.link_id, g.guest_name, g.guest_phone, g.phone_e164, g.guest_email, g.total, g.paid,
           g.delivery_fee, g.packeta_address, g.handed_over_at, g.order_token,
           l.host_friend_id, hf.name AS host_name
    FROM guest_orders g
    JOIN guest_order_links l ON l.id = g.link_id
    JOIN friends hf ON hf.id = l.host_friend_id
    WHERE l.cycle_id = ? AND COALESCE(g.status, 'submitted') <> 'cancelled' AND g.handed_over_at IS NOT NULL
    ORDER BY g.guest_name COLLATE NOCASE, g.id
  `, [cycleId]);
}

function locationsById() {
  return new Map(db.all('SELECT id, name, address FROM pickup_locations').map((row) => [row.id, row]));
}

// ⚠ WA-T4: the two halves compute EVERY handed-over party's key and return them all;
// `buildSegment()` keeps the entries of ONE key, `handOverRecipients()` (the hand-over
// enqueue's door) keeps the entries of the bags it was handed. One query per half,
// one `vars` composition, two filters — never a second recipient query.

// Every ACTIVE friend whose order of the cycle is handed over, as `{ key, consent,
// recipient }`. `key` is null for a bag that belongs to no group (`in_person`).
// An INACTIVE friend is neither a recipient nor `opted_out` (§UC-WA-005's consent
// predicate is `active = 1 AND whatsapp_opt_in = 1`), so they are not returned.
function friendHandOverEntries(cycle, base) {
  const locations = locationsById();
  const out = [];
  for (const row of handedOverFriendRows(cycle.id)) {
    if (row.active !== 1) continue;
    const delivery = deliveryOf(row, { locationsById: locations });
    const key = handOverSegmentKey({ delivery, handedOverAt: row.handed_over_at });
    const vars = { meno: firstName(row.name), ...cycleVars(cycle), suma: friendSuma(row), odkaz: base };
    if (delivery.type === 'pickup') {
      if (delivery.target_label) {
        vars.miesto = delivery.target_detail ? `${delivery.target_label} (${delivery.target_detail})` : delivery.target_label;
      }
    } else if (delivery.type === 'packeta') {
      vars.miesto = delivery.target_detail;
    }
    out.push({ key, consent: hasConsent(row), recipient: friendRecipient(row, vars, row.order_id) });
  }
  return out;
}

// Every LIVE handed-over guest sub-order of the cycle, as `{ key, consent: true,
// recipient }` (guests have no flag — D6).
function guestHandOverEntries(cycle, base) {
  const out = [];
  for (const row of handedOverGuestRows(cycle.id)) {
    const delivery = deliveryOf(row);
    const statusPath = guestStatusUrlPath(row.order_token);
    const key = handOverSegmentKey({ delivery, handedOverAt: row.handed_over_at, hostFriendId: row.host_friend_id });
    const vars = {
      meno: firstName(row.guest_name),
      ...cycleVars(cycle),
      suma: guestSuma(row, cycle.name),
      odkaz: statusPath ? `${base}${statusPath}` : '',
      host: firstName(row.host_name),
    };
    if (delivery.type === 'packeta') vars.miesto = delivery.target_detail;
    out.push({ key, consent: true, recipient: guestRecipient(row, vars) });
  }
  return out;
}

// ── the composer-built halves ───────────────────────────────────────────────

function notOrderedCandidates(cycle, base) {
  // ⚠ „Ordered" = an `orders` row of THIS cycle holding ≥ 1 `order_items` row, ANY
  // status (21 §UC-WA-005 literal): an auto-saved EMPTY order is „not ordered"; a draft
  // WITH items counts as ordered. A correlated subquery — no join on `orders`.
  const rows = db.all(`
    SELECT ${FRIEND_COLUMNS}
    FROM friends f
    WHERE f.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM orders o
        WHERE o.friend_id = f.id AND o.cycle_id = ?
          AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)
      )
    ORDER BY f.name COLLATE NOCASE, f.id
  `, [cycle.id]);
  return rows.map((row) => ({
    consent: hasConsent(row),
    recipient: friendRecipient(row, { meno: firstName(row.name), ...cycleVars(cycle), suma: friendSuma(row), odkaz: base }),
  }));
}

function allActiveCandidates(base) {
  const rows = db.all(`SELECT ${FRIEND_COLUMNS} FROM friends f WHERE f.active = 1 ORDER BY f.name COLLATE NOCASE, f.id`);
  return rows.map((row) => ({
    consent: hasConsent(row),
    recipient: friendRecipient(row, { meno: firstName(row.name), suma: friendSuma(row), odkaz: base }),
  }));
}

function waitlistCandidates(cycle, base) {
  // Un-notified rows of ACTIVE hosts (19 §UC-GL-010 / 21 §UC-WA-005). Not filtered by
  // `w.cycle_id` — that is the round the guest signed up BEFORE; the segment announces
  // the round being opened (`cycle`). `guest_link_token` is read as stored and only
  // ever composed into `{odkaz}` — `segmentForJson()` never publishes it.
  const rows = db.all(`
    SELECT w.id, w.name, w.phone, w.phone_e164, w.whatsapp_opt_in,
           f.name AS host_name, f.guest_link_token
    FROM guest_waitlist w
    JOIN friends f ON f.id = w.host_friend_id
    WHERE w.notified_at IS NULL AND f.active = 1
    ORDER BY f.name COLLATE NOCASE, w.created_at, w.id
  `);
  return rows.map((row) => {
    const path = standingUrlPath(row.guest_link_token);
    return {
      consent: row.whatsapp_opt_in === 1,
      recipient: {
        recipient_kind: 'waitlist',
        recipient_id: row.id,
        name: row.name,
        phone: row.phone ?? null,
        phone_e164: row.phone_e164 || null,
        email: null, // the waitlist stores no e-mail
        opt_in: row.whatsapp_opt_in === 1 ? 1 : 0,
        order_id: null,
        guest_order_id: null,
        vars: {
          meno: firstName(row.name),
          host: firstName(row.host_name),
          odkaz: path ? `${base}${path}` : '',
          ...cycleVars(cycle),
        },
      },
    };
  });
}

// ── the builders ─────────────────────────────────────────────────────────────

function readCycle(cycleId) {
  if (!Number.isInteger(cycleId) || cycleId <= 0) return null;
  return db.get('SELECT id, name, status, closes_at FROM order_cycles WHERE id = ?', [cycleId]);
}

function finish(key, kind, cycleId, recipients, optedOut) {
  return {
    key,
    kind,
    name: segmentName(key),
    template_key: TEMPLATE_BY_KIND[kind],
    cycle_id: cycleId,
    recipients,
    excluded_opt_out: optedOut.length,
    no_phone: recipients.filter((r) => !r.phone_e164).length,
    opted_out: optedOut,
  };
}

/**
 * Build ONE segment of 21 §UC-WA-005 for `cycleId` (ignored by `all_active`). Returns
 * null when `key` is no segment of the six, or a cycle-bound key's cycle does not exist.
 * ⚠ A `not_ordered:<id>` / `waitlist:<id>` key is built for the cycle IT names; the read
 * route refuses a key naming another cycle than `cycle_id` before it gets here.
 */
export function buildSegment(cycleId, key, options = {}) {
  const parsed = parseSegmentKey(key);
  if (!parsed) return null;
  const base = baseOf(options);

  if (parsed.kind === 'all_active') {
    const { recipients, optedOut } = consentSplit(allActiveCandidates(base));
    return finish(key, parsed.kind, null, recipients, optedOut);
  }

  const cycle = readCycle(parsed.cycleId ?? cycleId);
  if (!cycle) return null;

  if (parsed.kind === 'not_ordered') {
    const { recipients, optedOut } = consentSplit(notOrderedCandidates(cycle, base));
    return finish(key, parsed.kind, cycle.id, recipients, optedOut);
  }
  if (parsed.kind === 'waitlist') {
    const { recipients, optedOut } = consentSplit(waitlistCandidates(cycle, base));
    return finish(key, parsed.kind, cycle.id, recipients, optedOut);
  }

  // The hand-over kinds: the friend half and the guest half, merged in JS.
  const friends = parsed.kind === 'host_guests' ? [] : friendHandOverEntries(cycle, base).filter((e) => e.key === key);
  const guests = guestHandOverEntries(cycle, base).filter((e) => e.key === key).map((e) => e.recipient);
  const { recipients, optedOut } = consentSplit(friends);
  return finish(key, parsed.kind, cycle.id, [...recipients, ...guests].sort(byName), optedOut);
}

const toIdSet = (ids) => new Set((Array.isArray(ids) ? ids : []).filter((id) => Number.isInteger(id) && id > 0));

/**
 * WA-T4 (21 §UC-WA-006) — the hand-over enqueue's door into the SAME halves
 * `buildSegment()` reads: for the given friend `orderIds` / guest `guestOrderIds` of
 * `cycleId`, the entries `{ key, template_key, consent, recipient }` of every one that
 * is a handed-over party with a group, in id order (friends first). `recipient` is
 * exactly what `buildSegment(cycleId, key)` lists for that bag (or, with `consent:
 * false`, what it hands over as `opted_out`) — same row, same `vars`.
 *
 * A requested id with NO entry is a bag that owes no message to anybody: an `in_person`
 * friend (no group), an inactive friend, a cancelled sub-order, an id that is not
 * handed over (or not of this cycle). The caller counts those as `none`.
 * Returns `[]` for an unknown cycle.
 */
export function handOverRecipients(cycleId, { orderIds = [], guestOrderIds = [], baseUrl } = {}) {
  const cycle = readCycle(cycleId);
  if (!cycle) return [];
  const base = baseOf({ baseUrl });
  const wantOrders = toIdSet(orderIds);
  const wantGuests = toIdSet(guestOrderIds);
  const withTemplate = (entry) => ({ ...entry, template_key: TEMPLATE_BY_KIND[parseSegmentKey(entry.key)?.kind] || null });
  const friends = wantOrders.size === 0 ? [] : friendHandOverEntries(cycle, base)
    .filter((e) => e.key && wantOrders.has(e.recipient.order_id))
    .sort((a, b) => a.recipient.order_id - b.recipient.order_id);
  const guests = wantGuests.size === 0 ? [] : guestHandOverEntries(cycle, base)
    .filter((e) => e.key && wantGuests.has(e.recipient.guest_order_id))
    .sort((a, b) => a.recipient.guest_order_id - b.recipient.guest_order_id);
  return [...friends, ...guests].map(withTemplate).filter((e) => e.template_key);
}

/**
 * WA-T5 — the template a segment key's rows are rendered from (21 §UC-WA-005's table),
 * or null for a key that is no segment of the six (e.g. the boot re-key's
 * `legacy_handover:…` fallback). The compose / rerender doors ask it BEFORE building
 * the segment, so a disabled template refuses without running the recipient query.
 */
export function segmentTemplateKey(key) {
  const parsed = parseSegmentKey(key);
  return parsed ? TEMPLATE_BY_KIND[parsed.kind] : null;
}

/** The summary the composer lists for a segment (no recipients, no names). */
export function segmentSummary(segment) {
  const template = getTemplate(segment.template_key);
  return {
    key: segment.key,
    name: segment.name,
    template_key: segment.template_key,
    template_enabled: !!template?.enabled,
    requires_open_cycle: segment.kind === 'not_ordered' || segment.kind === 'waitlist',
    count: segment.recipients.length,
    excluded_opt_out: segment.excluded_opt_out,
    no_phone: segment.no_phone,
  };
}

/**
 * The three composer-built segments of a cycle (§UC-WA-008 `computed`): `not_ordered`,
 * `waitlist`, `all_active` — always all three, in that order. `requires_open_cycle`
 * says which two compose only while the cycle is `open` (WA-T5's 409 `cycle_not_open`);
 * the counts are live whether or not a group was composed already.
 */
export function computedSegments(cycleId, options = {}) {
  return [`not_ordered:${cycleId}`, `waitlist:${cycleId}`, 'all_active']
    .map((key) => buildSegment(cycleId, key, options))
    .filter(Boolean)
    .map(segmentSummary);
}

/**
 * THE JSON BOUNDARY of a built segment (the admin preview of
 * `GET /api/notifications/segments?…&segment_key=`). Three deliberate differences from
 * the in-process object:
 *   • `vars.suma === NOTHING_OWED` ⇒ `null`. `JSON.stringify` DROPS a Symbol-valued key,
 *     which would read as „no value" = a literal, release-blocking `{suma}` — the
 *     opposite meaning. So in JSON: `null` = nothing owed (the sentence is dropped), a
 *     string = the amount, an absent key = no source for that recipient.
 *   • `vars.odkaz` is NEVER published — it holds a guest's `order_token` or a host's
 *     standing token (`friends.guest_link_token`, which CLAUDE.md lets only the four
 *     standing routes publish). The preview carries `odkaz_resolved: boolean` instead,
 *     which is all the composer needs to flag a row release would refuse.
 *   • `opted_out` (names) is dropped; `excluded_opt_out` (the count) stays.
 */
export function segmentForJson(segment) {
  return {
    ...segmentSummary(segment),
    kind: segment.kind,
    cycle_id: segment.cycle_id,
    recipients: segment.recipients.map(({ vars, ...rest }) => {
      const { odkaz, ...shown } = vars;
      if (shown.suma === NOTHING_OWED) shown.suma = null;
      return { ...rest, vars: shown, odkaz_resolved: typeof odkaz === 'string' && odkaz.trim() !== '' };
    }),
  };
}
