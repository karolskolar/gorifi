<script setup>
import { ref, computed, watchEffect, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import CycleTrendsChart from '@/components/analytics/CycleTrendsChart.vue'
import SegmentDonutChart from '@/components/analytics/SegmentDonutChart.vue'
import FriendAnalyticsTable from '@/components/analytics/FriendAnalyticsTable.vue'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const data = ref(null)

// Simulator state
const simFriends = ref(10)
const simAvgKg = ref(1.0)

watchEffect(() => {
  document.title = 'Štatistiky káva - Gorifi Admin'
})

onMounted(async () => {
  try {
    data.value = await api.getCoffeeAnalytics()
    // Initialize simulator defaults from data
    if (data.value && data.value.cycles.length > 0) {
      const lastCycle = data.value.cycles[data.value.cycles.length - 1]
      simFriends.value = lastCycle.num_friends || 10
      simAvgKg.value = data.value.summary.avg_kg_per_person || 1.0
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

// === Tier Progress computed ===
const rollingAvg = computed(() => data.value?.summary?.rolling_avg_kg_3 ?? 0)
const avgKgPerPerson = computed(() => data.value?.summary?.avg_kg_per_person ?? 0)
const buyerDiscount = computed(() => data.value?.summary?.buyer_discount ?? 0.30)

const BAR_MAX = 60

const tierColor = computed(() => {
  const kg = rollingAvg.value
  if (kg >= 51) return 'green'
  if (kg >= 26) return 'blue'
  return 'amber'
})

const tierColorClasses = computed(() => {
  const c = tierColor.value
  if (c === 'green') return { bar: 'bg-green-500', text: 'text-green-700', badge: 'bg-green-100 text-green-800 border-green-300' }
  if (c === 'blue') return { bar: 'bg-blue-500', text: 'text-blue-700', badge: 'bg-blue-100 text-blue-800 border-blue-300' }
  return { bar: 'bg-amber-500', text: 'text-amber-700', badge: 'bg-amber-100 text-amber-800 border-amber-300' }
})

const progressPercent = computed(() => Math.min((rollingAvg.value / BAR_MAX) * 100, 100))

const currentTier = computed(() => data.value?.summary?.current_tier)
const nextTier = computed(() => data.value?.summary?.next_tier)
const distanceToNext = computed(() => data.value?.summary?.distance_to_next_tier ?? 0)
const friendsNeeded = computed(() => data.value?.summary?.friends_needed_for_next_tier)
const isMaxTier = computed(() => !nextTier.value && currentTier.value)

// === Growth Roadmap computed ===
const milestones = computed(() => {
  const kg = rollingAvg.value
  const avgPp = avgKgPerPerson.value
  return [
    {
      label: 'Dosiahnuť 5 kg (veľkoobchodná cena, 30% zľava)',
      done: kg >= 5,
      friendsNeeded: kg < 5 && avgPp > 0 ? Math.ceil((5 - kg) / avgPp) : null,
    },
    {
      label: 'Dosiahnuť 26 kg stabilne (35% zľava → 5% marža)',
      done: kg >= 26,
      friendsNeeded: kg < 26 && avgPp > 0 ? Math.ceil((26 - kg) / avgPp) : null,
    },
    {
      label: 'Dosiahnuť 51 kg (40% zľava → 10% marža)',
      done: kg >= 51,
      friendsNeeded: kg < 51 && avgPp > 0 ? Math.ceil((51 - kg) / avgPp) : null,
    },
  ]
})

// === Scenario Simulator computed ===
const simTotalKg = computed(() => {
  return Math.round(simFriends.value * simAvgKg.value * 10) / 10
})

const simTier = computed(() => {
  const kg = simTotalKg.value
  if (kg >= 51) return { discount: 0.40, label: '40%' }
  if (kg >= 26) return { discount: 0.35, label: '35%' }
  if (kg >= 5) return { discount: 0.30, label: '30%' }
  return null
})

const simTierLabel = computed(() => {
  if (!simTier.value) return 'Bez zľavy'
  return simTier.value.label + ' zľava'
})

const avgPricePerKg = computed(() => {
  if (!data.value || data.value.cycles.length === 0) return 0
  const lastCycle = data.value.cycles[data.value.cycles.length - 1]
  return lastCycle.total_kg > 0 ? lastCycle.total_value / lastCycle.total_kg : 0
})

const simMarginPerCycle = computed(() => {
  if (!simTier.value) return 0
  const bd = buyerDiscount.value
  if (simTier.value.discount <= bd) return 0
  const totalValue = simTotalKg.value * avgPricePerKg.value
  return Math.round(totalValue * (1 - (1 - simTier.value.discount) / (1 - bd)) * 100) / 100
})

const simAnnualMargin = computed(() => {
  // Assume ~12 cycles per year (monthly)
  return Math.round(simMarginPerCycle.value * 12 * 100) / 100
})

// === Cycle Comparison computed ===
const comparison = computed(() => {
  if (!data.value || data.value.cycles.length < 2) return null
  const curr = data.value.cycles.at(-1)
  const prev = data.value.cycles.at(-2)

  function delta(currVal, prevVal, unit) {
    const diff = currVal - prevVal
    const pct = prevVal !== 0 ? ((diff / Math.abs(prevVal)) * 100) : (diff !== 0 ? 100 : 0)
    const direction = diff > 0.001 ? 'up' : diff < -0.001 ? 'down' : 'flat'
    return { current: currVal, previous: prevVal, diff, pct: Math.round(pct * 10) / 10, direction, unit }
  }

  return {
    total_kg: delta(curr.total_kg, prev.total_kg, 'kg'),
    num_friends: delta(curr.num_friends, prev.num_friends, ''),
    avg_kg_per_person: delta(curr.avg_kg_per_person ?? 0, prev.avg_kg_per_person ?? 0, 'kg'),
    operator_margin: delta(curr.operator_margin ?? 0, prev.operator_margin ?? 0, '\u20AC'),
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

        <!-- ============================== -->
        <!-- Part A: Tier Progress Card      -->
        <!-- ============================== -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-3">
              Úroveň zľavy
              <Badge v-if="isMaxTier" class="bg-green-100 text-green-800 border-green-300">
                Maximálna úroveň zľavy dosiahnutá!
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <!-- Large rolling average display -->
            <div class="flex items-baseline gap-2 mb-4">
              <span :class="['text-4xl font-bold', tierColorClasses.text]">
                {{ rollingAvg }} kg
              </span>
              <span class="text-muted-foreground text-sm">priemer za posledné 3 cykly</span>
            </div>

            <!-- Progress bar with tier markers -->
            <div class="relative mb-6">
              <div class="w-full h-4 bg-muted rounded-full overflow-hidden">
                <div
                  :class="['h-full rounded-full transition-all duration-500', tierColorClasses.bar]"
                  :style="{ width: progressPercent + '%' }"
                />
              </div>
              <!-- Tier threshold markers -->
              <div class="relative w-full h-6 mt-1">
                <!-- 26 kg marker (35%) -->
                <div
                  class="absolute top-0 flex flex-col items-center -translate-x-1/2"
                  :style="{ left: (26 / BAR_MAX * 100) + '%' }"
                >
                  <div class="w-px h-3 bg-muted-foreground/50" />
                  <span class="text-xs text-muted-foreground whitespace-nowrap">26 kg (35%)</span>
                </div>
                <!-- 51 kg marker (40%) -->
                <div
                  class="absolute top-0 flex flex-col items-center -translate-x-1/2"
                  :style="{ left: (51 / BAR_MAX * 100) + '%' }"
                >
                  <div class="w-px h-3 bg-muted-foreground/50" />
                  <span class="text-xs text-muted-foreground whitespace-nowrap">51 kg (40%)</span>
                </div>
              </div>
            </div>

            <!-- Distance to next tier message -->
            <div v-if="nextTier" class="space-y-1">
              <p class="text-sm">
                Do úrovne <strong>{{ nextTier.label }}</strong> chýba
                <strong :class="tierColorClasses.text">{{ distanceToNext }} kg</strong>
              </p>
              <p v-if="friendsNeeded && avgKgPerPerson > 0" class="text-sm text-muted-foreground">
                To je približne <strong>{{ friendsNeeded }} {{ friendsNeeded === 1 ? 'nový priateľ' : (friendsNeeded < 5 ? 'noví priatelia' : 'nových priateľov') }}</strong>
                pri priemernom odbere {{ avgKgPerPerson }} kg/osobu
              </p>
            </div>

            <!-- Current tier info -->
            <div v-if="currentTier" class="mt-3">
              <Badge :class="tierColorClasses.badge">
                Aktuálna úroveň: {{ currentTier.label }} zľava
              </Badge>
            </div>
            <div v-else class="mt-3">
              <Badge variant="outline" class="text-muted-foreground">
                Zatiaľ bez úrovne zľavy
              </Badge>
            </div>
          </CardContent>
        </Card>

        <!-- ============================== -->
        <!-- Part B: Growth Roadmap          -->
        <!-- ============================== -->
        <Card>
          <CardHeader>
            <CardTitle>Plán rastu</CardTitle>
          </CardHeader>
          <CardContent>
            <ol class="space-y-3">
              <li
                v-for="(m, i) in milestones"
                :key="i"
                class="flex items-start gap-3"
              >
                <!-- Checkbox icon -->
                <span v-if="m.done" class="mt-0.5 flex-shrink-0 text-green-600">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
                  </svg>
                </span>
                <span v-else class="mt-0.5 flex-shrink-0 text-muted-foreground">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                  </svg>
                </span>
                <div>
                  <p :class="['text-sm', m.done ? 'text-foreground font-medium' : 'text-muted-foreground']">
                    {{ m.label }}
                  </p>
                  <p v-if="!m.done && m.friendsNeeded" class="text-xs text-muted-foreground mt-0.5">
                    ešte ~{{ m.friendsNeeded }} {{ m.friendsNeeded === 1 ? 'priateľ' : (m.friendsNeeded < 5 ? 'priatelia' : 'priateľov') }}
                  </p>
                </div>
              </li>
            </ol>
          </CardContent>
        </Card>

        <!-- ============================== -->
        <!-- Part C: Scenario Simulator      -->
        <!-- ============================== -->
        <Card>
          <CardHeader>
            <CardTitle>Simulátor scenárov</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="grid gap-6 sm:grid-cols-2">
              <!-- Input 1: Number of friends -->
              <div class="space-y-2">
                <Label>Počet priateľov</Label>
                <div class="flex items-center gap-3">
                  <input
                    type="range"
                    :min="1"
                    :max="80"
                    v-model.number="simFriends"
                    class="flex-1 h-2 accent-primary cursor-pointer"
                  />
                  <Input
                    type="number"
                    v-model.number="simFriends"
                    :min="1"
                    :max="80"
                    class="w-20"
                  />
                </div>
              </div>

              <!-- Input 2: Avg kg per person -->
              <div class="space-y-2">
                <Label>Priemerný odber na osobu (kg)</Label>
                <div class="flex items-center gap-3">
                  <input
                    type="range"
                    :min="0.1"
                    :max="3.0"
                    :step="0.1"
                    v-model.number="simAvgKg"
                    class="flex-1 h-2 accent-primary cursor-pointer"
                  />
                  <Input
                    type="number"
                    v-model.number="simAvgKg"
                    :min="0.1"
                    :max="3.0"
                    :step="0.1"
                    class="w-20"
                  />
                </div>
              </div>
            </div>

            <!-- Output -->
            <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div class="rounded-lg border p-4 text-center">
                <p class="text-sm text-muted-foreground mb-1">Celkovo kg</p>
                <p class="text-2xl font-bold">{{ simTotalKg }}</p>
              </div>
              <div class="rounded-lg border p-4 text-center">
                <p class="text-sm text-muted-foreground mb-1">Úroveň zľavy</p>
                <p class="text-2xl font-bold">{{ simTierLabel }}</p>
              </div>
              <div :class="['rounded-lg border p-4 text-center', simMarginPerCycle > 0 ? 'bg-green-50 border-green-200' : '']">
                <p class="text-sm text-muted-foreground mb-1">Marža / cyklus</p>
                <p :class="['text-2xl font-bold', simMarginPerCycle > 0 ? 'text-green-700' : '']">
                  {{ simMarginPerCycle.toFixed(2) }} &euro;
                </p>
              </div>
              <div :class="['rounded-lg border p-4 text-center', simAnnualMargin > 0 ? 'bg-green-50 border-green-200' : '']">
                <p class="text-sm text-muted-foreground mb-1">Ročná marža (12 cyklov)</p>
                <p :class="['text-2xl font-bold', simAnnualMargin > 0 ? 'text-green-700' : '']">
                  {{ simAnnualMargin.toFixed(2) }} &euro;
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- ============================== -->
        <!-- Part D: Cycle Trends Chart      -->
        <!-- ============================== -->
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

        <!-- ============================== -->
        <!-- Part E: Comparison Cards        -->
        <!-- ============================== -->
        <div v-if="comparison" class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card v-for="(item, key) in [
            { key: 'total_kg', label: 'Celkové kg', fmt: (v) => v.toFixed(1) },
            { key: 'num_friends', label: 'Priatelia', fmt: (v) => v },
            { key: 'avg_kg_per_person', label: 'Priemer kg/os', fmt: (v) => v.toFixed(2) },
            { key: 'operator_margin', label: 'Marža', fmt: (v) => v.toFixed(2) },
          ]" :key="item.key">
            <CardContent class="pt-6 text-center">
              <p class="text-sm text-muted-foreground mb-1">{{ item.label }}</p>
              <p class="text-2xl font-bold">
                {{ item.fmt(comparison[item.key].current) }}
                <span v-if="comparison[item.key].unit" class="text-sm font-normal text-muted-foreground">{{ comparison[item.key].unit }}</span>
              </p>
              <div class="mt-1 text-sm flex items-center justify-center gap-1">
                <span v-if="comparison[item.key].direction === 'up'" class="text-green-600">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                </span>
                <span v-else-if="comparison[item.key].direction === 'down'" class="text-red-600">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </span>
                <span v-else class="text-gray-400">—</span>
                <span :class="{
                  'text-green-600': comparison[item.key].direction === 'up',
                  'text-red-600': comparison[item.key].direction === 'down',
                  'text-gray-400': comparison[item.key].direction === 'flat',
                }">
                  {{ comparison[item.key].direction === 'flat' ? '0%' : (comparison[item.key].pct > 0 ? '+' : '') + comparison[item.key].pct + '%' }}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        <!-- ============================== -->
        <!-- Part F: Friend Segments         -->
        <!-- ============================== -->
        <Card v-if="data.friends && data.friends.length > 0">
          <CardHeader>
            <CardTitle>Segmenty priateľov</CardTitle>
          </CardHeader>
          <CardContent>
            <SegmentDonutChart :friends="data.friends" />
          </CardContent>
        </Card>

        <!-- ============================== -->
        <!-- Part G: Friend Table            -->
        <!-- ============================== -->
        <Card v-if="data.friends && data.friends.length > 0">
          <CardHeader>
            <CardTitle>Prehľad priateľov</CardTitle>
          </CardHeader>
          <CardContent>
            <FriendAnalyticsTable :friends="data.friends" />
          </CardContent>
        </Card>

      </div>
    </main>
  </div>
</template>
