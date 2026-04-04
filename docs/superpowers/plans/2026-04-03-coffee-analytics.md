# Coffee Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-only analytics dashboard for coffee order cycles with tier tracking, cycle trends, friend segmentation, and a scenario simulator.

**Architecture:** Single backend endpoint (`GET /api/analytics/coffee`) computes all metrics from existing tables and returns a structured JSON response. Frontend page at `/admin/analytics/coffee` renders the data using Chart.js charts and shadcn-vue components. A placeholder page at `/admin/analytics/bakery` is added for future use.

**Tech Stack:** Chart.js + vue-chartjs for charts, existing shadcn-vue components for UI, sql.js queries for backend computation.

**Spec:** `docs/coffee-analytics-spec.md`

---

## File Structure

### Backend (create)
- `backend/src/helpers/analytics.js` — Pure computation helpers: weight calculation, tier logic, margin formula, friend segmentation. No DB access.
- `backend/src/routes/analytics.js` — Express route. Queries DB, calls helpers, returns JSON.

### Backend (modify)
- `backend/src/index.js` — Register analytics route.

### Frontend (create)
- `frontend/src/views/CoffeeAnalytics.vue` — Main analytics page with all sections.
- `frontend/src/views/BakeryAnalytics.vue` — Placeholder page.
- `frontend/src/components/analytics/CycleTrendsChart.vue` — Bar+line chart for kg and friends over cycles.
- `frontend/src/components/analytics/MarginChart.vue` — Area chart for cumulative margin.
- `frontend/src/components/analytics/SegmentDonutChart.vue` — Donut chart for friend segments.
- `frontend/src/components/analytics/BuyerFlowChart.vue` — Stacked bar chart for retention/churn per cycle transition.
- `frontend/src/components/analytics/FriendAnalyticsTable.vue` — Sortable, filterable friend table.

### Frontend (modify)
- `frontend/package.json` — Add chart.js, vue-chartjs.
- `frontend/src/api.js` — Add `getCoffeeAnalytics()` method.
- `frontend/src/router.js` — Add `/admin/analytics/coffee` and `/admin/analytics/bakery` routes.
- `frontend/src/views/AdminDashboard.vue` — Add "Štatistiky" nav button.

---

## Task 1: Install dependencies and create backend analytics helpers

**Files:**
- Modify: `frontend/package.json`
- Create: `backend/src/helpers/analytics.js`

- [ ] **Step 1: Install chart.js and vue-chartjs**

```bash
cd frontend && npm install chart.js vue-chartjs
```

- [ ] **Step 2: Create analytics helpers file**

Create `backend/src/helpers/analytics.js` with all pure computation functions:

```javascript
// Tier thresholds: kg → discount percentage
export const TIER_THRESHOLDS = [
  { minKg: 51, discount: 0.40, label: '40%' },
  { minKg: 26, discount: 0.35, label: '35%' },
  { minKg: 5,  discount: 0.30, label: '30%' },
];

// Buyer discount rate (what friends pay relative to retail)
export const BUYER_DISCOUNT = 0.30;

/**
 * Compute weight in kg from order_items variant and quantity.
 * SQL CASE equivalent for use in JS aggregation.
 */
export function variantToKg(variant, quantity) {
  const map = {
    '250g':   0.250,
    '1kg':    1.000,
    '150g':   0.150,
    '200g':   0.200,
    '20pc5g': 0.100, // 20 capsules × 5g = 100g
  };
  return (map[variant] || 0) * quantity;
}

/**
 * Determine which tier a given total kg falls into.
 * Returns { discount, label, minKg } or null if below minimum.
 */
export function getTier(totalKg) {
  for (const tier of TIER_THRESHOLDS) {
    if (totalKg >= tier.minKg) return tier;
  }
  return null;
}

/**
 * Compute operator margin for a cycle.
 * Formula: margin = totalOrderValue × (1 - (1 - tierDiscount) / (1 - BUYER_DISCOUNT))
 * At 30% tier (same as buyer price): margin = 0
 * At 35% tier: cost ratio = 0.65/0.70 ≈ 0.9286, margin ≈ 7.14%
 * At 40% tier: cost ratio = 0.60/0.70 ≈ 0.8571, margin ≈ 14.29%
 */
export function computeMargin(totalOrderValue, totalKg) {
  const tier = getTier(totalKg);
  if (!tier || tier.discount <= BUYER_DISCOUNT) return 0;
  return totalOrderValue * (1 - (1 - tier.discount) / (1 - BUYER_DISCOUNT));
}

/**
 * Get the next tier above current kg, or null if at max.
 */
export function getNextTier(totalKg) {
  // Tiers sorted descending by minKg
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalKg < TIER_THRESHOLDS[i].minKg) {
      return TIER_THRESHOLDS[i];
    }
  }
  return null; // Already at max tier
}

/**
 * Classify a friend into a segment based on their order history.
 * @param {number[]} orderedCycleIds - cycle IDs where friend has submitted orders (chronological)
 * @param {number[]} lastNCycleIds - the last N completed coffee cycle IDs (chronological)
 * @param {boolean} isActive - friends.active flag
 * @param {number} totalCoffeeCycles - total completed coffee cycles
 */
export function classifyFriend(orderedCycleIds, lastNCycleIds, isActive, totalCoffeeCycles) {
  if (!isActive) return { segment: 'inactive', label: 'Neaktívny', color: 'gray' };

  const n = lastNCycleIds.length; // typically 3, but could be fewer
  if (n === 0) return { segment: 'new', label: 'Nový', color: 'purple' };

  const recentCount = orderedCycleIds.filter(id => lastNCycleIds.includes(id)).length;
  const totalParticipated = orderedCycleIds.length;

  // New: only 1 or 2 cycles of history total
  if (totalParticipated <= 2 && totalCoffeeCycles > 2) {
    return { segment: 'new', label: 'Nový', color: 'purple' };
  }

  // Check last 2 cycles for inactive
  const last2 = lastNCycleIds.slice(-2);
  const recentCount2 = orderedCycleIds.filter(id => last2.includes(id)).length;
  if (recentCount2 === 0 && totalParticipated > 0) {
    return { segment: 'inactive', label: 'Neaktívny', color: 'gray' };
  }

  // Core: ordered in all of last N cycles
  if (recentCount === n) {
    return { segment: 'core', label: 'Jadro', color: 'green' };
  }

  // Regular: ordered in N-1 of last N (or 2 of 3)
  if (n >= 2 && recentCount >= n - 1) {
    return { segment: 'regular', label: 'Pravidelný', color: 'blue' };
  }

  // Occasional: ordered in at least 1 of last N
  if (recentCount >= 1) {
    return { segment: 'occasional', label: 'Občasný', color: 'amber' };
  }

  return { segment: 'inactive', label: 'Neaktívny', color: 'gray' };
}

/**
 * Compute consecutive streak of recent cycles a friend ordered in.
 * @param {number[]} orderedCycleIds - cycle IDs with submitted orders
 * @param {number[]} allCycleIds - all completed coffee cycle IDs (chronological)
 */
export function computeStreak(orderedCycleIds, allCycleIds) {
  let streak = 0;
  for (let i = allCycleIds.length - 1; i >= 0; i--) {
    if (orderedCycleIds.includes(allCycleIds[i])) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Determine order trend: 'up', 'down', or 'flat'.
 * Compares last two order kg values.
 */
export function computeTrend(orderKgByycle) {
  if (orderKgByycle.length < 2) return null;
  const last = orderKgByycle[orderKgByycle.length - 1];
  const prev = orderKgByycle[orderKgByycle.length - 2];
  if (last > prev * 1.05) return 'up';
  if (last < prev * 0.95) return 'down';
  return 'flat';
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json backend/src/helpers/analytics.js
git commit -m "feat(analytics): install chart.js and add analytics computation helpers"
```

---

## Task 2: Backend analytics endpoint

**Files:**
- Create: `backend/src/routes/analytics.js`
- Modify: `backend/src/index.js`

- [ ] **Step 1: Create the analytics route file**

Create `backend/src/routes/analytics.js`:

```javascript
import { Router } from 'express';
import db from '../db/schema.js';
import {
  variantToKg, getTier, getNextTier, computeMargin,
  classifyFriend, computeStreak, computeTrend,
  TIER_THRESHOLDS, BUYER_DISCOUNT
} from '../helpers/analytics.js';

const router = Router();

// Admin auth check — reuse pattern from admin.js
function requireAdmin(req, res) {
  const token = req.headers['x-admin-token'];
  if (!token) {
    res.status(401).json({ error: 'Vyžaduje sa prihlásenie admina' });
    return false;
  }
  const session = db.get(
    "SELECT value FROM settings WHERE key = 'admin_token'"
  );
  if (!session || session.value !== token) {
    res.status(401).json({ error: 'Neplatný admin token' });
    return false;
  }
  return true;
}

// GET /api/analytics/coffee — all coffee analytics in one response
router.get('/coffee', (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    // 1. Get all coffee cycles (completed or locked), chronological
    const cycles = db.all(`
      SELECT id, name, status, type, created_at, expected_date, markup_ratio
      FROM order_cycles
      WHERE type = 'coffee' AND status IN ('completed', 'locked')
      ORDER BY created_at ASC
    `);

    const cycleIds = cycles.map(c => c.id);
    if (cycleIds.length === 0) {
      return res.json({ cycles: [], friends: [], summary: {} });
    }

    // 2. Get all submitted orders for coffee cycles with items
    const orders = db.all(`
      SELECT
        o.id AS order_id,
        o.friend_id,
        o.cycle_id,
        o.total AS order_value,
        o.submitted_at
      FROM orders o
      JOIN order_cycles oc ON oc.id = o.cycle_id
      WHERE o.status = 'submitted'
        AND oc.type = 'coffee'
        AND oc.status IN ('completed', 'locked')
      ORDER BY oc.created_at ASC
    `);

    const items = db.all(`
      SELECT
        oi.order_id,
        oi.variant,
        oi.quantity,
        oi.price
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN order_cycles oc ON oc.id = o.cycle_id
      WHERE o.status = 'submitted'
        AND oc.type = 'coffee'
        AND oc.status IN ('completed', 'locked')
    `);

    // 3. Get all friends
    const friends = db.all(`
      SELECT id, name, display_name, active
      FROM friends
    `);

    // Build item lookup: order_id → items[]
    const itemsByOrder = {};
    for (const item of items) {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    }

    // Build order lookup: cycle_id → orders[]
    const ordersByCycle = {};
    for (const order of orders) {
      if (!ordersByCycle[order.cycle_id]) ordersByCycle[order.cycle_id] = [];
      order.kg = 0;
      const orderItems = itemsByOrder[order.order_id] || [];
      for (const item of orderItems) {
        order.kg += variantToKg(item.variant, item.quantity);
      }
      ordersByCycle[order.cycle_id].push(order);
    }

    // Build friend → cycle participation map
    // friendId → { cycleIds: Set, orderKgByCycle: [{cycleId, kg}] }
    const friendParticipation = {};
    for (const order of orders) {
      if (!friendParticipation[order.friend_id]) {
        friendParticipation[order.friend_id] = { cycleIds: new Set(), orderKgByCycle: [] };
      }
      friendParticipation[order.friend_id].cycleIds.add(order.cycle_id);
      friendParticipation[order.friend_id].orderKgByCycle.push({
        cycleId: order.cycle_id,
        kg: order.kg,
        value: order.order_value
      });
    }

    // 4. Compute per-cycle stats
    const cycleStats = [];
    let prevFriendIds = new Set();

    for (let i = 0; i < cycles.length; i++) {
      const cycle = cycles[i];
      const cycleOrders = ordersByCycle[cycle.id] || [];
      const friendIds = new Set(cycleOrders.map(o => o.friend_id));
      const totalKg = cycleOrders.reduce((sum, o) => sum + o.kg, 0);
      const totalValue = cycleOrders.reduce((sum, o) => sum + o.order_value, 0);
      const numFriends = friendIds.size;
      const tier = getTier(totalKg);
      const margin = computeMargin(totalValue, totalKg);

      // New / returning / churned (vs previous cycle)
      let newFriends = 0;
      let returningFriends = 0;
      let churnedFriends = 0;

      if (i > 0) {
        for (const fid of friendIds) {
          if (prevFriendIds.has(fid)) {
            returningFriends++;
          } else {
            newFriends++;
          }
        }
        for (const fid of prevFriendIds) {
          if (!friendIds.has(fid)) {
            churnedFriends++;
          }
        }
      } else {
        newFriends = numFriends;
      }

      cycleStats.push({
        id: cycle.id,
        name: cycle.name,
        status: cycle.status,
        created_at: cycle.created_at,
        expected_date: cycle.expected_date,
        markup_ratio: cycle.markup_ratio || 1.0,
        num_friends: numFriends,
        total_kg: Math.round(totalKg * 10) / 10,
        total_value: Math.round(totalValue * 100) / 100,
        avg_kg_per_person: numFriends > 0 ? Math.round((totalKg / numFriends) * 10) / 10 : 0,
        avg_value_per_person: numFriends > 0 ? Math.round((totalValue / numFriends) * 100) / 100 : 0,
        tier_discount: tier ? tier.discount : null,
        tier_label: tier ? tier.label : null,
        operator_margin: Math.round(margin * 100) / 100,
        new_friends: newFriends,
        returning_friends: returningFriends,
        churned_friends: churnedFriends,
      });

      prevFriendIds = friendIds;
    }

    // 5. Compute per-friend stats
    const lookbackCount = Math.min(3, cycleIds.length);
    const lastNCycleIds = cycleIds.slice(-lookbackCount);
    const lastCycleId = cycleIds[cycleIds.length - 1];

    const friendStats = [];
    for (const friend of friends) {
      const participation = friendParticipation[friend.id];
      if (!participation) {
        // Friend never ordered coffee — skip unless active
        if (friend.active) {
          friendStats.push({
            id: friend.id,
            name: friend.display_name || friend.name,
            active: !!friend.active,
            cycles_participated: 0,
            total_cycles: cycleIds.length,
            participation_rate: 0,
            total_kg: 0,
            avg_kg_per_cycle: 0,
            avg_value_per_cycle: 0,
            last_active_cycle_id: null,
            last_active_cycle_name: null,
            streak: 0,
            trend: null,
            segment: classifyFriend([], lastNCycleIds, !!friend.active, cycleIds.length),
          });
        }
        continue;
      }

      const orderedCycleIds = [...participation.cycleIds].sort((a, b) => {
        return cycleIds.indexOf(a) - cycleIds.indexOf(b);
      });
      const cyclesParticipated = orderedCycleIds.length;

      // Total cycles since first order
      const firstOrderCycleIndex = cycleIds.indexOf(orderedCycleIds[0]);
      const totalCyclesSinceFirst = cycleIds.length - firstOrderCycleIndex;

      const totalKg = participation.orderKgByCycle.reduce((sum, o) => sum + o.kg, 0);
      const totalValue = participation.orderKgByCycle.reduce((sum, o) => sum + o.value, 0);

      const lastOrderEntry = participation.orderKgByCycle
        .sort((a, b) => cycleIds.indexOf(a.cycleId) - cycleIds.indexOf(b.cycleId))
        .at(-1);
      const lastActiveCycle = lastOrderEntry
        ? cycles.find(c => c.id === lastOrderEntry.cycleId)
        : null;

      const kgByCycle = participation.orderKgByCycle
        .sort((a, b) => cycleIds.indexOf(a.cycleId) - cycleIds.indexOf(b.cycleId))
        .map(o => o.kg);

      friendStats.push({
        id: friend.id,
        name: friend.display_name || friend.name,
        active: !!friend.active,
        cycles_participated: cyclesParticipated,
        total_cycles: totalCyclesSinceFirst,
        participation_rate: totalCyclesSinceFirst > 0
          ? Math.round((cyclesParticipated / totalCyclesSinceFirst) * 100)
          : 0,
        total_kg: Math.round(totalKg * 10) / 10,
        avg_kg_per_cycle: cyclesParticipated > 0
          ? Math.round((totalKg / cyclesParticipated) * 10) / 10
          : 0,
        avg_value_per_cycle: cyclesParticipated > 0
          ? Math.round((totalValue / cyclesParticipated) * 100) / 100
          : 0,
        last_active_cycle_id: lastActiveCycle?.id || null,
        last_active_cycle_name: lastActiveCycle?.name || null,
        streak: computeStreak(orderedCycleIds, cycleIds),
        trend: computeTrend(kgByCycle),
        segment: classifyFriend(orderedCycleIds, lastNCycleIds, !!friend.active, cycleIds.length),
      });
    }

    // 6. Compute summary metrics
    const recentCycles = cycleStats.slice(-3);
    const rollingAvgKg = recentCycles.length > 0
      ? recentCycles.reduce((sum, c) => sum + c.total_kg, 0) / recentCycles.length
      : 0;

    const avgKgPerPerson = recentCycles.length > 0
      ? recentCycles.reduce((sum, c) => sum + c.avg_kg_per_person, 0) / recentCycles.length
      : 0;

    const currentTier = getTier(rollingAvgKg);
    const nextTier = getNextTier(rollingAvgKg);
    const distanceToNextTier = nextTier ? nextTier.minKg - rollingAvgKg : 0;
    const friendsNeeded = avgKgPerPerson > 0 && nextTier
      ? Math.ceil(distanceToNextTier / avgKgPerPerson)
      : null;

    const tierHitRate35 = cycleStats.filter(c => c.tier_discount && c.tier_discount >= 0.35).length;

    const cumulativeMarginAll = cycleStats.reduce((sum, c) => sum + c.operator_margin, 0);

    // Last 12 months
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const cumulativeMargin12m = cycleStats
      .filter(c => new Date(c.created_at) >= twelveMonthsAgo)
      .reduce((sum, c) => sum + c.operator_margin, 0);

    // Top 5 concentration (last cycle)
    const lastCycleOrders = ordersByCycle[lastCycleId] || [];
    const lastCycleTotalKg = lastCycleOrders.reduce((sum, o) => sum + o.kg, 0);
    const friendKgInLastCycle = {};
    for (const o of lastCycleOrders) {
      friendKgInLastCycle[o.friend_id] = (friendKgInLastCycle[o.friend_id] || 0) + o.kg;
    }
    const sortedFriendKg = Object.values(friendKgInLastCycle).sort((a, b) => b - a);
    const top5Kg = sortedFriendKg.slice(0, 5).reduce((sum, kg) => sum + kg, 0);
    const top5Share = lastCycleTotalKg > 0
      ? Math.round((top5Kg / lastCycleTotalKg) * 100)
      : 0;

    // Minimum viable base
    const coreAndRegular = friendStats.filter(
      f => f.segment.segment === 'core' || f.segment.segment === 'regular'
    );
    const coreRegularAvgKg = coreAndRegular.length > 0
      ? coreAndRegular.reduce((sum, f) => sum + f.avg_kg_per_cycle, 0) / coreAndRegular.length
      : 0;
    const minViableBase = coreRegularAvgKg > 0
      ? Math.ceil(26 / coreRegularAvgKg)
      : null;

    const summary = {
      rolling_avg_kg_3: Math.round(rollingAvgKg * 10) / 10,
      avg_kg_per_person: Math.round(avgKgPerPerson * 10) / 10,
      current_tier: currentTier ? { discount: currentTier.discount, label: currentTier.label } : null,
      next_tier: nextTier ? { discount: nextTier.discount, label: nextTier.label, min_kg: nextTier.minKg } : null,
      distance_to_next_tier: Math.round(distanceToNextTier * 10) / 10,
      friends_needed_for_next_tier: friendsNeeded,
      tier_hit_rate_35: tierHitRate35,
      total_cycles: cycleStats.length,
      cumulative_margin_all: Math.round(cumulativeMarginAll * 100) / 100,
      cumulative_margin_12m: Math.round(cumulativeMargin12m * 100) / 100,
      top5_share: top5Share,
      concentration_warning: top5Share > 40,
      min_viable_base: minViableBase,
      core_regular_count: coreAndRegular.length,
      core_regular_avg_kg: Math.round(coreRegularAvgKg * 10) / 10,
      tier_thresholds: TIER_THRESHOLDS.map(t => ({ min_kg: t.minKg, discount: t.discount, label: t.label })),
      buyer_discount: BUYER_DISCOUNT,
    };

    res.json({
      cycles: cycleStats,
      friends: friendStats,
      summary,
    });
  } catch (e) {
    console.error('Analytics error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
```

- [ ] **Step 2: Register the route in index.js**

In `backend/src/index.js`, add the import alongside other route imports:

```javascript
import analyticsRouter from './routes/analytics.js';
```

And register it alongside other routes:

```javascript
app.use('/api/analytics', analyticsRouter);
```

- [ ] **Step 3: Verify the backend starts**

```bash
cd backend && npm run dev
```

Open a second terminal and test with curl (use a valid admin token from the app):

```bash
curl -H "X-Admin-Token: YOUR_TOKEN" http://localhost:3000/api/analytics/coffee | head -c 500
```

Expected: JSON response with `cycles`, `friends`, `summary` keys.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/analytics.js backend/src/index.js
git commit -m "feat(analytics): add backend analytics endpoint for coffee cycles"
```

---

## Task 3: Frontend setup — API, router, navigation, page shells

**Files:**
- Modify: `frontend/src/api.js`
- Modify: `frontend/src/router.js`
- Modify: `frontend/src/views/AdminDashboard.vue`
- Create: `frontend/src/views/CoffeeAnalytics.vue` (shell)
- Create: `frontend/src/views/BakeryAnalytics.vue`

- [ ] **Step 1: Add API method**

In `frontend/src/api.js`, add to the `api` object (inside the export, alongside other methods):

```javascript
  // Analytics
  getCoffeeAnalytics: () => adminRequest('/analytics/coffee'),
```

- [ ] **Step 2: Add routes**

In `frontend/src/router.js`, add two routes after the `admin-bakery-products` route (before `admin-friends`):

```javascript
  {
    path: '/admin/analytics/coffee',
    name: 'analytics-coffee',
    component: () => import('./views/CoffeeAnalytics.vue')
  },
  {
    path: '/admin/analytics/bakery',
    name: 'analytics-bakery',
    component: () => import('./views/BakeryAnalytics.vue')
  },
```

- [ ] **Step 3: Add navigation button to AdminDashboard.vue**

In `frontend/src/views/AdminDashboard.vue`, inside the header `<div class="flex items-center gap-2">`, add a "Štatistiky" button before the "Priatelia" button:

```vue
      <Button variant="ghost" @click="router.push('/admin/analytics/coffee')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
        Štatistiky
      </Button>
```

- [ ] **Step 4: Create BakeryAnalytics.vue placeholder**

Create `frontend/src/views/BakeryAnalytics.vue`:

```vue
<script setup>
import { watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

const router = useRouter()

watchEffect(() => {
  document.title = 'Štatistiky pekáreň - Gorifi Admin'
})
</script>

<template>
  <div class="min-h-screen bg-background">
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="router.push('/admin/dashboard')" class="text-primary-foreground hover:bg-primary-foreground/10">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </Button>
          <h1 class="text-xl font-bold">Štatistiky</h1>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex gap-2 mb-6">
        <Button variant="outline" @click="router.push('/admin/analytics/coffee')">Káva</Button>
        <Button variant="default">Pekáreň</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Štatistiky pekárne</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-muted-foreground">Pripravujeme — štatistiky pre pekáreň budú dostupné čoskoro.</p>
        </CardContent>
      </Card>
    </main>
  </div>
</template>
```

- [ ] **Step 5: Create CoffeeAnalytics.vue shell**

Create `frontend/src/views/CoffeeAnalytics.vue` with loading state and data fetch:

```vue
<script setup>
import { ref, watchEffect, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const data = ref(null) // { cycles, friends, summary }

watchEffect(() => {
  document.title = 'Štatistiky káva - Gorifi Admin'
})

onMounted(async () => {
  try {
    data.value = await api.getCoffeeAnalytics()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="min-h-screen bg-background">
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="router.push('/admin/dashboard')" class="text-primary-foreground hover:bg-primary-foreground/10">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </Button>
          <h1 class="text-xl font-bold">Štatistiky</h1>
        </div>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex gap-2 mb-6">
        <Button variant="default">Káva</Button>
        <Button variant="outline" @click="router.push('/admin/analytics/bakery')">Pekáreň</Button>
      </div>

      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <div v-else-if="data && data.cycles.length === 0" class="text-center py-12 text-muted-foreground">
        Žiadne dokončené kávové cykly na analýzu.
      </div>

      <div v-else-if="data" class="space-y-8">
        <!-- Sections will be added in subsequent tasks -->
        <p class="text-muted-foreground">Analytics data loaded: {{ data.cycles.length }} cycles, {{ data.friends.length }} friends.</p>
      </div>
    </main>
  </div>
</template>
```

- [ ] **Step 6: Verify frontend compiles and page loads**

```bash
cd frontend && npm run dev
```

Navigate to `http://localhost:5173/admin/analytics/coffee` (after logging in as admin). Verify:
- Page loads without errors
- Tab switcher shows "Káva" (active) and "Pekáreň"
- Data loads (shows cycle/friend count)
- Back button goes to dashboard
- "Štatistiky" button appears in dashboard header

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.js frontend/src/router.js frontend/src/views/AdminDashboard.vue frontend/src/views/CoffeeAnalytics.vue frontend/src/views/BakeryAnalytics.vue
git commit -m "feat(analytics): add analytics page shells with routing and navigation"
```

---

## Task 4: Tier progress card and growth roadmap (Feature 3.1, 3.4)

**Files:**
- Modify: `frontend/src/views/CoffeeAnalytics.vue`

- [ ] **Step 1: Add tier progress card and growth roadmap to CoffeeAnalytics.vue**

In the `<script setup>` section, add:

```javascript
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
```

Replace the placeholder `<p>` inside `<div v-else-if="data" class="space-y-8">` with:

```vue
        <!-- Section: Tier Progress (Feature 3.1) -->
        <Card>
          <CardHeader>
            <CardTitle>Postup k ďalšej úrovni zľavy</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="space-y-4">
              <!-- Rolling average display -->
              <div class="text-center">
                <div class="text-4xl font-bold">{{ data.summary.rolling_avg_kg_3 }} kg</div>
                <div class="text-sm text-muted-foreground">priemer za posledné {{ Math.min(3, data.cycles.length) }} cykly</div>
              </div>

              <!-- Progress bar with tier markers -->
              <div class="relative pt-8 pb-2">
                <!-- Tier labels above bar -->
                <div class="absolute top-0 left-0 w-full flex text-xs text-muted-foreground">
                  <div :style="{ left: tierPosition(5) + '%' }" class="absolute transform -translate-x-1/2">
                    <div class="text-center">30%</div>
                    <div>5 kg</div>
                  </div>
                  <div :style="{ left: tierPosition(26) + '%' }" class="absolute transform -translate-x-1/2">
                    <div class="text-center font-semibold text-blue-600">35%</div>
                    <div>26 kg</div>
                  </div>
                  <div :style="{ left: tierPosition(51) + '%' }" class="absolute transform -translate-x-1/2">
                    <div class="text-center font-semibold text-green-600">40%</div>
                    <div>51 kg</div>
                  </div>
                </div>

                <!-- Bar background -->
                <div class="h-4 bg-muted rounded-full relative overflow-hidden">
                  <!-- Filled portion -->
                  <div
                    class="h-full rounded-full transition-all duration-500"
                    :class="progressBarColor"
                    :style="{ width: Math.min(tierPosition(data.summary.rolling_avg_kg_3), 100) + '%' }"
                  ></div>

                  <!-- Tier threshold markers -->
                  <div class="absolute top-0 h-full w-0.5 bg-border" :style="{ left: tierPosition(26) + '%' }"></div>
                  <div class="absolute top-0 h-full w-0.5 bg-border" :style="{ left: tierPosition(51) + '%' }"></div>
                </div>
              </div>

              <!-- Distance to next tier -->
              <div v-if="data.summary.next_tier" class="text-center space-y-1">
                <p class="text-sm">
                  Do úrovne <span class="font-semibold">{{ data.summary.next_tier.label }}</span> chýba
                  <span class="font-bold text-lg">{{ data.summary.distance_to_next_tier }} kg</span>
                </p>
                <p v-if="data.summary.friends_needed_for_next_tier" class="text-sm text-muted-foreground">
                  To je približne <span class="font-semibold">{{ data.summary.friends_needed_for_next_tier }}</span>
                  {{ data.summary.friends_needed_for_next_tier === 1 ? 'nový priateľ' : 'noví priatelia' }}
                  pri priemernom odbere {{ data.summary.avg_kg_per_person }} kg/osobu
                </p>
              </div>
              <div v-else class="text-center">
                <Badge variant="default" class="bg-green-600">Maximálna úroveň zľavy dosiahnutá!</Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Section: Growth Roadmap (Feature 3.4) -->
        <Card>
          <CardHeader>
            <CardTitle>Míľniky</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="space-y-3">
              <div v-for="milestone in milestones" :key="milestone.label" class="flex items-start gap-3">
                <div class="mt-0.5 text-lg">{{ milestone.done ? '☑' : '☐' }}</div>
                <div>
                  <div :class="milestone.done ? 'line-through text-muted-foreground' : 'font-medium'">
                    {{ milestone.label }}
                  </div>
                  <div v-if="!milestone.done && milestone.note" class="text-sm text-muted-foreground">
                    {{ milestone.note }}
                  </div>
                  <div v-if="milestone.done" class="text-sm text-muted-foreground">Dosiahnuté</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
```

In the `<script setup>`, add computed helpers:

```javascript
import { ref, computed, watchEffect, onMounted } from 'vue'

// Tier progress bar position: map kg to percentage (bar max = 60 kg for visual space)
const PROGRESS_BAR_MAX = 60
function tierPosition(kg) {
  return Math.min((kg / PROGRESS_BAR_MAX) * 100, 100)
}

const progressBarColor = computed(() => {
  if (!data.value) return 'bg-muted'
  const kg = data.value.summary.rolling_avg_kg_3
  if (kg >= 51) return 'bg-green-500'
  if (kg >= 26) return 'bg-blue-500'
  return 'bg-amber-500'
})

const milestones = computed(() => {
  if (!data.value) return []
  const avg = data.value.summary.rolling_avg_kg_3
  const needed = data.value.summary.friends_needed_for_next_tier
  return [
    {
      label: 'Dosiahnuť 5 kg (veľkoobchodná cena, 30% zľava)',
      done: avg >= 5,
    },
    {
      label: 'Dosiahnuť 26 kg stabilne (35% zľava → 5% marža)',
      done: avg >= 26,
      note: avg < 26 && needed ? `ešte ~${needed} priateľov` : null,
    },
    {
      label: 'Dosiahnuť 51 kg (40% zľava → 10% marža)',
      done: avg >= 51,
      note: avg < 51 && avg >= 26
        ? `ešte ~${Math.ceil((51 - avg) / (data.value.summary.avg_kg_per_person || 1))} priateľov`
        : null,
    },
  ]
})
```

- [ ] **Step 2: Verify tier progress card renders**

In browser, check:
- Progress bar shows current rolling average
- Tier markers at 26 kg and 51 kg are visible
- Distance message shows how many kg and friends are needed
- Milestones show correct done/todo state

- [ ] **Step 3: Commit**

```bash
git add frontend/src/views/CoffeeAnalytics.vue
git commit -m "feat(analytics): add tier progress card and growth roadmap"
```

---

## Task 5: Scenario simulator (Feature 3.3)

**Files:**
- Modify: `frontend/src/views/CoffeeAnalytics.vue`

- [ ] **Step 1: Add scenario simulator section**

Add the following imports at the top of `<script setup>`:

```javascript
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
```

Add reactive state for the simulator:

```javascript
// Scenario simulator state
const simFriends = ref(0)
const simAvgKg = ref(0)

// Initialize simulator defaults after data loads
function initSimulator() {
  if (!data.value) return
  simFriends.value = data.value.summary.rolling_avg_kg_3 > 0
    ? Math.round(data.value.cycles.at(-1)?.num_friends || 0)
    : 20
  simAvgKg.value = data.value.summary.avg_kg_per_person || 1.0
}

const simProjectedKg = computed(() => simFriends.value * simAvgKg.value)

const simTier = computed(() => {
  const kg = simProjectedKg.value
  if (kg >= 51) return { discount: 0.40, label: '40%' }
  if (kg >= 26) return { discount: 0.35, label: '35%' }
  if (kg >= 5) return { discount: 0.30, label: '30%' }
  return null
})

const simMargin = computed(() => {
  if (!simTier.value || simTier.value.discount <= 0.30) return 0
  // Estimate total value from kg: use current avg price/kg from data
  const lastCycle = data.value?.cycles.at(-1)
  const avgPricePerKg = lastCycle && lastCycle.total_kg > 0
    ? lastCycle.total_value / lastCycle.total_kg
    : 43 // fallback
  const totalValue = simProjectedKg.value * avgPricePerKg
  return totalValue * (1 - (1 - simTier.value.discount) / (1 - 0.30))
})
```

Update `onMounted` to call `initSimulator()`:

```javascript
onMounted(async () => {
  try {
    data.value = await api.getCoffeeAnalytics()
    initSimulator()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})
```

Add the simulator template after the Growth Roadmap card:

```vue
        <!-- Section: Scenario Simulator (Feature 3.3) -->
        <Card>
          <CardHeader>
            <CardTitle>Simulátor scenárov</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <!-- Inputs -->
              <div class="space-y-4">
                <div>
                  <Label>Počet priateľov</Label>
                  <div class="flex items-center gap-3 mt-1">
                    <input
                      type="range"
                      v-model.number="simFriends"
                      :min="1" :max="80" :step="1"
                      class="flex-1"
                    />
                    <Input
                      type="number"
                      v-model.number="simFriends"
                      class="w-20"
                      :min="1" :max="200"
                    />
                  </div>
                </div>
                <div>
                  <Label>Priemerný odber (kg/osobu)</Label>
                  <div class="flex items-center gap-3 mt-1">
                    <input
                      type="range"
                      v-model.number="simAvgKg"
                      :min="0.1" :max="3" :step="0.1"
                      class="flex-1"
                    />
                    <Input
                      type="number"
                      v-model.number="simAvgKg"
                      class="w-20"
                      :min="0.1" :max="10" :step="0.1"
                    />
                  </div>
                </div>
              </div>

              <!-- Results -->
              <div class="space-y-3">
                <div class="p-4 rounded-lg" :class="simTier && simTier.discount >= 0.35 ? 'bg-green-50 border border-green-200' : 'bg-muted'">
                  <div class="text-sm text-muted-foreground">Celkový objem</div>
                  <div class="text-2xl font-bold">{{ simProjectedKg.toFixed(1) }} kg</div>
                </div>
                <div class="p-4 rounded-lg bg-muted">
                  <div class="text-sm text-muted-foreground">Úroveň zľavy</div>
                  <div class="text-2xl font-bold">
                    {{ simTier ? simTier.label : '—' }}
                    <span v-if="simTier && data.summary.current_tier" class="text-sm font-normal text-muted-foreground">
                      (teraz {{ data.summary.current_tier.label }})
                    </span>
                  </div>
                </div>
                <div class="p-4 rounded-lg" :class="simMargin > 0 ? 'bg-green-50 border border-green-200' : 'bg-muted'">
                  <div class="text-sm text-muted-foreground">Odhadovaná marža za cyklus</div>
                  <div class="text-2xl font-bold">{{ simMargin.toFixed(2) }} €</div>
                  <div v-if="simMargin > 0" class="text-sm text-muted-foreground">~{{ (simMargin * 12).toFixed(0) }} €/rok</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
```

- [ ] **Step 2: Verify simulator works**

In browser:
- Sliders and inputs are synced
- Results update live when moving sliders
- Tier label changes at 26 kg and 51 kg thresholds
- Margin is €0 at 30% tier, positive at 35%+

- [ ] **Step 3: Commit**

```bash
git add frontend/src/views/CoffeeAnalytics.vue
git commit -m "feat(analytics): add scenario simulator with tier and margin projection"
```

---

## Task 6: Cycle trends chart and comparison cards (Feature 1.1, 1.2)

**Files:**
- Create: `frontend/src/components/analytics/CycleTrendsChart.vue`
- Modify: `frontend/src/views/CoffeeAnalytics.vue`

- [ ] **Step 1: Create CycleTrendsChart component**

Create `frontend/src/components/analytics/CycleTrendsChart.vue`:

```vue
<script setup>
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, PointElement,
  LineElement, LineController, BarController, Title, Tooltip, Legend, Filler
} from 'chart.js'

ChartJS.register(
  CategoryScale, LinearScale, BarElement, PointElement,
  LineElement, LineController, BarController, Title, Tooltip, Legend, Filler
)

const props = defineProps({
  cycles: { type: Array, required: true }
})

const chartData = computed(() => {
  const labels = props.cycles.map(c => {
    // Extract short label from cycle name or created_at
    const date = new Date(c.created_at)
    return date.toLocaleDateString('sk-SK', { month: 'short', year: 'numeric' })
  })

  return {
    labels,
    datasets: [
      {
        type: 'bar',
        label: 'Celkové kg',
        data: props.cycles.map(c => c.total_kg),
        backgroundColor: props.cycles.map(c =>
          c.total_kg >= 51 ? 'rgba(34, 197, 94, 0.7)' :
          c.total_kg >= 26 ? 'rgba(59, 130, 246, 0.7)' :
          'rgba(245, 158, 11, 0.7)'
        ),
        borderRadius: 4,
        yAxisID: 'y',
        order: 2,
      },
      {
        type: 'line',
        label: 'Počet priateľov',
        data: props.cycles.map(c => c.num_friends),
        borderColor: 'rgb(99, 102, 241)',
        backgroundColor: 'rgba(99, 102, 241, 0.1)',
        borderWidth: 2,
        pointRadius: 4,
        pointBackgroundColor: 'rgb(99, 102, 241)',
        yAxisID: 'y1',
        order: 1,
      },
    ]
  }
})

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: 'index',
    intersect: false,
  },
  plugins: {
    legend: {
      position: 'top',
    },
    tooltip: {
      callbacks: {
        afterBody(context) {
          const idx = context[0].dataIndex
          const cycle = props.cycles[idx]
          return [
            `Priemerné kg/osobu: ${cycle.avg_kg_per_person}`,
            `Celková hodnota: ${cycle.total_value.toFixed(2)} €`,
            `Priemer/osobu: ${cycle.avg_value_per_person.toFixed(2)} €`,
            `Úroveň: ${cycle.tier_label || '—'}`,
            `Marža: ${cycle.operator_margin.toFixed(2)} €`,
          ]
        }
      }
    }
  },
  scales: {
    y: {
      type: 'linear',
      position: 'left',
      title: { display: true, text: 'kg' },
      beginAtZero: true,
      grid: { display: true },
    },
    y1: {
      type: 'linear',
      position: 'right',
      title: { display: true, text: 'Priatelia' },
      beginAtZero: true,
      grid: { display: false },
    },
  },
}))

// Annotation plugin not needed — use chartjs-plugin-annotation or manual approach
// For simplicity, draw threshold lines as additional datasets
const chartDataWithThresholds = computed(() => {
  const base = chartData.value
  const len = base.labels.length
  return {
    ...base,
    datasets: [
      ...base.datasets,
      {
        type: 'line',
        label: '35% hranica (26 kg)',
        data: Array(len).fill(26),
        borderColor: 'rgba(59, 130, 246, 0.4)',
        borderDash: [5, 5],
        borderWidth: 1,
        pointRadius: 0,
        yAxisID: 'y',
        order: 3,
      },
      {
        type: 'line',
        label: '40% hranica (51 kg)',
        data: Array(len).fill(51),
        borderColor: 'rgba(34, 197, 94, 0.4)',
        borderDash: [5, 5],
        borderWidth: 1,
        pointRadius: 0,
        yAxisID: 'y',
        order: 3,
      },
    ]
  }
})
</script>

<template>
  <div style="height: 350px;">
    <Bar :data="chartDataWithThresholds" :options="chartOptions" />
  </div>
</template>
```

- [ ] **Step 2: Add the chart and comparison cards to CoffeeAnalytics.vue**

Add import at top of `<script setup>`:

```javascript
import CycleTrendsChart from '../components/analytics/CycleTrendsChart.vue'
```

Add computed for comparison cards:

```javascript
const comparison = computed(() => {
  if (!data.value || data.value.cycles.length < 2) return null
  const curr = data.value.cycles.at(-1)
  const prev = data.value.cycles.at(-2)

  function delta(currVal, prevVal, unit = '', decimals = 1) {
    const diff = currVal - prevVal
    const pct = prevVal !== 0 ? Math.round((diff / prevVal) * 100) : 0
    return {
      current: currVal,
      previous: prevVal,
      diff: Math.round(diff * Math.pow(10, decimals)) / Math.pow(10, decimals),
      pct,
      direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
      unit,
    }
  }

  return {
    cycleName: curr.name,
    prevCycleName: prev.name,
    total_kg: delta(curr.total_kg, prev.total_kg, 'kg'),
    num_friends: delta(curr.num_friends, prev.num_friends, '', 0),
    avg_kg: delta(curr.avg_kg_per_person, prev.avg_kg_per_person, 'kg'),
    margin: delta(curr.operator_margin, prev.operator_margin, '€', 2),
  }
})
```

Add template after the Tier Progress card (before the milestones card):

```vue
        <!-- Section: Cycle Trends Chart (Feature 1.1) -->
        <Card v-if="data.cycles.length >= 2">
          <CardHeader>
            <CardTitle>Vývoj objednávok</CardTitle>
          </CardHeader>
          <CardContent>
            <CycleTrendsChart :cycles="data.cycles" />
          </CardContent>
        </Card>
        <Card v-else>
          <CardHeader>
            <CardTitle>Vývoj objednávok</CardTitle>
          </CardHeader>
          <CardContent>
            <p class="text-muted-foreground">Nedostatok dát pre analýzu trendov — potrebné aspoň 2 dokončené cykly.</p>
          </CardContent>
        </Card>

        <!-- Section: Cycle Comparison Cards (Feature 1.2) -->
        <div v-if="comparison" class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card v-for="(item, key) in { 'Celkové kg': comparison.total_kg, 'Priatelia': comparison.num_friends, 'Priemer kg/os': comparison.avg_kg, 'Marža': comparison.margin }" :key="key">
            <CardContent class="pt-4">
              <div class="text-sm text-muted-foreground">{{ key }}</div>
              <div class="text-2xl font-bold">{{ typeof item.current === 'number' ? item.current.toFixed(item.unit === '€' ? 2 : 1) : item.current }} {{ item.unit }}</div>
              <div class="text-sm" :class="item.direction === 'up' ? 'text-green-600' : item.direction === 'down' ? 'text-red-600' : 'text-muted-foreground'">
                {{ item.direction === 'up' ? '▲' : item.direction === 'down' ? '▼' : '—' }}
                {{ Math.abs(item.pct) }}% vs predchádzajúci
              </div>
            </CardContent>
          </Card>
        </div>
```

- [ ] **Step 3: Verify chart renders with threshold lines**

In browser:
- Chart shows bars (kg) and line (friends count)
- Dashed horizontal lines at 26 and 51 kg
- Tooltips show all cycle metrics
- Comparison cards show deltas with correct colors
- Works with 2 cycles of data

- [ ] **Step 4: Commit**

```bash
mkdir -p frontend/src/components/analytics
git add frontend/src/components/analytics/CycleTrendsChart.vue frontend/src/views/CoffeeAnalytics.vue
git commit -m "feat(analytics): add cycle trends chart and comparison cards"
```

---

## Task 7: Friend segments donut and table (Feature 2.1, 2.2)

**Files:**
- Create: `frontend/src/components/analytics/SegmentDonutChart.vue`
- Create: `frontend/src/components/analytics/FriendAnalyticsTable.vue`
- Modify: `frontend/src/views/CoffeeAnalytics.vue`

- [ ] **Step 1: Create SegmentDonutChart component**

Create `frontend/src/components/analytics/SegmentDonutChart.vue`:

```vue
<script setup>
import { computed } from 'vue'
import { Doughnut } from 'vue-chartjs'
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js'

ChartJS.register(ArcElement, Tooltip, Legend)

const props = defineProps({
  friends: { type: Array, required: true }
})

const SEGMENT_COLORS = {
  core:       { bg: 'rgba(34, 197, 94, 0.7)',  border: 'rgb(34, 197, 94)' },
  regular:    { bg: 'rgba(59, 130, 246, 0.7)',  border: 'rgb(59, 130, 246)' },
  occasional: { bg: 'rgba(245, 158, 11, 0.7)',  border: 'rgb(245, 158, 11)' },
  new:        { bg: 'rgba(168, 85, 247, 0.7)',  border: 'rgb(168, 85, 247)' },
  inactive:   { bg: 'rgba(156, 163, 175, 0.7)', border: 'rgb(156, 163, 175)' },
}

const SEGMENT_ORDER = ['core', 'regular', 'occasional', 'new', 'inactive']

const segments = computed(() => {
  const map = {}
  for (const f of props.friends) {
    const seg = f.segment.segment
    if (!map[seg]) {
      map[seg] = { segment: seg, label: f.segment.label, count: 0, totalKg: 0 }
    }
    map[seg].count++
    map[seg].totalKg += f.total_kg
  }

  const totalKg = props.friends.reduce((sum, f) => sum + f.total_kg, 0)
  return SEGMENT_ORDER
    .filter(s => map[s])
    .map(s => ({
      ...map[s],
      pctVolume: totalKg > 0 ? Math.round((map[s].totalKg / totalKg) * 100) : 0,
    }))
})

const chartData = computed(() => ({
  labels: segments.value.map(s => s.label),
  datasets: [{
    data: segments.value.map(s => s.count),
    backgroundColor: segments.value.map(s => SEGMENT_COLORS[s.segment]?.bg),
    borderColor: segments.value.map(s => SEGMENT_COLORS[s.segment]?.border),
    borderWidth: 2,
  }]
}))

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
  },
  cutout: '60%',
}

// Find insight: which segment has biggest volume share?
const insight = computed(() => {
  const core = segments.value.find(s => s.segment === 'core')
  if (core && core.pctVolume > 0) {
    return `Tvoje jadro (${core.count} ľudí) tvorí ${core.pctVolume}% celkového objemu`
  }
  return null
})
</script>

<template>
  <div class="flex flex-col md:flex-row gap-6 items-start">
    <div style="width: 200px; height: 200px;" class="flex-shrink-0">
      <Doughnut :data="chartData" :options="chartOptions" />
    </div>
    <div class="flex-1 space-y-2">
      <div v-for="seg in segments" :key="seg.segment" class="flex items-center justify-between text-sm">
        <div class="flex items-center gap-2">
          <div class="w-3 h-3 rounded-full" :style="{ backgroundColor: SEGMENT_COLORS[seg.segment]?.border }"></div>
          <span class="font-medium">{{ seg.label }}</span>
        </div>
        <div class="flex gap-4 text-muted-foreground">
          <span>{{ seg.count }} ľudí</span>
          <span>{{ seg.totalKg.toFixed(1) }} kg</span>
          <span>{{ seg.pctVolume }}%</span>
        </div>
      </div>
      <p v-if="insight" class="text-sm font-medium text-green-700 mt-3 pt-3 border-t">
        {{ insight }}
      </p>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Create FriendAnalyticsTable component**

Create `frontend/src/components/analytics/FriendAnalyticsTable.vue`:

```vue
<script setup>
import { ref, computed } from 'vue'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const props = defineProps({
  friends: { type: Array, required: true }
})

const SEGMENT_BADGE_CLASSES = {
  core:       'bg-green-100 text-green-800 hover:bg-green-100',
  regular:    'bg-blue-100 text-blue-800 hover:bg-blue-100',
  occasional: 'bg-amber-100 text-amber-800 hover:bg-amber-100',
  new:        'bg-purple-100 text-purple-800 hover:bg-purple-100',
  inactive:   'bg-gray-100 text-gray-600 hover:bg-gray-100',
}

const sortKey = ref('total_kg')
const sortDir = ref('desc')
const filterSegment = ref(null)

function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc'
  } else {
    sortKey.value = key
    sortDir.value = 'desc'
  }
}

const sortIcon = (key) => {
  if (sortKey.value !== key) return '↕'
  return sortDir.value === 'desc' ? '↓' : '↑'
}

const filtered = computed(() => {
  let list = props.friends
  if (filterSegment.value) {
    list = list.filter(f => f.segment.segment === filterSegment.value)
  }
  return list.slice().sort((a, b) => {
    const aVal = a[sortKey.value] ?? 0
    const bVal = b[sortKey.value] ?? 0
    return sortDir.value === 'desc' ? bVal - aVal : aVal - bVal
  })
})

const segments = ['core', 'regular', 'occasional', 'new', 'inactive']
const segmentLabels = { core: 'Jadro', regular: 'Pravidelný', occasional: 'Občasný', new: 'Nový', inactive: 'Neaktívny' }
</script>

<template>
  <div class="space-y-3">
    <!-- Segment filter -->
    <div class="flex gap-2 flex-wrap">
      <Button
        variant="outline"
        size="sm"
        :class="!filterSegment ? 'border-primary' : ''"
        @click="filterSegment = null"
      >
        Všetci ({{ friends.length }})
      </Button>
      <Button
        v-for="seg in segments"
        :key="seg"
        variant="outline"
        size="sm"
        :class="filterSegment === seg ? 'border-primary' : ''"
        @click="filterSegment = filterSegment === seg ? null : seg"
      >
        {{ segmentLabels[seg] }} ({{ friends.filter(f => f.segment.segment === seg).length }})
      </Button>
    </div>

    <!-- Table -->
    <div class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Meno</TableHead>
            <TableHead>Segment</TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('participation_rate')">
              Účasť {{ sortIcon('participation_rate') }}
            </TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('avg_kg_per_cycle')">
              Priemer kg {{ sortIcon('avg_kg_per_cycle') }}
            </TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('total_kg')">
              Celkové kg {{ sortIcon('total_kg') }}
            </TableHead>
            <TableHead>Posledná obj.</TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('streak')">
              Séria {{ sortIcon('streak') }}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="f in filtered" :key="f.id" :class="!f.active ? 'opacity-50' : ''">
            <TableCell class="font-medium">{{ f.name }}</TableCell>
            <TableCell>
              <Badge variant="secondary" :class="SEGMENT_BADGE_CLASSES[f.segment.segment]">
                {{ f.segment.label }}
              </Badge>
            </TableCell>
            <TableCell>{{ f.cycles_participated }}/{{ f.total_cycles }} ({{ f.participation_rate }}%)</TableCell>
            <TableCell>{{ f.avg_kg_per_cycle }} kg</TableCell>
            <TableCell>{{ f.total_kg }} kg</TableCell>
            <TableCell class="text-sm text-muted-foreground">{{ f.last_active_cycle_name || '—' }}</TableCell>
            <TableCell>
              {{ f.streak > 0 ? f.streak : '—' }}
              <span v-if="f.trend === 'up'" class="text-green-600">▲</span>
              <span v-else-if="f.trend === 'down'" class="text-red-600">▼</span>
              <span v-else-if="f.trend === 'flat'" class="text-muted-foreground">—</span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Add segment donut and friend table to CoffeeAnalytics.vue**

Add imports:

```javascript
import SegmentDonutChart from '../components/analytics/SegmentDonutChart.vue'
import FriendAnalyticsTable from '../components/analytics/FriendAnalyticsTable.vue'
```

Add template sections (after the comparison cards, before the milestones):

```vue
        <!-- Section: Friend Segments (Feature 2.1) -->
        <Card>
          <CardHeader>
            <CardTitle>Segmenty priateľov</CardTitle>
          </CardHeader>
          <CardContent>
            <SegmentDonutChart :friends="data.friends" />
          </CardContent>
        </Card>

        <!-- Section: Friend Table (Feature 2.2) -->
        <Card>
          <CardHeader>
            <CardTitle>Prehľad priateľov</CardTitle>
          </CardHeader>
          <CardContent>
            <FriendAnalyticsTable :friends="data.friends" />
          </CardContent>
        </Card>
```

- [ ] **Step 4: Verify segments and table render correctly**

In browser:
- Donut chart shows colored segments
- Legend shows count, kg, and % for each segment
- Insight text appears for core segment
- Table default-sorts by total kg descending
- Column sorting works (click headers)
- Segment filter buttons work
- Inactive friends are grayed out
- Trend arrows show correctly

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/analytics/SegmentDonutChart.vue frontend/src/components/analytics/FriendAnalyticsTable.vue frontend/src/views/CoffeeAnalytics.vue
git commit -m "feat(analytics): add friend segments donut chart and analytics table"
```

---

## Task 8: Margin tracker chart (Feature 3.2)

**Files:**
- Create: `frontend/src/components/analytics/MarginChart.vue`
- Modify: `frontend/src/views/CoffeeAnalytics.vue`

- [ ] **Step 1: Create MarginChart component**

Create `frontend/src/components/analytics/MarginChart.vue`:

```vue
<script setup>
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement,
  LineElement, LineController, BarController, PointElement,
  Title, Tooltip, Legend, Filler
} from 'chart.js'

ChartJS.register(
  CategoryScale, LinearScale, BarElement, LineElement,
  LineController, BarController, PointElement,
  Title, Tooltip, Legend, Filler
)

const props = defineProps({
  cycles: { type: Array, required: true },
  cumulativeMarginAll: { type: Number, default: 0 }
})

const chartData = computed(() => {
  const labels = props.cycles.map(c => {
    const date = new Date(c.created_at)
    return date.toLocaleDateString('sk-SK', { month: 'short', year: 'numeric' })
  })

  // Cumulative margin line
  let cumulative = 0
  const cumulativeData = props.cycles.map(c => {
    cumulative += c.operator_margin
    return Math.round(cumulative * 100) / 100
  })

  return {
    labels,
    datasets: [
      {
        type: 'bar',
        label: 'Marža za cyklus (€)',
        data: props.cycles.map(c => c.operator_margin),
        backgroundColor: props.cycles.map(c =>
          c.operator_margin > 0 ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.2)'
        ),
        borderRadius: 4,
        yAxisID: 'y',
        order: 2,
      },
      {
        type: 'line',
        label: 'Kumulatívna marža (€)',
        data: cumulativeData,
        borderColor: 'rgb(99, 102, 241)',
        backgroundColor: 'rgba(99, 102, 241, 0.1)',
        fill: true,
        borderWidth: 2,
        pointRadius: 4,
        pointBackgroundColor: 'rgb(99, 102, 241)',
        yAxisID: 'y1',
        order: 1,
      }
    ]
  }
})

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: 'index',
    intersect: false,
  },
  plugins: {
    legend: { position: 'top' },
  },
  scales: {
    y: {
      type: 'linear',
      position: 'left',
      title: { display: true, text: 'Marža/cyklus (€)' },
      beginAtZero: true,
    },
    y1: {
      type: 'linear',
      position: 'right',
      title: { display: true, text: 'Kumulatívne (€)' },
      beginAtZero: true,
      grid: { display: false },
    },
  }
}
</script>

<template>
  <div style="height: 300px;">
    <Bar :data="chartData" :options="chartOptions" />
  </div>
</template>
```

- [ ] **Step 2: Add margin tracker to CoffeeAnalytics.vue**

Add import:

```javascript
import MarginChart from '../components/analytics/MarginChart.vue'
```

Add template section (after the simulator, before the milestones/roadmap):

```vue
        <!-- Section: Margin Tracker (Feature 3.2) -->
        <Card>
          <CardHeader>
            <div class="flex justify-between items-start">
              <CardTitle>Vývoj marže</CardTitle>
              <div class="text-right">
                <div class="text-2xl font-bold">{{ data.summary.cumulative_margin_all.toFixed(2) }} €</div>
                <div class="text-sm text-muted-foreground">celková marža</div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <MarginChart :cycles="data.cycles" :cumulative-margin-all="data.summary.cumulative_margin_all" />
          </CardContent>
        </Card>
```

- [ ] **Step 3: Verify margin chart renders**

In browser:
- Bars show per-cycle margin (€0 cycles shown as light red)
- Cumulative line rises over time
- Running total displayed in card header
- Tooltips work

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/analytics/MarginChart.vue frontend/src/views/CoffeeAnalytics.vue
git commit -m "feat(analytics): add margin tracker chart with cumulative view"
```

---

## Task 9: Buyer flow / retention chart (Feature 1.3)

**Files:**
- Create: `frontend/src/components/analytics/BuyerFlowChart.vue`
- Modify: `frontend/src/views/CoffeeAnalytics.vue`

- [ ] **Step 1: Create BuyerFlowChart component**

Create `frontend/src/components/analytics/BuyerFlowChart.vue`:

```vue
<script setup>
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement,
  Title, Tooltip, Legend
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend)

const props = defineProps({
  cycles: { type: Array, required: true }
})

// Skip first cycle (no previous to compare to)
const transitions = computed(() => props.cycles.slice(1))

const chartData = computed(() => {
  const labels = transitions.value.map(c => {
    const date = new Date(c.created_at)
    return date.toLocaleDateString('sk-SK', { month: 'short', year: 'numeric' })
  })

  return {
    labels,
    datasets: [
      {
        label: 'Vrátení',
        data: transitions.value.map(c => c.returning_friends),
        backgroundColor: 'rgba(59, 130, 246, 0.7)',
        stack: 'active',
      },
      {
        label: 'Noví',
        data: transitions.value.map(c => c.new_friends),
        backgroundColor: 'rgba(168, 85, 247, 0.7)',
        stack: 'active',
      },
      {
        label: 'Odchody',
        data: transitions.value.map(c => -c.churned_friends),
        backgroundColor: 'rgba(239, 68, 68, 0.5)',
        stack: 'churn',
      },
    ]
  }
})

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { position: 'top' },
    tooltip: {
      callbacks: {
        label(context) {
          const val = Math.abs(context.raw)
          return `${context.dataset.label}: ${val}`
        }
      }
    }
  },
  scales: {
    x: { stacked: true },
    y: {
      stacked: true,
      title: { display: true, text: 'Priatelia' },
    },
  }
}
</script>

<template>
  <div v-if="transitions.length > 0" style="height: 250px;">
    <Bar :data="chartData" :options="chartOptions" />
  </div>
  <p v-else class="text-muted-foreground">Nedostatok dát — potrebné aspoň 2 cykly.</p>
</template>
```

- [ ] **Step 2: Add buyer flow chart to CoffeeAnalytics.vue**

Add import:

```javascript
import BuyerFlowChart from '../components/analytics/BuyerFlowChart.vue'
```

Add template section (after the cycle comparison cards, before the friend segments):

```vue
        <!-- Section: Buyer Flow / Retention (Feature 1.3) -->
        <Card v-if="data.cycles.length >= 2">
          <CardHeader>
            <CardTitle>Pohyb priateľov medzi cyklami</CardTitle>
          </CardHeader>
          <CardContent>
            <BuyerFlowChart :cycles="data.cycles" />
          </CardContent>
        </Card>
```

- [ ] **Step 3: Verify buyer flow chart**

In browser:
- Stacked bars show returning (blue) + new (purple) above axis
- Churned (red) shown below axis
- Labels show absolute values
- Works with 2+ cycles

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/analytics/BuyerFlowChart.vue frontend/src/views/CoffeeAnalytics.vue
git commit -m "feat(analytics): add buyer flow retention chart"
```

---

## Task 10: Concentration risk indicator (Feature 2.3)

**Files:**
- Modify: `frontend/src/views/CoffeeAnalytics.vue`

- [ ] **Step 1: Add concentration risk section**

Add the following template section after the friend table card:

```vue
        <!-- Section: Concentration Risk (Feature 2.3) -->
        <Card>
          <CardHeader>
            <CardTitle>Koncentrácia rizika</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <!-- Top 5 share -->
            <div class="flex items-center gap-4">
              <div class="flex-1">
                <div class="text-sm text-muted-foreground">Top 5 priateľov — podiel na objeme (posledný cyklus)</div>
                <div class="flex items-center gap-3 mt-1">
                  <div class="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all"
                      :class="data.summary.top5_share > 40 ? 'bg-red-500' : 'bg-green-500'"
                      :style="{ width: data.summary.top5_share + '%' }"
                    ></div>
                  </div>
                  <span class="font-bold text-lg">{{ data.summary.top5_share }}%</span>
                </div>
              </div>
            </div>

            <Alert v-if="data.summary.concentration_warning" variant="destructive">
              <AlertDescription>
                Vysoká koncentrácia — tvoj objem závisí od niekoľkých kľúčových ľudí.
              </AlertDescription>
            </Alert>

            <!-- Minimum viable base -->
            <div v-if="data.summary.min_viable_base" class="p-4 bg-muted rounded-lg">
              <div class="text-sm text-muted-foreground">Minimálna základňa pre 26 kg (úroveň 35%)</div>
              <div class="text-lg font-semibold">
                {{ data.summary.min_viable_base }} jadro+pravidelní priatelia
                <span class="text-sm font-normal text-muted-foreground">
                  (teraz {{ data.summary.core_regular_count }} pri priemere {{ data.summary.core_regular_avg_kg }} kg/os)
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
```

- [ ] **Step 2: Verify concentration risk renders**

In browser:
- Progress bar shows top 5 share percentage
- Red bar + warning if > 40%
- Minimum viable base calculation shown
- Current core+regular count displayed

- [ ] **Step 3: Commit**

```bash
git add frontend/src/views/CoffeeAnalytics.vue
git commit -m "feat(analytics): add concentration risk indicator"
```

---

## Task 11: Final section ordering and polish

**Files:**
- Modify: `frontend/src/views/CoffeeAnalytics.vue`

- [ ] **Step 1: Arrange all sections in final order**

Ensure the sections inside `<div v-else-if="data" class="space-y-8">` are ordered per the spec priority:

1. Tier progress card (Feature 3.1)
2. Scenario simulator (Feature 3.3)
3. Cycle trends chart (Feature 1.1)
4. Cycle comparison cards (Feature 1.2)
5. Margin tracker (Feature 3.2)
6. Buyer flow / retention (Feature 1.3)
7. Friend segments donut (Feature 2.1)
8. Friend table (Feature 2.2)
9. Concentration risk (Feature 2.3)
10. Growth roadmap (Feature 3.4)

Move sections as needed to match this order.

- [ ] **Step 2: Add the "Štatistiky" navigation button to other admin pages**

The navigation button was added to `AdminDashboard.vue`. Other admin pages (AdminSettings, AdminFriends, AdminBakeryProducts) have a back-to-dashboard button instead of full nav — this is consistent, no changes needed.

- [ ] **Step 3: Verify the complete page end-to-end**

Navigate through the full page and verify:
- All sections render without console errors
- Charts display correctly
- Simulator sliders work
- Friend table sorting and filtering work
- Tab switcher between Coffee and Bakery works
- Back button returns to dashboard
- Page works with the current 2 cycles of production data
- Loading state shows while data fetches
- Empty state shows if no completed cycles

- [ ] **Step 4: Commit**

```bash
git add frontend/src/views/CoffeeAnalytics.vue
git commit -m "feat(analytics): finalize section ordering and polish"
```

---

## Summary

| Task | What it builds | Files |
|------|---------------|-------|
| 1 | Dependencies + computation helpers | `backend/src/helpers/analytics.js`, `frontend/package.json` |
| 2 | Backend endpoint | `backend/src/routes/analytics.js`, `backend/src/index.js` |
| 3 | Frontend setup (API, router, nav, shells) | `api.js`, `router.js`, `AdminDashboard.vue`, `CoffeeAnalytics.vue`, `BakeryAnalytics.vue` |
| 4 | Tier progress + growth roadmap | `CoffeeAnalytics.vue` |
| 5 | Scenario simulator | `CoffeeAnalytics.vue` |
| 6 | Cycle trends chart + comparison cards | `CycleTrendsChart.vue`, `CoffeeAnalytics.vue` |
| 7 | Friend segments + table | `SegmentDonutChart.vue`, `FriendAnalyticsTable.vue`, `CoffeeAnalytics.vue` |
| 8 | Margin tracker | `MarginChart.vue`, `CoffeeAnalytics.vue` |
| 9 | Buyer flow chart | `BuyerFlowChart.vue`, `CoffeeAnalytics.vue` |
| 10 | Concentration risk | `CoffeeAnalytics.vue` |
| 11 | Final ordering + polish | `CoffeeAnalytics.vue` |
