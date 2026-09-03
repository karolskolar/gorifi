<script setup>
// ⚠ ONE HOME for the admin's correction of a party's pickup point (PO decision,
// 2026-09-02; widened to "za každých okolností" on 2026-09-03). TWO call sites, in two
// DIFFERENT views:
//
//   1. `CycleDetail.vue`'s orders tab — the Status column, where the pickup badge
//      already lived (the screen the request came from);
//   2. `Distribution.vue`'s friend card — the screen where the bags are actually
//      packed, which is where a wrong place costs real time.
//
// ⚠ KEYED ON (cycle, friend), NOT ON AN ORDER ID. The reported hole was a host who
// ordered nothing themselves while their unregistered colleague did: they are the
// pickup party — they collect the bags — but they have no `orders` row, so an
// order-id control could not address them at all. The server decides which store the
// write lands on (`helpers/pickup.js`); this component deliberately does not know and
// must not start guessing, or the two surfaces drift apart again.
//
// ⚠ THE PILL *IS* THE `<select>`, and that is the whole point of the row. The obvious
// build — badge, click to reveal a picker, pick, save — is three interactions per
// correction and hides the control behind a state the admin has to discover. A native
// select styled as the shipped badge is TWO (open, pick), keeps the table's colour
// coding at rest (blue = a real pickup location, grey = the friend's "Iné" note), and
// costs no portal inside a 33-row table. Native `<select>` with these exact Tailwind
// classes is the established admin-skin pattern (`AdminCatalog.vue`).
//
// ⚠ THIS COMPONENT OWNS ITS OWN MUTATION, DIVERGING FROM `GuestLinkRowControls.vue`
// deliberately. That one keeps every pending flag in the parent because its two call
// sites render the SAME friend in the SAME view, so one friend must have one mutation
// state. Here the call sites are separate views that never coexist, so parent-owned
// state would mean the identical optimistic-patch/rollback logic written twice — the
// exact drift the "one home" rule exists to prevent. The parent's only job is to hand
// over the current values and patch its own row from `updated`.
//
// ⚠ ADMIN SKIN ONLY — shadcn / Tailwind utilities, zero `neo/` classes, zero theme
// tokens, no `.app` scope (01-architecture design-system scope rule).
import { ref, computed, watch, nextTick } from 'vue'
import api from '../api'

const props = defineProps({
  cycleId: { type: [Number, String], required: true },
  friendId: { type: [Number, String], required: true },
  // Active locations, ALREADY filtered by cycle type by the parent (`for_coffee` /
  // `for_bakery`) — the same filtering the friend's own order form applies.
  locations: { type: Array, default: () => [] },
  locationId: { type: [Number, String], default: null },
  // The joined `pickup_location_name`. Needed as well as the id: a location that was
  // soft-deleted (`active = 0`, which is what DELETE does once an order references it)
  // is NOT in `locations`, and without its name the pill would silently render some
  // OTHER location's label for this order.
  locationName: { type: String, default: '' },
  // The friend's free-text "Iné" answer, when they chose no configured location.
  note: { type: String, default: '' },
  // ⚠ A PACKETA ORDER IS NOW SWITCHABLE (PO decision, 2026-09-03, reversing
  // 2026-09-02's flat refusal), but not silently — see `parcelWarning`.
  packetaAddress: { type: String, default: '' },
  deliveryFee: { type: [Number, String], default: 0 },
  testidPrefix: { type: String, default: 'pickup' },
})

const emit = defineEmits(['updated'])

// Sentinels, never sent to the server: one for "the note this order already has"
// (so the pill can display it as its selected option) and one for "let me type a note".
const NOTE_CURRENT = '__note_current__'
const NOTE_NEW = '__note_new__'
const NOTE_MAX = 200

const pending = ref(false)
const error = ref('')
const noteMode = ref(false)
const noteDraft = ref('')
const noteInput = ref(null)
// The Packeta switch waits here for a confirm; it holds the pending request body.
const confirmValue = ref(null)

const noteText = computed(() => String(props.note || '').trim())
const isParcel = computed(() => !!String(props.packetaAddress || '').trim())
const feeAmount = computed(() => Number(props.deliveryFee || 0))

function currentValue() {
  if (props.locationId) return String(props.locationId)
  if (noteText.value) return NOTE_CURRENT
  return ''
}

// ⚠ `v-model` on the select, NOT `:value`. Vue's `v-model` for `<select>` re-applies
// the selection AFTER the `v-for` options have been patched; a bound `:value` is set on
// the element before its options exist and silently falls back to the first option.
const model = ref(currentValue())
watch(() => [props.locationId, noteText.value], () => { model.value = currentValue() })

const options = computed(() => {
  const list = (props.locations || []).map((loc) => ({ value: String(loc.id), label: loc.name }))
  if (props.locationId && !list.some((o) => o.value === String(props.locationId))) {
    // A soft-deleted location the friend picked while it was still active. Listed so
    // the pill tells the truth; picking anything else moves the order off it for good.
    list.unshift({ value: String(props.locationId), label: props.locationName || 'Neaktívne miesto' })
  }
  return list
})

const currentLabel = computed(() => {
  if (props.locationId) return props.locationName || 'Neaktívne miesto'
  if (noteText.value) return noteText.value
  if (isParcel.value) return 'Packeta'
  return 'Nezadané'
})

// The shipped badge's own colours, so the table reads exactly as before at rest.
const tone = computed(() => {
  if (props.locationId) return 'border-blue-400 text-blue-600 bg-blue-50'
  if (noteText.value) return 'border-gray-400 text-gray-600 bg-gray-50'
  if (isParcel.value) return 'border-red-400 text-red-600 bg-red-50'
  return 'border-dashed border-input text-muted-foreground bg-background'
})

const tid = (suffix) => `${props.testidPrefix}${suffix ? `-${suffix}` : ''}-${props.friendId}`

// ⚠ THE ONE CASE THAT MAY NOT BE SILENT. Switching a parcel order to personal pickup
// clears `packeta_address` and zeroes `delivery_fee` server-side. That is
// LEDGER-neutral (both ledger legs post `order.total` alone — the fee has never
// entered `transactions`), so no balance moves and no existing row is invalidated.
// What it does change is what the friend was ASKED to pay, and they may already have
// transferred it — so the confirm names the amount rather than leaving the admin to
// discover a refund later.
const parcelWarning = computed(() => {
  if (!isParcel.value) return ''
  const fee = feeAmount.value
  return fee > 0
    ? `Zruší sa doručenie Packetou a poplatok ${fee.toFixed(2)} EUR. Ak už priateľ zaplatil, poplatok mu vráťte.`
    : 'Zruší sa doručenie Packetou.'
})

async function save(body) {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    const updated = await api.setPartyPickup(props.cycleId, props.friendId, body)
    emit('updated', updated)
    noteMode.value = false
    confirmValue.value = null
  } catch (e) {
    // A refused change must never leave the pill claiming the new place: the packing
    // sheet is read as fact, and "it looked like it saved" is how a bag goes to the
    // wrong address. The select snaps back to what is actually stored.
    error.value = e.message
    model.value = currentValue()
  } finally {
    pending.value = false
  }
}

/** Save, unless this is the parcel switch — that one asks first. */
function commit(body) {
  if (isParcel.value) {
    confirmValue.value = body
    noteMode.value = false
    model.value = currentValue()
    return
  }
  save(body)
}

function onChange(event) {
  const value = event.target.value
  if (value === NOTE_NEW) {
    noteDraft.value = noteText.value
    noteMode.value = true
    error.value = ''
    // Nothing is saved yet, so the select must not be left showing "Iné".
    model.value = currentValue()
    nextTick(() => noteInput.value?.focus())
    return
  }
  // Re-picking the note the order already has is a no-op, not an empty write.
  if (value === NOTE_CURRENT || value === '') {
    model.value = currentValue()
    return
  }
  commit({ pickup_location_id: Number(value) })
}

function saveNote() {
  const text = noteDraft.value.trim()
  if (!text) {
    error.value = 'Poznámka je povinná'
    return
  }
  commit({ pickup_location_note: text })
}

function cancelNote() {
  noteMode.value = false
  error.value = ''
  model.value = currentValue()
}

function cancelConfirm() {
  confirmValue.value = null
  error.value = ''
  model.value = currentValue()
}
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-1 align-middle font-normal">
    <template v-if="noteMode">
      <input
        ref="noteInput"
        v-model="noteDraft"
        type="text"
        :maxlength="NOTE_MAX"
        :disabled="pending"
        placeholder="Vlastné miesto"
        class="h-7 w-40 rounded-md border border-input bg-background px-2 text-xs"
        :data-testid="tid('note-input')"
        @keydown.enter.prevent="saveNote"
        @keydown.esc.prevent="cancelNote"
      />
      <button
        type="button"
        class="text-xs text-primary underline underline-offset-2 hover:no-underline disabled:opacity-50"
        :disabled="pending"
        :data-testid="tid('note-save')"
        @click="saveNote"
      >{{ pending ? 'Ukladám...' : 'Uložiť' }}</button>
      <button
        type="button"
        class="text-xs text-muted-foreground underline underline-offset-2 hover:no-underline"
        :data-testid="tid('note-cancel')"
        @click="cancelNote"
      >Zrušiť</button>
    </template>
    <span v-else class="relative inline-flex items-center">
      <select
        v-model="model"
        :disabled="pending"
        :title="currentLabel"
        :class="[
          'h-6 max-w-[13rem] cursor-pointer appearance-none truncate rounded-full border pl-2 pr-6 text-xs font-semibold disabled:opacity-50',
          tone,
        ]"
        :data-testid="tid('select')"
        @change="onChange"
      >
        <!-- Placeholder only: the route refuses clearing a pickup back to empty, so
             this is never a selectable target. Same for a parcel order, whose current
             state is "Packeta" and cannot be re-selected. -->
        <option v-if="!locationId && !noteText" value="" disabled>{{ isParcel ? 'Packeta' : 'Nezadané' }}</option>
        <option v-if="!locationId && noteText" :value="NOTE_CURRENT">{{ noteText }}</option>
        <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        <option :value="NOTE_NEW">Iné (poznámka)…</option>
      </select>
      <svg
        class="pointer-events-none absolute right-1.5 h-3 w-3 opacity-60"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M19 9l-7 7-7-7" />
      </svg>
    </span>
    <!-- Inline confirm, ONLY for the parcel switch (the one case that moves a money
         column) — the `GuestLinkRowControls.vue` precedent. Everything else saves on
         the pick, which is the whole interaction budget of this control. -->
    <span
      v-if="confirmValue"
      class="text-xs inline-flex flex-wrap items-center gap-1.5"
      :data-testid="tid('parcel-confirm')"
    >
      <span class="text-muted-foreground">{{ parcelWarning }}</span>
      <button
        type="button"
        class="text-destructive underline underline-offset-2 hover:no-underline disabled:opacity-50"
        :disabled="pending"
        :data-testid="tid('parcel-yes')"
        @click="save(confirmValue)"
      >{{ pending ? 'Ukladám...' : 'Áno, zmeniť' }}</button>
      <button
        type="button"
        class="text-muted-foreground underline underline-offset-2 hover:no-underline"
        :data-testid="tid('parcel-no')"
        @click="cancelConfirm"
      >Nie</button>
    </span>
    <span
      v-if="error"
      class="text-xs text-destructive"
      :data-testid="tid('error')"
    >{{ error }}</span>
  </span>
</template>
