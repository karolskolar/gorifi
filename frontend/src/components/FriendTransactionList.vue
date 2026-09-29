<script setup>
// The friend's ledger — 18 §UC-PI-010 item 2.
//
// ⚠⚠ THIS FILE IS A LIFT, NOT A REWRITE. Every line below the imports came out of
// `FriendTransactionsModal.vue`, which PI-T7 DELETES: the row markup
// (`.suborder > ul.items > li`), the `tx-list` / `tx-row` / `tx-type` / `tx-meta` /
// `tx-amount` testids, the `overflow-wrap:anywhere` container, the `amount > 0`
// colour predicate, the `sk-SK` date, the Platba / Účtovanie / Kredit labels and the
// loading / empty / error copy are byte-identical. `portal-balance.spec.js` (the
// renamed `portal-transactions-modal.spec.js`) still pins all of it, which is what
// makes "verbatim" checkable rather than a claim.
//
// ⚠ WHAT DID NOT COME ACROSS, and why: the `NeoModal` shell, the `open` prop, the
// `balance` prop and its three-state subtitle span. The list renders IN PAGE now
// (§UC-PI-019 item 9), the balance is the account card's above it, and a second
// three-state derivation beside that card is exactly the duplication this module's
// relocation rule is about. `balanceState` therefore has ONE home again —
// `FriendBalanceCard.vue` — instead of the two the modal era carried.
//
// ⚠ `BalanceBadge.vue` is NOT imported and NOT modified: it is SHARED WITH ADMIN
// (`AdminFriends`, `FriendDetail`, `Distribution`, `CycleDetail` + three admin
// dialogs) and must stay pixel-identical. Nothing in this file renders a balance at
// all, so the question does not arise here any more.
//
// ⚠ READ-ONLY. Nothing here writes: `transactions` rows come only from the friend
// paid toggle and pack/unpack (CLAUDE.md §Money & data), both admin-side.
import { ref, watch, onMounted } from 'vue'
import api from '../api'

const props = defineProps({
  friendId: {
    type: [Number, String],
    required: true
  }
})

const transactions = ref([])
const loading = ref(false)
const error = ref('')

// ⚠ THE LOAD TRIGGER IS THE MOUNT, and that is §UC-PI-010's "the view reloads
// balance + transactions on mount (a payment marked by the admin shows after
// re-entering the view — no polling)". The component is `v-if`-gated on
// `view === 'balance'` in `FriendPortalSession.vue`, so leaving the view unmounts it
// and coming back re-runs this — the modal's `watch(open)` in different clothes.
onMounted(loadAllTransactions)

// The in-place `friendId` change no path reaches today, kept from the modal for the
// same reason the SESSION's `loadBalance()` clears before it reads
// (`FriendPortalSession.vue`): it is the cheap half of the defence, and the structural
// half is the parent's `v-if` + `:key`. ⚠ The earlier wording cited
// `FriendBalanceCard`'s own watch — this row removed it when the card became props-fed
// and fetched nothing, so the citation was stale the moment it was written.
watch(() => props.friendId, loadAllTransactions)

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
// paints as the danger colour. Kept identical on purpose: this lift relocates, it
// does not re-decide money semantics. The ±0.01 dead zone applies to the BALANCE
// only, where it is `FriendBalanceCard`'s shipped behaviour.
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
</script>

<template>
  <div>
    <div v-if="error" class="banner danger slim" role="alert">
      <span class="dot"></span>
      <div style="min-width:0">{{ error }}</div>
    </div>

    <!-- Loading and empty keep their shipped strings verbatim. -->
    <div v-else-if="loading" class="sub" style="text-align:center">Načítavam...</div>

    <div v-else-if="transactions.length === 0" class="sub" style="text-align:center">
      Žiadne transakcie
    </div>

    <!-- The ledger. `.suborder > ul.items` is the house's only shipped "list of
         money rows" (`GuestSubOrders.vue`): a bordered card whose `li` is a
         `space-between` flex row with the amount pinned right and `flex-shrink:0`
         on any `.mono` direct child. `.suborder .items` is A10-covered and
         `line-height` inherits, so every span below is covered too.

         ⚠ JUDGEMENT CALL, carried over from the modal: `.suborder` is named after a
         guest sub-order but is purely presentational (frame + row rhythm; nothing in
         it knows about guests). Reusing it is what keeps this file free of new CSS —
         the alternative, `.card.flat` plus hand-rolled inline flex rows, would have
         re-implemented `.items` and forfeited its A10 line-height coverage. The
         prototype's own `.p2-tx` row was NOT adopted for the same reason §UC-PI-010
         says "lifted VERBATIM": the shipped markup is what the pins describe.

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
               320px inside the modal with the property deleted: the row's content
               box was 206px and it painted 342px wide.

               ⚠ THE MEASUREMENT MOVED WITH THE MARKUP. In the modal the spill was
               absorbed by `.modal-scrim` (`overflow-y:auto` computes the other axis
               to `auto` too), so the DOCUMENT never moved and only the row and the
               scrim were load-bearing. In the page there is no scrim: the row is
               still the inner measurement, and the DOCUMENT is now the outer one. -->
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
              <span v-if="rowNote(tx)"> · <span data-user-copy>{{ rowNote(tx) }}</span></span>
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
  </div>
</template>
