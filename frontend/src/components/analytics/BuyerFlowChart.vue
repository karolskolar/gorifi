<script setup>
import { computed } from 'vue'
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

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
)

const props = defineProps({
  cycles: {
    type: Array,
    required: true,
  },
})

// Skip first cycle (no previous comparison)
const relevantCycles = computed(() => props.cycles.slice(1))

const labels = computed(() =>
  relevantCycles.value.map((c) =>
    new Date(c.created_at).toLocaleDateString('sk-SK', {
      month: 'short',
      year: 'numeric',
    })
  )
)

const chartData = computed(() => ({
  labels: labels.value,
  datasets: [
    {
      label: 'Vr\u00E1ten\u00ED',
      data: relevantCycles.value.map((c) => c.returning_friends ?? 0),
      backgroundColor: 'rgba(59, 130, 246, 0.7)',
      borderColor: 'rgb(59, 130, 246)',
      borderWidth: 1,
      stack: 'active',
    },
    {
      label: 'Nov\u00ED',
      data: relevantCycles.value.map((c) => c.new_friends ?? 0),
      backgroundColor: 'rgba(147, 51, 234, 0.7)',
      borderColor: 'rgb(147, 51, 234)',
      borderWidth: 1,
      stack: 'active',
    },
    {
      label: 'Odchody',
      data: relevantCycles.value.map((c) => -(c.churned_friends ?? 0)),
      backgroundColor: 'rgba(239, 68, 68, 0.7)',
      borderColor: 'rgb(239, 68, 68)',
      borderWidth: 1,
      stack: 'churn',
    },
  ],
}))

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
        label(context) {
          const label = context.dataset.label || ''
          const value = Math.abs(context.raw)
          return `${label}: ${value}`
        },
      },
    },
  },
  scales: {
    x: {
      stacked: true,
    },
    y: {
      stacked: true,
    },
  },
}))
</script>

<template>
  <div v-if="cycles.length < 2" class="text-muted-foreground text-center py-8">
    Nedostatok d\u00E1t
  </div>
  <div v-else style="height: 250px;">
    <Bar :data="chartData" :options="chartOptions" />
  </div>
</template>
