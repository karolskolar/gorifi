<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import BalanceBadge from '@/components/BalanceBadge.vue'
import GuestLinkRowControls from '@/components/GuestLinkRowControls.vue'
import PickupLocationPicker from '@/components/PickupLocationPicker.vue'

const route = useRoute()
const router = useRouter()

const cycle = ref(null)
const products = ref([])
const orders = ref([])
const summary = ref(null)

const loading = ref(true)
const activeTab = ref('products')
const error = ref('')

// Product modal
const showProductModal = ref(false)
// Save errors render inside the product dialog (the module-11 modalError
// lesson — the page Alert is hidden behind the radix overlay).
const productModalError = ref('')
const editingProduct = ref(null)
const productForm = ref({
  name: '', description1: '', description2: '', roast_type: '', purpose: '', price_150g: '', price_200g: '', price_250g: '', price_500g: '', price_1kg: '', price_20pc5g: '', price_8pc12g: '', image: '', roastery: '', stock_limit_g: ''
})
const imagePreview = ref(null)
const isDragging = ref(false)

// Roasteries
const roasteries = ref([])

// Drag & drop for product list
const dragOverProductId = ref(null)
const droppingProductId = ref(null)

// (The per-cycle import UI retired in PC-T8 — 12 §UC-PC-013. Products enter a
// cycle via the catalog picker at cycle creation or the manual "+ Pridať
// produkt" dialog below; sheet imports live in /admin/catalog.)

// Summary roastery filter
const summaryRoasteryFilter = ref('')  // '' = all, '_default' = no roastery, or roastery name

// Markup ratio
const markupPercent = ref(0)
const markupSaving = ref(false)

// Parcel delivery
const parcelEnabled = ref(false)
const parcelFee = ref(0)
const parcelSaving = ref(false)

// Expected date
const expectedDate = ref('')
const expectedDateSaving = ref(false)

// Plan note
const planNote = ref('')
const planNoteSaving = ref(false)

// Cycle name editing
const editingCycleName = ref(false)
const cycleNameEdit = ref('')

const cycleId = computed(() => route.params.id)

// Expandable orders
const expandedOrders = ref(new Set())

function toggleExpand(orderId) {
  if (expandedOrders.value.has(orderId)) {
    expandedOrders.value.delete(orderId)
  } else {
    expandedOrders.value.add(orderId)
  }
  expandedOrders.value = new Set(expandedOrders.value) // trigger reactivity
}

// Guest sub-orders expand independently of their host's own order (§UC-GSO-009):
// a host can have several colleagues under them and the admin checks one bag list
// at a time. Keyed by `guest_orders.id`, a SEPARATE sequence from `orders.id` —
// the same reason Distribution.vue namespaces its pending keys `own:` / `guest:`.
const expandedGuestOrders = ref(new Set())

function toggleExpandGuest(guestOrderId) {
  if (expandedGuestOrders.value.has(guestOrderId)) {
    expandedGuestOrders.value.delete(guestOrderId)
  } else {
    expandedGuestOrders.value.add(guestOrderId)
  }
  expandedGuestOrders.value = new Set(expandedGuestOrders.value) // trigger reactivity
}

// Counts LINES, not pieces — it labels a list the admin is about to expand, and
// that list has one row per line. A piece count would promise rows that are not there.
function guestItemCountLabel(sub) {
  const n = (sub.items || []).length
  if (n === 1) return '1 položka'
  if (n >= 2 && n <= 4) return `${n} položky`
  return `${n} položiek`
}

// The purpose badge colours, shared by the host's own item list and the nested
// guest one so a bag reads identically wherever it is shown.
function purposeBadgeClass(purpose) {
  return {
    'border-stone-400 text-stone-600 bg-stone-50': purpose === 'Espresso',
    'border-sky-400 text-sky-600 bg-sky-50': purpose === 'Filter',
    'border-amber-400 text-amber-600 bg-amber-50': purpose === 'Kapsule' || purpose === 'Slané',
    'border-pink-400 text-pink-600 bg-pink-50': purpose === 'Sladké'
  }
}

function itemVariantLabel(item) {
  if (item.variant_label) return item.variant_label
  return item.variant === 'unit' ? 'ks' : item.variant
}

const isBakery = computed(() => cycle.value?.type === 'bakery')

const ordersView = ref('friend') // 'friend' or 'product'
const expandedProducts = ref(new Set())

function toggleExpandProduct(key) {
  if (expandedProducts.value.has(key)) {
    expandedProducts.value.delete(key)
  } else {
    expandedProducts.value.add(key)
  }
  expandedProducts.value = new Set(expandedProducts.value)
}

// A host whose colleagues ordered is listed even when they ordered NOTHING
// themselves (§Edge Cases: "host has no own order at lock time") — otherwise the
// guest sub-orders nested under them, and the money owed for them, would be
// invisible on this screen. Such a row contributes 0 to every total below.
const listedOrders = computed(() => orders.value.filter(
  o => o.status === 'submitted' || o.status === 'draft' || (o.guest_orders && o.guest_orders.length > 0)
))

// ⚠ THE ONE PREDICATE FOR EVERY FIGURE IN THIS TAB (product decision, 2026-08-26).
// A `draft` is a cart the friend saved and never submitted — reachable in normal
// use, because `doSubmitOrder()` PUTs the cart (which get-or-creates the row as
// 'draft', orders.js) and only then submits, so any failed submit leaves one behind.
// It is LISTED, so the admin can see a cart exists (the "Rozpracované" badge), but it
// contributes to NOTHING on this screen — same as a friend who never ordered. What
// people have in their carts gets its own view later; it is never mixed into the
// figures for what was ordered.
//
// This is the same predicate as `helpers/stock.js` (`o.status = 'submitted'`), the
// Sumár sheet (`cycles.js`) and "Podľa produktu" above. All four now agree.
function isOrdered(order) {
  return order.status === 'submitted'
}

// The heading count: parties who actually ordered something — a submitted own order,
// or live guest bags (a host with no own order is still a party, §Edge Cases). A
// draft-only row is listed but not counted, because it is not an order.
const orderedPartiesCount = computed(() => listedOrders.value.filter(
  (o) => isOrdered(o) || (o.guest_orders || []).some((sub) => !isGuestCancelled(sub))
).length)

// Group by product: { productKey: { product_name, purpose, variant, total_quantity, total_price, buyers: [{ name, is_guest, host_name, quantity, price }] } }
//
// ⚠ THE GUEST HALF IS NOT OPTIONAL, and leaving it out was a real reported bug.
// `helpers/stock.js` counts guest bags against `products.stock_limit_g`, so while
// this sheet listed friend items only it showed FEWER kilos than the friend-facing
// "Zostáva … z …" bar had already subtracted — 1 ks here against 0.5 kg claimed,
// which reads as a broken counter rather than a missing half. The Sumár tab's
// ordering sheet (GET /api/cycles/:id/summary) merges the two server-side for the
// same reason (§UC-GSO-013, Decision 4: cycle-LEVEL quantities include guests);
// this view is the client-side twin of that rule and must stay in step with it.
//
// Merged into the SAME `product_id|variant` line as the friend items, exactly as
// the server-side sheet does — a guest's 250 g of X is not a separate product.
// Decision 4's other half still holds: this is a quantity aggregate, not a
// per-friend one, so a guest appearing here inflates no count of friends
// (`orderedPartiesCount`, the balances and the friend view are untouched).
const ordersByProduct = computed(() => {
  const map = {}

  function addLine(item, buyer) {
    const key = `${item.product_id}-${item.variant}`
    if (!map[key]) {
      map[key] = {
        key,
        product_name: item.product_name,
        variant_label: item.variant_label || null,
        purpose: item.purpose,
        variant: item.variant,
        total_quantity: 0,
        total_price: 0,
        buyers: []
      }
    }
    map[key].total_quantity += item.quantity
    map[key].total_price += item.price * item.quantity
    map[key].buyers.push({
      ...buyer,
      quantity: item.quantity,
      price: item.price * item.quantity
    })
  }

  // ⚠ Iterates `orders` (every listed party), NOT `listedOrders`, and gates the
  // two halves separately — they answer different questions:
  //
  //   friend items — ONLY `status === 'submitted'`, the same predicate
  //     `helpers/stock.js` and the Sumár sheet (`cycles.js`, `o.status = 'submitted'`)
  //     use. A DRAFT is a cart nobody has ordered: it reserves no stock, so counting
  //     it here made this table report MORE than the friend-facing "Zostáva … kg" bar
  //     had subtracted — the same divergence as the missing guest half, in the other
  //     direction. Reachable without any bug: `PUT /api/orders/cycle/:id/friend/:id`
  //     get-or-creates the row with the schema default 'draft' (orders.js), so any
  //     client that saves a cart and never submits leaves one. `listedOrders` still
  //     carries drafts on purpose — they are LISTED as a status, never as a figure
  //     (see `isOrdered`).
  //
  //   guest bags — EVERY listed party's, whatever their own order status. A host with
  //     guest bags and no own order at all (`status: 'none'`) is the §Edge Cases case
  //     the API builds a synthetic row for, and their colleagues' bags still have to
  //     be bought (the GSO-T7 rule: such a host IS packable).
  for (const order of orders.value) {
    if (order.status === 'submitted') {
      for (const item of order.items || []) {
        addLine(item, { name: order.friend_name, is_guest: false })
      }
    }
    // Cancelled sub-orders are excluded — the same status predicate every backend
    // guest aggregate applies (their item rows are KEPT on purpose, so the filter
    // is the whole mechanism), via the shared nullable-status helper.
    for (const sub of order.guest_orders || []) {
      if (isGuestCancelled(sub)) continue
      for (const item of sub.items || []) {
        addLine(item, { name: sub.guest_name, is_guest: true, host_name: sub.host_name || order.friend_name })
      }
    }
  }

  // Sort buyers within each product by quantity desc
  const result = Object.values(map)
  for (const p of result) {
    p.buyers.sort((a, b) => b.quantity - a.quantity)
  }
  // Sort products by purpose then name
  result.sort((a, b) => {
    const purposeOrder = { 'Espresso': 1, 'Filter': 2, 'Kapsule': 3, 'Slané': 4, 'Sladké': 5 }
    const pa = purposeOrder[a.purpose] || 6
    const pb = purposeOrder[b.purpose] || 6
    if (pa !== pb) return pa - pb
    return a.product_name.localeCompare(b.product_name)
  })
  return result
})

// The "Podľa priateľa" footer AND which variant columns are shown. Built from the
// ORDERED rows only — a draft cart contributed both money and pieces here, which made
// this footer disagree with "Podľa produktu", the Sumár sheet and the stock counter
// all at once.
const orderTotals = computed(() => {
  const ordered = listedOrders.value.filter(isOrdered)
  return {
    count_150g: ordered.reduce((sum, o) => sum + (o.count_150g || 0), 0),
    count_200g: ordered.reduce((sum, o) => sum + (o.count_200g || 0), 0),
    count_250g: ordered.reduce((sum, o) => sum + (o.count_250g || 0), 0),
    count_500g: ordered.reduce((sum, o) => sum + (o.count_500g || 0), 0),
    count_1kg: ordered.reduce((sum, o) => sum + (o.count_1kg || 0), 0),
    count_20pc5g: ordered.reduce((sum, o) => sum + (o.count_20pc5g || 0), 0),
    count_8pc12g: ordered.reduce((sum, o) => sum + (o.count_8pc12g || 0), 0),
    count_unit: ordered.reduce((sum, o) => sum + (o.count_unit || 0), 0),
    total: ordered.reduce((sum, o) => sum + (o.total || 0), 0)
  }
})

// The "Podľa produktu" footer, derived from the lines the table actually renders.
// ⚠ It CANNOT reuse `orderTotals.total` any more: that sums `orders.total`, i.e.
// friends only, so once the guest bags joined the lines above the Ks column would
// have counted them and the Suma column would not — the two halves of one footer
// row disagreeing. Guests pay the admin directly (Decision 1), so this figure is
// "what this cycle is worth", not "what the friends owe"; the friend view's own
// footer still uses `orderTotals` and is unchanged.
// What the colleagues' sub-orders come to, across every host in the cycle.
//
// ⚠ THIS EXISTS BECAUSE THE PO ASKED "how can the dashboard say 1458.16 when this tab
// says 753.73?" — and the honest answer is that they were two different questions with
// one label. Measured on production: friends 753.73 + guests 704.43 = 1458.16, which is
// exactly the dashboard's roastery breakdown. Nothing was miscounted; the screen simply
// never said which half it was showing. So the friend footer now says "(priatelia)",
// this figure sits beside it, and the product footer — which has included guests since
// GR-T6 — says so out loud.
//
// Guests pay the ADMIN directly (Decision 1), which is why their money was never in the
// friend footer: that column is the friends' balance. Cancelled sub-orders are excluded
// by the same status predicate every other guest aggregate uses, and the sum is taken
// from the payload already on screen — no new request, no backend change.
const guestOrdersTotal = computed(() => {
  let total = 0
  for (const order of orders.value) {
    for (const sub of order.guest_orders || []) {
      if (isGuestCancelled(sub)) continue
      total += sub.total || 0
    }
  }
  return Math.round(total * 100) / 100
})

const productViewTotals = computed(() => ({
  quantity: ordersByProduct.value.reduce((sum, p) => sum + p.total_quantity, 0),
  total: ordersByProduct.value.reduce((sum, p) => sum + p.total_price, 0)
}))

const COFFEE_VARIANT_COLUMNS = [
  { label: '150g', countField: 'count_150g' },
  { label: '200g', countField: 'count_200g' },
  { label: '250g', countField: 'count_250g' },
  { label: '500g', countField: 'count_500g' },
  { label: '1kg',  countField: 'count_1kg' },
  { label: '20ks', countField: 'count_20pc5g' },
  { label: '8ks',  countField: 'count_8pc12g' },
]

const visibleVariantColumns = computed(() =>
  COFFEE_VARIANT_COLUMNS.filter(col => (orderTotals.value[col.countField] || 0) > 0)
)

onMounted(async () => {
  await loadAll()
})

// Set page title
watchEffect(() => {
  document.title = cycle.value?.name ? `${cycle.value.name} - Gorifi Admin` : 'Gorifi Admin'
})

async function loadAll() {
  loading.value = true
  try {
    const [cycleData, productsData, ordersData, summaryData, roasteriesData] = await Promise.all([
      api.getCycle(cycleId.value),
      api.getProducts(cycleId.value),
      api.getOrders(cycleId.value),
      api.getCycleSummary(cycleId.value),
      api.getRoasteries()
    ])
    cycle.value = cycleData
    products.value = productsData
    orders.value = ordersData
    summary.value = summaryData
    roasteries.value = roasteriesData
    // Initialize markup percentage from cycle data (ratio 1.19 = 19%)
    markupPercent.value = Math.round(((cycleData.markup_ratio || 1.0) - 1) * 100)
    // Initialize expected date
    expectedDate.value = cycleData.expected_date || ''
    planNote.value = cycleData.plan_note || ''
    parcelEnabled.value = !!cycleData.parcel_enabled
    parcelFee.value = cycleData.parcel_fee || 0
    // Same non-blocking contract, and it has to run AFTER `cycle.value` is set: the
    // listing is filtered by cycle type, exactly as the friend's own order form
    // filters it (`for_coffee` / `for_bakery`).
    await loadPickupLocations()
    // Non-blocking: the orders tab still renders (with the nested sub-orders that
    // came with `ordersData`) if only the money overview fails.
    await loadGuestUnpaid()
    // Same contract, same reason (§UC-GR-008): a failed link listing must not stop
    // the orders tab rendering. Both helpers swallow their own errors into an inline
    // message, so neither can reject and land in the catch below.
    await loadGuestLinks()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// ── Pickup point correction (PO decisions, 2026-09-02 and 2026-09-03) ────────
//
// `orders.pickup_location_id` / `_note` used to be write-once, set by the friend at
// submit time, so a wrong or since-changed place could not be fixed and the packing
// sheet disagreed with reality.
// `PATCH /api/orders/cycle/:cycleId/friend/:friendId/pickup` is the correction and
// `PickupLocationPicker.vue` owns the control (and its own pending/rollback state).
//
// ⚠ Keyed on (cycle, friend) rather than an order id, so it also reaches a party who
// has NO `orders` row — a host whose only stake is a colleague's bags, which is the
// case the PO reported. The server picks the store (`orders`, else the share link);
// see `backend/src/helpers/pickup.js`.
const pickupLocations = ref([])
const pickupLocationsError = ref('')

async function loadPickupLocations() {
  try {
    pickupLocations.value = await api.getPickupLocations(isBakery.value ? 'bakery' : 'coffee')
    pickupLocationsError.value = ''
  } catch (e) {
    // Reported inline: an empty listing and a failed load look identical on screen,
    // and "no pickup locations are configured" is the wrong conclusion to draw from a
    // network error — it would send the admin to Settings to re-create places that
    // already exist.
    pickupLocationsError.value = e.message
  }
}

// ⚠ EVERY LISTED ROW (PO decision, 2026-09-03: "za každých okolností"). The previous
// rule — submitted, non-Packeta, has an `orders` row — left three parties with no
// control at all, and the one the PO reported is the one that matters most on the
// picking sheet: a host who ordered nothing themselves while their unregistered
// colleague did. They collect the bags, and the screen said nothing about where.
//
// There is no state left to exclude: the route is keyed on (cycle, friend) and picks
// the store itself (`orders` if a row exists, else the share link), so a draft and a
// no-own-order host are both addressable, and a Packeta order switches behind the
// picker's own inline confirm. A row with neither store 404s — but such a party is not
// in `listedOrders` in the first place, so the control is never offered for one.
function canEditPickup(order) {
  return !!order.id || (order.guest_orders || []).length > 0
}

// Patched in place from the mutation response rather than reloading a 33-row table
// (the GSO-T1 per-row pattern). `order` is the reactive row object itself.
//
// ⚠ `cleared_parcel` has to be mirrored too, or the row keeps rendering the parcel it
// no longer has: the pill would still read red "Packeta" over the new location and the
// Suma column would still show "(… + fee doručenie)" for a fee the server just zeroed.
function onPickupUpdated(order, updated) {
  order.pickup_location_id = updated.pickup_location_id
  order.pickup_location_note = updated.pickup_location_note
  order.pickup_location_name = updated.pickup_location_name
  if (updated.cleared_parcel) {
    order.packeta_address = null
    order.delivery_fee = 0
  }
}

// Guest sub-orders, admin side (§UC-GSO-009..010) ----------------------------
//
// `paid` is the ADMIN's flag: this view is the only place it is written, and doing
// so creates NO balance transaction — guests pay the admin directly and have no
// balance account (Decision 1). `delivered` is the HOST's hand-over tick and is
// rendered read-only here (Decision 2), which is why no handler below touches it.

const guestUnpaid = ref({ unpaid: [], totals: { count: 0, total: 0 }, refunds: [], refund_totals: { count: 0, total: 0 } })
// Pending state is PER SUB-ORDER, so one slow request never blocks another row.
const guestPaidPending = ref({})
const guestUnpaidError = ref('')

// ⚠ SEQUENCE GUARD (the repo's `loadSeq` convention). `guestPaidPending` is per
// sub-order on purpose, so two rows can be toggled concurrently — and each toggle
// refetches this overview, so two responses can resolve out of order and leave a
// SUPERSEDED receivables list on screen. On a money screen that is a wrong answer,
// not a cosmetic flicker.
let unpaidSeq = 0

async function loadGuestUnpaid() {
  const seq = ++unpaidSeq
  try {
    const data = await api.getGuestUnpaid(cycleId.value)
    if (seq !== unpaidSeq) return
    guestUnpaid.value = data
    guestUnpaidError.value = ''
  } catch (e) {
    if (seq !== unpaidSeq) return
    // Reported inline next to the overview, never silently swallowed: an empty list
    // and a failed load look identical, and "nobody owes anything" is exactly the
    // wrong conclusion to draw from a network error.
    guestUnpaidError.value = e.message
  }
}

// The first name of the host who invited this guest — what the nested badge says
// ("Hosť • pozval Peťo"), so a sub-order is never mistaken for the host's own.
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || ''
}

function isGuestCancelled(subOrder) {
  return (subOrder.status || 'submitted') === 'cancelled'
}

async function toggleGuestPaid(subOrder) {
  const id = subOrder.id
  if (guestPaidPending.value[id]) return
  guestPaidPending.value = { ...guestPaidPending.value, [id]: true }
  const previous = { paid: subOrder.paid, paid_at: subOrder.paid_at }
  const next = subOrder.paid ? 0 : 1
  // Optimistic, so the toggle stays where it was clicked while the request runs.
  subOrder.paid = next
  try {
    const data = await api.markGuestOrderPaid(id, !!next)
    if (data.guest_order) {
      subOrder.paid = data.guest_order.paid
      subOrder.paid_at = data.guest_order.paid_at
    }
    // The overview is derived from the same flag, so it has to follow.
    await loadGuestUnpaid()
  } catch (e) {
    // A refused toggle must never leave the UI claiming money arrived.
    subOrder.paid = previous.paid
    subOrder.paid_at = previous.paid_at
    error.value = e.message
  } finally {
    const pending = { ...guestPaidPending.value }
    delete pending[id]
    guestPaidPending.value = pending
  }
}

// ── Module 14 §UC-GR-008 — links, resend, cancel on the orders tab ────────────
//
// The incident this closes: a guest's status URL died when her host regenerated
// their share link, and neither the host who invited her nor the admin who held
// her money could send it back. GR-T3/T4/T5 shipped the endpoints and published
// the column; this is the admin UI half.
//
// ⚠ NO TOKEN EVER REACHES THE DOM — not a `title`, not an `href`, not a `data-`
// attribute, not any bound value. Both URLs are composed in JS at click time and
// handed to the clipboard; the controls' hook is the row id. Publication
// (UC-GR-006) made the token READABLE by the admin; it did not make it
// RENDERABLE, and that distinction is the whole safety margin — a rendered token
// is a credential in every screenshot and every screen-share.
//
// ⚠ THE LINK LISTING IS ITS OWN REQUEST, joined to the order rows CLIENT-SIDE by
// `host_friend_id` (§UC-GR-004, decided there). The orders payload is built over a
// LEFT JOIN on `orders`; a second join for link data is the row-multiplying class
// the GSO-T6/T8 notes warn about, and it corrupts `orders_count` silently.

const guestLinks = ref([])
const guestLinksError = ref('')
// Per FRIEND row, so two rows can be created concurrently and a slow one never
// blocks or overwrites another (the `rowSeq` convention, GSO-T5).
const guestLinkPending = ref({})
const guestLinkErrors = ref({})
const guestLinkRowSeq = new Map()

// SEQUENCE GUARD (the repo's `loadSeq` convention), kept deliberately even though
// the race is NOT REACHABLE TODAY — stated plainly so nobody argues from a scenario
// that does not exist: this view has no watcher on `cycleId` and `loadAll()` runs
// only in `onMounted`, so exactly one listing request is ever in flight. It becomes
// load-bearing the moment either changes (a `cycleId` watcher, or a refetch hung off
// a mutation the way `toggleGuestPaid` refetches `loadGuestUnpaid`), and the failure
// it then prevents is the admin forwarding one cycle's ordering link as another's.
let guestLinksSeq = 0

async function loadGuestLinks() {
  const seq = ++guestLinksSeq
  try {
    const data = await api.getGuestLinksForCycle(cycleId.value)
    if (seq !== guestLinksSeq) return
    guestLinks.value = data.links || []
    guestLinksError.value = ''
  } catch (e) {
    if (seq !== guestLinksSeq) return
    // Reported, never swallowed: "this friend has no share link" and "the listing
    // failed" look identical on screen, and the first would make the admin create
    // a link that already exists.
    guestLinksError.value = e.message
  }
}

const guestLinkByHost = computed(() => {
  const map = new Map()
  for (const link of guestLinks.value) map.set(link.host_friend_id, link)
  return map
})

function hostLink(order) {
  return guestLinkByHost.value.get(order.friend_id) || null
}

// A link under a deactivated host 410s for every guest even while `active = 1`
// (routes/guest.js `resolveLink`), so the marker has to answer BOTH halves —
// otherwise the admin forwards a URL that is dead for a reason the row never said.
function isHostLinkDead(link) {
  return !link || !link.active || !link.host_active
}

async function createHostLink(order) {
  const friendId = order.friend_id
  if (!friendId || guestLinkPending.value[friendId]) return
  const seq = (guestLinkRowSeq.get(friendId) || 0) + 1
  guestLinkRowSeq.set(friendId, seq)
  guestLinkPending.value = { ...guestLinkPending.value, [friendId]: true }
  setRowMessage(guestLinkErrors, friendId, '')
  try {
    const data = await api.createGuestLinkForHost(cycleId.value, friendId)
    if (guestLinkRowSeq.get(friendId) !== seq) return
    // ⚠ `{ link, created }` — NOT the host POST's `{ link, regenerated, … }`. The
    // two shapes differ on purpose; nothing here may assume symmetry.
    if (!data.link) return
    guestLinks.value = [
      ...guestLinks.value.filter((l) => l.host_friend_id !== friendId),
      { ...data.link, host_name: order.friend_name, host_active: 1 },
    ]
  } catch (e) {
    if (guestLinkRowSeq.get(friendId) !== seq) return
    // ⚠ The 409 `inactive_host` path: the gate runs BEFORE the existing-link
    // lookup, so the body carries no `link` and this route is not a way to read a
    // deactivated host's token. Say why, on this row, and invent nothing.
    setRowMessage(guestLinkErrors, friendId, e.message)
  } finally {
    clearRowFlag(guestLinkPending, friendId)
  }
}

// ⚠ THE ADMIN REGENERATE (D3 as AMENDED — PO decision, 2026-08-31). The HOST's own
// regenerate now refuses while live colleague orders exist (409
// `reason:'has_orders'`) and their dialog says "kontaktujte správcu", so this control
// is that escalation target. Without it the host-side copy points at a dead end —
// the GSO-T5 mistake module 14 exists to remove.
//
// What it does and does not do, because the confirm copy below promises both:
//   · the OLD `/g/:token` stops taking NEW orders (`resolveLink` 404s it);
//   · every colleague order ALREADY placed keeps working — they resolve by
//     `order_token` alone (§UC-GR-001/002), which is what made amending D3 safe;
//   · `active` is NOT touched server-side, so a revoked link stays revoked. This is
//     not a back-door reactivate, and there is still no admin deactivate/reactivate.
//
// Per-row `rowSeq` + pending, the GSO-T5 convention — two rows may be regenerated
// concurrently and a superseded response must not land.
const guestLinkRegenConfirmId = ref(null)
const guestLinkRegenPending = ref({})
const guestLinkRegenRowSeq = new Map()

async function regenerateHostLink(order) {
  const friendId = order.friend_id
  if (!friendId || guestLinkRegenPending.value[friendId]) return
  const seq = (guestLinkRegenRowSeq.get(friendId) || 0) + 1
  guestLinkRegenRowSeq.set(friendId, seq)
  guestLinkRegenPending.value = { ...guestLinkRegenPending.value, [friendId]: true }
  setRowMessage(guestLinkErrors, friendId, '')
  try {
    const data = await api.regenerateGuestLinkForHost(cycleId.value, friendId)
    if (guestLinkRegenRowSeq.get(friendId) !== seq) return
    if (!data.link) return
    // Patched in place, preserving the joined columns the regenerate response does
    // not carry (`host_name` / `host_active` come from the LISTING's JOIN). Merging
    // over the existing row rather than rebuilding it is what keeps the "neaktívny"
    // marker truthful after a rotation — the server left `active` alone, so the row
    // must too.
    guestLinks.value = guestLinks.value.map((l) => (
      l.host_friend_id === friendId ? { ...l, ...data.link } : l
    ))
    guestLinkRegenConfirmId.value = null
  } catch (e) {
    if (guestLinkRegenRowSeq.get(friendId) !== seq) return
    setRowMessage(guestLinkErrors, friendId, e.message)
  } finally {
    clearRowFlag(guestLinkRegenPending, friendId)
  }
}

// ── "Hosťovské odkazy (všetci priatelia)" — the fold under the orders table ────
//
// THE GAP IT CLOSES (PO-approved, 2026-08-31). `listedOrders` above renders only
// friends who ordered, have a draft, or host guests. On the live September cycle that
// is 33 of 76 active friends — so for 43 friends the admin could neither SEE nor
// CREATE a share link, which is precisely the "lost the link before anyone used it"
// case §UC-GR-008 recorded as an accepted residual: a host who shared, ordered
// nothing himself, and whose colleagues have not ordered YET is invisible on the one
// screen that exists to make links reachable. One such friend on production already
// HAS a link the admin cannot see.
//
// ⚠ IT IS A FOLD, NOT A WIDER TABLE. Widening `listedOrders` was rejected by the PO:
// 76 rows of which 43 are empty would wreck the sheet the admin packs and orders
// from, and it would move `guest-admin-view.spec.js`'s row counts as a side effect.
//
// ⚠ NO NEW ENDPOINT AND NO NEW REQUEST. `GET /api/orders/cycle/:cycleId` already
// returns ONE ROW PER ACTIVE FRIEND (placeholder rows `status:'none'`,
// orders.js:634-660), and `guestLinks` already holds every link of the cycle. The
// fold is built from the two payloads that are already on screen — the same
// client-side join by `host_friend_id`, the same `guestLinkByHost` map.
//
// ⚠ IT RENDERS NO GUEST DATA AT ALL — no sub-orders, no `order_token`, no share
// token (§UC-GR-007's promoted DOM rule; pinned by a whole-document `outerHTML`
// assertion over the EXPANDED fold).
const allFriendsLinksOpen = ref(false)
const allFriendsLinksQuery = ref('')

// Diacritic-insensitive, because at 76 rows the admin types "Skolar" for "Školár"
// and a case-only match would answer "nobody by that name".
const foldNormalize = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

// Every ACTIVE friend, name-sorted. The payload lists ordered friends first and
// placeholders after, so the sort is what makes a 76-row list scannable.
// (`orders` carries exactly one row per active friend — real order or placeholder —
// so no de-duplication is needed; a deactivated friend is absent from the payload
// entirely, and so from this fold.)
const allFriendsRows = computed(() => orders.value
  .filter((o) => o.friend_id)
  .slice()
  .sort((a, b) => String(a.friend_name || '').localeCompare(String(b.friend_name || ''), 'sk')))

const allFriendsFiltered = computed(() => {
  const q = foldNormalize(allFriendsLinksQuery.value).trim()
  if (!q) return allFriendsRows.value
  return allFriendsRows.value.filter((o) => foldNormalize(o.friend_name).includes(q))
})

// Header counts — the answer to "who is still missing a link" without expanding.
const allFriendsLinkStats = computed(() => {
  let withLink = 0
  let dead = 0
  for (const o of allFriendsRows.value) {
    const link = guestLinkByHost.value.get(o.friend_id)
    if (!link) continue
    withLink++
    if (isHostLinkDead(link)) dead++
  }
  return { total: allFriendsRows.value.length, withLink, dead }
})

// ⚠ The fold's own state must not survive a cycle change. The view has no `cycleId`
// watcher today (`loadAll()` runs only in `onMounted`, see the `loadGuestLinks`
// note), so a future in-SPA cycle→cycle navigation would keep the fold open with a
// stale search term against another cycle's links. Reset only the LOCAL UI state —
// deliberately no refetch here, since adding one would change this view's shipped
// load behaviour.
watch(() => cycleId.value, () => {
  allFriendsLinksOpen.value = false
  allFriendsLinksQuery.value = ''
})

// Two independent copy flips (a friend row's ORDERING link, a sub-order row's
// per-guest STATUS link) — separate refs, so copying a share link never flashes
// "Skopírované!" on somebody's order row.
const copiedHostLinkId = ref(null)
const copiedSubOrderId = ref(null)
let copiedHostLinkTimer = null
let copiedSubOrderTimer = null

// The same try/catch semantics as the host-side control (02 §UC-DS-011):
// `navigator.clipboard` is undefined on a non-secure origin and `writeText` rejects
// when the document is not focused. In both cases the flip still happens — the UI
// must not strand at "Kopírovať" while the value did reach the clipboard.
function writeClipboard(text) {
  try {
    const written = navigator.clipboard?.writeText(text)
    if (written && typeof written.catch === 'function') written.catch(() => {})
  } catch (e) {
    // Clipboard API missing or blocked outright.
  }
}

function copyHostLink(order) {
  const link = hostLink(order)
  if (!link) return
  // The ORDERING url — what the admin forwards to a friend who lost theirs. A
  // different thing from the per-guest status URL below, and never confused with it.
  writeClipboard(`${window.location.origin}/g/${link.token}`)
  if (copiedHostLinkTimer) clearTimeout(copiedHostLinkTimer)
  copiedHostLinkId.value = order.friend_id
  copiedHostLinkTimer = setTimeout(() => {
    copiedHostLinkId.value = null
    copiedHostLinkTimer = null
  }, 2000)
}

function copySubOrderLink(subOrder) {
  if (!subOrder.order_token) {
    // Defensive: without the column this would copy a literal "/g/o/undefined" — a
    // plausible-looking dead URL, which is the exact failure this affordance exists
    // to prevent. Say so instead of handing one out.
    setRowMessage(guestRowErrors, subOrder.id, 'Odkaz na objednávku hosťa sa nepodarilo zostaviť.')
    return
  }
  // ⚠ CANONICAL FORM ONLY (`/g/o/:orderToken`, UC-GR-003). The legacy pair form
  // carries the very link half a regeneration retires — emitting a new one would
  // hand out a URL with the incident's failure already built in.
  writeClipboard(`${window.location.origin}/g/o/${subOrder.order_token}`)
  if (copiedSubOrderTimer) clearTimeout(copiedSubOrderTimer)
  copiedSubOrderId.value = subOrder.id
  copiedSubOrderTimer = setTimeout(() => {
    copiedSubOrderId.value = null
    copiedSubOrderTimer = null
  }, 2000)
}

// Cancelling a colleague's order is destructive and, since `cancelled` is terminal
// (GSO-T4), irreversible — so it asks first, per row.
const guestCancelConfirmId = ref(null)
const guestCancelPending = ref({})
// ONE error slot per sub-order row, shared by both of its controls — a failure
// belongs next to the row that produced it, never in a page-level banner that says
// nothing about which of twenty rows failed.
const guestRowErrors = ref({})
const guestCancelRowSeq = new Map()

function setRowMessage(bag, id, message) {
  const next = { ...bag.value }
  if (message) next[id] = message
  else delete next[id]
  bag.value = next
}

function clearRowFlag(bag, id) {
  const next = { ...bag.value }
  delete next[id]
  bag.value = next
}

async function cancelGuestOrder(subOrder) {
  const id = subOrder.id
  if (guestCancelPending.value[id]) return
  // ⚠ PER-ROW sequencing, not one shared counter. This is a money screen: with a
  // shared counter a request overtaken by another row's would discard its own
  // result, and the row would sit there claiming a live order the server has
  // already cancelled (or an error the admin never sees).
  const seq = (guestCancelRowSeq.get(id) || 0) + 1
  guestCancelRowSeq.set(id, seq)
  guestCancelPending.value = { ...guestCancelPending.value, [id]: true }
  setRowMessage(guestRowErrors, id, '')
  try {
    const data = await api.cancelGuestOrderAdmin(id)
    if (guestCancelRowSeq.get(id) !== seq) return
    // Patched in place from the response — no full reload, so the admin does not
    // lose their scroll position and every other row's state (the GSO-T1 rule).
    if (data.guest_order) {
      subOrder.status = data.guest_order.status
      subOrder.total = data.guest_order.total
    }
    // Only close OUR confirm: another row's may legitimately be open by now.
    if (guestCancelConfirmId.value === id) guestCancelConfirmId.value = null
    // Cancelling a PAID sub-order moves it into the refund queue (D4), so the money
    // overview has to follow.
    await loadGuestUnpaid()
  } catch (e) {
    if (guestCancelRowSeq.get(id) !== seq) return
    // A refused cancel is ALWAYS reported and NEVER shown as done — 409 `closed`
    // when the cycle locked between load and click. The confirm box stays open on
    // purpose (the GuestSubOrders precedent): the admin sees the refusal next to
    // the thing they asked for, and dismisses it themselves.
    setRowMessage(guestRowErrors, id, e.message)
  } finally {
    clearRowFlag(guestCancelPending, id)
  }
}

onBeforeUnmount(() => {
  if (copiedHostLinkTimer) clearTimeout(copiedHostLinkTimer)
  if (copiedSubOrderTimer) clearTimeout(copiedSubOrderTimer)
  copiedHostLinkTimer = null
  copiedSubOrderTimer = null
})

// Cycle actions
async function toggleLock() {
  const newStatus = cycle.value.status === 'locked' ? 'open' : 'locked'
  await api.updateCycle(cycleId.value, { status: newStatus })
  await loadAll()
}

async function markCompleted() {
  await api.updateCycle(cycleId.value, { status: 'completed' })
  await loadAll()
}

function startEditingCycleName() {
  cycleNameEdit.value = cycle.value?.name || ''
  editingCycleName.value = true
}

async function saveCycleName() {
  if (!cycleNameEdit.value.trim()) return
  try {
    await api.updateCycle(cycleId.value, { name: cycleNameEdit.value.trim() })
    await loadAll()
    editingCycleName.value = false
  } catch (e) {
    error.value = e.message
  }
}

function cancelEditingCycleName() {
  editingCycleName.value = false
  cycleNameEdit.value = ''
}

// ── Stock limit per cycle product (PM 2026-08-26) ──────────────────────────
// ⚠ REGRESSION FIX: `products.stock_limit_g` has always been enforced
// (helpers/stock.js gates every order, the friend card shows "Zostáva X z Y kg"),
// but its only editor was the manual product dialog — which the 2026-08-23 change
// made bakery-only, so a coffee cycle had NO way to set a limit. The limit is
// CYCLE-scoped (how much of THIS cycle's supply may be ordered), so it belongs
// here on the snapshot, not on the global catalog product.
// Pending is tracked PER ROW (the GSO-T5 rule): a superseded save must still
// revert and surface its own error, never share one flag.
const limitDraft = ref({})
const limitPending = ref({})
const limitError = ref({})

function limitValue(product) {
  const d = limitDraft.value[product.id]
  return d === undefined ? (product.stock_limit_g ?? '') : d
}

function onLimitInput(productId, value) {
  limitDraft.value = { ...limitDraft.value, [productId]: value }
}

async function saveLimit(product) {
  const raw = limitValue(product)
  const trimmed = String(raw).trim()
  // Empty clears the limit (NULL = unlimited) — the same meaning the column has.
  const grams = trimmed === '' ? null : Number(trimmed)
  if (grams !== null && (!Number.isFinite(grams) || grams < 0)) {
    limitError.value = { ...limitError.value, [product.id]: 'Zadajte počet gramov' }
    return
  }
  limitPending.value = { ...limitPending.value, [product.id]: true }
  limitError.value = { ...limitError.value, [product.id]: '' }
  try {
    await api.updateProduct(product.id, { stock_limit_g: grams === null ? null : Math.round(grams) })
    product.stock_limit_g = grams === null ? null : Math.round(grams)
    const { [product.id]: _drop, ...rest } = limitDraft.value
    limitDraft.value = rest
  } catch (e) {
    limitError.value = { ...limitError.value, [product.id]: e.message }
  } finally {
    const { [product.id]: _p, ...restP } = limitPending.value
    limitPending.value = restP
  }
}

// ── Friend-facing price check (PM 2026-08-23) ───────────────────────────────
// The snapshot price is the base; a friend pays base × markup_ratio. The formula
// is byte-identical to the ONE the friend page and the order endpoint use
// (FriendOrder.vue applyMarkup / helpers/pricing.js applyMarkup) — if it ever
// drifts, this control column stops being a control. `cycle` is reloaded by
// saveMarkup(), so these recompute the moment the markup is saved.
const markupRatioLive = computed(() => cycle.value?.markup_ratio || 1.0)
const markupIsNeutral = computed(() => Math.abs(markupRatioLive.value - 1) < 0.0001)
const friendPriceTitle = computed(() =>
  markupIsNeutral.value
    ? 'Prirážka nie je nastavená — priatelia platia rovnakú cenu'
    : `Cena pre priateľov (× ${markupRatioLive.value.toFixed(2)})`
)

function friendPrice(base) {
  if (base === null || base === undefined || base === '') return null
  const n = Number(base)
  if (!Number.isFinite(n) || n === 0) return null
  return Math.round(n * markupRatioLive.value * 100) / 100
}

function formatFriendPrice(base) {
  const p = friendPrice(base)
  return p === null ? null : p.toFixed(2)
}

// ── Catalog product picker, reopenable while the cycle is editable ──────────
const showCatalogPicker = ref(false)
const catalogAll = ref([])
const catalogSearch = ref('')
const catalogPicked = ref([])
const catalogLoading = ref(false)
const catalogSaving = ref(false)
const catalogError = ref('')
const catalogResult = ref(null)

// Editable = the admin can still change what the cycle offers (server enforces
// the same rule and 409s otherwise).
const cycleEditable = computed(() => ['open', 'planned'].includes(cycle.value?.status))

const catalogFiltered = computed(() => {
  const q = catalogSearch.value.trim().toLowerCase()
  if (!q) return catalogAll.value
  return catalogAll.value.filter(p => (p.name || '').toLowerCase().includes(q))
})

const catalogRemovedCount = computed(() => {
  const picked = new Set(catalogPicked.value)
  return products.value.filter(p => p.source_coffee_product_id && !picked.has(p.source_coffee_product_id)).length
})
const catalogAddedCount = computed(() => {
  const present = new Set(products.value.filter(p => p.source_coffee_product_id).map(p => p.source_coffee_product_id))
  return catalogPicked.value.filter(id => !present.has(id)).length
})

async function openCatalogPicker() {
  catalogError.value = ''
  catalogResult.value = null
  catalogSearch.value = ''
  // Pre-tick exactly what the cycle offers today (catalog-linked rows only).
  catalogPicked.value = products.value
    .filter(p => p.source_coffee_product_id)
    .map(p => p.source_coffee_product_id)
  showCatalogPicker.value = true
  catalogLoading.value = true
  try {
    const list = await api.getCatalogProducts({})
    const rows = Array.isArray(list) ? list : (list.products || [])
    // Offer available products PLUS anything already in this cycle (so a retired
    // product the cycle still carries can be seen and unticked, never silently dropped).
    const inCycle = new Set(catalogPicked.value)
    catalogAll.value = rows.filter(p => p.status !== 'retired' || inCycle.has(p.id))
  } catch (e) {
    catalogError.value = e.message
  } finally {
    catalogLoading.value = false
  }
}

function toggleCatalogPick(id) {
  const i = catalogPicked.value.indexOf(id)
  if (i === -1) catalogPicked.value.push(id)
  else catalogPicked.value.splice(i, 1)
}

async function saveCatalogPicker() {
  catalogSaving.value = true
  catalogError.value = ''
  try {
    const res = await api.setCycleCatalogProducts(cycleId.value, catalogPicked.value)
    catalogResult.value = res
    await loadAll()
    // Keep the dialog open ONLY when something needs saying (removed products
    // that friends had already ordered); otherwise close it.
    if (!res.removed_with_orders?.length) showCatalogPicker.value = false
  } catch (e) {
    catalogError.value = e.message
  } finally {
    catalogSaving.value = false
  }
}

async function saveMarkup() {
  markupSaving.value = true
  error.value = ''
  try {
    // Convert percentage to ratio (19% -> 1.19)
    const ratio = 1 + (markupPercent.value / 100)
    await api.updateCycle(cycleId.value, { markup_ratio: ratio })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    markupSaving.value = false
  }
}

async function saveParcel() {
  parcelSaving.value = true
  error.value = ''
  try {
    await api.updateCycle(cycleId.value, {
      parcel_enabled: parcelEnabled.value,
      parcel_fee: parcelEnabled.value ? parcelFee.value : 0
    })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    parcelSaving.value = false
  }
}

async function saveExpectedDate() {
  expectedDateSaving.value = true
  error.value = ''
  try {
    await api.updateCycle(cycleId.value, { expected_date: expectedDate.value || null })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    expectedDateSaving.value = false
  }
}

async function savePlanNote() {
  planNoteSaving.value = true
  error.value = ''
  try {
    await api.updateCycle(cycleId.value, { plan_note: planNote.value || null })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    planNoteSaving.value = false
  }
}

async function openPlannedCycle() {
  await api.updateCycle(cycleId.value, { status: 'open' })
  await loadAll()
}

// Product actions
function openProductModal(product = null) {
  editingProduct.value = product
  if (product) {
    productForm.value = {
      ...product,
      price_150g: product.price_150g || '',
      price_200g: product.price_200g || '',
      price_250g: product.price_250g || '',
      price_500g: product.price_500g || '',
      price_1kg: product.price_1kg || '',
      price_20pc5g: product.price_20pc5g || '',
      price_8pc12g: product.price_8pc12g || '',
      image: product.image || '',
      roastery: product.roastery || '',
      stock_limit_g: product.stock_limit_g || ''
    }
    imagePreview.value = product.image || null
  } else {
    productForm.value = { name: '', description1: '', description2: '', roast_type: '', purpose: '', price_150g: '', price_200g: '', price_250g: '', price_500g: '', price_1kg: '', price_20pc5g: '', price_8pc12g: '', image: '', roastery: '', stock_limit_g: '' }
    imagePreview.value = null
  }
  productModalError.value = ''
  showProductModal.value = true
}

async function saveProduct() {
  const data = {
    ...productForm.value,
    cycle_id: cycleId.value,
    price_150g: productForm.value.price_150g ? parseFloat(productForm.value.price_150g) : null,
    price_200g: productForm.value.price_200g ? parseFloat(productForm.value.price_200g) : null,
    price_250g: productForm.value.price_250g ? parseFloat(productForm.value.price_250g) : null,
    price_500g: productForm.value.price_500g ? parseFloat(productForm.value.price_500g) : null,
    price_1kg: productForm.value.price_1kg ? parseFloat(productForm.value.price_1kg) : null,
    price_20pc5g: productForm.value.price_20pc5g ? parseFloat(productForm.value.price_20pc5g) : null,
    price_8pc12g: productForm.value.price_8pc12g ? parseFloat(productForm.value.price_8pc12g) : null,
    image: productForm.value.image || null,
    roastery: productForm.value.roastery || null,
    stock_limit_g: productForm.value.stock_limit_g ? parseInt(productForm.value.stock_limit_g) : null
  }

  productModalError.value = ''
  try {
    if (editingProduct.value) {
      await api.updateProduct(editingProduct.value.id, data)
    } else {
      await api.createProduct(data)
    }
    showProductModal.value = false
    await loadAll()
  } catch (e) {
    // PC-T7 (review-assigned): surface save errors IN-DIALOG — notably PC-T3's
    // deliberate `duplicate_in_cycle` 409, which this function used to swallow.
    // The page-level Alert sits behind the radix overlay (the module-11
    // modalError lesson), so it must render inside the dialog.
    productModalError.value = e.message
  }
}

function duplicateProduct(product) {
  editingProduct.value = null
  productForm.value = {
    ...product,
    name: product.name + ' (kópia)',
    price_150g: product.price_150g || '',
    price_200g: product.price_200g || '',
    price_250g: product.price_250g || '',
    price_500g: product.price_500g || '',
    price_1kg: product.price_1kg || '',
    price_20pc5g: product.price_20pc5g || '',
    price_8pc12g: product.price_8pc12g || '',
    image: product.image || '',
    roastery: product.roastery || '',
    stock_limit_g: product.stock_limit_g || ''
  }
  imagePreview.value = product.image || null
  productModalError.value = ''
  showProductModal.value = true
}

async function deleteProduct(id) {
  if (!confirm('Naozaj vymazať tento produkt?')) return
  await api.deleteProduct(id)
  await loadAll()
}

// Image handling
function handleImageSelect(event) {
  const file = event.target.files[0]
  if (file) processImageFile(file)
}

function handleDrop(event) {
  event.preventDefault()
  isDragging.value = false
  const file = event.dataTransfer.files[0]
  if (file && file.type.startsWith('image/')) {
    processImageFile(file)
  }
}

function handleDragOver(event) {
  event.preventDefault()
  isDragging.value = true
}

function handleDragLeave() {
  isDragging.value = false
}

function processImageFile(file) {
  const reader = new FileReader()
  reader.onload = (e) => {
    productForm.value.image = e.target.result
    imagePreview.value = e.target.result
  }
  reader.readAsDataURL(file)
}

function removeImage() {
  productForm.value.image = ''
  imagePreview.value = null
}

// Drag & drop image from external webpage to product row
function handleProductDragOver(event, productId) {
  event.preventDefault()
  dragOverProductId.value = productId
}

function handleProductDragLeave(event, productId) {
  // Only clear if we're actually leaving the element (not entering a child)
  if (!event.currentTarget.contains(event.relatedTarget)) {
    dragOverProductId.value = null
  }
}

async function handleProductDrop(event, productId) {
  event.preventDefault()
  dragOverProductId.value = null

  // Try to get image URL from various drag data types
  let imageUrl = null

  // Check for URL in dataTransfer
  const url = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    imageUrl = url
  }

  // Check for HTML content (img tag)
  const html = event.dataTransfer.getData('text/html')
  if (!imageUrl && html) {
    const match = html.match(/src=["']([^"']+)["']/)
    if (match && match[1]) {
      imageUrl = match[1]
    }
  }

  // Check for files (local file drop)
  if (!imageUrl && event.dataTransfer.files.length > 0) {
    const file = event.dataTransfer.files[0]
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = async (e) => {
        droppingProductId.value = productId
        try {
          await api.updateProduct(productId, { image: e.target.result })
          await loadAll()
        } catch (err) {
          error.value = 'Chyba pri ukladaní obrázku: ' + err.message
        } finally {
          droppingProductId.value = null
        }
      }
      reader.readAsDataURL(file)
      return
    }
  }

  if (!imageUrl) {
    error.value = 'Nepodarilo sa získať URL obrázku. Skúste iný obrázok.'
    return
  }

  // Download image from URL via backend
  droppingProductId.value = productId
  try {
    await api.uploadProductImageFromUrl(productId, imageUrl)
    await loadAll()
  } catch (err) {
    error.value = 'Chyba pri sťahovaní obrázku: ' + err.message
  } finally {
    droppingProductId.value = null
  }
}

// Order actions
async function togglePaid(order) {
  await api.markPaid(order.id, !order.paid)
  await loadAll()
}

// Summary
async function loadSummaryForRoastery(roasteryFilter) {
  summaryRoasteryFilter.value = roasteryFilter
  try {
    summary.value = await api.getCycleSummary(cycleId.value, roasteryFilter || undefined)
  } catch (e) {
    error.value = e.message
  }
}

function copySummary() {
  if (!summary.value) return

  const roasteryLabel = summaryRoasteryFilter.value && summaryRoasteryFilter.value !== '_default'
    ? ` (${summaryRoasteryFilter.value})`
    : summaryRoasteryFilter.value === '_default' ? ' (hlavná pražiareň)' : ''
  let text = `Objednávka - ${cycle.value.name}${roasteryLabel}\n`
  text += '='.repeat(30) + '\n\n'

  // Group items by purpose
  const purposeOrder = ['Espresso', 'Filter', 'Kapsule']
  const grouped = {}

  for (const item of summary.value.items) {
    const purpose = item.purpose || 'Ostatné'
    if (!grouped[purpose]) grouped[purpose] = []
    grouped[purpose].push(item)
  }

  // Output items grouped by purpose
  const sortedPurposes = [...purposeOrder.filter(p => grouped[p]), ...Object.keys(grouped).filter(p => !purposeOrder.includes(p))]

  for (const purpose of sortedPurposes) {
    text += `--- ${purpose} ---\n`
    for (const item of grouped[purpose]) {
      const details = [item.description1, item.roast_type].filter(Boolean).join(', ')
      const nameWithDetails = details ? `${item.name} - ${details}` : item.name
      const variantDisplay = item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant)
      text += `${nameWithDetails} ${variantDisplay}: ${item.total_quantity}x\n`
    }
    text += '\n'
  }

  text += '='.repeat(30) + '\n'
  text += `Celkom položiek: ${summary.value.totalItems}\n`
  text += `Celková suma: ${summary.value.totalPrice.toFixed(2)} EUR\n`

  navigator.clipboard.writeText(text)
  alert('Sumár bol skopírovaný do schránky!')
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

function getStatusVariant(status) {
  switch (status) {
    case 'planned': return 'outline'
    case 'open': return 'default'
    case 'locked': return 'secondary'
    case 'completed': return 'outline'
    default: return 'outline'
  }
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex flex-wrap justify-between items-center gap-2">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="router.push('/admin/dashboard')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <div>
            <div v-if="editingCycleName" class="flex items-center gap-2">
              <input
                v-model="cycleNameEdit"
                @keyup.enter="saveCycleName"
                @keyup.escape="cancelEditingCycleName"
                class="text-xl font-bold bg-primary-foreground/20 text-primary-foreground border border-primary-foreground/30 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary-foreground/50"
                autofocus
              />
              <button @click="saveCycleName" class="text-primary-foreground/70 hover:text-primary-foreground">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
              </button>
              <button @click="cancelEditingCycleName" class="text-primary-foreground/70 hover:text-primary-foreground">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <h1 v-else class="text-xl font-bold flex items-center gap-2 cursor-pointer group" @click="startEditingCycleName">
              {{ cycle?.name || 'Načítavam...' }}
              <svg class="w-4 h-4 text-primary-foreground/50 group-hover:text-primary-foreground transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </h1>
            <Badge v-if="cycle" :variant="getStatusVariant(cycle.status)" class="mt-1 text-primary-foreground bg-primary-foreground/20 border-primary-foreground/30">
              {{ cycle.status === 'planned' ? 'Plánovaný' : cycle.status === 'open' ? 'Otvorený' : cycle.status === 'locked' ? 'Uzamknutý' : 'Dokončený' }}
            </Badge>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button
            v-if="cycle?.status === 'planned'"
            variant="secondary"
            size="sm"
            @click="openPlannedCycle"
            class="bg-green-600 hover:bg-green-700 text-white"
          >
            Otvoriť objednávanie
          </Button>
          <Button
            v-if="cycle?.status === 'open' || cycle?.status === 'locked'"
            variant="secondary"
            size="sm"
            @click="toggleLock"
          >
            {{ cycle?.status === 'locked' ? 'Odomknúť' : 'Uzamknúť' }}
          </Button>
          <Button
            v-if="cycle?.status === 'locked'"
            variant="secondary"
            size="sm"
            @click="markCompleted"
            class="bg-green-600 hover:bg-green-700 text-white"
          >
            Označiť ako dokončený
          </Button>
          <Button
            variant="secondary"
            size="sm"
            @click="router.push(`/admin/cycle/${cycleId}/distribution`)"
          >
            Distribúcia
          </Button>
        </div>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-6">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <template v-else>
        <Tabs v-model="activeTab">
        <TabsList class="mb-6">
          <TabsTrigger value="products">Produkty</TabsTrigger>
          <TabsTrigger value="orders">Objednávky</TabsTrigger>
          <TabsTrigger value="summary">Sumár</TabsTrigger>
        </TabsList>

        <!-- Products Tab -->
        <TabsContent value="products">
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-lg font-semibold">Produkty ({{ products.length }})</h2>
            <!-- PM 2026-08-23: coffee products are managed globally in Katalóg; this
                 cycle only decides WHICH of them it offers, and that must stay
                 changeable for as long as the cycle is editable. The old manual
                 "+ Pridať produkt" (and the per-row edit/duplicate/delete) is gone
                 for coffee — bakery keeps it until that module is retired. -->
            <Button v-if="!isBakery" :disabled="!cycleEditable" data-testid="cycle-catalog-picker-open" @click="openCatalogPicker()">
              Spravovať produkty z katalógu
            </Button>
            <Button v-else @click="openProductModal()">
              + Pridať produkt
            </Button>
          </div>

          <!-- Cycle settings -->
          <Card class="mb-4">
            <CardContent class="p-4 space-y-4">
              <!-- Expected date -->
              <div class="space-y-1">
                <Label class="text-sm font-medium">Očakávaný dátum objednávky:</Label>
                <div class="flex items-center gap-2">
                  <Input
                    v-model="expectedDate"
                    type="text"
                    placeholder="napr. 15. februára 2026"
                    class="flex-1"
                    :disabled="expectedDateSaving"
                  />
                  <Button
                    @click="saveExpectedDate"
                    :disabled="expectedDateSaving"
                    size="sm"
                  >
                    {{ expectedDateSaving ? 'Ukladám...' : 'Uložiť' }}
                  </Button>
                </div>
              </div>
              <!-- Plan note -->
              <div class="space-y-2">
                <Label>Plán objednávky</Label>
                <textarea
                  v-model="planNote"
                  placeholder="napr. 1. - 3. máj objednávanie&#10;4. - 5. máj dodávka"
                  rows="4"
                  class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                ></textarea>
                <Button size="sm" @click="savePlanNote" :disabled="planNoteSaving">
                  {{ planNoteSaving ? 'Ukladám...' : 'Uložiť plán' }}
                </Button>
              </div>
              <!-- Markup ratio -->
              <div class="space-y-1">
                <Label class="text-sm font-medium">Prirážka pre priateľov:</Label>
                <div class="flex items-center gap-2">
                  <Input
                    v-model.number="markupPercent"
                    data-testid="markup-input"
                    type="number"
                    step="1"
                    min="0"
                    max="100"
                    class="w-20 text-center"
                    :disabled="markupSaving"
                  />
                  <span class="text-muted-foreground">%</span>
                  <Button
                    @click="saveMarkup"
                    data-testid="markup-save"
                    :disabled="markupSaving"
                    size="sm"
                  >
                    {{ markupSaving ? 'Ukladám...' : 'Uložiť' }}
                  </Button>
                  <span v-if="cycle?.markup_ratio && cycle.markup_ratio !== 1.0" class="text-sm text-muted-foreground">
                    (cena × {{ cycle.markup_ratio.toFixed(2) }})
                  </span>
                </div>
              </div>
              <!-- Parcel delivery -->
              <div class="space-y-1">
                <Label class="text-sm font-medium">Doručenie Packetou:</Label>
                <div class="flex items-center gap-2">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" v-model="parcelEnabled" class="rounded" :disabled="parcelSaving" />
                    <span class="text-sm">Povoliť</span>
                  </label>
                  <template v-if="parcelEnabled">
                    <Input
                      v-model.number="parcelFee"
                      type="number"
                      step="0.5"
                      min="0"
                      class="w-24 text-center"
                      :disabled="parcelSaving"
                      placeholder="Cena"
                    />
                    <span class="text-muted-foreground">EUR</span>
                  </template>
                  <Button
                    @click="saveParcel"
                    :disabled="parcelSaving"
                    size="sm"
                  >
                    {{ parcelSaving ? 'Ukladám...' : 'Uložiť' }}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <!-- (Import section retired in PC-T8 — 12 §UC-PC-013: products enter a
               cycle via the catalog picker at creation; sheet imports live in
               /admin/catalog.) -->
          <!-- Price-check legend (PM 2026-08-23): the cycle price on top, what a
               friend actually sees underneath, so a wrong markup is visible at a glance. -->
          <div v-if="!isBakery" class="flex items-center gap-3 mb-2 text-xs text-muted-foreground" data-testid="price-legend">
            <span>V cenových stĺpcoch: <span class="font-medium text-foreground">cena cyklu</span> /
              <span :class="markupIsNeutral ? '' : 'text-violet-600 font-medium'">cena pre priateľov</span></span>
            <span v-if="markupIsNeutral" class="text-amber-700" data-testid="markup-neutral-hint">
              prirážka je 0 % — priatelia platia rovnaké ceny
            </span>
            <span v-else class="text-violet-600">× {{ markupRatioLive.toFixed(2) }}</span>
          </div>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-16">Foto</TableHead>
                  <TableHead>Názov</TableHead>
                  <template v-if="isBakery">
                    <TableHead>Kategória</TableHead>
                    <TableHead>Praženie</TableHead>
                    <TableHead class="text-right">Hmotnosť</TableHead>
                    <TableHead class="text-right">Cena/ks</TableHead>
                    <TableHead>Zloženie</TableHead>
                  </template>
                  <template v-else>
                    <TableHead>Chutový profil</TableHead>
                    <TableHead>Praženie</TableHead>
                    <TableHead>Účel</TableHead>
                    <TableHead class="text-right">150g</TableHead>
                    <TableHead class="text-right">200g</TableHead>
                    <TableHead class="text-right">250g</TableHead>
                    <TableHead class="text-right">500g</TableHead>
                    <TableHead class="text-right">1kg</TableHead>
                    <TableHead class="text-right">20ks×5g</TableHead>
                    <TableHead class="text-right">8ks×12g</TableHead>
                  </template>
                  <TableHead class="text-right">{{ isBakery ? 'Akcie' : 'Zdroj / limit zásob' }}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow
                  v-for="product in products"
                  :key="product.id"
                  :class="[
                    'transition-all duration-150',
                    dragOverProductId === product.id ? 'bg-accent ring-2 ring-primary ring-inset' : '',
                    droppingProductId === product.id ? 'opacity-50' : ''
                  ]"
                  @dragover="handleProductDragOver($event, product.id)"
                  @dragleave="handleProductDragLeave($event, product.id)"
                  @drop="handleProductDrop($event, product.id)"
                >
                  <TableCell>
                    <div :class="[
                      'w-12 h-12 rounded overflow-hidden flex items-center justify-center transition-all',
                      dragOverProductId === product.id ? 'ring-2 ring-primary bg-accent' : 'bg-muted'
                    ]">
                      <div v-if="droppingProductId === product.id" class="animate-pulse">
                        <svg class="w-6 h-6 text-primary animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      </div>
                      <img v-else-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                      <svg v-else class="w-6 h-6 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div class="flex items-center gap-2">
                      <span class="font-medium">{{ product.name }}</span>
                      <span v-if="product.roastery" class="text-xs bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">{{ product.roastery }}</span>
                      <span v-if="product.stock_limit_g" class="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">max {{ product.stock_limit_g >= 1000 ? (product.stock_limit_g / 1000) + ' kg' : product.stock_limit_g + 'g' }}</span>
                    </div>
                    <div v-if="product.description1" class="text-sm text-muted-foreground">{{ product.description1 }}</div>
                  </TableCell>
                  <template v-if="isBakery">
                    <TableCell class="text-sm">{{ product.purpose || '-' }}</TableCell>
                    <TableCell class="text-sm">{{ product.roast_type || '-' }}</TableCell>
                    <TableCell class="text-sm text-right">{{ product.weight_grams ? `${product.weight_grams}g` : '-' }}</TableCell>
                    <TableCell class="text-sm text-right">{{ formatPrice(product.price_unit) }}</TableCell>
                    <TableCell class="text-sm text-muted-foreground max-w-xs">
                      <span v-if="product.composition" class="line-clamp-1">{{ product.composition }}</span>
                      <span v-else>-</span>
                    </TableCell>
                  </template>
                  <template v-else>
                    <TableCell class="text-sm text-muted-foreground max-w-xs">
                      <span v-if="product.description2" class="line-clamp-2">{{ product.description2 }}</span>
                      <span v-else class="text-muted-foreground/50">-</span>
                    </TableCell>
                    <TableCell class="text-sm">{{ product.roast_type || '-' }}</TableCell>
                    <TableCell class="text-sm">{{ product.purpose || '-' }}</TableCell>
                    <TableCell class="text-sm text-right">
                      <div>{{ formatPrice(product.price_150g) }}</div>
                      <div v-if="formatFriendPrice(product.price_150g)"
                           class="text-xs mt-0.5"
                           :class="markupIsNeutral ? 'text-muted-foreground/60' : 'text-violet-600 font-medium'"
                           :title="friendPriceTitle"
                           data-testid="friend-price">
                        {{ formatFriendPrice(product.price_150g) }}
                      </div>
                    </TableCell>
                    <TableCell class="text-sm text-right">
                      <div>{{ formatPrice(product.price_200g) }}</div>
                      <div v-if="formatFriendPrice(product.price_200g)"
                           class="text-xs mt-0.5"
                           :class="markupIsNeutral ? 'text-muted-foreground/60' : 'text-violet-600 font-medium'"
                           :title="friendPriceTitle"
                           data-testid="friend-price">
                        {{ formatFriendPrice(product.price_200g) }}
                      </div>
                    </TableCell>
                    <TableCell class="text-sm text-right">
                      <div>{{ formatPrice(product.price_250g) }}</div>
                      <div v-if="formatFriendPrice(product.price_250g)"
                           class="text-xs mt-0.5"
                           :class="markupIsNeutral ? 'text-muted-foreground/60' : 'text-violet-600 font-medium'"
                           :title="friendPriceTitle"
                           data-testid="friend-price">
                        {{ formatFriendPrice(product.price_250g) }}
                      </div>
                    </TableCell>
                    <TableCell class="text-sm text-right">
                      <div>{{ formatPrice(product.price_500g) }}</div>
                      <div v-if="formatFriendPrice(product.price_500g)"
                           class="text-xs mt-0.5"
                           :class="markupIsNeutral ? 'text-muted-foreground/60' : 'text-violet-600 font-medium'"
                           :title="friendPriceTitle"
                           data-testid="friend-price">
                        {{ formatFriendPrice(product.price_500g) }}
                      </div>
                    </TableCell>
                    <TableCell class="text-sm text-right">
                      <div>{{ formatPrice(product.price_1kg) }}</div>
                      <div v-if="formatFriendPrice(product.price_1kg)"
                           class="text-xs mt-0.5"
                           :class="markupIsNeutral ? 'text-muted-foreground/60' : 'text-violet-600 font-medium'"
                           :title="friendPriceTitle"
                           data-testid="friend-price">
                        {{ formatFriendPrice(product.price_1kg) }}
                      </div>
                    </TableCell>
                    <TableCell class="text-sm text-right">
                      <div>{{ formatPrice(product.price_20pc5g) }}</div>
                      <div v-if="formatFriendPrice(product.price_20pc5g)"
                           class="text-xs mt-0.5"
                           :class="markupIsNeutral ? 'text-muted-foreground/60' : 'text-violet-600 font-medium'"
                           :title="friendPriceTitle"
                           data-testid="friend-price">
                        {{ formatFriendPrice(product.price_20pc5g) }}
                      </div>
                    </TableCell>
                    <TableCell class="text-sm text-right">
                      <div>{{ formatPrice(product.price_8pc12g) }}</div>
                      <div v-if="formatFriendPrice(product.price_8pc12g)"
                           class="text-xs mt-0.5"
                           :class="markupIsNeutral ? 'text-muted-foreground/60' : 'text-violet-600 font-medium'"
                           :title="friendPriceTitle"
                           data-testid="friend-price">
                        {{ formatFriendPrice(product.price_8pc12g) }}
                      </div>
                    </TableCell>
                  </template>
                  <TableCell v-if="!isBakery" class="text-right text-xs" data-testid="product-origin">
                    <div class="text-muted-foreground mb-1">
                      <span v-if="product.source_coffee_product_id">z katalógu</span>
                      <span v-else title="Nie je napojený na katalóg — pridaný manuálne alebo pred migráciou">mimo katalógu</span>
                    </div>
                    <!-- Limit zásob pre TENTO cyklus (PM 2026-08-26) -->
                    <div class="flex items-center justify-end gap-1">
                      <!-- Native input on purpose: the shadcn Input speaks
                           modelValue/update:modelValue, so :value/@input do not
                           bind through it. -->
                      <input
                        type="number"
                        min="0"
                        step="50"
                        class="h-7 w-24 rounded-md border border-input bg-background px-2 text-xs text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        placeholder="bez limitu"
                        :value="limitValue(product)"
                        :disabled="limitPending[product.id]"
                        :data-testid="`stock-limit-input-${product.id}`"
                        @input="onLimitInput(product.id, $event.target.value)"
                        @keydown.enter.prevent="saveLimit(product)"
                      />
                      <span class="text-muted-foreground">g</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-7 px-2"
                        :disabled="limitPending[product.id]"
                        :data-testid="`stock-limit-save-${product.id}`"
                        @click="saveLimit(product)"
                      >{{ limitPending[product.id] ? '…' : 'Uložiť' }}</Button>
                    </div>
                    <div v-if="limitError[product.id]" class="text-destructive mt-0.5" :data-testid="`stock-limit-error-${product.id}`">
                      {{ limitError[product.id] }}
                    </div>
                  </TableCell>
                  <TableCell v-else class="text-right">
                    <Button variant="ghost" size="sm" @click="openProductModal(product)">Upraviť</Button>
                    <Button variant="ghost" size="sm" @click="duplicateProduct(product)" title="Duplikovať">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                    </Button>
                    <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="deleteProduct(product.id)">Vymazať</Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <!-- Orders Tab -->
        <TabsContent value="orders">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold">Objednávky ({{ orderedPartiesCount }})</h2>
            <div v-if="listedOrders.length > 0" class="flex gap-1 bg-muted rounded-lg p-1">
              <button
                @click="ordersView = 'friend'"
                :class="['px-3 py-1 text-sm rounded-md transition-colors', ordersView === 'friend' ? 'bg-background shadow font-medium' : 'text-muted-foreground hover:text-foreground']"
              >
                Podľa priateľa
              </button>
              <button
                @click="ordersView = 'product'"
                :class="['px-3 py-1 text-sm rounded-md transition-colors', ordersView === 'product' ? 'bg-background shadow font-medium' : 'text-muted-foreground hover:text-foreground']"
              >
                Podľa produktu
              </button>
            </div>
          </div>

          <!-- ⚠ THE LINK LISTING FAILING IS INVISIBLE WITHOUT THIS (§UC-GR-008).
               `guestLinks` stays `[]`, so EVERY friend row falls into the `v-else`
               and offers "Vytvoriť hosťovský odkaz" — the admin reads that as "nobody
               has ever shared". For a DEACTIVATED host who does have a link it is
               worse: the create then answers 409 `inactive_host`, so their existing
               token stays invisible and unforwardable, which is precisely the state
               module 14 exists to make recoverable. The listing is the complete
               source of tokens; when it is missing, say so.
               ⚠ A SIBLING ABOVE the chain, same rule as the card below. -->
          <Alert
            v-if="guestLinksError"
            variant="destructive"
            class="mb-4"
            data-testid="guest-links-error"
          >
            <AlertDescription class="text-sm">
              Hosťovské odkazy sa nepodarilo načítať: {{ guestLinksError }}. Odkazy, ktoré už
              existujú, sa teraz nezobrazujú — obnovte stránku.
            </AlertDescription>
          </Alert>

          <!-- Same contract as the listing above: an empty pickup dropdown and a
               failed load are indistinguishable on screen, and the wrong conclusion
               ("no places are configured") sends the admin to Settings to re-create
               places that already exist.
               ⚠ A SIBLING ABOVE the v-if/v-else-if/v-else chain, same rule. -->
          <Alert
            v-if="pickupLocationsError"
            variant="destructive"
            class="mb-4"
            data-testid="pickup-locations-error"
          >
            <AlertDescription class="text-sm">
              Miesta vyzdvihnutia sa nepodarilo načítať: {{ pickupLocationsError }}. Zmena
              miesta teraz nie je možná — obnovte stránku.
            </AlertDescription>
          </Alert>

          <!-- Guest money overview (§UC-GSO-010). Guests pay the admin directly, so
               this is the receivables list: the payment reference is what matches an
               incoming bank transfer to one sub-order.
               ⚠ Placed ABOVE the empty-state div on purpose: that div opens the
               v-if / v-else-if / v-else chain of the two order tables, and an
               independent v-if slipped between its links breaks the chain — the
               tables then silently stop rendering whenever this card shows. -->
          <Card
            v-if="guestUnpaid.unpaid.length > 0 || guestUnpaid.refunds.length > 0 || guestUnpaidError"
            class="mb-4"
            data-testid="guest-unpaid-overview"
          >
            <CardContent class="p-4">
              <div v-if="guestUnpaidError" class="text-sm text-destructive">
                Prehľad platieb hostí sa nepodarilo načítať: {{ guestUnpaidError }}
              </div>

              <template v-if="guestUnpaid.unpaid.length > 0">
                <h3 class="text-sm font-medium mb-1">
                  Nezaplatené objednávky hostí ({{ guestUnpaid.totals.count }})
                </h3>
                <p class="text-xs text-muted-foreground mb-3">
                  Spolu {{ formatPrice(guestUnpaid.totals.total) }}. Hostia platia priamo správcovi —
                  platbu spárujte podľa referencie.
                </p>
                <div class="space-y-2">
                  <div
                    v-for="row in guestUnpaid.unpaid"
                    :key="`unpaid-${row.id}`"
                    class="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
                    :data-testid="`guest-unpaid-row-${row.id}`"
                  >
                    <div class="min-w-0">
                      <div class="font-medium">
                        {{ row.guest_name }}
                        <span class="text-xs font-normal text-muted-foreground">
                          — hosť, pozval {{ row.host.name }}
                        </span>
                      </div>
                      <div class="text-xs text-muted-foreground">
                        {{ row.guest_phone }}<span v-if="row.guest_email"> · {{ row.guest_email }}</span>
                      </div>
                      <!-- 15 §UC-PL-008 — the VS first, then the human reference: the
                           admin reading a statement line "VS 9000123" finds the row by the
                           symbol, and still has the name-bearing reference beside it for
                           the transfers that carry no VS at all. Server-derived
                           (`helpers/payment.js`); nothing here composes one.
                           ⚠ GUARDED, like the two row sites below: the helper fails closed
                           with an EMPTY symbol for an out-of-range id, and an unguarded
                           prefix would then render „VS  · " — a bare label and a dangling
                           separator in front of the reference. One convention for this
                           value across all four sites this row added. -->
                      <div class="text-xs font-mono text-muted-foreground"><span v-if="row.variable_symbol">VS {{ row.variable_symbol }} · </span>{{ row.reference }}</div>
                    </div>
                    <div class="font-semibold">{{ formatPrice(row.amount) }}</div>
                  </div>
                </div>
              </template>

              <!-- Money received for a sub-order that was later cancelled: it has to
                   go back. Unticking "zaplatené" on the row takes it off this list. -->
              <template v-if="guestUnpaid.refunds.length > 0">
                <h3 class="text-sm font-medium mt-4 mb-1">
                  Na vrátenie ({{ guestUnpaid.refund_totals.count }})
                </h3>
                <p class="text-xs text-muted-foreground mb-2">
                  Zaplatené, no zrušené objednávky — spolu {{ formatPrice(guestUnpaid.refund_totals.total) }}.
                </p>
                <div class="space-y-2">
                  <div
                    v-for="row in guestUnpaid.refunds"
                    :key="`refund-${row.id}`"
                    class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm"
                    :data-testid="`guest-refund-row-${row.id}`"
                  >
                    <div class="min-w-0">
                      <div class="font-medium">
                        {{ row.guest_name }}
                        <span class="text-xs font-normal text-muted-foreground">
                          — hosť, pozval {{ row.host.name }}
                        </span>
                      </div>
                      <div class="text-xs text-muted-foreground">
                        {{ row.guest_phone }}<span v-if="row.guest_email"> · {{ row.guest_email }}</span>
                      </div>
                      <!-- 15 §UC-PL-008 — the VS first, then the human reference: the
                           admin reading a statement line "VS 9000123" finds the row by the
                           symbol, and still has the name-bearing reference beside it for
                           the transfers that carry no VS at all. Server-derived
                           (`helpers/payment.js`); nothing here composes one.
                           ⚠ GUARDED, like the two row sites below: the helper fails closed
                           with an EMPTY symbol for an out-of-range id, and an unguarded
                           prefix would then render „VS  · " — a bare label and a dangling
                           separator in front of the reference. One convention for this
                           value across all four sites this row added. -->
                      <div class="text-xs font-mono text-muted-foreground"><span v-if="row.variable_symbol">VS {{ row.variable_symbol }} · </span>{{ row.reference }}</div>
                    </div>
                    <div class="font-semibold">{{ formatPrice(row.amount) }}</div>
                  </div>
                </div>
              </template>
            </CardContent>
          </Card>

          <div v-if="orders.length === 0" class="text-center py-12 text-muted-foreground">
            Zatiaľ žiadne objednávky
          </div>

          <!-- Product view -->
          <Card v-else-if="ordersView === 'product'">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10"></TableHead>
                  <TableHead>Produkt</TableHead>
                  <TableHead class="text-center">Ks</TableHead>
                  <TableHead class="text-right">Suma</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <template v-for="product in ordersByProduct" :key="product.key">
                  <TableRow class="cursor-pointer hover:bg-muted/50" @click="toggleExpandProduct(product.key)">
                    <TableCell class="p-2">
                      <button class="w-8 h-8 flex items-center justify-center rounded hover:bg-muted transition-colors">
                        <svg
                          class="w-4 h-4 transition-transform"
                          :class="{ 'rotate-90': expandedProducts.has(product.key) }"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </TableCell>
                    <TableCell>
                      <div class="flex items-center gap-2">
                        <Badge
                          v-if="product.purpose"
                          variant="outline"
                          :class="{
                            'border-stone-400 text-stone-600 bg-stone-50': product.purpose === 'Espresso',
                            'border-sky-400 text-sky-600 bg-sky-50': product.purpose === 'Filter',
                            'border-amber-400 text-amber-600 bg-amber-50': product.purpose === 'Kapsule' || product.purpose === 'Slané',
                            'border-pink-400 text-pink-600 bg-pink-50': product.purpose === 'Sladké'
                          }"
                          class="text-xs"
                        >
                          {{ product.purpose }}
                        </Badge>
                        <span class="font-medium">{{ product.product_name }}</span>
                        <span class="text-xs text-muted-foreground">({{ product.variant_label ? product.variant_label : (product.variant === 'unit' ? 'ks' : product.variant) }})</span>
                      </div>
                    </TableCell>
                    <TableCell class="text-center font-medium">{{ product.total_quantity }}</TableCell>
                    <TableCell class="text-right">{{ formatPrice(product.total_price) }}</TableCell>
                  </TableRow>
                  <!-- Expanded buyer list: friends and guests, the guests marked
                       violet with their host — the same treatment the nested
                       sub-orders get in the friend view, so a bag reads the same
                       wherever it is shown. Without the marker a guest would be
                       indistinguishable from a friend on a screen where only
                       friends carry a balance. -->
                  <template v-if="expandedProducts.has(product.key)">
                    <TableRow v-for="(b, i) in product.buyers" :key="`${product.key}-${i}`" class="bg-muted/30">
                      <TableCell></TableCell>
                      <TableCell class="text-sm text-muted-foreground">
                        {{ b.name }}
                        <span v-if="b.is_guest" class="text-xs text-violet-600">
                          — hosť<template v-if="b.host_name">, pozval {{ firstName(b.host_name) }}</template>
                        </span>
                      </TableCell>
                      <TableCell class="text-center text-sm text-muted-foreground">{{ b.quantity }}</TableCell>
                      <TableCell class="text-right text-sm text-muted-foreground">{{ formatPrice(b.price) }}</TableCell>
                    </TableRow>
                  </template>
                </template>
              </TableBody>
              <tfoot>
                <!-- ⚠ This footer DOES include the guests (GR-T6), so it says so —
                     otherwise the two tabs of one screen carry the same word for two
                     different figures, which is the confusion this row exists to end. -->
                <TableRow class="font-semibold bg-muted">
                  <TableCell></TableCell>
                  <TableCell>Celkom (vrátane hostí)</TableCell>
                  <TableCell class="text-center">{{ productViewTotals.quantity }}</TableCell>
                  <TableCell class="text-right">{{ formatPrice(productViewTotals.total) }}</TableCell>
                </TableRow>
              </tfoot>
            </Table>
          </Card>

          <!-- Friend view -->
          <Card v-else>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10"></TableHead>
                  <TableHead>Priateľ</TableHead>
                  <TableHead class="text-right">Suma</TableHead>
                  <TableHead class="text-right">Zostatok</TableHead>
                  <template v-if="isBakery">
                    <TableHead class="text-center">Ks</TableHead>
                  </template>
                  <template v-else>
                    <TableHead
                      v-for="col in visibleVariantColumns"
                      :key="col.label"
                      class="text-center"
                    >{{ col.label }}</TableHead>
                  </template>
                  <TableHead>Status</TableHead>
                  <TableHead class="text-center">Zaplatené</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <template v-for="order in listedOrders" :key="order.id || order.friend_id">
                  <TableRow>
                    <TableCell class="p-2">
                      <!-- Only an ORDERED row has items to expand. A draft's cart
                           lines are not shown here at all (see `isOrdered`). -->
                      <button
                        v-if="isOrdered(order)"
                        @click="toggleExpand(order.id)"
                        class="w-8 h-8 flex items-center justify-center rounded hover:bg-muted transition-colors"
                      >
                        <svg
                          class="w-4 h-4 transition-transform"
                          :class="{ 'rotate-90': expandedOrders.has(order.id) }"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </TableCell>
                    <TableCell class="font-medium">
                      {{ order.friend_name }}
                      <!-- §UC-GR-008 — the host's SHARE link, so the admin can forward
                           it to a friend who lost theirs (PO requirement 1). It sits
                           under the name rather than in a column of its own: a new
                           column would move every `colspan` on this tab, including the
                           nested guest rows' and the footer's.
                           ⚠ The token is composed in JS at click time — nothing here
                           binds it into markup. -->
                      <!-- ⚠ ONE HOME for this cluster (`GuestLinkRowControls.vue`) —
                           the SAME component the "všetci priatelia" fold below the
                           table renders, with its own testid namespace. Extracted
                           when the fold was added: two copies of a money-adjacent
                           control drift, and the shipped `host-guest-link*` testids
                           and copy are what this surface is pinned on. -->
                      <GuestLinkRowControls
                        class="mt-1"
                        :friend-id="order.friend_id"
                        :link="hostLink(order)"
                        :copied="copiedHostLinkId === order.friend_id"
                        :create-pending="!!guestLinkPending[order.friend_id]"
                        :regen-pending="!!guestLinkRegenPending[order.friend_id]"
                        :confirm-open="guestLinkRegenConfirmId === order.friend_id"
                        :error="guestLinkErrors[order.friend_id] || ''"
                        @copy="copyHostLink(order)"
                        @create="createHostLink(order)"
                        @regenerate="regenerateHostLink(order)"
                        @open-confirm="guestLinkRegenConfirmId = order.friend_id"
                        @close-confirm="guestLinkRegenConfirmId = null"
                      />
                    </TableCell>
                    <TableCell class="text-right">
                      {{ formatPrice(isOrdered(order) ? (order.total || 0) + (order.delivery_fee || 0) : 0) }}
                      <div v-if="isOrdered(order) && order.delivery_fee" class="text-xs text-muted-foreground">
                        ({{ formatPrice(order.total) }} + {{ formatPrice(order.delivery_fee) }} doručenie)
                      </div>
                      <!-- 15 §UC-PL-008 — beside the money, which is what the admin is
                           reconciling. A placeholder row (a friend who has not ordered, or
                           a host whose only stake is their colleague's bags) carries
                           `variable_symbol: null` and renders nothing: there is no debt to
                           quote.
                           ⚠ `isOrdered` — THE tab's one predicate — and not merely the
                           presence of a symbol: a DRAFT has an `orders.id`, so the payload
                           carries its VS, but a saved cart is not money owed and this
                           screen shows it nothing but a „-“ everywhere else (the rule
                           above `isOrdered`). Quoting a symbol for one would invite the
                           admin to chase a payment nobody was asked for. -->
                      <div
                        v-if="isOrdered(order) && order.variable_symbol"
                        class="text-xs font-mono text-muted-foreground"
                        :data-testid="`order-vs-${order.id}`"
                      >VS {{ order.variable_symbol }}</div>
                    </TableCell>
                    <TableCell class="text-right">
                      <BalanceBadge :balance="order.friend_balance || 0" />
                    </TableCell>
                    <template v-if="isBakery">
                      <TableCell class="text-center">{{ isOrdered(order) ? (order.count_unit || 0) : 0 }}</TableCell>
                    </template>
                    <template v-else>
                      <TableCell
                        v-for="col in visibleVariantColumns"
                        :key="col.label"
                        class="text-center"
                      >{{ isOrdered(order) ? (order[col.countField] || 0) : 0 }}</TableCell>
                    </template>
                    <TableCell>
                      <div class="flex flex-wrap gap-1">
                        <Badge
                          :variant="order.status === 'submitted' ? 'default' : order.status === 'none' ? 'outline' : 'secondary'"
                          :class="order.status === 'none' ? 'text-muted-foreground' : ''"
                        >
                          {{ order.status === 'submitted' ? 'Odoslane' : order.status === 'none' ? 'Neobjednane' : 'Rozpracovane' }}
                        </Badge>
                        <!-- ⚠ THE PILL IS A `<select>` NOW, not a badge (PO decision,
                             2026-09-02): friends pick the wrong pickup point and the
                             point changes afterwards, so the admin needs to name the
                             FINAL one before packing. Same colours as the badge it
                             replaces — blue = a configured location, grey = the
                             friend's "Iné" note, red = still going by Packeta — so the
                             table reads as before at rest. Saves on pick; no modal, no
                             Uložiť. On EVERY listed row since 2026-09-03, including a
                             host with no own order (their pickup lives on the share
                             link), a draft, and a Packeta order — that last one behind
                             the picker's inline confirm, because it clears the parcel
                             fee. -->
                        <PickupLocationPicker
                          v-if="canEditPickup(order)"
                          :cycle-id="cycleId"
                          :friend-id="order.friend_id"
                          :locations="pickupLocations"
                          :location-id="order.pickup_location_id"
                          :location-name="order.pickup_location_name || ''"
                          :note="order.pickup_location_note || ''"
                          :packeta-address="order.packeta_address || ''"
                          :delivery-fee="order.delivery_fee || 0"
                          @updated="onPickupUpdated(order, $event)"
                        />
                        <Badge
                          v-else-if="order.pickup_location_name"
                          variant="outline"
                          class="border-blue-400 text-blue-600 bg-blue-50"
                        >
                          {{ order.pickup_location_name }}
                        </Badge>
                        <Badge
                          v-else-if="order.pickup_location_note"
                          variant="outline"
                          class="border-gray-400 text-gray-600 bg-gray-50"
                        >
                          {{ order.pickup_location_note }}
                        </Badge>
                        <!-- Only when no picker is rendered: the pill itself reads
                             "Packeta" in the same red for a parcel order, so both
                             would be the same word twice. -->
                        <Badge
                          v-if="order.packeta_address && !canEditPickup(order)"
                          variant="outline"
                          class="border-red-400 text-red-600 bg-red-50"
                        >
                          Packeta
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell class="text-center">
                      <!-- ⚠ ORDERED rows only. `PATCH /api/orders/:id/paid` posts a
                           `transactions` row for `order.total`, so offering this on a
                           DRAFT turned an unsubmitted cart's value into a real payment
                           against the friend's balance. The route refuses it now
                           (400, mirroring `PATCH /:id/packed`); this stops the admin
                           being offered a control that can only fail. -->
                      <button
                        v-if="isOrdered(order)"
                        @click="togglePaid(order)"
                        :class="['w-6 h-6 rounded border-2 flex items-center justify-center mx-auto', order.paid ? 'bg-green-500 border-green-500 text-white' : 'border-border']"
                      >
                        <svg v-if="order.paid" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                      <span v-else class="text-muted-foreground">-</span>
                    </TableCell>
                  </TableRow>
                  <!-- Expanded items row -->
                  <TableRow v-if="isOrdered(order) && expandedOrders.has(order.id)">
                    <TableCell :colspan="6 + (isBakery ? 1 : visibleVariantColumns.length)" class="bg-muted/50 p-4">
                      <div v-if="order.items && order.items.length > 0" class="space-y-1">
                        <div v-for="item in order.items" :key="`${item.product_id}-${item.variant}`" class="flex justify-between py-1 text-sm">
                          <span>
                            <Badge
                              v-if="item.purpose"
                              variant="outline"
                              :class="purposeBadgeClass(item.purpose)"
                              class="mr-2 text-xs"
                            >
                              {{ item.purpose }}
                            </Badge>
                            {{ item.product_name }} ({{ itemVariantLabel(item) }})
                          </span>
                          <span class="text-muted-foreground">{{ item.quantity }} × {{ formatPrice(item.price) }} = {{ formatPrice(item.price * item.quantity) }}</span>
                        </div>
                      </div>
                      <div v-else class="text-sm text-muted-foreground">Žiadne položky</div>
                    </TableCell>
                  </TableRow>

                  <!-- Guest sub-orders (§UC-GSO-009), NESTED under their host: the
                       colleagues who ordered through this friend's share link.
                       The admin owns `paid` (toggle) and only READS the host's
                       `delivered` tick — Decision 2, single owner per flag. -->
                  <template v-for="sub in (order.guest_orders || [])" :key="`guest-${sub.id}`">
                  <TableRow
                    class="bg-violet-50/40"
                    :class="isGuestCancelled(sub) ? 'opacity-60' : ''"
                    :data-testid="`guest-suborder-${sub.id}`"
                  >
                    <TableCell></TableCell>
                    <TableCell :colspan="2 + (isBakery ? 1 : visibleVariantColumns.length)">
                      <!-- Indented behind a violet rule: a sub-order is a subgroup
                           OF the host above it, not a party of its own. -->
                      <div class="flex items-start gap-2 pl-4 border-l-2 border-violet-300">
                        <button
                          v-if="sub.items && sub.items.length > 0"
                          @click="toggleExpandGuest(sub.id)"
                          class="w-7 h-7 shrink-0 flex items-center justify-center rounded hover:bg-violet-100 transition-colors"
                          :aria-expanded="expandedGuestOrders.has(sub.id) ? 'true' : 'false'"
                          :title="expandedGuestOrders.has(sub.id) ? 'Zbaliť položky' : 'Rozbaliť položky'"
                          :data-testid="`guest-expand-${sub.id}`"
                        >
                          <svg
                            class="w-4 h-4 transition-transform"
                            :class="{ 'rotate-90': expandedGuestOrders.has(sub.id) }"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                        <span v-else class="w-7 h-7 shrink-0"></span>
                        <div class="min-w-0">
                          <div class="flex flex-wrap items-center gap-2">
                            <!-- Violet, so a sub-order can never be mistaken for the
                                 host's own order or for a delivery badge (pickup blue,
                                 Packeta red, paid green, unpaid amber, cancelled stone). -->
                            <Badge
                              variant="outline"
                              class="text-xs border-violet-400 text-violet-700 bg-violet-50"
                            >
                              Hosť • pozval {{ firstName(order.friend_name) }}
                            </Badge>
                            <span class="font-medium text-sm">{{ sub.guest_name }}</span>
                            <span class="text-xs text-muted-foreground">{{ sub.guest_phone }}</span>
                            <span v-if="sub.guest_email" class="text-xs text-muted-foreground">{{ sub.guest_email }}</span>
                          </div>
                          <div v-if="sub.items && sub.items.length > 0" class="mt-0.5 text-xs text-muted-foreground">
                            {{ guestItemCountLabel(sub) }}
                          </div>
                          <div v-else class="mt-0.5 text-xs text-muted-foreground">Žiadne položky</div>

                          <!-- §UC-GR-008 — resend + cancel, D9's minimal placement:
                               these live on the nested sub-order rows ONLY. The refund
                               card carries `order_token` too, but no PO ask names that
                               surface and two affordances for one action drift apart. -->
                          <div class="mt-1 flex flex-wrap items-center gap-3">
                            <!-- ⚠ On EVERY row, cancelled included and after the lock:
                                 resending is precisely a post-lock / lost-URL activity,
                                 and a cancelled order's URL still renders the guest's
                                 terminal record (the read resolver is 404-only). -->
                            <button
                              type="button"
                              class="text-xs text-primary underline underline-offset-2 hover:no-underline"
                              :data-testid="`guest-order-link-${sub.id}`"
                              @click="copySubOrderLink(sub)"
                            >{{ copiedSubOrderId === sub.id ? 'Skopírované!' : 'Odkaz na objednávku' }}</button>
                            <!-- Unlike the host's DELETE this has NO paid blockade (D4):
                                 the host's 409 exists to force the escalation TO the
                                 admin, so blocking the admin too would recreate the
                                 dead end the incident ran into. -->
                            <button
                              v-if="!isGuestCancelled(sub) && guestCancelConfirmId !== sub.id"
                              type="button"
                              class="text-xs text-destructive underline underline-offset-2 hover:no-underline"
                              :data-testid="`guest-cancel-${sub.id}`"
                              @click="guestCancelConfirmId = sub.id"
                            >Zrušiť</button>
                          </div>

                          <div
                            v-if="guestCancelConfirmId === sub.id"
                            class="mt-1 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs"
                            :data-testid="`guest-cancel-confirm-${sub.id}`"
                          >
                            <!-- ⚠ The paid warning NAMES the refund queue, so the admin
                                 cancels a paid order knowingly: the money does not
                                 vanish, it moves to "Na vrátenie" below. -->
                            <p v-if="sub.paid" class="font-medium">
                              Objednávka je zaplatená - po zrušení sa zobrazí medzi platbami na vrátenie.
                            </p>
                            <p :class="sub.paid ? 'mt-0.5' : ''">
                              Objednávka hosťa sa zruší. Hosť ju uvidí ako zrušenú a už si ju nebude môcť upraviť.
                            </p>
                            <div class="mt-1.5 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                class="rounded bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                                :disabled="!!guestCancelPending[sub.id]"
                                :data-testid="`guest-cancel-yes-${sub.id}`"
                                @click="cancelGuestOrder(sub)"
                              >{{ guestCancelPending[sub.id] ? 'Ruším...' : 'Áno, zrušiť' }}</button>
                              <button
                                type="button"
                                class="rounded border px-2 py-1 text-xs disabled:opacity-50"
                                :disabled="!!guestCancelPending[sub.id]"
                                :data-testid="`guest-cancel-no-${sub.id}`"
                                @click="guestCancelConfirmId = null"
                              >Nie</button>
                            </div>
                          </div>

                          <!-- A refused cancel lands HERE, on the row that asked for it
                               — never as a page-level banner, which on a table of
                               twenty rows says nothing about which one failed. -->
                          <div
                            v-if="guestRowErrors[sub.id]"
                            class="mt-1 text-xs text-destructive"
                            :data-testid="`guest-row-error-${sub.id}`"
                          >{{ guestRowErrors[sub.id] }}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div class="flex flex-wrap items-center gap-1">
                        <Badge
                          v-if="isGuestCancelled(sub)"
                          variant="outline"
                          class="text-xs border-stone-400 text-stone-600 bg-stone-50"
                        >
                          Zrušené
                        </Badge>
                        <!-- READ-ONLY: `delivered` belongs to the host (their
                             hand-over checklist). No control is offered here — the
                             admin's own delivery tracking is the Distribution
                             packing flow, a separate concept. -->
                        <span
                          class="text-xs"
                          :class="sub.delivered ? 'text-green-700' : 'text-muted-foreground'"
                          :data-testid="`guest-delivered-state-${sub.id}`"
                          title="Odovzdanie eviduje hostiteľ"
                        >
                          {{ sub.delivered ? 'Odovzdané' : 'Neodovzdané' }}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell class="text-right text-sm">
                      {{ formatPrice(sub.total) }}
                      <!-- The guest scheme (`9` + the padded sub-order id) — a different
                           id space from the host's order above it, which is exactly why
                           the two are prefixed apart (15 §UC-PL-001). -->
                      <div
                        v-if="sub.variable_symbol"
                        class="text-xs font-mono text-muted-foreground"
                        :data-testid="`guest-vs-${sub.id}`"
                      >VS {{ sub.variable_symbol }}</div>
                    </TableCell>
                    <TableCell class="text-center">
                      <button
                        @click="toggleGuestPaid(sub)"
                        :disabled="!!guestPaidPending[sub.id]"
                        :aria-pressed="sub.paid ? 'true' : 'false'"
                        :title="sub.paid ? 'Označiť ako nezaplatené' : 'Označiť ako zaplatené'"
                        :data-testid="`guest-paid-toggle-${sub.id}`"
                        :class="['w-6 h-6 rounded border-2 flex items-center justify-center mx-auto', sub.paid ? 'bg-green-500 border-green-500 text-white' : 'border-border']"
                      >
                        <svg v-if="sub.paid" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                    </TableCell>
                  </TableRow>

                  <!-- Expanded guest items: one product per row, in the same
                       format as the host's own items above, still indented behind
                       the violet rule so the subgroup stays visible. -->
                  <TableRow
                    v-if="expandedGuestOrders.has(sub.id)"
                    class="bg-violet-50/40"
                    :class="isGuestCancelled(sub) ? 'opacity-60' : ''"
                    :data-testid="`guest-suborder-items-${sub.id}`"
                  >
                    <TableCell></TableCell>
                    <!-- `py-2` only: the horizontal padding stays at the cell default
                         so this violet rule lines up exactly with the header row's. -->
                    <TableCell :colspan="5 + (isBakery ? 1 : visibleVariantColumns.length)" class="py-2">
                      <div class="border-l-2 border-violet-300 pl-4 space-y-1">
                        <div
                          v-for="item in sub.items"
                          :key="`guest-item-${item.id}`"
                          class="flex justify-between gap-3 py-1 text-sm"
                        >
                          <span>
                            <Badge
                              v-if="item.purpose"
                              variant="outline"
                              :class="purposeBadgeClass(item.purpose)"
                              class="mr-2 text-xs"
                            >
                              {{ item.purpose }}
                            </Badge>
                            {{ item.product_name }} ({{ itemVariantLabel(item) }})
                          </span>
                          <span class="text-muted-foreground whitespace-nowrap">
                            {{ item.quantity }} × {{ formatPrice(item.price) }} = {{ formatPrice(item.price * item.quantity) }}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                  </template>
                </template>
              </TableBody>
              <tfoot>
                <!-- ⚠ "(priatelia)" is not decoration — see `guestOrdersTotal`. This
                     column is the friends' balance, so it has never included the
                     guests' money, and an unqualified "Celkom" here against the
                     dashboard's whole-cycle figure is what sent the PO looking for a
                     bug that did not exist. -->
                <TableRow class="font-semibold bg-muted">
                  <TableCell></TableCell>
                  <TableCell>Celkom (priatelia)</TableCell>
                  <TableCell class="text-right">{{ formatPrice(orderTotals.total) }}</TableCell>
                  <TableCell></TableCell>
                  <template v-if="isBakery">
                    <TableCell class="text-center">{{ orderTotals.count_unit }}</TableCell>
                  </template>
                  <template v-else>
                    <TableCell
                      v-for="col in visibleVariantColumns"
                      :key="col.label"
                      class="text-center"
                    >{{ orderTotals[col.countField] }}</TableCell>
                  </template>
                  <TableCell></TableCell>
                  <TableCell></TableCell>
                </TableRow>

                <!-- The other half, right beside the first one. Rendered only when the
                     cycle actually has colleagues' orders — on a cycle without them
                     there is no second half and a permanent "0.00" would be noise.
                     ⚠ Deliberately NOT under the "Nezaplatené objednávky hostí" card:
                     that card lists the UNPAID ones and disappears entirely once
                     everyone has paid, which is exactly when this figure would vanish
                     while the friends' half stayed on screen. -->
                <TableRow v-if="guestOrdersTotal > 0" class="bg-muted text-muted-foreground">
                  <TableCell></TableCell>
                  <TableCell class="font-normal">
                    Objednávky hostí
                    <span class="block text-xs">platia priamo správcovi, nie cez zostatok priateľa</span>
                  </TableCell>
                  <TableCell class="text-right font-semibold" data-testid="guest-orders-total">
                    {{ formatPrice(guestOrdersTotal) }}
                  </TableCell>
                  <TableCell :colspan="3 + (isBakery ? 1 : visibleVariantColumns.length)"></TableCell>
                </TableRow>
              </tfoot>
            </Table>
          </Card>

          <!-- ══ Hosťovské odkazy (všetci priatelia) ═════════════════════════════
               PO decision 2026-08-31 — the residual §UC-GR-008 recorded ("a host who
               has a link, has not ordered themselves, and whose colleagues have not
               ordered yet is absent from this tab") closed as a FOLD, not by widening
               the table above: on the live September cycle 43 of 76 active friends
               have no activity, and 43 empty rows would wreck the sheet the admin
               packs and orders from.

               ⚠ A SIBLING **BELOW** the v-if / v-else-if / v-else chain of the two
               order tables — never between its links. An independent `v-if` slipped
               into that chain breaks it and BOTH tables silently stop rendering; see
               the same warning at the `guest-unpaid-overview` card above, which is a
               sibling ABOVE for exactly this reason.

               ⚠ Collapsed by default: this is a lookup tool ("forward X their link"),
               not part of the packing sheet, and 76 rows expanded on load would push
               the tables off screen.

               ⚠ No guest data is rendered here at all — no sub-orders, no
               `order_token`, no share token. Both URLs are composed in JS at click
               time (§UC-GR-007's promoted rule). -->
          <Card class="mt-4" data-testid="all-friends-guest-links">
            <CardContent class="p-4">
              <button
                type="button"
                class="w-full flex items-start gap-2 text-left"
                :aria-expanded="allFriendsLinksOpen ? 'true' : 'false'"
                data-testid="all-friends-guest-links-toggle"
                @click="allFriendsLinksOpen = !allFriendsLinksOpen"
              >
                <svg
                  class="w-4 h-4 mt-0.5 shrink-0 transition-transform text-muted-foreground"
                  :class="{ 'rotate-90': allFriendsLinksOpen }"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
                <span class="min-w-0">
                  <span class="block text-sm font-medium">Hosťovské odkazy (všetci priatelia)</span>
                  <span class="block text-xs text-muted-foreground" data-testid="all-friends-guest-links-stats">
                    Odkaz má {{ allFriendsLinkStats.withLink }} z {{ allFriendsLinkStats.total }} priateľov<template v-if="allFriendsLinkStats.dead > 0">, z toho neaktívnych: {{ allFriendsLinkStats.dead }}</template>
                  </span>
                </span>
              </button>

              <div v-if="allFriendsLinksOpen" class="mt-3" data-testid="all-friends-guest-links-body">
                <p class="text-xs text-muted-foreground mb-3 max-w-3xl">
                  Tu je každý aktívny priateľ - aj ten, ktorý si sám nič neobjednal. Odkaz mu môžete
                  vytvoriť alebo skopírovať a poslať, aby cez neho objednávali jeho kolegovia.
                </p>

                <!-- ⚠ A SEARCH BOX IS NOT A NICETY AT THIS SCALE. The admin's task is
                     "friend X lost their link"; scrolling 76 name rows to find one is
                     the wall this fold would otherwise be. -->
                <Input
                  v-model="allFriendsLinksQuery"
                  type="search"
                  class="mb-3 max-w-xs"
                  aria-label="Hľadať priateľa"
                  placeholder="Hľadať priateľa"
                  data-testid="all-friends-guest-links-search"
                />

                <div v-if="allFriendsRows.length === 0" class="text-sm text-muted-foreground">
                  Žiadni aktívni priatelia.
                </div>
                <div
                  v-else-if="allFriendsFiltered.length === 0"
                  class="text-sm text-muted-foreground"
                  data-testid="all-friends-guest-links-empty"
                >
                  Žiadny priateľ nevyhovuje hľadaniu.
                </div>
                <!-- ⚠ WIDTH-CAPPED ON PURPOSE. Full-width rows put the name and its
                     action ~1200px apart on a desktop admin screen, so scanning 76 of
                     them means crossing the viewport once per row. -->
                <div v-else class="divide-y max-w-3xl">
                  <div
                    v-for="row in allFriendsFiltered"
                    :key="`allf-${row.friend_id}`"
                    class="flex flex-wrap items-center justify-between gap-2 py-2"
                    :data-testid="`all-friends-row-${row.friend_id}`"
                  >
                    <span class="text-sm font-medium min-w-0 break-words">{{ row.friend_name }}</span>
                    <!-- ⚠ THE SAME COMPONENT as the table row above, with its own
                         testid namespace so one friend can be rendered on both
                         surfaces at once. All mutation state is shared per friend
                         (per-row `rowSeq` + pending), so a create started here shows
                         as pending in the table row too. -->
                    <GuestLinkRowControls
                      :friend-id="row.friend_id"
                      :link="hostLink(row)"
                      testid-prefix="all-friends-link"
                      :copied="copiedHostLinkId === row.friend_id"
                      :create-pending="!!guestLinkPending[row.friend_id]"
                      :regen-pending="!!guestLinkRegenPending[row.friend_id]"
                      :confirm-open="guestLinkRegenConfirmId === row.friend_id"
                      :error="guestLinkErrors[row.friend_id] || ''"
                      @copy="copyHostLink(row)"
                      @create="createHostLink(row)"
                      @regenerate="regenerateHostLink(row)"
                      @open-confirm="guestLinkRegenConfirmId = row.friend_id"
                      @close-confirm="guestLinkRegenConfirmId = null"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- Summary Tab -->
        <TabsContent value="summary">
          <div class="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 mb-4">
            <h2 class="text-lg font-semibold">Sumár objednávky</h2>
            <Button size="sm" @click="copySummary" class="self-start sm:self-auto">
              Kopírovať do schranky
            </Button>
          </div>

          <!-- Roastery filter -->
          <div v-if="summary?.roasteries?.length > 0" class="flex gap-2 mb-4 flex-wrap">
            <Button
              size="sm"
              :variant="summaryRoasteryFilter === '' ? 'default' : 'outline'"
              @click="loadSummaryForRoastery('')"
            >Všetky</Button>
            <Button
              size="sm"
              :variant="summaryRoasteryFilter === '_default' ? 'default' : 'outline'"
              @click="loadSummaryForRoastery('_default')"
            >Hlavná pražiareň</Button>
            <Button
              v-for="r in summary.roasteries"
              :key="r"
              size="sm"
              :variant="summaryRoasteryFilter === r ? 'default' : 'outline'"
              @click="loadSummaryForRoastery(r)"
            >{{ r }}</Button>
          </div>

          <Card>
            <CardContent class="p-3 sm:p-6">
              <div v-if="summary?.items.length === 0" class="text-center text-muted-foreground py-8">
                Zatiaľ žiadne objednávky
              </div>
              <div v-else>
                <div class="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Účel</TableHead>
                        <TableHead>Produkt</TableHead>
                        <TableHead>Varianta</TableHead>
                        <TableHead class="text-right">Počet</TableHead>
                        <TableHead class="text-right">Suma</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow v-for="(item, i) in summary.items" :key="i">
                        <TableCell>
                          <Badge
                            v-if="item.purpose"
                            variant="outline"
                            :class="{
                              'border-stone-400 text-stone-600 bg-stone-50': item.purpose === 'Espresso',
                              'border-sky-400 text-sky-600 bg-sky-50': item.purpose === 'Filter',
                              'border-amber-400 text-amber-600 bg-amber-50': item.purpose === 'Kapsule' || item.purpose === 'Slané',
                                  'border-pink-400 text-pink-600 bg-pink-50': item.purpose === 'Sladké'
                            }"
                          >
                            {{ item.purpose }}
                          </Badge>
                          <span v-else class="text-muted-foreground">-</span>
                        </TableCell>
                        <TableCell>{{ item.name }}<span v-if="item.description1 || item.roast_type" class="text-muted-foreground"> - {{ [item.description1, item.roast_type].filter(Boolean).join(', ') }}</span></TableCell>
                        <TableCell>{{ item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant) }}</TableCell>
                        <TableCell class="text-right">{{ item.total_quantity }}x</TableCell>
                        <TableCell class="text-right">{{ formatPrice(item.total_price) }}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>

                <div class="md:hidden divide-y">
                  <div v-for="(item, i) in summary.items" :key="i" class="py-3 first:pt-0 last:pb-0">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span
                            v-if="item.purpose"
                            class="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                            :class="{
                              'bg-stone-500': item.purpose === 'Espresso',
                              'bg-sky-500': item.purpose === 'Filter',
                              'bg-amber-500': item.purpose === 'Kapsule' || item.purpose === 'Slané',
                              'bg-pink-500': item.purpose === 'Sladké'
                            }"
                            :title="item.purpose"
                          ></span>
                          <span class="font-medium text-sm">{{ item.name }}</span>
                        </div>
                        <div v-if="item.description1 || item.roast_type" class="text-xs text-muted-foreground mt-0.5">
                          {{ [item.description1, item.roast_type].filter(Boolean).join(', ') }}
                        </div>
                        <div class="text-xs text-muted-foreground mt-1">
                          {{ item.total_quantity }}× {{ item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant) }}
                        </div>
                      </div>
                      <div class="text-sm font-semibold whitespace-nowrap">{{ formatPrice(item.total_price) }}</div>
                    </div>
                  </div>
                </div>

                <div class="border-t pt-4 mt-4 flex flex-col sm:flex-row sm:justify-between gap-1 text-base sm:text-lg font-semibold">
                  <span>Celkom položiek: {{ summary.totalItems }}</span>
                  <span>Celková suma: {{ formatPrice(summary.totalPrice) }}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        </Tabs>
      </template>
    </main>

    <!-- Product Modal -->
    <Dialog :open="showProductModal" @update:open="showProductModal = $event">
      <DialogContent class="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ editingProduct ? 'Upraviť produkt' : 'Nový produkt' }}</DialogTitle>
        </DialogHeader>

        <Alert v-if="productModalError" variant="destructive" data-testid="product-modal-error">
          <AlertDescription>{{ productModalError }}</AlertDescription>
        </Alert>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 py-4">
          <!-- Left column - Image -->
          <div>
            <Label class="mb-2">Fotografia produktu</Label>
            <div
              @drop="handleDrop"
              @dragover="handleDragOver"
              @dragleave="handleDragLeave"
              :class="[
                'border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer',
                isDragging ? 'border-primary bg-accent' : 'border-border hover:border-muted-foreground'
              ]"
              @click="$refs.imageInput.click()"
            >
              <input
                ref="imageInput"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                @change="handleImageSelect"
                class="hidden"
              />

              <div v-if="imagePreview" class="relative">
                <img :src="imagePreview" class="max-h-48 mx-auto rounded" />
                <button
                  @click.stop="removeImage"
                  class="absolute top-2 right-2 bg-destructive text-destructive-foreground rounded-full w-6 h-6 flex items-center justify-center hover:bg-destructive/90"
                >
                  &times;
                </button>
              </div>
              <div v-else class="py-8">
                <svg class="w-12 h-12 mx-auto text-muted-foreground mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p class="text-sm text-muted-foreground">Kliknite alebo preťahnite obrázok</p>
                <p class="text-xs text-muted-foreground/70 mt-1">JPG, PNG, max 5MB</p>
              </div>
            </div>
          </div>

          <!-- Right column - Fields -->
          <div class="space-y-3">
            <div class="space-y-1">
              <Label>Názov *</Label>
              <Input v-model="productForm.name" />
            </div>
            <div class="space-y-1">
              <Label>Popis (podnadpis)</Label>
              <Input v-model="productForm.description1" />
            </div>
            <div class="space-y-1">
              <Label>Chutový profil</Label>
              <textarea v-model="productForm.description2" rows="2" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"></textarea>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1">
                <Label>Praženie</Label>
                <Input v-model="productForm.roast_type" />
              </div>
              <div class="space-y-1">
                <Label>Účel</Label>
                <Input v-model="productForm.purpose" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1">
                <Label>Pražiareň</Label>
                <select v-model="productForm.roastery" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                  <option value="">— Žiadna —</option>
                  <option v-for="r in roasteries" :key="r.id" :value="r.name">{{ r.name }}</option>
                </select>
              </div>
              <div class="space-y-1">
                <Label>Limit zásob (g)</Label>
                <Input v-model="productForm.stock_limit_g" type="number" placeholder="Napr. 1000 = max 1 kg" />
              </div>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <div class="space-y-1">
                <Label>150g (EUR)</Label>
                <Input v-model="productForm.price_150g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>200g (EUR)</Label>
                <Input v-model="productForm.price_200g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>250g (EUR)</Label>
                <Input v-model="productForm.price_250g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>500g (EUR)</Label>
                <Input v-model="productForm.price_500g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>1kg (EUR)</Label>
                <Input v-model="productForm.price_1kg" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>20ks×5g (EUR)</Label>
                <Input v-model="productForm.price_20pc5g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>8ks×12g (EUR)</Label>
                <Input v-model="productForm.price_8pc12g" type="number" step="0.01" />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="showProductModal = false">Zrušiť</Button>
          <Button @click="saveProduct">Uložiť</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

  </div>

    <!-- Catalog product picker for an existing cycle (PM 2026-08-23) -->
    <Dialog :open="showCatalogPicker" @update:open="showCatalogPicker = $event">
      <DialogContent class="max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl max-h-[90vh] overflow-y-auto" data-testid="cycle-catalog-dialog">
        <DialogHeader>
          <DialogTitle>Produkty z katalógu v tomto cykle</DialogTitle>
        </DialogHeader>

        <div class="space-y-3">
          <p class="text-sm text-muted-foreground">
            Zaškrtnuté produkty cyklus ponúka. Odškrtnutím sa produkt z cyklu odstráni —
            už zadané objednávky, ceny ani množstvá sa nezmenia.
          </p>

          <Input v-model="catalogSearch" placeholder="Hľadať produkt..." data-testid="cycle-catalog-search" />

          <div v-if="catalogLoading" class="text-sm text-muted-foreground py-4 text-center">Načítavam katalóg…</div>
          <div v-else class="max-h-[38vh] lg:max-h-[50vh] overflow-y-auto border rounded-md p-2 grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-x-6 gap-y-0.5">
            <label
              v-for="cp in catalogFiltered"
              :key="cp.id"
              class="flex items-center gap-2 p-1.5 rounded hover:bg-muted cursor-pointer"
              data-testid="cycle-catalog-row"
            >
              <input type="checkbox" class="rounded" :checked="catalogPicked.includes(cp.id)" @change="toggleCatalogPick(cp.id)" />
              <span class="text-sm flex-1">{{ cp.name }}</span>
              <Badge v-if="cp.purpose" variant="outline" class="text-xs">{{ cp.purpose }}</Badge>
              <span v-if="cp.status === 'retired'" class="text-xs text-amber-700">vyradená</span>
            </label>
            <div v-if="catalogFiltered.length === 0" class="text-sm text-muted-foreground text-center py-2 lg:col-span-2 2xl:col-span-3">
              Žiadne produkty v katalógu
            </div>
          </div>

          <div class="text-sm" data-testid="cycle-catalog-summary">
            Vybraných: <span class="font-medium">{{ catalogPicked.length }}</span>
            <span v-if="catalogAddedCount" class="text-green-700"> · pridá sa {{ catalogAddedCount }}</span>
            <span v-if="catalogRemovedCount" class="text-destructive"> · odstráni sa {{ catalogRemovedCount }}</span>
          </div>

          <Alert v-if="catalogError" variant="destructive" data-testid="cycle-catalog-error">
            <AlertDescription>{{ catalogError }}</AlertDescription>
          </Alert>

          <Alert v-if="catalogResult?.removed_with_orders?.length" data-testid="cycle-catalog-warning">
            <AlertDescription>
              <span class="font-medium">Pozor:</span> odstránené produkty, ktoré už niekto objednal:
              {{ catalogResult.removed_with_orders.map(r => r.name).join(', ') }}.
              Objednávky zostávajú nezmenené, produkt sa len prestal ponúkať.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" :disabled="catalogSaving" @click="showCatalogPicker = false">Zavrieť</Button>
          <Button :disabled="catalogSaving || catalogLoading" data-testid="cycle-catalog-save" @click="saveCatalogPicker">
            {{ catalogSaving ? 'Ukladám…' : 'Uložiť výber' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
</template>
