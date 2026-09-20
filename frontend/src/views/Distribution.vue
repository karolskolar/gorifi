<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import BalanceBadge from '@/components/BalanceBadge.vue'
import PickupLocationPicker from '@/components/PickupLocationPicker.vue'
import { bagsLabel, packedAdjective, handedAdjective, guestsLabel, bagsMoveVerb } from '../lib/plural'

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
    // ⚠ ~~Not reachable from this row (nothing here re-fetches after a pickup
    // change) but it becomes reachable the moment DP-T6 adds that re-fetch.~~
    // **REACHABLE SINCE DP-T6**: `onPickupUpdated()` below re-fetches, so moving
    // the last party off a point and retiring it now releases the focus here.
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

// ⚠ PATCH IN PLACE, **THEN RE-FETCH** (DP-T6, 16 §UC-DP-011). Two halves, and both
// are load-bearing:
//
//  • The patch is what keeps the admin's place. A `location.reload()` here would
//    re-collapse every guest fold and every row the admin folded away in a long
//    picking list — which is why this was a patch in the first place.
//  • The re-fetch is what keeps the board HONEST. A pickup change can move the
//    party into another GROUP and onto another PLAN CARD, and `delivery` / `plan`
//    are `helpers/delivery.js`'s answer, not something this screen may re-derive
//    (one home — the same rule `loadData()` states about `plan` / `totals`). So the
//    patch paints the picker's own three columns immediately, and `loadData()`
//    (loadSeq-guarded, so a slow earlier fetch cannot paint over it) brings the
//    grouping back from the server.
async function onPickupUpdated(friend, updated) {
  friend.pickup_location_id = updated.pickup_location_id
  friend.pickup_location_note = updated.pickup_location_note
  friend.pickup_location_name = updated.pickup_location_name
  // Same reason as the orders tab: otherwise the row keeps printing the 📦 address
  // and the red badge for a parcel the server just cleared.
  if (updated.cleared_parcel) {
    friend.packeta_address = null
    friend.delivery_fee = 0
  }
  await loadData()
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
  // ⚠ 16 §UC-DP-007, the frontend half: a bag that has already left cannot be
  // un-packed (un-packing posts the ledger reversal and re-opens the bag). The
  // button renders disabled with the title, and this is the second line of
  // defence — the server answers 409 `handed_over` either way.
  if (isHandedOver(friend)) return

  packingOrderId.value = friend.order_id
  error.value = ''
  // ⚠ AND THE ROW'S OWN REFUSAL GOES WITH IT. „Najprv označte balíček ako
  // zabalený" is advice about THIS step: the moment the admin takes it, the
  // sentence is false, and a stale red line under a row that is now packed and
  // ready to hand over is worse than no line at all. Cleared here and in
  // `toggleItem()` — the two doors that act on the advice — exactly where the
  // global `error` is cleared.
  setRowError(String(friend.id), '')
  // ⚠ And so does the GROUP's refusal highlight (DP-T7): „Niektoré balíčky už nie
  // sú zabalené" points at THIS row, and packing it is the admin taking that
  // advice — same rule, one line up.
  clearRefusal(friend.id)
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
  // §UC-DP-007 again: unchecking an item of a handed-over bag is a 409, and for a
  // guest bag the gate is EITHER the guest's own hand-over or the host's (the
  // host's own order would otherwise be un-packed by the guest's uncheck).
  if (itemLocked(friend, group)) return

  setItemPending(key, true)
  error.value = ''
  // Same reason as in `togglePacked()`: ticking the item that was holding the
  // gate closed is the admin acting on the row's refusal, so the refusal goes.
  setRowError(String(friend.id), '')
  clearRefusal(friend.id)
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
//   • ~~the ROW layout. Inside a group the shipped per-friend Card is still the
//     placeholder, verbatim — DP-T6 converts card → row.~~ **DONE (DP-T6): see the
//     row section at the bottom of this script.** `guest-distribution.spec.js` and
//     `item-packed.spec.js` still pass UNMODIFIED — the conversion kept the one
//     `div.p-4` and the item rows' `div.cursor-pointer` that both files locate a
//     party by.
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

// ── DP-T6 (16 §UC-DP-011): the row ──────────────────────────────────────────
//
// One bag, one row, five columns — Kto · Doručenie/obsah · Platba · Krok 1 ·
// Krok 2 — with the shipped packing mechanics (per-item checkboxes, guest folds,
// the pickup picker) kept verbatim inside a click-to-expand body.
//
// ⚠ What is deliberately NOT here:
//   • the module-20 PACKETA GUEST ROW. A guest carrying its OWN `packeta_address`
//     becomes its own party under Packeta („Hosť • cez {host}") instead of nesting
//     under its host. `helpers/delivery.js` already classifies it; nothing EMITS it
//     as a standalone party yet, so today `friend.guest_orders[]` holds via_host
//     guests only and the nested-row block below is the whole story. GP-T6 fills
//     the slot; the seam is that a Packeta guest simply stops arriving in
//     `guest_orders[]` and starts arriving as a party, which this row renders
//     without a new branch (the nested block iterates what it is given).
//   • the per-GROUP „Odovzdať zabalené (n)" CALL — DP-T7's.

/**
 * A row is expandable only when it HAS a body. The shipped card body is
 * `v-if="!friend.packed"`: the moment the whole-order flag is set, the checklist
 * is gone (item-packed.spec.js pins exactly that), so a packed friend row really
 * is one line and a toggle over nothing would be a lie. A SYNTHETIC host has no
 * `packed` column at all, so their checklist survives every stage — they are the
 * party for whom „collapsed once done" is a fold rather than an unmount.
 */
function hasRowBody(friend) {
  return !friend.packed && totalItemCount(friend) > 0
}

// ⚠ A local OVERRIDE map over a DERIVED default, not a state map seeded on load.
// The default is „expanded while there is packing to do" (PO, 2026-09-19), and it
// must keep tracking `stage` as the admin works — a map seeded at load time would
// freeze a bag open after it was packed, and a re-fetch that reseeded it would
// throw away the rows the admin expanded by hand. Keyed by party id, so it
// survives every in-place patch and every `loadData()`.
const rowExpandOverride = ref({})

function isRowExpanded(friend) {
  const key = String(friend.id)
  if (Object.prototype.hasOwnProperty.call(rowExpandOverride.value, key)) {
    return !!rowExpandOverride.value[key]
  }
  return (friend.stage || 'to_pack') === 'to_pack'
}

function toggleRow(friend) {
  if (!hasRowBody(friend)) return
  rowExpandOverride.value = { ...rowExpandOverride.value, [String(friend.id)]: !isRowExpanded(friend) }
}

// ⚠ PER-ROW, NEVER ONE GLOBAL FLAG. This is a money-adjacent admin screen worked
// from a phone over a pile of bags: hand-over #2 must not be swallowed because
// hand-over #1 is still in flight. Same discipline as `pendingItems` above, and
// the same reason the error is per row too — a shared `error` banner would blame
// the wrong bag.
const pendingParties = ref({})
const rowErrors = ref({})

function isPartyPending(friend) {
  return !!pendingParties.value[String(friend.id)]
}

function setPartyPending(key, value) {
  const next = { ...pendingParties.value }
  if (value) next[key] = true
  else delete next[key]
  pendingParties.value = next
}

function setRowError(key, message) {
  const next = { ...rowErrors.value }
  if (message) next[key] = message
  else delete next[key]
  rowErrors.value = next
}

function rowError(friend) {
  return rowErrors.value[String(friend.id)] || ''
}

function isHandedOver(friend) {
  return !!friend.handed_over_at || friend.stage === 'handed'
}

function itemLocked(friend, group) {
  if (isHandedOver(friend)) return true
  return group.kind === 'guest' && !!group.guest.handed_over_at
}

function guestCount(friend) {
  return (friend.guest_orders || []).length
}

// „odovzdané okrem {n}" — UC-DP-005 case c: the admin took ONE colleague's bag
// back out of a parcel that has otherwise left. The row says so rather than
// showing a ticked host over an unticked guest and letting the admin work it out.
function handedExceptCount(friend) {
  if (!isHandedOver(friend)) return 0
  return (friend.guest_orders || []).filter((guest) => !guest.handed_over_at).length
}

// „{items} pol. · {kg} kg" — the bag's own content line. `friend.kg` is the
// SERVER's (grams, guests folded in, DP-T2); `kgLabel` is the one copy of the
// display rule already in this file.
function contentLine(friend) {
  return `${totalItemCount(friend)} pol. · ${kgLabel(friend.kg || 0)}`
}

// Krok 2 is reachable only from „Zabalené" — the prototype's `opacity .4`, and a
// mirror of the server's 409 `not_packed`.
function canHandOver(friend) {
  if (isPartyPending(friend)) return false
  const stage = friend.stage || 'to_pack'
  return stage === 'packed' || stage === 'handed'
}

function handOverTitle(friend) {
  return canHandOver(friend) || isPartyPending(friend) ? '' : 'Najprv zabaliť'
}

// A refused change SNAPS THE CONTROL BACK (CLAUDE.md §Frontend). It has to be done
// on the DOM node by hand: the checkbox is bound with `:checked`, so after a failed
// click the binding's value is UNCHANGED (still `false`) and Vue's patch — which
// compares the new vnode prop against the old one — has nothing to write. The user
// gesture would silently stand on screen while the server holds the opposite.
function snapBackHandover(friend, event) {
  const el = event?.target
  if (el) el.checked = isHandedOver(friend)
}

/** The live sub-order ids of a party — already filtered by the server. */
function liveGuestIds(friend) {
  return (friend.guest_orders || []).map((guest) => guest.id)
}

/**
 * Krok 2, for one bag.
 *
 * ⚠ TWO ROUTES, and which one is not a style choice. A friend with an own order is
 * one `PATCH /orders/:id/handed-over` and their guests INHERIT inside that
 * transaction. A SYNTHETIC host has no `orders` row to stamp, so their bag is the
 * set of their sub-orders: going out, that is the BULK route (one transaction, one
 * timestamp across every bag — the stamp module 21 groups its segments by); coming
 * back, it is the per-guest PATCH in sequence, because a bulk REVERSAL is Phase 2
 * by spec and deliberately not built.
 *
 * ⚠ Patch in place, THEN re-fetch (loadSeq): the response is enough for the row
 * and its mirrors, but `plan[]`, `totals` and the „Podľa stavu" grouping are the
 * server's.
 */
async function toggleHandover(friend, event) {
  const wanted = !!event?.target?.checked
  const key = String(friend.id)
  if (isPartyPending(friend)) {
    snapBackHandover(friend, event)
    return
  }

  setPartyPending(key, true)
  setRowError(key, '')
  try {
    if (friend.order_id) {
      const result = await api.setOrderHandedOver(friend.order_id, wanted)
      friend.handed_over_at = result?.order?.handed_over_at ?? null
      friend.stage = result?.order?.stage || friend.stage
      const byId = new Map((result?.guests || []).map((guest) => [guest.id, guest]))
      for (const guest of friend.guest_orders || []) {
        const patched = byId.get(guest.id)
        if (!patched) continue
        guest.handed_over_at = patched.handed_over_at
        guest.stage = patched.stage
      }
    } else if (wanted) {
      await api.handOverDistributionBatch(cycleId, [], liveGuestIds(friend))
    } else {
      for (const guestId of liveGuestIds(friend)) {
        await api.setGuestOrderHandedOver(guestId, false)
      }
    }
    await loadData()
  } catch (e) {
    // The SERVER's sentence, inline on the row that refused („Najprv označte
    // balíček ako zabalený" for 409 `not_packed`) — never a client-side guess at
    // which rule was hit.
    setRowError(key, e.message)
    snapBackHandover(friend, event)
    await loadData()
  } finally {
    setPartyPending(key, false)
  }
}

// ── DP-T7 (16 §UC-DP-012): the group hand-over ──────────────────────────────
//
// „Odovzdať zabalené (n)" — rendered and counted by DP-T5, wired here: a radix
// confirm, ONE bulk POST, an in-place patch, a re-fetch and a 3.5 s toast; a
// refusal closes the modal, says one sentence on the group that refused, and
// highlights the rows the SERVER named.
//
// ⚠ What is deliberately NOT here:
//   • the modal's WhatsApp sentence and the „· n správ zaradených" half of the
//     toast — module 21's (resolved conflict 3). `queued_notifications` IS read
//     off the response (it has to be, it is in the body) and DROPPED.
//   • a bulk REVERSAL. Phase 2 by spec; the per-bag route is the only way back.

/**
 * ⚠⚠ WHICH IDENTIFIERS GO ON THE WIRE — the one decision this row had to make,
 * and DP-T4 recorded the reason it is not „everything I can see":
 *
 *   an EXPLICITLY listed guest with one unchecked item aborts the whole batch,
 *   while the SAME bag merely INHERITED from its host sails through, because
 *   §UC-DP-004 puts no pack gate on inheritance.
 *
 * So a group sends PARTY identifiers:
 *   • a friend party  → its `order_id`; its nested `via_host` guests are left to
 *                       inherit inside the route's own transaction,
 *   • a SYNTHETIC host → the live ids of its sub-orders, because that IS its bag
 *                       (there is no `orders` row to stamp).
 * Sending A's nested guest alongside A's order would buy nothing and could turn a
 * batch that must succeed into a 409 over a bag that travels inside another one.
 *
 * ⚠ Module-20 seam: when GP-T6 emits a Packeta guest as its OWN party, it arrives
 * here as a party with no `order_id` and its own sub-order in `guest_orders[]` —
 * i.e. the synthetic-host branch already sends it, with no new case.
 */
function groupBatch(group) {
  const orderIds = []
  const guestOrderIds = []
  const partyIds = []
  for (const party of group.parties) {
    // `stage === 'packed'` ONLY — the same rule `groupReadyCount()` counts by, so
    // the button's number and the batch can never disagree. A `handed` party is
    // done, not ready.
    if ((party.stage || 'to_pack') !== 'packed') continue
    partyIds.push(party.id)
    if (party.order_id) orderIds.push(party.order_id)
    else guestOrderIds.push(...liveGuestIds(party))
  }
  return { orderIds, guestOrderIds, partyIds }
}

// ⚠ PER GROUP, NEVER ONE GLOBAL FLAG (DP-T5 named this as the trap). Two drops can
// be recorded from two group buttons in the same breath, and a shared flag would
// swallow the second — the same discipline `pendingParties` / `pendingItems` keep.
const pendingGroups = ref({})
// The refusal's sentence, on the group that refused. Also per group: a banner at
// the top of the board would blame a drop the admin never touched.
const groupErrors = ref({})
// The parties the server NAMED in its 409 — `{ [groupKey]: { [partyId]: true } }`.
//
// ⚠⚠ THE MESSAGE AND ITS HIGHLIGHTS SHARE A SCOPE, and that is the whole point.
// This map used to be FLAT while the sentences were per group, so opening any
// group's dialog wiped EVERY group's highlights while clearing only its own
// sentence — leaving another group's Alert standing with nothing to point at. The
// clearing path then early-returned on the missing highlight, so that sentence
// became UNCLEARABLE short of a reload, and worst exactly where it hurts: when the
// offender was that group's last packed bag its button sits at 0 and disabled, so
// even re-opening the dialog was gone. The same stale-advice failure this code
// exists to prevent, one scope up. (Review finding, DP-T7.)
//
// The invariant it buys, and the one to keep: **a group Alert always has at least
// one highlighted row** — which is what makes it clearable by packing that bag.
// `confirmHandover` enforces the other half: a refusal that names nothing this
// board can resolve falls back to the page-level banner instead of minting a
// group sentence with no rows under it.
const refusedParties = ref({})

function isGroupPending(key) {
  return !!pendingGroups.value[String(key)]
}

function setGroupPending(key, value) {
  const next = { ...pendingGroups.value }
  if (value) next[String(key)] = true
  else delete next[String(key)]
  pendingGroups.value = next
}

function groupError(group) {
  return groupErrors.value[String(group.key)] || ''
}

function setGroupError(key, message) {
  const next = { ...groupErrors.value }
  if (message) next[String(key)] = message
  else delete next[String(key)]
  groupErrors.value = next
}

function isRefused(friend) {
  const id = String(friend.id)
  return Object.values(refusedParties.value).some((named) => named[id])
}

/** One group's refusal, message and highlights together — never one without the other. */
function clearGroupRefusal(key) {
  const k = String(key)
  if (refusedParties.value[k]) {
    const next = { ...refusedParties.value }
    delete next[k]
    refusedParties.value = next
  }
  setGroupError(k, '')
}

/**
 * The refusal is ADVICE („some bags are no longer packed"), and the moment the
 * admin acts on it the sentence is false — DP-T6's stale-refusal lesson, applied
 * without re-learning it. Packing a named bag drops its highlight, and a group
 * whose last highlight goes drops its sentence with it: the sentence is only true
 * while it has rows to point at.
 *
 * ⚠ Deliberately NOT cleared in `loadData()`: that runs on the FAILURE path too
 * (right after the refusal is written) and would wipe the message in the same tick.
 */
function clearRefusal(friendId) {
  const id = String(friendId)
  const next = {}
  let touched = false
  for (const [key, named] of Object.entries(refusedParties.value)) {
    if (!named[id]) {
      next[key] = named
      continue
    }
    touched = true
    const rest = { ...named }
    delete rest[id]
    if (Object.keys(rest).length > 0) next[key] = rest
    else setGroupError(key, '')
  }
  if (!touched) return
  refusedParties.value = next
}

const HANDOVER_TOAST_MS = 3500
const handoverToast = ref('')
// ⚠ A plain `let` inside `<script setup>` is PER INSTANCE, which is what a timer
// must be — the module-scope note in CLAUDE.md is about singletons, and a toast
// timer shared between two mounted boards would cancel the wrong one.
let toastTimer = null

function showHandoverToast(text) {
  handoverToast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    handoverToast.value = ''
    toastTimer = null
  }, HANDOVER_TOAST_MS)
}

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = null
})

// ⚠ A SNAPSHOT, taken when the modal OPENS. The subtitle promises a count, and the
// confirm must post exactly the bags that count described — §UC-DP-012's own
// acceptance is the stale case (un-pack one behind the screen's back between open
// and confirm ⇒ the Alert, and nothing written). Recomputing at confirm time would
// quietly hand over a different set than the one the admin agreed to.
//
// ⚠⚠ ONE REF FOR THE WHOLE BOARD, AND IT IS SAFE ONLY BECAUSE THE MODAL IS
// UNDISMISSABLE WHILE ITS BATCH IS IN FLIGHT. The two decisions hold each other
// up: `closeHandoverDialog()` refuses while the group is pending, and
// `confirmHandover()` ends by setting this ref to `null` — so there can never be
// a SECOND group's dialog open when the first group's request completes. Let the
// admin dismiss the modal mid-post and a completing batch would blank the dialog
// they opened next, cancelling a hand-over they had already agreed to. Anything
// that relaxes the dismissal rule must key the dialog per group first.
const handoverDialog = ref(null)

function openHandoverDialog(group) {
  if (isGroupPending(group.key)) return
  const ready = groupReadyCount(group)
  if (ready === 0) return
  const batch = groupBatch(group)
  // ⚠ THIS GROUP's refusal only. Wiping every group's highlights here is exactly
  // the bug the `refusedParties` note above records — another drop's sentence
  // must survive an unrelated group's dialog, or it survives with nothing under it.
  clearGroupRefusal(group.key)
  handoverDialog.value = { key: group.key, title: group.title, ready, ...batch }
}

function closeHandoverDialog() {
  // The modal stays up while the batch is in flight: closing it mid-request would
  // hide the only pending affordance and invite a second click on the group button.
  if (handoverDialog.value && isGroupPending(handoverDialog.value.key)) return
  handoverDialog.value = null
}

const handoverSubtitle = computed(() => {
  const snapshot = handoverDialog.value
  if (!snapshot) return ''
  const n = snapshot.ready
  return `${snapshot.title} · ${bagsLabel(n)} ${bagsMoveVerb(n)} do stavu Odovzdané.`
})

/**
 * PATCH IN PLACE, **THEN RE-FETCH** — the same two halves as `onPickupUpdated()`,
 * for the same two reasons: the patch keeps the admin's place (a reload would
 * re-collapse every guest fold in a long picking list), the re-fetch keeps the
 * board honest (`plan[]`, `totals` and the grouping are the server's).
 *
 * ⚠ Only the parties this call actually moved, and only bags with no stamp of
 * their own: DP-T4's response reports the BATCH stamp, while a colleague who
 * ordered after their host's bag went out keeps that BAG's older stamp. Painting
 * the batch stamp over everything would invent a string no row carries — which is
 * exactly why the re-fetch immediately follows.
 */
function patchHandedOver(snapshot, result) {
  const stamp = result?.handed_over_at
  if (!stamp) return
  const ids = new Set(snapshot.partyIds)
  for (const party of distribution.value) {
    if (!ids.has(party.id)) continue
    if (!party.handed_over_at) {
      party.handed_over_at = stamp
      party.stage = 'handed'
    }
    for (const guest of party.guest_orders || []) {
      if (guest.handed_over_at) continue
      guest.handed_over_at = stamp
      guest.stage = 'handed'
    }
  }
}

/**
 * The 409 names offenders in THREE lists (`order_ids`, `guest_order_ids`,
 * `cancelled_guest_order_ids`) — DP-T4 listed cancelled bags separately on
 * purpose. The board works in PARTIES, so each named id is resolved back to the
 * row that owns it: an order id to its party, a sub-order id to the party whose
 * `guest_orders[]` holds it (which covers a synthetic host's own bags and a
 * nested guest alike).
 */
function markRefusedParties(key, err) {
  const orderIds = new Set((err.orderIds || []).map(Number))
  const guestIds = new Set([
    ...(err.guestOrderIds || []),
    ...(err.cancelledGuestOrderIds || []),
  ].map(Number))
  const named = {}
  let count = 0
  for (const party of distribution.value) {
    const hit = (party.order_id && orderIds.has(Number(party.order_id)))
      || (party.guest_orders || []).some((guest) => guestIds.has(Number(guest.id)))
    if (!hit) continue
    named[String(party.id)] = true
    count += 1
  }
  if (count > 0) refusedParties.value = { ...refusedParties.value, [String(key)]: named }
  // The caller decides where the sentence goes — see the invariant on
  // `refusedParties`: a group Alert with no rows under it cannot be cleared.
  return count
}

// §UC-DP-012 step 4 pins this sentence, and it says something the server cannot
// know (that the list was refreshed). Any OTHER refusal — a cancelled bag, a
// `foreign_id` — falls back to the SERVER's own words rather than a guess, the
// rule the per-row errors already follow.
function refusalSentence(err) {
  return err?.reason === 'not_packed'
    ? 'Niektoré balíčky už nie sú zabalené — zoznam bol obnovený.'
    : (err?.message || 'Odovzdanie sa nepodarilo')
}

async function confirmHandover() {
  const snapshot = handoverDialog.value
  if (!snapshot) return
  // ⚠ THE SECOND CLICK. The button is `disabled` while in flight — this is the
  // layer under it, because a second POST would be a second all-or-nothing batch
  // over the same bags.
  if (isGroupPending(snapshot.key)) return

  setGroupPending(snapshot.key, true)
  clearGroupRefusal(snapshot.key)
  try {
    const result = await api.handOverDistributionBatch(cycleId, snapshot.orderIds, snapshot.guestOrderIds)
    patchHandedOver(snapshot, result)
    handoverDialog.value = null
    // ⚠ The unit is the BAG, i.e. the PARTY — the same unit `bagsLabel`,
    // `plan[].count` and `totals.count` use, so a host and the guest bags inside
    // their parcel are ONE balíček. `handed_over` in the response counts ROWS
    // (a synthetic host's three sub-orders are three), which would read as three
    // balíčky for one drop. ⚠ `result.queued_notifications` is read and dropped:
    // module 21 owns the „· n správ zaradených" half of this sentence.
    showHandoverToast(`${bagsLabel(snapshot.ready)} ${handedAdjective(snapshot.ready)}`)
    await loadData()
  } catch (e) {
    handoverDialog.value = null
    // ⚠ THE INVARIANT: a group sentence only exists while it has rows to point at,
    // because those rows are what clear it. A refusal this board cannot resolve to
    // a party (a `foreign_id` on an id that left the cycle between load and
    // confirm — not reachable from the payload today, since DP-T2 emits only live
    // in-cycle bags) goes to the PAGE-level banner instead, which every row action
    // already clears.
    if (markRefusedParties(snapshot.key, e) > 0) {
      setGroupError(snapshot.key, refusalSentence(e))
    } else {
      error.value = refusalSentence(e)
    }
    // The server wrote nothing; the board says what it really holds.
    await loadData()
  } finally {
    setGroupPending(snapshot.key, false)
  }
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
              <!-- DP-T7: the confirm modal and the bulk POST. Still refuses to be
                   clickable at zero, and now also while ITS OWN batch is in
                   flight — never while another group's is. -->
              <Button
                size="sm"
                :disabled="groupReadyCount(group) === 0 || isGroupPending(group.key)"
                :data-testid="`handover-group-${group.key}`"
                @click="openHandoverDialog(group)"
              >
                Odovzdať zabalené ({{ groupReadyCount(group) }})
              </Button>
            </div>
          </div>

          <!-- The group's own refusal, on the group that refused (§UC-DP-012
               step 4). Not a page-level banner: a drop the admin never touched
               must not wear another drop's red line. -->
          <Alert
            v-if="groupError(group)"
            variant="destructive"
            class="print:hidden"
            :data-testid="`handover-alert-${group.key}`"
          >
            <AlertDescription class="text-sm">{{ groupError(group) }}</AlertDescription>
          </Alert>

          <div
            v-if="group.parties.length === 0"
            class="text-sm text-muted-foreground italic"
            :data-testid="`group-empty-${group.key}`"
          >
            Nič v tejto skupine.
          </div>

          <div v-else class="space-y-4">
        <!-- ⚠ ONE `div.p-4` PER PARTY, AND IT STAYS. Two shipped specs
             (`guest-distribution.spec.js`, `item-packed.spec.js`) locate a party
             as `div.p-4` containing the friend's heading, and `item-packed`
             additionally counts `div.cursor-pointer` inside it as the ITEM rows.
             So: `CardContent` keeps `p-4` and is the row's only padded wrapper,
             the row's own expand affordance is a `<button>` / `.row-expand` (never
             a second `div.cursor-pointer`), and the name stays an `<h3>` — DP-T5's
             group assertions locate it by role too. -->
        <Card
          v-for="friend in group.parties"
          :key="friend.id"
          :data-testid="`bag-row-${friend.id}`"
          :data-stage="friend.stage || 'to_pack'"
          :data-refused="isRefused(friend) ? 'true' : 'false'"
          :class="[
            'print:shadow-none print:border print:break-inside-avoid',
            friend.packed || isHandedOver(friend) ? 'opacity-50' : '',
            // §UC-DP-012 step 4: the rows the SERVER named in its 409, so the
            // admin knows which bag to go back to. `print:ring-0` — a highlight is
            // a screen tool, the sheet is the bags.
            isRefused(friend) ? 'ring-2 ring-destructive print:ring-0' : ''
          ]"
        >
          <CardContent class="p-4">
            <!-- ── the five columns ──────────────────────────────────────── -->
            <div class="flex flex-wrap items-start gap-x-4 gap-y-2">
              <!-- Kto -->
              <div class="flex items-start gap-2 min-w-0 flex-1 basis-48" :data-testid="`bag-who-${friend.id}`">
                <button
                  v-if="hasRowBody(friend)"
                  type="button"
                  :data-testid="`bag-row-toggle-${friend.id}`"
                  :aria-expanded="isRowExpanded(friend) ? 'true' : 'false'"
                  :title="isRowExpanded(friend) ? 'Skryť položky' : 'Zobraziť položky'"
                  @click="toggleRow(friend)"
                  class="shrink-0 mt-1 rounded p-0.5 text-muted-foreground hover:bg-muted/60 transition-colors print:hidden"
                >
                  <svg
                    class="w-4 h-4 transition-transform"
                    :class="{ 'rotate-90': isRowExpanded(friend) }"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <!-- The Kto cell itself toggles the row (§UC-DP-011). `.row-expand`
                     rather than Tailwind's `cursor-pointer`: see the note above. -->
                <div
                  class="min-w-0"
                  :class="hasRowBody(friend) ? 'row-expand select-none' : ''"
                  style="overflow-wrap: anywhere"
                  @click="toggleRow(friend)"
                >
                  <h3 class="text-lg font-semibold">{{ friend.name }}</h3>
                  <div class="flex items-center gap-1.5 flex-wrap mt-0.5">
                    <Badge
                      v-if="guestCount(friend) > 0"
                      variant="outline"
                      class="text-xs border-violet-400 text-violet-700 bg-violet-50"
                    >
                      +{{ guestsLabel(guestCount(friend)) }}
                    </Badge>
                    <!-- A host with no own order (§Edge Cases) is still the pickup
                         party, but has nothing of their own to pay for. -->
                    <Badge
                      v-if="friend.has_own_order === false"
                      variant="outline"
                      class="text-xs border-violet-400 text-violet-700 bg-violet-50"
                    >
                      Bez vlastnej objednávky
                    </Badge>
                    <span
                      v-if="handedExceptCount(friend) > 0"
                      class="text-xs text-amber-700"
                      :data-testid="`bag-handed-except-${friend.id}`"
                    >
                      odovzdané okrem {{ handedExceptCount(friend) }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Doručenie / obsah -->
              <div class="min-w-0 flex-1 basis-56" :data-testid="`bag-delivery-${friend.id}`">
                <div
                  class="text-sm text-muted-foreground"
                  :class="hasRowBody(friend) ? 'row-expand select-none' : ''"
                  style="overflow-wrap: anywhere"
                  @click="toggleRow(friend)"
                >
                  <!-- Packeta: the address AND the phone, because both are needed on
                       the parcel and on the label (§UC-DP-011). -->
                  <template v-if="friend.delivery?.type === 'packeta'">
                    📦 {{ friend.delivery.target_detail }}
                    <template v-if="friend.delivery.phone">
                      · <span class="font-mono" :data-testid="`bag-phone-${friend.id}`">{{ friend.delivery.phone }}</span>
                    </template>
                  </template>
                  <template v-else-if="friend.delivery?.type === 'in_person' && friend.delivery.target_detail">
                    {{ friend.delivery.target_detail }}
                  </template>
                  <template v-else>{{ contentLine(friend) }}</template>
                  <span v-if="!friend.packed && totalItemCount(friend) > 0" class="text-xs">
                    · {{ checkedCount(friend) }}/{{ totalItemCount(friend) }} ✓
                  </span>
                </div>
                <div class="flex items-center gap-2 flex-wrap mt-1">
                  <!-- ⚠ EDITABLE HERE TOO (PO decision, 2026-09-02) — this is the
                       screen the bags are packed from, so it is where a wrong pickup
                       point costs time. ⚠ `cycleId` + `friendId`, NEVER an order id
                       (the one-home rule, docs/learnings/06-pickup-point.md).
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
                </div>
              </div>

              <!-- Platba -->
              <div
                class="flex items-center gap-2 flex-wrap shrink-0 text-sm text-muted-foreground"
                :data-testid="`bag-pay-${friend.id}`"
              >
                <BalanceBadge :balance="friend.balance || 0" />
                <!-- A red „Nezapl." on a synthetic host's 0 EUR non-order would be a
                     lie — the shipped rule, kept. -->
                <template v-if="friend.has_own_order !== false">
                  <Badge v-if="friend.paid" variant="default" class="bg-green-600">Zaplat.</Badge>
                  <Badge v-else variant="destructive">Nezapl.</Badge>
                  <span>{{ formatPrice(friend.total) }}</span>
                </template>
              </div>

              <!-- Krok 1 „Zabalené" -->
              <div class="flex flex-col gap-1 shrink-0">
                <span class="text-[11px] uppercase tracking-wide text-muted-foreground print:hidden">Krok 1</span>
                <!-- No `orders` row ⇒ nowhere to store a whole-order packed flag, so
                     no button. Such a host's packing record is the per-bag checkboxes
                     below, and their Krok 1 is the DERIVED stage, read-only. -->
                <Button
                  v-if="friend.has_own_order !== false"
                  @click="togglePacked(friend)"
                  :variant="friend.packed ? 'default' : 'outline'"
                  :disabled="packingOrderId === friend.order_id || isHandedOver(friend) || (!friend.packed && !allItemsChecked(friend))"
                  :title="isHandedOver(friend) ? 'Najprv zrušte odovzdanie' : ''"
                  size="sm"
                  :data-testid="`packed-toggle-${friend.id}`"
                  :class="[
                    'print:hidden shrink-0',
                    friend.packed ? 'bg-green-600 hover:bg-green-700' : ''
                  ]"
                >
                  {{ packingOrderId === friend.order_id ? '...' : (friend.packed ? 'Zabalené' : 'Zabaliť') }}
                </Button>
                <label v-else class="inline-flex items-center gap-1.5 text-sm text-muted-foreground print:hidden">
                  <input
                    type="checkbox"
                    disabled
                    :checked="(friend.stage || 'to_pack') !== 'to_pack'"
                    :data-testid="`packed-mirror-${friend.id}`"
                    title="Zabalené sa označuje na jednotlivých vreckách"
                    class="w-4 h-4 accent-green-600"
                  />
                  Zabalené
                </label>
              </div>

              <!-- Krok 2 „Odovzdané" -->
              <div class="flex flex-col gap-1 shrink-0 print:hidden">
                <span class="text-[11px] uppercase tracking-wide text-muted-foreground">Krok 2</span>
                <label
                  class="inline-flex items-center gap-1.5 text-sm"
                  :class="canHandOver(friend) ? '' : 'opacity-40'"
                >
                  <input
                    type="checkbox"
                    :checked="isHandedOver(friend)"
                    :disabled="!canHandOver(friend)"
                    :title="handOverTitle(friend)"
                    :aria-busy="isPartyPending(friend)"
                    :data-testid="`handover-toggle-${friend.id}`"
                    @change="toggleHandover(friend, $event)"
                    class="w-4 h-4 accent-green-600"
                  />
                  Odovzdané
                </label>
              </div>
            </div>

            <!-- The row's own refusal, on the row that refused. -->
            <div
              v-if="rowError(friend)"
              class="mt-2 text-sm text-destructive print:hidden"
              :data-testid="`bag-row-error-${friend.id}`"
            >
              {{ rowError(friend) }}
            </div>

            <!-- ── nested `via_host` guest rows — READ-ONLY MIRRORS ────────
                 PO decision 2026-09-19: the API permits a per-guest correction
                 (§UC-DP-005), the board does not offer one. Their bag travels
                 inside the host's, so both steps are inherited state, never a
                 control: no button, and every checkbox `disabled`.
                 ⚠ Module-20 seam: a guest with its OWN `packeta_address` will not
                 arrive here at all — GP-T6 emits it as its own party, which the
                 row block above renders with no new branch. -->
            <div v-if="guestCount(friend) > 0" class="mt-2 pl-2 border-l-2 border-violet-200 flex flex-col gap-1">
              <div
                v-for="guest in friend.guest_orders"
                :key="`row-${guest.id}`"
                :data-testid="`guest-row-${guest.id}`"
                class="flex items-center gap-x-2.5 gap-y-1 flex-wrap text-sm"
              >
                <span class="font-medium min-w-0" style="overflow-wrap: anywhere">{{ guest.guest_name }}</span>
                <Badge variant="outline" class="text-xs border-violet-400 text-violet-700 bg-violet-50">hosť</Badge>
                <span class="text-xs text-muted-foreground">
                  v balíku hostiteľa · {{ (guest.items || []).length }} pol.
                </span>
                <Badge
                  v-if="guest.paid"
                  variant="outline"
                  class="text-xs border-green-400 text-green-700 bg-green-50"
                >
                  Zaplat.
                </Badge>
                <Badge v-else variant="outline" class="text-xs border-amber-400 text-amber-700 bg-amber-50">
                  Nezapl.
                </Badge>
                <label class="inline-flex items-center gap-1 text-xs text-muted-foreground print:hidden">
                  <input
                    type="checkbox"
                    disabled
                    :checked="(guest.stage || 'to_pack') !== 'to_pack'"
                    :data-testid="`packed-mirror-guest-${guest.id}`"
                    title="Zabalené sa označuje na jednotlivých vreckách"
                    class="w-3.5 h-3.5 accent-green-600"
                  />
                  Zabalené
                </label>
                <label class="inline-flex items-center gap-1 text-xs text-muted-foreground print:hidden">
                  <input
                    type="checkbox"
                    disabled
                    :checked="!!guest.handed_over_at"
                    :data-testid="`handover-toggle-guest-${guest.id}`"
                    title="Odovzdáva sa spolu s hostiteľom"
                    class="w-3.5 h-3.5 accent-green-600"
                  />
                  Odovzdané
                </label>
              </div>
            </div>

            <div v-if="!friend.packed && totalItemCount(friend) === 0" class="text-muted-foreground italic mt-3">
              Žiadne položky
            </div>
            <!-- ── the expandable body: the SHIPPED card body, verbatim ─────
                 Collapsed is `hidden print:block`, never a `v-if`: every row prints
                 expanded (CLAUDE.md §Frontend, §UC-DP-011 print rules). -->
            <div
              v-if="hasRowBody(friend)"
              :data-testid="`bag-row-body-${friend.id}`"
              class="mt-3"
              :class="isRowExpanded(friend) ? '' : 'hidden print:block'"
            >
              <!-- One block per group: the host's own items, then one per guest, so
                   the bags can be pre-separated during packing (§UC-GSO-011). -->
              <div class="flex flex-col gap-3">
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
                    :title="itemLocked(friend, group) ? 'Najprv zrušte odovzdanie' : ''"
                    class="flex items-center gap-2.5 border rounded-lg px-3 py-2.5 cursor-pointer transition-all select-none print:border-gray-300"
                    :class="[
                      isItemChecked(item)
                        ? 'bg-green-50 border-green-200 opacity-50 dark:bg-green-950/20 dark:border-green-800'
                        : 'bg-card border-border hover:border-muted-foreground/30',
                      isItemPending(group.kind, item) ? 'animate-pulse ring-2 ring-primary/40 print:ring-0 print:animate-none' : ''
                    ]"
                  >
                    <!-- ⚠ `disabled` on a bag that has already left (§UC-DP-007).
                         The class list above is untouched on purpose: `item-packed
                         .spec.js` counts these rows as `div.cursor-pointer`, and the
                         handler refuses the tap anyway. -->
                    <input
                      type="checkbox"
                      :checked="isItemChecked(item)"
                      :disabled="itemLocked(friend, group)"
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
            </div>

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

      <!-- ── DP-T7 (16 §UC-DP-012): the confirm ─────────────────────────────
           A radix `Dialog` — the admin skin's overlay primitive, which portals
           itself to `body`. Never a hand-rolled fixed div (CLAUDE.md §Frontend). -->
      <Dialog :open="!!handoverDialog" @update:open="$event ? null : closeHandoverDialog()">
        <!-- `print:hidden` — §UC-DP-011's print list names modals alongside the
             pickers and the toolbar: a confirmation printed over a picking sheet
             is a black box across the bags. ⚠ It covers the CONTENT box only; the
             radix OVERLAY is the shared primitive's own element and carries no
             print rule (`DialogContent.vue`, `bg-black/80 fixed inset-0`), so a
             sheet printed with ANY admin modal open still gets the dim layer.
             Recorded for the module closeout rather than patched here — it is one
             token in a shipped shared component that every admin view consumes,
             not a board-row change. -->
        <DialogContent class="max-w-md print:hidden" data-testid="handover-dialog">
          <DialogHeader>
            <DialogTitle>Odovzdať zabalené?</DialogTitle>
            <DialogDescription data-testid="handover-subtitle">
              {{ handoverSubtitle }}
            </DialogDescription>
          </DialogHeader>

          <!-- ⚠ THE BANNER MAKES A CLAIM ABOUT MONEY, and the claim is true by
               construction: `helpers/packing.js` is the one ledger moment and a
               hand-over writes no `transactions` row in either direction
               (§UC-DP-004/006, pinned from both sides in e2e). ⚠ The prototype's
               second sentence — the WhatsApp one — is module 21's by resolved
               conflict 3 and is deliberately absent. -->
          <div
            class="rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
            data-testid="handover-ledger-note"
          >
            Hostia v balíku hostiteľa sa označia spolu s ním.
            Peniaze sa nemenia — účtovanie prebehlo pri zabalení.
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              data-testid="handover-cancel"
              :disabled="handoverDialog ? isGroupPending(handoverDialog.key) : false"
              @click="closeHandoverDialog"
            >
              Zrušiť
            </Button>
            <Button
              data-testid="handover-confirm"
              :disabled="handoverDialog ? isGroupPending(handoverDialog.key) : false"
              @click="confirmHandover"
            >
              {{ handoverDialog && isGroupPending(handoverDialog.key) ? 'Odovzdávam…' : 'Áno, odovzdané' }}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>

    <!-- The toast. `Teleport` rather than a fixed div in the tree: the sanctioned
         escape hatch (CLAUDE.md §Frontend), so no ancestor's stacking context can
         park it behind the board. Screen-only, like every other control here. -->
    <Teleport to="body">
      <div
        v-if="handoverToast"
        data-testid="handover-toast"
        role="status"
        aria-live="polite"
        class="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-lg print:hidden"
      >
        {{ handoverToast }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ⚠ NOT Tailwind's `cursor-pointer`, and that is the whole point. The board's
   ITEM rows are located as `div.cursor-pointer` by two shipped specs
   (`item-packed.spec.js` counts them, `guest-distribution.spec.js` clicks them),
   so a row's own expand affordance must not join that family — a second `div
   .cursor-pointer` inside a party would change a count nobody expects to move.
   Same rule as the `div.p-4` note in the template. */
.row-expand {
  cursor: pointer;
}
/* ⚠ `select-none` rides ALONGSIDE it in the template (Tailwind's, the same class
   the item rows carry): without it, clicking a name to expand the row drags a
   text selection across the cell. It is bound with `.row-expand`, so a row with
   nothing to expand keeps its name selectable. */
</style>

<style>
@media print {
  body {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
}
</style>
