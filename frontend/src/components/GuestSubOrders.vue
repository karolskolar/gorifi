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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'

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

// 1 kolega / 2-4 kolegovia / 5+ kolegov
const colleagueCount = computed(() => {
  const count = totals.value.count || 0
  if (count === 1) return '1 kolega'
  if (count >= 2 && count <= 4) return `${count} kolegovia`
  return `${count} kolegov`
})

// Recomputed from the same rows the list renders, so the badge can never drift from
// what the tab actually contains. Cancelled sub-orders count for neither number:
// they owe nothing and there is nothing to hand over.
watchEffect(() => {
  const live = subOrders.value.filter((o) => !isCancelled(o))
  emit('summary', {
    count: totals.value.count || 0,
    total: totals.value.total || 0,
    pendingDelivery: live.reduce((sum, o) => sum + (o.delivered ? 0 : 1), 0),
    failed: !!error.value,
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
       load would otherwise be indistinguishable from "no colleagues yet". -->
  <Card v-if="subOrders.length > 0 || error" class="mb-4" data-testid="guest-sub-orders">
    <CardHeader class="pb-2">
      <CardTitle class="text-base">Objednávky kolegov</CardTitle>
      <CardDescription v-if="subOrders.length > 0">
        Objednali {{ colleagueCount }} · spolu {{ formatPrice(totals.total) }}.
        Kolegovia platia priamo, vaša suma na úhradu sa tým nemení.
      </CardDescription>
    </CardHeader>

    <CardContent class="space-y-3 p-4 pt-0">
      <Alert v-if="error" variant="destructive">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div
        v-for="subOrder in subOrders"
        :key="subOrder.id"
        class="rounded-lg border p-3"
        :class="[
          isCancelled(subOrder) ? 'border-dashed opacity-60' : 'border-border',
          pending[subOrder.id] ? 'animate-pulse' : ''
        ]"
      >
        <div class="flex flex-wrap items-start justify-between gap-2">
          <!-- The whole name block is the fold control — a bare 16px chevron is not
               a thumb target on the phone this screen is used on. Spans, not divs:
               a <div> inside a <button> is invalid HTML. -->
          <button
            type="button"
            @click="toggleCollapsed(subOrder)"
            :aria-expanded="isCollapsed(subOrder) ? 'false' : 'true'"
            :title="isCollapsed(subOrder) ? 'Zobraziť položky' : 'Skryť položky'"
            :data-testid="`guest-items-toggle-${subOrder.id}`"
            class="flex min-w-0 items-start gap-1.5 text-left rounded -m-1 p-1 hover:bg-muted/60 transition-colors"
          >
            <svg
              class="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground transition-transform"
              :class="{ 'rotate-90': !isCollapsed(subOrder) }"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            <span class="min-w-0">
              <span class="block font-semibold text-sm">{{ subOrder.guest_name }}</span>
              <span class="block text-xs text-muted-foreground">{{ subOrder.guest_phone }}</span>
              <!-- Folded, this is the only thing left saying how much is hidden. -->
              <span
                v-if="isCollapsed(subOrder) && (subOrder.items || []).length > 0"
                class="block text-xs text-muted-foreground"
                :data-testid="`guest-items-summary-${subOrder.id}`"
              >
                {{ itemCountLabel(subOrder) }}
              </span>
            </span>
          </button>
          <div class="flex flex-wrap items-center gap-1.5">
            <!-- `paid` is the ADMIN's flag: shown, never toggled here. -->
            <Badge
              variant="outline"
              class="text-[11px] px-1.5 py-0"
              :class="subOrder.paid
                ? 'border-green-500 text-green-700 bg-green-50'
                : 'border-amber-400 text-amber-700 bg-amber-50'"
              data-testid="guest-paid-badge"
            >
              {{ subOrder.paid ? 'Zaplatené' : 'Nezaplatené' }}
            </Badge>
            <Badge
              v-if="isCancelled(subOrder)"
              variant="outline"
              class="text-[11px] px-1.5 py-0 border-stone-400 text-stone-600 bg-stone-50"
              :data-testid="`guest-status-${subOrder.id}`"
            >
              Zrušené
            </Badge>
          </div>
        </div>

        <ul
          v-if="!isCollapsed(subOrder)"
          class="mt-2 space-y-0.5 text-xs text-muted-foreground"
          :data-testid="`guest-items-${subOrder.id}`"
        >
          <li v-for="item in subOrder.items" :key="item.id" class="flex justify-between gap-2">
            <span class="min-w-0">
              {{ item.quantity }}× {{ item.product_name }}
              <span v-if="item.variant_label" class="text-muted-foreground/80">— {{ item.variant_label }}</span>
              <span v-else-if="item.variant && item.variant !== 'unit'" class="text-muted-foreground/80">— {{ item.variant }}</span>
            </span>
            <span class="shrink-0">{{ formatPrice(item.price * item.quantity) }}</span>
          </li>
        </ul>

        <div class="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <span class="text-sm font-semibold">{{ formatPrice(subOrder.total) }}</span>

          <div class="flex items-center gap-3">
            <label
              v-if="!isCancelled(subOrder)"
              class="flex items-center gap-1.5 text-xs cursor-pointer select-none"
            >
              <input
                type="checkbox"
                class="w-4 h-4 accent-green-500"
                :checked="!!subOrder.delivered"
                :disabled="!!pending[subOrder.id]"
                :data-testid="`guest-delivered-${subOrder.id}`"
                @change="toggleDelivered(subOrder)"
              />
              Odovzdané
            </label>

            <Button
              v-if="!cycleLocked && !isCancelled(subOrder) && confirmRemoveId !== subOrder.id"
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs text-muted-foreground"
              :data-testid="`guest-remove-${subOrder.id}`"
              @click="confirmRemoveId = subOrder.id"
            >
              Odstrániť
            </Button>
          </div>
        </div>

        <!-- Removing is destructive (the colleague's order is called off and they
             cannot re-save it), so it asks first. -->
        <div
          v-if="confirmRemoveId === subOrder.id"
          class="mt-2 space-y-2 rounded-md border border-yellow-400 bg-yellow-50 p-3"
        >
          <p class="text-xs text-yellow-800">
            Objednávka kolegu sa zruší. Kolega ju uvidí ako zrušenú a už si ju nebude môcť upraviť.
          </p>
          <div class="flex gap-2">
            <Button
              size="sm"
              class="bg-red-600 hover:bg-red-700"
              :disabled="!!pending[subOrder.id]"
              @click="removeSubOrder(subOrder)"
            >
              {{ pending[subOrder.id] ? 'Odstraňujem...' : 'Áno, odstrániť' }}
            </Button>
            <Button variant="ghost" size="sm" @click="confirmRemoveId = null">Nie</Button>
          </div>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
