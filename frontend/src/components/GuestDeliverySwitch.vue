<script setup>
// ⚠ ONE HOME for the admin's correction of a GUEST's delivery back to „cez {host}"
// (GP-T5, 20 §UC-GP-009 / §UC-GP-010). TWO consumers, in two DIFFERENT views:
//
//   1. `CycleDetail.vue`'s orders tab — the nested guest sub-order row (GP-T5);
//   2. `Distribution.vue`'s Packeta guest party (GP-T6 — mount THIS component, never a
//      copy of its confirm).
//
// ⚠ KEYED ON THE GUEST SUB-ORDER'S OWN ID (`guest_orders.id`), NOT on (cycle, friend):
// `PickupLocationPicker.vue` is deliberately NOT reused — its props are `cycleId` +
// `friendId`, „never an order id" (CLAUDE.md), and a guest is not a pickup party of
// the host's link. The server write lives in `helpers/pickup.js applyGuestDelivery`.
//
// ⚠ THIS COMPONENT OWNS ITS OWN MUTATION (the `PickupLocationPicker` reasoning, not
// `GuestLinkRowControls`'): its call sites are separate views that never coexist, so a
// parent-owned pending/confirm state would be the same logic written twice. One
// instance per sub-order row ⇒ the pending flag is per row by construction (keyed by
// `guest_orders.id`), and a sequence counter drops a response that lands after the row
// was re-bound to another id. The parent's only job is to render it on a LIVE Packeta
// row and patch its own row from `updated`.
//
// ⚠ THE SWITCH IS NEVER SILENT. It zeroes `delivery_fee` — ledger-neutral (guests have
// no ledger), but it changes what the guest was ASKED to pay, and a PAID guest may
// already have transferred the fee. So the confirm NAMES the amount and tells the admin
// to return it — the switch SETTLES the fee (orchestrator decision 2026-09-23, option (a),
// PENDING PO; learnings 12 §31): ~~a later cancel still refunds what was paid~~ a later
// cancel refunds the items only (the snapshot stays server-side as a trace, uncounted).
//
// ⚠ ADMIN SKIN ONLY — shadcn / Tailwind utilities, zero `neo/` classes, zero theme
// tokens, no `.app` scope (the PI-T12 admin-invariance sweep reads this file).
import { ref, computed, watch } from 'vue'
import api from '../api'

const props = defineProps({
  guestOrderId: { type: [Number, String], required: true },
  // The host's FIRST name — the button says „Zmeniť na odovzdanie cez {host}".
  hostName: { type: String, default: '' },
  deliveryFee: { type: [Number, String], default: 0 },
  testidPrefix: { type: String, default: 'guest-delivery' },
})

const emit = defineEmits(['updated'])

const confirming = ref(false)
const pending = ref(false)
const error = ref('')
let seq = 0

// A re-bound row (another sub-order in the same slot) must not inherit this one's
// open confirm, its error, or a late response.
watch(() => props.guestOrderId, () => {
  seq += 1
  confirming.value = false
  pending.value = false
  error.value = ''
})

const fee = computed(() => Number(props.deliveryFee || 0))
const tid = (suffix) => `${props.testidPrefix}${suffix ? `-${suffix}` : ''}-${props.guestOrderId}`

// The shipped admin money format (`formatPrice`: `X.XX EUR`). A fee of 0 is legal
// (free parcels) — then there is no amount to name.
const warning = computed(() => (fee.value > 0
  ? `Zruší sa doručenie Packetou a poplatok ${fee.value.toFixed(2)} EUR. Ak hosť poplatok už uhradil, treba mu ho vrátiť.`
  : 'Zruší sa doručenie Packetou.'))

function openConfirm() {
  error.value = ''
  confirming.value = true
}

function cancelConfirm() {
  if (pending.value) return
  confirming.value = false
  error.value = ''
}

async function confirmSwitch() {
  // ⚠ JS guard as well as `:disabled` — a dispatched click ignores a disabled button.
  if (pending.value || !confirming.value) return
  const mine = ++seq
  const id = props.guestOrderId
  pending.value = true
  error.value = ''
  try {
    const data = await api.switchGuestDelivery(id)
    if (mine !== seq) return
    confirming.value = false
    emit('updated', data)
  } catch (e) {
    if (mine !== seq) return
    // A refused switch (409 `cancelled`, a 404) is reported next to the control and
    // never shown as done; the confirm stays open so the admin sees what they asked.
    error.value = e.message
  } finally {
    if (mine === seq) pending.value = false
  }
}
</script>

<template>
  <span class="inline-flex flex-col gap-1 align-middle text-xs font-normal">
    <button
      v-if="!confirming"
      type="button"
      class="self-start text-xs text-primary underline underline-offset-2 hover:no-underline"
      :data-testid="tid('switch')"
      @click="openConfirm"
    >Zmeniť na odovzdanie cez {{ hostName }}</button>
    <span
      v-else
      class="block rounded border border-red-300 bg-red-50 p-2"
      :data-testid="tid('confirm')"
    >
      <span class="block text-muted-foreground" :data-testid="tid('warning')">{{ warning }}</span>
      <span class="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground disabled:opacity-50"
          :disabled="pending"
          :data-testid="tid('yes')"
          @click="confirmSwitch"
        >{{ pending ? 'Ukladám...' : 'Áno, zmeniť' }}</button>
        <button
          type="button"
          class="rounded border px-2 py-1 text-xs disabled:opacity-50"
          :disabled="pending"
          :data-testid="tid('no')"
          @click="cancelConfirm"
        >Nie</button>
      </span>
    </span>
    <span
      v-if="error"
      class="text-xs text-destructive"
      :data-testid="tid('error')"
    >{{ error }}</span>
  </span>
</template>
