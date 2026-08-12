<script setup>
// "Objednávky kolegov" — the host's view of the guest sub-orders placed through
// their share link (§UC-GSO-006..008). Rendered in FriendOrder.vue, under the
// share card.
//
// What the host can do here:
//   - see every colleague, what they ordered and what it costs;
//   - tick "Odovzdané" per sub-order — the hand-over checklist. `delivered` is
//     the HOST's flag (Decision 2), so this is the only place it is written;
//   - remove a sub-order while the cycle is open (typo, prank, colleague changed
//     their mind). The server soft-cancels it: the colleague's own status URL then
//     shows it as cancelled, and the stock it held is released.
//
// What the host CANNOT do here: touch `paid`. That flag belongs to the admin, who
// is the money recipient — the host only sees whether a colleague has settled up,
// so it is rendered as a badge and there is no control for it.
//
// The money rule (§UC-GSO-006): the guest total shown here is CONTEXT. The
// colleagues pay the admin directly, so the host's own payable total (the cart
// footer) stays own-items-only and is not touched by anything in this component.
import { ref, computed, watch, watchEffect } from 'vue'
import api from '../api'
import { colleaguesLabel } from '@/lib/plural'
import { variantText } from '@/lib/guest-cart'
import CartLineList from '@/components/CartLineList.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoCheckbox from '@/components/neo/NeoCheckbox.vue'

const props = defineProps({
  cycleId: { type: [String, Number], default: null },
  // Removal ends at the lock (the goods are ordered by then), so the affordance
  // disappears — but the delivered checklist stays, because the hand-over happens
  // precisely after the lock.
  cycleLocked: { type: Boolean, default: false },
  // ⚠ AUTH-READY GATE, not a cosmetic flag. A child's setup() runs BEFORE the
  // parent's onMounted, and FriendOrder restores the friend session (api's
  // in-memory token) in its onMounted — so fetching on setup would fire this
  // Bearer-only request with no Authorization header on every fresh load of
  // /cycle/:id (reload, or a link opened directly) and 401. The parent passes
  // `true` once it holds an authenticated response; defaults to false so a new
  // consumer has to make the same promise deliberately.
  ready: { type: Boolean, default: false }
})

// The parent puts the colleagues on their own tab, so it needs the headline numbers
// WITHOUT having to fetch them a second time: how many colleagues to put on the tab
// badge, how many are still waiting to be handed over (the only thing this screen
// ever asks the host to do), and whether the load failed — otherwise the parent
// would render "nobody has ordered yet" over a failed request.
//
// This component stays mounted on both tabs (the parent uses v-show, not v-if)
// precisely so the badge is right before the host ever opens the tab.
const emit = defineEmits(['summary'])

const error = ref('')
const subOrders = ref([])
const totals = ref({ count: 0, total: 0 })
// Pending state is PER SUB-ORDER, so two rows can be ticked independently and one
// slow request never disables (or unblocks) another row's checkbox.
const pending = ref({})
const confirmRemoveId = ref(null)

// Folding one colleague's item list away. A host who shared their link with a whole
// office gets a card taller than several phone screens, and the lines are reference
// information — the things the host ACTS on (the delivered tick, "Odstrániť") live
// in the footer and stay visible when folded, as do the name, the total and both
// badges.
//
// Keyed by `guest_orders.id`, so folding one colleague never touches another; the
// keys survive `replaceRow()` (which swaps the object, not the id). Expanded by
// default — this card exists to show what colleagues ordered, so hiding it unasked
// would defeat it. Screen state only, deliberately not persisted.
const collapsed = ref({})

function isCollapsed(subOrder) {
  return !!collapsed.value[subOrder.id]
}

function toggleCollapsed(subOrder) {
  collapsed.value = { ...collapsed.value, [subOrder.id]: !isCollapsed(subOrder) }
}

// Counts LINES, not pieces: it labels the list that is about to unfold, so it has
// to match the number of rows that appear.
function itemCountLabel(subOrder) {
  const n = (subOrder.items || []).length
  if (n === 1) return '1 položka'
  if (n >= 2 && n <= 4) return `${n} položky`
  return `${n} položiek`
}

// One component instance serves whatever cycle the route currently points at (the
// router reuses FriendOrder across /cycle/:cycleId changes), so the LOAD is
// sequence-guarded: a slow GET for the cycle just left must never land on top of
// the cycle now on screen, or the host would tick "odovzdané" on the wrong
// colleague's sub-order. Same rule as GuestShareDialog.
//
// Mutations are sequenced per sub-order id instead (rowSeq below) — a shared
// counter made a request that was overtaken by a later one (on ANY row) discard
// its own failure, leaving the checkbox claiming a hand-over the server refused.
let loadSeq = 0
const rowSeq = new Map()

watch([() => props.cycleId, () => props.ready], async ([cycleId, ready]) => {
  const seq = ++loadSeq
  error.value = ''
  subOrders.value = []
  totals.value = { count: 0, total: 0 }
  confirmRemoveId.value = null
  pending.value = {}
  collapsed.value = {}
  rowSeq.clear()
  if (!cycleId || !ready) return

  try {
    const data = await api.getGuestLink(cycleId)
    if (seq !== loadSeq) return
    subOrders.value = data.guest_orders || []
    totals.value = data.totals || { count: 0, total: 0 }
  } catch (e) {
    if (seq !== loadSeq) return
    // Reported, not swallowed: with an empty list a silent failure and "no
    // colleagues have ordered yet" look identical to the host, and they would go
    // on believing nobody joined their order. The card renders for an error alone
    // (see the template's v-if).
    error.value = e.message
  }
}, { immediate: true })

function isCancelled(subOrder) {
  return (subOrder.status || 'submitted') === 'cancelled'
}

function formatPrice(price) {
  return `${Number(price || 0).toFixed(2)} EUR`
}

// `formatAmount` — the bare, currency-less item amount (05 §UC-KG-003 item 2,
// prototype `order.jsx:124`) — is RETIRED with its only caller. Item lines now carry
// `€` like every other list of ordered coffee (product decision 2026-08-12), and
// `CartLineList` owns that formatting. `formatPrice` stays: the card's foot total and
// the struck cancelled amount are still `EUR`, which is the unit the host pays in.

// One sub-order's lines in `CartLineList`'s normalized shape (product decision
// 2026-08-12: every list of ordered coffee reads the same, and the host sees this one
// directly above their own cart bar).
//
// This replaces the old precomposed `"2× Name — 250g"` string. That string existed
// because a sibling `<span>` for the variant suffix could lose its separator to Vue's
// `condense` whitespace mode — a hazard that simply does not arise now: the size is
// its own COLUMN, not a suffix, so there is no separator left to lose.
//
// `variantText` from `lib/guest-cart.js` is the one home for variant → label, so a
// bakery `variant_label`, the zero-gram `'unit'` ⇒ "ks" and `'20pc5g'` ⇒ "20 ks × 5g"
// all render exactly as they do on the guest's own screens. (The old local rule
// printed NOTHING for `'unit'`.)
function subOrderLines(subOrder) {
  return (subOrder.items || []).map((item) => ({
    key: item.id,
    name: item.product_name,
    purpose: item.purpose,
    size: variantText(item),
    quantity: item.quantity,
    amount: Number(item.price || 0) * Number(item.quantity || 0),
  }))
}

// The amount that was CALLED OFF, recomputed from the item rows the server kept
// (§UC-KG-003 rule 6). `total` cannot be used: GSO-T5 zeroes it on soft-cancel,
// so the struck-through figure would read "0.00 EUR" and say nothing about what
// the colleague had ordered. Same derivation as the admin refund queue (GSO-T6).
// Display only — no payload change, and nothing here feeds the host's own total.
function cancelledTotal(subOrder) {
  return (subOrder.items || []).reduce(
    (sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0),
    0
  )
}

// 1 kolega / 2-4 kolegovia / 5+ kolegov — `lib/plural.js` owns the declension
// since the portal cycle card's share row prints the same phrase from the same
// count reached a different way.
const colleagueCount = computed(() => colleaguesLabel(totals.value.count || 0))

// Recomputed from the same rows the list renders, so the badge can never drift from
// what the tab actually contains. Cancelled sub-orders count for neither number:
// they owe nothing and there is nothing to hand over.
//
// ⚠ `rows` is ADDITIVE (05 §UC-KG-001 rule 5) and answers a different question from
// `count`: "is there a list on screen at all?", cancelled rows INCLUDED. The parent
// picks the panel's empty / share-row / locked-empty state with it, so a host whose
// only colleague cancelled keeps the one-line share row instead of being told
// "Zatiaľ nikto" above a visible cancelled card.
//
// `count` and `pendingDelivery` are UNCHANGED and stay cancelled-excluded — module
// 04's tab badge is computed from those two and must NOT be re-gated on `rows`.
watchEffect(() => {
  const live = subOrders.value.filter((o) => !isCancelled(o))
  emit('summary', {
    count: totals.value.count || 0,
    total: totals.value.total || 0,
    pendingDelivery: live.reduce((sum, o) => sum + (o.delivered ? 0 : 1), 0),
    failed: !!error.value,
    rows: subOrders.value.length,
  })
})

function replaceRow(updated) {
  if (!updated) return
  const index = subOrders.value.findIndex((o) => o.id === updated.id)
  if (index !== -1) subOrders.value[index] = updated
}

function findRow(id) {
  return subOrders.value.find((o) => o.id === id)
}

// Claim the newest slot for one sub-order and mark it busy. Returns a checker for
// "am I still the newest request for this row?".
function beginRowRequest(id) {
  const seq = (rowSeq.get(id) || 0) + 1
  rowSeq.set(id, seq)
  pending.value = { ...pending.value, [id]: true }
  return () => rowSeq.get(id) === seq
}

function endRowRequest(id) {
  const next = { ...pending.value }
  delete next[id]
  pending.value = next
}

async function toggleDelivered(subOrder) {
  const id = subOrder.id
  if (isCancelled(subOrder) || pending.value[id]) return
  const isNewest = beginRowRequest(id)
  const next = subOrder.delivered ? 0 : 1
  const previous = { delivered: subOrder.delivered, delivered_at: subOrder.delivered_at }
  // Optimistic, so the checkbox the host just clicked stays where they put it
  // while the request is in flight; reverted below if the server refuses.
  subOrder.delivered = next
  error.value = ''
  try {
    const data = await api.setGuestOrderDelivered(id, !!next)
    // Only the newest request for THIS row may write server state back.
    if (!isNewest()) return
    replaceRow(data.guest_order)
    if (data.totals) totals.value = data.totals
  } catch (e) {
    // A failure is ALWAYS reported — never dropped because some other request
    // finished later. The server refused this tick (a 409 for a cancelled or a
    // paid sub-order, a lost connection), so a checkbox left ticked would be the
    // UI asserting a hand-over that was never persisted.
    error.value = e.message
    // The optimistic value is only rolled back while this request still owns the
    // row: if the host re-toggled the SAME row meanwhile, that newer request owns
    // what is on screen and will settle it itself.
    if (isNewest()) {
      const row = findRow(id) || subOrder
      row.delivered = previous.delivered
      row.delivered_at = previous.delivered_at
    }
  } finally {
    endRowRequest(id)
  }
}

async function removeSubOrder(subOrder) {
  const id = subOrder.id
  const isNewest = beginRowRequest(id)
  error.value = ''
  try {
    const data = await api.deleteGuestOrder(id)
    if (!isNewest()) return
    // The row STAYS on screen, now marked as cancelled: the host asked for it to
    // be called off, not to disappear from their record.
    replaceRow(data.guest_order)
    if (data.totals) totals.value = data.totals
    confirmRemoveId.value = null
  } catch (e) {
    // Always surfaced, for the same reason as above — a refusal the host cannot
    // see (e.g. "already paid, talk to the admin") is worse than the refusal.
    error.value = e.message
  } finally {
    endRowRequest(id)
  }
}
</script>

<template>
  <!-- Rendered for an ERROR too, not only for rows: with an empty list a failed
       load would otherwise be indistinguishable from "no colleagues yet".
       (05 §UC-KG-001 "Error surfacing", the shipped rule, kept.)

       The shadcn `Card` wrapper is gone: the prototype's `GuestsPanel` is a plain
       14px flex column, and the heading is page-level type rather than a card
       header. `data-testid="guest-sub-orders"` moves onto the container unchanged
       — it is the root of everything ten assertions in `guest-host-view.spec.js`
       scope themselves to. -->
  <div
    v-if="subOrders.length > 0 || error"
    data-testid="guest-sub-orders"
    style="display:flex;flex-direction:column;gap:14px"
  >
    <!-- Panel-level failures (load, delivered toggle, remove) share ONE ref and ONE
         banner, and it is the FIRST child of the container so a failure is never
         read as "no colleagues yet". The message is the server's, VERBATIM — the
         backend speaks Slovak, and the paid-409 ("Táto objednávka je už zaplatená.
         Zrušenie vyriešte so správcom.") already carries its own escalate-to-the-
         admin instruction, so rewording it client-side would only weaken it
         (05 §UC-KG-005). -->
    <div v-if="error" class="banner danger slim" role="alert">
      <span class="dot"></span>
      <div style="min-width:0">{{ error }}</div>
    </div>

    <!-- Heading block. `.display` is page-level type here, not a card title: the
         colleagues are their own section of the tab, under the share row. -->
    <div v-if="subOrders.length > 0">
      <div class="display" style="font-size:24px">Objednávky kolegov</div>
      <!-- ⚠ THE MONEY LINE IS CONTEXT, NOT A CHARGE. `{{ colleagueCount }}` and the
           total both come from the server's `totals` (`{count, total}`, cancelled
           excluded — GSO-T5 pins that shape). The colleagues pay the admin
           directly, so nothing here is added to, or rendered inside, the host's own
           payable total: the cartbar stays own-items-only (§UC-GSO-006). The
           sentence says so in as many words, and it must keep saying so. -->
      <div class="sub" style="margin-top:4px;font-size:13.5px">
        Objednali {{ colleagueCount }} · spolu <b class="mono" style="color:var(--ink)">{{ formatPrice(totals.total) }}</b>. Kolegovia platia priamo správcovi — vaša suma na úhradu sa tým nemení.
      </div>
    </div>

    <div
      v-for="subOrder in subOrders"
      :key="subOrder.id"
      class="suborder"
      :class="{ cancelled: isCancelled(subOrder), 'animate-pulse': !!pending[subOrder.id] }"
    >
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <!-- LIVE row: the whole name block is the fold control — a bare 16px
             chevron is not a thumb target on the phone this screen is used on.
             Spans with `display:block`, not divs: a <div> inside a <button> is
             invalid HTML.

             ⚠ `line-height:normal` at the CALL SITE. Tailwind's preflight sets
             `line-height:inherit` on <button> and `1.5` on <html>, and the name
             span below is unclassed — a class list cannot reach it, so it would
             own a 1.5 strut (23.25px instead of 18px at 15.5px) and stretch the
             whole header. Fixing it here rather than widening A10 keeps the
             stylesheet's canon list honest. -->
        <button
          v-if="!isCancelled(subOrder)"
          type="button"
          @click="toggleCollapsed(subOrder)"
          :aria-expanded="isCollapsed(subOrder) ? 'false' : 'true'"
          :title="isCollapsed(subOrder) ? 'Zobraziť položky' : 'Skryť položky'"
          :data-testid="`guest-items-toggle-${subOrder.id}`"
          style="display:flex;gap:8px;align-items:flex-start;min-width:0;text-align:left;line-height:normal;background:transparent;border:0;padding:0;margin:0;cursor:pointer"
        >
          <span class="chev" :class="{ open: !isCollapsed(subOrder) }" style="margin-top:3px"><NeoIcon name="chev" /></span>
          <span style="display:block;min-width:0">
            <span style="display:block;font-weight:800;font-size:15.5px">{{ subOrder.guest_name }}</span>
            <span class="mono sub" style="display:block;font-size:12px">{{ subOrder.guest_phone }}</span>
            <!-- Folded, this is the only thing left saying how much is hidden. -->
            <span
              v-if="isCollapsed(subOrder) && (subOrder.items || []).length > 0"
              class="sub"
              style="display:block;font-size:12px"
              :data-testid="`guest-items-summary-${subOrder.id}`"
            >{{ itemCountLabel(subOrder) }}</span>
          </span>
        </button>

        <!-- CANCELLED row: the same block, but NOT a toggle (§UC-KG-003 rule 3).
             There is nothing left to unfold — the item list is not rendered at all
             on a cancelled row — so a control that reveals nothing would be a lie.
             The prototype keeps a live-looking click handler here; that is a
             prototype glitch, and the spec resolves it this way. No `aria-expanded`
             and no `guest-items-toggle-{id}`; no spec exercises either here. -->
        <div v-else style="display:flex;gap:8px;align-items:flex-start;min-width:0;line-height:normal">
          <span class="chev" style="margin-top:3px"><NeoIcon name="chev" /></span>
          <div style="min-width:0">
            <div style="font-weight:800;font-size:15.5px">{{ subOrder.guest_name }}</div>
            <div class="mono sub" style="font-size:12px">{{ subOrder.guest_phone }}</div>
            <!-- Permanent on a cancelled row: it is the only record left on screen
                 of how big the called-off order was. -->
            <div
              class="sub"
              style="font-size:12px"
              :data-testid="`guest-items-summary-${subOrder.id}`"
            >{{ itemCountLabel(subOrder) }}</div>
          </div>
        </div>

        <!-- Exactly ONE badge. A cancelled row drops the paid badge (resolved
             conflict 2): its paid state is the ADMIN's refund-queue signal
             (GSO-T6), not something the host can act on, and two badges on a 60%
             dashed card read as a live row. `paid` itself is the admin's flag in
             every state — shown, never toggled here (Decision 2). -->
        <!-- ⚠ The testid exists so "exactly one badge" can be asserted about THIS row
             rather than about the whole card: since 2026-08-12 the card also holds one
             `.badge` per purpose group inside `CartLineList`, and a bare
             `card.locator('.badge')` count would conflate a stray STATUS badge with a
             legitimate group header. -->
        <div style="display:flex;gap:6px;flex-shrink:0" data-testid="sub-order-badges">
          <span
            v-if="isCancelled(subOrder)"
            class="badge muted"
            :data-testid="`guest-status-${subOrder.id}`"
          >Zrušené</span>
          <span
            v-else
            class="badge"
            :class="subOrder.paid ? 'ok' : 'warn'"
            data-testid="guest-paid-badge"
          >{{ subOrder.paid ? 'Zaplatené' : 'Nezaplatené' }}</span>
        </div>
      </div>

      <!-- Never rendered on a cancelled row, in either fold state.
           ⚠ The testid stays on the LIST ROOT — `CartLineList` renders the `ul`, so
           the attribute falls through to it and both shipped locators
           (`getByTestId('guest-items-N').locator('li')` in `colleagues-panel` and
           `guest-host-view`) still resolve. The theme's `.suborder .items` rule is no
           longer used by this component; the list brings its own styling. -->
      <CartLineList
        v-if="!isCollapsed(subOrder) && !isCancelled(subOrder)"
        :items="subOrderLines(subOrder)"
        :data-testid="`guest-items-${subOrder.id}`"
        style="margin-top:10px"
      />

      <!-- Cancelled foot: the called-off amount, struck through, and nothing else
           — no hand-over tick (there is nothing to hand over) and no "Odstrániť"
           (`cancelled` is terminal, GSO-T4). -->
      <div v-if="isCancelled(subOrder)" class="foot">
        <span class="sub" style="text-decoration:line-through">{{ formatPrice(cancelledTotal(subOrder)) }}</span>
      </div>

      <div v-else class="foot">
        <span class="total">{{ formatPrice(subOrder.total) }}</span>

        <div style="display:flex;align-items:center;gap:14px">
          <!-- The hand-over tick — the ONLY writer of `delivered` in the system
               (Decision 2 / GSO-T5). `ok` because green is this system's
               done/money-good colour; `big` because it is a 32px thumb target in
               a warehouse-floor moment. It survives the lock on purpose: the
               hand-over happens precisely AFTER the cycle is locked.

               `disabled` while this row has a mutation in flight — per-row, never
               a shared lock. `tabindex` deliberately stays 0 on the primitive
               (aria-disabled = present but unavailable).

               ⚠ THREE ZONES, because `NeoCheckbox` is a `span[role=checkbox]`, not a
               native `<input>`. A `<label>` can neither forward its click to a
               non-labelable element nor NAME one, so the naive "wrap the text in the
               label" that works for an `<input>` silently loses BOTH here: the text
               and the gap stop toggling, and `getByRole('checkbox', {name})` resolves
               nothing. This row is the hand-over checklist on a phone — the whole
               reason this screen exists — so the label declaring `cursor:pointer`
               across a width where only 32px responds is a real miss, not a nicety.
               Hence: `@click.self` for the GAP, an explicit `@click` on the SPAN, and
               `aria-label` on the control. Same fix, same reason, as the three other
               NeoCheckbox call sites (FriendPortal, FriendOrder, FriendPortalSession).

               No extra pending guard is needed and none is added: `toggleDelivered`
               already returns early on `pending[id]` (set SYNCHRONOUSLY by
               `beginRowRequest`) and on cancelled rows, so all three zones are inert
               for the same reasons and cannot double-write. `.self` also cannot
               double-fire with the span: a click on the span makes the label a
               bubble ancestor, not the target. -->
          <label
            style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;font-size:13.5px;line-height:normal"
            @click.self="toggleDelivered(subOrder)"
          >
            <NeoCheckbox
              big
              ok
              :model-value="!!subOrder.delivered"
              :disabled="!!pending[subOrder.id]"
              aria-label="Odovzdané"
              :data-testid="`guest-delivered-${subOrder.id}`"
              @update:model-value="toggleDelivered(subOrder)"
            />
            <span @click="toggleDelivered(subOrder)">Odovzdané</span>
          </label>

          <!-- Stays visible on a PAID row on purpose (§UC-KG-005): hiding it would
               hide the escalation path silently. The server's 409 refusal is the
               explanation, and it lands in the banner above. -->
          <button
            v-if="!cycleLocked && !isCancelled(subOrder) && confirmRemoveId !== subOrder.id"
            type="button"
            class="btn ghost sm"
            :data-testid="`guest-remove-${subOrder.id}`"
            @click="confirmRemoveId = subOrder.id"
          >Odstrániť</button>
        </div>
      </div>

      <!-- Removing is destructive (the colleague's order is called off and, since
           `cancelled` is terminal, they cannot re-save it), so it asks first.
           ⚠ The confirmbox is NOT closed by a failure — only by success or by
           "Nie". That is what makes the paid-409 legible: the host sees the
           refusal in the banner while the thing they asked for is still on
           screen, and dismisses it themselves. -->
      <div v-if="confirmRemoveId === subOrder.id" class="confirmbox" style="margin-top:10px">
        <span>Objednávka kolegu sa zruší. Kolega ju uvidí ako zrušenú a už si ju nebude môcť upraviť.</span>
        <div class="row">
          <button
            type="button"
            class="btn sm danger"
            :disabled="!!pending[subOrder.id]"
            @click="removeSubOrder(subOrder)"
          >{{ pending[subOrder.id] ? 'Odstraňujem...' : 'Áno, odstrániť' }}</button>
          <button
            type="button"
            class="btn sm ghost"
            :disabled="!!pending[subOrder.id]"
            @click="confirmRemoveId = null"
          >Nie</button>
        </div>
      </div>
    </div>
  </div>
</template>
