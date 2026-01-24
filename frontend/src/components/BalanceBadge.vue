<script setup>
import { computed } from 'vue'

const props = defineProps({
  balance: {
    type: Number,
    required: true
  },
  showSign: {
    type: Boolean,
    default: true
  }
})

const formattedBalance = computed(() => {
  const sign = props.showSign && props.balance > 0 ? '+' : ''
  return `${sign}${props.balance.toFixed(2)} EUR`
})

const colorClass = computed(() => {
  if (props.balance > 0.01) return 'text-green-600 bg-green-100'
  if (props.balance < -0.01) return 'text-red-600 bg-red-100'
  return 'text-gray-600 bg-gray-100'
})
</script>

<template>
  <span :class="['inline-flex items-center px-2 py-0.5 rounded text-sm font-medium', colorClass]">
    {{ formattedBalance }}
  </span>
</template>
