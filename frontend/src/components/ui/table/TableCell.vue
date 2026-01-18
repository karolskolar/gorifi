<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})
</script>

<template>
  <td :class="cn('p-4 align-middle [&:has([role=checkbox])]:pr-0', props.class)">
    <slot />
  </td>
</template>
