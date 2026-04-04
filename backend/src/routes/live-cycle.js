import { Router } from 'express';
import db from '../db/schema.js';
import {
  variantToKg,
  getTier,
  getNextTier,
  computeMargin,
  classifyFriend,
  TIER_THRESHOLDS,
  BUYER_DISCOUNT,
} from '../helpers/analytics.js';

const router = Router();

function roundKg(v) {
  return Math.round(v * 10) / 10;
}

function roundEur(v) {
  return Math.round(v * 100) / 100;
}

const SEGMENT_PRIORITY = { core: 0, regular: 1, occasional: 2, new: 3, inactive: 4 };

router.get('/', (req, res) => {
  try {
    // 1. Find current open or locked coffee cycle (most recent)
    const cycle = db.get(
      "SELECT id, name, status, created_at, expected_date, markup_ratio FROM order_cycles WHERE type = 'coffee' AND status IN ('open', 'locked') ORDER BY created_at DESC LIMIT 1"
    );

    if (!cycle) {
      return res.json({ cycle: null });
    }

    // 2. Get submitted orders for this cycle with items
    const orders = db.all(
      `SELECT o.id, o.friend_id, o.total
       FROM orders o
       WHERE o.cycle_id = ? AND o.status = 'submitted'`,
      [cycle.id]
    );

    const orderIds = orders.map(o => o.id);
    let items = [];
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      items = db.all(
        `SELECT oi.order_id, oi.variant, oi.quantity
         FROM order_items oi
         WHERE oi.order_id IN (${placeholders})`,
        orderIds
      );
    }

    // Compute totals
    let totalKg = 0;
    let totalValue = 0;
    const orderedFriendIds = new Set();

    for (const order of orders) {
      totalValue += order.total || 0;
      orderedFriendIds.add(order.friend_id);
    }
    for (const item of items) {
      totalKg += variantToKg(item.variant, item.quantity);
    }

    totalKg = roundKg(totalKg);
    totalValue = roundEur(totalValue);
    const numFriends = orderedFriendIds.size;
    const avgKgPerPerson = numFriends > 0 ? roundKg(totalKg / numFriends) : 0;
    const avgValuePerPerson = numFriends > 0 ? roundEur(totalValue / numFriends) : 0;

    const tier = getTier(totalKg);
    const nextTier = getNextTier(totalKg);
    const distanceToNextTier = nextTier ? roundKg(nextTier.minKg - totalKg) : 0;
    const friendsNeeded = nextTier && avgKgPerPerson > 0
      ? Math.ceil(distanceToNextTier / avgKgPerPerson)
      : null;
    const operatorMargin = roundEur(computeMargin(totalValue, totalKg));

    // 3. Count eligible friends (active + subscribed to coffee OR no subscriptions)
    const eligibleFriends = db.all(
      `SELECT f.id, f.name, f.display_name FROM friends f
       WHERE f.active = 1 AND (
         EXISTS (SELECT 1 FROM friend_subscriptions fs WHERE fs.friend_id = f.id AND fs.type = 'coffee')
         OR NOT EXISTS (SELECT 1 FROM friend_subscriptions fs WHERE fs.friend_id = f.id)
       )
       ORDER BY f.name ASC`
    );

    // 4. Get previous completed coffee cycle for comparison
    const prevCycle = db.get(
      "SELECT id, name, created_at FROM order_cycles WHERE type = 'coffee' AND status = 'completed' ORDER BY created_at DESC LIMIT 1"
    );

    let previous = null;
    const prevFriendIds = new Set();
    if (prevCycle) {
      const prevOrders = db.all(
        `SELECT o.id, o.friend_id, o.total
         FROM orders o
         WHERE o.cycle_id = ? AND o.status = 'submitted'`,
        [prevCycle.id]
      );

      const prevOrderIds = prevOrders.map(o => o.id);
      let prevItems = [];
      if (prevOrderIds.length > 0) {
        const pp = prevOrderIds.map(() => '?').join(',');
        prevItems = db.all(
          `SELECT oi.variant, oi.quantity FROM order_items oi WHERE oi.order_id IN (${pp})`,
          prevOrderIds
        );
      }

      let prevTotalKg = 0;
      let prevTotalValue = 0;
      for (const o of prevOrders) {
        prevTotalValue += o.total || 0;
        prevFriendIds.add(o.friend_id);
      }
      for (const item of prevItems) {
        prevTotalKg += variantToKg(item.variant, item.quantity);
      }

      prevTotalKg = roundKg(prevTotalKg);
      prevTotalValue = roundEur(prevTotalValue);
      const prevNumFriends = prevFriendIds.size;

      previous = {
        id: prevCycle.id,
        name: prevCycle.name,
        total_kg: prevTotalKg,
        total_value: prevTotalValue,
        num_friends: prevNumFriends,
        avg_kg_per_person: prevNumFriends > 0 ? roundKg(prevTotalKg / prevNumFriends) : 0,
        avg_value_per_person: prevNumFriends > 0 ? roundEur(prevTotalValue / prevNumFriends) : 0,
        friend_ids: [...prevFriendIds],
      };
    }

    // 5. Segment classification: get completed coffee cycle IDs for lookback
    const completedCycles = db.all(
      "SELECT id FROM order_cycles WHERE type = 'coffee' AND status = 'completed' ORDER BY created_at ASC"
    );
    const allCompletedCycleIds = completedCycles.map(c => c.id);
    const lastNCycleIds = allCompletedCycleIds.slice(-3);

    // Build per-friend participation map from historical orders
    let historicalParticipation = {};
    if (allCompletedCycleIds.length > 0) {
      const hp = allCompletedCycleIds.map(() => '?').join(',');
      const historicalOrders = db.all(
        `SELECT DISTINCT o.friend_id, o.cycle_id
         FROM orders o
         WHERE o.cycle_id IN (${hp}) AND o.status = 'submitted'`,
        allCompletedCycleIds
      );
      for (const ho of historicalOrders) {
        if (!historicalParticipation[ho.friend_id]) historicalParticipation[ho.friend_id] = [];
        historicalParticipation[ho.friend_id].push(ho.cycle_id);
      }
    }

    // 6. Build not-ordered list
    const notOrdered = eligibleFriends
      .filter(f => !orderedFriendIds.has(f.id))
      .map(f => {
        const orderedCycleIds = historicalParticipation[f.id] || [];
        const segment = classifyFriend(orderedCycleIds, lastNCycleIds, true, allCompletedCycleIds.length);
        const orderedPrevious = prevFriendIds.has(f.id);
        return {
          id: f.id,
          name: f.display_name || f.name,
          segment: segment.segment,
          ordered_previous: orderedPrevious,
        };
      })
      .sort((a, b) => (SEGMENT_PRIORITY[a.segment] ?? 99) - (SEGMENT_PRIORITY[b.segment] ?? 99));

    // 7. Potential kg if all not-ordered friends order at avg rate
    const potentialKg = avgKgPerPerson > 0
      ? roundKg(notOrdered.length * avgKgPerPerson)
      : 0;

    res.json({
      cycle: {
        id: cycle.id,
        name: cycle.name,
        status: cycle.status,
        created_at: cycle.created_at,
        expected_date: cycle.expected_date,
        markup_ratio: cycle.markup_ratio,
      },
      totals: {
        total_kg: totalKg,
        total_value: totalValue,
        num_friends: numFriends,
        total_eligible: eligibleFriends.length,
        avg_kg_per_person: avgKgPerPerson,
        avg_value_per_person: avgValuePerPerson,
        tier_discount: tier ? tier.discount : null,
        tier_label: tier ? tier.label : null,
        next_tier: nextTier ? { discount: nextTier.discount, label: nextTier.label, minKg: nextTier.minKg } : null,
        distance_to_next_tier: distanceToNextTier,
        friends_needed: friendsNeeded,
        operator_margin: operatorMargin,
      },
      previous,
      not_ordered: notOrdered,
      potential_kg: potentialKg,
    });
  } catch (err) {
    console.error('Live cycle error:', err);
    res.status(500).json({ error: 'Chyba pri načítaní live cycle dát' });
  }
});

export default router;
