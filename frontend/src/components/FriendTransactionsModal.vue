<script setup>
// "Všetky transakcie" — the ledger behind the balance card's "Transakcie"
// button, restyled onto the Neobrutal PP language.
//
// ⚠ NO CANON SCREEN EXISTS. `docs/design/friends-portal-redesign/friends/
// portal.jsx:114` has the BUTTON and nothing behind it, so every choice here is
// an extrapolation from shipped vocabulary — no new theme class was invented and
// `friends-theme.css` is untouched.
//
// ⚠ `BalanceBadge.vue` is deliberately NOT imported any more and NOT modified.
// It is SHARED WITH FIVE ADMIN VIEWS (`AdminFriends`, `FriendDetail`,
// `Distribution`, `CycleDetail`, plus three admin dialogs), which must stay
// pixel-identical — restyling it would leak the theme into admin and break the
// admin-invariance gate. This dialog renders the same three-state span
// `FriendBalanceCard.vue` does, from the same `balanceState` derivation, using
// the theme's money classes (`.neg.pill` / `.zero` / `.mono`). The canon paints
// this very balance as `<span class="neg pill">` at `portal.jsx:112`, so that
// half is precedent rather than extrapolation.
//
// ⚠ BEHAVIOUR IS UNCHANGED: same `api.getTransactions(friendId)`, same
// load-on-open watch, same `sk-SK` date, same type labels, same sign rule, same
// loading / empty / error copy.
import { ref, computed, watch } from 'vue'
import api from '../api'
import { fmtEur } from '@/lib/money'
import NeoModal from './neo/NeoModal.vue'

const props = defineProps({
  open: Boolean,
  friendId: {
    type: [Number, String],
    required: true
  },
  balance: {
    type: Number,
    default: 0
  }
})

defineEmits(['update:open'])

const transactions = ref([])
const loading = ref(false)
const error = ref('')

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    await loadAllTransactions()
  }
})

async function loadAllTransactions() {
  if (!props.friendId) return

  loading.value = true
  error.value = ''
  try {
    transactions.value = await api.getTransactions(props.friendId)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleDateString('sk-SK', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric'
  })
}

function getTransactionTypeLabel(type) {
  switch (type) {
    case 'payment': return 'Platba'
    case 'charge': return 'Účtovanie'
    case 'adjustment': return 'Kredit'
    default: return type
  }
}

function formatAmount(amount) {
  const sign = amount > 0 ? '+' : ''
  return `${sign}${amount.toFixed(2)} EUR`
}

// ⚠ The row colour predicate is `amount > 0`, VERBATIM from the shipped
// `text-green-600 : text-red-600` ternary — so a (never-observed) 0.00 row still
// paints as the danger colour. Kept identical on purpose: this row restyles, it
// does not re-decide money semantics. The ±0.01 dead zone below applies to the
// BALANCE only, where it is `FriendBalanceCard`'s shipped behaviour.
function isCredit(tx) {
  return tx.amount > 0
}

// The second line of a row: the cycle it belongs to, or the admin's free note.
// Both are unbounded admin text, which is why the container carries
// `overflow-wrap:anywhere` (see the template) — `min-w-0` lets a flex item
// SHRINK, but an unbreakable token still paints outside it.
function rowNote(tx) {
  return tx.cycle_name || tx.note || ''
}

// Identical to `FriendBalanceCard.vue`'s derivation, deliberately duplicated
// rather than hoisted: the two components render the same value on the same
// screen, and a shared helper would be a third place to keep in step for four
// lines of arithmetic. If a fourth consumer ever appears, hoist it then.
const balanceState = computed(() => {
  const n = Number(props.balance)
  if (!Number.isFinite(n)) return 'zero'
  if (n < -0.01) return 'neg'
  if (n <= 0.01) return 'zero'
  return 'pos'
})
</script>

<template>
  <!-- ⚠ THE `v-if` IS LOAD-BEARING, not a style choice. Shipped specs query
       `Zavrieť` and `getByRole('dialog')` UNSCOPED; an always-mounted NeoModal
       parks a second dialog (and a full-viewport scrim that swallows clicks) on
       every portal screen. Mutation-proved twice in this project. -->
  <NeoModal
    v-if="open"
    title="Všetky transakcie"
    wide
    @close="$emit('update:open', false)"
  >
    <!-- The balance moves into the subtitle row — `PaymentModal.vue`'s
         "Suma na úhradu: …" precedent for a single labelled money value under
         the title. `.sub` is A10-covered, so the inline `.neg.pill` needs no
         call-site `line-height`. -->
    <template #subtitle>
      Zostatok:
      <span v-if="balanceState === 'neg'" class="neg pill">{{ fmtEur(balance) }}</span>
      <span v-else-if="balanceState === 'zero'" class="zero">{{ fmtEur(0) }}</span>
      <span v-else class="mono" style="color:var(--ok-deep);font-weight:700">+{{ fmtEur(balance) }}</span>
    </template>

    <div v-if="error" class="banner danger slim" role="alert">
      <span class="dot"></span>
      <div style="min-width:0">{{ error }}</div>
    </div>

    <!-- Loading and empty keep their shipped strings verbatim. `.sub`, centred —
         the invite modal's loading state (`FriendPortalSession.vue`) is the
         precedent for both. -->
    <div v-else-if="loading" class="sub" style="text-align:center">Načítavam...</div>

    <div v-else-if="transactions.length === 0" class="sub" style="text-align:center">
      Žiadne transakcie
    </div>

    <!-- The ledger. `.suborder > ul.items` is the house's only shipped "list of
         money rows" (`GuestSubOrders.vue`): a bordered card whose `li` is a
         `space-between` flex row with the amount pinned right and `flex-shrink:0`
         on any `.mono` direct child. `.suborder .items` is A10-covered and
         `line-height` inherits, so every span below is covered too.

         ⚠ JUDGEMENT CALL: `.suborder` is named after a guest sub-order but is
         purely presentational (frame + row rhythm; nothing in it knows about
         guests). Reusing it here is what keeps this file free of new CSS — the
         alternative, `.card.flat` plus hand-rolled inline flex rows, would have
         re-implemented `.items` and forfeited its A10 line-height coverage. If
         the theme ever grows a neutral `.moneylist`, this is its first caller.

         The hairline between rows is an inline `border-top` from the SECOND row
         on, because `.items` ships no separator and adding one would mean
         touching `friends-theme.css` (a byte-for-byte canon port with a numbered
         adaptation list). -->
    <div v-else class="suborder" data-testid="tx-list">
      <ul class="items">
        <li
          v-for="(tx, idx) in transactions"
          :key="tx.id"
          :style="idx > 0 ? 'border-top:1px solid rgba(10,10,10,0.14);padding-top:8px;margin-top:4px' : null"
          data-testid="tx-row"
        >
          <!-- ⚠ `overflow-wrap:anywhere` on the CONTAINER, not on a leaf: it
               inherits, and both the cycle name and the note are free admin text.
               `min-width:0` alone only permits the flex item to shrink — an
               unbreakable token still paints straight out of it. Measured at
               320px with the property deleted: the row's content box is 206px
               and it painted 342px wide, spilling the modal by 79px.

               ⚠ AND THE DOCUMENT DOES NOT NOTICE. `.modal-scrim` is
               `overflow-y:auto`, so CSS computes its `overflow-x` to `auto` too
               and the scrim silently absorbs the spill —
               `documentElement.scrollWidth` stays at 320. The regression net for
               this line therefore measures the ROW and the SCRIM, not the
               document (`portal-transactions-modal.spec.js`, 320px). -->
          <span style="display:block;flex:1;min-width:0;overflow-wrap:anywhere">
            <span
              style="display:block;font-weight:700;font-size:14px;color:var(--ink)"
              data-testid="tx-type"
            >{{ getTransactionTypeLabel(tx.type) }}</span>
            <span class="mono sub" style="display:block;font-size:12px" data-testid="tx-meta">
              <!-- Two nodes, never one interpolation: Vue's `condense` drops a
                   newline-bearing whitespace node between elements, which would
                   silently glue the date to the note. -->
              <span>{{ formatDate(tx.created_at) }}</span>
              <span v-if="rowNote(tx)"> · {{ rowNote(tx) }}</span>
            </span>
          </span>
          <span
            v-if="isCredit(tx)"
            class="mono"
            style="color:var(--ok-deep);font-weight:700;font-size:13px;white-space:nowrap"
            data-testid="tx-amount"
          >{{ formatAmount(tx.amount) }}</span>
          <span v-else class="mono neg" data-testid="tx-amount">{{ formatAmount(tx.amount) }}</span>
        </li>
      </ul>
    </div>

    <template #footer>
      <button type="button" class="btn" @click="$emit('update:open', false)">Zavrieť</button>
    </template>
  </NeoModal>
</template>
