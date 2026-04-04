<script setup>
import { computed } from 'vue'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  LineController,
  BarController,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { Bar } from 'vue-chartjs'

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  LineController,
  BarController,
  Title,
  Tooltip,
  Legend,
  Filler,
)

const props = defineProps({
  cycles: {
    type: Array,
    required: true,
  },
})

const labels = computed(() =>
  props.cycles.map((c) =>
    new Date(c.created_at).toLocaleDateString('sk-SK', {
      month: 'short',
      year: 'numeric',
    })
  )
)

const barColors = computed(() =>
  props.cycles.map((c) => {
    if (c.total_kg >= 51) return 'rgba(34, 197, 94, 0.7)'  // green
    if (c.total_kg >= 26) return 'rgba(59, 130, 246, 0.7)'  // blue
    return 'rgba(245, 158, 11, 0.7)'                         // amber
  })
)

const barBorderColors = computed(() =>
  props.cycles.map((c) => {
    if (c.total_kg >= 51) return 'rgb(34, 197, 94)'
    if (c.total_kg >= 26) return 'rgb(59, 130, 246)'
    return 'rgb(245, 158, 11)'
  })
)

const chartDataWithThresholds = computed(() => ({
  labels: labels.value,
  datasets: [
    {
      type: 'bar',
      label: 'Celkové kg',
      data: props.cycles.map((c) => c.total_kg),
      backgroundColor: barColors.value,
      borderColor: barBorderColors.value,
      borderWidth: 1,
      yAxisID: 'y',
      order: 2,
    },
    {
      type: 'line',
      label: 'Priatelia',
      data: props.cycles.map((c) => c.num_friends),
      borderColor: 'rgb(99, 102, 241)',
      backgroundColor: 'rgba(99, 102, 241, 0.1)',
      pointBackgroundColor: 'rgb(99, 102, 241)',
      tension: 0.3,
      yAxisID: 'y1',
      order: 1,
    },
    {
      type: 'line',
      label: '35% hranica (26 kg)',
      data: Array(props.cycles.length).fill(26),
      borderColor: 'rgba(59, 130, 246, 0.5)',
      borderDash: [5, 5],
      pointRadius: 0,
      yAxisID: 'y',
      order: 0,
    },
    {
      type: 'line',
      label: '40% hranica (51 kg)',
      data: Array(props.cycles.length).fill(51),
      borderColor: 'rgba(34, 197, 94, 0.5)',
      borderDash: [5, 5],
      pointRadius: 0,
      yAxisID: 'y',
      order: 0,
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
        afterBody(tooltipItems) {
          const idx = tooltipItems[0]?.dataIndex
          if (idx == null) return ''
          const c = props.cycles[idx]
          if (!c) return ''
          const lines = []
          lines.push(`Priemer kg/os: ${(c.avg_kg_per_person ?? 0).toFixed(2)} kg`)
          lines.push(`Celková hodnota: ${(c.total_value ?? 0).toFixed(2)} \u20AC`)
          lines.push(`Priemer \u20AC/os: ${(c.avg_value_per_person ?? 0).toFixed(2)} \u20AC`)
          if (c.tier_label) lines.push(`Tier: ${c.tier_label}`)
          lines.push(`Mar\u017Ea: ${(c.operator_margin ?? 0).toFixed(2)} \u20AC`)
          return lines
        },
      },
    },
  },
  scales: {
    y: {
      type: 'linear',
      position: 'left',
      beginAtZero: true,
      title: {
        display: true,
        text: 'kg',
      },
    },
    y1: {
      type: 'linear',
      position: 'right',
      beginAtZero: true,
      grid: {
        drawOnChartArea: false,
      },
      title: {
        display: true,
        text: 'Priatelia',
      },
    },
  },
}))
</script>

<template>
  <div style="height: 350px;">
    <Bar :data="chartDataWithThresholds" :options="chartOptions" />
  </div>
</template>
