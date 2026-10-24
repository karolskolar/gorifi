import db from '../db/schema.js';
import { handOverRecipients } from './segments.js';
import { getTemplate } from './templates.js';
import { renderTemplate } from './template-render.js';
// The ONE home of „is this an e-mail address" (CLAUDE.md `storedEmailUsable()` rule) —
// the CONSTANT only; this file never calls the mailer (`sendMail` is WA-T5/T6's, at release).
import { EMAIL_SHAPE } from './mailer.js';

// ⚠ THE ONE AND ONLY WRITER OF `notifications` (DP-T3, 16 §UC-DP-008; module 21's
// writers join HERE — WA-T4 §UC-WA-006, WA-T5's compose/release later).
//
// It records WHICH template is owed to WHOM about WHICH bag, at the moment the bag
// leaves the admin's hands, renders the text and snapshots the address. It SENDS
// NOTHING — there is no outbound call and no WhatsApp import, and the only mailer import
// is the `EMAIL_SHAPE` constant, by design (01-architecture: „the API never sends";
// the e-mail rows are handed to the mailer at RELEASE, WA-T5/WA-T6).
//
// ⚠ SYNCHRONOUS, AND CALLED INSIDE THE CALLER'S `db.transaction()`, AFTER the
// `handed_over_at` UPDATEs (§UC-WA-006). An `await` in here would break the
// check-then-write atomicity the hand-over routes rest on under `instances: 1`
// (CLAUDE.md, GA-T8) — the enqueue must commit or roll back with the stamp it
// describes. And it reads the stamps it was called for, through the same connection,
// so it MUST come after them.
//
// ⚠ A NOTIFICATION IS NOT A FINANCIAL EVENT. Nothing here touches `transactions`,
// `orders.total`, `paid` or `delivery_fee` (it READS the ledger balance for `{suma}`,
// through `helpers/segments.js`). Stage 3 is ledger-neutral by construction (§UC-DP-004).
//
// ── WA-T4: DP-T3's inline hook, refactored onto module 21 (§UC-WA-006) ─────────────
//   • WHO and WHAT come from `helpers/segments.js handOverRecipients()` — the same two
//     halves `buildSegment()` reads, so a row's recipient, `vars` and `segment_key` are
//     exactly what the composer will list for that group. No recipient query here.
//   • `segment_key` is 21's grammar (`handed_over:pickup:<loc>:<date>` /
//     `handed_over:packeta:<date>` / `host_guests:<host>:<date>`, `segment-keys.js
//     handOverSegmentKey()`), computed from the ROW's own `handed_over_at` — never DP-T3's
//     `loc<id>` / `packeta` / `host:<id>` (re-keyed at boot by schema.js
//     `rekeyLegacyHandOverRows()`).
//   • `body = renderTemplate(template.body, vars)`, `phone_e164` / `email` SNAPSHOTS.
//     ~~`body` and `phone_e164` are NULL ON PURPOSE … rendered at RELEASE~~ (DP-T3) →
//     21 §UC-WA-001/006 store the rendered body per row at enqueue: the admin reviews
//     the TEXT in the composer, and „Prepísať texty vo fronte" (WA-T5 rerender) is the
//     door for a template edited afterwards.
//   • ⚠ `in_person` STILL ENQUEUES NOTHING (resolved conflict 4): no group exists for it,
//     `handOverSegmentKey()` answers null and `handOverRecipients()` drops it.

// The three OPERATIONAL templates — the only ones whose message an opted-out friend
// still receives, by e-mail (Decision D5, PO 2026-09-19). `closing` / `waitlist` /
// `custom` give an opted-out friend nothing (WA-T5's compose reuses `planRow()`).
export const OPERATIONAL_TEMPLATES = Object.freeze(['pickup', 'packeta', 'host']);

/**
 * §UC-WA-006's per-recipient rules, IN ORDER, as a pure decision: the row one recipient
 * gets under one template, or null for „no row" (counted in `none`).
 *
 *   1. template missing / disabled                ⇒ null
 *   2. friend without consent (`consent === false`): an OPERATIONAL template and an
 *      e-mail ⇒ `email`/`queued` (D5); otherwise ⇒ null
 *      („an e-mail" = one that passes `EMAIL_SHAPE`, here and in rule 4 — `usableEmail()`)
 *   3. `phone_e164`                               ⇒ `whatsapp`/`queued`
 *   4. no phone, an e-mail                        ⇒ `email`/`queued` (R5.8 fallback)
 *   5. neither                                    ⇒ `whatsapp`/`skipped`, `error = 'no_phone'`
 *
 * The snapshots are MINIMAL: a `whatsapp` row carries the number and no e-mail, an
 * `email` row the address and no number (an opted-out friend's number is not copied
 * into a row whose channel cannot use it), a `skipped` row neither.
 */
export function planRow(template, recipient, { consent = true } = {}) {
  if (!template || !template.enabled) return null;
  const phone = typeof recipient?.phone_e164 === 'string' && recipient.phone_e164 ? recipient.phone_e164 : null;
  const email = usableEmail(recipient?.email);
  if (consent === false) {
    return OPERATIONAL_TEMPLATES.includes(template.key) && email
      ? { channel: 'email', status: 'queued', phone_e164: null, email, error: null }
      : null;
  }
  if (phone) return { channel: 'whatsapp', status: 'queued', phone_e164: phone, email: null, error: null };
  if (email) return { channel: 'email', status: 'queued', phone_e164: null, email, error: null };
  return { channel: 'whatsapp', status: 'skipped', phone_e164: null, email: null, error: 'no_phone' };
}

// An e-mail counts as PRESENT only when it passes the mailer's `EMAIL_SHAPE` — the
// `storedEmailUsable()` rule (CLAUDE.md, GP-T7): a via_host guest's checkout e-mail or a
// friend's admin-typed one may be unshaped, and an unshaped address is ABSENT for rules 2
// and 4 (it would only become a `failed`/`invalid_recipient` row at release). Trimmed
// first; returns the address or null.
function usableEmail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && EMAIL_SHAPE.test(trimmed) ? trimmed : null;
}

// Is this error the outbox's partial unique index (WA-T1, 21 §UC-WA-001)? BOTH
// halves, and the message half COLUMN-SPECIFIC (the `isWaitlistConflict` /
// `isStandingTokenConflict` precedent): a different constraint must never be read as
// „already queued". better-sqlite3 names the COLUMNS of a unique index, not the index.
export function isQueuedOnceConflict(e) {
  return typeof e?.code === 'string'
    && e.code.startsWith('SQLITE_CONSTRAINT')
    && /UNIQUE constraint failed: notifications\.template_key, notifications\.recipient_kind, notifications\.recipient_id, notifications\.cycle_id/
      .test(String(e?.message || ''));
}

/**
 * What the module-16 routes publish as `queued_notifications`: the rows an enqueue
 * minted in status `queued` — WhatsApp AND e-mail — so a hand → un-hand pair balances
 * against `dequeued_notifications` (which deletes `queued` rows only). A `skipped` to-do
 * is not a queued message, and `already` minted nothing.
 */
export function queuedCount(result) {
  return (result?.queued || 0) + (result?.email || 0);
}

const ids = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => Number.isInteger(id) && id > 0))];

/**
 * Queue the messages a hand-over owes (21 §UC-WA-006).
 *
 *   enqueueForHandOver({ cycleId, orderIds, guestOrderIds, handedOverAt })
 *     → { queued, email, skipped, none, already, groups }
 *
 * `orderIds` / `guestOrderIds` are the bags THIS call stamped — never „every bag that
 * happens to be handed over" (DP-T3's review rule, kept by every caller: a no-op
 * hand-over is not an event and mints nothing, whatever the old rows' status).
 *
 * Every distinct requested id ends in EXACTLY ONE count:
 *   `queued`  — a `whatsapp` row INSERTed `queued`
 *   `email`   — an `email` row INSERTed `queued` (D5 / R5.8)
 *   `skipped` — a `whatsapp` row INSERTed `skipped`/`no_phone` (the composer's to-do)
 *   `none`    — no row owed: `in_person`, an inactive friend, a cancelled or unstamped
 *               bag, a disabled template, an opted-out friend without an e-mail
 *   `already` — a row this one would duplicate already exists (see IDEMPOTENCY)
 * `groups` = the distinct `segment_key`s that now hold a row for one of the bags.
 *
 * ⚠ IDEMPOTENCY KEYS ON THE INDEX'S OWN TUPLE `(template_key, recipient_kind,
 * recipient_id, cycle_id)` — not on the BAG, as DP-T3's pre-check did. The two agreed
 * for every bag except a friend holding TWO orders in one cycle (`orders` has no
 * UNIQUE(friend_id, cycle_id)): there the second bag's message IS the first one's, so
 * it is `already`, coherently with the constraint. A `queued` row blocks a new one of
 * any channel (the index does not key on channel); a `skipped` row blocks a second
 * `skipped` to-do (the index does not cover it, so this pre-check is the only guard —
 * without it a hand → un-hand → hand loop on a number-less friend would stack to-dos,
 * because the reversal deletes `queued` rows only) but NOT a `queued` row: a friend who
 * has since entered a number gets the message. A `released`/`sent`/`failed` row
 * blocks nothing — a genuine re-hand-over after a reversal is a new event.
 * The pre-check runs first; the constraint, should it fire anyway, is counted as
 * `already` and NEVER thrown: a throw would roll back the stamp around it and 500 the
 * admin's button (SQLite aborts only the failing STATEMENT, so the transaction goes on).
 *
 * `handedOverAt` is accepted for §UC-WA-006's signature and NOT used for the key: each
 * row's group comes from its OWN stored `handed_over_at` (`handOverRecipients()`), the
 * value `buildSegment()` regroups by later. Every caller passes the stamp it just bound,
 * so the two agree — except a late colleague stamped by the bulk route with the HOST
 * BAG's older stamp, where the row's stamp is the truth and the batch's is not.
 */
export function enqueueForHandOver({ cycleId, orderIds = [], guestOrderIds = [], handedOverAt } = {}) {
  const out = { queued: 0, email: 0, skipped: 0, none: 0, already: 0, groups: [] };
  const wantOrders = ids(orderIds);
  const wantGuests = ids(guestOrderIds);
  const requested = wantOrders.length + wantGuests.length;
  if (!Number.isInteger(cycleId) || cycleId <= 0 || requested === 0) {
    out.none = requested;
    return out;
  }

  const entries = handOverRecipients(cycleId, { orderIds: wantOrders, guestOrderIds: wantGuests });
  const existing = db.prepare(`
    SELECT id FROM notifications
     WHERE template_key = ? AND recipient_kind = ? AND recipient_id IS ? AND cycle_id IS ?
       AND status IN ('queued', ?)
     LIMIT 1
  `);
  const insert = db.prepare(`
    INSERT INTO notifications (
      channel, template_key, segment_key, recipient_kind, recipient_id,
      phone_e164, email, body, status, cycle_id, order_id, guest_order_id, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const templates = new Map();
  const templateOf = (key) => {
    if (!templates.has(key)) templates.set(key, getTemplate(key));
    return templates.get(key);
  };
  const groups = new Set();
  let handled = 0;

  for (const entry of entries) {
    handled += 1;
    const template = templateOf(entry.template_key);
    const plan = planRow(template, entry.recipient, { consent: entry.consent });
    if (!plan) { out.none += 1; continue; }

    const r = entry.recipient;
    // `queued` is always a blocker (the index); `skipped` blocks only another `skipped`,
    // so the second status bound is `'skipped'` for a skipped plan and `'queued'` again
    // (a harmless duplicate in the list) otherwise.
    if (existing.get(entry.template_key, r.recipient_kind, r.recipient_id, cycleId, plan.status === 'skipped' ? 'skipped' : 'queued')) {
      out.already += 1;
      groups.add(entry.key);
      continue;
    }
    try {
      insert.run(
        plan.channel, entry.template_key, entry.key, r.recipient_kind, r.recipient_id,
        plan.phone_e164, plan.email, renderTemplate(template.body, r.vars), plan.status,
        cycleId, r.order_id, r.guest_order_id, plan.error
      );
    } catch (e) {
      if (isQueuedOnceConflict(e)) { out.already += 1; groups.add(entry.key); continue; }
      throw e;
    }
    groups.add(entry.key);
    if (plan.status === 'skipped') out.skipped += 1;
    else if (plan.channel === 'email') out.email += 1;
    else out.queued += 1;
  }

  // A requested bag with no entry owes nobody anything (see `handOverRecipients()`).
  out.none += requested - handled;
  out.groups = [...groups];
  return out;
}

/**
 * Un-queue the messages a REVERSED hand-over no longer owes (21 §UC-WA-006).
 *
 *   cancelForUnHandOver({ orderIds, guestOrderIds }) → { deleted, requeued }
 *
 * Called inside the caller's transaction AFTER it cleared the `handed_over_at` stamps.
 * Deletes `status = 'queued'` rows of the three hand-over templates whose `order_id` /
 * `guest_order_id` is one of the ids.
 *
 * ⚠ `queued` ONLY. A `released`, `sent`, `failed` or `skipped` row is HISTORY (§UC-WA-006
 * literal) — somebody was already told, or already not told; the admin resolves those
 * by hand (a `skipped` to-do is the admin's to DELETE, WA-T5).
 *
 * ⚠ OWNERSHIP (the WA-T1 review caveat, closed here): with idempotency keyed on
 * (template, recipient, CYCLE), a friend with TWO handed-over orders in one cycle holds
 * ONE queued row, owned (`order_id`) by whichever bag was handed over first. Deleting it
 * because THAT bag came back would leave the still-handed second bag with no message.
 * So after the delete, every OTHER still-handed order of an affected friend in that
 * cycle is enqueued again through `enqueueForHandOver()` — the same rules, a fresh body
 * and its own key; `requeued` counts the rows that minted. A friend whose orders are
 * all back in hand gets nothing.
 */
export function cancelForUnHandOver({ orderIds = [], guestOrderIds = [] } = {}) {
  const orders = ids(orderIds);
  const guests = ids(guestOrderIds);
  const dropFriend = db.prepare(`
    DELETE FROM notifications
     WHERE status = 'queued' AND template_key IN ('pickup', 'packeta', 'host') AND order_id = ?
     RETURNING recipient_id, cycle_id
  `);
  const dropGuest = db.prepare(`
    DELETE FROM notifications
     WHERE status = 'queued' AND template_key IN ('pickup', 'packeta', 'host') AND guest_order_id = ?
  `);

  let deleted = 0;
  const affected = new Map(); // `${friendId}:${cycleId}` → { friendId, cycleId }
  for (const orderId of orders) {
    for (const row of dropFriend.all(orderId)) {
      deleted += 1;
      if (Number.isInteger(row.recipient_id) && Number.isInteger(row.cycle_id)) {
        affected.set(`${row.recipient_id}:${row.cycle_id}`, { friendId: row.recipient_id, cycleId: row.cycle_id });
      }
    }
  }
  for (const guestOrderId of guests) deleted += dropGuest.run(guestOrderId).changes;

  let requeued = 0;
  if (affected.size > 0) {
    const survivors = db.prepare(`
      SELECT id FROM orders
       WHERE friend_id = ? AND cycle_id = ? AND status = 'submitted' AND handed_over_at IS NOT NULL
       ORDER BY id
    `);
    for (const { friendId, cycleId } of affected.values()) {
      const still = survivors.all(friendId, cycleId).map((row) => row.id).filter((id) => !orders.includes(id));
      if (still.length === 0) continue;
      const again = enqueueForHandOver({ cycleId, orderIds: still });
      requeued += again.queued + again.email + again.skipped;
    }
  }
  return { deleted, requeued };
}
