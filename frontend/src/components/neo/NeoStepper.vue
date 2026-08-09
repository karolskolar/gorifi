<script setup>
// The quantity stepper (UC-DS-008) — the control every product variant box and cart
// line uses. Transcribed from `docs/design/friends-portal-redesign/friends/ui.jsx`
// `Stepper`: same three children in the same order, same `−`/`+` glyphs (U+2212
// MINUS SIGN, not a hyphen), same Slovak aria-labels.
//
// ⚠ There is deliberately NO `max` prop. Stock ceilings are business logic the
// consuming views enforce against server availability (`backend/src/helpers/stock.js`
// is the authority); baking a max in here would move that rule into a dumb primitive
// and let it silently fork from the server's. Views that need a ceiling pass
// `incDisabled`.

const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  disabled: { type: Boolean, default: false },
  // Disables ONLY "+" — module 06's stock-ceiling state, where the guest must still
  // be able to remove what they already put in the cart.
  //
  // ⚠ The ported stylesheet has no `.stepper button:disabled` rule (only
  // `.stepper.disabled button`), so this state currently has no visual affordance.
  // Left as-is deliberately: an inline style here would be unoverridable by module 06,
  // which owns the stock-ceiling UX. Flagged to the orchestrator as a spec gap.
  incDisabled: { type: Boolean, default: false },
  // Optional `data-testid` pass-throughs so consuming views keep their already-pinned
  // e2e hooks (modules 04/06). `null` — the default — binds to nothing at all: Vue
  // omits a null/undefined attribute, so the DOM carries no `data-testid` rather than
  // the literal string "undefined".
  decTestid: { type: String, default: null },
  valTestid: { type: String, default: null },
  incTestid: { type: String, default: null }
})

const emit = defineEmits(['update:modelValue'])

// `.stepper.disabled button` sets `pointer-events:none` and the buttons also carry the
// real `disabled` attribute — but neither reliably stops a programmatic `.click()`
// from reaching the handler, so the guard is re-asserted in JS. A locked cycle must
// not be mutable by any path.
function dec() {
  if (props.disabled) return
  const next = Math.max(props.min, props.modelValue - 1)
  // No emit when the value cannot change (already at `min`). ui.jsx emits regardless,
  // but here the emit is the change signal the views hang auto-save and
  // unsaved-changes detection off (CLAUDE.md order auto-save rules) — a no-op tap at 0
  // must not mark a cart dirty or fire a save. `modelValue` is identical either way,
  // so nothing in the v-model contract can observe the difference.
  if (next === props.modelValue) return
  emit('update:modelValue', next)
}

function inc() {
  if (props.disabled || props.incDisabled) return
  emit('update:modelValue', props.modelValue + 1)
}
</script>

<template>
  <div class="stepper" :class="{ disabled }">
    <button
      type="button"
      aria-label="menej"
      :disabled="disabled"
      :data-testid="decTestid"
      @click="dec"
    >−</button>
    <span class="val" :data-testid="valTestid">{{ modelValue }}</span>
    <button
      type="button"
      aria-label="viac"
      :disabled="disabled || incDisabled"
      :data-testid="incTestid"
      @click="inc"
    >+</button>
  </div>
</template>
