<script setup>
import { computed, watchEffect } from 'vue'
import { ICONS } from './icons.js'

const props = defineProps({
  name: { type: String, required: true },
  // Overrides the per-icon default from the `icons.js` table. The glyph always uses the
  // 0 0 24 24 viewBox, so it scales rather than crops.
  size: { type: Number, default: null }
})

// Own-property lookup, not `ICONS[name]` — a prototype key ("constructor", "toString")
// would otherwise resolve to a function and blow up the render (same class of bug as
// the `variantGrams()` stock bypass); those names must take the unknown-icon path.
const icon = computed(() =>
  Object.prototype.hasOwnProperty.call(ICONS, props.name) ? ICONS[props.name] : null
)

const px = computed(() => (props.size != null ? props.size : icon.value ? icon.value.size : null))

// An unknown name renders nothing rather than throwing — a missing glyph must never
// take a screen down. It is loud in dev and silent in production.
watchEffect(() => {
  if (!icon.value && import.meta.env.DEV) {
    console.warn(`[NeoIcon] unknown icon name "${props.name}" — rendering nothing.`)
  }
})
</script>

<template>
  <svg
    v-if="icon"
    :width="px"
    :height="px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="icon.strokeWidth"
  >
    <component :is="shape.tag" v-for="(shape, i) in icon.shapes" :key="i" v-bind="shape.attrs" />
  </svg>
</template>
