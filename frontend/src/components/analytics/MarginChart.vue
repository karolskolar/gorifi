<script setup>
import { computed } from 'vue'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  LineController,
  BarController,
  PointElement,
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
  LineElement,
  LineController,
  BarController,
  PointElement,
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
  cumulativeMarginAll: {
    type: Number,
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

const cumulativeData = computed(() => {
  let sum = 0
  return props.cycles.map((c) => {
    sum += c.operator_margin ?? 0
    return Math.round(sum * 100) / 100
  })
})

const barColors = computed(() =>
  props.cycles.map((c) =>
    (c.operator_margin ?? 0) > 0
      ? 'rgba(34, 197, 94, 0.7)'
      : 'rgba(239, 68, 68, 0.2)'
  )
)

const barBorderColors = computed(() =>
  props.cycles.map((c) =>
    (c.operator_margin ?? 0) > 0
      ? 'rgb(34, 197, 94)'
      : 'rgb(239, 68, 68)'
  )
)

const chartData = computed(() => ({
  labels: labels.value,
  datasets: [
    {
      type: 'bar',
      label: 'Marža za cyklus',
      data: props.cycles.map((c) => c.operator_margin ?? 0),
      backgroundColor: barColors.value,
      borderColor: barBorderColors.value,
      borderWidth: 1,
      yAxisID: 'y',
      order: 2,
    },
    {
      type: 'line',
      label: 'Kumulatívna marža',
      data: cumulativeData.value,
      borderColor: 'rgb(99, 102, 241)',
      backgroundColor: 'rgba(99, 102, 241, 0.1)',
      pointBackgroundColor: 'rgb(99, 102, 241)',
      fill: true,
      tension: 0.3,
      yAxisID: 'y1',
      order: 1,
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
  },
  scales: {
    y: {
      type: 'linear',
      position: 'left',
      beginAtZero: true,
      title: {
        display: true,
        text: 'Marža za cyklus (\u20AC)',
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
        text: 'Kumulatívna marža (\u20AC)',
      },
    },
  },
}))
</script>

<template>
  <div style="height: 300px;">
    <Bar :data="chartData" :options="chartOptions" />
  </div>
</template>
