<script setup>
// „Môj účet“ — the account card of the „Zostatok a platby“ view (18 §UC-PI-010
// item 1). It was module 03's landing card (§UC-FL-005); PI-T7 RE-PURPOSES it and
// moves it off the landing, where a settled balance must never appear at all
// (R2.3, §UC-PI-008).
//
// ⚠⚠ RELOCATED, NEVER DUPLICATED — and this file is where that rule got smaller,
// not larger. PL-T4 made this card the one home of THREE things: the balance fetch,
// the „Zaplatiť“ trigger and the `PaymentModal` mount. Module 18 gives the same
// debt two surfaces — this card and the landing's debt banner (§UC-PI-008) — which
// are different VIEWS of one session. So:
//
//   · the FETCH moved UP to `FriendPortalSession.vue` (one request per session
//     load, §UC-PI-004 item 3; this card now takes `balance` / `payment` /
//     `loading` / `error` as props and reads nothing of its own);
//   · the `PaymentModal` MOUNT moved up with it, because a mount that lives in this
//     card cannot be opened from a banner on another view — and the second mount
//     that would fix that is precisely the defect. There is exactly ONE balance
//     `PaymentModal` in the tree, in the session view;
//   · the TRIGGER stays here in the sense that matters: this card owns the one
//     `data-testid="pay-balance"` control in the whole frontend. It EMITS `pay`;
//     it does not decide what a payment is.
//
// The moment two components each hold their own copy of `balancePaymentBlock()`'s
// answer, „what does this friend owe“ has two homes that can disagree, and only one
// of them will be fixed the day something about the block changes.
//
// ⚠ `BalanceBadge.vue` is deliberately NOT imported and NOT modified — it is SHARED
// WITH ADMIN (`AdminFriends.vue`, `FriendDetail.vue`, `Distribution.vue`,
// `CycleDetail.vue` + three admin dialogs), which must stay pixel-identical.
//
// ⚠ THE MONEY CLASSES CHANGED, AND THAT IS THE CANON'S CALL, NOT A TIDY-UP.
// The 03 card rendered `.neg.pill` / `.zero` / `.mono` at 16px; `portal2.jsx:232`
// (and §UC-PI-010 after it) renders one `.display` at 38px coloured `var(--danger)`
// / `var(--ok-deep)`. The two cannot be combined: `friends-theme.css:216` declares
// `.neg{font-family:var(--font-mono);font-size:13px}` AFTER `:25`'s `.display`, at
// equal specificity, so `.display.neg` would paint the display font away. The
// three-state DERIVATION below is unchanged — only what it paints is.
//
// ⚠ MODULE-21 SEAM. Any message that quotes the debt renders the SAME block this
// card displays — `backend/src/helpers/payment.js balancePaymentBlock()` (amount,
// reference, variable symbol). Messages must quote it, never re-derive a symbol:
// the scheme lives in that one server file and nowhere else.
//
// ⚠ NO LEDGER WRITE, from here or from anything it opens: `transactions` rows come
// only from the friend paid toggle and pack/unpack, both admin-side (CLAUDE.md
// §Money & data). `paid` is admin-only.
import { computed } from 'vue'
import { fmtEur, balanceState as balanceStateOf } from '@/lib/money'

const props = defineProps({
  // `null` while it has never loaded, and after a failure — the same meaning the
  // session's ref carries. `error` is what distinguishes the two for the reader.
  balance: {
    type: Number,
    default: null
  },
  // The server's `payment` block, QUOTED (15 §UC-PL-003 item 4) — never recomposed
  // here and never composed at all. `null` until a payload carrying one arrives,
  // which is also what a stale/stubbed response leaves behind: a surface with no
  // payment data offers no payment control rather than a made-up one
  // (15 §UC-PL-007 business rules).
  payment: {
    type: Object,
    default: null
  },
  loading: Boolean,
  error: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['pay'])

// Three money states (UC-FL-005, unchanged by the re-purpose). The thresholds are
// the spec's: anything below -0.01 owes money, anything within ±0.01 is settled,
// the rest is credit. A non-finite balance (`null` included) falls into "settled"
// rather than rendering "NaN EUR" — the same fail-closed reflex `fmtEur` uses.
// ⚠ The states are imported, not restated (`lib/money.js balanceState`). This copy was
// the untested one — its fixtures were 0 / 12.5 / −5 / −30 / −74.24, none within a cent
// of the threshold — while it drove the colour, the „Nedoplatok" copy AND whether
// Zaplatiť is offered at all.
const balanceState = computed(() => balanceStateOf(props.balance))

// „positive keeps the leading `+`“ (§UC-PI-010) — carried over from `BalanceBadge`'s
// behaviour, as the 03 card did. Zero prints `fmtEur(0)`, never `-0.00 EUR`.
const displayAmount = computed(() => {
  if (balanceState.value === 'pos') return `+${fmtEur(props.balance)}`
  if (balanceState.value === 'zero') return fmtEur(0)
  return fmtEur(props.balance)
})

// The „Zaplatiť“ gate (§UC-PL-007 item 4, §UC-PI-010): a DEBT, and somewhere to send
// the money.
// ⚠ Gated on the block's own fields, never on a second predicate over the balance:
// the modal is opened with exactly the amount/reference/symbol that object carries,
// so the control and what it opens can never answer different questions. A friend
// who is settled or in credit is asked for nothing at all (`amount` is `0` there
// anyway).
const canPayBalance = computed(() => (
  balanceState.value === 'neg'
  && !!props.payment
  && !!(props.payment.iban || props.payment.revolut_username)
))
</script>

<template>
  <!-- `portal2.jsx:230` — `.hl` only while the friend owes something. -->
  <div class="card" :class="{ hl: balanceState === 'neg' }" style="padding:16px">
    <div class="field-lbl" style="margin-bottom:4px">Môj účet</div>

    <span v-if="loading" class="sub">Načítavam...</span>

    <!-- The error surface §UC-PI-008 deliberately does NOT give the landing: a
         failed balance renders nothing there, and this view owns the message. -->
    <div v-else-if="error" class="banner danger slim" role="alert">
      <span class="dot"></span>
      <div style="min-width:0">{{ error }}</div>
    </div>

    <template v-else>
      <!-- ⚠ `line-height` INLINE — `friends-theme.css` loads after Tailwind and
           `:where(.app,.modal-layer) .display` matches at the same specificity as a
           utility, so the canon's value survives only as a style attribute
           (CLAUDE.md §Frontend). `overflow-wrap:anywhere` because a four-figure debt
           plus „ EUR“ is the widest thing on a 320px card. -->
      <div
        class="display"
        :style="`font-size:38px;line-height:1;overflow-wrap:anywhere;color:${balanceState === 'neg' ? 'var(--danger)' : 'var(--ok-deep)'}`"
        data-testid="balance-amount"
      >{{ displayAmount }}</div>

      <!-- ⚠ „po zaplatení sa zostatok vyrovná do 1–2 dní“ is the PO's sentence and
           §UC-PI-010's recorded default — it says what the ledger will not say for a
           day or two, because nothing on the friend side writes a `transactions`
           row. Do not shorten it into a promise the admin has not made. -->
      <div class="sub" style="margin-top:6px" data-testid="balance-sub">{{
        balanceState === 'neg'
          ? 'Nedoplatok — po zaplatení sa zostatok vyrovná do 1–2 dní.'
          : 'Všetko vyrovnané.'
      }}</div>

      <!-- ⚠⚠ THE ONE `pay-balance` CONTROL IN THE FRONTEND. The landing's debt
           banner has its own button (§UC-PI-008) with its own testid, and BOTH call
           the session's single `openBalancePayment()` so that one `PaymentModal`
           mount answers for both. A second mount here is the defect this row exists
           to avoid — see this file's header. -->
      <button
        v-if="canPayBalance"
        type="button"
        class="btn accent block"
        style="margin-top:14px"
        data-testid="pay-balance"
        @click="emit('pay')"
      >
        Zaplatiť {{ fmtEur(-balance) }}
      </button>
    </template>
  </div>
</template>
