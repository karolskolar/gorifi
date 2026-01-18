<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { SwitchRoot, SwitchThumb } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  defaultChecked?: boolean
  checked?: boolean
  disabled?: boolean
  required?: boolean
  name?: string
  id?: string
  value?: string
  class?: HTMLAttributes['class']
}>()

const emits = defineEmits<{
  'update:checked': [value: boolean]
}>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})

const rootStyle = computed(() => ({
  backgroundColor: props.checked ? '#16a34a' : '#d1d5db'
}))

const thumbStyle = computed(() => ({
  transform: props.checked ? 'translateX(20px)' : 'translateX(0)',
  backgroundColor: '#ffffff'
}))
</script>

<template>
  <SwitchRoot
    v-bind="delegatedProps"
    :class="cn(
      'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
      props.class
    )"
    :style="rootStyle"
    @update:checked="emits('update:checked', $event)"
  >
    <SwitchThumb
      class="pointer-events-none block h-5 w-5 rounded-full shadow-lg ring-0 transition-transform"
      :style="thumbStyle"
    />
  </SwitchRoot>
</template>
