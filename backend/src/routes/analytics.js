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

      totalKg = Math.round(totalKg * 1000) / 1000;
      totalValue = Math.round(totalValue * 100) / 100;

      const avgKgPerPerson = numFriends > 0 ? Math.round((totalKg / numFriends) * 1000) / 1000 : 0;
      const avgValuePerPerson = numFriends > 0 ? Math.round((totalValue / numFriends) * 100) / 100 : 0;

      const tier = getTier(totalKg);
      const margin = Math.round(computeMargin(totalValue, totalKg) * 100) / 100;

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
        margin,
        new_friends: newFriends,
        returning_friends: returningFriends,
        churned_friends: churnedFriends,
      };
    });

    // =========================================================
    // 5. Per-friend stats
    // =========================================================
    // Get all friends (active and inactive) who have at least one order
    const allFriendIds = [...new Set(orders.map(o => o.friend_id))];
    const friendMap = {};
    if (allFriendIds.length > 0) {
      const fPlaceholders = allFriendIds.map(() => '?').join(',');
      const friendRows = db.all(
        `SELECT id, name, active FROM friends WHERE id IN (${fPlaceholders})`,
        allFriendIds
      );
      for (const f of friendRows) {
        friendMap[f.id] = f;
      }
    }

    // Last N cycle IDs for classification (up to last 5)
    const lastNCycleIds = cycleIds.slice(-5);

    const friendStats = allFriendIds.map(friendId => {
      const friend = friendMap[friendId];
      if (!friend) return null;

      const friendOrders = ordersByFriend[friendId] || [];
      const orderedCycleIds = [...new Set(friendOrders.map(o => o.cycle_id))];
      const cyclesParticipated = orderedCycleIds.length;
      const participationRate = cycleIds.length > 0
        ? Math.round((cyclesParticipated / cycleIds.length) * 100) / 100
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

      totalKg = Math.round(totalKg * 1000) / 1000;
      totalValue = Math.round(totalValue * 100) / 100;
      const avgKg = cyclesParticipated > 0 ? Math.round((totalKg / cyclesParticipated) * 1000) / 1000 : 0;
      const avgValue = cyclesParticipated > 0 ? Math.round((totalValue / cyclesParticipated) * 100) / 100 : 0;

      // Last active cycle
      const lastActiveCycleId = orderedCycleIds.length > 0
        ? orderedCycleIds[orderedCycleIds.length - 1]
        : null;

      const streak = computeStreak(orderedCycleIds, cycleIds);
      const trend = computeTrend(kgByCycle);
      const segment = classifyFriend(orderedCycleIds, lastNCycleIds, !!friend.active, cycleIds.length);

      return {
        id: friendId,
        name: friend.name,
        active: !!friend.active,
        cycles_participated: cyclesParticipated,
        participation_rate: participationRate,
        total_kg: totalKg,
        avg_kg: avgKg,
        total_value: totalValue,
        avg_value: avgValue,
        last_active_cycle_id: lastActiveCycleId,
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
      ? Math.round((last3Cycles.reduce((sum, c) => sum + c.total_kg, 0) / last3Cycles.length) * 1000) / 1000
      : 0;

    const currentTier = getTier(rollingAvgKg3);
    const nextTier = getNextTier(rollingAvgKg3);
    const distanceToNextTier = nextTier ? Math.round((nextTier.minKg - rollingAvgKg3) * 1000) / 1000 : 0;

    // Estimate friends needed to reach next tier (using avg kg per person from last cycle)
    const lastCycle = cycleStats[cycleStats.length - 1];
    const avgKgPerPerson = lastCycle && lastCycle.avg_kg_per_person > 0
      ? lastCycle.avg_kg_per_person
      : 0;
    const friendsNeeded = nextTier && avgKgPerPerson > 0
      ? Math.ceil(distanceToNextTier / avgKgPerPerson)
      : null;

    // Tier hit rate: how many cycles hit at least 30% tier (minKg >= 5)
    const tierHitCount = cycleStats.filter(c => c.tier !== null).length;
    const tierHitRate = cycleStats.length > 0
      ? Math.round((tierHitCount / cycleStats.length) * 100) / 100
      : 0;

    // Cumulative margin
    const cumulativeMargin = Math.round(cycleStats.reduce((sum, c) => sum + c.margin, 0) * 100) / 100;

    // Top 5 friends by total kg and their share
    const sortedFriends = [...friendStats].sort((a, b) => b.total_kg - a.total_kg);
    const top5 = sortedFriends.slice(0, 5);
    const totalKgAllFriends = friendStats.reduce((sum, f) => sum + f.total_kg, 0);
    const top5Share = totalKgAllFriends > 0
      ? Math.round((top5.reduce((sum, f) => sum + f.total_kg, 0) / totalKgAllFriends) * 100) / 100
      : 0;

    // Concentration warning if top 5 account for >60%
    const concentrationWarning = top5Share > 0.6;

    // Minimum viable base: how many friends needed to sustain current tier alone
    // using average kg per person from recent cycles
    const minViableBase = currentTier && avgKgPerPerson > 0
      ? Math.ceil(currentTier.minKg / avgKgPerPerson)
      : null;

    const summary = {
      total_cycles: cycleStats.length,
      rolling_avg_kg_3: rollingAvgKg3,
      current_tier: currentTier ? { discount: currentTier.discount, label: currentTier.label, minKg: currentTier.minKg } : null,
      next_tier: nextTier ? { discount: nextTier.discount, label: nextTier.label, minKg: nextTier.minKg } : null,
      distance_to_next_tier: distanceToNextTier,
      friends_needed: friendsNeeded,
      tier_hit_rate: tierHitRate,
      cumulative_margin: cumulativeMargin,
      top5_share: top5Share,
      concentration_warning: concentrationWarning,
      min_viable_base: minViableBase,
    };

    res.json({ cycles: cycleStats, friends: friendStats, summary });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Chyba pri výpočte analytiky' });
  }
});

export default router;
