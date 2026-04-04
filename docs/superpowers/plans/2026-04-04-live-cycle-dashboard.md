# Live Cycle Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-time admin dashboard for the current open coffee cycle, showing tier progress, key metrics, comparison to previous cycle, and a "who hasn't ordered yet" nudge list.

**Architecture:** Single backend endpoint (`GET /api/analytics/live-cycle`) computes current cycle metrics, previous cycle comparison, and the not-ordered friend list with segment classification. Frontend page at `/admin/analytics/live` renders 4 sections using pure CSS/Tailwind (no Chart.js). Integrated into the existing Štatistiky tab navigation as the first tab.

**Tech Stack:** Existing shadcn-vue components, Tailwind CSS progress bar, reused analytics helpers from `backend/src/helpers/analytics.js`.

**Spec:** `docs/live-cycle-dashboard-spec.md`

---

## File Structure

### Backend (create)
- `backend/src/routes/live-cycle.js` — Express route for `GET /` returning live cycle data.

### Backend (modify)
- `backend/src/index.js` — Register live-cycle route at `/api/analytics/live-cycle`.

### Frontend (create)
- `frontend/src/views/LiveCycleDashboard.vue` — Main dashboard page with 4 sections.

### Frontend (modify)
- `frontend/src/api.js` — Add `getLiveCycle()` method.
- `frontend/src/router.js` — Add `/admin/analytics/live` route.
- `frontend/src/views/CoffeeAnalytics.vue` — Add "Živý prehľad" tab button.
- `frontend/src/views/BakeryAnalytics.vue` — Add "Živý prehľad" tab button.

---

## Task 1: Backend live-cycle endpoint

**Files:**
- Create: `backend/src/routes/live-cycle.js`
- Modify: `backend/src/index.js`

- [ ] **Step 1: Create the live-cycle route file**

Create `backend/src/routes/live-cycle.js`:

```javascript
import { Router } from 'express';
import db from '../db/schema.js';
import {
  variantToKg, getTier, getNextTier, computeMargin,
  classifyFriend, computeStreak, TIER_THRESHOLDS, BUYER_DISCOUNT
} from '../helpers/analytics.js';

const router = Router();

function roundKg(value) {
  return Math.round(value * 10) / 10;
}

function roundEur(value) {
  return Math.round(value * 100) / 100;
}

// GET / — live cycle dashboard data
router.get('/', (req, res) => {
  try {
    // 1. Find current open or locked coffee cycle
    const currentCycle = db.get(`
      SELECT id, name, status, type, created_at, expected_date, markup_ratio
      FROM order_cycles
      WHERE type = 'coffee' AND status IN ('open', 'locked')
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (!currentCycle) {
      return res.json({ cycle: null });
    }

    // 2. Get submitted orders for current cycle
    const orders = db.all(`
      SELECT o.id AS order_id, o.friend_id, o.total AS order_value
      FROM orders o
      WHERE o.cycle_id = ? AND o.status = 'submitted'
    `, [currentCycle.id]);

    const items = db.all(`
      SELECT oi.order_id, oi.variant, oi.quantity
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.cycle_id = ? AND o.status = 'submitted'
    `, [currentCycle.id]);

    // Compute per-order kg
    const kgByOrder = {};
    for (const item of items) {
      kgByOrder[item.order_id] = (kgByOrder[item.order_id] || 0) + variantToKg(item.variant, item.quantity);
    }

    const totalKg = Object.values(kgByOrder).reduce((sum, kg) => sum + kg, 0);
    const totalValue = orders.reduce((sum, o) => sum + (o.order_value || 0), 0);
    const orderedFriendIds = new Set(orders.map(o => o.friend_id));
    const numFriends = orderedFriendIds.size;
    const avgKgPerPerson = numFriends > 0 ? totalKg / numFriends : 0;
    const avgValuePerPerson = numFriends > 0 ? totalValue / numFriends : 0;

    const tier = getTier(totalKg);
    const nextTier = getNextTier(totalKg);
    const margin = computeMargin(totalValue, totalKg);

    // 3. Count eligible friends (active + subscribed to coffee or no subscriptions)
    const eligibleFriends = db.all(`
      SELECT f.id, f.name, f.display_name
      FROM friends f
      WHERE f.active = 1
        AND (
          EXISTS (SELECT 1 FROM friend_subscriptions fs WHERE fs.friend_id = f.id AND fs.type = 'coffee')
          OR NOT EXISTS (SELECT 1 FROM friend_subscriptions fs WHERE fs.friend_id = f.id)
        )
      ORDER BY f.name ASC
    `);

    const totalEligible = eligibleFriends.length;

    // 4. Previous completed coffee cycle
    const prevCycle = db.get(`
      SELECT id, name
      FROM order_cycles
      WHERE type = 'coffee' AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    let previous = null;
    if (prevCycle) {
      const prevOrders = db.all(`
        SELECT o.id AS order_id, o.friend_id, o.total AS order_value
        FROM orders o
        WHERE o.cycle_id = ? AND o.status = 'submitted'
      `, [prevCycle.id]);

      const prevItems = db.all(`
        SELECT oi.order_id, oi.variant, oi.quantity
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.cycle_id = ? AND o.status = 'submitted'
      `, [prevCycle.id]);

      const prevKgByOrder = {};
      for (const item of prevItems) {
        prevKgByOrder[item.order_id] = (prevKgByOrder[item.order_id] || 0) + variantToKg(item.variant, item.quantity);
      }

      const prevTotalKg = Object.values(prevKgByOrder).reduce((sum, kg) => sum + kg, 0);
      const prevTotalValue = prevOrders.reduce((sum, o) => sum + (o.order_value || 0), 0);
      const prevFriendIds = new Set(prevOrders.map(o => o.friend_id));
      const prevNumFriends = prevFriendIds.size;

      previous = {
        id: prevCycle.id,
        name: prevCycle.name,
        total_kg: roundKg(prevTotalKg),
        total_value: roundEur(prevTotalValue),
        num_friends: prevNumFriends,
        avg_kg_per_person: prevNumFriends > 0 ? roundKg(prevTotalKg / prevNumFriends) : 0,
        avg_value_per_person: prevNumFriends > 0 ? roundEur(prevTotalValue / prevNumFriends) : 0,
        friend_ids: [...prevFriendIds],
      };
    }

    // 5. Who hasn't ordered yet + segment classification
    // Get all completed coffee cycle IDs for segmentation
    const completedCycles = db.all(`
      SELECT id FROM order_cycles
      WHERE type = 'coffee' AND status IN ('completed', 'locked')
      ORDER BY created_at ASC
    `);
    const completedCycleIds = completedCycles.map(c => c.id);
    const lookbackCount = Math.min(3, completedCycleIds.length);
    const lastNCycleIds = completedCycleIds.slice(-lookbackCount);

    // Get per-friend participation across all completed coffee cycles
    const friendOrders = db.all(`
      SELECT DISTINCT o.friend_id, o.cycle_id
      FROM orders o
      JOIN order_cycles oc ON oc.id = o.cycle_id
      WHERE o.status = 'submitted'
        AND oc.type = 'coffee'
        AND oc.status IN ('completed', 'locked')
    `);

    const friendCycleMap = {};
    for (const fo of friendOrders) {
      if (!friendCycleMap[fo.friend_id]) friendCycleMap[fo.friend_id] = [];
      friendCycleMap[fo.friend_id].push(fo.cycle_id);
    }

    const prevFriendIdSet = previous ? new Set(previous.friend_ids) : new Set();

    const notOrdered = eligibleFriends
      .filter(f => !orderedFriendIds.has(f.id))
      .map(f => {
        const orderedCycleIds = friendCycleMap[f.id] || [];
        const segment = classifyFriend(orderedCycleIds, lastNCycleIds, true, completedCycleIds.length);
        return {
          id: f.id,
          name: f.display_name || f.name,
          segment,
          ordered_previous: prevFriendIdSet.has(f.id),
        };
      });

    // Sort: Core first, then Regular, then Occasional, then New, then Inactive
    const segmentOrder = { core: 0, regular: 1, occasional: 2, new: 3, inactive: 4 };
    notOrdered.sort((a, b) => (segmentOrder[a.segment.segment] ?? 5) - (segmentOrder[b.segment.segment] ?? 5));

    // Potential kg impact
    const avgKgFromPrev = previous && previous.num_friends > 0
      ? previous.total_kg / previous.num_friends
      : avgKgPerPerson;
    const potentialKg = notOrdered.length * avgKgFromPrev;

    // Distance to next tier
    const distanceToNextTier = nextTier ? roundKg(nextTier.minKg - totalKg) : 0;
    const friendsNeeded = avgKgFromPrev > 0 && nextTier
      ? Math.ceil(distanceToNextTier / avgKgFromPrev)
      : null;

    res.json({
      cycle: {
        id: currentCycle.id,
        name: currentCycle.name,
        status: currentCycle.status,
        created_at: currentCycle.created_at,
        expected_date: currentCycle.expected_date,
        markup_ratio: currentCycle.markup_ratio || 1.0,
      },
      totals: {
        total_kg: roundKg(totalKg),
        total_value: roundEur(totalValue),
        num_friends: numFriends,
        total_eligible: totalEligible,
        avg_kg_per_person: numFriends > 0 ? roundKg(avgKgPerPerson) : 0,
        avg_value_per_person: numFriends > 0 ? roundEur(avgValuePerPerson) : 0,
        tier_discount: tier ? tier.discount : null,
        tier_label: tier ? tier.label : null,
        next_tier: nextTier ? { discount: nextTier.discount, label: nextTier.label, min_kg: nextTier.minKg } : null,
        distance_to_next_tier: distanceToNextTier,
        friends_needed: friendsNeeded,
        operator_margin: roundEur(margin),
      },
      previous,
      not_ordered: notOrdered,
      potential_kg: roundKg(potentialKg),
    });
  } catch (e) {
    console.error('Live cycle error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
```

- [ ] **Step 2: Register the route in index.js**

In `backend/src/index.js`, add alongside other imports:

```javascript
import liveCycleRouter from './routes/live-cycle.js';
```

Register alongside other routes:

```javascript
app.use('/api/analytics/live-cycle', liveCycleRouter);
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/live-cycle.js backend/src/index.js
git commit -m "feat(live-cycle): add backend endpoint for live cycle dashboard"
```

---

## Task 2: Frontend setup — API, router, tab navigation

**Files:**
- Modify: `frontend/src/api.js`
- Modify: `frontend/src/router.js`
- Modify: `frontend/src/views/CoffeeAnalytics.vue`
- Modify: `frontend/src/views/BakeryAnalytics.vue`

- [ ] **Step 1: Add API method**

In `frontend/src/api.js`, add alongside `getCoffeeAnalytics`:

```javascript
  getLiveCycle: () => adminRequest('/analytics/live-cycle'),
```

- [ ] **Step 2: Add route**

In `frontend/src/router.js`, add a new route before the `analytics-coffee` route:

```javascript
  {
    path: '/admin/analytics/live',
    name: 'analytics-live',
    component: () => import('./views/LiveCycleDashboard.vue')
  },
```

- [ ] **Step 3: Update CoffeeAnalytics.vue tab navigation**

In `frontend/src/views/CoffeeAnalytics.vue`, find the tab div (around line 171):

```vue
      <div class="flex gap-2 mb-6">
        <Button variant="default">Káva</Button>
        <Button variant="outline" @click="router.push('/admin/analytics/bakery')">Pekáreň</Button>
      </div>
```

Replace with:

```vue
      <div class="flex gap-2 mb-6">
        <Button variant="outline" @click="router.push('/admin/analytics/live')">Živý prehľad</Button>
        <Button variant="default">Káva</Button>
        <Button variant="outline" @click="router.push('/admin/analytics/bakery')">Pekáreň</Button>
      </div>
```

- [ ] **Step 4: Update BakeryAnalytics.vue tab navigation**

In `frontend/src/views/BakeryAnalytics.vue`, find the tab div (around line 28):

```vue
      <div class="flex gap-2 mb-6">
        <Button variant="outline" @click="router.push('/admin/analytics/coffee')">Káva</Button>
        <Button variant="default">Pekáreň</Button>
      </div>
```

Replace with:

```vue
      <div class="flex gap-2 mb-6">
        <Button variant="outline" @click="router.push('/admin/analytics/live')">Živý prehľad</Button>
        <Button variant="outline" @click="router.push('/admin/analytics/coffee')">Káva</Button>
        <Button variant="default">Pekáreň</Button>
      </div>
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.js frontend/src/router.js frontend/src/views/CoffeeAnalytics.vue frontend/src/views/BakeryAnalytics.vue
git commit -m "feat(live-cycle): add API method, route, and tab navigation"
```

---

## Task 3: LiveCycleDashboard.vue — full page

**Files:**
- Create: `frontend/src/views/LiveCycleDashboard.vue`

- [ ] **Step 1: Create the dashboard page**

Create `frontend/src/views/LiveCycleDashboard.vue`:

```vue
<script setup>
import { ref, computed, watchEffect, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const data = ref(null) // { cycle, totals, previous, not_ordered, potential_kg }
const showAllNotOrdered = ref(false)
let refreshInterval = null

watchEffect(() => {
  document.title = 'Živý prehľad - Gorifi Admin'
})

async function loadData() {
  try {
    data.value = await api.getLiveCycle()
    error.value = ''
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadData()
  refreshInterval = setInterval(loadData, 60000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

// === Tier progress bar ===
const PROGRESS_BAR_MAX = computed(() => {
  if (!data.value?.totals) return 60
  return Math.max(51, (data.value.totals.total_kg || 0) * 1.2, 60)
})

function tierPosition(kg) {
  return Math.min((kg / PROGRESS_BAR_MAX.value) * 100, 100)
}

const progressBarColor = computed(() => {
  if (!data.value?.totals) return 'bg-gray-400'
  const kg = data.value.totals.total_kg
  if (kg >= 51) return 'bg-green-500'
  if (kg >= 26) return 'bg-blue-500'
  return 'bg-gray-400'
})

const tierMessage = computed(() => {
  if (!data.value?.totals) return ''
  const t = data.value.totals
  if (t.total_kg >= 51) return '40% tier dosiahnutý!'
  if (t.total_kg >= 26) {
    return `35% tier dosiahnutý! Ešte ${t.distance_to_next_tier} kg do 40%`
  }
  const friendsMsg = t.friends_needed ? ` (+ ${t.friends_needed} ľudí pri priemernej objednávke)` : ''
  return `Ešte ${t.distance_to_next_tier} kg do 35% tieru${friendsMsg}`
})

// === Comparison deltas ===
const comparison = computed(() => {
  if (!data.value?.previous) return null
  const curr = data.value.totals
  const prev = data.value.previous

  function delta(currVal, prevVal) {
    const diff = currVal - prevVal
    const pct = prevVal !== 0 ? Math.round((diff / prevVal) * 100) : 0
    return {
      current: currVal,
      previous: prevVal,
      pct,
      direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
    }
  }

  return {
    prevName: prev.name,
    total_kg: delta(curr.total_kg, prev.total_kg),
    num_friends: delta(curr.num_friends, prev.num_friends),
    avg_kg: delta(curr.avg_kg_per_person, prev.avg_kg_per_person),
    total_value: delta(curr.total_value, prev.total_value),
  }
})

// === Not ordered list ===
const SEGMENT_BADGE_CLASSES = {
  core:       'bg-green-100 text-green-800 hover:bg-green-100',
  regular:    'bg-blue-100 text-blue-800 hover:bg-blue-100',
  occasional: 'bg-amber-100 text-amber-800 hover:bg-amber-100',
  new:        'bg-purple-100 text-purple-800 hover:bg-purple-100',
  inactive:   'bg-gray-100 text-gray-600 hover:bg-gray-100',
}

const visibleNotOrdered = computed(() => {
  if (!data.value?.not_ordered) return []
  if (showAllNotOrdered.value) return data.value.not_ordered
  return data.value.not_ordered.slice(0, 10)
})

const hasMoreNotOrdered = computed(() => {
  return (data.value?.not_ordered?.length || 0) > 10
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
        <Button variant="ghost" size="sm" @click="loadData" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
          Obnoviť dáta
        </Button>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 py-8">
      <!-- Tab navigation -->
      <div class="flex gap-2 mb-6">
        <Button variant="default">Živý prehľad</Button>
        <Button variant="outline" @click="router.push('/admin/analytics/coffee')">Káva</Button>
        <Button variant="outline" @click="router.push('/admin/analytics/bakery')">Pekáreň</Button>
      </div>

      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <!-- No active cycle -->
      <div v-else-if="!data?.cycle" class="text-center py-12">
        <p class="text-muted-foreground text-lg">Žiadny aktívny kávový cyklus</p>
        <Button variant="outline" class="mt-4" @click="router.push('/admin/dashboard')">Späť na dashboard</Button>
      </div>

      <!-- Dashboard content -->
      <div v-else class="space-y-6">
        <!-- Cycle name header -->
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">{{ data.cycle.name }}</h2>
          <Badge v-if="data.cycle.status === 'locked'" variant="secondary">Uzamknutý</Badge>
          <Badge v-else variant="default" class="bg-green-600">Otvorený</Badge>
        </div>

        <!-- Section 1: Tier progress bar -->
        <Card>
          <CardContent class="pt-6">
            <div class="space-y-3">
              <!-- Current kg display -->
              <div class="text-center">
                <span class="text-3xl font-bold">{{ data.totals.total_kg }}</span>
                <span class="text-xl text-muted-foreground"> kg</span>
              </div>

              <!-- Progress bar -->
              <div class="relative pt-6 pb-2">
                <!-- Tier labels above bar -->
                <div class="absolute top-0 left-0 w-full text-xs text-muted-foreground">
                  <div :style="{ left: tierPosition(26) + '%' }" class="absolute transform -translate-x-1/2 text-center">
                    <div class="font-semibold text-blue-600">35%</div>
                    <div>26 kg</div>
                  </div>
                  <div :style="{ left: tierPosition(51) + '%' }" class="absolute transform -translate-x-1/2 text-center">
                    <div class="font-semibold text-green-600">40%</div>
                    <div>51 kg</div>
                  </div>
                </div>

                <!-- Bar -->
                <div class="h-5 bg-muted rounded-full relative overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-700"
                    :class="progressBarColor"
                    :style="{ width: tierPosition(data.totals.total_kg) + '%' }"
                  ></div>
                  <!-- Threshold markers -->
                  <div class="absolute top-0 h-full w-0.5 bg-border" :style="{ left: tierPosition(26) + '%' }"></div>
                  <div class="absolute top-0 h-full w-0.5 bg-border" :style="{ left: tierPosition(51) + '%' }"></div>
                </div>
              </div>

              <!-- Tier message -->
              <p class="text-center text-sm" :class="data.totals.total_kg >= 26 ? 'text-green-700 font-medium' : 'text-muted-foreground'">
                {{ tierMessage }}
              </p>
            </div>
          </CardContent>
        </Card>

        <!-- Section 2: Key metric cards -->
        <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Card>
            <CardContent class="pt-4">
              <div class="text-sm text-muted-foreground">Celkovo kg</div>
              <div class="text-2xl font-bold">{{ data.totals.total_kg }} kg</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="pt-4">
              <div class="text-sm text-muted-foreground">Objednalo</div>
              <div class="text-2xl font-bold">{{ data.totals.num_friends }} <span class="text-sm font-normal text-muted-foreground">z {{ data.totals.total_eligible }}</span></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="pt-4">
              <div class="text-sm text-muted-foreground">Priemer na osobu</div>
              <div class="text-2xl font-bold">{{ data.totals.avg_kg_per_person }} kg</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="pt-4">
              <div class="text-sm text-muted-foreground">Hodnota objednávok</div>
              <div class="text-2xl font-bold">{{ data.totals.total_value.toFixed(2) }} €</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="pt-4">
              <div class="text-sm text-muted-foreground">Odhadovaná marža</div>
              <div class="text-2xl font-bold" :class="data.totals.operator_margin > 0 ? 'text-green-700' : ''">
                {{ data.totals.operator_margin.toFixed(2) }} €
              </div>
              <div v-if="data.totals.operator_margin === 0" class="text-xs text-muted-foreground">30% tier</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="pt-4">
              <div class="text-sm text-muted-foreground">Aktuálny tier</div>
              <div class="text-2xl font-bold">
                <Badge
                  :class="data.totals.tier_discount >= 0.40 ? 'bg-green-600' : data.totals.tier_discount >= 0.35 ? 'bg-blue-600' : 'bg-gray-500'"
                  class="text-white text-lg px-3 py-1"
                >
                  {{ data.totals.tier_label || '—' }}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>

        <!-- Section 3: Comparison with previous cycle -->
        <Card v-if="comparison">
          <CardHeader>
            <CardTitle class="text-base">Porovnanie s predchádzajúcim cyklom</CardTitle>
            <p class="text-xs text-muted-foreground">vs {{ comparison.prevName }} — Cyklus ešte prebieha — porovnanie s konečným stavom predošlého cyklu</p>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div v-for="(item, label) in {
                'Celkové kg': comparison.total_kg,
                'Priatelia': comparison.num_friends,
                'Priemer kg/os': comparison.avg_kg,
                'Hodnota': comparison.total_value,
              }" :key="label">
                <div class="text-sm text-muted-foreground">{{ label }}</div>
                <div class="font-semibold">
                  {{ typeof item.current === 'number' && label === 'Hodnota' ? item.current.toFixed(2) + ' €' : item.current }}
                  vs {{ typeof item.previous === 'number' && label === 'Hodnota' ? item.previous.toFixed(2) + ' €' : item.previous }}
                </div>
                <div class="text-sm" :class="item.direction === 'up' ? 'text-green-600' : item.direction === 'down' ? 'text-red-600' : 'text-muted-foreground'">
                  {{ item.direction === 'up' ? '▲' : item.direction === 'down' ? '▼' : '—' }}
                  {{ Math.abs(item.pct) }}%
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card v-else-if="!data.previous">
          <CardHeader>
            <CardTitle class="text-base">Porovnanie s predchádzajúcim cyklom</CardTitle>
          </CardHeader>
          <CardContent>
            <p class="text-muted-foreground">Prvý cyklus — žiadne porovnanie</p>
          </CardContent>
        </Card>

        <!-- Section 4: Who hasn't ordered yet (only when cycle is open) -->
        <Card v-if="data.cycle.status === 'open' && data.not_ordered.length > 0">
          <CardHeader>
            <CardTitle class="text-base">Ešte neobjednalo: {{ data.not_ordered.length }} ľudí</CardTitle>
          </CardHeader>
          <CardContent class="space-y-3">
            <div class="space-y-2">
              <div
                v-for="friend in visibleNotOrdered"
                :key="friend.id"
                class="flex items-center justify-between py-1.5 border-b last:border-0"
              >
                <div class="flex items-center gap-2">
                  <span>{{ friend.name }}</span>
                  <Badge variant="secondary" :class="SEGMENT_BADGE_CLASSES[friend.segment.segment]" class="text-xs">
                    {{ friend.segment.label }}
                  </Badge>
                </div>
                <span v-if="friend.ordered_previous" class="text-xs text-muted-foreground">minule objednal/a</span>
              </div>
            </div>

            <Button
              v-if="hasMoreNotOrdered && !showAllNotOrdered"
              variant="ghost"
              size="sm"
              class="w-full"
              @click="showAllNotOrdered = true"
            >
              Zobraziť všetkých ({{ data.not_ordered.length }})
            </Button>

            <!-- Potential kg impact -->
            <div class="pt-2 border-t text-sm text-muted-foreground">
              Ak objednajú všetci, potenciálne <span class="font-semibold">+ {{ data.potential_kg }} kg</span>
            </div>
          </CardContent>
        </Card>

        <!-- All ordered message when cycle is open but everyone ordered -->
        <Card v-else-if="data.cycle.status === 'open' && data.not_ordered.length === 0">
          <CardContent class="pt-6 text-center">
            <p class="text-green-700 font-medium">Všetci priatelia už objednali!</p>
          </CardContent>
        </Card>
      </div>
    </main>
  </div>
</template>
```

- [ ] **Step 2: Verify page loads**

```bash
cd frontend && npm run dev
```

Navigate to `http://localhost:5173/admin/analytics/live`. Verify:
- Tab navigation shows "Živý prehľad" (active), "Káva", "Pekáreň"
- If no open coffee cycle: shows empty state
- If open cycle: shows all 4 sections
- Auto-refresh works (check network tab for 60s interval)
- "Obnoviť dáta" button triggers manual refresh
- Tab switching works from all 3 analytics pages

- [ ] **Step 3: Commit**

```bash
git add frontend/src/views/LiveCycleDashboard.vue
git commit -m "feat(live-cycle): add live cycle dashboard page"
```

---

## Summary

| Task | What it builds | Files |
|------|---------------|-------|
| 1 | Backend endpoint | `backend/src/routes/live-cycle.js`, `backend/src/index.js` |
| 2 | Frontend wiring (API, router, tabs) | `api.js`, `router.js`, `CoffeeAnalytics.vue`, `BakeryAnalytics.vue` |
| 3 | LiveCycleDashboard.vue (full page) | `frontend/src/views/LiveCycleDashboard.vue` |
