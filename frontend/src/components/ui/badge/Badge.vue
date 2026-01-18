<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { type BadgeVariants, badgeVariants } from '.'
import { cn } from '@/lib/utils'

const props = defineProps<{
  variant?: BadgeVariants['variant']
  class?: HTMLAttributes['class']
}>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})
</script>

<template>
  <div :class="cn(badgeVariants({ variant }), props.class)">
    <slot />
  </div>
</template>
