import { Router } from 'express';
import db from '../db/schema.js';
import {
  variantToKg,
  getTier,
  getNextTier,
  computeMargin,
  classifyFriend,
  computeStreak,
  computeTrend,
  TIER_THRESHOLDS,
  BUYER_DISCOUNT,
} from '../helpers/analytics.js';

const router = Router();

// Validate admin token helper
function requireAdmin(req, res) {
  const token = req.headers['x-admin-token'];
  if (!token) {
    res.status(401).json({ error: 'Neautorizovaný prístup' });
    return false;
  }
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'admin_token'").get();
  if (!setting) {
    res.status(401).json({ error: 'Neautorizovaný prístup' });
    return false;
  }
  try {
    const { token: storedToken, expiry } = JSON.parse(setting.value);
    if (token === storedToken && Date.now() < expiry) {
      return true;
    }
  } catch (e) {
    // invalid format
  }
  res.status(401).json({ error: 'Neautorizovaný prístup' });
  return false;
}

// Round kg to 1 decimal place
function roundKg(value) {
  return Math.round(value * 10) / 10;
}

router.get('/coffee', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    // 1. Get all coffee cycles (completed or locked), chronological
    const cycles = db.all(
      "SELECT * FROM order_cycles WHERE type = 'coffee' AND status IN ('locked', 'completed') ORDER BY created_at ASC"
    );

    if (cycles.length === 0) {
      return res.json({ cycles: [], friends: [], summary: null });
    }

    const cycleIds = cycles.map(c => c.id);
    const placeholders = cycleIds.map(() => '?').join(',');

    // Build cycle id-to-name map
    const cycleNameMap = {};
    for (const c of cycles) {
      cycleNameMap[c.id] = c.name;
    }

    // 2. Get all submitted orders for those cycles
    const orders = db.all(
      `SELECT o.*, f.name as friend_name, f.active as friend_active
       FROM orders o
       JOIN friends f ON o.friend_id = f.id
       WHERE o.cycle_id IN (${placeholders}) AND o.status = 'submitted'`,
      cycleIds
    );

    // 3. Get all order items for those orders
    const orderIds = orders.map(o => o.id);
    let items = [];
    if (orderIds.length > 0) {
      const itemPlaceholders = orderIds.map(() => '?').join(',');
      items = db.all(
        `SELECT oi.*, o.cycle_id, o.friend_id
         FROM order_items oi
         JOIN orders o ON oi.order_id = o.id
         WHERE oi.order_id IN (${itemPlaceholders})`,
        orderIds
      );
    }

    // Build lookup maps
    const ordersByCycle = {};
    const ordersByFriend = {};
    for (const o of orders) {
      if (!ordersByCycle[o.cycle_id]) ordersByCycle[o.cycle_id] = [];
      ordersByCycle[o.cycle_id].push(o);
      if (!ordersByFriend[o.friend_id]) ordersByFriend[o.friend_id] = [];
      ordersByFriend[o.friend_id].push(o);
    }

    const itemsByOrder = {};
    for (const item of items) {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    }

    // Track friends who participated in each cycle
    const friendsByCycle = {};
    for (const o of orders) {
      if (!friendsByCycle[o.cycle_id]) friendsByCycle[o.cycle_id] = new Set();
      friendsByCycle[o.cycle_id].add(o.friend_id);
    }

    // Previous cycle's friend set for churn detection
    let prevFriendSet = new Set();

    // =========================================================
    // 4. Per-cycle stats
    // =========================================================
    const cycleStats = cycles.map((cycle, idx) => {
      const cycleOrders = ordersByCycle[cycle.id] || [];
      const currentFriendSet = friendsByCycle[cycle.id] || new Set();
      const numFriends = currentFriendSet.size;

      // Compute total kg and total value
      let totalKg = 0;
      let totalValue = 0;
      for (const order of cycleOrders) {
        const orderItems = itemsByOrder[order.id] || [];
        for (const item of orderItems) {
          totalKg += variantToKg(item.variant, item.quantity);
          totalValue += item.price * item.quantity;
        }
      }

      totalKg = roundKg(totalKg);
      totalValue = Math.round(totalValue * 100) / 100;

      const avgKgPerPerson = numFriends > 0 ? roundKg(totalKg / numFriends) : 0;
      const avgValuePerPerson = numFriends > 0 ? Math.round((totalValue / numFriends) * 100) / 100 : 0;

      const tier = getTier(totalKg);
      const operator_margin = Math.round(computeMargin(totalValue, totalKg) * 100) / 100;

      // New / returning / churned
      const newFriends = [...currentFriendSet].filter(f => !prevFriendSet.has(f)).length;
      const returningFriends = [...currentFriendSet].filter(f => prevFriendSet.has(f)).length;
      const churnedFriends = [...prevFriendSet].filter(f => !currentFriendSet.has(f)).length;

      prevFriendSet = currentFriendSet;

      return {
        id: cycle.id,
        name: cycle.name,
        status: cycle.status,
        created_at: cycle.created_at,
        num_friends: numFriends,
        total_kg: totalKg,
        total_value: totalValue,
        avg_kg_per_person: avgKgPerPerson,
        avg_value_per_person: avgValuePerPerson,
        tier: tier ? { discount: tier.discount, label: tier.label, minKg: tier.minKg } : null,
        operator_margin,
        new_friends: newFriends,
        returning_friends: returningFriends,
        churned_friends: churnedFriends,
      };
    });

    // =========================================================
    // 5. Per-friend stats
    // =========================================================
    // Get ALL active friends (including those with no orders)
    const allActiveFriends = db.all("SELECT id, name, active FROM friends WHERE active = 1");

    // Also get friends who have orders but may be inactive
    const allFriendIdsWithOrders = [...new Set(orders.map(o => o.friend_id))];
    const friendMap = {};

    // Add all active friends to map
    for (const f of allActiveFriends) {
      friendMap[f.id] = f;
    }

    // Add inactive friends who have orders
    if (allFriendIdsWithOrders.length > 0) {
      const fPlaceholders = allFriendIdsWithOrders.map(() => '?').join(',');
      const friendRows = db.all(
        `SELECT id, name, active FROM friends WHERE id IN (${fPlaceholders})`,
        allFriendIdsWithOrders
      );
      for (const f of friendRows) {
        friendMap[f.id] = f;
      }
    }

    // All friend IDs to process (union of active friends + friends with orders)
    const allFriendIds = [...new Set([...allActiveFriends.map(f => f.id), ...allFriendIdsWithOrders])];

    // Last N cycle IDs for classification (up to last 5)
    const lastNCycleIds = cycleIds.slice(-5);

    const friendStats = allFriendIds.map(friendId => {
      const friend = friendMap[friendId];
      if (!friend) return null;

      const friendOrders = ordersByFriend[friendId] || [];
      const orderedCycleIds = [...new Set(friendOrders.map(o => o.cycle_id))];
      const cyclesParticipated = orderedCycleIds.length;

      // total_cycles: number of coffee cycles from first participated cycle to latest (inclusive)
      let totalCycles = 0;
      if (cyclesParticipated > 0) {
        const firstCycleIdx = cycleIds.indexOf(orderedCycleIds[0]);
        const lastCycleIdx = cycleIds.length - 1; // latest cycle
        totalCycles = lastCycleIdx - firstCycleIdx + 1;
      }

      const participationRate = totalCycles > 0
        ? Math.round((cyclesParticipated / totalCycles) * 100) / 100
        : 0;

      // Total kg and value per cycle for trend
      let totalKg = 0;
      let totalValue = 0;
      const kgByCycle = [];

      for (const cycleId of cycleIds) {
        const cycleOrders = friendOrders.filter(o => o.cycle_id === cycleId);
        let cycleKg = 0;
        for (const order of cycleOrders) {
          const orderItems = itemsByOrder[order.id] || [];
          for (const item of orderItems) {
            const kg = variantToKg(item.variant, item.quantity);
            cycleKg += kg;
            totalValue += item.price * item.quantity;
          }
        }
        if (cycleOrders.length > 0) {
          kgByCycle.push(cycleKg);
        }
        totalKg += cycleKg;
      }

      totalKg = roundKg(totalKg);
      totalValue = Math.round(totalValue * 100) / 100;
      const avgKgPerCycle = cyclesParticipated > 0 ? roundKg(totalKg / cyclesParticipated) : 0;
      const avgValuePerCycle = cyclesParticipated > 0 ? Math.round((totalValue / cyclesParticipated) * 100) / 100 : 0;

      // Last active cycle
      const lastActiveCycleId = orderedCycleIds.length > 0
        ? orderedCycleIds[orderedCycleIds.length - 1]
        : null;
      const lastActiveCycleName = lastActiveCycleId ? (cycleNameMap[lastActiveCycleId] || null) : null;

      const streak = computeStreak(orderedCycleIds, cycleIds);
      const trend = computeTrend(kgByCycle);
      const segment = classifyFriend(orderedCycleIds, lastNCycleIds, !!friend.active, cycleIds.length);

      return {
        id: friendId,
        name: friend.name,
        active: !!friend.active,
        cycles_participated: cyclesParticipated,
        total_cycles: totalCycles,
        participation_rate: participationRate,
        total_kg: totalKg,
        avg_kg_per_cycle: avgKgPerCycle,
        total_value: totalValue,
        avg_value_per_cycle: avgValuePerCycle,
        last_active_cycle_id: lastActiveCycleId,
        last_active_cycle_name: lastActiveCycleName,
        streak,
        trend,
        segment,
      };
    }).filter(Boolean);

    // =========================================================
    // 6. Summary
    // =========================================================
    // Rolling average of last 3 cycles' kg
    const last3Cycles = cycleStats.slice(-3);
    const rollingAvgKg3 = last3Cycles.length > 0
      ? roundKg(last3Cycles.reduce((sum, c) => sum + c.total_kg, 0) / last3Cycles.length)
      : 0;

    const currentTier = getTier(rollingAvgKg3);
    const nextTier = getNextTier(rollingAvgKg3);
    const distanceToNextTier = nextTier ? roundKg(nextTier.minKg - rollingAvgKg3) : 0;

    // Estimate friends needed to reach next tier (using avg kg per person from last cycle)
    const lastCycle = cycleStats[cycleStats.length - 1];
    const avgKgPerPerson = lastCycle && lastCycle.avg_kg_per_person > 0
      ? lastCycle.avg_kg_per_person
      : 0;
    const friendsNeededForNextTier = nextTier && avgKgPerPerson > 0
      ? Math.ceil(distanceToNextTier / avgKgPerPerson)
      : null;

    // Tier hit rate 35%: how many cycles hit tier_discount >= 0.35
    const tierHitCount35 = cycleStats.filter(c => c.tier !== null && c.tier.discount >= 0.35).length;
    const tierHitRate35 = cycleStats.length > 0
      ? Math.round((tierHitCount35 / cycleStats.length) * 100) / 100
      : 0;

    // Cumulative margin (all time)
    const cumulativeMarginAll = Math.round(cycleStats.reduce((sum, c) => sum + c.operator_margin, 0) * 100) / 100;

    // Cumulative margin (last 12 months)
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const twelveMonthsAgoStr = twelveMonthsAgo.toISOString();
    const cumulativeMargin12m = Math.round(
      cycleStats
        .filter(c => c.created_at >= twelveMonthsAgoStr)
        .reduce((sum, c) => sum + c.operator_margin, 0) * 100
    ) / 100;

    // Average kg per person across recent cycles (last 3)
    const avgKgPerPersonSummary = last3Cycles.length > 0
      ? roundKg(last3Cycles.reduce((sum, c) => sum + c.avg_kg_per_person, 0) / last3Cycles.length)
      : 0;

    // Top 5 friends by total kg and their share
    const sortedFriends = [...friendStats].sort((a, b) => b.total_kg - a.total_kg);
    const top5 = sortedFriends.slice(0, 5);
    const totalKgAllFriends = friendStats.reduce((sum, f) => sum + f.total_kg, 0);
    const top5Share = totalKgAllFriends > 0
      ? Math.round((top5.reduce((sum, f) => sum + f.total_kg, 0) / totalKgAllFriends) * 100) / 100
      : 0;

    // Concentration warning if top 5 account for >40%
    const concentrationWarning = top5Share > 0.4;

    // Minimum viable base: how many friends needed to sustain current tier alone
    const minViableBase = currentTier && avgKgPerPerson > 0
      ? Math.ceil(currentTier.minKg / avgKgPerPerson)
      : null;

    // Core + regular count and their avg kg per cycle
    const coreRegularFriends = friendStats.filter(
      f => f.segment.segment === 'core' || f.segment.segment === 'regular'
    );
    const coreRegularCount = coreRegularFriends.length;
    const coreRegularAvgKg = coreRegularCount > 0
      ? roundKg(coreRegularFriends.reduce((sum, f) => sum + f.avg_kg_per_cycle, 0) / coreRegularCount)
      : 0;

    // Tier thresholds mapped to {min_kg, discount, label}
    const tierThresholds = TIER_THRESHOLDS.map(t => ({
      min_kg: t.minKg,
      discount: t.discount,
      label: t.label,
    }));

    const summary = {
      total_cycles: cycleStats.length,
      rolling_avg_kg_3: rollingAvgKg3,
      current_tier: currentTier ? { discount: currentTier.discount, label: currentTier.label, minKg: currentTier.minKg } : null,
      next_tier: nextTier ? { discount: nextTier.discount, label: nextTier.label, minKg: nextTier.minKg } : null,
      distance_to_next_tier: distanceToNextTier,
      friends_needed_for_next_tier: friendsNeededForNextTier,
      tier_hit_rate_35: tierHitRate35,
      cumulative_margin_all: cumulativeMarginAll,
      cumulative_margin_12m: cumulativeMargin12m,
      avg_kg_per_person: avgKgPerPersonSummary,
      top5_share: top5Share,
      concentration_warning: concentrationWarning,
      min_viable_base: minViableBase,
      core_regular_count: coreRegularCount,
      core_regular_avg_kg: coreRegularAvgKg,
      tier_thresholds: tierThresholds,
      buyer_discount: BUYER_DISCOUNT,
    };

    res.json({ cycles: cycleStats, friends: friendStats, summary });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Chyba pri výpočte analytiky' });
  }
});

export default router;
