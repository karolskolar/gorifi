import { Router } from 'express';
import db from '../db/schema.js';
import { variantToKg } from '../helpers/analytics.js';

const router = Router();

// GET /api/analytics/rewards — aggregated group × cycle report
router.get('/', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 12;

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

    const unassignedIds = friends
      .filter(f => !f.is_root && !f.root_friend_id)
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

    // Build kg map: friendId -> cycleId -> kg
    const kgMap = new Map();
    for (const item of orderItems) {
      const key = item.friend_id;
      if (!kgMap.has(key)) kgMap.set(key, new Map());
      const cycleMap = kgMap.get(key);
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
      const perCycle = cycleIds.map(cycleId => {
        let cycleKg = 0;
        const orderedMembers = [];
        for (const memberId of memberIds) {
          const memberKg = kgMap.get(memberId)?.get(cycleId) || 0;
          if (memberKg > 0) {
            cycleKg += memberKg;
            orderedMembers.push(friendNameMap.get(memberId));
          }
        }
        cumulativeKg += cycleKg;
        return {
          cycleId,
          kg: Math.round(cycleKg * 1000) / 1000,
          orderedMembers
        };
      });

      return { memberCount: memberIds.length, perCycle, cumulativeKg: Math.round(cumulativeKg * 1000) / 1000 };
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
