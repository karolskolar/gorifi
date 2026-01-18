<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { type AlertVariants, alertVariants } from '.'
import { cn } from '@/lib/utils'

const props = defineProps<{
  variant?: AlertVariants['variant']
  class?: HTMLAttributes['class']
}>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})
</script>

<template>
  <div :class="cn(alertVariants({ variant }), props.class)" role="alert">
    <slot />
  </div>
</template>
