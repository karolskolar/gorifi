<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watchEffect, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import api, { getFriendsPassword, getFriendsAuthInfo, getFriendsToken } from '../api'
// ⚠ 04 §UC-FO-001's "all shadcn imports removed from this view" is now CLOSED.
// RD-FO-1 took `Alert`/`Badge`/`Tabs*`, RD-FO-2 the product cards' `Card`,
// RD-FO-3 the cart footer's `Button`, RD-FO-5 the four `Dialog`s (every modal on
// this screen is `NeoModal`, 02 §UC-DS-010) — and the last three,
// `Card`/`CardContent`/`Button`, dressed the Kolegovia share card, which is
// module 05's surface and therefore had to wait for RD-KG-1. They are gone with
// it. Nothing under `@/components/ui/` is imported here any more; keep it that
// way (02 §UC-DS-004 rule 4 makes shadcn admin-only).
import GuestShareDialog from '@/components/GuestShareDialog.vue'
import GuestSubOrders from '@/components/GuestSubOrders.vue'
import BrandChrome from '@/components/neo/BrandChrome.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoStepper from '@/components/neo/NeoStepper.vue'
import NeoModal from '@/components/neo/NeoModal.vue'
import NeoCheckbox from '@/components/neo/NeoCheckbox.vue'
import { snapTab } from '@/lib/snap-tab'
import { itemsLabel } from '@/lib/plural'
import CartLineList from '@/components/CartLineList.vue'
import CatScrollArrow from '@/components/CatScrollArrow.vue'
import PaymentModal from '@/components/PaymentModal.vue'
import { encode as bysquareEncode, PaymentOptions, CurrencyCode, Version } from 'bysquare'
import QRCode from 'qrcode'

const route = useRoute()
const router = useRouter()

// Cycle/friend data
const friend = ref(null)
const cycle = ref(null)
const products = ref([])
const order = ref(null)
const cart = ref({}) // { productId-variant: quantity }
const lastSubmittedCart = ref(null) // Snapshot of cart at last submission

// UI state
const loading = ref(true)
const saving = ref(false)
const error = ref('')
// ⚠ `successMessage` ("Košík bol uložený") was RETIRED here, not repaired.
// RD-FO-1 instrumented it and left the choice to this row (04 §UC-FO-009 owns the
// cartbar's messaging). The facts it recorded: `saveCart(false)` was the ONLY
// writer, `doSubmitOrder()` its only non-silent caller (auto-save and cancel pass
// `silent: true` deliberately), so the banner never reported a user-initiated
// save — and after a FAILED submit it rendered "Košík bol uložený" next to the
// error banner for 3s. Giving it a trigger was explicitly ruled out; clearing it
// in `doSubmitOrder()` would have left a ref, a timeout and a banner that no
// reachable state ever shows. So it is gone: the ref, the two writes in
// `saveCart`, and the page banner.
const activeTab = ref('Espresso')
const showSuccessModal = ref(false)
// ⚠ `successModalMessage` ("Vaša objednávka bola úspešne odoslaná!" /
// "…bola aktualizovaná!") is RETIRED, for the same reason `successMessage` was one
// row earlier: 04 resolved conflict #4 gives the success modal ONE subtitle on both
// paths — "Objednávka bola odoslaná. Môžete ju upraviť až do uzamknutia cyklu." —
// so the ref had a writer, a reader and no remaining variation to carry.
// `wasAlreadySubmitted` in `doSubmitOrder()` went with it; nothing else read it.
const showCancelModal = ref(false)
const initialLoadComplete = ref(false) // Prevents auto-save during initial load
const showLeaveModal = ref(false) // Confirmation modal when leaving with unsaved changes
const pendingNavigation = ref(null) // Store pending navigation path
const leaveConfirmed = ref(false) // Flag to bypass navigation guard after confirming leave
const changesNotificationDismissed = ref(false) // Track if "changes not saved" notification was dismissed

// Stock availability state
const availability = ref({}) // { productId: { stock_limit_g, ordered_g, remaining_g } }

// Variant weight map in grams
const variantGrams = { '150g': 150, '200g': 200, '250g': 250, '500g': 500, '1kg': 1000, '20pc5g': 100 }

// Pickup location state
const pickupLocations = ref([])
const showPickupModal = ref(false)
const selectedPickupLocationId = ref(null) // null = "Iné"
const pickupLocationNote = ref('')

// Parcel delivery state
const deliveryMethod = ref('pickup') // 'pickup' or 'packeta'
const packetaAddress = ref('')
// ⚠ Default UNCHECKED (04 resolved conflict #11). The prototype renders
// `<Checkbox checked={true}>`, which is a demo constant, not a rule: silently
// rewriting the friend's stored profile default from an order-time modal is the
// wrong default for a persistent setting. `submitOrder()` re-clears it on every
// open, so a previous tick never carries into the next order.
const savePacketaAsDefault = ref(false)

// ---- 04 §UC-FO-010, the 4-scenario matrix, named ONCE ------------------------
//
// `submitOrder()` decides whether a modal opens at all from exactly these two
// facts, and the modal's own body decides which sections it shows from them too.
// They were duplicated as locals in `submitOrder()` and as inline `pickupLocations
// .length > 0 && cycle?.parcel_enabled` tests in the template, i.e. three copies of
// one rule; the routing and the rendering are now provably the same predicate.
//
//   locations | parcel | modal
//   ----------+--------+------------------------------------------------------
//     no      |  no    | NO MODAL — submitOrder() calls doSubmitOrder() directly
//     yes     |  no    | pickup section only, NO method radios
//     no      |  yes   | method radios: Packetou / "Bez doručenia…" (repo copy)
//     yes     |  yes   | method radios: Osobný odber / Doručenie Packetou (+fee)
const hasPickupLocations = computed(() => pickupLocations.value.length > 0)
const hasParcelDelivery = computed(() => !!cycle.value?.parcel_enabled)

// The method RadioRows, in the shipped order for each scenario — an empty list IS
// the "pickup only" row of the matrix, so the template needs no scenario test of
// its own beyond `v-if="deliveryMethodOptions.length"`.
//
// ⚠ The parcel-only pair keeps the REPO's second option, "Bez doručenia (vyzdvihnem
// osobne)", not the "Osobný odber" of the both-scenario: with no locations
// configured there is nothing to pick FROM, so the honest label is the opt-out.
// 04 §UC-FO-010's table pins that copy explicitly.
const deliveryMethodOptions = computed(() => {
  if (!hasParcelDelivery.value) return []
  const packeta = { value: 'packeta', label: 'Doručenie Packetou', fee: true }
  return hasPickupLocations.value
    ? [{ value: 'pickup', label: 'Osobný odber', fee: false }, packeta]
    : [packeta, { value: 'pickup', label: 'Bez doručenia (vyzdvihnem osobne)', fee: false }]
})

// Locations + the trailing "Iné" (`null`), so the pickup section is ONE `v-for`
// over one RadioRow markup rather than a loop plus a hand-copied last row.
const pickupOptions = computed(() => [
  ...pickupLocations.value.map((loc) => ({ value: loc.id, label: loc.name, sub: loc.address || '' })),
  { value: null, label: 'Iné', sub: '' }
])

// Payment state
const paymentIban = ref('')
const paymentRevolutUsername = ref('')
const showPaymentModal = ref(false)
const successQrDataUrl = ref(null)
const hasPaymentSettings = computed(() => !!(paymentIban.value || paymentRevolutUsername.value))
const paymentReference = computed(() => {
  const friendName = friend.value?.name || ''
  const cycleName = cycle.value?.name || ''
  return `${friendName} / ${cycleName}`
})

// Guest share link — all state/logic lives in GuestShareDialog, shared with
// FriendPortal's cycle list so both entry points behave identically.
const showShareModal = ref(false)

// ---- top-level view switch: own order vs colleagues ---------------------------
//
// Everything guest-related used to sit ABOVE the product list, so the host's own
// offer started ~860px down the page and got worse with every colleague who
// ordered. The two jobs — ordering for myself, handing goods to colleagues — now
// live on their own tabs.
//
// ⚠ The panels are v-show, NOT v-if: GuestSubOrders must stay mounted on both tabs
// or its badge count would only appear after the host already opened the tab it is
// meant to advertise. It also keeps the hand-over ticks from re-fetching on every
// switch.
//
// Deliberately NOT persisted and NOT in the URL: a locked cycle opens on 'own' too,
// even though hand-over is the only job left then — the host still wants to see
// what they themselves ordered first (confirmed with the user).
const mainTab = ref('own')

// Fed by GuestSubOrders (one fetch, one owner) — see its `summary` emit.
//
// ⚠ Two DIFFERENT questions live in here and must not be conflated (05 §UC-KG-001
// rule 5 / resolved conflict 6):
//   · `count` / `pendingDelivery` — cancelled-EXCLUDED. They are money and work:
//     how many colleagues owe/are owed something. The tab badge below is computed
//     from these two and is NOT re-gated on `rows`.
//   · `rows` — ALL rows, cancelled included. Purely "is there a list on screen?",
//     and the only thing the panel's state machine below may ask. Gating the panel
//     on `count` stacked a "Zatiaľ nikto" CTA card directly above visible
//     cancelled cards.
// Seeded with `rows: 0` so the empty state is correct on the very first paint,
// before the child's `watchEffect` has emitted.
const guestSummary = ref({ count: 0, total: 0, pendingDelivery: 0, failed: false, rows: 0 })

const cycleId = computed(() => route.params.cycleId)

const isLocked = computed(() => cycle.value?.status === 'planned' || cycle.value?.status === 'locked' || cycle.value?.status === 'completed')
const isSubmitted = computed(() => order.value?.status === 'submitted')
const markupRatio = computed(() => cycle.value?.markup_ratio || 1.0)
const isBakery = computed(() => cycle.value?.type === 'bakery')

// Amber (`.tabbadge.pending`) only when the host actually owes someone an action:
// the cycle is locked, so the goods have arrived, and somebody has not been handed
// theirs yet. The plain white/ink `.tabbadge` with the colleague count is the
// resting state; no badge at all when nobody has ordered.
// (Declared after isLocked so the dependency reads in source order.)
//
// ⚠ These two computeds are OWNED BY THIS VIEW and are never re-derived in the
// Kolegovia panel (module 05): the badge must be right before its tab is opened,
// which is only possible from the parent, off `GuestSubOrders`' `summary` emit.
// The prototype always renders the amber pending badge, even on an open cycle
// (04 resolved conflict #1) — shipped semantics win, prototype visuals win.
const guestBadgeIsPending = computed(
  () => isLocked.value && guestSummary.value.pendingDelivery > 0
)
const guestBadgeCount = computed(
  () => guestBadgeIsPending.value ? guestSummary.value.pendingDelivery : guestSummary.value.count
)

// Check if there are unsaved changes that would be lost on leaving:
// 1. Order is submitted but cart differs from last submission
// 2. No order exists but cart has items (items not saved yet)
const hasUnsavedChanges = computed(() => {
  // Case 1: No order exists but cart has items - these would be lost
  if (!order.value && cartItems.value.length > 0) {
    return true
  }

  // Case 2: Order is submitted but cart differs from last submission
  if (isSubmitted.value && lastSubmittedCart.value) {
    const currentKeys = Object.keys(cart.value).filter(k => cart.value[k] > 0)
    const lastKeys = Object.keys(lastSubmittedCart.value).filter(k => lastSubmittedCart.value[k] > 0)
    if (currentKeys.length !== lastKeys.length) return true
    for (const key of currentKeys) {
      if (cart.value[key] !== lastSubmittedCart.value[key]) return true
    }
  }

  return false
})

// Alias for backward compatibility with existing template references
const hasUnsubmittedChanges = computed(() => {
  // For the status notification, only show when order is submitted but has changes
  if (!isSubmitted.value || !lastSubmittedCart.value) return false
  const currentKeys = Object.keys(cart.value).filter(k => cart.value[k] > 0)
  const lastKeys = Object.keys(lastSubmittedCart.value).filter(k => lastSubmittedCart.value[k] > 0)
  if (currentKeys.length !== lastKeys.length) return true
  for (const key of currentKeys) {
    if (cart.value[key] !== lastSubmittedCart.value[key]) return true
  }
  return false
})

const cartItems = computed(() => {
  const items = []
  const ratio = markupRatio.value
  for (const [key, quantity] of Object.entries(cart.value)) {
    if (quantity > 0) {
      const [productId, variant] = key.split('-')
      const product = products.value.find(p => p.id === parseInt(productId))
      if (product) {
        let basePrice
        if (variant === 'unit') basePrice = product.price_unit
        else if (variant === '1kg') basePrice = product.price_1kg
        else if (variant === '500g') basePrice = product.price_500g
        else if (variant === '20pc5g') basePrice = product.price_20pc5g
        else if (variant === '150g') basePrice = product.price_150g
        else if (variant === '200g') basePrice = product.price_200g
        else basePrice = product.price_250g
        // Apply markup ratio to get final price
        const price = Math.round(basePrice * ratio * 100) / 100
        items.push({
          key,
          product_id: parseInt(productId),
          product_name: product.name,
          variant_label: product.variant_label || null,
          purpose: product.purpose || 'Ostatné',
          variant,
          quantity,
          price,
          total: price * quantity
        })
      }
    }
  }
  return items
})

// The cart lines in `CartLineList`'s normalized shape. Grouping, columns, the
// ellipsis and the `€` all live in that component now — it is the ONE home for this
// list on every screen (product decision 2026-08-12), and the grouping it does
// reverses 04 resolved conflict #10's flat list.
//
// Only the MAPPING is this view's business: `lineSize` is the shipped
// `variant_label` / 'ks' / raw-variant-key rule (04 §UC-FO-009) and `item.total` is
// already marked up by `cartItems`.
const cartLines = computed(() => cartItems.value.map((item) => ({
  key: item.key,
  name: item.product_name,
  purpose: item.purpose,
  size: lineSize(item),
  quantity: item.quantity,
  amount: item.total,
})))

// `orders.delivery_fee` is a field ON the order and never an `order_items` line
// (CLAUDE.md 2026-05-01), so it is an EXTRA rather than an item: no purpose header,
// no quantity, no size — just a name and an amount in the same column.
const cartExtraLines = computed(() => (
  order.value?.delivery_fee
    ? [{ key: 'delivery', name: 'Doručenie Packetou', amount: order.value.delivery_fee }]
    : []
))

// The cart line's size label — the shipped logic verbatim (04 §UC-FO-009):
// `variant_label` when the snapshot carries one (bakery variants), 'ks' for the
// zero-gram `'unit'` variant, else the raw variant key ('250g', '20pc5g', …),
// which is what the pre-redesign template printed inline.
function lineSize(item) {
  if (item.variant_label) return item.variant_label
  return item.variant === 'unit' ? 'ks' : item.variant
}

const cartTotal = computed(() => {
  return cartItems.value.reduce((sum, item) => sum + item.total, 0)
})

// Total including delivery fee (for payment)
const paymentTotal = computed(() => {
  const deliveryFee = order.value?.delivery_fee || 0
  return cartTotal.value + deliveryFee
})

const groupedProducts = computed(() => {
  const groups = {}
  for (const product of products.value) {
    const type = product.purpose || 'Ostatne'
    if (!groups[type]) groups[type] = []
    groups[type].push(product)
  }
  return groups
})

const groupedBakeryProducts = computed(() => {
  if (!isBakery.value) return groupedProducts.value

  const result = {}
  for (const [purpose, purposeProducts] of Object.entries(groupedProducts.value)) {
    const groups = []
    const seen = new Set()
    for (const product of purposeProducts) {
      const groupKey = product.source_bakery_product_id || product.id
      if (seen.has(groupKey)) continue
      seen.add(groupKey)

      // Find all products with same source_bakery_product_id
      const variants = purposeProducts.filter(p =>
        p.source_bakery_product_id && p.source_bakery_product_id === product.source_bakery_product_id
      )

      if (variants.length > 1) {
        // Multi-variant product: first variant provides the card info
        groups.push({ ...variants[0], _variants: variants })
      } else {
        // Single product (no grouping needed)
        groups.push({ ...product, _variants: [product] })
      }
    }
    result[purpose] = groups
  }
  return result
})

// The coffee card's variant boxes, in 04 §UC-FO-005's FIXED order — one `.vbox`
// per non-null price field. This replaces the old "capsules XOR weights" split:
// the template used to render `price_20pc5g` in its own single-column grid and
// then hide EVERY weight variant behind `v-if="!product.price_20pc5g"`, so a
// product priced for both would have shown only the capsules. Under the new rule
// a `20pc5g`-only product is simply a one-variant grid, and a mixed product shows
// all of its variants (04 §UC-FO-005 business rules).
//
// ⚠ The `variant` keys are the CART keys and are also the keys of `variantGrams`
// and of the server's `order_items.variant` — they are not display strings and
// must not be "tidied". Only `label` is presentational (`20pc5g` → "20 ks × 5g").
const COFFEE_VARIANTS = [
  { field: 'price_150g', variant: '150g', label: '150g' },
  { field: 'price_200g', variant: '200g', label: '200g' },
  { field: 'price_250g', variant: '250g', label: '250g' },
  { field: 'price_500g', variant: '500g', label: '500g' },
  { field: 'price_1kg', variant: '1kg', label: '1kg' },
  { field: 'price_20pc5g', variant: '20pc5g', label: '20 ks × 5g' }
]

function coffeeVariants(product) {
  const out = []
  for (const v of COFFEE_VARIANTS) {
    const price = product[v.field]
    if (price) out.push({ variant: v.variant, label: v.label, price })
  }
  return out
}

// Grams → the prototype's kg copy (04 §UC-FO-006, resolved conflict #6: repo gram
// MATH, kg DISPLAY). Up to 2 decimals, trailing zeros stripped, dot decimal:
// 250 → "0.25 kg", 1000 → "1 kg", 1250 → "1.25 kg". `Number#toString` gives the
// stripping and the dot for free; `toFixed(2)` would render "1.00 kg".
function kg(grams) {
  return `${Math.round((grams || 0) / 10) / 100} kg`
}

// The bar's fill. Deliberately derived from `getRemainingGrams` — i.e. it INCLUDES
// the friend's own uncommitted cart, exactly as the shipped bar did — so emptying
// a variant walks the fill back live. The `limit > 0` guard only keeps a 0/NULL
// limit out of the style binding as NaN; availability rows only exist for products
// that have one.
function stockPct(productId) {
  const avail = availability.value[productId]
  const limit = avail?.stock_limit_g
  if (!limit || limit <= 0) return 0
  const remaining = getRemainingGrams(productId)
  return Math.min(100, ((limit - remaining) / limit) * 100)
}

// The single bridge from `NeoStepper`'s absolute v-model to the shipped cart
// mutators. 02 §UC-DS-008 forbids a `max` in the primitive, so the stock ceiling
// has to live HERE: routing an increase through `increment()` is what keeps
// `canIncrement()` in the path. Binding `setQuantity` directly would have handed
// the stepper an unchecked write and silently retired the ceiling.
//
// The stepper only ever emits ±1; a larger jump is clamped to one step rather
// than trusted, so no future change to the primitive can widen this hole.
function onQty(productId, variant, next) {
  const current = getQuantity(productId, variant)
  if (next > current) increment(productId, variant)
  else if (next < current) decrement(productId, variant)
}

const availablePurposes = computed(() => {
  // Order: Espresso, Filter, Kapsule, then others
  const order = ['Espresso', 'Filter', 'Kapsule']
  const purposes = Object.keys(groupedProducts.value)
  const sorted = []
  for (const p of order) {
    if (purposes.includes(p)) sorted.push(p)
  }
  for (const p of purposes) {
    if (!order.includes(p)) sorted.push(p)
  }
  return sorted
})

// The cards of the ACTIVE purpose only — one list, rendered under the strip.
//
// This replaces the radix `TabsContent` panels AND the "only one purpose, so no
// strip" fallback, which were two byte-divergent copies of the same card markup
// (the fallback's had no roast/roastery badges and no `canIncrement` guard on
// "+", so a single-purpose cycle could be stepped past its stock limit in the UI).
// Same one-visible-at-a-time behaviour, one card to restyle in RD-FO-2.
const activeProducts = computed(() => {
  const source = isBakery.value ? groupedBakeryProducts.value : groupedProducts.value
  return source[activeTab.value] || []
})

// Set active tab to first available purpose when products load
watch(availablePurposes, (purposes) => {
  if (purposes.length > 0 && !purposes.includes(activeTab.value)) {
    activeTab.value = purposes[0]
  }
}, { immediate: true })

const STORAGE_KEY = 'gorifi_friend_auth'

onMounted(async () => {
  // Check if authenticated (token or password)
  if (!getFriendsToken() && !getFriendsPassword()) {
    // Try to restore from localStorage
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) {
      router.push('/')
      return
    }
    try {
      const parsed = JSON.parse(stored)
      if (!parsed.token && !parsed.password) {
        router.push('/')
        return
      }
      // Auth will be restored by FriendPortal, redirect there
      router.push('/')
      return
    } catch {
      router.push('/')
      return
    }
  }

  await loadOrderData()

  // Load pickup locations and payment settings
  try {
    const [locations, paymentSettings] = await Promise.all([
      api.getPickupLocations(cycle.value?.type || 'coffee'),
      api.getPaymentSettings()
    ])
    pickupLocations.value = locations
    paymentIban.value = paymentSettings.paymentIban || ''
    paymentRevolutUsername.value = paymentSettings.paymentRevolutUsername || ''
  } catch (e) {
    // Non-critical, proceed without locations/payment
  }
})

// Set page title
watchEffect(() => {
  document.title = cycle.value?.name ? `${cycle.value.name} - Objednávka` : 'Objednávka'
})

async function loadOrderData() {
  loading.value = true
  error.value = ''

  try {
    // Get friend info from localStorage or in-memory auth
    let friendId = null
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      friendId = parsed.friendId
    } else {
      // Try in-memory auth info (when "remember me" was not checked)
      const authInfo = getFriendsAuthInfo()
      if (authInfo) {
        friendId = authInfo.friendId
      }
    }

    if (!friendId) {
      router.push('/')
      return
    }

    // Get order data
    const orderData = await api.getOrderByFriend(cycleId.value, friendId)
    order.value = orderData.order
    cycle.value = orderData.cycle
    friend.value = orderData.friend

    // Get products and availability
    products.value = await api.getProducts(cycleId.value)
    await loadAvailability(friendId)

    // Populate cart from existing order items
    cart.value = {}
    for (const item of orderData.items) {
      cart.value[`${item.product_id}-${item.variant}`] = item.quantity
    }

    // If order is already submitted, store snapshot for change detection
    if (orderData.order?.status === 'submitted') {
      lastSubmittedCart.value = { ...cart.value }
    } else {
      lastSubmittedCart.value = null
    }

    // Mark initial load as complete after a short delay
    // This prevents auto-save from triggering during initial data population
    setTimeout(() => {
      initialLoadComplete.value = true
    }, 100)
  } catch (e) {
    error.value = e.message
    // If auth error, redirect to portal
    if (e.message.includes('heslo') || e.message.includes('Heslo')) {
      setTimeout(() => router.push('/'), 2000)
    }
  } finally {
    loading.value = false
  }
}

async function loadAvailability(friendId) {
  try {
    const data = await api.getProductAvailability(cycleId.value, friendId)
    const map = {}
    for (const item of data) {
      map[item.product_id] = item
    }
    availability.value = map
  } catch (e) {
    // Non-critical, proceed without availability data
  }
}

// Get grams of a product currently in the friend's cart
function getCartGramsForProduct(productId) {
  let grams = 0
  for (const [key, qty] of Object.entries(cart.value)) {
    if (qty <= 0) continue
    const [pid, variant] = key.split('-')
    if (parseInt(pid) === productId) {
      grams += (variantGrams[variant] || 0) * qty
    }
  }
  return grams
}

// Check if adding one more of this variant would exceed stock limit
function canIncrement(productId, variant) {
  const avail = availability.value[productId]
  if (!avail) return true // No stock limit
  const cartGrams = getCartGramsForProduct(productId)
  const addGrams = variantGrams[variant] || 0
  return (avail.remaining_g - cartGrams - addGrams) >= 0
}

// Get remaining grams available for a product (accounting for cart)
function getRemainingGrams(productId) {
  const avail = availability.value[productId]
  if (!avail) return null
  return Math.max(0, avail.remaining_g - getCartGramsForProduct(productId))
}

function goBack() {
  // If there are unsaved changes, show confirmation modal
  if (hasUnsavedChanges.value) {
    pendingNavigation.value = '/'
    showLeaveModal.value = true
    return
  }
  router.push('/')
}

function confirmLeave() {
  showLeaveModal.value = false
  leaveConfirmed.value = true // Bypass navigation guard
  if (pendingNavigation.value) {
    router.push(pendingNavigation.value)
    pendingNavigation.value = null
  }
}

function cancelLeave() {
  showLeaveModal.value = false
  pendingNavigation.value = null
}

// Navigation guard - warn when leaving with unsaved changes
onBeforeRouteLeave((to, from, next) => {
  if (leaveConfirmed.value) {
    leaveConfirmed.value = false // Reset for next time
    next() // Allow navigation after user confirmed
  } else if (hasUnsavedChanges.value && !showLeaveModal.value) {
    pendingNavigation.value = to.fullPath
    showLeaveModal.value = true
    next(false) // Cancel navigation
  } else {
    next() // Allow navigation
  }
})

function getCartKey(productId, variant) {
  return `${productId}-${variant}`
}

function getQuantity(productId, variant) {
  return cart.value[getCartKey(productId, variant)] || 0
}

function setQuantity(productId, variant, quantity) {
  if (isLocked.value) return
  const key = getCartKey(productId, variant)
  if (quantity <= 0) {
    delete cart.value[key]
  } else {
    cart.value[key] = quantity
  }
  cart.value = { ...cart.value } // trigger reactivity
}

function increment(productId, variant) {
  if (isLocked.value) return
  if (!canIncrement(productId, variant)) return
  const current = getQuantity(productId, variant)
  setQuantity(productId, variant, current + 1)
}

function decrement(productId, variant) {
  if (isLocked.value) return
  const current = getQuantity(productId, variant)
  if (current > 0) {
    setQuantity(productId, variant, current - 1)
  }
}

// Auto-save debounce timer
let autoSaveTimeout = null
const autoSaving = ref(false)

async function saveCart(silent = false) {
  if (isLocked.value) return
  if (!friend.value) return

  if (!silent) saving.value = true
  else autoSaving.value = true

  error.value = ''

  try {
    const items = cartItems.value.map(item => ({
      product_id: item.product_id,
      variant: item.variant,
      quantity: item.quantity
    }))

    const result = await api.updateOrderByFriend(cycleId.value, friend.value.id, items)
    order.value = result.order
  } catch (e) {
    error.value = e.message
  } finally {
    if (!silent) saving.value = false
    else autoSaving.value = false
  }
}

// Auto-save cart when it changes (debounced) - only for existing draft orders
watch(cart, () => {
  // Reset the "changes not saved" notification dismissed state when cart changes
  // This ensures the notification reappears if user makes more changes after dismissing
  changesNotificationDismissed.value = false

  // Skip auto-save during initial load, when locked, when order is already submitted,
  // or when there's no existing order (don't auto-create orders, only auto-save existing drafts)
  // New orders are only created when user explicitly submits
  if (!initialLoadComplete.value || isLocked.value || !friend.value || isSubmitted.value || !order.value) return

  // Clear previous timeout
  if (autoSaveTimeout) clearTimeout(autoSaveTimeout)

  // Debounce: save after 500ms of no changes
  autoSaveTimeout = setTimeout(() => {
    saveCart(true)
  }, 500)
}, { deep: true })

function cancelOrder() {
  if (isLocked.value) return
  showCancelModal.value = true
}

async function confirmCancelOrder() {
  showCancelModal.value = false

  // Clear the cart
  cart.value = {}

  // Only save if there's an existing order to delete
  // If there's no order yet (user just added items without saving), no need to save
  if (order.value) {
    await saveCart(true)
  }

  // Reset the snapshot since we've now saved an empty cart
  // This prevents the "unsaved changes" warning from showing
  lastSubmittedCart.value = {}

  // Mark as confirmed to bypass navigation guard
  leaveConfirmed.value = true

  // Redirect back to cycle list
  router.push('/')
}

async function submitOrder() {
  if (isLocked.value) return
  if (cartItems.value.length === 0) {
    error.value = 'Košík je prázdny'
    return
  }

  // Scenario 1 of the matrix: nothing to ask, so nothing is asked.
  if (!hasPickupLocations.value && !hasParcelDelivery.value) {
    await doSubmitOrder()
    return
  }

  // ⚠ EVERY other explicit submit opens the modal — the first one AND every
  // "Aktualizovať" (README §Interactions / 04 §UC-FO-010 Routing). The prototype's
  // "later submits are direct" means "do not re-ASK what is already answered", and
  // the pre-selection below is what satisfies it: a re-submit opens with the
  // previous choice already selected and is one tap. Skipping the modal instead
  // would make the delivery method un-changeable after the first submit.

  // Re-cleared on every open (04 resolved conflict #11) — a tick on one submit must
  // not silently persist the NEXT submit's address to the profile.
  savePacketaAsDefault.value = false

  // Pre-select based on existing order state
  if (order.value?.packeta_address) {
    deliveryMethod.value = 'packeta'
    packetaAddress.value = order.value.packeta_address
  } else if (order.value?.pickup_location_id) {
    deliveryMethod.value = 'pickup'
    selectedPickupLocationId.value = order.value.pickup_location_id
    pickupLocationNote.value = ''
    packetaAddress.value = friend.value?.packeta_address || ''
  } else if (order.value?.pickup_location_note) {
    deliveryMethod.value = 'pickup'
    selectedPickupLocationId.value = null
    pickupLocationNote.value = order.value.pickup_location_note
    packetaAddress.value = friend.value?.packeta_address || ''
  } else {
    // Default: pickup if locations exist, otherwise packeta
    deliveryMethod.value = hasPickupLocations.value ? 'pickup' : 'packeta'
    selectedPickupLocationId.value = null
    pickupLocationNote.value = ''
    packetaAddress.value = friend.value?.packeta_address || ''
  }

  showPickupModal.value = true
}

async function doSubmitOrder() {
  // First save the cart
  await saveCart()

  saving.value = true
  error.value = ''

  try {
    const pickupData = deliveryMethod.value === 'packeta'
      ? {
          use_parcel_delivery: true,
          packeta_address: packetaAddress.value.trim(),
          pickup_location_id: null,
          pickup_location_note: null
        }
      : {
          use_parcel_delivery: false,
          pickup_location_id: selectedPickupLocationId.value || null,
          pickup_location_note: selectedPickupLocationId.value ? null : (pickupLocationNote.value || null)
        }
    const result = await api.submitOrderByFriend(cycleId.value, friend.value.id, pickupData)
    order.value = result.order
    // Store snapshot of submitted cart for change detection
    lastSubmittedCart.value = { ...cart.value }
    showSuccessModal.value = true
    generateSuccessQr()
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function generateSuccessQr() {
  if (!paymentIban.value) return
  try {
    const today = new Date()
    const dateStr = today.getFullYear().toString()
      + (today.getMonth() + 1).toString().padStart(2, '0')
      + today.getDate().toString().padStart(2, '0')

    const qrString = bysquareEncode({
      invoiceId: '',
      payments: [{
        type: PaymentOptions.PaymentOrder,
        amount: paymentTotal.value,
        currencyCode: CurrencyCode.EUR,
        paymentDueDate: dateStr,
        variableSymbol: '',
        constantSymbol: '',
        specificSymbol: '',
        originatorsReferenceInformation: '',
        paymentNote: paymentReference.value || '',
        bankAccounts: [{ iban: paymentIban.value.replace(/\s/g, ''), bic: '' }],
        beneficiary: { name: 'Gorifi', street: '', city: '' }
      }]
    }, { version: Version['1.0.0'] })
    successQrDataUrl.value = await QRCode.toDataURL(qrString, { errorCorrectionLevel: 'M', width: 256, margin: 2 })
  } catch (e) {
    console.error('QR generation failed:', e)
  }
}

async function confirmPickupAndSubmit() {
  // Optionally save Packeta address to profile
  if (deliveryMethod.value === 'packeta' && savePacketaAsDefault.value && packetaAddress.value.trim()) {
    try {
      await api.updateFriendProfile(friend.value.id, {
        packeta_address: packetaAddress.value.trim()
      })
    } catch (e) {
      // Non-critical, proceed with order
    }
  }
  showPickupModal.value = false
  doSubmitOrder()
}

function handleSuccessModalClose() {
  showSuccessModal.value = false
  leaveConfirmed.value = true // Bypass navigation guard
  router.push('/')
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

function applyMarkup(price) {
  if (!price) return null
  return Math.round(price * markupRatio.value * 100) / 100
}
</script>

<template>
  <!-- ⚠ `.app` brings `.app > * { position:relative; z-index:1 }` with it, which
       NEUTRALISES every Tailwind positioning utility on a DIRECT child — `fixed`,
       `absolute`, `sticky`, and even `relative z-10` (whose z-index is silently
       clamped). It fails silently: no build error, no failing spec. Two live
       consequences on this screen, both handled here:
         · the old `<header … sticky top-0 z-40>` was a direct child and would have
           un-stuck the moment this class landed — it is GONE, replaced by the
           deliberately non-sticky `BrandChrome` (UC-DS-005/006);
         · the purpose strip's old `top-16` was calibrated against that sticky
           header. `.cat-tabs` is `top:0` from the theme, which is now correct
           because nothing above it is pinned any more.
       The cart footer USED to be a nested `fixed bottom-0 z-50` div, kept inside
       the page column precisely so `.app > *` could not reach it. RD-FO-3 hoisted
       it to a direct child on the THEME class `.cartbar`, which survives because
       the theme's rule is declared later than `.app>*` at equal specificity — see
       the long note on the bar itself, near the end of this template.

       `flex flex-col` + the theme's `min-height:100vh` is the prototype's root
       layout, and it is what lets the page column take `flex-1`. -->
  <div class="app flex flex-col">
    <!-- Brand chrome (UC-FO-001): appbar + hazard tape + ticker, full-bleed, NOT
         sticky — it scrolls away and `.cat-tabs` owns the top edge alone.

         Subtitle is the friend's NAME ONLY. The prototype's appbar shows
         "Lego · X42KPGZZ", but `GET /orders/cycle/:id/friend/:id` returns only
         `{id, name, packeta_address}`, `friends.js` strips `invite_code` from every
         friend response, and no API change is in scope. The session's uid — which
         module 03's portal appbar uses — is OPTIONAL in the stored auth shape, so
         sourcing it here would render "name · code" for some friends and a bare
         name for others. Consistency wins (orchestrator decision, 2026-08-08).

         The back chevron carries the house zero-pixel ARIA layer (role + tabindex
         + Enter/Space): it is a bare `<span>` in the prototype, and it is the only
         in-page route back to the cycle list — the control it replaced was a real
         `<button>`, so leaving it pointer-only would be a regression. Its label is
         "Späť", NOT "Späť na zoznam cyklov": the fatal-error state renders a button
         with that exact text, and Playwright matches accessible names as a
         case-insensitive SUBSTRING unless `exact: true`. -->
    <BrandChrome
      :title="cycle?.name || ''"
      :subtitle="friend?.name || ''"
      :ticker="isLocked
        ? '+++ OBJEDNÁVKY UZAMKNUTÉ +++ DRŽ JAZYK ZA ZUBAMI +++'
        : '+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++'"
    >
      <template #leading>
        <span
          class="back"
          role="button"
          tabindex="0"
          aria-label="Späť"
          @click="goBack"
          @keydown.enter.prevent="goBack"
          @keydown.space.prevent="goBack"
        >
          <NeoIcon name="back" />
        </span>
      </template>
      <template #trailing>
        <span v-if="isLocked" class="chip" title="Objednávky sú uzamknuté">
          <NeoIcon name="lock" />
        </span>
        <span v-else class="chip acc">Otvorené</span>
      </template>
    </BrandChrome>

    <!-- Loading -->
    <div v-if="loading" class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7">
      <div class="sub" style="text-align:center;padding:32px 0">Načítavam...</div>
    </div>

    <!-- Fatal error (no friend loaded at all) -->
    <div v-else-if="error && !friend" class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7 flex flex-col gap-[14px]">
      <div class="banner danger" role="alert">
        <span class="dot"></span>
        <div style="min-width:0"><b>Chyba:</b> {{ error }}</div>
      </div>
      <div>
        <button type="button" class="btn" @click="goBack">Späť na zoznam cyklov</button>
      </div>
    </div>

    <!-- Order Form.
         The page column is the settled geometry (UC-DS-005): 760px max, centred,
         16px phone / 28px desktop — written as axis utilities, the same idiom as
         `FriendPortalSession.vue`'s column. `pb-2` is repeated at both breakpoints
         so the `sm` layer cannot re-raise it; that 8px bottom is the prototype's
         `paddingBottom: 8` (UC-FO-001 item 3).

         NOTE: the "never use the `p-4` shorthand" rule that guards the portal's
         column does NOT apply on this route. It exists because
         `guest-link.spec.js`'s `cardFor()` locator (`div.p-4` containing a cycle
         heading) would otherwise match the column as well as the cycle card — and
         that locator only ever runs after `page.goto('/')`, i.e. on the PORTAL.
         It is documented where it belongs, in `FriendPortalSession.vue`. Here
         `p-4` would be perfectly legal (UC-DS-004 rule 2 lists it as an allowed
         layout utility); the axis form is kept for consistency, not for a pin. -->
    <div v-else class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7 pb-2 sm:pb-2 flex flex-col gap-[14px] flex-1">
      <!-- Status banner. Exactly one of the two, in the shipped priority order.
           ⚠ The green one now YIELDS while unsent changes exist — the prototype's
           `submitted && !dirty && lines > 0`, whose repo equivalent is
           `hasUnsubmittedChanges`. The cartbar warning carries that state instead
           (RD-FO-3). A handoff UX change, in contract (UC-FO-002). -->
      <div v-if="isLocked" class="banner warn">
        <span class="dot"></span>
        <div style="min-width:0"><b>Objednávky sú uzamknuté.</b> Už nie je možné meniť objednávku.</div>
      </div>
      <div v-else-if="isSubmitted && cartItems.length > 0 && !hasUnsubmittedChanges" class="banner ok">
        <span class="dot"></span>
        <div style="min-width:0"><b>Vaša objednávka bola odoslaná!</b> Stále ju môžete upraviť až do uzamknutia.</div>
      </div>

      <!-- Messages. Page-level, so they sit ABOVE the switch: the order can be
           submitted from the sticky footer on either tab, and a failure the host
           cannot see because they happen to be on the colleagues tab is worse than
           no message at all. -->
      <div v-if="error" class="banner danger slim" role="alert">
        <span class="dot"></span>
        <div style="min-width:0">{{ error }}</div>
      </div>
      <!-- (The "Košík bol uložený" banner that used to sit here is GONE — see the
           `successMessage` note in the script. It had no user-initiated trigger
           and, after a FAILED submit, contradicted the error banner above.) -->

      <!-- Own order ⇄ colleagues. Hand-rolled rather than the Tabs component
           because the panels must stay MOUNTED (v-show) — see mainTab's note — and
           because only the purpose tabs inside may be sticky: two stacked sticky
           bars eat a third of a phone screen.

           ⚠ This must remain the FIRST tablist in the DOM: `mobile-no-h-overflow`
           asserts `scrollWidth − clientWidth <= 0` on `getByRole('tablist').first()`.
           `.tabgroup` is a 1fr/1fr grid with NO scroll affordance, so an
           overflowing label would simply be unreachable.

           ⚠ The fit model is `min₁ + min₂ + gap ≤ content`, NOT "does the label
           fit a half cell". `grid-auto-columns: 1fr` is `minmax(auto, 1fr)`, so
           each track FLOORS at its own min-content and only the surplus is
           shared: "Moja objednávka" legitimately exceeds half the row (136.2px
           against a 133.5px half cell) and the Kolegovia track gives the
           difference back, down to its own min-content.

           And the binding factor is the BADGE — data-dependent width — not the
           label. Measured at 320px (container content box 272px, gap 5px):

             no badge, Figtree ............. 41.3px headroom
             no badge, fallback face ....... 32.5px
             1-digit badge, Figtree ........ 12.3px      ← the shipped state
             1-digit badge, fallback ....... 3.6px
             3-digit badge, fallback ....... overflows by 2px

           So no override is shipped, but the margin is thin and it is the badge
           that spends it. `order-shell.spec.js`'s 320px test renders a real guest
           sub-order and asserts that headroom stays positive — before RD-FO-1's
           review neither it nor `mobile-no-h-overflow.spec.js` had a badge on
           screen at 320px at all, so the tight case was untested.

           If an override is ever needed it goes on `.tabgroup .tab` ONLY, never on
           `.tab` globally (the purpose strip must keep its canon metrics) — and it
           cannot be a Tailwind utility: `.tabgroup .tab` is `(0,2,0)` and
           `friends-theme.css` loads after Tailwind, so it needs a scoped block. -->
      <div class="tabgroup" role="tablist" aria-label="Objednávka alebo kolegovia">
        <span
          class="tab"
          :class="{ on: mainTab === 'own' }"
          role="tab"
          id="tab-own"
          tabindex="0"
          aria-controls="panel-own"
          :aria-selected="mainTab === 'own' ? 'true' : 'false'"
          data-testid="main-tab-own"
          @click="mainTab = 'own'"
          @keydown.enter.prevent="mainTab = 'own'"
          @keydown.space.prevent="mainTab = 'own'"
        >Moja objednávka</span>
        <span
          class="tab"
          :class="{ on: mainTab === 'guests' }"
          role="tab"
          id="tab-guests"
          tabindex="0"
          aria-controls="panel-guests"
          :aria-selected="mainTab === 'guests' ? 'true' : 'false'"
          data-testid="main-tab-guests"
          @click="mainTab = 'guests'"
          @keydown.enter.prevent="mainTab = 'guests'"
          @keydown.space.prevent="mainTab = 'guests'"
        >
          Kolegovia
          <span
            v-if="guestBadgeCount > 0"
            class="tabbadge"
            :class="{ pending: guestBadgeIsPending }"
            data-testid="guest-tab-badge"
            :title="guestBadgeIsPending
              ? 'Toľkým kolegom ste ešte neodovzdali tovar'
              : 'Toľko kolegov si objednalo cez váš odkaz'"
          >{{ guestBadgeCount }}</span>
        </span>
      </div>

      <!-- ============ panel: colleagues ============ -->
      <!-- ⚠ `flex flex-col gap-[14px]` mirrors #panel-own: the prototype's whole
           GuestsPanel is ONE 14px column (share row → heading → cards), and the
           child container repeats the same gap, so the rhythm is continuous across
           the component boundary. `v-show` writes inline `display:none`, which
           beats the `flex` class — order-shell.spec.js reads that inline value. -->
      <div
        v-show="mainTab === 'guests'"
        id="panel-guests"
        role="tabpanel"
        aria-labelledby="tab-guests"
        class="flex flex-col gap-[14px]"
      >
        <!-- The panel's three non-list states, ONE v-if chain (05 §UC-KG-001 item 1,
             §UC-KG-002 A/B/C). Keeping them in a single chain is deliberate: an
             independent `v-if` slipped between the branches silently kills the rest
             of the chain, and no test would catch it (GSO-T6's CycleDetail lesson).

             All three are gated on `guestSummary.rows`, never on `count` — see the
             ref's note in the script.

             ⚠ Sharing disappears entirely when the cycle is locked: nobody can order
             into it, so an odkaz is a dead end. `guest-host-view.spec.js` asserts
             `/Zdieľať/` count 0 on a locked cycle, and the portal's own entry point
             (module 03) hides on the same rule.

             Copy is verbatim from the prototype and must not drift. -->
        <div
          v-if="!isLocked && guestSummary.rows > 0"
          class="card flat"
          style="padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"
        >
          <span class="sub" style="font-size:13px">Ďalší kolegovia sa môžu pridať cez ten istý odkaz.</span>
          <button type="button" class="btn sm" @click="showShareModal = true">
            <NeoIcon name="share" /> Zdieľať odkaz
          </button>
        </div>

        <!-- Empty state (A). The tab stays visible with nobody in it precisely so
             the sharing can be found at all — hiding it would bury the feature, and
             this card IS the panel then, so it carries the whole explanation.
             `guest-sub-orders` must NOT exist in this state (pinned: count 0) — the
             child renders nothing without rows or an error, so that holds by
             construction. -->
        <div
          v-else-if="!isLocked && guestSummary.rows === 0"
          class="card"
          style="padding:22px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center"
        >
          <span class="badge acc">Zatiaľ nikto</span>
          <div class="display" style="font-size:22px">Objednávate aj pre kolegov?</div>
          <div class="sub" style="max-width:300px">Pošlite im odkaz — objednajú si sami, bez registrácie, a vy im tovar odovzdáte.</div>
          <!-- ⚠ `white-space:normal` is a 320px accommodation, not a style choice.
               `.btn` is `white-space:nowrap`, so this 28-character label has a
               min-content width of ~271px against ~238px of card interior at
               320px — and a nowrap `.btn` gives NO degradation signal: it neither
               shrinks nor wraps nor ellipsizes, it just pushes the page sideways.
               Wrapping to two lines is the honest failure mode. No effect at the
               378px reference width, where it still fits on one line. -->
          <button
            type="button"
            class="btn accent"
            style="margin-top:4px;white-space:normal"
            @click="showShareModal = true"
          >
            <NeoIcon name="share" /> Zdieľať objednávku s kolegami
          </button>
        </div>

        <!-- Locked, and nobody used the link (B). One line, no card, no CTA — there
             is nothing to offer and nothing to hand over. Suppressed when the load
             FAILED: "nikto neobjednal" over a failed request is a lie, and the
             child's danger banner is the truthful thing to show instead. -->
        <div
          v-else-if="isLocked && guestSummary.rows === 0 && !guestSummary.failed"
          class="sub"
          style="padding:8px 2px"
        >Cez váš odkaz si nikto neobjednal.</div>

        <!-- Sub-orders the colleagues placed through the share link. Rendered
             regardless of the lock (C): removal ends at the lock, but the
             "odovzdané" hand-over checklist is used exactly AFTER it. The guest
             total inside is context only — the host's own payable total in the
             cartbar is own items only (§UC-GSO-006). -->
        <!-- `ready` waits for an authenticated load: this view restores the friend
             session in onMounted, which runs AFTER a child's setup, so fetching any
             earlier would 401 on a fresh load of /cycle/:id. -->
        <GuestSubOrders
          :cycle-id="cycleId"
          :cycle-locked="isLocked"
          :ready="!!friend"
          @summary="guestSummary = $event"
        />
      </div>

      <!-- ============ panel: own order ============ -->
      <div
        v-show="mainTab === 'own'"
        id="panel-own"
        role="tabpanel"
        aria-labelledby="tab-own"
        class="flex flex-col gap-[14px]"
      >
        <!-- Category strip (UC-FO-004). Purposes are DATA-DERIVED — `availablePurposes`
             is the distinct `product.purpose` of the cycle snapshot, ordered Espresso,
             Filter, Kapsule first and then in encounter order (unchanged shipped rule).
             The prototype's "Filter Special / Brew Bags / Nespresso" are admin-entered
             values, not code.

             ⚠ Geometry comes from `.cat-tabs` in the theme and is NOT re-derived here:
             `position:sticky; top:0; z-index:40`, hidden scrollbar, `scroll-snap-type`,
             the 28px right-edge fade. `top:0` is right ONLY because the chrome above is
             not sticky; the old `top-16` was calibrated against a sticky header that no
             longer exists, and `mobile-no-h-overflow.spec.js` would NOT have caught it.

             `data-testid="purpose-tabs"` moved onto this element and must not be
             dropped, and the tabs must expose `role="tab"` — that spec counts
             `strip.getByRole('tab')`.

             Single purpose ⇒ no strip at all (shipped fallback); the cards below render
             either way. Per-category page tints and coloured triggers are dropped
             (resolved conflict #7): the active tab is `.tab.on` (magenta) and nothing
             else. -->
        <div
          v-if="availablePurposes.length > 1"
          class="cat-tabs"
          data-testid="purpose-tabs"
          role="tablist"
          aria-label="Kategórie produktov"
        >
          <span
            v-for="purpose in availablePurposes"
            :key="purpose"
            class="tab"
            :class="{ on: purpose === activeTab }"
            role="tab"
            tabindex="0"
            :aria-selected="purpose === activeTab ? 'true' : 'false'"
            @click="(e) => { snapTab(e); activeTab = purpose }"
            @keydown.enter.prevent="activeTab = purpose"
            @keydown.space.prevent="activeTab = purpose"
          >{{ purpose }}</span>
          <!-- Scroll affordance. The theme's own signal is the 28px `::after`
               fade, which reads as a soft edge rather than "there is more" — the
               categories past the fold went unfound. MUST stay the last direct
               child of `.cat-tabs`: it sticks to that scroller and finds it via
               `parentElement`. Identical wiring in `GuestProductGrid.vue`. -->
          <CatScrollArrow />
        </div>

        <!-- Only the active purpose's cards — the same one-visible-at-a-time
             behaviour the radix `TabsContent` panels had.

             ⚠ ONE root per product, TWO bodies. `Card`/`CardContent` are gone from
             here: `.card` IS the neo card (3px ink border, radius 14, `5px 5px 0`
             hard shadow), and leaving it nested inside shadcn's `Card` would have
             drawn two borders and two shadows around every product.

             `phone` — 04's markup blocks are written against the prototype's
             `phone ? 14 : 18` boolean. In the prototype that is a DEMO FRAME
             TOGGLE (`device === "phone"` in app.jsx), not a media query. This port
             expresses it as Tailwind's `sm:` breakpoint rather than a viewport
             reactive, deliberately:
               · module 03 already established that idiom on every friend surface
                 (`px-4 sm:px-7`, `text-[28px] sm:text-[34px]`), and a second,
                 JS-driven notion of "phone" would fork the definition;
               · there is no `resize`/`matchMedia` listener to register, leak, or
                 forget to tear down, and no re-render of the whole product list on
                 every resize frame;
               · it follows `emulateMedia` and a mid-session resize, which a value
                 read once in `setup()` would not.
             The ONE thing a class cannot carry here is `line-height`:
             `friends-theme.css` loads AFTER Tailwind and `:where(.app,…) .display`
             has the same (0,1,0) specificity as `leading-[0.95]`, so the theme
             would win. Every line-height below therefore stays an INLINE style,
             which outranks both.

             Text metrics: every text-bearing element in these two cards carries a
             class already covered by the theme's A10 `line-height:normal` list
             (`.display`, `.badge`, `.sub`, `.mono`, `.vbox .vsize`,
             `.vbox .vprice`, `.stepper .val`), so the inline font-sizes cannot
             inherit preflight's 1.5 through an unclassed element. Nothing here
             needs a call-site `line-height:normal`, and A10's selector list must
             NOT grow for this row — measured against the current build, which
             already carries RD-FL-8b's `.vbox`/`.stepper` additions. -->
        <div class="flex flex-col gap-4">
          <div
            v-for="product in activeProducts"
            :key="product.id"
            class="card p-[14px] sm:p-[18px]"
            data-testid="product-card"
          >
            <!-- ==================== bakery (04 §UC-FO-007) ====================
                 Branch condition unchanged from the shipped view. One card per
                 `source_bakery_product_id` through `groupedBakeryProducts` (the
                 CLAUDE.md 2026-04-19 contract, untouched); no image column
                 (resolved conflict #8) and no stock bar — bakery products carry no
                 availability row, and `'unit'` is zero-gram by contract. -->
            <template v-if="isBakery && product.price_unit">
              <div class="flex justify-between gap-[10px] items-baseline">
                <!-- `overflow-wrap:anywhere` for the same reason as the coffee
                     card's text column below — see the comment there.

                     ⚠ `line-height:normal` here is the SECOND half of the same
                     defect the cartbar's `<details>` carries (see the long note
                     there). The `<h3>` below is `inline` — deliberately, so it
                     keeps the weight span's baseline — which makes THIS wrapper
                     establish the line box, and its strut comes from the
                     wrapper's own inherited `line-height`. Preflight's 1.5 made
                     that 24px against the canon's `normal`, so every bakery card
                     rendered 4px tall: header row 20→24, card 181→185 (measured
                     at 378px against the live prototype). `normal` reproduces
                     the canon exactly — 20 and 181.
                     The COFFEE card needs nothing: its `<h3>` is block-level, so
                     no strut is involved (measured: zero delta on both cards). -->
                <div class="min-w-0" style="overflow-wrap:anywhere;line-height:normal">
                  <!-- `<h3>`, not the spec block's `span`: 04 §UC-FO-015 pins the
                       product name as `getByRole('heading', …)` for
                       `guest-host-view.spec.js`, and that pin outranks the element
                       name in the markup sketch. `inline` keeps it on the
                       subtitle's baseline. RD-FL-4 established that `.display`'s
                       weight and uppercase fully override the UA `h3` styles, and
                       Tailwind preflight already zeroes the margin and inherits
                       the size — so there is no visual delta from a `span`. -->
                  <h3 class="display inline text-[19px] sm:text-[21px]" style="line-height:.95">{{ product.name }}</h3>
                  <span v-if="product.description2" class="sub" style="font-size:13px;margin-left:8px">{{ product.description2 }}</span>
                </div>
                <!-- Card-level weight = the FIRST variant row's `weight_grams`
                     (the snapshot carries one per variant — `cycles.js`); the
                     prototype shows exactly one weight per card. -->
                <span
                  v-if="product._variants[0].weight_grams"
                  class="mono sub"
                  style="font-size:12px;white-space:nowrap"
                >{{ product._variants[0].weight_grams }} g</span>
              </div>

              <div v-if="product.description1" class="sub" style="font-size:13px;margin-top:6px">{{ product.description1 }}</div>

              <details v-if="product.composition" style="margin-top:8px">
                <summary class="sub" style="cursor:pointer;font-size:13px">Zloženie</summary>
                <div class="sub" style="font-size:13px;margin-top:4px">{{ product.composition }}</div>
              </details>

              <!-- Column rule and the 368px floor: see the coffee grid below. -->
              <div
                class="grid gap-[10px] mt-3"
                :class="product._variants.length > 1 ? 'grid-cols-1 min-[368px]:grid-cols-2' : 'grid-cols-1'"
              >
                <!-- Selection is PER VBOX (04 §UC-FO-007), replacing the repo's
                     whole-card `ring-2 ring-primary`: two variants of one product
                     now select independently, which is also why
                     `getGroupQuantityTotal` — whose only consumer was that ring —
                     is gone from the script. -->
                <div
                  v-for="v in product._variants"
                  :key="v.id"
                  class="vbox"
                  :class="{ sel: getQuantity(v.id, 'unit') > 0 }"
                >
                  <div class="vrow">
                    <!-- NULL on legacy single-variant snapshots. -->
                    <span class="vsize">{{ v.variant_label || '1 ks' }}</span>
                    <span class="vprice">{{ formatPrice(applyMarkup(v.price_unit)) }}</span>
                  </div>
                  <NeoStepper
                    :model-value="getQuantity(v.id, 'unit')"
                    :disabled="isLocked"
                    :inc-disabled="!canIncrement(v.id, 'unit')"
                    @update:model-value="(q) => onQty(v.id, 'unit', q)"
                  />
                </div>
              </div>
            </template>

            <!-- ==================== coffee (04 §UC-FO-005) ==================== -->
            <template v-else>
              <div class="flex gap-[13px] items-stretch">
                <!-- ⚠ CLOSES 02 §UC-DS-013's `.pimg` OPEN. A product with no
                     uploaded photo renders the BARE frame — its built-in dark
                     gradient and nothing else. No `.band`/`.cap`/`.lbl` bag
                     internals (they encode a per-bag demo colour and `.lbl` wants
                     Anton, which 02 §UC-DS-003 deliberately does not load), and no
                     placeholder icon: the grey photo glyph belonged to the shadcn
                     skin. Recorded in 02 §UC-DS-013's disposition table.

                     `min-height` = width, `height:auto`, `align-self:stretch` is
                     what makes the frame track the text block's height. -->
                <div class="pimg w-[58px] sm:w-[70px] min-h-[58px] sm:min-h-[70px] h-auto self-stretch">
                  <img
                    v-if="product.image"
                    :src="product.image"
                    alt=""
                    style="display:block;width:100%;height:100%;object-fit:cover"
                  />
                </div>
                <!-- ⚠ `overflow-wrap:anywhere` is REQUIRED, not cosmetic, and
                     `min-w-0` alone does not do it: `min-w-0` lets the flex item
                     SHRINK, but an unbreakable token still paints outside it.
                     Product names are free admin text, and a 45-char space-free
                     name put the `<h3>` at 479px inside a 183px column and scrolled
                     the whole DOCUMENT 263px sideways at 320px (measured) — 02
                     §UC-DS-005's zero-horizontal-overflow floor. It is set on the
                     CONTAINER, not the `h3`, because `overflow-wrap` inherits and
                     `description1`/`description2` are equally free text. Same class
                     of hole RD-FL-4 closed on `plan_note`; pinned with a long
                     unbreakable fixture name in `order-product-card.spec.js`. -->
                <div class="flex-1 min-w-0" style="overflow-wrap:anywhere">
                  <h3 class="display text-[19px] sm:text-[21px]" style="line-height:.95">{{ product.name }}</h3>
                  <div v-if="product.roast_type || product.roastery" class="flex flex-wrap gap-[6px] mt-2">
                    <span v-if="product.roast_type" class="badge" style="font-size:11px;padding:2px 7px">{{ product.roast_type }}</span>
                    <span v-if="product.roastery" class="badge acc-o" style="font-size:11px;padding:2px 7px">{{ product.roastery }}</span>
                  </div>
                  <!-- Fixed field mapping (04 §UC-FO-005): `description1` is the
                       spec line, `description2` the tasting notes. The old
                       `line-clamp-2` on the notes is dropped — the prototype does
                       not truncate them.

                       ⚠ `.pspec` / `.pnotes` (Noto Sans Condensed 700 / 500) carry
                       EVERY text property for these two lines — family, size,
                       line-height, letter-spacing and colour — so no inline
                       `font-size` may come back here. The condensed face is what
                       lets a long Slovak varietal fit one line, and the 700/500 pair
                       is the hierarchy (what it is → how it tastes). The notes line
                       deliberately LOSES `.mono`: it was the least readable text on
                       the card. Mono stays on dates, prices, IBANs and references.
                       Only the two `margin-top`s remain inline, as spacing. -->
                  <div v-if="product.description1" class="pspec" style="margin-top:7px">{{ product.description1 }}</div>
                  <div v-if="product.description2" class="pnotes" style="margin-top:2px">{{ product.description2 }}</div>
                </div>
              </div>

              <!-- Stock-limit bar (04 §UC-FO-006). Renders between the description
                   row and the variant grid, only where the server returned an
                   availability row.

                   ⚠ The MATH is the shipped gram math, untouched (resolved
                   conflict #6): `getRemainingGrams` = server `remaining_g` minus
                   the grams already in THIS friend's local cart, so the fill
                   includes their own uncommitted basket and walks back live when
                   they empty a variant. Only the DISPLAY changed — grams became
                   `kg()`, per prototype copy. Fill is always accent magenta; the
                   sold-out signal is the danger-red "Vypredané" LABEL (repo
                   state, kept), never a bar colour — so the old amber/red bar
                   tinting goes. -->
              <div v-if="availability[product.id]" class="flex items-center gap-[10px] mt-3" data-testid="stock-bar">
                <div style="flex:1;height:10px;border:2px solid var(--nb-ink);border-radius:6px;overflow:hidden;background:#fff">
                  <div
                    data-testid="stock-fill"
                    :style="{ width: stockPct(product.id) + '%', height: '100%', background: 'var(--accent)' }"
                  ></div>
                </div>
                <span
                  v-if="getRemainingGrams(product.id) === 0"
                  class="mono"
                  data-testid="stock-label"
                  style="font-size:11.5px;white-space:nowrap;color:var(--danger)"
                >Vypredané</span>
                <span
                  v-else
                  class="mono"
                  data-testid="stock-label"
                  style="font-size:11.5px;white-space:nowrap;color:var(--warn)"
                >Zostáva {{ kg(getRemainingGrams(product.id)) }} z {{ kg(availability[product.id].stock_limit_g) }}</span>
              </div>

              <!-- ⚠ COLUMN RULE — and a recorded ADAPTATION at the 320px floor.
                   04 §UC-FO-005 says `1fr 1fr` for >1 priced variant, single `1fr`
                   otherwise. Two separate things are going on here, and conflating
                   them is what produced an earlier wrong breakpoint:

                   (1) `1fr` is written as `grid-cols-*` CLASSES, never an inline
                       `gridTemplateColumns` — an inline style outranks every class,
                       so a media query could not reach it. That switch is ALSO what
                       satisfies `mobile-no-h-overflow.spec.js`, and it does so on
                       its own: the spec's literal inline `1fr 1fr` is
                       `minmax(auto,1fr)`, whose `auto` floors each track at the
                       item's 146px min-content, and at 320px that scrolls the
                       DOCUMENT 15px sideways (measured). `grid-cols-2` is
                       `repeat(2, minmax(0,1fr))` — minimum ZERO — so forcing two
                       columns at 320px gives a document overflow of exactly 0
                       (measured). No media query needed for the overflow rule.

                   (2) The media query's real job is the opposite one: stopping a
                       track from sitting BELOW the item's min-content, where the
                       shortfall is absorbed by the flex stepper buttons shrinking
                       (`width:38px` with the default `flex-shrink:1`). 02
                       §UC-DS-008 pins those 38×38 hit targets as "from CSS — do not
                       override", so a silently squeezed button is a real defect.

                   MEASURED, not estimated: a `.vbox`'s min-content is 146px — the
                   38+24+38 stepper plus its two 10px gaps (120), plus 11px padding
                   and 2px border a side. Two of them plus the 10px gap need 302px
                   of card CONTENT box, and that box is
                   `viewport − 32 (page column) − 28 (card padding) − 6 (.card's own
                   3px border a side, friends-theme.css)`; 302 + 66 = 368.

                   ⚠ 368, not 362: dropping the border term put the switch 6px low,
                   and across 362–367 the tracks rendered at 143–145.5px with the
                   "+" button squeezed to 36.5–37.75px. Pinned by the 364px case in
                   `order-product-card.spec.js`. At the prototype's own 378px phone
                   width the tracks come out at 151px with 38px buttons, which is
                   why `03-shot.png` shows two boxes side by side and this fallback
                   never fires on the design width. -->
              <div
                class="grid gap-[10px] mt-[13px]"
                :class="coffeeVariants(product).length > 1 ? 'grid-cols-1 min-[368px]:grid-cols-2' : 'grid-cols-1'"
              >
                <div
                  v-for="v in coffeeVariants(product)"
                  :key="v.variant"
                  class="vbox"
                  :class="{ sel: getQuantity(product.id, v.variant) > 0 }"
                >
                  <div class="vrow">
                    <span class="vsize">{{ v.label }}</span>
                    <span class="vprice">{{ formatPrice(applyMarkup(v.price)) }}</span>
                  </div>
                  <!-- ⚠ THE `+` CEILING, and why BOTH halves are here.
                       02 §UC-DS-008 forbids a `max` in `NeoStepper`, so the rule
                       lives in the view; 04 §UC-FO-006 says an increment past
                       `remaining_g` is SILENTLY refused — no toast.

                       `incDisabled` carries the shipped semantics: the pre-redesign
                       "+" was a real `:disabled` button at the ceiling, and
                       dropping that would have taken the state away from assistive
                       tech, which is the one audience a purely silent refusal
                       cannot reach. It costs no fidelity, because RD-DS-3 recorded
                       that the theme has no `.stepper button:disabled` rule at all
                       — the button looks identical, which is exactly the silence
                       the spec asks for.

                       And it is NOT the enforcement. `onQty` routes every increase
                       through `increment()`, which re-checks `canIncrement()`, so a
                       programmatic click that bypasses the disabled attribute still
                       cannot exceed the limit. Both, not either. -->
                  <NeoStepper
                    :model-value="getQuantity(product.id, v.variant)"
                    :disabled="isLocked"
                    :inc-disabled="!canIncrement(product.id, v.variant)"
                    @update:model-value="(q) => onQty(product.id, v.variant, q)"
                  />
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
      <!-- ============ /panel: own order ============ -->
    </div>

    <!-- ============================ .cartbar (04 §UC-FO-009) ============================
         ⚠ A DIRECT CHILD OF `.app`, after the page column — and that is the whole
         reason it can be `sticky` at all.

         `.app > * { position:relative; z-index:1 }` (friends-theme.css:23)
         neutralises every Tailwind positioning utility on a direct child, which is
         why RD-FO-1 had to leave the old `fixed bottom-0 z-50` bar NESTED inside
         the page column and warned against hoisting it while it was still on
         utilities. This row does the hoist correctly, by switching to the THEME
         class: `:where(.app,.modal-layer) .cartbar` (friends-theme.css:158) has the
         same (0,1,0) specificity as `.app>*` but is declared LATER, so its
         `position:sticky; bottom:0; z-index:50` wins the cascade. MEASURED on the
         shipped build, not assumed — `order-cartbar.spec.js` reads back
         sticky / 0px / 50 on this element and would fail loudly at `relative` if the
         two rules ever swapped order.

         Sticky needs no spacer: the bar is the flex column's last child, `.app` is
         `min-height:100vh` + `flex flex-col`, and the page column takes `flex-1`.
         The old `<div class="h-48">` spacer is therefore GONE — with `fixed` it was
         load-bearing (the bar was out of flow and would have covered the last card);
         with `sticky` it would be 192px of dead space at the end of every page.

         Rendered under the SAME condition as the page column (neither loading nor
         the fatal-error branch): a bar with no cycle, no products and no friend has
         nothing to submit and would only add chrome to a spinner. -->
    <div v-if="!loading && !(error && !friend)" class="cartbar" data-testid="cartbar">
      <!-- 1. not-yet-submitted notice, and 2. the dirty warning. At most one of the
           two, neither when locked — the shipped `v-if`/`v-else-if` priority,
           unchanged. Both moved INSIDE the bar per the prototype.

           The ✕ is resolved conflict #5: the prototype's warning has no dismiss,
           the shipped behaviour does (CLAUDE.md 2026-02-03) and behaviour is
           repo-canonical, so the dismiss stays and the ✕ is a recorded visual
           addition. `changesNotificationDismissed` is reset by the `cart` watcher,
           so a dismissed warning reappears on the NEXT edit — that reset is the
           behaviour, not the flag.

           ⚠ The dismiss control was a real `<button>` before this row. 04's markup
           block writes it as a bare `<span>` (prototype idiom), so it carries the
           house zero-pixel ARIA layer — `role`/`tabindex`/Enter/Space, exactly as
           the appbar back chevron does — rather than losing keyboard reach in a
           re-skin. `aria-label`, because the only child is an SVG. -->
      <div
        v-if="!isLocked && cartItems.length > 0 && !isSubmitted"
        class="banner warn slim"
        style="margin-bottom:8px"
        data-testid="cart-warn-unsent"
      >
        <span class="dot"></span><span><b>Objednávka ešte nebola odoslaná.</b></span>
      </div>
      <div
        v-else-if="!isLocked && hasUnsubmittedChanges && !changesNotificationDismissed"
        class="banner warn slim"
        style="margin-bottom:8px"
        data-testid="cart-warn-dirty"
      >
        <span class="dot"></span>
        <span style="flex:1"><b>Zmeny neboli odoslané.</b> Stlačte „Aktualizovať“.</span>
        <span
          class="hstack"
          role="button"
          tabindex="0"
          aria-label="Zavrieť"
          title="Zavrieť"
          data-testid="cart-warn-dismiss"
          style="cursor:pointer;flex-shrink:0"
          @click="changesNotificationDismissed = true"
          @keydown.enter.prevent="changesNotificationDismissed = true"
          @keydown.space.prevent="changesNotificationDismissed = true"
        ><NeoIcon name="close" :size="14" /></span>
      </div>

      <!-- Deadline: only when the cycle carries one, and VERBATIM from the API — no
           reformatting, no 📅 (the design language has no emoji).
           ⚠ The "Položiek: N" span that used to share this row is GONE (product
           decision 2026-08-12): the count moved into the `<details>` summary below,
           where it labels the very list it counts. The row is therefore dropped
           WHOLESALE when there is no deadline — an empty `.meta` would still be a
           flex container in the bar's vertical rhythm, and the whole point of the
           change was to give that line back to the summary's hit target. -->
      <div v-if="cycle?.expected_date" class="meta">
        <span class="deadline">Objednávka do: {{ cycle.expected_date }}</span>
      </div>
      <!-- ⚠ `paymentTotal`, not `cartTotal` (resolved conflict #9): it includes
           `orders.delivery_fee`, which is a field ON the order and never an
           `order_items` line (CLAUDE.md 2026-05-01), so summing the cart lines
           alone under-states what the friend owes by exactly the Packeta fee — and
           the same `paymentTotal` is what the success modal, the QR and
           `PaymentModal` are already billing.
           `.sum` is the 22px display style with its own `line-height:1`; only the
           per-line totals and the fee line below are `.mono`. -->
      <div class="meta" style="margin-top:2px">
        <span class="sum">Celkom: {{ paymentTotal.toFixed(2) }} EUR</span>
        <span v-if="autoSaving" class="sub" style="font-size:12px">Ukladám…</span>
      </div>

      <!-- Locked ⇒ the actions row is absent ENTIRELY (04 §UC-FO-014); the meta rows
           and the `<details>` stay. `.cartbar .actions .btn{flex:1;min-height:46px}`
           comes from the theme — the three buttons share the row equally and their
           widths are NOT overridden here (the prototype's `flex:0 1 auto` on Zrušiť
           is not in 04's markup block, and 04's business rules say do not override).
           Zaplatiť opens `PaymentModal` with its pinned props; the modal's internals
           belong to module 06 and are untouched by this row. -->
      <div v-if="!isLocked" class="actions">
        <button
          type="button"
          class="btn danger sm"
          :disabled="saving || cartItems.length === 0"
          @click="cancelOrder"
        >Zrušiť</button>
        <button
          v-if="isSubmitted && hasPaymentSettings"
          type="button"
          class="btn ok sm"
          @click="showPaymentModal = true"
        >Zaplatiť</button>
        <button
          type="button"
          class="btn accent sm"
          :disabled="saving || cartItems.length === 0"
          @click="submitOrder"
        >{{ saving ? 'Odosielam…' : (isSubmitted ? 'Aktualizovať' : 'Odoslať') }}</button>
      </div>

      <!-- Cart lines: GROUPED BY PURPOSE and column-aligned (product decision
           2026-08-12, reversing 04 resolved conflict #10's flat list). `×` is
           U+00D7, not "x". `.lines` owns the 170px scroll cap and the row rule
           from the theme; the four columns and the group header come from this
           file's scoped block.

           Each line is exactly ONE row at every supported width. That is the
           `.ln-name` ellipsis doing it, not a shortened string: product names are
           free admin text, so nothing in the data bounds them. Truncating in CSS
           keeps the full name in the DOM (and in the `title`), which is also why
           this needs no `overflow-wrap` — `overflow:hidden` cannot paint outside
           the row the way an unbreakable token can (RD-FO-2's 263px document
           overflow was exactly that failure, one screen up).

           The quantity and the size are their OWN fixed-width columns, so they
           line up down the list instead of drifting with the name's length — the
           whole point of splitting them out of the "Name (250g) ×1" string.

           `€` replaces `EUR` on these lines to buy that width back; the `.sum`
           row above and the modals keep `EUR`, which is what the friend sees on
           the figure they actually pay.

           ⚠ `line-height:normal` ON THE `<details>` ITSELF — measured, not
           cosmetic. RD-FO-5's canon-vs-port pass found the whole `.cartbar` 3px
           taller than the prototype on EVERY order screen (146→149 open,
           90→93 locked, both phone and desktop), and this element is the entire
           cause: `.cartbar details summary` is `display:inline-flex`, so the
           `<details>` block establishes a line box whose STRUT comes from the
           details' own inherited `line-height`. The canon computes the UA
           `normal`; Tailwind preflight's `html{line-height:1.5}` makes it 24px
           here, and the taller strut adds exactly 3px. A/B'd live: setting
           `normal` gives details 27→24 and `.cartbar` 149→146 — the canon's
           numbers exactly.

           It has to be a CALL-SITE inline. A9/A10 in `friends-theme.css` are
           CLASS lists and this element carries no class, so no addition to them
           can reach it — the same structural gap as module 03's four plain-text
           sites (03 §UC-FL-013 closeout), fixed the same way. The bakery card's
           `<details>` needs nothing: its `summary` is a block-level `.sub`,
           already in A10, so no strut is involved (measured: 15px either way). -->
      <details style="line-height:normal">
        <!-- ⚠ The item count lives HERE now, not in the meta row above (product
             decision 2026-08-12) — it labels the list it counts, and the line it
             frees is spent on this control's hit target (see the scoped block).
             Declined, so it reads "1 položka" / "3 položky" / "11 položiek"; 0 is
             correct as "0 položiek" and the fold still opens onto "Košík je
             prázdny". -->
        <summary>Zobraziť položky v košíku ({{ itemsLabel(cartItems.length) }})</summary>
        <!-- The empty state has no `.lines` wrapper any more, so it carries the 8px
             the theme's `.cartbar .lines` used to give it. -->
        <span v-if="cartItems.length === 0" class="sub" style="display:block;margin-top:8px">Košík je prázdny</span>
        <!-- `purpose-order` is what keeps the cart's groups in the same order as the
             category strip above it (`availablePurposes`); the cart's own key order
             is whatever sequence the friend happened to tap in. The fee line rides
             along as an `extra` — see `cartExtraLines`, and note the repo's 📦 stays
             banned with the rest of the emoji. -->
        <CartLineList
          v-else
          :items="cartLines"
          :extras="cartExtraLines"
          :purpose-order="availablePurposes"
        />
      </details>
    </div>

    <!-- ================= Hotovo! success modal (04 §UC-FO-011) =================
         ⚠ ONE subtitle on BOTH paths (resolved conflict #4). The shipped view had
         two — "úspešne odoslaná" / "bola aktualizovaná" — and `successModalMessage`
         was retired with them (see the script). The distinction the friend actually
         needs is in the sentence that survived: the order can still be edited until
         the lock.

         ⚠ NO payment-reference row here. The reference (`Meno / Cyklus`) lives ONLY
         in the Platba modal (`PaymentModal`, module 06 / RD-GX-2) — README §Screens
         item 8, applied to the friend side identically. It is deliberately not a
         copy-row on this screen even though `paymentReference` is computed right
         above: one home for the string the friend must type into their bank.

         ⚠ CLOSING BY ANY ROUTE NAVIGATES TO THE PORTAL. `@close` is NeoModal's one
         event for ×, scrim and Esc, and the OK button calls the same handler, so all
         four routes go through `handleSuccessModalClose` — which sets
         `leaveConfirmed` BEFORE `router.push('/')`. That flag is what stops
         `onBeforeRouteLeave` opening the leave modal on top of a successful submit:
         the snapshot has just been retaken, so nothing is dirty, but the "cart items
         with no order" arm of `hasUnsavedChanges` would still be armed on a first
         submit if the order write had not landed. Belt and braces, and it is the
         shipped behaviour. -->
    <NeoModal
      v-if="showSuccessModal"
      title="Hotovo!"
      subtitle="Objednávka bola odoslaná. Môžete ju upraviť až do uzamknutia cyklu."
      @close="handleSuccessModalClose"
    >
      <!-- Payment block only when the admin configured payment settings at all;
           with neither IBAN nor Revolut there is nothing to pay INTO and the modal
           is the bare confirmation. -->
      <template v-if="hasPaymentSettings">
        <!-- `.banner.ok.slim` is in A10's `line-height:normal` list and the property
             inherits, so the unclassed <span> inside it needs no call-site fix. -->
        <div class="banner ok slim">
          <span class="dot"></span>
          <span style="min-width:0">
            Suma na úhradu: <b class="mono">{{ paymentTotal.toFixed(2) }} EUR</b>
            <!-- Repo information the prototype is silent about, kept: the Packeta
                 fee is a field ON the order, never a cart line, so without this
                 split the sum looks wrong against the cart. -->
            <span
              v-if="order?.delivery_fee"
              class="sub"
              style="display:block;font-size:12px"
            >({{ cartTotal.toFixed(2) }} EUR + {{ order.delivery_fee.toFixed(2) }} EUR doručenie)</span>
          </span>
        </div>

        <!-- Prototype `RevolutBtn` on the shipped link behaviour: an <a>, because it
             navigates off-site, wearing `.btn.block`. `fill:currentColor` + the
             white `color` is what tints the glyph. -->
        <a
          v-if="paymentRevolutUsername"
          class="btn block"
          style="background:#0075EB;color:#fff;border-color:#0a0a0a"
          :href="`https://revolut.me/${paymentRevolutUsername}`"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.1 6.8c-.3-1.2-1-2.2-2-2.9-.9-.7-2.1-1-3.3-1H6.2L4 20.1h4.1l1-5.5h3.7c1.6 0 3-.5 4.1-1.4 1.1-.9 1.9-2.2 2.2-3.8l.5-2.6zM16 9.2l-.2 1c-.2.9-.6 1.5-1.2 2-.6.5-1.4.7-2.3.7H9.1l1-5.5h3.2c.7 0 1.2.2 1.6.6.4.4.5.9.4 1.5l-.3 1.7z"/></svg>
          Zaplatiť cez Revolut
        </a>

        <!-- The REAL scannable code inside the neo frame (02 §UC-DS-012): `.qr` is
             the 190×190 ink frame with 10px padding, and the <img> fills its content
             box. `QRBox`'s pseudo-QR cell generator is prototype-only and is NOT
             ported — the generator here is the shipped `generateSuccessQr`
             (bysquare encode of `paymentTotal`, `paymentReference` as the note). -->
        <div v-if="paymentIban" style="text-align:center">
          <div class="sub" style="margin-bottom:10px">Pay by Square (QR kód pre bankovú appku)</div>
          <div v-if="successQrDataUrl" class="qr">
            <img :src="successQrDataUrl" alt="Pay by Square QR" style="display:block;width:100%;height:100%" />
          </div>
          <div v-else class="sub">Generujem QR kód…</div>
          <div class="sub mono" style="margin-top:10px;font-size:12px">IBAN: {{ paymentIban }}</div>
        </div>
      </template>

      <template #footer>
        <button type="button" class="btn fo-foot-btn" @click="handleSuccessModalClose">OK</button>
      </template>
    </NeoModal>

    <!-- Payment Modal (for footer button) -->
    <PaymentModal
      :open="showPaymentModal"
      :amount="paymentTotal"
      :reference="paymentReference"
      :iban="paymentIban"
      :revolut-username="paymentRevolutUsername"
      @close="showPaymentModal = false"
    />

    <!-- Share with colleagues (guest link) — shared with FriendPortal -->
    <GuestShareDialog
      :open="showShareModal"
      :cycle-id="cycleId"
      :cycle-name="cycle?.name || ''"
      @update:open="showShareModal = $event"
    />

    <!-- ============ Zrušiť objednávku? confirm (04 §UC-FO-012) ============
         ⚠ THE BANNER MAKES A PROMISE ABOUT SOMEBODY ELSE'S DATA, and it must stay
         true: `confirmCancelOrder()` clears THIS friend's cart and, when an order
         row exists, deletes it through the silent `saveCart` of an empty cart
         (`PUT /orders/cycle/:id/friend/:id` deletes the row when the total hits 0 —
         CLAUDE.md 2026-02-01). It touches `orders`/`order_items` only. Guest
         sub-orders live in `guest_orders`/`guest_order_items` under
         `guest_order_links`, are keyed on the LINK rather than on the host's order,
         and are never in that request's path — which is exactly why cancelling does
         not disturb them. `order-modals.spec.js` asserts a colleague's sub-order is
         still there, still unpaid and still undelivered, after the host cancels.

         Copy is the prototype's, new to production and in contract. Opening is
         blocked when locked (`cancelOrder()` returns early) and the cartbar's
         "Zrušiť" is disabled on an empty cart, so this modal is unreachable in
         both states rather than reachable-and-inert. -->
    <NeoModal
      v-if="showCancelModal"
      title="Zrušiť objednávku?"
      subtitle="Naozaj chcete zrušiť objednávku a vymazať všetky položky z košíka?"
      @close="showCancelModal = false"
    >
      <div class="banner danger slim">
        <span class="dot"></span>
        <span style="min-width:0">Položky sa vymažú z košíka. Kolegov, ktorí objednali cez váš odkaz, sa to nedotkne.</span>
      </div>
      <template #footer>
        <button type="button" class="btn fo-foot-btn" @click="showCancelModal = false">Nie</button>
        <button type="button" class="btn danger fo-foot-btn" @click="confirmCancelOrder">Áno, zrušiť</button>
      </template>
    </NeoModal>

    <!-- ============ Neuložené zmeny leave guard (04 §UC-FO-013) ============
         Not in the prototype (it navigates silently); the behaviour is
         repo-canonical and kept in full. Two entry points, one modal: `goBack()`
         (the appbar chevron) and `onBeforeRouteLeave` (everything else, including
         the browser Back button), both gated on `hasUnsavedChanges`.

         ⚠ `@close` maps ×/scrim/Esc onto `cancelLeave`, i.e. onto STAYING. That is
         the only safe default: this dialog exists to prevent data loss, so its
         dismissal must be the non-destructive branch. It also has to CLEAR
         `pendingNavigation` — leaving a stale target behind would make the next
         confirm send the friend somewhere they never asked to go.

         Body-less by 04 §UC-FO-013's composition: the whole question is the title
         and subtitle, and inventing a banner would be copy this row does not own. -->
    <NeoModal
      v-if="showLeaveModal"
      title="Neuložené zmeny"
      subtitle="Máte neuložené zmeny v objednávke. Naozaj chcete opustiť stránku? Zmeny nebudú uložené."
      @close="cancelLeave"
    >
      <template #footer>
        <button type="button" class="btn fo-foot-btn" @click="cancelLeave">Zostať</button>
        <button type="button" class="btn danger fo-foot-btn" @click="confirmLeave">Opustiť</button>
      </template>
    </NeoModal>

    <!-- ============ Spôsob prevzatia (04 §UC-FO-010) ============
         ⚠ THE RadioRow PATTERN — module 06 / RD-GX-1's guest checkout is told to
         LIFT this, not re-invent it. The whole recipe, transcribed from
         `order.jsx:203-208`:

           <label class="radiorow card flat"
                  style="padding:11px 13px;display:flex;align-items:center;gap:10px;
                         cursor:pointer;border-color:<ink|30%>;background:<soft|#fff>">
             <input type="radio" name="<group>" :value v-model  … visually hidden />
             <span style="width:18px;height:18px;border-radius:50%;
                          border:3px solid var(--nb-ink);
                          background:<accent|#fff>;flex-shrink:0"></span>
             <span style="min-width:0;font-size:14px;line-height:normal"> … </span>
           </label>

         Four things about it are load-bearing, and each cost something to find:

         1. ⚠ THE NATIVE `<input type="radio">` STAYS IN THE DOM, visually hidden,
            with the v-model unchanged. It is the entire keyboard/AT path: a
            same-`name` radio group gives arrow-key traversal and one Tab stop for
            the whole group, and the label wrapping it is what makes a tap on the
            row select it — no `@click` handler of our own. Hiding it with
            `display:none`/`visibility:hidden` would DELETE that path, so it is the
            clip-rect idiom (1×1, clipped) instead: still focusable, zero pixels.
         2. ⚠ `line-height:normal` ON THE CONTENT SPAN. A class list cannot reach
            plain text (friends-theme.css A10's closing note): that span carries no
            class, `.card`/`.card.flat` declare no line-height, so it would inherit
            preflight's 1.5 and stand ~4px taller than the canon. Fixed at the call
            site, exactly as module 03 fixed its four unclassed strings — A10's
            selector list must NOT grow for this.
         3. The visible dot is the 18px span; `--accent` filled when checked, white
            when not. The row itself is `.card.flat` (2px border, no shadow) with an
            INLINE `border-color`/`background` pair, because both flip on state and
            an inline style is the only thing that outranks `.card`'s own border.
         4. `:has(:focus-visible)` (the scoped rules at the end of this file) paints
            the ring the hidden input can no longer show. Without it a keyboard user
            moving through the group gets no feedback at all. ⚠ `:focus-visible`,
            not `:focus-within` — the latter fires on a POINTER tap too, which on a
            touch-first screen leaves a row ringed permanently after any tap.

         The modal is `closable` (the NeoModal default) and does NOT pass
         `trap-focus` — nor do the other three on this screen. That matters here
         specifically: `NeoModal.focusablesInside()` walks the DOM in order and has
         no radio-group awareness, so a trapped radio group would become N tab stops
         instead of the native one. Nothing opts in, so nothing is affected; if any
         modal on this shell ever does, teach `focusablesInside()` about radio groups
         first (verified separately: focus alone never changes the checked radio, so
         the trap would be a nuisance, not a data bug). -->
    <NeoModal
      v-if="showPickupModal"
      title="Spôsob prevzatia"
      subtitle="Vyberte, ako chcete dostať objednávku."
      @close="showPickupModal = false"
    >
      <!-- METHOD RadioRows. An empty `deliveryMethodOptions` IS the "pickup only"
           row of the matrix — no radios, straight to the locations. `.m-body` is
           itself a 12px-gap column, so these are bare children with no wrapper. -->
      <label
        v-for="opt in deliveryMethodOptions"
        :key="opt.value"
        class="radiorow card flat"
        :style="{
          padding: '11px 13px',
          display: 'flex',
          position: 'relative',
          alignItems: 'center',
          gap: '10px',
          cursor: 'pointer',
          borderColor: deliveryMethod === opt.value ? 'var(--nb-ink)' : 'rgba(10,10,10,0.3)',
          background: deliveryMethod === opt.value ? 'var(--accent-soft)' : '#fff'
        }"
        :data-testid="`delivery-method-${opt.value}`"
      >
        <input
          v-model="deliveryMethod"
          class="sr-radio"
          type="radio"
          name="fo-delivery-method"
          :value="opt.value"
        />
        <span
          :style="{
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            border: '3px solid var(--nb-ink)',
            background: deliveryMethod === opt.value ? 'var(--accent)' : '#fff',
            flexShrink: 0
          }"
        ></span>
        <span style="min-width:0;font-size:14px;line-height:normal">
          <b>{{ opt.label }}</b>
          <span
            v-if="opt.fee && cycle?.parcel_fee"
            class="sub"
          > (+{{ cycle.parcel_fee.toFixed(2) }} EUR)</span>
        </span>
      </label>

      <!-- PICKUP section — the locations plus the trailing "Iné", one `v-for` over
           `pickupOptions`. Shown when pickup is the chosen method AND there is
           something to choose; the top rule separates it from the method group
           above (and is harmless when there is none, since it is then the first
           child of a padded body). -->
      <div
        v-if="deliveryMethod === 'pickup' && hasPickupLocations"
        style="display:flex;flex-direction:column;gap:8px;border-top:2px solid rgba(10,10,10,0.12);padding-top:12px"
        data-testid="pickup-section"
      >
        <label
          v-for="opt in pickupOptions"
          :key="opt.value === null ? 'other' : opt.value"
          class="radiorow card flat"
          :style="{
            padding: '11px 13px',
            display: 'flex',
            position: 'relative',
            alignItems: 'center',
            gap: '10px',
            cursor: 'pointer',
            borderColor: selectedPickupLocationId === opt.value ? 'var(--nb-ink)' : 'rgba(10,10,10,0.3)',
            background: selectedPickupLocationId === opt.value ? 'var(--accent-soft)' : '#fff'
          }"
        >
          <input
            v-model="selectedPickupLocationId"
            class="sr-radio"
            type="radio"
            name="fo-pickup-location"
            :value="opt.value"
          />
          <span
            :style="{
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              border: '3px solid var(--nb-ink)',
              background: selectedPickupLocationId === opt.value ? 'var(--accent)' : '#fff',
              flexShrink: 0
            }"
          ></span>
          <!-- ⚠ `</b> <span` ON ONE LINE. Vue's `condense` whitespace mode DELETES a
               whitespace-only node between two elements when it contains a newline,
               and also strips a leading whitespace-only node inside an element — so
               both the obvious spellings ("</b>\n<span>" and "<span> {{ … }}") render
               "Lego domaDúbravka". Without a newline the same node condenses to a
               single space and is KEPT, which is what the prototype's JSX does. -->
          <span style="min-width:0;font-size:14px;line-height:normal">
            <b>{{ opt.label }}</b> <span v-if="opt.sub" class="sub">{{ opt.sub }}</span>
          </span>
        </label>
        <!-- The note is a SIBLING of the "Iné" row, not a child of its label
             (prototype), so typing in it cannot re-fire the label's selection. -->
        <input
          v-if="selectedPickupLocationId === null"
          v-model="pickupLocationNote"
          class="inp"
          type="text"
          placeholder="Poznámka (voliteľné)"
          data-testid="pickup-note"
        />
      </div>

      <!-- PACKETA section. The address is required — the footer's Potvrdiť is
           disabled while it is blank, which is the only validation this modal
           does (the server re-checks). -->
      <div
        v-if="deliveryMethod === 'packeta'"
        style="border-top:2px solid rgba(10,10,10,0.12);padding-top:12px"
        data-testid="packeta-section"
      >
        <label class="field-lbl" for="fo-packeta-address">Adresa výdajného miesta *</label>
        <input
          id="fo-packeta-address"
          v-model="packetaAddress"
          class="inp"
          type="text"
          placeholder="napr. Z-BOX Hlavná 15, Bratislava"
        />
        <!-- Save-as-default. DEFAULT UNCHECKED (resolved conflict #11) — see the
             `savePacketaAsDefault` ref.

             ⚠ THREE CLICK ZONES, ONE TOGGLE EACH — module 03's remember-me pattern,
             lifted verbatim, and for its reason: a `<label>` forwards clicks only to
             LABELABLE elements and `NeoCheckbox` is a `span[role=checkbox]`, so the
             wrapper forwards nothing by itself. The box has the component's own
             handler, the text span its `@click`, and the padding/gap `@click.self` —
             without `.self` the label would also catch the other two and toggle them
             straight back. `aria-label` on the control for the same reason: the
             label cannot name a non-labelable element.

             ⚠ `line-height:normal` — the text here is UNCLASSED, and A10's class
             list structurally cannot reach plain text (its closing note). Fixed at
             the call site, exactly as module 03 fixed its four. -->
        <label
          style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13.5px;line-height:normal;margin-top:10px"
          @click.self="savePacketaAsDefault = !savePacketaAsDefault"
        >
          <NeoCheckbox
            v-model="savePacketaAsDefault"
            aria-label="Uložiť ako predvolenú adresu"
            data-testid="save-packeta-default"
          />
          <span @click="savePacketaAsDefault = !savePacketaAsDefault">Uložiť ako predvolenú adresu</span>
        </label>
      </div>

      <template #footer>
        <button type="button" class="btn fo-foot-btn" @click="showPickupModal = false">Zrušiť</button>
        <button
          type="button"
          class="btn accent fo-foot-btn"
          :disabled="deliveryMethod === 'packeta' && !packetaAddress.trim()"
          @click="confirmPickupAndSubmit"
        >Potvrdiť a odoslať</button>
      </template>
    </NeoModal>
  </div>
</template>

<!-- ⚠ THE ONLY STYLESHEET THIS VIEW OWNS, and it exists solely to make 04
     §UC-FO-010's "the native radio stays in the DOM, visually hidden" survivable.
     Both rules are SCOPED — `friends-theme.css` is module 02's file and is not
     touched by this row, and neither of these belongs in the shared canon: they
     describe one local pattern, not a design-system class. (Vue's scope attribute
     lands on slot content authored here even though `NeoModal` teleports it to
     `body`, so both rules reach the modal.)

     `.sr-radio` is the clip-rect idiom, NOT `display:none`/`visibility:hidden`/
     `opacity:0;width:0`: the first two remove the control from the tab order and
     from the accessibility tree — deleting the keyboard/AT path the spec keeps it
     for — and a genuinely zero-sized element is inconsistently focusable across
     engines. 1×1 + `clip` is focusable everywhere and paints nothing.

     ⚠ NO `top`/`left`, AND `position:relative` on the row — two declarations, and
     it takes both to see what either is for. An absolutely positioned box with
     auto insets sits at its STATIC position (CSS 2.1 §10.3.7), i.e. where it
     would have flowed inside its row, so focusing it scrolls nothing. Measured
     in a 378×250 viewport, pickup list scrolled to the bottom, focusing the LAST
     radio (the FIRST one is at the top of the scroll range and therefore
     discriminates nothing — every variant scrolls to 0):

       A  relative row, no insets (shipped)   scrollTop 486 → 486   rect 71 → 71
       B  static   row, no insets             scrollTop 487 → 487   rect 70 → 70
       C  relative row + `top:0;left:0`       scrollTop 487 → 487   rect 49 → 49
       D  static   row + `top:0;left:0`       scrollTop 487 →   0   rect −488 → −1

     A ≡ B: with the insets omitted, the containing block is unobservable — so
     `position:relative` is NOT what makes the shipped code safe, and any note
     claiming focus would otherwise yank the dialog TODAY is false. The omitted
     insets are doing that work alone.

     C vs D is why the declaration stays, and it is not mere insurance: adding the
     classic sr-only `top:0;left:0` yanks the dialog to the top (D) only when the
     row is unpositioned. With the row positioned the control lands at its OWN
     row's origin and nothing moves (C). So `position:relative` is precisely what
     disarms the recipe everyone reaches for — which matters here because RD-GX-1
     is told to lift this block, and a lift that "restores" the familiar insets
     would be safe on arrival and broken the moment the row went static.

     `.radiorow:has(:focus-visible)` restores what hiding the input took away —
     `:focus-visible`, NOT `:focus-within`. ⚠ `:focus-within` also matches POINTER
     input, and a tap on a radio row leaves focus THERE, so under that spelling one
     row wore a magenta offset shadow permanently after any tap — on a touch-first
     surface, i.e. always. `.card.flat` is `box-shadow:none`, so that was a state
     INVENTION neither the prototype nor 02 specifies, not a restoration. Measured
     on the row, as shipped:

       at rest        :focus-within false  :has(:focus-visible) false  → none
       after a TAP    :focus-within TRUE   :has(:focus-visible) false  → none
       after ArrowDown:focus-within true   :has(:focus-visible) TRUE   → rgb(255,45,135) 3px 3px 0px 0px

     The middle row is the whole fix: focus is genuinely in the row (so
     `:focus-within` fires) and the ring correctly stays off.

     It reuses `.inp:focus`'s own idiom (`box-shadow:3px 3px 0 var(--accent)`) so
     the ring reads as the same control language, and it still outranks
     `.card.flat{box-shadow:none}`: `:has()` contributes the specificity of its
     most specific argument, so the emitted
     `.radiorow[data-v-…]:has(:focus-visible)` is (0,3,0) against that rule's
     (0,2,0) — unchanged by the respelling, because
     `:focus-visible` and `:focus-within` are both (0,1,0). (`.card.flat` is
     wrapped in `:where()`, which contributes nothing, so it really is (0,2,0).)

     ⚠ The `@supports not selector(:has(*))` twin is not decoration. `:focus-visible`
     shipped years before `:has()` (Firefox 85 vs 121, Chrome 86 vs 105), so an
     engine in that window drops the `:has()` rule WHOLESALE and a keyboard user
     would get no focus indicator at all — a worse failure than a stray pointer
     ring, which is why the old spelling survives there and only there. It is
     inert wherever `:has()` parses, so the two can never both paint. -->
<style scoped>
/* ⚠ The fold's own control, ENLARGED with the line the count vacated (product
   decision 2026-08-12). The theme's `.cartbar details summary` is 13px and
   `inline-flex`, i.e. a hit target as tall as one line of 13px text (~16px) and
   only as wide as its label — well under the 38-44px the rest of this bar
   spends on everything tappable (`.btn.sm` is 38, `.actions .btn` 46).

   Three changes, and each is doing a distinct job:
   · `display:flex` widens the target to the FULL bar width, so a thumb landing
     right of the label still opens the fold. This is what actually makes it
     forgiving — the vertical padding alone would leave a narrow column.
   · `min-height:40px` + the padding give it a real vertical target.
   · 14.5px, and `--ink` rather than the theme's `--ink-dim`: at 13px dimmed it
     read as a caption rather than as a control.

   Specificity: `.cartbar details summary` is (0,3,0) in `friends-theme.css`
   (`:where()` contributes nothing), and `<style scoped>` appends a data attribute
   to the last compound, so this is (0,4,0) and wins regardless of file order —
   NOT a cascade-order bet like `.cartbar` itself is. `list-style:none` and the
   `::before` marker stay the theme's; only the box changes. */
.cartbar details summary {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 6px 2px;
  font-size: 14.5px;
  color: var(--ink);
}

/* ⚠ The cart-line rules that used to live here — `.ln-group`, `.ln-name`,
   `.ln-qty`, `.ln-size`, `.ln-amt` — moved WHOLESALE into
   `components/CartLineList.vue` when four other screens had to render the same
   list (product decision 2026-08-12). They could not have stayed: a parent's
   `<style scoped>` cannot reach a child component's internals, so leaving copies
   here would have been dead CSS that looks authoritative. The component's block
   carries the derivations (the 320px ellipsis guard, the column widths, why every
   value it shares with `friends-theme.css` is byte-identical). */
.sr-radio {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.radiorow:has(:focus-visible) {
  box-shadow: 3px 3px 0 var(--accent);
}

@supports not selector(:has(*)) {
  .radiorow:focus-within {
    box-shadow: 3px 3px 0 var(--accent);
  }
}

/* ⚠ THE 320px FOOTER, MEASURED — not assumed to wrap. `.btn` is
   `white-space:nowrap`, so a `.m-foot` row that does not fit does NOT wrap: the
   buttons paint outside the modal's 4px border and `.modal-scrim` (whose
   `overflow-y:auto` computes `overflow-x` to `auto`) grows a horizontal
   scrollbar. Same class of hazard as the cartbar's actions row, one layer up.

   The arithmetic, at viewport W: the scrim takes 18px a side, `.modal` 4px of
   border a side, `.m-foot` 18px of padding a side, and the two buttons are
   separated by an 8px gap — so the row has `W − 80` to spend. Measured on this
   build at 320px (fallback face, which is the WIDE one here — Figtree is
   narrower): `Zrušiť` 78.69 + `Potvrdiť a odoslať` 156.05 + 8 = 242.73 against
   240. It overflows by 2.73px, i.e. every viewport below ~323px. The other three
   footers (`OK`; `Nie`/`Áno, zrušiť`; `Zostať`/`Opustiť`) land exactly on 240.

   Fixed by spending horizontal PADDING rather than copy: 04 §UC-FO-010 pins the
   labels verbatim, and shortening one to fit would be the wrong trade. The
   buttons are `flex:1` (`.m-foot .btn`), so they re-grow to fill the row either
   way — the padding is only ever their MINIMUM.

   ⚠ CORRECTED BY RD-GX-4 — "which is why this is invisible at every width" USED
   TO STAND HERE AND IS FALSE FOR ONE OF THE FOUR FOOTERS. `.m-foot .btn` is
   `flex:1` (grow 1, basis 0) with the flexbox default `min-width:auto`, so each
   button's min-content is its FLOOR — and the relief is invisible only while the
   even split already clears both floors. That holds for three of these footers
   and not for the one whose overflow motivated the relief. Re-measured on this
   build (relief vs. the canon 16px, real modals, same face):

     Spôsob prevzatia   378px  145.00 / 145.00    against  133.95 / 156.05
                        360px  127.95 / 144.05    against  115.95 / 156.05
                        320px   87.95 / 144.05    against   78.69 / 156.05  (OVERFLOWS)
     Hotovo! (OK)       every width: identical — one `flex:1` button fills the row
     Zrušiť objednávku? every width: identical — 180.93 min-content sum, both
                        floors sit under the even split from 320px up
     Neuložené zmeny    every width: identical — same, 180.66

   At 378px `Potvrdiť a odoslať` is pinned at its own 156.05 under the canon and
   squeezes `Zrušiť` to what is left; the relief lowers both floors under the even
   split, so flex distributes evenly and that footer becomes SYMMETRIC. Better
   looking, and a change — the same shape RD-GX-3 found on the guest cancel
   confirm. Recorded rather than repeated. Above 400px the query does not apply and
   all four are untouched.

   400px, not 323px: it costs only the redistribution tabulated above (nothing
   above 323 was overflowing anyway), it stays well below the 420px cap where `.modal` stops
   being viewport-bound, and it leaves room for a wider face than the one
   measured here. Scoped to this view's own footer buttons — `.m-foot .btn` is
   module 02's rule and every other dialog on this shell keeps its canon
   padding. */
@media (max-width: 400px) {
  .fo-foot-btn {
    padding-left: 10px;
    padding-right: 10px;
  }
}
</style>
