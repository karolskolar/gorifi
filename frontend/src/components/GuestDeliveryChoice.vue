<script setup>
// 20 §UC-GP-003 — THE ONE HOME of the guest delivery choice: „Prevezmem od {host}"
// (default) / „Poslať Packetou (+fee)" plus the free-text Packeta point. Consumed by
// the checkout modal (`views/GuestOrder.vue`, GP-T3) AND the status page's edit mode
// (`views/GuestOrderStatus.vue`, GP-T4) — extend, never fork.
//
// ⚠ RENDERS NOTHING when `parcelEnabled` is false. That is the whole parcel-off
// contract: the checkout modal of a cycle without parcels is element-for-element
// today's (the `guest-order*.spec.js` pins hold unchanged).
//
// ⚠ The component owns PRESENTATION only. It never decides what is sent: the caller
// reads the two v-models and builds its own payload (checkout sends the delivery keys
// ONLY for Packeta; the edit PUT always sends them — two different contracts, 20
// §UC-GP-003 item 5 vs §UC-GP-007 item 9). Validation messages are the caller's too
// (they render in the caller's own error banner).
//
// Markup = FriendOrder.vue's RadioRow recipe (04 §UC-FO-010, `order.jsx:203-208`):
// the native radio STAYS in the DOM, clip-rect hidden (`.sr-radio`), so the label is
// the tap target and a same-`name` group gives arrow keys + one Tab stop; the 18px
// dot is the visible state; `:has(:focus-visible)` paints the keyboard ring. The two
// scoped rules below are that file's, copied rather than moved (they are a local
// pattern, not a theme class — FriendOrder.vue's own note on why they are scoped).
//
// Money: the fee is `fmtEur` — „(+3.50 EUR)" (ORCHESTRATOR DECISION, GP-T3 review:
// the spec's own formula, FriendOrder's identical radio, and the hero badge — one fee,
// one format on the page; learnings 12 §16). ⚠ DRAFT PO copy
// (staging sign-off, PO 2026-09-19) — reproduce, never improve.
import { computed } from 'vue'
import { fmtEur } from '@/lib/money'

const props = defineProps({
  modelValue: { type: String, default: 'via_host' }, // 'via_host' | 'packeta'
  packetaAddress: { type: String, default: '' },
  hostFirstName: { type: String, default: '' },
  parcelFee: { type: Number, default: 0 },
  parcelEnabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'update:packetaAddress'])

const method = computed({
  get: () => (props.modelValue === 'packeta' ? 'packeta' : 'via_host'),
  set: (value) => emit('update:modelValue', value)
})
const address = computed({
  get: () => props.packetaAddress,
  set: (value) => emit('update:packetaAddress', value)
})

const feeLabel = computed(() => `(+${fmtEur(props.parcelFee)})`)

const OPTIONS = [
  { value: 'via_host', testid: 'guest-delivery-via-host' },
  { value: 'packeta', testid: 'guest-delivery-packeta' }
]

function rowStyle(value) {
  const on = method.value === value
  return {
    padding: '11px 13px',
    display: 'flex',
    position: 'relative',
    alignItems: 'center',
    gap: '10px',
    cursor: 'pointer',
    borderColor: on ? 'var(--nb-ink)' : 'rgba(10,10,10,0.3)',
    background: on ? 'var(--accent-soft)' : '#fff'
  }
}
function dotStyle(value) {
  return {
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    border: '3px solid var(--nb-ink)',
    background: method.value === value ? 'var(--accent)' : '#fff',
    flexShrink: 0
  }
}
</script>

<template>
  <div
    v-if="parcelEnabled"
    data-testid="guest-delivery-choice"
    role="radiogroup"
    aria-labelledby="guest-delivery-lbl"
    style="display:flex;flex-direction:column;gap:8px"
  >
    <span id="guest-delivery-lbl" class="field-lbl" style="margin:0">Spôsob prevzatia</span>
    <label
      v-for="opt in OPTIONS"
      :key="opt.value"
      class="radiorow card flat"
      :style="rowStyle(opt.value)"
    >
      <input
        v-model="method"
        class="sr-radio"
        type="radio"
        name="guest-delivery-method"
        :value="opt.value"
        :data-testid="opt.testid"
      />
      <span :style="dotStyle(opt.value)"></span>
      <!-- ⚠ ONE LINE per row: Vue's `condense` mode deletes a whitespace-only node that
           contains a newline, which would glue „od" to the name / the label to the fee. -->
      <span v-if="opt.value === 'via_host'" style="min-width:0;font-size:14px;line-height:normal;overflow-wrap:anywhere"><b>Prevezmem od <span data-user-copy>{{ hostFirstName }}</span></b></span>
      <span v-else style="min-width:0;font-size:14px;line-height:normal;overflow-wrap:anywhere"><b>Poslať Packetou</b> <span class="sub" data-testid="guest-delivery-fee">{{ feeLabel }}</span></span>
    </label>

    <!-- The point: required when Packeta (the caller validates; the server re-checks).
         `maxlength` mirrors the server's 160 (CLAUDE.md: bounds are mirrored). -->
    <div v-if="method === 'packeta'" style="margin-top:4px">
      <label class="field-lbl" for="guest-packeta-address">Výdajné miesto Packeta *</label>
      <input
        id="guest-packeta-address"
        v-model="address"
        class="inp"
        type="text"
        data-testid="guest-packeta-address"
        placeholder="napr. Z-BOX Hlavná 15, Bratislava"
        maxlength="160"
      />
      <div class="field-help" style="overflow-wrap:anywhere">Názov Z-BOXu alebo pobočky a mesto. Balík vám doručí Packeta, nie <span data-user-copy>{{ hostFirstName }}</span>.</div>
    </div>
  </div>
</template>

<style scoped>
/* FriendOrder.vue's RadioRow rules, verbatim (see the long note there for why each
   declaration is what it is — no insets + `position:relative` on the row, and
   `:focus-visible` rather than `:focus-within`). */
.sr-radio {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.radiorow:has(:focus-visible) {
  box-shadow: 3px 3px 0 var(--accent);
}

@supports not selector(:has(*)) {
  .radiorow:focus-within {
    box-shadow: 3px 3px 0 var(--accent);
  }
}
</style>
