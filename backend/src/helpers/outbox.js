import db from '../db/schema.js';
import { buildSegment, handOverRecipients, parseSegmentKey, segmentTemplateKey } from './segments.js';
import { getTemplate } from './templates.js';
import { renderTemplate, unresolvedFor } from './template-render.js';
import { scanPlaceholders, unresolvedColumn } from './outbox-scan.js';
// 21 Decision D8: the release stamps `guest_waitlist.notified_at` — through module 19's
// one writer of that table, never a statement of its own here.
import { markWaitlistNotified } from './guest-waitlist.js';
// The ONE home of „is this an e-mail address" (CLAUDE.md `storedEmailUsable()` rule), and
// (WA-T6) the mailer itself: `sendMail` + module 08's `renderEmail` are called ONLY by
// `handOffEmailRows()` at the bottom of this file — the post-commit seam the release and
// the retry call (21 §UC-WA-010). The enqueue / compose / rerender paths never send.
import { EMAIL_SHAPE, sendMail } from './mailer.js';
import { renderEmail } from './email-templates.js';

// ⚠ THE ONE AND ONLY WRITER OF `notifications` (DP-T3, 16 §UC-DP-008; module 21's
// writers join HERE — WA-T4 §UC-WA-006, and WA-T5's compose / release / retry /
// rerender / per-row edits at the bottom of this file. `db/schema.js`'s boot
// migrations — the WA-T4 re-key and the WA-T5 `unresolved` back-fill — are the only
// other statements, and they run before any route exists).
//
// It records WHICH template is owed to WHOM about WHICH bag, at the moment the bag
// leaves the admin's hands, renders the text and snapshots the address. The ENQUEUE
// SENDS NOTHING — there is no outbound call and no WhatsApp import (01-architecture: „the
// API never sends"). ~~the only mailer import is the `EMAIL_SHAPE` constant~~ → WA-T6:
// `sendMail`/`renderEmail` are imported too, and called ONLY by `handOffEmailRows()` —
// the e-mail rows are handed to the mailer AFTER the release / retry commits (21
// §UC-WA-010, the one place the API sends a notification itself).
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
  const minted = mintEntries(entries, cycleId);
  out.queued = minted.queued;
  out.email = minted.email;
  out.skipped = minted.skipped;
  out.already = minted.already;
  // A requested bag with no entry owes nobody anything (see `handOverRecipients()`).
  out.none = minted.none + (requested - entries.length);
  out.groups = [...minted.groups];
  return out;
}

/**
 * THE ONE INSERT PATH of a rendered row — shared by the hand-over enqueue (WA-T4) and
 * the composer's compose (WA-T5), so §UC-WA-006's per-recipient rules, the idempotency
 * pre-check and the constraint translation exist ONCE.
 *
 *   mintEntries(entries, cycleId) → { queued, email, skipped, none, already, groups:Set }
 *
 * `entries` = `[{ key, template_key, consent, recipient }]` (the `handOverRecipients()` /
 * `buildSegment()` shape); `cycleId` = the rows' `cycle_id` (NULL for `all_active`).
 * Each entry lands in exactly ONE count. Every row carries `body = renderTemplate()` AND
 * `unresolved = unresolvedFor()` — computed from the SAME template + vars, never by
 * rescanning the rendered text (a guest named „{suma}" must not block a group,
 * learnings 15 §WA-T2).
 *
 * ⚠ IDEMPOTENCY (see `enqueueForHandOver`): the pre-check keys on the index's own tuple
 * with `cycle_id IS ?` — which is also the ONLY guard for `all_active` rows: their
 * `cycle_id` is NULL and a SQLite unique index treats NULLs as distinct, so the partial
 * index never fires for them. Synchronous ⇒ the check and the INSERT cannot interleave.
 */
function mintEntries(entries, cycleId) {
  const out = { queued: 0, email: 0, skipped: 0, none: 0, already: 0, groups: new Set() };
  const existing = db.prepare(`
    SELECT id FROM notifications
     WHERE template_key = ? AND recipient_kind = ? AND recipient_id IS ? AND cycle_id IS ?
       AND status IN ('queued', ?)
     LIMIT 1
  `);
  const insert = db.prepare(`
    INSERT INTO notifications (
      channel, template_key, segment_key, recipient_kind, recipient_id,
      phone_e164, email, body, unresolved, status, cycle_id, order_id, guest_order_id, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const templates = new Map();
  const templateOf = (key) => {
    if (!templates.has(key)) templates.set(key, getTemplate(key));
    return templates.get(key);
  };

  for (const entry of entries) {
    const template = templateOf(entry.template_key);
    const plan = planRow(template, entry.recipient, { consent: entry.consent });
    if (!plan) { out.none += 1; continue; }

    const r = entry.recipient;
    // `queued` is always a blocker (the index); `skipped` blocks only another `skipped`,
    // so the second status bound is `'skipped'` for a skipped plan and `'queued'` again
    // (a harmless duplicate in the list) otherwise.
    if (existing.get(entry.template_key, r.recipient_kind, r.recipient_id, cycleId ?? null, plan.status === 'skipped' ? 'skipped' : 'queued')) {
      out.already += 1;
      out.groups.add(entry.key);
      continue;
    }
    try {
      insert.run(
        plan.channel, entry.template_key, entry.key, r.recipient_kind, r.recipient_id,
        plan.phone_e164, plan.email, renderTemplate(template.body, r.vars),
        unresolvedColumn(unresolvedFor(template.body, r.vars)), plan.status,
        cycleId ?? null, r.order_id, r.guest_order_id, plan.error
      );
    } catch (e) {
      if (isQueuedOnceConflict(e)) { out.already += 1; out.groups.add(entry.key); continue; }
      throw e;
    }
    out.groups.add(entry.key);
    if (plan.status === 'skipped') out.skipped += 1;
    else if (plan.channel === 'email') out.email += 1;
    else out.queued += 1;
  }
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

// ═════════════════════════════════════════════════════════════════════════════
// WA-T5 — the ADMIN's write surface over the outbox (21 §UC-WA-008, §UC-WA-007's
// compose + release). `routes/notifications.js` validates the request and calls ONE of
// these; every statement that writes `notifications` stays in this file.
//
//   composeSegment({ cycleId, segmentKey, baseUrl })   computed segment → rows
//   releaseGroup({ cycleId, segmentKey })               THE `queued → released`
//   retryGroup({ cycleId, segmentKey })                 `failed → released`
//   rerenderGroup({ cycleId, segmentKey, baseUrl })     queued rows ← current template
//   editRowBody(id, body)                               one queued row's text
//   markManualSent(id, fromStatuses)                    the wa.me tick (sync half)
//   deleteRow(id)                                       a queued/skipped row
//   composeWaitlistOnOpen(cycleId, { baseUrl })         PO 2026-09-19 auto-compose
//   handOffEmailRows(ids)                               WA-T6: the post-commit e-mail send
//   sweepInterruptedEmailRows()                         WA-T6 review: the boot sweep (index.js)
//
// ⚠ ALL SYNCHRONOUS (GA-T8). The only `await` on this surface is the manual tick's
// health fetch, and it lives in the ROUTE, BEFORE `markManualSent()` — whose
// conditional `UPDATE … WHERE status IN (…)` closes the check-then-write gap the await
// opens.
//
// ⚠ A NOTIFICATION IS NOT A FINANCIAL EVENT: none of these touches `transactions`,
// `orders`, `guest_orders` money columns, `handed_over_at` or a cycle's status.
// ═════════════════════════════════════════════════════════════════════════════

// The three kinds the COMPOSER builds (21 §UC-WA-005 „built by: composer"). The three
// hand-over kinds are built by the hook only: composing one would be a back door that
// back-fills a hand-over whose template was disabled at the time (§UC-WA-004: „enabling
// it later does not back-fill yesterday's hand-overs").
export const COMPOSABLE_KINDS = Object.freeze(['not_ordered', 'waitlist', 'all_active']);
const OPEN_ONLY_KINDS = Object.freeze(['not_ordered', 'waitlist']);

// The rows of ONE group: `(segment_key, cycle_id)`; `all_active` is cycle-less.
function groupWhere(segmentKey, cycleId, alias = '') {
  const a = alias ? `${alias}.` : '';
  return segmentKey === 'all_active'
    ? { sql: `${a}segment_key = 'all_active' AND ${a}cycle_id IS NULL`, params: [] }
    : { sql: `${a}segment_key = ? AND ${a}cycle_id = ?`, params: [segmentKey, cycleId] };
}

const STATUSES = Object.freeze(['queued', 'released', 'sent', 'failed', 'skipped']);

/** Per-status counts of one group, READ BACK from the table (`total` included). */
export function groupCounts(segmentKey, cycleId) {
  const where = groupWhere(segmentKey, cycleId);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const row of db.prepare(`SELECT status, COUNT(*) AS n FROM notifications WHERE ${where.sql} GROUP BY status`).all(...where.params)) {
    if (Object.prototype.hasOwnProperty.call(counts, row.status)) counts[row.status] += row.n;
    total += row.n;
  }
  return { ...counts, total };
}

// The template's own refusals, shared by compose and rerender: off ⇒ inert (§UC-WA-004),
// blank ⇒ nothing to send (`custom` ships EMPTY, D3 — the admin writes the text first).
function templateRefusal(template) {
  if (!template || !template.enabled) return 'template_disabled';
  if (typeof template.body !== 'string' || !template.body.trim()) return 'template_empty';
  return null;
}

const entriesOf = (segment) => [
  ...segment.recipients.map((recipient) => ({ key: segment.key, template_key: segment.template_key, consent: true, recipient })),
  ...segment.opted_out.map((recipient) => ({ key: segment.key, template_key: segment.template_key, consent: false, recipient })),
];

/**
 * `POST /compose` (21 §UC-WA-008): build a COMPUTED segment and mint its rows through
 * §UC-WA-006's per-recipient rules (`planRow()`, via `mintEntries()`). Idempotent:
 * already-queued recipients are counted (`already`), never duplicated.
 *
 * ⇒ `{ refused: reason }` — `unknown_segment` / `not_composable` / `template_disabled` /
 *    `template_empty` / `cycle_not_open` — nothing written; or
 * ⇒ `{ segment_key, cycle_id, template_key, queued, email, skipped, none, already }`.
 *
 * The opted-out half (`segment.opted_out`) is planned with `consent: false`, so an
 * opted-out friend gets NOTHING for `closing`/`custom` and a waitlist row with
 * `whatsapp_opt_in = 0` gets nothing at all (D5 covers only the three operational
 * templates) — it still counts in `none`. A waitlist row without a number becomes the
 * `skipped`/`no_phone` to-do (§UC-WA-007: waitlist rows have no e-mail).
 */
export function composeSegment({ cycleId, segmentKey, baseUrl } = {}) {
  const parsed = parseSegmentKey(segmentKey);
  if (!parsed) return { refused: 'unknown_segment' };
  if (!COMPOSABLE_KINDS.includes(parsed.kind)) return { refused: 'not_composable' };
  const template = getTemplate(segmentTemplateKey(segmentKey));
  const refusal = templateRefusal(template);
  if (refusal) return { refused: refusal };
  if (OPEN_ONLY_KINDS.includes(parsed.kind)) {
    const cycle = db.prepare('SELECT status FROM order_cycles WHERE id = ?').get(parsed.cycleId);
    if (!cycle) return { refused: 'unknown_segment' };
    if (cycle.status !== 'open') return { refused: 'cycle_not_open' };
  }
  const segment = buildSegment(cycleId, segmentKey, { baseUrl });
  if (!segment) return { refused: 'unknown_segment' };

  const minted = db.transaction(() => mintEntries(entriesOf(segment), segment.cycle_id))();
  return {
    segment_key: segment.key,
    cycle_id: segment.cycle_id,
    template_key: segment.template_key,
    queued: minted.queued,
    email: minted.email,
    skipped: minted.skipped,
    none: minted.none,
    already: minted.already,
  };
}

/**
 * PO 2026-09-19 — „Waitlist on round open = auto-COMPOSE (never auto-release)". Called by
 * the cycle routes on the transition INTO `open`, inside their transaction. The SAME
 * code path as `POST /compose` for `waitlist:<cycleId>`; SILENT: a disabled / blank
 * template or an empty waitlist is a no-op, and a throw is logged and swallowed — it
 * runs in its own SAVEPOINT (a nested `db.transaction`), so a failure rolls back only
 * its own rows and never the status write around it. Returns the compose result or null.
 */
export function composeWaitlistOnOpen(cycleId, { baseUrl } = {}) {
  if (!Number.isInteger(cycleId) || cycleId <= 0) return null;
  try {
    return db.transaction(() => {
      const result = composeSegment({ cycleId, segmentKey: `waitlist:${cycleId}`, baseUrl });
      return result.refused ? null : result;
    })();
  } catch (e) {
    console.error(`[outbox] waitlist auto-compose failed for cycle ${cycleId}: ${String(e?.message || e).slice(0, 200)}`);
    return null;
  }
}

// Is this row sendable as it stands? A NULL / blank body (DP-T3's legacy rows, a blanked
// template), a NULL `unresolved` (never computed — pre-WA-T5) or a non-empty / unreadable
// one ⇒ NO. Release refuses the whole group while any such row is selected.
function releasable(row) {
  if (typeof row.body !== 'string' || !row.body.trim()) return false;
  if (typeof row.unresolved !== 'string') return false;
  try {
    const list = JSON.parse(row.unresolved);
    return Array.isArray(list) && list.length === 0;
  } catch (e) {
    return false;
  }
}

const nowStamp = () => db.prepare('SELECT CURRENT_TIMESTAMP AS now').get().now;

// Rows whose `guest_order_id` names a CANCELLED sub-order (the DP-T3 seam's release-time
// defence, orchestrator decision 2): never sent, moved to `skipped`/`cancelled`.
function cancelledGuest(row) {
  return row.guest_order_id !== null && row.guest_status === 'cancelled';
}

/**
 * `POST /release` (21 §UC-WA-008) — THE ONE `queued → released` TRANSITION.
 *
 *   • Selects the group's `queued` rows; none ⇒ `{ released: 0, … }` (a double-click is
 *     harmless — the „one Poslať per group" of Q5.d).
 *   • ALL-OR-NOTHING: any selected row that is not `releasable()` (NULL/blank body, NULL or
 *     non-empty `unresolved`) ⇒ `{ refused: 'unresolved_placeholders', ids }` and NOTHING
 *     is written. Rows about a cancelled sub-order are not part of that check — they are
 *     never sent anyway.
 *   • WAITLIST rows (WA-T5 review): a row whose `guest_waitlist` row is gone (purged on
 *     order / admin-deleted), already `notified_at` (told in another round — the partial
 *     index keys on `cycle_id`, so two rounds can each hold one), or no longer in the
 *     segment (host inactive, consent withdrawn) ⇒ `skipped`, `error = 'not_waiting'`,
 *     outside the gate. The rest are RE-RENDERED in this transaction (the standing link
 *     may have rotated since compose — never send a revoked token); an `{odkaz}` the host
 *     no longer has blocks like any other literal. NOT in `retryGroup()` (a failed
 *     waitlist row was stamped by its own release).
 *   • Otherwise ONE transaction, ONE timestamp: rows about a cancelled sub-order ⇒
 *     `skipped`, `error = 'cancelled'` (not a 409 — orchestrator decision 2); the rest ⇒
 *     `released`, `released_at = now`; `waitlist` rows ⇒ `guest_waitlist.notified_at =
 *     now` (D8, via `markWaitlistNotified()`).
 *   • AFTER the commit: the released `email` rows go to `handOffEmailRows()` (WA-T6).
 *
 * No cycle-status gate (hand-over groups are released while the cycle is `locked`), no
 * `whatsapp_paused` gate (a paused bot just leaves rows `released`). A NON-waitlist body
 * is NOT re-rendered here: the admin releases the text the admin reviewed — a stale
 * `{suma}` (a payment between hand-over and release) is refreshed by the explicit
 * rerender door. (A waitlist row's per-row body edit IS overwritten by the release's
 * re-render — the link must be current.)
 *
 * ⇒ `{ released, whatsapp, email, skipped }` (`skipped` = rows moved to `cancelled`).
 */
export function releaseGroup({ cycleId, segmentKey, baseUrl } = {}) {
  const where = groupWhere(segmentKey, cycleId, 'n');
  const outcome = db.transaction(() => {
    const rows = db.prepare(`
      SELECT n.id, n.channel, n.template_key, n.body, n.unresolved, n.recipient_kind, n.recipient_id,
             n.guest_order_id, g.status AS guest_status, w.id AS waitlist_id, w.notified_at AS waitlist_notified_at
        FROM notifications n
        LEFT JOIN guest_orders g ON n.guest_order_id IS NOT NULL AND g.id = n.guest_order_id
        LEFT JOIN guest_waitlist w ON n.recipient_kind = 'waitlist' AND w.id = n.recipient_id
       WHERE n.status = 'queued' AND ${where.sql}
       ORDER BY n.id
    `).all(...where.params);

    // The rows that are never sent, OUTSIDE the all-or-nothing gate (each with its reason).
    const waitlistNow = waitlistRecipients(rows, cycleId, segmentKey, baseUrl);
    const skips = [];
    const live = [];
    for (const row of rows) {
      if (cancelledGuest(row)) { skips.push([row.id, 'cancelled']); continue; }
      if (row.recipient_kind === 'waitlist') {
        const entry = waitlistNow.get(row.recipient_id);
        // Purged on order / admin-deleted (`w.id IS NULL`), already told in ANOTHER round
        // (`notified_at` set — the partial index keys on `cycle_id`, so two rounds may each
        // hold a queued row), or no longer in the segment (host deactivated, consent
        // withdrawn on a re-signup) ⇒ the person is not waiting for THIS message.
        if (row.waitlist_id === null || row.waitlist_notified_at !== null || !entry || !entry.consent) {
          skips.push([row.id, 'not_waiting']);
          continue;
        }
        // ⚠ RE-RENDERED HERE (orchestrator WA-T5 review): the body carries the host's
        // STANDING link, and a rotation between compose and release would otherwise send a
        // revoked token. No money vars, so this is cheap and changes nothing else; an
        // `{odkaz}` the host no longer has stays literal and blocks the group as usual.
        const template = getTemplate(row.template_key);
        if (template) {
          row.body = renderTemplate(template.body, entry.recipient.vars);
          row.unresolved = unresolvedColumn(unresolvedFor(template.body, entry.recipient.vars));
          row.rerendered = true;
        }
      }
      live.push(row);
    }
    const blocked = live.filter((row) => !releasable(row)).map((row) => row.id);
    if (blocked.length > 0) return { refused: 'unresolved_placeholders', ids: blocked };

    const now = nowStamp();
    const skip = db.prepare(
      "UPDATE notifications SET status = 'skipped', error = ? WHERE id = ? AND status = 'queued'"
    );
    const release = db.prepare(
      "UPDATE notifications SET status = 'released', released_at = ? WHERE id = ? AND status = 'queued'"
    );
    const releaseRendered = db.prepare(
      "UPDATE notifications SET status = 'released', released_at = ?, body = ?, unresolved = ? WHERE id = ? AND status = 'queued'"
    );
    let skipped = 0;
    for (const [id, reason] of skips) skipped += skip.run(reason, id).changes;
    const out = { released: 0, whatsapp: 0, email: 0, skipped, emailIds: [], waitlistIds: [] };
    for (const row of live) {
      const changed = row.rerendered
        ? releaseRendered.run(now, row.body, row.unresolved, row.id).changes
        : release.run(now, row.id).changes;
      if (changed !== 1) continue;
      out.released += 1;
      if (row.channel === 'email') { out.email += 1; out.emailIds.push(row.id); } else out.whatsapp += 1;
      if (row.recipient_kind === 'waitlist') out.waitlistIds.push(row.recipient_id);
    }
    markWaitlistNotified(out.waitlistIds, now);
    return out;
  })();
  if (outcome.refused) return outcome;
  handOffEmailRows(outcome.emailIds);
  return { released: outcome.released, whatsapp: outcome.whatsapp, email: outcome.email, skipped: outcome.skipped };
}

// The CURRENT waitlist segment's entries by `guest_waitlist.id` (consenting + opted-out,
// `{ consent, recipient }`), built once — only when the group holds waitlist rows and is a
// `waitlist:<cycle>` group. Empty map otherwise.
function waitlistRecipients(rows, cycleId, segmentKey, baseUrl) {
  const map = new Map();
  if (!rows.some((row) => row.recipient_kind === 'waitlist')) return map;
  if (parseSegmentKey(segmentKey)?.kind !== 'waitlist') return map;
  const segment = buildSegment(cycleId, segmentKey, { baseUrl });
  if (!segment) return map;
  for (const entry of entriesOf(segment)) map.set(entry.recipient.recipient_id, entry);
  return map;
}

/**
 * `POST /retry` (21 §UC-WA-008): the group's `failed` rows ⇒ `released`, `released_at`
 * refreshed, `error` KEPT until the sender overwrites it. 0 is fine. The same
 * cancelled-sub-order defence as the release (⇒ `skipped`/`cancelled`, never re-sent),
 * and the same post-commit e-mail hand-off. ⇒ `{ released, whatsapp, email, skipped }`.
 */
export function retryGroup({ cycleId, segmentKey } = {}) {
  const where = groupWhere(segmentKey, cycleId, 'n');
  const outcome = db.transaction(() => {
    const rows = db.prepare(`
      SELECT n.id, n.channel, n.guest_order_id, g.status AS guest_status
        FROM notifications n
        LEFT JOIN guest_orders g ON n.guest_order_id IS NOT NULL AND g.id = n.guest_order_id
       WHERE n.status = 'failed' AND ${where.sql}
       ORDER BY n.id
    `).all(...where.params);
    const now = nowStamp();
    const skip = db.prepare(
      "UPDATE notifications SET status = 'skipped', error = 'cancelled' WHERE id = ? AND status = 'failed'"
    );
    const release = db.prepare(
      "UPDATE notifications SET status = 'released', released_at = ? WHERE id = ? AND status = 'failed'"
    );
    const out = { released: 0, whatsapp: 0, email: 0, skipped: 0, emailIds: [] };
    for (const row of rows) {
      if (cancelledGuest(row)) { out.skipped += skip.run(row.id).changes; continue; }
      if (release.run(now, row.id).changes !== 1) continue;
      out.released += 1;
      if (row.channel === 'email') { out.email += 1; out.emailIds.push(row.id); } else out.whatsapp += 1;
    }
    return out;
  })();
  handOffEmailRows(outcome.emailIds);
  return { released: outcome.released, whatsapp: outcome.whatsapp, email: outcome.email, skipped: outcome.skipped };
}

/**
 * `POST /rerender` (21 §UC-WA-004 „Prepísať texty vo fronte"): re-render the group's
 * `queued` rows from the CURRENT template and the recipient AS THEY ARE NOW.
 *
 *   • The recipient comes from `buildSegment()` (consenting half + `opted_out`), matched
 *     by `(recipient_kind, recipient_id)`; the row's OWN `template_key` is rendered.
 *   • Refreshed per row, in ONE literal UPDATE: `body`, `unresolved`, `phone_e164`,
 *     `email` AND `channel` — re-planned by `planRow()` (a friend who entered a number
 *     since moves from the e-mail fallback to WhatsApp, and back). This is the door that
 *     repairs DP-T3's NULL-body legacy rows and a `{suma}` frozen before a payment.
 *   • A row is left UNCHANGED (its id in `unchanged`) when its recipient is no longer in
 *     the segment (un-handed, cancelled, ordered meanwhile, notified, deactivated — or a
 *     key that is no segment, like the re-key's `legacy_handover:…`), or when the plan is
 *     no longer a QUEUED row (the number/e-mail/consent is gone — the row stays for the
 *     admin to DELETE; a rerender never changes a status).
 *   • NEVER touches `released`/`sent`/`failed`/`skipped` rows, and NEVER `segment_key`:
 *     the grouping FREEZES at enqueue (DP-T3/FUP-T23 — a dangling `loc<id>` keeps its
 *     group and loses only its label; a party re-pointed after its hand-over is re-found
 *     only if its new key is this one, else it is `unchanged`).
 *
 * ⇒ `{ refused }` (`template_disabled` / `template_empty`, nothing written) or
 * ⇒ `{ rerendered, unchanged: [ids] }`.
 */
export function rerenderGroup({ cycleId, segmentKey, baseUrl } = {}) {
  const templateKey = segmentTemplateKey(segmentKey);
  if (templateKey) {
    const refusal = templateRefusal(getTemplate(templateKey));
    if (refusal) return { refused: refusal };
  }
  const segment = templateKey ? buildSegment(cycleId, segmentKey, { baseUrl }) : null;
  const byRecipient = new Map();
  if (segment) {
    for (const entry of entriesOf(segment)) {
      byRecipient.set(`${entry.recipient.recipient_kind}:${entry.recipient.recipient_id}`, entry);
    }
  }
  const where = groupWhere(segmentKey, cycleId);
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, template_key, recipient_kind, recipient_id FROM notifications
       WHERE status = 'queued' AND ${where.sql} ORDER BY id
    `).all(...where.params);
    const update = db.prepare(`
      UPDATE notifications
         SET channel = ?, phone_e164 = ?, email = ?, body = ?, unresolved = ?
       WHERE id = ? AND status = 'queued'
    `);
    const templates = new Map();
    const templateOf = (key) => {
      if (!templates.has(key)) templates.set(key, getTemplate(key));
      return templates.get(key);
    };
    const out = { rerendered: 0, unchanged: [] };
    for (const row of rows) {
      const entry = byRecipient.get(`${row.recipient_kind}:${row.recipient_id}`);
      const template = templateOf(row.template_key);
      const plan = entry && template && !templateRefusal(template)
        ? planRow(template, entry.recipient, { consent: entry.consent })
        : null;
      if (!plan || plan.status !== 'queued') { out.unchanged.push(row.id); continue; }
      const changed = update.run(
        plan.channel, plan.phone_e164, plan.email,
        renderTemplate(template.body, entry.recipient.vars),
        unresolvedColumn(unresolvedFor(template.body, entry.recipient.vars)),
        row.id
      ).changes;
      if (changed === 1) out.rerendered += 1; else out.unchanged.push(row.id);
    }
    return out;
  })();
}

/**
 * `PATCH /:id/body` (21 §UC-WA-008): the admin's text for ONE `queued` row. There is no
 * template + vars for an admin's own words, so `unresolved` is the RESCAN of the new body
 * (`outbox-scan.js` — can only over-block). ⇒ `{ refused: 'not_found' | 'not_queued' }`
 * or `{ ok: true }`.
 */
export function editRowBody(id, body) {
  return db.transaction(() => {
    const row = db.prepare('SELECT status FROM notifications WHERE id = ?').get(id);
    if (!row) return { refused: 'not_found' };
    if (row.status !== 'queued') return { refused: 'not_queued' };
    const changed = db.prepare(
      "UPDATE notifications SET body = ?, unresolved = ? WHERE id = ? AND status = 'queued'"
    ).run(body, unresolvedColumn(scanPlaceholders(body)), id).changes;
    return changed === 1 ? { ok: true } : { refused: 'not_queued' };
  })();
}

/**
 * The SYNCHRONOUS half of `PATCH /:id/manual-sent` (the wa.me tick): `status = 'sent'`,
 * `sent_at = now`, `sent_via = 'wa_me'` — ONLY while the row is still in one of
 * `fromStatuses` (the route passes `['queued']` or, after its health await, `['released']`;
 * the WHERE re-asserts it, so a row the bot sent during the await is not overwritten).
 * A waitlist row ticked straight from `queued` was never released, so its D8 stamp
 * happens HERE (otherwise the next compose would message the person again).
 * A queued WAITLIST row whose person is no longer waiting (purged / deleted / notified in
 * another round) is moved to `skipped`/`not_waiting` and refused `not_waiting`.
 * ⇒ `{ refused: 'not_found' | 'not_pending' | 'not_waiting' }` or `{ ok: true }`.
 */
export function markManualSent(id, fromStatuses) {
  const allowed = (Array.isArray(fromStatuses) ? fromStatuses : []).filter((s) => s === 'queued' || s === 'released');
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT n.status, n.recipient_kind, n.recipient_id, w.id AS waitlist_id, w.notified_at AS waitlist_notified_at
        FROM notifications n
        LEFT JOIN guest_waitlist w ON n.recipient_kind = 'waitlist' AND w.id = n.recipient_id
       WHERE n.id = ?
    `).get(id);
    if (!row) return { refused: 'not_found' };
    if (!allowed.includes(row.status)) return { refused: 'not_pending' };
    // The release's waitlist defence, on the tick of a still-QUEUED row: a person purged /
    // deleted or already told in another round is not waiting — the row becomes the
    // `skipped`/`not_waiting` record and the tick is refused.
    if (row.status === 'queued' && row.recipient_kind === 'waitlist'
      && (row.waitlist_id === null || row.waitlist_notified_at !== null)) {
      db.prepare("UPDATE notifications SET status = 'skipped', error = 'not_waiting' WHERE id = ? AND status = 'queued'").run(id);
      return { refused: 'not_waiting' };
    }
    const now = nowStamp();
    const changed = db.prepare(
      "UPDATE notifications SET status = 'sent', sent_at = ?, sent_via = 'wa_me' WHERE id = ? AND status = ?"
    ).run(now, id, row.status).changes;
    if (changed !== 1) return { refused: 'not_pending' };
    if (row.status === 'queued' && row.recipient_kind === 'waitlist') markWaitlistNotified([row.recipient_id], now);
    return { ok: true };
  })();
}

/**
 * `DELETE /:id` (21 §UC-WA-008): the admin decides not to message someone — a `queued`
 * row or a `skipped` to-do. `released`/`sent`/`failed` are history ⇒ `not_queued`.
 * ⇒ `{ refused: 'not_found' | 'not_queued' }` or `{ deleted: true }`.
 */
export function deleteRow(id) {
  return db.transaction(() => {
    const row = db.prepare('SELECT status FROM notifications WHERE id = ?').get(id);
    if (!row) return { refused: 'not_found' };
    if (row.status !== 'queued' && row.status !== 'skipped') return { refused: 'not_queued' };
    const changed = db.prepare(
      "DELETE FROM notifications WHERE id = ? AND status IN ('queued', 'skipped')"
    ).run(id).changes;
    return changed === 1 ? { deleted: true } : { refused: 'not_queued' };
  })();
}

// ═════════════════════════════════════════════════════════════════════════════
// WA-T6 — the e-mail fallback `channel = 'email'` (21 §UC-WA-010, R5.8 + D5).
//
// ⚠ THE ONE PLACE THE API PROCESS SENDS A NOTIFICATION ITSELF — because the mailer lives
// in the API (01-architecture §Shared services); „the API never sends" is a WHATSAPP
// rule, and a WhatsApp row is never handed to anything here (the SELECT below re-asserts
// `channel = 'email'`). Module 08's seam, verbatim: `renderEmail()` → `sendMail()`; this
// file adds no transport, no HTML and no link of its own (the body is ONE paragraph
// block; 08's shell, escaping and per-message tracking-off flags do the rest).
// ═════════════════════════════════════════════════════════════════════════════

const EMAIL_SUBJECT_BRAND = 'Podpultovka';

/**
 * The subject of a notification e-mail: „Podpultovka · {template name}“ (21 §UC-WA-010,
 * e.g. „Podpultovka · Doručené na odberné miesto“). The name is read at SEND time from
 * `getTemplate()` (fail-quiet: a corrupt row reads as its seed). A key outside the six —
 * the §UC-WA-012 `'test'` message, a stray key — has no name, so the subject is the brand
 * ALONE: no invented Slovak copy (the `test` row is a WhatsApp row anyway).
 */
export function emailSubject(templateKey) {
  const name = getTemplate(templateKey)?.name;
  return typeof name === 'string' && name.trim() ? `${EMAIL_SUBJECT_BRAND} · ${name}` : EMAIL_SUBJECT_BRAND;
}

// The mailer's FIXED result vocabulary (`helpers/mailer.js` header) plus this file's own
// `render`. Anything else — which the mailer never returns — is stored as `unknown`, so
// `notifications.error` can never carry server text, let alone the API key (the mailer's
// rule 2, enforced a second time at the column).
const EMAIL_RESULT_CODE = /^(?:no_recipient|not_configured|invalid_recipient|timeout|network|HTTP [1-5]\d{2})$/;

/** `sendMail()`'s result ⇒ the `error` code a `failed` row stores. Never throws. */
export function emailResultError(result) {
  const code = result && typeof result === 'object' ? (result.error ?? result.skipped) : undefined;
  return typeof code === 'string' && EMAIL_RESULT_CODE.test(code) ? code : 'unknown';
}

// The conditional result writes (§UC-WA-010): `WHERE status = 'released'` — the manual
// wa.me tick may have finalised the row while the send was in flight, and whoever writes
// second affects 0 rows. A success CLEARS `error` (a retried row keeps its old code until
// the sender overwrites it — WA-T5 decision 9 — and a `sent` row must not read as a
// failure in the composer).
// `code` (a failure only) is either `emailResultError(result)` or one of this file's OWN
// two codes: `render` (a `renderEmail` throw) and `interrupted` (the boot sweep below).
function writeEmailResult(id, result, code = emailResultError(result)) {
  const changed = result && result.sent === true
    ? db.prepare(
      "UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP, sent_via = 'email', error = NULL WHERE id = ? AND status = 'released'"
    ).run(id).changes
    : db.prepare(
      "UPDATE notifications SET status = 'failed', error = ? WHERE id = ? AND status = 'released'"
    ).run(code, id).changes;
  if (changed === 0) console.log(`[outbox] email result for already-final row id=${id}`);
}

// One row: render + send, fire-and-forget. NOTHING escapes: a `renderEmail` throw (a
// blank body — the release gate refuses one, so only a direct call can get here with it)
// is the row's `failed`/`render`; a throw inside the `.then` write (a DB fault) is
// logged by the `.catch`. Log lines carry the row id and a bounded message — never the
// body, the address or anything from the mailer beyond its fixed code.
function sendEmailRow(row) {
  try {
    const { text, html } = renderEmail({ text: row.body, blocks: [{ type: 'paragraph', text: row.body }] });
    sendMail({ to: row.email, subject: emailSubject(row.template_key), text, html })
      .then((result) => writeEmailResult(row.id, result))
      .catch((e) => {
        console.error(`[outbox] email result write failed for row id=${row.id}: ${String(e?.message || e).slice(0, 200)}`);
      });
  } catch (e) {
    console.error(`[outbox] email for row id=${row.id} could not be rendered: ${String(e?.message || e).slice(0, 200)}`);
    try {
      writeEmailResult(row.id, null, 'render');
    } catch (writeError) {
      console.error(`[outbox] email render failure not recorded for row id=${row.id}: ${String(writeError?.message || writeError).slice(0, 200)}`);
    }
  }
}

/**
 * ⚠ THE POST-COMMIT E-MAIL HAND-OFF (21 §UC-WA-010) — called by `releaseGroup()` and
 * `retryGroup()` AFTER their transaction committed (the `routes/magic-link.js`
 * fire-and-forget precedent), with the ids of the `email` rows they just moved to
 * `released`.
 *
 *   handOffEmailRows(ids) → the number of rows handed to the mailer
 *
 *   • The caller's list is NOT trusted: each id is RE-READ and sent only while the row is
 *     `channel = 'email' AND status = 'released'` (a WhatsApp row, a queued / sent /
 *     failed row, a vanished id or a non-integer is skipped silently; duplicates count
 *     once). The re-read is synchronous, so under `instances: 1` nothing interleaves
 *     between the commit and it.
 *   • Each send is fire-and-forget: the route answers with the rows `released`, and the
 *     `.then` moves each to `sent`/`email` or `failed`/<code> (`writeEmailResult`). With
 *     no Mailgun env the mailer answers `not_configured` and the row is `failed` /
 *     `not_configured` — visible in the composer, never a silent success.
 *   • A RETRY re-sends through this same door (`failed → released → here`).
 *   • ⚠ A row whose send is in flight when the process stops would stay `released`
 *     forever (retry takes `failed` rows only, rerender `queued` only, DELETE refuses a
 *     released row). ~~nothing re-drives it; the admin can tick it by hand~~ → (WA-T6
 *     review) the recovery path is `sweepInterruptedEmailRows()` below, run ONCE at API
 *     boot (`index.js`): every `released` e-mail row ⇒ `failed`/`interrupted`, which the
 *     composer's retry then re-sends. The hand tick (`PATCH /:id/manual-sent`) is a second
 *     door: an e-mail row is exempt from its `bot_active` guard (the WA process never
 *     drains e-mail rows, 21 §UC-WA-011 step 1). Learnings 15 §WA-T6 decision 5.
 *   • NEVER THROWS into the route, and never an unhandled rejection.
 */
export function handOffEmailRows(rowIds) {
  const wanted = ids(rowIds);
  if (wanted.length === 0) return 0;
  let handed = 0;
  try {
    const read = db.prepare(`
      SELECT id, email, body, template_key FROM notifications
       WHERE id = ? AND channel = 'email' AND status = 'released'
    `);
    const rows = wanted.map((id) => read.get(id)).filter(Boolean);
    for (const row of rows) {
      sendEmailRow(row);
      handed += 1;
    }
  } catch (e) {
    console.error(`[outbox] email hand-off failed: ${String(e?.message || e).slice(0, 200)}`);
  }
  return handed;
}

/**
 * ⚠ THE BOOT SWEEP (WA-T6 review, learnings 15 §WA-T6 decision 5) — called ONCE by
 * `index.js` at API startup, before `app.listen`. Every `channel = 'email'` row still
 * `released` is a send the previous process started and never finished (the `.then`
 * write died with it): ⇒ `status = 'failed'`, `error = 'interrupted'`, so the composer's
 * retry re-sends it. NO AGE THRESHOLD: the API is the only e-mail sender and runs as ONE
 * instance, so at its own boot nothing can be in flight. ⚠ Accepted cost: a mail Mailgun
 * had already accepted before the crash goes out twice on that retry.
 *
 * ⚠ NOT in `db/schema.js`: schema.js runs in EVERY process that imports it (spec probes,
 * tooling pointed at a live `DB_PATH`), and a sweep there would fail a running server's
 * in-flight send. WhatsApp rows are never touched (the WA process owns `released` ones).
 * Returns the number of rows swept; never throws (logged, 0).
 */
export function sweepInterruptedEmailRows() {
  try {
    const swept = db.prepare(
      "UPDATE notifications SET status = 'failed', error = 'interrupted' WHERE channel = 'email' AND status = 'released'"
    ).run().changes;
    if (swept > 0) console.log(`[outbox] boot: ${swept} interrupted e-mail row(s) marked failed/interrupted`);
    return swept;
  } catch (e) {
    console.error(`[outbox] boot sweep of interrupted e-mail rows failed: ${String(e?.message || e).slice(0, 200)}`);
    return 0;
  }
}
