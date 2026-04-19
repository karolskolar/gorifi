<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'
import { Bar } from 'vue-chartjs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend)

const router = useRouter()
const loading = ref(true)
const error = ref('')
const data = ref(null)

// Sliding window
const WINDOW_SIZE = 3
const windowStart = ref(0)

onMounted(async () => {
  await loadData()
})

watchEffect(() => {
  document.title = 'Odmeny — Gorifi'
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    data.value = await api.getRewardsReport(12)
    // Start at the end (most recent cycles)
    if (data.value?.cycles.length > WINDOW_SIZE) {
      windowStart.value = data.value.cycles.length - WINDOW_SIZE
    } else {
      windowStart.value = 0
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

const allCycles = computed(() => data.value?.cycles || [])
const groups = computed(() => data.value?.groups || [])

// Visible window of cycles
const visibleCycles = computed(() => {
  return allCycles.value.slice(windowStart.value, windowStart.value + WINDOW_SIZE)
})

const canGoBack = computed(() => windowStart.value > 0)
const canGoForward = computed(() => windowStart.value + WINDOW_SIZE < allCycles.value.length)

function goBack() {
  if (canGoBack.value) windowStart.value--
}
function goForward() {
  if (canGoForward.value) windowStart.value++
}

// Color palette for groups
const GROUP_COLORS = [
  { bg: 'rgba(59, 130, 246, 0.7)', border: 'rgb(59, 130, 246)' },     // blue
  { bg: 'rgba(34, 197, 94, 0.7)', border: 'rgb(34, 197, 94)' },       // green
  { bg: 'rgba(245, 158, 11, 0.7)', border: 'rgb(245, 158, 11)' },     // amber
  { bg: 'rgba(168, 85, 247, 0.7)', border: 'rgb(168, 85, 247)' },     // purple
  { bg: 'rgba(236, 72, 153, 0.7)', border: 'rgb(236, 72, 153)' },     // pink
  { bg: 'rgba(20, 184, 166, 0.7)', border: 'rgb(20, 184, 166)' },     // teal
  { bg: 'rgba(249, 115, 22, 0.7)', border: 'rgb(249, 115, 22)' },     // orange
  { bg: 'rgba(99, 102, 241, 0.7)', border: 'rgb(99, 102, 241)' },     // indigo
]
const OSTATNI_COLOR = { bg: 'rgba(156, 163, 175, 0.5)', border: 'rgb(156, 163, 175)' } // gray

function getGroupColor(index, group) {
  if (!group.rootFriend) return OSTATNI_COLOR
  return GROUP_COLORS[index % GROUP_COLORS.length]
}

function getGroupName(group) {
  if (group.rootFriend) return group.rootFriend.displayName || group.rootFriend.name
  return group.label || 'Ostatní'
}

// Chart data
const chartData = computed(() => {
  const labels = visibleCycles.value.map(c => c.name)
  const visibleCycleIds = visibleCycles.value.map(c => c.id)

  const datasets = groups.value.map((group, i) => {
    const color = getGroupColor(i, group)
    return {
      label: getGroupName(group),
      data: visibleCycleIds.map(cycleId => {
        const pc = group.perCycle.find(p => p.cycleId === cycleId)
        return pc ? pc.kg : 0
      }),
      backgroundColor: color.bg,
      borderColor: color.border,
      borderWidth: 1,
      borderRadius: 3,
    }
  })

  return { labels, datasets }
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
      position: 'bottom',
      labels: {
        padding: 16,
        usePointStyle: true,
        pointStyle: 'rectRounded',
      },
    },
    tooltip: {
      callbacks: {
        label(context) {
          const kg = context.parsed.y
          if (kg === 0) return null
          return `${context.dataset.label}: ${kg.toFixed(2)} kg`
        },
        afterBody(tooltipItems) {
          const cycleIndex = tooltipItems[0]?.dataIndex
          if (cycleIndex == null) return ''
          const cycleId = visibleCycles.value[cycleIndex]?.id
          if (!cycleId) return ''

          // Show members who ordered
          const lines = []
          for (const group of groups.value) {
            const pc = group.perCycle.find(p => p.cycleId === cycleId)
            if (pc && pc.orderedMembers.length > 0) {
              lines.push(`  ${getGroupName(group)}: ${pc.orderedMembers.join(', ')}`)
            }
          }
          if (lines.length > 0) {
            return ['\nObjednali:', ...lines]
          }
          return ''
        },
      },
    },
  },
  scales: {
    y: {
      beginAtZero: true,
      title: {
        display: true,
        text: 'kg',
      },
      ticks: {
        callback: (val) => val + ' kg',
      },
    },
    x: {
      grid: {
        display: false,
      },
    },
  },
}))

// Summary cards
const totalCumulativeKg = computed(() => {
  return groups.value.reduce((sum, g) => sum + g.cumulativeKg, 0)
})

const totalGroups = computed(() => {
  return groups.value.filter(g => g.rootFriend).length
})
</script>

<template>
  <div class="max-w-7xl mx-auto p-4 space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <Button variant="ghost" size="sm" @click="router.push('/admin/dashboard')">
          &larr; Spat
        </Button>
        <h1 class="text-2xl font-bold">Statistiky</h1>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="router.push('/admin/friend-groups')">
          Spravovat skupiny
        </Button>
        <Button variant="outline" size="sm" @click="loadData" :disabled="loading">
          Obnovit
        </Button>
      </div>
    </div>

    <!-- Tab navigation -->
    <div class="flex gap-1 border-b">
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground"
        @click="router.push('/admin/analytics/live')"
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
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 border-primary text-primary"
      >
        Odmeny
      </button>
    </div>

    <Alert v-if="error" variant="destructive">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div v-if="loading && !data" class="text-center py-12 text-muted-foreground">
      Nacitavam...
    </div>

    <template v-else-if="data">
      <!-- No data states -->
      <div v-if="allCycles.length === 0" class="text-center py-12">
        <p class="text-muted-foreground">Ziadne dokoncene kavove cykly</p>
      </div>

      <div v-else-if="groups.length === 0" class="text-center py-12 space-y-4">
        <p class="text-muted-foreground">Ziadne skupiny. Najprv vytvorte skupiny priatelov.</p>
        <Button variant="outline" @click="router.push('/admin/friend-groups')">
          Spravovat skupiny
        </Button>
      </div>

      <template v-else>
        <!-- Summary -->
        <div class="grid grid-cols-3 gap-4">
          <Card>
            <CardContent class="pt-4 pb-3 text-center">
              <div class="text-2xl font-bold">{{ totalGroups }}</div>
              <div class="text-xs text-muted-foreground">skupin</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="pt-4 pb-3 text-center">
              <div class="text-2xl font-bold">{{ allCycles.length }}</div>
              <div class="text-xs text-muted-foreground">cyklov</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent class="pt-4 pb-3 text-center">
              <div class="text-2xl font-bold">{{ totalCumulativeKg.toFixed(1) }} kg</div>
              <div class="text-xs text-muted-foreground">celkom</div>
            </CardContent>
          </Card>
        </div>

        <!-- Chart with navigation -->
        <Card>
          <CardHeader class="pb-2">
            <div class="flex items-center justify-between">
              <CardTitle class="text-lg">Objednavky podla skupin</CardTitle>
              <div class="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="!canGoBack"
                  @click="goBack"
                  class="h-8 w-8 p-0"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd" />
                  </svg>
                </Button>
                <span class="text-sm text-muted-foreground whitespace-nowrap">
                  {{ windowStart + 1 }}–{{ Math.min(windowStart + WINDOW_SIZE, allCycles.length) }} z {{ allCycles.length }}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="!canGoForward"
                  @click="goForward"
                  class="h-8 w-8 p-0"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
                  </svg>
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div style="height: 400px;">
              <Bar :data="chartData" :options="chartOptions" :key="windowStart" />
            </div>
          </CardContent>
        </Card>

        <!-- Cumulative totals per group -->
        <Card>
          <CardHeader class="pb-2">
            <CardTitle class="text-lg">Celkove kg podla skupin</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="space-y-3">
              <div v-for="(group, i) in groups" :key="i" class="flex items-center gap-3">
                <div
                  class="w-3 h-3 rounded-sm shrink-0"
                  :style="{ backgroundColor: getGroupColor(i, group).border }"
                ></div>
                <span class="font-medium flex-1">{{ getGroupName(group) }}</span>
                <Badge variant="secondary" class="text-xs">{{ group.memberCount }} {{ group.memberCount === 1 ? 'clen' : 'clenov' }}</Badge>
                <span class="font-bold tabular-nums">{{ group.cumulativeKg.toFixed(2) }} kg</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </template>
    </template>
  </div>
</template>
