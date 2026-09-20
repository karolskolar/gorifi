<script setup>
import { isInDebt } from '@/lib/money'
// The landing's debt banner — 18 §UC-PI-008. „Never hide debt; never show a settled
// balance on the landing.“
//
// ⚠⚠ ~~THE THRESHOLD LIVES HERE, ONCE.~~ **That claim was FALSE when written and is
// corrected here (review, 2026-09-20): the comparison also lived in
// `FriendBalanceCard.vue` and in the drawer badge, and it was declared a single home in
// FOUR documents while having THREE.** The predicate now genuinely has one home —
// `lib/money.js isInDebt()` — which all three import; `BalanceBadge.vue` keeps its own
// copy on purpose because it is shared with the ADMIN skin. What lives here is the
// PLACEMENT rule: the gate is the `v-if` on this component's own root rather than a
// condition at each call site —
// there are THREE call sites (the open, closed and locked landings, §UC-PI-005 item
// 2 / §UC-PI-006 item 3 / §UC-PI-007 item 1) and a rule written three times is a
// rule with two of them wrong. ⚠ ZERO AND POSITIVE ARE A PRODUCT DECISION, NOT A
// ROUNDING TOLERANCE (R2.3, §UC-PI-008): a settled friend sees no „Môj účet“, no
// „Transakcie“ and no money at all on the landing. Widening this predicate to
// `<= 0` would put „0.00 EUR“ on the screen the PO asked to keep clean.
//
// ⚠ `balance` is `null` while the session's one fetch is in flight and after it
// FAILS. `Number(null)` is `0`, which is not `< -0.01`, so both render nothing —
// which is §UC-PI-008's „a failed balance fetch renders NO banner and no error on
// the landing (the balance view owns the error surface)“, reached without a second
// predicate about loading.
//
// ⚠ THE PROTOTYPE'S „z minulého kola“ IS DROPPED and nothing replaces it (18
// resolved conflict 1). It was also a „kolo“, which §UC-PI-017 forbids on a friend
// surface — but the drop is the spec's, not the vocabulary rule's.
//
// ⚠ IT OPENS THE SESSION'S ONE `PaymentModal`; it mounts none. This component emits
// `pay` and knows nothing about amounts, references or variable symbols: the server
// composes the block (`helpers/payment.js balancePaymentBlock()`) and exactly one
// mount quotes it. Nothing here writes a ledger row — `transactions` comes only from
// the friend paid toggle and pack/unpack, both admin-side (CLAUDE.md §Money & data).
import { computed } from 'vue'
import { fmtEur } from '@/lib/money'

const props = defineProps({
  balance: {
    type: Number,
    default: null
  },
  // „the button is absent when neither [iban nor revolutUsername] is configured“
  // (§UC-PI-008). The BANNER still renders — a debt is news whether or not there is
  // a link to settle it with.
  canPay: Boolean
})

const emit = defineEmits(['pay'])

// ⚠ The predicate is imported, not restated — see `lib/money.js isInDebt`. PI-T7
// shipped this comparison here AND in the card AND in the drawer badge while claiming
// one home; the review measured three. Only this copy had a boundary fixture, so a
// banner-vs-card disagreement between −0.01 and −1.00 was invisible to the suite.
const inDebt = computed(() => isInDebt(props.balance))
</script>

<template>
  <!-- `portal2.jsx:340`, minus „z minulého kola“. `align-items:center` and the
       `.dot`'s `margin-top:0` are the canon's: this banner is one line with a
       control in it, not the two-line `.banner.slim` the status line uses. -->
  <div
    v-if="inDebt"
    class="banner danger slim"
    style="align-items:center"
    data-testid="debt-banner"
  >
    <span class="dot" style="margin-top:0"></span>
    <div style="min-width:0;flex:1;overflow-wrap:anywhere"><b>Nedoplatok {{ fmtEur(-balance) }}</b></div>
    <!-- ⚠ NOT `data-testid="pay-balance"` — that testid names the ONE control on the
         „Zostatok a platby“ card (`FriendBalanceCard.vue`), and two elements
         answering to it would make every `getByTestId('pay-balance')` in the suite
         ambiguous the day both surfaces ever render together. Different control,
         same single modal. -->
    <button
      v-if="canPay"
      type="button"
      class="btn sm accent"
      style="flex-shrink:0"
      data-testid="debt-banner-pay"
      @click="emit('pay')"
    >
      Zaplatiť
    </button>
  </div>
</template>
