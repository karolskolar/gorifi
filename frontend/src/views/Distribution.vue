<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import BalanceBadge from '@/components/BalanceBadge.vue'
import PickupLocationPicker from '@/components/PickupLocationPicker.vue'
import { bagsLabel, packedAdjective, handedAdjective } from '../lib/plural'

const route = useRoute()
const router = useRouter()

const cycle = ref(null)
const distribution = ref([])
const loading = ref(true)
const error = ref('')
const packingOrderId = ref(null)
// Per-item in-flight map ("own:12" / "guest:12" -> true). Keyed per item on
// purpose: tapping item B while item A's PATCH is still in flight must work — an
// admin ticking off a 30-friend list on a phone taps faster than the round trips
// complete. The `own:` / `guest:` prefix is not decoration: `order_items.id` and
// `guest_order_items.id` are independent sequences, so a bare id would let an own
// item and a guest bag on the same card share one pending flag (and one v-for key).
const pendingItems = ref({})

const cycleId = route.params.id

onMounted(async () => {
  await loadData()
})

// ⚠ `loadSeq` — the board re-fetches from several places (mount, after a whole-order
// pack, and from DP-T6/T7 after a pickup change or a bulk hand-over), and those
// responses can land out of order. The LAST request started is the only one allowed
// to write the refs: a slower earlier fetch resolving afterwards would otherwise
// paint a stale plan (and stale counts) over a fresh one. Same guard the shared
// dialogs/loaders carry (CLAUDE.md §Frontend).
let loadSeq = 0

async function loadData() {
  const seq = ++loadSeq
  try {
    const data = await api.getCycleDistribution(cycleId)
    if (seq !== loadSeq) return
    cycle.value = data.cycle
    distribution.value = data.distribution
    // ⚠ READ, NEVER RECOMPUTED (DP-T2, 16 §UC-DP-003). `plan` / `totals` are the
    // server's — `helpers/delivery.js` is the one home of the classification, and a
    // client-side re-derivation is exactly the second copy that drifts.
    plan.value = Array.isArray(data.plan) ? data.plan : []
    totals.value = data.totals || { count: 0, packed_count: 0, handed_count: 0 }
    locations.value = Array.isArray(data.locations) ? data.locations : []
    // ⚠ A FOCUS OUTLIVES ITS TARGET. The focus is a local `ref` and survives every
    // re-fetch, but `plan[]` is the server's and the focused key can LEAVE it —
    // the last party moves off a point and the point is retired, and that key is
    // simply not in the next payload. The delivery branch then filters to zero
    // groups while `distribution` is not empty, i.e. a toolbar over nothing with
    // no focused card left to click to release it.
    // ⚠ Not reachable from this row (nothing here re-fetches after a pickup
    // change) but it becomes reachable the moment DP-T6 adds that re-fetch, which
    // is why it is closed here rather than handed over.
    if (focusedTarget.value && !plan.value.some((entry) => entry.target_key === focusedTarget.value)) {
      focusedTarget.value = null
    }
    // After the cycle is known: the listing is filtered by cycle type. Non-blocking
    // and swallowed into its own inline message — the picking sheet must still render
    // (and stay printable) when only the pickup dropdown fails to load.
    await loadPickupLocations()
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e.message
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

// ── Pickup-location correction (PO decision, 2026-09-02) ─────────────────────
//
// The second call site of `PickupLocationPicker.vue` — this is where the bags are
// actually packed, so it is where a wrong pickup point costs time. Same route, same
// component, same no-money guarantee as the orders tab.
const pickupLocations = ref([])
const pickupLocationsError = ref('')

async function loadPickupLocations() {
  try {
    pickupLocations.value = await api.getPickupLocations(cycle.value?.type === 'bakery' ? 'bakery' : 'coffee')
    pickupLocationsError.value = ''
  } catch (e) {
    pickupLocationsError.value = e.message
  }
}

// ⚠ EVERY PARTY ON THE SHEET (PO decision, 2026-09-03: "za každých okolností"),
// synthetic rows included. A host with guest bags but no `orders` row has
// `order_id: null` — there is no order to carry a pickup, exactly as there is no
// whole-order `packed` flag — but they ARE the party who collects, so the sheet has to
// say where. Their pickup lives on the share link; the route is keyed on
// (cycle, friend) and picks the store itself, so nothing here needs to know which.
function canEditPickup() {
  return true
}

// Patched in place, not via `loadData()`: a full reload here would also re-collapse
// every guest fold and lose the admin's place in a long picking list.
function onPickupUpdated(friend, updated) {
  friend.pickup_location_id = updated.pickup_location_id
  friend.pickup_location_note = updated.pickup_location_note
  friend.pickup_location_name = updated.pickup_location_name
  // Same reason as the orders tab: otherwise the card keeps printing the 📦 address
  // and the red badge for a parcel the server just cleared.
  if (updated.cleared_parcel) {
    friend.packeta_address = null
    friend.delivery_fee = 0
  }
}

// Set page title
watchEffect(() => {
  document.title = 'Distribúcia - Gorifi Admin'
})

async function togglePacked(friend) {
  // A host with no own order has no `orders` row, so there is no whole-order flag to
  // write (§Edge Cases) — the template offers no button for them, and this is the
  // second line of defence against PATCHing /api/orders/null/packed.
  if (!friend.order_id) return
  if (packingOrderId.value) return

  packingOrderId.value = friend.order_id
  error.value = ''
  try {
    await api.togglePacked(friend.order_id)
    await loadData()
  } catch (e) {
    error.value = e.message
  } finally {
    packingOrderId.value = null
  }
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

function itemKey(kind, item) {
  return `${kind}:${item.id}`
}

function isItemPending(kind, item) {
  return !!pendingItems.value[itemKey(kind, item)]
}

function setItemPending(key, value) {
  const next = { ...pendingItems.value }
  if (value) next[key] = true
  else delete next[key]
  pendingItems.value = next
}

// A host's packing list, in the order the bags are assembled: their own items first,
// then ONE GROUP PER GUEST so the bags can be pre-separated (§Frontend / UC-GSO-011).
// Cancelled sub-orders never arrive here — the server drops them, because a
// called-off bag is neither handed over nor a blocker for the gate.
function itemGroups(friend) {
  const groups = []
  if (friend.items && friend.items.length > 0) {
    groups.push({ key: 'own', kind: 'own', guest: null, items: friend.items })
  }
  for (const guest of friend.guest_orders || []) {
    groups.push({ key: `guest-${guest.id}`, kind: 'guest', guest, items: guest.items || [] })
  }
  return groups
}

// Flattened { group, item } pairs — for the counters and the print table, which need
// one list but must still name the guest each line belongs to.
function allItemEntries(friend) {
  return itemGroups(friend).flatMap(group => group.items.map(item => ({ group, item })))
}

function hasGuestBags(friend) {
  return (friend.guest_orders || []).length > 0
}

// ---- collapsing a guest's bag list -------------------------------------------
//
// A host with several colleagues produces a very tall card (the screen that
// prompted this had 15 bags under one name), so each guest group folds away on
// demand. Keyed by `group.key` (`guest-<guest_orders.id>`) — globally unique, so
// two hosts can never share a collapse state.
//
// ⚠ DELIBERATELY MANUAL, never automatic on "all bags checked". Auto-folding was
// tried and rejected: ticking a guest's last bag would hide the very rows the admin
// needs to UNTICK when they mis-scan one, forcing an expand before every correction
// (and it dead-locks the existing untick-and-repack flow in guest-distribution's UI
// spec). The admin folds a guest away when they are done with them.
//
// The host's own "Vlastná objednávka" block stays open: it is the one list that is
// always theirs to pack.
const guestCollapse = ref({})

function guestGroupChecked(group) {
  return group.items.reduce((sum, item) => sum + (item.packed ? 1 : 0), 0)
}

function guestGroupPacked(group) {
  return group.items.length > 0 && group.items.every(item => item.packed)
}

function isGuestCollapsed(group) {
  if (group.kind !== 'guest') return false
  return !!guestCollapse.value[group.key]
}

function toggleGuestCollapsed(group) {
  guestCollapse.value = { ...guestCollapse.value, [group.key]: !isGuestCollapsed(group) }
}

// Persisted per-item packing state: toggle on the server
// (`order_items.packed` / `guest_order_items.packed`) so the "X/Y ✓" counter, the
// un-pack-on-uncheck behaviour and the "Zabaliť" gating all reflect durable state
// (survives refresh / other device).
// The response carries the updated item plus the HOST order's packed flag, so we
// patch just those two values locally instead of re-fetching the whole distribution
// (1 + N queries and a full re-render) on every tap.
async function toggleItem(friend, group, item) {
  const key = itemKey(group.kind, item)
  // `friend.order_id` is null for a host with no own order, and `packingOrderId` is
  // null while idle — without the first check, `null === null` would freeze every
  // checkbox on such a card.
  if (pendingItems.value[key]) return
  if (friend.order_id && packingOrderId.value === friend.order_id) return

  setItemPending(key, true)
  error.value = ''
  try {
    const updated = group.kind === 'guest'
      ? await api.toggleGuestItemPacked(item.id)
      : await api.toggleItemPacked(item.id)
    item.packed = updated.packed ? 1 : 0
    // Unchecking either kind of item un-packs the host's order server-side; both
    // endpoints answer with the resulting flag.
    friend.packed = updated.order_packed ? 1 : 0
  } catch (e) {
    error.value = e.message
    // Never leave the UI claiming a state that was not persisted.
    await loadData()
  } finally {
    setItemPending(key, false)
  }
}

function isItemChecked(item) {
  return !!item.packed
}

function totalItemCount(friend) {
  return allItemEntries(friend).length
}

function checkedCount(friend) {
  return allItemEntries(friend).reduce((sum, entry) => sum + (entry.item.packed ? 1 : 0), 0)
}

// The "Zabaliť" gate, mirroring the server's 409: every own item AND every item of
// every (non-cancelled) guest bag under this host must be checked, and there has to
// be at least one item.
function allItemsChecked(friend) {
  const entries = allItemEntries(friend)
  return entries.length > 0 && entries.every(entry => entry.item.packed)
}

function printDistribution() {
  window.print()
}

// ── DP-T5 (16 §UC-DP-010): the board shell ───────────────────────────────────
//
// The header IS the plan: how many bags go to Packeta, to each pickup point, and
// in person. Everything below reads the server's `plan[]` / `totals` (DP-T2) and
// only arranges them — see `loadData()` for why nothing here re-derives a target.
//
// ⚠ What is deliberately NOT here, so the next rows are not surprised:
//   • the ROW layout. Inside a group the shipped per-friend Card is still the
//     placeholder, verbatim — DP-T6 converts card → row, and `guest-distribution
//     .spec.js` passes unmodified until it does.
//   • the bulk hand-over CALL. „Odovzdať zabalené (n)" renders, counts and
//     disables itself at zero here; DP-T7 attaches the confirm modal and the
//     `POST /cycles/:id/distribution/hand-over`. ⚠ When it does: send PARTY
//     identifiers (an `order_id`, or a synthetic host's guest ids) — NOT every
//     nested guest row the group renders. DP-T4 recorded why: an explicitly
//     listed guest with one unchecked item aborts the whole batch, while the same
//     bag merely INHERITED from its host goes through.
//   • „Správa skupine" — module 21's, by resolved conflict 3. Not a slot, not a
//     disabled button: absent.
const plan = ref([])
const totals = ref({ count: 0, packed_count: 0, handed_count: 0 })
const locations = ref([])

// ⚠ PLACEHOLDER, AND ON PURPOSE ONE CONSTANT. „Štítky" is the entry point of F7
// (the label sheet), which is built elsewhere and whose route the product owner
// has not supplied yet. The button therefore renders DISABLED and navigates
// nowhere: `router.js` has no catch-all, so pushing an unknown admin path renders
// a blank page, which is strictly worse than a button that says „not yet". The
// route travels on the DOM (`data-labels-route`) so wiring it later is this line
// plus a `@click`.
const LABELS_ROUTE = '/admin/stitky'

const GROUP_BY_OPTIONS = [
  { key: 'delivery', label: 'Podľa doručenia' },
  { key: 'stage', label: 'Podľa stavu' },
  { key: 'friend', label: 'Podľa priateľa' },
]

const STAGE_FILTERS = [
  { key: 'all', label: 'Všetko' },
  { key: 'to_pack', label: 'Na zabalenie' },
  { key: 'packed', label: 'Zabalené' },
  { key: 'handed', label: 'Odovzdané' },
]

// „Podľa stavu" is exactly three groups, in the order the work happens.
const STAGE_GROUPS = [
  { key: 'to_pack', title: 'Na zabalenie', sub: '' },
  { key: 'packed', title: 'Zabalené', sub: '' },
  { key: 'handed', title: 'Odovzdané', sub: '' },
]

// The two targets that are not places, and therefore label themselves. A pickup
// point takes its title from `plan[].target_label` (the server reads it from the
// party, so a group title can never disagree with the row under it) and its
// sub-line from `locations[]`.
const DELIVERY_GROUP_META = {
  packeta: { title: 'Packeta', sub: 'zásielky odovzdáte na pobočke / Z-BOXe' },
  in_person: { title: 'Osobné odovzdanie', sub: 'dohodnete individuálne' },
}

// ⚠ Local `ref`s, not URL state: they survive the in-place row patches DP-T6/T7
// make, and a re-fetch must not reset the admin's view of the board.
const groupBy = ref('delivery')
const stageFilter = ref('all')
const focusedTarget = ref(null)

const locationsById = computed(() => {
  const map = {}
  for (const location of locations.value) map[String(location.id)] = location
  return map
})

// `loc<id>` → `<id>`, or null for `packeta` / `in_person`. The server emits no
// other shape (helpers/delivery.js), so anything else is treated as not-a-point.
function locIdOf(key) {
  const match = /^loc([1-9][0-9]*)$/.exec(String(key || ''))
  return match ? match[1] : null
}

function sortedByName(parties) {
  return [...parties].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
}

// ⚠ THE FILTER APPLIES TO PARTIES — host rows. A nested `via_host` guest is never
// filtered independently of its host: it travels inside the host's bag, so hiding
// it alone would describe a bag that does not exist.
const filteredParties = computed(() =>
  stageFilter.value === 'all'
    ? distribution.value
    : distribution.value.filter((party) => party.stage === stageFilter.value)
)

// Under „Všetko" an empty group still renders („Nič v tejto skupine.") — that is
// how the admin tells „no bags at that point" from „that point is not set up".
// Under any other filter an empty group is hidden, or filtering to „Odovzdané"
// would answer with a page of empty boxes.
function keepGroup(group) {
  return stageFilter.value === 'all' || group.parties.length > 0
}

const groups = computed(() => {
  const parties = filteredParties.value

  if (groupBy.value === 'friend') {
    return [{ key: 'all', title: 'Všetci', sub: '', parties: sortedByName(parties) }]
  }

  if (groupBy.value === 'stage') {
    return STAGE_GROUPS
      .map((group) => ({ ...group, parties: sortedByName(parties.filter((p) => p.stage === group.key)) }))
      .filter((group) => keepGroup(group))
  }

  // Podľa doručenia — `plan[]` IS the order (Packeta, points by ascending id,
  // Osobne last) and the set of groups, zero-count active points included.
  const byDelivery = plan.value.map((entry) => {
    const locationId = locIdOf(entry.target_key)
    const meta = DELIVERY_GROUP_META[entry.target_key]
    const location = locationId ? locationsById.value[locationId] : null
    return {
      key: entry.target_key,
      // A DANGLING point (the `pickup_locations` row is gone outright) keeps its
      // key and loses only its name — the bag is real and must not vanish.
      title: meta ? meta.title : (entry.target_label || 'Neznáme miesto'),
      sub: meta ? meta.sub : (location?.address || ''),
      parties: sortedByName(parties.filter((party) => party.delivery?.target_key === entry.target_key)),
    }
  }).filter((group) => keepGroup(group))

  if (focusedTarget.value) return byDelivery.filter((group) => group.key === focusedTarget.value)
  return byDelivery
})

function groupPackedCount(group) {
  return group.parties.filter((p) => p.stage === 'packed' || p.stage === 'handed').length
}

function groupHandedCount(group) {
  return group.parties.filter((p) => p.stage === 'handed').length
}

// ⚠ `stage === 'packed'` ONLY, never the `packed_count` superset: a bag that is
// already handed over is DONE, not ready, and counting it would offer to hand
// over a parcel that has left the building.
function groupReadyCount(group) {
  return group.parties.filter((p) => p.stage === 'packed').length
}

const boardEmpty = computed(() => distribution.value.length === 0)

// ⚠ THERE ARE BAGS, BUT NONE IN THIS VIEW. A focus and a non-default stage filter
// select independently, so their intersection can be empty (focus „Packeta" +
// „Na zabalenie" when everything at Packeta has left) — and under any filter but
// „Všetko" the empty groups are hidden too, so the screen would be a toolbar over
// nothing. Rather than decide which of the two wins (a semantics call §UC-DP-010
// does not settle, and DP-T7's confirm modal reads this same list), the board
// SAYS SO. ⚠ Distinct from `boardEmpty`, which is about the CYCLE.
const viewEmpty = computed(() => !boardEmpty.value && groups.value.length === 0)

const totalsLine = computed(() => {
  const count = totals.value?.count || 0
  const packed = totals.value?.packed_count || 0
  const handed = totals.value?.handed_count || 0
  return `${bagsLabel(count)} · ${packed} ${packedAdjective(packed)} · ${handed} ${handedAdjective(handed)}`
})

// ⚠ The two-tone bar only adds up because DP-T2 made `packed_count` a SUPERSET of
// `handed_count` (handed implies packed): the first segment is the handed share,
// the second is what is packed but still here. A second segment drawn from
// `packed_count / count` would double-count every handed bag and overflow.
function handedShare(entry) {
  return entry.count > 0 ? Math.round((entry.handed_count / entry.count) * 1000) / 10 : 0
}

function packedShare(entry) {
  return entry.count > 0
    ? Math.round(((entry.packed_count - entry.handed_count) / entry.count) * 1000) / 10
    : 0
}

function planIcon(entry) {
  if (entry.type === 'packeta') return '🚚'
  if (entry.type === 'pickup') return '📍'
  return '🤝'
}

// The shipped kg rule, `Math.round(g/10)/100` (FriendOrder.vue,
// GuestProductGrid.vue, FriendPortalSession.vue print the same expression).
// JavaScript's own number→string drops the trailing zeros, which is the "trailing
// zeros stripped" half of it — 1500 g reads „1.5 kg", 1000 g reads „1 kg".
function kgLabel(grams) {
  return `${Math.round((grams || 0) / 10) / 100} kg`
}

// Click = group by delivery AND show only this target; click again = release.
function focusPlan(entry) {
  groupBy.value = 'delivery'
  focusedTarget.value = focusedTarget.value === entry.target_key ? null : entry.target_key
}

// Choosing a grouping clears the card focus (§UC-DP-010) — a focus on a delivery
// target is meaningless under „Podľa stavu" / „Podľa priateľa".
function setGroupBy(key) {
  groupBy.value = key
  focusedTarget.value = null
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header (hidden when printing) -->
    <header class="bg-primary text-primary-foreground shadow print:hidden">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="router.push(`/admin/cycle/${cycleId}`)" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <h1 class="text-xl font-bold">Distribúcia - {{ cycle?.name || 'Načítavam...' }}</h1>
        </div>
        <Button variant="secondary" @click="printDistribution">
          Tlačiť
        </Button>
      </div>
    </header>

    <!-- Print header -->
    <div class="hidden print:block p-4 border-b">
      <h1 class="text-2xl font-bold">Distribúcia - {{ cycle?.name }}</h1>
    </div>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-6 print:max-w-none print:p-4">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <!-- An empty dropdown and a failed load look identical on screen; say which it
           was rather than let the admin conclude no places are configured. -->
      <Alert v-if="pickupLocationsError" variant="destructive" class="mb-4 print:hidden" data-testid="dist-pickup-locations-error">
        <AlertDescription class="text-sm">
          Miesta vyzdvihnutia sa nepodarilo načítať: {{ pickupLocationsError }}. Zmena miesta
          teraz nie je možná — obnovte stránku.
        </AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <div v-else class="space-y-6">
        <!-- ── Title block (16 §UC-DP-010 item 2) ───────────────────────────── -->
        <div>
          <h1 class="text-2xl font-bold" data-testid="board-title">
            Distribúcia <span class="text-primary">plán</span>
          </h1>
          <p class="text-sm text-muted-foreground mt-1" data-testid="board-totals">{{ totalsLine }}</p>
        </div>

        <!-- ── Plan cards, one per plan[] entry, zero-count points included ──
             `print:hidden`: the plan is a screen tool, the printed sheet is the
             bags themselves. -->
        <div v-if="plan.length > 0" class="grid gap-3 grid-cols-2 lg:grid-cols-4 print:hidden">
          <Card
            v-for="entry in plan"
            :key="entry.target_key"
            :data-testid="`plan-card-${entry.target_key}`"
            :data-focused="focusedTarget === entry.target_key ? 'true' : 'false'"
            role="button"
            tabindex="0"
            @click="focusPlan(entry)"
            @keydown.enter.prevent="focusPlan(entry)"
            @keydown.space.prevent="focusPlan(entry)"
            :class="[
              'cursor-pointer transition-all select-none hover:border-muted-foreground/40',
              focusedTarget === entry.target_key ? 'ring-2 ring-primary border-primary' : ''
            ]"
          >
            <CardContent class="p-3">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0" style="overflow-wrap: anywhere">
                  <span class="text-base" aria-hidden="true">{{ planIcon(entry) }}</span>
                  <span class="text-sm font-semibold ml-1">{{ entry.target_label || 'Neznáme miesto' }}</span>
                </div>
                <span class="text-2xl font-bold leading-none shrink-0" :data-testid="`plan-count-${entry.target_key}`">{{ entry.count }}</span>
              </div>
              <!-- Two-tone: handed first, then packed-but-still-here. The shares
                   ride on the DOM so they are assertable, not eyeballed. -->
              <div class="mt-2 h-2 w-full rounded-full bg-muted overflow-hidden flex">
                <div
                  class="h-full bg-green-600"
                  :data-testid="`plan-bar-handed-${entry.target_key}`"
                  :data-share="handedShare(entry)"
                  :style="{ width: `${handedShare(entry)}%` }"
                ></div>
                <div
                  class="h-full bg-amber-400"
                  :data-testid="`plan-bar-packed-${entry.target_key}`"
                  :data-share="packedShare(entry)"
                  :style="{ width: `${packedShare(entry)}%` }"
                ></div>
              </div>
              <div class="mt-1.5 text-xs text-muted-foreground" :data-testid="`plan-line-${entry.target_key}`">
                {{ entry.packed_count }}/{{ entry.count }} zabal. ·
                {{ entry.handed_count }}/{{ entry.count }} odovzd. ·
                {{ kgLabel(entry.kg) }}
              </div>
            </CardContent>
          </Card>
        </div>

        <!-- ── Toolbar: group-by + stage filter ─────────────────────────────── -->
        <div class="flex flex-wrap items-center gap-4 print:hidden">
          <div class="inline-flex rounded-md border overflow-hidden">
            <button
              v-for="option in GROUP_BY_OPTIONS"
              :key="option.key"
              type="button"
              :data-testid="`group-by-${option.key}`"
              :data-active="groupBy === option.key ? 'true' : 'false'"
              @click="setGroupBy(option.key)"
              class="px-3 py-1.5 text-sm transition-colors border-r last:border-r-0"
              :class="groupBy === option.key ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'"
            >
              {{ option.label }}
            </button>
          </div>
          <div class="inline-flex rounded-md border overflow-hidden">
            <button
              v-for="option in STAGE_FILTERS"
              :key="option.key"
              type="button"
              :data-testid="`stage-filter-${option.key}`"
              :data-active="stageFilter === option.key ? 'true' : 'false'"
              @click="stageFilter = option.key"
              class="px-3 py-1.5 text-sm transition-colors border-r last:border-r-0"
              :class="stageFilter === option.key ? 'bg-secondary text-secondary-foreground' : 'bg-background hover:bg-muted'"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <!-- Nobody ordered: the plan cards above still show the configured points
             at 0, and this replaces the groups entirely. -->
        <div v-if="boardEmpty" class="text-muted-foreground italic py-8" data-testid="board-empty">
          Zatiaľ nie je čo distribuovať.
        </div>

        <!-- There ARE bags — just none that the current focus + filter select.
             A screen that explains itself instead of one that looks broken. -->
        <div v-else-if="viewEmpty" class="text-muted-foreground italic py-8" data-testid="board-no-match">
          Tomuto výberu nezodpovedá žiadny balíček. Zmeňte filter alebo zoskupenie.
        </div>

        <!-- ── Groups ───────────────────────────────────────────────────────── -->
        <template v-else>
        <section
          v-for="group in groups"
          :key="group.key"
          :data-testid="`dist-group-${group.key}`"
          class="space-y-3"
        >
          <!-- ⚠ NO `p-4` ON ANY WRAPPER AROUND A PARTY CARD. `guest-distribution
               .spec.js` locates a card as `div.p-4` containing the friend's
               heading; a second such ancestor makes that locator strict-mode
               ambiguous and reddens a shipped file this row must not touch. -->
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-2">
            <div class="min-w-0" style="overflow-wrap: anywhere">
              <h2 class="text-base font-semibold">{{ group.title }}</h2>
              <p v-if="group.sub" class="text-xs text-muted-foreground">{{ group.sub }}</p>
            </div>
            <Badge variant="outline" :data-testid="`group-badge-${group.key}`">
              {{ bagsLabel(group.parties.length) }}
            </Badge>
            <span class="text-xs text-muted-foreground" :data-testid="`group-counts-${group.key}`">
              {{ groupPackedCount(group) }} zabal. · {{ groupHandedCount(group) }} odovzd.
            </span>
            <div class="ml-auto flex items-center gap-2 print:hidden">
              <!-- F7's entry point, not yet supplied — see LABELS_ROUTE. -->
              <Button
                variant="outline"
                size="sm"
                disabled
                title="Tlač štítkov pripravujeme"
                :data-testid="`labels-group-${group.key}`"
                :data-labels-route="LABELS_ROUTE"
              >
                Štítky
              </Button>
              <!-- DP-T7 attaches the confirm modal and the bulk POST; here it only
                   counts and refuses to be clickable at zero. -->
              <Button
                size="sm"
                :disabled="groupReadyCount(group) === 0"
                :data-testid="`handover-group-${group.key}`"
              >
                Odovzdať zabalené ({{ groupReadyCount(group) }})
              </Button>
            </div>
          </div>

          <div
            v-if="group.parties.length === 0"
            class="text-sm text-muted-foreground italic"
            :data-testid="`group-empty-${group.key}`"
          >
            Nič v tejto skupine.
          </div>

          <div v-else class="space-y-4">
        <Card
          v-for="friend in group.parties"
          :key="friend.id"
          :class="[
            'print:shadow-none print:border print:break-inside-avoid',
            friend.packed ? 'opacity-50' : ''
          ]"
        >
          <CardContent class="p-4">
            <div class="flex justify-between items-start mb-3">
              <div>
                <h3 class="text-lg font-semibold">{{ friend.name }}</h3>
                <div class="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                  <BalanceBadge :balance="friend.balance || 0" />
                  <!-- A host with no own order (§Edge Cases) is still the pickup
                       party, but has nothing of their own to pay for — a red
                       "Nezaplatené" badge on a 0 EUR non-order would be a lie. -->
                  <template v-if="friend.has_own_order !== false">
                    <Badge v-if="friend.paid" variant="default" class="bg-green-600">Zaplatené</Badge>
                    <Badge v-else variant="destructive">Nezaplatené</Badge>
                    <span>{{ formatPrice(friend.total) }}</span>
                  </template>
                  <Badge
                    v-else
                    variant="outline"
                    class="border-violet-400 text-violet-700 bg-violet-50"
                  >
                    Bez vlastnej objednávky
                  </Badge>
                  <!-- ⚠ EDITABLE HERE TOO (PO decision, 2026-09-02) — this is the
                       screen the bags are packed from, so it is where a wrong pickup
                       point costs time. Saves on pick; see the picker's own header.
                       ⚠ AND IT IS `print:hidden` WITH THE BADGE KEPT FOR PRINT: a
                       printed picking sheet must state the place as TEXT, not render a
                       dropdown box (the same rule as the guest folds' `hidden
                       print:flex`). -->
                  <PickupLocationPicker
                    v-if="canEditPickup(friend)"
                    class="print:hidden"
                    testid-prefix="dist-pickup"
                    :cycle-id="cycleId"
                    :friend-id="friend.id"
                    :locations="pickupLocations"
                    :location-id="friend.pickup_location_id"
                    :location-name="friend.pickup_location_name || ''"
                    :note="friend.pickup_location_note || ''"
                    :packeta-address="friend.packeta_address || ''"
                    :delivery-fee="friend.delivery_fee || 0"
                    @updated="onPickupUpdated(friend, $event)"
                  />
                  <Badge
                    v-if="friend.pickup_location_name || friend.pickup_location_note"
                    variant="outline"
                    :data-testid="`dist-pickup-badge-${friend.id}`"
                    class="border-blue-400 text-blue-600 bg-blue-50 hidden print:inline-flex"
                  >
                    {{ friend.pickup_location_name || friend.pickup_location_note }}
                  </Badge>
                  <!-- Print-only for the same reason: on screen the pill itself reads
                       red "Packeta", so both would be the same word twice — but the
                       printed sheet has no pill and still has to say it. -->
                  <Badge
                    v-if="friend.packeta_address"
                    variant="outline"
                    class="border-red-400 text-red-600 bg-red-50 hidden print:inline-flex"
                  >
                    Packeta
                  </Badge>
                  <span v-if="!friend.packed && totalItemCount(friend) > 0" class="text-xs">· {{ checkedCount(friend) }}/{{ totalItemCount(friend) }} ✓</span>
                </div>
                <div v-if="friend.packeta_address" class="text-sm text-muted-foreground mt-1">
                  📦 {{ friend.packeta_address }}
                </div>
              </div>
              <!-- No `orders` row ⇒ nowhere to store a whole-order packed flag, so
                   no button. Such a host's packing record is the per-bag
                   checkboxes below. -->
              <Button
                v-if="friend.has_own_order !== false"
                @click="togglePacked(friend)"
                :variant="friend.packed ? 'default' : 'outline'"
                :disabled="packingOrderId === friend.order_id || (!friend.packed && !allItemsChecked(friend))"
                size="sm"
                :class="[
                  'print:hidden shrink-0',
                  friend.packed ? 'bg-green-600 hover:bg-green-700' : ''
                ]"
              >
                {{ packingOrderId === friend.order_id ? '...' : (friend.packed ? 'Zabalené' : 'Zabaliť') }}
              </Button>
            </div>

            <template v-if="!friend.packed">
              <div v-if="totalItemCount(friend) === 0" class="text-muted-foreground italic">
                Žiadne položky
              </div>
              <!-- One block per group: the host's own items, then one per guest, so
                   the bags can be pre-separated during packing (§UC-GSO-011). -->
              <div v-else class="flex flex-col gap-3">
                <div v-for="group in itemGroups(friend)" :key="group.key" class="flex flex-col gap-1.5">
                  <!-- The whole guest header is the collapse control: on a phone,
                       held in one hand over a pile of bags, a 16px chevron is not a
                       target. `print:hidden` on the chevron only — the header itself
                       still labels the bags on a printed sheet. -->
                  <button
                    v-if="group.kind === 'guest'"
                    type="button"
                    @click="toggleGuestCollapsed(group)"
                    :aria-expanded="isGuestCollapsed(group) ? 'false' : 'true'"
                    :title="isGuestCollapsed(group) ? 'Rozbaliť vrecká hosťa' : 'Zbaliť vrecká hosťa'"
                    :data-testid="`guest-group-toggle-${group.guest.id}`"
                    class="flex w-full items-center gap-2 flex-wrap text-sm text-muted-foreground text-left rounded hover:bg-muted/60 -mx-1 px-1 py-0.5 transition-colors print:hover:bg-transparent"
                  >
                    <svg
                      class="w-4 h-4 shrink-0 transition-transform text-violet-500 print:hidden"
                      :class="{ 'rotate-90': !isGuestCollapsed(group) }"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                    </svg>
                    <Badge variant="outline" class="text-xs border-violet-400 text-violet-700 bg-violet-50">
                      Hosť • {{ group.guest.guest_name }}
                    </Badge>
                    <span class="text-xs">{{ formatPrice(group.guest.total) }}</span>
                    <Badge
                      v-if="group.guest.paid"
                      variant="outline"
                      class="text-xs border-green-400 text-green-700 bg-green-50"
                    >
                      Zaplatené
                    </Badge>
                    <Badge
                      v-else
                      variant="outline"
                      class="text-xs border-amber-400 text-amber-700 bg-amber-50"
                    >
                      Nezaplatené
                    </Badge>
                    <!-- Collapsed, this counter is the only thing left saying whether
                         these bags are done — so it is always shown when folded. -->
                    <span
                      v-if="isGuestCollapsed(group) && group.items.length > 0"
                      class="text-xs print:hidden"
                      :class="guestGroupPacked(group) ? 'text-green-700' : ''"
                      :data-testid="`guest-group-summary-${group.guest.id}`"
                    >
                      · {{ guestGroupChecked(group) }}/{{ group.items.length }} ✓
                    </span>
                  </button>
                  <!-- Only worth labelling the host's own bag when there are guest
                       bags next to it. -->
                  <div v-else-if="hasGuestBags(friend)" class="text-xs text-muted-foreground">
                    Vlastná objednávka
                  </div>
                  <!-- Collapsed means hidden ON SCREEN only. A printed picking sheet
                       must still list every bag, so this folds with `hidden
                       print:flex` rather than a `v-if` that would drop the rows out
                       of the DOM entirely. -->
                  <div
                    class="flex-col gap-1.5"
                    :class="isGuestCollapsed(group) ? 'hidden print:flex' : 'flex'"
                    :data-testid="group.kind === 'guest' ? `guest-group-items-${group.guest.id}` : undefined"
                  >
                  <div
                    v-for="item in group.items"
                    :key="group.key + '-' + item.id"
                    :data-owner="group.kind"
                    @click="toggleItem(friend, group, item)"
                    :aria-busy="isItemPending(group.kind, item)"
                    class="flex items-center gap-2.5 border rounded-lg px-3 py-2.5 cursor-pointer transition-all select-none print:border-gray-300"
                    :class="[
                      isItemChecked(item)
                        ? 'bg-green-50 border-green-200 opacity-50 dark:bg-green-950/20 dark:border-green-800'
                        : 'bg-card border-border hover:border-muted-foreground/30',
                      isItemPending(group.kind, item) ? 'animate-pulse ring-2 ring-primary/40 print:ring-0 print:animate-none' : ''
                    ]"
                  >
                    <input
                      type="checkbox"
                      :checked="isItemChecked(item)"
                      class="w-5 h-5 accent-green-500 shrink-0 pointer-events-none print:hidden"
                    />
                    <div class="flex-1 min-w-0" :class="isItemChecked(item) ? 'line-through' : ''">
                      <div class="font-semibold text-sm">{{ item.product_name }}<span v-if="item.variant_label" class="font-normal text-muted-foreground"> — {{ item.variant_label }}</span></div>
                      <div class="flex gap-1 mt-1 flex-wrap">
                        <Badge
                          v-if="item.purpose"
                          variant="outline"
                          class="text-[11px] px-1.5 py-0"
                          :class="{
                            'border-stone-400 text-stone-600 bg-stone-50': item.purpose === 'Espresso',
                            'border-sky-400 text-sky-600 bg-sky-50': item.purpose === 'Filter',
                            'border-amber-400 text-amber-600 bg-amber-50': item.purpose === 'Kapsule' || item.purpose === 'Slané',
                            'border-pink-400 text-pink-600 bg-pink-50': item.purpose === 'Sladké'
                          }"
                        >
                          {{ item.purpose }}
                        </Badge>
                        <Badge
                          v-if="item.roast_type"
                          variant="outline"
                          class="text-[11px] px-1.5 py-0 border-amber-300 text-amber-700 bg-amber-50"
                        >
                          {{ item.roast_type }}
                        </Badge>
                        <Badge variant="outline" class="text-[11px] px-1.5 py-0 border-green-400 text-green-700 bg-green-50 font-semibold">
                          {{ item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant) }} × {{ item.quantity }}
                        </Badge>
                      </div>
                    </div>
                    <!-- Immediate feedback that this tap is being saved -->
                    <svg
                      v-if="isItemPending(group.kind, item)"
                      class="w-4 h-4 shrink-0 animate-spin text-muted-foreground print:hidden"
                      fill="none"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                  </div>
                  </div>
                </div>
              </div>
            </template>

            <!-- Print-only table fallback. The "Pre" column names whose bag each
                 line goes into — a printed sheet is what the bags are separated
                 against, so the per-guest grouping has to survive the print. -->
            <template v-if="!friend.packed && totalItemCount(friend) > 0">
              <table class="hidden print:table w-full text-sm mt-2">
                <thead>
                  <tr class="border-b">
                    <th class="text-left py-1">Pre</th>
                    <th class="text-left py-1">Produkt</th>
                    <th class="text-left py-1">Praženie</th>
                    <th class="text-center py-1">Varianta</th>
                    <th class="text-center py-1">Počet</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(entry, i) in allItemEntries(friend)" :key="'print-'+i" class="border-b border-gray-200">
                    <td class="py-1">{{ entry.group.kind === 'guest' ? entry.group.guest.guest_name : 'Vlastné' }}</td>
                    <td class="py-1">{{ entry.item.product_name }}<span v-if="entry.item.variant_label"> — {{ entry.item.variant_label }}</span></td>
                    <td class="py-1">{{ entry.item.roast_type || '-' }}</td>
                    <td class="text-center py-1">{{ entry.item.variant_label ? entry.item.variant_label : (entry.item.variant === 'unit' ? 'ks' : entry.item.variant) }}</td>
                    <td class="text-center py-1">{{ entry.item.quantity }}×</td>
                  </tr>
                </tbody>
              </table>
            </template>
          </CardContent>
        </Card>
          </div>
        </section>
        </template>
      </div>
    </main>
  </div>
</template>

<style>
@media print {
  body {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
}
</style>
