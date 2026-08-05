<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { TabsList, type TabsListProps } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = defineProps<TabsListProps & { class?: HTMLAttributes['class'] }>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})
</script>

<template>
  <TabsList
    v-bind="delegatedProps"
    :class="cn(
      // max-w-full + overflow-x-auto: every trigger is `whitespace-nowrap`, so a
      // strip with several tabs has a min-content width that can exceed a phone
      // viewport. Without these the inline-flex widens the DOCUMENT instead,
      // making the whole page scroll sideways and clipping content off the left
      // edge (measured: 46px overflow at 390px with five purpose tabs). Now the
      // strip scrolls within itself and the page never does.
      'inline-flex h-10 max-w-full items-center justify-center overflow-x-auto rounded-md bg-muted p-1 text-muted-foreground',
      props.class,
    )"
  >
    <slot />
  </TabsList>
</template>
