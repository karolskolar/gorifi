<script setup>
// "Môj účet" — the portal's balance card (03 §UC-FL-005), restyled to the
// Neobrutal PP language. Data flow is untouched: `api.getFriendBalance` on mount
// and on every `friendId` change, same refs, same error surface.
//
// ⚠ `BalanceBadge.vue` is deliberately NOT imported any more and NOT modified —
// it is SHARED WITH ADMIN (`AdminFriends.vue`, `FriendDetail.vue`, …), which must
// stay pixel-identical. This card renders its own three-state span instead, using
// the theme's money classes (`.neg.pill` / `.zero` / `.mono`).
//
// ⚠ 15 §UC-PL-007 item 4 (PL-T4) — THIS CARD IS THE ONE HOME OF THE BALANCE PAYMENT
// SURFACE. „Zaplatiť“ and the `PaymentModal` mount below belong to the CARD, never to
// `FriendTransactionsModal` (02 §UC-DS-010, the one-modal rule — that component is
// untouched by this row).
//
// ⚠⚠ MODULE-18 SEAM (PI-T7). The portal IA moves the balance into a „Zostatok a platby“
// view and puts a debt banner on the landing. PI-T7 RELOCATES this trigger and this
// mount into that view; it must NEVER add a second `PaymentModal` for the balance, and
// the landing banner's „Zaplatiť“ opens THIS one. Relocated, never duplicated — the
// moment two components each hold their own copy of `balancePaymentBlock()`'s answer,
// "what does this friend owe" has two homes that can disagree, and only one of them
// will be fixed the day something about the block changes.
//
// ⚠ MODULE-21 SEAM. Any message that quotes the debt renders the SAME block this card
// displays — `backend/src/helpers/payment.js balancePaymentBlock()` (amount, reference,
// variable symbol). Messages must quote it, never re-derive a symbol: the scheme lives
// in that one server file and nowhere else.
import { ref, computed, onMounted, watch } from 'vue'
import api from '../api'
import { fmtEur } from '@/lib/money'
import FriendTransactionsModal from './FriendTransactionsModal.vue'
import PaymentModal from '@/components/PaymentModal.vue'

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

// The server's `payment` block, QUOTED (15 §UC-PL-003 item 4) — never recomposed here.
// `null` until a payload carrying one arrives, which is also what a stale/stubbed
// response leaves behind: a surface with no payment data offers no payment control
// rather than a made-up one (§UC-PL-007 business rules).
const payment = ref(null)
const showPayment = ref(false)

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
  // ⚠ CLEARED BEFORE THE READ, not merged after it — DEFENCE IN DEPTH, and it is worth
  // being exact about what it does and does not do.
  //
  // It is NOT what keeps one session's payment block out of the next session. That is
  // structural and lives in the parent: `FriendPortal.vue` mounts
  // `FriendPortalSession` with `v-else-if="authState === 'authenticated'"` plus
  // `:key="sessionSeq"`, so a logout DESTROYS this subtree — this card with it — and a
  // session swap re-creates it with `payment` back at `null`. ⚠ That `v-if` is itself
  // load-bearing (`FriendPortalSession.vue`'s header: swapping it for `v-show` brings
  // all six session leaks back at once) — do not read this clear as a reason it could
  // be relaxed, and do not restate it as one.
  //
  // What the clear DOES cover is two narrower things. (1) An IN-PLACE `friendId` change
  // — the `watch` above — which no path reaches today (same standing as the parent's
  // key) and which would otherwise re-point the card at a new friend while the previous
  // one's symbol, reference and amount stayed mounted and openable. (2) The gap a
  // FAILED reload leaves: without it, the card paints its error banner while a stale
  // block sits behind a „Zaplatiť“ that still opens. Clearing `showPayment` with it is
  // the same rule — a dialog quoting a debt that is no longer on screen has no owner.
  payment.value = null
  showPayment.value = false
  try {
    const data = await api.getFriendBalance(props.friendId)
    balance.value = data.balance
    transactions.value = data.transactions
    payment.value = data.payment || null
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

// The „Zaplatiť“ gate (§UC-PL-007 item 4): a DEBT, and somewhere to send the money.
// ⚠ Gated on the block's own fields, never on a second predicate over the balance: the
// modal is opened with exactly the amount/reference/symbol this object carries, so the
// control and what it opens can never answer different questions. A friend who is
// settled or in credit is asked for nothing at all (`amount` is `0` there anyway).
const canPayBalance = computed(() => (
  balanceState.value === 'neg'
  && !!payment.value
  && !!(payment.value.iban || payment.value.revolut_username)
))

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

    <!-- ⚠ BEFORE „Transakcie“ (§UC-PL-007 item 4): settling the debt is the action,
         reading the ledger is the explanation. `.btn.ok.sm` — the theme's "money-good"
         fill, the same grammar the rest of the portal uses for a confirming action. -->
    <button
      v-if="canPayBalance"
      type="button"
      class="btn ok sm"
      data-testid="pay-balance"
      @click="showPayment = true"
    >
      Zaplatiť
    </button>

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

  <!-- The shared Platba modal, PROPS IN / LINKS OUT: every value is the server's
       (`balancePaymentBlock()`), and this card composes no symbol, no reference and no
       amount of its own.
       ⚠ `close` deliberately does NOT reload the balance: paying through a link changes
       nothing in the ledger until the admin records the transfer, and a refreshed-looking
       balance would tell the friend otherwise. Nothing is written here — module 15 adds
       no `transactions` row anywhere. -->
  <PaymentModal
    v-if="payment"
    :open="showPayment"
    :amount="payment.amount"
    :reference="payment.reference"
    :iban="payment.iban"
    :revolut-username="payment.revolut_username"
    :variable-symbol="payment.variable_symbol"
    :creditor-name="payment.creditor_name"
    @close="showPayment = false"
  />
</template>
