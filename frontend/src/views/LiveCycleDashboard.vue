<script setup>
import { ref, computed, onMounted, onUnmounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

const router = useRouter()
const data = ref(null)
const loading = ref(true)
const error = ref('')
const showAllNotOrdered = ref(false)
let refreshInterval = null

watchEffect(() => {
  document.title = 'Štatistiky — Gorifi'
})

onMounted(async () => {
  await loadData()
  refreshInterval = setInterval(loadData, 60000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

async function loadData() {
  try {
    loading.value = true
    data.value = await api.getLiveCycle()
    error.value = ''
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

const cycle = computed(() => data.value?.cycle)
const totals = computed(() => data.value?.totals)
const previous = computed(() => data.value?.previous)
const notOrdered = computed(() => data.value?.not_ordered || [])
const potentialKg = computed(() => data.value?.potential_kg || 0)

// Tier progress
const barMax = computed(() => {
  const kg = totals.value?.total_kg || 0
  return Math.max(51, kg * 1.2, 60)
})

const barColor = computed(() => {
  const kg = totals.value?.total_kg || 0
  if (kg >= 51) return 'bg-green-500'
  if (kg >= 26) return 'bg-blue-500'
  return 'bg-gray-400'
})

const tierMessage = computed(() => {
  if (!totals.value) return ''
  const kg = totals.value.total_kg
  if (kg >= 51) return '40% tier dosiahnuty!'
  if (kg >= 26) {
    const dist = (51 - kg).toFixed(1)
    return `35% tier dosiahnuty! Este ${dist} kg do 40%`
  }
  const dist = (26 - kg).toFixed(1)
  const friendsNeeded = totals.value.friends_needed || 0
  let msg = `Este ${dist} kg do 35% tieru`
  if (friendsNeeded > 0) {
    msg += ` (+ ${friendsNeeded} ludi pri priemernej objednavke)`
  }
  return msg
})

// Comparison deltas
function delta(current, prev) {
  if (prev == null || current == null) return null
  return current - prev
}

function formatDelta(val) {
  if (val == null) return ''
  const sign = val > 0 ? '+' : ''
  return sign + val.toFixed(2)
}

function deltaClass(val) {
  if (val == null) return ''
  if (val > 0) return 'text-green-600'
  if (val < 0) return 'text-red-600'
  return 'text-gray-500'
}

function deltaArrow(val) {
  if (val == null) return ''
  if (val > 0) return '\u25B2'
  if (val < 0) return '\u25BC'
  return ''
}

// Segment badges
const segmentClasses = {
  core: 'bg-green-100 text-green-800',
  regular: 'bg-blue-100 text-blue-800',
  occasional: 'bg-amber-100 text-amber-800',
  new: 'bg-purple-100 text-purple-800',
  inactive: 'bg-gray-100 text-gray-600'
}

const visibleNotOrdered = computed(() => {
  if (showAllNotOrdered.value) return notOrdered.value
  return notOrdered.value.slice(0, 10)
})
</script>

<template>
  <div class="max-w-4xl mx-auto p-4 space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <Button variant="ghost" size="sm" @click="router.push('/admin/dashboard')">
          &larr; Spat
        </Button>
        <h1 class="text-2xl font-bold">Statistiky</h1>
      </div>
      <Button variant="outline" size="sm" @click="loadData" :disabled="loading">
        Obnovit data
      </Button>
    </div>

    <!-- Tab navigation -->
    <div class="flex gap-1 border-b">
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 border-primary text-primary"
      >
        Zivy prehlad
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground"
        @click="router.push('/admin/analytics/coffee')"
      >
        Kava
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground"
        @click="router.push('/admin/analytics/bakery')"
      >
        Pekaren
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading && !data" class="text-center py-12 text-muted-foreground">
      Nacitavam...
    </div>

    <!-- No active cycle -->
    <div v-else-if="!cycle" class="text-center py-12 space-y-4">
      <p class="text-lg text-muted-foreground">Ziadny aktivny kavovy cyklus</p>
      <Button variant="outline" @click="router.push('/admin/dashboard')">
        &larr; Spat na dashboard
      </Button>
    </div>

    <!-- Active cycle content -->
    <template v-else>
      <!-- Section 1: Tier progress bar -->
      <Card>
        <CardContent class="pt-6 space-y-4">
          <div class="text-center">
            <span class="text-4xl font-bold">{{ totals.total_kg?.toFixed(1) }}</span>
            <span class="text-xl text-muted-foreground ml-1">kg</span>
          </div>

          <!-- Progress bar container -->
          <div class="relative">
            <!-- Threshold labels -->
            <div class="relative h-6 text-xs text-muted-foreground">
              <span
                class="absolute"
                :style="{ left: (26 / barMax * 100) + '%', transform: 'translateX(-50%)' }"
              >26 kg</span>
              <span
                class="absolute"
                :style="{ left: (51 / barMax * 100) + '%', transform: 'translateX(-50%)' }"
              >51 kg</span>
            </div>

            <!-- Bar -->
            <div class="relative h-5 bg-muted rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="barColor"
                :style="{ width: Math.min(100, (totals.total_kg / barMax) * 100) + '%' }"
              />
              <!-- 26 kg marker -->
              <div
                class="absolute top-0 bottom-0 border-l-2 border-dashed border-gray-500"
                :style="{ left: (26 / barMax * 100) + '%' }"
              />
              <!-- 51 kg marker -->
              <div
                class="absolute top-0 bottom-0 border-l-2 border-dashed border-gray-500"
                :style="{ left: (51 / barMax * 100) + '%' }"
              />
            </div>
          </div>

          <p class="text-sm text-center text-muted-foreground">{{ tierMessage }}</p>
        </CardContent>
      </Card>

      <!-- Section 2: Key metric cards -->
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card>
          <CardContent class="pt-4 pb-4">
            <p class="text-xs text-muted-foreground">Celkovo kg</p>
            <p class="text-2xl font-bold">{{ totals.total_kg?.toFixed(2) }}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent class="pt-4 pb-4">
            <p class="text-xs text-muted-foreground">Objednalo</p>
            <p class="text-2xl font-bold">{{ totals.num_friends }} <span class="text-sm font-normal text-muted-foreground">z {{ totals.total_eligible }}</span></p>
          </CardContent>
        </Card>

        <Card>
          <CardContent class="pt-4 pb-4">
            <p class="text-xs text-muted-foreground">Priemer na osobu</p>
            <p class="text-2xl font-bold">{{ totals.avg_kg_per_person?.toFixed(2) }} <span class="text-sm font-normal text-muted-foreground">kg</span></p>
          </CardContent>
        </Card>

        <Card>
          <CardContent class="pt-4 pb-4">
            <p class="text-xs text-muted-foreground">Hodnota objednavok</p>
            <p class="text-2xl font-bold">{{ totals.total_value?.toFixed(2) }} <span class="text-sm font-normal text-muted-foreground">EUR</span></p>
          </CardContent>
        </Card>

        <Card>
          <CardContent class="pt-4 pb-4">
            <p class="text-xs text-muted-foreground">Odhadovana marza</p>
            <p class="text-2xl font-bold" :class="totals.operator_margin > 0 ? 'text-green-600' : ''">
              {{ totals.operator_margin?.toFixed(2) }} <span class="text-sm font-normal text-muted-foreground">EUR</span>
            </p>
            <p v-if="totals.operator_margin === 0" class="text-xs text-muted-foreground">30% tier</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent class="pt-4 pb-4">
            <p class="text-xs text-muted-foreground">Aktualny tier</p>
            <Badge
              v-if="totals.tier_label"
              :class="totals.total_kg >= 51 ? 'bg-green-100 text-green-800' : totals.total_kg >= 26 ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'"
              class="mt-1"
            >
              {{ totals.tier_label }} ({{ totals.tier_discount }}%)
            </Badge>
          </CardContent>
        </Card>
      </div>

      <!-- Section 3: Comparison with previous cycle -->
      <Card>
        <CardHeader>
          <CardTitle class="text-lg">Porovnanie s predoslym cyklom</CardTitle>
        </CardHeader>
        <CardContent>
          <div v-if="!previous" class="text-muted-foreground text-sm">
            Prvy cyklus — ziadne porovnanie
          </div>
          <template v-else>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p class="text-xs text-muted-foreground">Celkovo kg</p>
                <p class="text-lg font-semibold">{{ totals.total_kg?.toFixed(2) }}</p>
                <p class="text-sm" :class="deltaClass(delta(totals.total_kg, previous.total_kg))">
                  {{ deltaArrow(delta(totals.total_kg, previous.total_kg)) }}
                  {{ formatDelta(delta(totals.total_kg, previous.total_kg)) }}
                </p>
              </div>
              <div>
                <p class="text-xs text-muted-foreground">Pocet ludi</p>
                <p class="text-lg font-semibold">{{ totals.num_friends }}</p>
                <p class="text-sm" :class="deltaClass(delta(totals.num_friends, previous.num_friends))">
                  {{ deltaArrow(delta(totals.num_friends, previous.num_friends)) }}
                  {{ formatDelta(delta(totals.num_friends, previous.num_friends)) }}
                </p>
              </div>
              <div>
                <p class="text-xs text-muted-foreground">Priemer kg</p>
                <p class="text-lg font-semibold">{{ totals.avg_kg_per_person?.toFixed(2) }}</p>
                <p class="text-sm" :class="deltaClass(delta(totals.avg_kg_per_person, previous.avg_kg_per_person))">
                  {{ deltaArrow(delta(totals.avg_kg_per_person, previous.avg_kg_per_person)) }}
                  {{ formatDelta(delta(totals.avg_kg_per_person, previous.avg_kg_per_person)) }}
                </p>
              </div>
              <div>
                <p class="text-xs text-muted-foreground">Hodnota</p>
                <p class="text-lg font-semibold">{{ totals.total_value?.toFixed(2) }} EUR</p>
                <p class="text-sm" :class="deltaClass(delta(totals.total_value, previous.total_value))">
                  {{ deltaArrow(delta(totals.total_value, previous.total_value)) }}
                  {{ formatDelta(delta(totals.total_value, previous.total_value)) }}
                </p>
              </div>
            </div>
            <p class="text-xs text-muted-foreground mt-3">
              Cyklus este prebieha — porovnanie s konecnym stavom predosleho cyklu
            </p>
          </template>
        </CardContent>
      </Card>

      <!-- Section 4: Who hasn't ordered -->
      <Card v-if="cycle.status === 'open'">
        <CardHeader>
          <CardTitle class="text-lg">
            <template v-if="notOrdered.length > 0">
              Este neobjednalo: {{ notOrdered.length }} ludi
            </template>
            <template v-else>
              Vsetci priatelia uz objednali!
            </template>
          </CardTitle>
        </CardHeader>
        <CardContent v-if="notOrdered.length > 0" class="space-y-3">
          <div
            v-for="friend in visibleNotOrdered"
            :key="friend.id"
            class="flex items-center justify-between py-1"
          >
            <div class="flex items-center gap-2">
              <span class="text-sm">{{ friend.name }}</span>
              <span
                v-if="friend.segment"
                class="text-xs px-2 py-0.5 rounded-full"
                :class="segmentClasses[friend.segment.segment] || 'bg-gray-100 text-gray-600'"
              >
                {{ friend.segment.label }}
              </span>
            </div>
            <span v-if="friend.ordered_previous" class="text-xs text-muted-foreground">
              minule objednal/a
            </span>
          </div>

          <Button
            v-if="notOrdered.length > 10 && !showAllNotOrdered"
            variant="ghost"
            size="sm"
            class="w-full"
            @click="showAllNotOrdered = true"
          >
            Zobrazit vsetkych ({{ notOrdered.length }})
          </Button>

          <p class="text-xs text-muted-foreground pt-2">
            Ak objednaju vsetci, potencialne + {{ potentialKg.toFixed(1) }} kg
          </p>
        </CardContent>
      </Card>
    </template>

    <!-- Error -->
    <Alert v-if="error" variant="destructive">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>
  </div>
</template>
