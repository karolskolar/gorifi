<script setup>
import { computed } from 'vue'
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { Doughnut } from 'vue-chartjs'

ChartJS.register(ArcElement, Tooltip, Legend)

const props = defineProps({
  friends: {
    type: Array,
    required: true,
  },
})

const SEGMENT_ORDER = ['core', 'regular', 'occasional', 'new', 'inactive']

const SEGMENT_COLORS = {
  core: { bg: 'rgba(34, 197, 94, 0.7)', border: 'rgb(34, 197, 94)' },
  regular: { bg: 'rgba(59, 130, 246, 0.7)', border: 'rgb(59, 130, 246)' },
  occasional: { bg: 'rgba(245, 158, 11, 0.7)', border: 'rgb(245, 158, 11)' },
  new: { bg: 'rgba(168, 85, 247, 0.7)', border: 'rgb(168, 85, 247)' },
  inactive: { bg: 'rgba(156, 163, 175, 0.7)', border: 'rgb(156, 163, 175)' },
}

const segments = computed(() => {
  const map = {}
  for (const f of props.friends) {
    const seg = f.segment?.segment || 'inactive'
    if (!map[seg]) {
      map[seg] = { segment: seg, label: f.segment?.label || seg, count: 0, totalKg: 0 }
    }
    map[seg].count++
    map[seg].totalKg += f.total_kg || 0
  }
  return SEGMENT_ORDER.filter((s) => map[s]).map((s) => map[s])
})

const totalKg = computed(() => segments.value.reduce((sum, s) => sum + s.totalKg, 0))

const chartData = computed(() => ({
  labels: segments.value.map((s) => s.label),
  datasets: [
    {
      data: segments.value.map((s) => s.count),
      backgroundColor: segments.value.map((s) => SEGMENT_COLORS[s.segment]?.bg),
      borderColor: segments.value.map((s) => SEGMENT_COLORS[s.segment]?.border),
      borderWidth: 1,
    },
  ],
}))

const chartOptions = {
  responsive: false,
  cutout: '60%',
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        label(ctx) {
          const seg = segments.value[ctx.dataIndex]
          return `${seg.label}: ${seg.count} osôb, ${seg.totalKg.toFixed(1)} kg`
        },
      },
    },
  },
}

const coreInsight = computed(() => {
  const core = segments.value.find((s) => s.segment === 'core')
  if (!core || totalKg.value === 0) return null
  const pct = Math.round((core.totalKg / totalKg.value) * 100)
  return { count: core.count, pct }
})
</script>

<template>
  <div class="flex flex-col sm:flex-row items-start gap-6">
    <!-- Donut Chart -->
    <div class="flex-shrink-0">
      <Doughnut :data="chartData" :options="chartOptions" :style="{ width: '200px', height: '200px' }" />
    </div>

    <!-- Legend -->
    <div class="flex-1 space-y-2">
      <div
        v-for="seg in segments"
        :key="seg.segment"
        class="flex items-center gap-3 text-sm"
      >
        <span
          class="w-3 h-3 rounded-full flex-shrink-0"
          :style="{ backgroundColor: SEGMENT_COLORS[seg.segment]?.border }"
        />
        <span class="font-medium min-w-[80px]">{{ seg.label }}</span>
        <span class="text-muted-foreground">{{ seg.count }} osôb</span>
        <span class="text-muted-foreground">&middot;</span>
        <span class="text-muted-foreground">{{ seg.totalKg.toFixed(1) }} kg</span>
        <span class="text-muted-foreground">&middot;</span>
        <span class="text-muted-foreground">{{ totalKg > 0 ? Math.round(seg.totalKg / totalKg * 100) : 0 }}%</span>
      </div>

      <!-- Core insight -->
      <p v-if="coreInsight" class="text-sm text-muted-foreground mt-4 pt-3 border-t">
        Tvoje jadro ({{ coreInsight.count }} ľudí) tvorí {{ coreInsight.pct }}% celkového objemu
      </p>
    </div>
  </div>
</template>
