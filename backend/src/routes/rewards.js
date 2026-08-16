import { Router } from 'express';
import db from '../db/schema.js';
import { variantToKg } from '../helpers/analytics.js';
import { guestCycleItems } from '../helpers/guest-aggregation.js';
import { bindValue } from '../helpers/bind-value.js';

const router = Router();

// GET /api/analytics/rewards — aggregated group × cycle report
router.get('/', (req, res) => {
  try {
    // FUP-T13 — `?limit[toString]=1` makes `parseInt` call ToPrimitive on a
    // non-callable `toString`, which throws. ⚠ DELIBERATELY NOT A LOG-FLOOD SITE, and
    // the distinction matters: this route's own try/catch logs `e.message` only —
    // 72 bytes, NO stack — so unlike every other site in this row the defect was
    // purely the WRONG STATUS (a malformed query string is a client mistake, not a
    // server fault). Fixed for correctness, not hygiene; nobody should later "harden"
    // it as if it leaked a stack. `undefined` reproduces what `?limit=abc` already
    // did: NaN, then the `|| 12` default.
    const limit = parseInt(bindValue(req.query.limit)) || 12;

    // Get recent completed/locked coffee cycles
    const cycles = db.all(
      `SELECT id, name, status FROM order_cycles
       WHERE type = 'coffee' AND status IN ('locked', 'completed')
       ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    cycles.reverse(); // chronological order

    const cycleIds = cycles.map(c => c.id);
    if (cycleIds.length === 0) {
      return res.json({ cycles: [], groups: [] });
    }

    // Get all friends with their group info
    const friends = db.all('SELECT id, name, display_name, is_root, root_friend_id, active FROM friends');

    // Build group membership map
    const rootFriends = friends.filter(f => f.is_root);
    const groupMap = new Map();

    for (const root of rootFriends) {
      groupMap.set(root.id, {
        rootFriend: { id: root.id, name: root.name, displayName: root.display_name },
        memberIds: [root.id]
      });
    }

    for (const f of friends) {
      if (!f.is_root && f.root_friend_id && groupMap.has(f.root_friend_id)) {
        groupMap.get(f.root_friend_id).memberIds.push(f.id);
      }
    }

    // Unassigned = no root of their own AND no root they belong to. ⚠ A DANGLING
    // `root_friend_id` (pointing at a friend who is no longer a root, or who was
    // hard-deleted — `friends.js` DELETE is a real `DELETE FROM friends` and
    // `root_friend_id` was added by a bare ALTER TABLE with no FK) counts as
    // unassigned too. Before this, such a friend matched neither the group loop above
    // nor this filter and vanished from the report entirely: deleting a group's root
    // silently zeroed every ex-member's whole reward volume, own kilos and guest
    // kilos alike. Volume must never disappear from a report that decides money —
    // whatever the grouping, every friend lands in exactly one bucket.
    const unassignedIds = friends
      .filter(f => !f.is_root && !(f.root_friend_id && groupMap.has(f.root_friend_id)))
      .map(f => f.id);

    // Get all submitted orders with their items for these cycles
    const placeholders = cycleIds.map(() => '?').join(',');
    const orderItems = db.all(
      `SELECT o.friend_id, o.cycle_id, oi.variant, oi.quantity
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.cycle_id IN (${placeholders}) AND o.status = 'submitted'`,
      cycleIds
    );

    // Build kg map: friendId -> cycleId -> kg (OWN orders only)
    const kgMap = new Map();
    for (const item of orderItems) {
      const key = item.friend_id;
      if (!kgMap.has(key)) kgMap.set(key, new Map());
      const cycleMap = kgMap.get(key);
      const current = cycleMap.get(item.cycle_id) || 0;
      cycleMap.set(item.cycle_id, current + variantToKg(item.variant, item.quantity));
    }

    // GUEST kilos, credited to the HOST (§UC-GSO-014, Decision 5 "Host gets the
    // kilos credit"): the host recruited the guests and hands their bags over, so
    // their guests' kilos count toward the host's reward/voucher volume. The
    // attribution key is `guest_order_links.host_friend_id`, which
    // `guestCycleItems()` already returns — this row reuses that ONE guest UNION
    // (GSO-T8) rather than writing another one, so the cycle correlation
    // (`glink.cycle_id`) and the `COALESCE(gord.status,'submitted') <> 'cancelled'`
    // predicate can never drift from the other guest aggregates. Cancelled
    // sub-orders keep their item rows (GSO-T4), so that predicate is the only thing
    // keeping a called-off bag out of a reward payout.
    //
    // ⚠ Kept in a SEPARATE map from own orders, deliberately:
    //   - each (friend, cycle) pair is summed once per source and added once in
    //     buildGroupReport, so a host who has BOTH an own order and sub-orders
    //     accumulates them (addition) instead of being counted twice;
    //   - `memberIds` are disjoint across buckets (a root is only in its own group,
    //     a member only under its root, `unassignedIds` is neither), so one bucket
    //     reads each friend's guest kilos exactly once;
    //   - it makes the guest share reportable on its own (`guestKg`), which a
    //     report that decides money should not hide.
    // Merged in JAVASCRIPT, never as a JOIN (the GSO-T6 trap) — a second join over
    // the friend-order query would multiply friend lines by the sub-order count.
    //
    // A DEACTIVATED host keeps this credit: `friends` is read whole (active or not)
    // and their own orders keep counting, because the report is history — the coffee
    // was bought. A hard-deleted host has no guest rows left at all
    // (`guest_order_links.host_friend_id` is ON DELETE CASCADE).
    const guestKgMap = new Map();
    for (const item of guestCycleItems(cycleIds)) {
      const key = item.host_friend_id;
      if (!guestKgMap.has(key)) guestKgMap.set(key, new Map());
      const cycleMap = guestKgMap.get(key);
      const current = cycleMap.get(item.cycle_id) || 0;
      cycleMap.set(item.cycle_id, current + variantToKg(item.variant, item.quantity));
    }

    // Friend name lookup
    const friendNameMap = new Map();
    for (const f of friends) {
      friendNameMap.set(f.id, f.display_name || f.name);
    }

    function buildGroupReport(memberIds) {
      let cumulativeKg = 0;
      let cumulativeGuestKg = 0;
      const perCycle = cycleIds.map(cycleId => {
        let cycleKg = 0;
        let cycleGuestKg = 0;
        // TWO lists, deliberately. `orderedMembers` answers "who ordered", so it is
        // OWN SUBMITTED ORDERS ONLY — the per-friend question Decision 4 / GSO-T8
        // fence off ("anything answering 'who ordered' must keep querying `orders`
        // alone"). Naming a guest-only host here would make a false claim on the very
        // screen that decides reward money, and would silently mislead any future
        // consumer reading the field as "friends with a submitted order".
        // `guestOnlyMembers` carries the hosts whose entire contribution is their
        // guests' kilos — so a group's volume is still fully accounted for, which is
        // why the group total can exceed what `orderedMembers` explains.
        // `memberCount` stays the FRIEND count: a guest is never a member.
        const orderedMembers = [];
        const guestOnlyMembers = [];
        for (const memberId of memberIds) {
          const ownKg = kgMap.get(memberId)?.get(cycleId) || 0;
          const guestKg = guestKgMap.get(memberId)?.get(cycleId) || 0;
          const memberKg = ownKg + guestKg;
          if (memberKg > 0) {
            cycleKg += memberKg;
            cycleGuestKg += guestKg;
            if (ownKg > 0) {
              orderedMembers.push(friendNameMap.get(memberId));
            } else {
              guestOnlyMembers.push(friendNameMap.get(memberId));
            }
          }
        }
        cumulativeKg += cycleKg;
        cumulativeGuestKg += cycleGuestKg;
        return {
          cycleId,
          kg: Math.round(cycleKg * 1000) / 1000,
          guestKg: Math.round(cycleGuestKg * 1000) / 1000,
          orderedMembers,
          guestOnlyMembers
        };
      });

      return {
        memberCount: memberIds.length,
        perCycle,
        cumulativeKg: Math.round(cumulativeKg * 1000) / 1000,
        cumulativeGuestKg: Math.round(cumulativeGuestKg * 1000) / 1000
      };
    }

    const groups = [];

    for (const [rootId, group] of groupMap) {
      const report = buildGroupReport(group.memberIds);
      groups.push({ rootFriend: group.rootFriend, ...report });
    }

    groups.sort((a, b) => b.cumulativeKg - a.cumulativeKg);

    if (unassignedIds.length > 0) {
      const ostatniReport = buildGroupReport(unassignedIds);
      groups.push({ rootFriend: null, label: 'Ostatní', ...ostatniReport });
    }

    res.json({ cycles, groups });
  } catch (e) {
    console.error('Error fetching rewards report:', e.message);
    res.status(500).json({ error: 'Chyba pri načítaní reportu odmien' });
  }
});

export default router;
