import db from '../db/schema.js';

// ⚠ THE ONE AND ONLY WRITER OF `notifications` (DP-T3, 16 §UC-DP-008).
//
// Module 16 records WHICH template is owed to WHOM about WHICH bag, at the moment
// the bag leaves the admin's hands. It renders nothing, resolves no phone number
// and SENDS NOTHING — there is no outbound call and no WhatsApp/mail import
// anywhere near this file, by design (01-architecture: „the API never sends").
//
// ⚠ ITS SUCCESSOR IS **WA-T4** (module 21, `21-whatsapp-notifications.md`
// §UC-WA-006). That row keeps these two function names and these rows, and ADDS
// the per-recipient rule order on top: a disabled template enqueues nothing; an
// opted-out friend gets a `channel='email'` row when an address exists and none
// otherwise (PO D5); a phone gives `whatsapp`, no phone plus an e-mail gives
// `email`, neither gives `skipped/no_phone`; and the partial unique index
// `idx_notifications_queued_once` (WA-T1) makes the idempotency a constraint
// rather than a SELECT, counted and never thrown out of the enclosing transaction.
// `in_person` still enqueues nothing. The swap is meant to be mechanical: the
// CALLERS pass bags and read counts, and they do not know what a row looks like.
//
// ⚠ SYNCHRONOUS, AND CALLED INSIDE THE CALLER'S `db.transaction()`. An `await` in
// here would break the check-then-write atomicity the hand-over routes rest on
// under `instances: 1` (CLAUDE.md, GA-T8) — the enqueue must commit or roll back
// with the stamp it describes, or the admin gets a message queued for a bag that
// was never handed over.
//
// ⚠ A NOTIFICATION IS NOT A FINANCIAL EVENT. Nothing here touches `transactions`,
// `orders.total`, `paid` or `delivery_fee`. Stage 3 is ledger-neutral by
// construction (§UC-DP-004) and this is the only thing it writes besides the two
// `handed_over_at` columns.

// The three template keys module 21 owns (UC-WA-004 holds the texts):
//   `pickup`  ↔ „Doručené na odberné miesto"
//   `packeta` ↔ „Odovzdané Packete"
//   `host`    ↔ „Odovzdané priateľovi"
// ⚠ AN `in_person` BAG ENQUEUES NO ROW AT ALL. Module 21 defines no template for
// it — the admin arranges that hand-over directly (orchestrator reconciliation
// 2026-09-19). Its `in_person` SEGMENT still exists, but only for 21's composer's
// „Správa skupine" with template `custom`; a hand-over never mints it.
const FRIEND_TEMPLATE_BY_DELIVERY = { pickup: 'pickup', packeta: 'packeta' };

/**
 * The row one bag owes, or `null` for a bag that owes none.
 *
 * A bag is `{ kind: 'friend', cycleId, orderId, friendId, delivery }` or
 * `{ kind: 'guest', cycleId, guestOrderId, hostFriendId, delivery }`, where
 * `delivery` is `helpers/delivery.js`'s classification — the ONE HOME for „how
 * does this bag leave, and where". Nothing here re-derives it.
 */
function rowFor(bag) {
  const type = bag?.delivery?.type;

  if (bag?.kind === 'friend') {
    const templateKey = FRIEND_TEMPLATE_BY_DELIVERY[type];
    if (!templateKey) return null; // `in_person`, and nothing else reaches here
    return {
      template_key: templateKey,
      // For a friend bag the segment IS the delivery's target key: `loc<id>` for a
      // pickup point, `packeta` for Packeta. One value, not two spellings.
      segment_key: bag.delivery.target_key,
      recipient_kind: 'friend',
      recipient_id: bag.friendId,
      cycle_id: bag.cycleId,
      order_id: bag.orderId,
      guest_order_id: null,
    };
  }

  if (bag?.kind === 'guest') {
    // A guest travelling inside their host's bag is written to about THEIR HOST,
    // and grouped by that host — not by where the host happens to collect, because
    // the message is „your coffee is with <host>". A module-20 Packeta guest is its
    // own party and takes the Packeta template instead.
    if (type === 'via_host') {
      return {
        template_key: 'host',
        segment_key: `host:${bag.hostFriendId}`,
        recipient_kind: 'guest',
        recipient_id: bag.guestOrderId,
        cycle_id: bag.cycleId,
        order_id: null,
        guest_order_id: bag.guestOrderId,
      };
    }
    if (type === 'packeta') {
      return {
        template_key: 'packeta',
        segment_key: 'packeta',
        recipient_kind: 'guest',
        recipient_id: bag.guestOrderId,
        cycle_id: bag.cycleId,
        order_id: null,
        guest_order_id: bag.guestOrderId,
      };
    }
    return null;
  }

  return null;
}

/**
 * Queue the messages a hand-over owes. Returns how many rows were INSERTed.
 *
 * ⚠ IDEMPOTENT BY (template, recipient, bag): a `queued` row for the same tuple
 * blocks a second one, so a double click or a second device converges on one
 * message (§UC-DP-008). A `released`/`sent`/`failed`/`skipped` row does NOT block
 * a new `queued` one — a genuine re-hand-over after a reversal is a new event, and
 * the old row is history. `IS` rather than `=` on the nullable id columns, because
 * `order_id = NULL` is NULL in SQL and would match nothing.
 *
 * ⚠ `body` and `phone_e164` are NULL ON PURPOSE. Module 21 renders the text and
 * resolves the number at RELEASE time, from the live row: the template text is
 * editable in its composer before release, so rendering here would freeze stale
 * wording into rows the admin then edits. `released_at` / `sent_at` / `error` stay
 * NULL for the same reason — no `released` transition exists in module 16.
 *
 * A bag whose recipient is a DEACTIVATED friend still enqueues: this module
 * records that the event happened; whether to skip is module 21's decision.
 */
export function enqueueForHandOver(bags) {
  const existing = db.prepare(`
    SELECT id FROM notifications
     WHERE status = 'queued'
       AND template_key = ?
       AND recipient_kind = ?
       AND recipient_id IS ?
       AND order_id IS ?
       AND guest_order_id IS ?
  `);
  const insert = db.prepare(`
    INSERT INTO notifications (
      channel, template_key, segment_key, recipient_kind, recipient_id,
      phone_e164, body, status, cycle_id, order_id, guest_order_id
    ) VALUES ('whatsapp', ?, ?, ?, ?, NULL, NULL, 'queued', ?, ?, ?)
  `);

  let queued = 0;
  for (const bag of Array.isArray(bags) ? bags : []) {
    const row = rowFor(bag);
    if (!row) continue;
    const hit = existing.get(
      row.template_key, row.recipient_kind, row.recipient_id, row.order_id, row.guest_order_id
    );
    if (hit) continue;
    insert.run(
      row.template_key, row.segment_key, row.recipient_kind, row.recipient_id,
      row.cycle_id, row.order_id, row.guest_order_id
    );
    queued += 1;
  }
  return queued;
}

/**
 * Un-queue the messages a REVERSED hand-over no longer owes. Returns how many rows
 * were deleted.
 *
 * ⚠ `status = 'queued'` ONLY. A `released`, `sent`, `failed` or `skipped` row is
 * HISTORY — somebody was already told, or already not told, and deleting that
 * record would make the outbox lie about what the friend received. Un-handing a bag
 * after its message went out is a situation the admin resolves by talking to the
 * person, not one the database pretends away.
 */
export function cancelForUnHandOver(bags) {
  const dropFriend = db.prepare(
    "DELETE FROM notifications WHERE status = 'queued' AND recipient_kind = 'friend' AND order_id = ?"
  );
  const dropGuest = db.prepare(
    "DELETE FROM notifications WHERE status = 'queued' AND recipient_kind = 'guest' AND guest_order_id = ?"
  );

  let dequeued = 0;
  for (const bag of Array.isArray(bags) ? bags : []) {
    if (bag?.kind === 'friend' && bag.orderId) {
      dequeued += dropFriend.run(bag.orderId).changes;
    } else if (bag?.kind === 'guest' && bag.guestOrderId) {
      dequeued += dropGuest.run(bag.guestOrderId).changes;
    }
  }
  return dequeued;
}
