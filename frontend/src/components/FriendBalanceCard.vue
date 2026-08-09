<script setup>
// "Môj účet" — the portal's balance card (03 §UC-FL-005), restyled to the
// Neobrutal PP language. Data flow is untouched: `api.getFriendBalance` on mount
// and on every `friendId` change, same refs, same error surface.
//
// ⚠ `BalanceBadge.vue` is deliberately NOT imported any more and NOT modified —
// it is SHARED WITH ADMIN (`AdminFriends.vue`, `FriendDetail.vue`, …), which must
// stay pixel-identical. This card renders its own three-state span instead, using
// the theme's money classes (`.neg.pill` / `.zero` / `.mono`).
import { ref, computed, onMounted, watch } from 'vue'
import api from '../api'
import { fmtEur } from '@/lib/money'
import FriendTransactionsModal from './FriendTransactionsModal.vue'

const props = defineProps({
  friendId: {
    type: [Number, String],
    required: true
  }
})

const balance = ref(0)
const transactions = ref([])
const loading = ref(true)
const error = ref('')
const showModal = ref(false)

onMounted(async () => {
  await loadBalance()
})

watch(() => props.friendId, async () => {
  await loadBalance()
})

async function loadBalance() {
  if (!props.friendId) return

  loading.value = true
  error.value = ''
  try {
    const data = await api.getFriendBalance(props.friendId)
    balance.value = data.balance
    transactions.value = data.transactions
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Three money states (UC-FL-005). The thresholds are the spec's: anything below
// -0.01 owes money, anything within ±0.01 is settled, the rest is credit.
// A non-finite balance falls into "settled" rather than rendering "NaN EUR" —
// the same fail-closed reflex `fmtEur` itself uses.
const balanceState = computed(() => {
  const n = Number(balance.value)
  if (!Number.isFinite(n)) return 'zero'
  if (n < -0.01) return 'neg'
  if (n <= 0.01) return 'zero'
  return 'pos'
})

// OPEN (UC-FL-005): the prototype only ever shows a negative balance and
// theme.css defines no positive-money class. This is the spec's recorded default
// — green (`--ok-deep`) = money-good per 02's semantic grammar, and the leading
// "+" is carried over from `BalanceBadge`'s current behaviour. Still awaiting a
// design confirmation.
</script>

<template>
  <div
    class="card mb-5 flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5"
  >
    <div>
      <div class="field-lbl" style="margin-bottom:4px">Môj účet</div>
      <span v-if="loading" class="sub">Načítavam...</span>
      <span
        v-else-if="balanceState === 'neg'"
        class="neg pill"
        style="font-size:16px"
      >{{ fmtEur(balance) }}</span>
      <span
        v-else-if="balanceState === 'zero'"
        class="zero"
        style="font-size:16px"
      >{{ fmtEur(0) }}</span>
      <span
        v-else
        class="mono"
        style="font-size:16px;color:var(--ok-deep);font-weight:700"
      >+{{ fmtEur(balance) }}</span>
    </div>

    <button
      v-if="!loading && !error"
      type="button"
      class="btn sm"
      @click="showModal = true"
    >
      Transakcie
    </button>

    <!-- Full-width third flex item: `flex-wrap` drops it onto its own row. -->
    <div v-if="error" class="banner danger slim" style="flex-basis:100%">
      <span class="dot"></span>
      <div>{{ error }}</div>
    </div>
  </div>

  <FriendTransactionsModal
    v-model:open="showModal"
    :friend-id="friendId"
    :balance="balance"
  />
</template>
