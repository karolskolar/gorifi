<script setup>
import { ref, computed, onMounted, watch, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import api from '../api'
import GuestBrandHeader from '@/components/GuestBrandHeader.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoModal from '@/components/neo/NeoModal.vue'
import PaymentModal from '@/components/PaymentModal.vue'
import GuestProductGrid from '@/components/GuestProductGrid.vue'
import GuestInviteRequest from '@/components/GuestInviteRequest.vue'
import { fmtEur } from '@/lib/money'
import {
  availabilityMap,
  cartFromOrderItems,
  cartLines,
  itemsPayload,
  linesTotal,
  variantText
} from '@/lib/guest-cart'

// The guest's personal status page — route `/g/:token/o/:orderToken`
// (§UC-GSO-004, restyled by 06 §UC-GX-006/007/008). No account and no password:
// the PAIR of tokens in the URL is the whole credential, so this page carries no
// auth headers at all (api.guestRequest).
//
// ============================ RD-GX-3 (06 §UC-GX-006..008) ============================
// ⚠ THE `.app` ROOT IS THE POINT OF THIS ROW, not a detail of it. Every theme rule
// is `:where(.app,.modal-layer) …`, and this view had no `.app` ancestor — so from
// RD-GX-1 (which lifted the SHARED `GuestProductGrid` onto the neo card) until this
// row, the edit screen rendered that grid with EVERY theme class resolving to
// nothing. Measured on the build immediately before this change:
//
//     .cat-tabs   textContent "EspressoFilter"   display:block   gap:normal
//     .stepper    textContent "−1+"              display:block   border-width:0px
//     .vbox       "250g11.20 EUR−1+"                             border-width:0px
//     .card       border-width:0px  box-shadow:none
//
// i.e. the purpose tabs ran together into one word and the stepper read as three
// glued glyphs. Fully functional and `guest-status.spec.js` green throughout —
// which is exactly why nothing caught it. §UC-GX-006 requires the root anyway.
//
// ⚠ `.app > * { position:relative; z-index:1 }` NEUTRALISES Tailwind positioning
// utilities on a DIRECT child (`fixed`/`absolute`/`sticky` alike, silently). That
// is why edit mode's footer is the theme's `.cartbar` — declared later at equal
// specificity, so its `position:sticky` wins — and why the shipped
// `fixed bottom-0 z-50` footer plus its `<div class="h-36">` spacer are both gone.
//
// The status-404 card (§UC-GX-010) and `GuestInviteRequest` (§UC-GX-009) are
// RD-GX-4's — every screen on this route is now on the neo shell.
//
// Four states, driven entirely by the server's flags so the page can
// never offer an action the backend would refuse:
//   - editable  — the cycle is open, the link is alive, the sub-order is live:
//                 items can be changed through the same grid as `/g/:token`, and
//                 emptying the cart cancels the sub-order.
//   - paid      — the admin has recorded the payment: the ITEMS are frozen (the
//                 server 409s a non-empty edit, because what is owed cannot change
//                 after the money arrived), but the sub-order can still be
//                 CANCELLED, so the page offers exactly that and nothing more.
//   - read-only — the cycle has locked (or the host deactivated the link). The
//                 order and the payment reference stay on screen, because the
//                 guest still owes the money; only the edit affordances go.
//   - cancelled — terminal. There is no way back from here (the lifecycle diagram
//                 has no cancelled → submitted edge), and GSO-T5's host-delete
//                 produces the same state.
//
// `paid` (toggled by the ADMIN, GSO-T6) and `delivered` (by the HOST, GSO-T5) are
// displayed read-only. "Zaplatiť" re-opens the shared PaymentModal and disappears
// once `paid` is set.

const route = useRoute()
const token = computed(() => route.params.token)
const orderToken = computed(() => route.params.orderToken)

const GUEST_STORAGE_KEY = 'gorifi_guest_orders'

const loading = ref(true)
const unavailable = ref(null) // { status, message } when the pair does not resolve
const cycle = ref(null)
const host = ref(null)
const order = ref(null)
const items = ref([])
const payment = ref(null)
const editable = ref(false)
// A SECOND, finer flag from the server (GSO-T6): once the admin records the payment,
// the ITEMS are frozen — what is owed may not be rewritten after the money arrived —
// while cancelling the whole sub-order stays allowed. Both come from the backend so
// this page can still never offer an action the backend would refuse.
const itemsEditable = ref(false)
const products = ref([])
const availability = ref({})
// GSO-T10 (§Lead Capture): whether to offer the "ask for your own account" CTA, and
// whether this guest's number is already in the invitations queue. Both come from the
// server — the page cannot tell a locked cycle (CTA still valid) from a dead link
// (the endpoint 410s) on its own, since both merely clear `editable`. Defaults to
// "not available", so a payload without the flag offers nothing.
const inviteRequest = ref({ available: false, requested: false })

const showPaymentModal = ref(false)

// Edit mode
const editing = ref(false)
const cart = ref({})
const activeTab = ref('')
const saving = ref(false)
const editError = ref('')
const showCancelConfirm = ref(false)

// ⚠ Sequence guard on every async request, per the GSO-T2 lesson: one component
// instance serves whatever `(:token, :orderToken)` the router hands it, and a save
// races the load that follows it. Without the guard a slow response can overwrite
// a newer one — in GuestShareDialog that made the action buttons act on the wrong
// cycle's link. Here it would show one sub-order's items under another's total.
let loadSeq = 0

const isBakery = computed(() => cycle.value?.type === 'bakery')
const isCancelled = computed(() => order.value?.status === 'cancelled')
const isPaid = computed(() => !!order.value?.paid)
const isDelivered = computed(() => !!order.value?.delivered)
const hasPaymentDetails = computed(() => !!(payment.value?.iban || payment.value?.revolut_username))

const cartItems = computed(() => cartLines(cart.value, products.value))
const cartTotal = computed(() => linesTotal(cartItems.value))

// §UC-GX-006: the background is uniform `--bg` in EVERY state. The per-tab tinting
// (`bg-sky-100`/`bg-stone-200`/…) and the `bg-muted` cancelled wash are both gone —
// the danger banner now carries the cancelled state, not the page colour.

// Why editing is impossible, in the guest's terms. The backend owns the decision;
// this only words it.
const readOnlyReason = computed(() => {
  if (editable.value || isCancelled.value) return ''
  if (cycle.value && cycle.value.status !== 'open') {
    return 'Objednávanie v tomto cykle je uzavreté, objednávku už nie je možné upraviť.'
  }
  return 'Odkaz na túto spoločnú objednávku už nie je aktívny, objednávku už nie je možné upraviť.'
})

const unavailableTitle = computed(() => {
  if (!unavailable.value) return ''
  if (unavailable.value.status === 404) return 'Objednávka sa nenašla'
  return 'Objednávka nie je dostupná'
})

watchEffect(() => {
  document.title = cycle.value?.name ? `${cycle.value.name} - Vaša objednávka` : 'Vaša objednávka'
})

onMounted(load)
// The route params are the identity of what is on screen, so a navigation between
// two status URLs must reload rather than keep the previous sub-order.
watch([token, orderToken], () => {
  editing.value = false
  load()
})

async function load() {
  const seq = ++loadSeq
  loading.value = true
  unavailable.value = null
  try {
    const data = await api.getGuestOrderStatus(token.value, orderToken.value)
    if (seq !== loadSeq) return
    applyStatus(data)
  } catch (e) {
    if (seq !== loadSeq) return
    // 404 is the only failure the guest can act on: a mistyped or truncated URL.
    unavailable.value = { status: e.status || 0, message: e.message }
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

// Both GET and PUT answer with the same payload, so an edit needs no follow-up
// round trip (these endpoints share one abuse-limiter bucket with the public
// invite-code lookup).
function applyStatus(data) {
  cycle.value = data.cycle
  host.value = data.host
  order.value = data.order
  items.value = data.items || []
  payment.value = data.payment
  editable.value = !!data.editable
  // Older payloads (before the paid freeze) carried only `editable`; fall back to it
  // rather than silently locking every edit.
  itemsEditable.value = data.items_editable === undefined ? !!data.editable : !!data.items_editable
  products.value = data.products || []
  availability.value = availabilityMap(data.availability)
  inviteRequest.value = {
    available: !!data.invite_request?.available,
    requested: !!data.invite_request?.requested
  }
  refreshStoredEntry()
}

// GSO-T3 wrote this entry on the confirmation screen, keyed by link token; keep it
// current so the "your order" card a returning guest sees is not stale.
function refreshStoredEntry() {
  try {
    const raw = localStorage.getItem(GUEST_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    const store = parsed && typeof parsed === 'object' ? parsed : {}
    const existing = store[token.value]
    // Only touch OUR entry — a device may hold sub-orders for several links, and a
    // newer sub-order on this link must not be overwritten by an older one.
    if (existing && existing.order_token !== orderToken.value) return
    store[token.value] = {
      order_id: order.value?.id,
      order_token: orderToken.value,
      status_url: `${window.location.origin}/g/${token.value}/o/${orderToken.value}`,
      guest_name: order.value?.guest_name,
      cycle_name: cycle.value?.name || '',
      total: order.value?.total,
      status: order.value?.status,
      saved_at: new Date().toISOString()
    }
    localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(store))
  } catch (e) {
    // Private mode / full storage: purely a convenience, never break the page.
  }
}

function startEditing() {
  editError.value = ''
  cart.value = cartFromOrderItems(items.value)
  editing.value = true
}

function stopEditing() {
  editing.value = false
  editError.value = ''
  showCancelConfirm.value = false
}

// ⚠ THE CANCEL CONFIRM HAS THREE ENTRY POINTS AND ONE PAYLOAD (§UC-GX-008):
//   1. `saveEdit()` with an empty cart — the funnel below;
//   2. edit mode's ghost "Zrušiť objednávku" under the cartbar actions;
//   3. the paid-frozen read view's ghost "Zrušiť objednávku" (no edit mode to
//      enter — the server 409s a non-empty edit once `paid` is set, GSO-T6).
// All three land on `confirmCancel()`, which sends a LITERAL `items: []`. That is
// the only payload the server accepts as a cancel: GSO-T4 hard rule — `items`
// absent, non-array, or non-empty-but-unpriceable must 400 non-destructively,
// because before that guard `PUT {}` returned 200 and irreversibly cancelled the
// order. Nothing on this page may reach `submitEdit` with anything else meaning
// "cancel".

// Emptying the cart cancels the sub-order, which is irreversible — so the empty
// save funnels into the same confirmation as the explicit "Zrušiť objednávku",
// rather than quietly PUTting `items: []` on the guest's behalf.
function saveEdit() {
  if (cartItems.value.length === 0) {
    showCancelConfirm.value = true
    return
  }
  submitEdit(itemsPayload(cartItems.value))
}

function requestCancel() {
  editError.value = ''
  showCancelConfirm.value = true
}

function confirmCancel() {
  showCancelConfirm.value = false
  submitEdit([])
}

async function submitEdit(payloadItems) {
  const seq = ++loadSeq
  saving.value = true
  editError.value = ''
  try {
    const data = await api.updateGuestOrder(token.value, orderToken.value, { items: payloadItems })
    if (seq !== loadSeq) return
    applyStatus(data)
    editing.value = false
  } catch (e) {
    if (seq !== loadSeq) return
    // 409 = the cycle locked, or the sub-order was cancelled meanwhile (possibly
    // by the host); 410 = the link died; 400 = bounds or a stock limit. In the
    // first two cases the page's whole premise changed, so reload it.
    editError.value = [e.message, ...(e.details || [])].join(' ')
    if (e.status === 409 || e.status === 410) {
      // load() takes the next sequence number, so it wins over anything still in
      // flight and the reloaded page explains the new situation itself (read-only
      // notice, or the terminal cancelled state).
      editing.value = false
      await load()
    }
  } finally {
    // Not sequence-guarded, unlike the state above: the button is disabled while
    // `saving`, so there is only ever one save in flight, and a guard here would
    // leave it stuck after the reload above took the next sequence number.
    saving.value = false
  }
}

// The on-card payment-reference row and its hand-rolled copy helper are GONE
// (§UC-GX-006, resolved conflict #4): the reference lives ONLY inside the Platba
// modal now, where `NeoCopyRow` owns the clipboard write, the 2 s "Skopírované!"
// window and the missing-clipboard fallback per instance (RD-GX-2 landed that row
// in `PaymentModal.vue`). Reachable from here via "Zaplatiť" in every state that
// still owes money.
</script>

<template>
  <!-- ⚠ THE `.app` ROOT — see the header note. Without it every `.card`,
       `.cat-tabs`, `.vbox`, `.stepper`, `.banner` and `.statuspill` below resolves
       to nothing, because the whole theme is scoped `:where(.app,.modal-layer)`.
       `flex flex-col` + the theme's `min-height:100vh` is the prototype's root
       layout, and it is what lets edit mode's page column take `flex-1` so the
       `.cartbar` sits at the viewport bottom on a short page. -->
  <div class="app flex flex-col">
    <!-- ================= status-404 (§UC-GX-010) =================
         The (link, order) pair does not resolve: a mistyped or truncated URL, or
         a cross-link `orderToken` (GSO-T4's read resolver is 404-ONLY and gives the
         same message either way — no oracle).

         ⚠ THIS IS A COMPOSITION DECISION, NOT NEW BEHAVIOUR. The prototype does not
         design this screen; §UC-GX-010 reuses g-dead's visual — same badge, same
         floating card, same closing shape — because the two are the same dead end
         seen from two URLs, and a guest who mistypes one is as lost as one who
         mistypes the other. The COPY is the shipped copy: the title, the server's
         own message line, and the "skopírovaný celý" instruction all stand, because
         the pair-resolution failure has an actionable cause the g-dead variants do
         not share.

         ⚠ This is the ONLY dead card on this route. A locked cycle or a dead link
         must still render the order and the payment reference (GSO-T4's read
         resolver is deliberately 404-only), so they land on the read-only banner
         below — never here. -->
    <template v-if="unavailable">
      <GuestBrandHeader subtitle="Vaša objednávka" />

      <div class="flex-1 flex items-center justify-center p-5 sm:p-10">
        <div
          class="card p-[22px] sm:p-[30px]"
          style="max-width:400px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center"
          data-testid="guest-status-unavailable"
        >
          <!-- ⚠ `inline-flex`, for the reason measured on GuestOrder.vue's twin:
               Tailwind preflight's `svg{display:block}` breaks the prototype's
               `inline-block` badge into two lines (41.14px tall becomes 52.41px, and
               the glyph drops 6.13px off centre). The 4px gap replaces the
               prototype's literal space, which a flex container strips anyway. -->
          <span class="badge danger" style="font-size:13px;padding:6px 14px;transform:rotate(-2deg);display:inline-flex;align-items:center;gap:4px"><NeoIcon name="lock" /><span>Slepá ulička</span></span>
          <h1 class="h-screen text-[32px] sm:text-[38px]">{{ unavailableTitle }}</h1>
          <div class="sub" style="font-size:14px">{{ unavailable.message }}</div>
          <div class="sub" style="font-size:13.5px">Skontrolujte, či je odkaz skopírovaný celý. Ak nie, požiadajte kolegu, ktorý objednávku organizuje.</div>
        </div>
      </div>
    </template>

    <template v-else>
      <!-- ONE instance across both purposes: only the subtitle switches
           ("Vaša objednávka" ⇄ "Úprava objednávky", §UC-GX-006/007). Rendering two
           `GuestBrandHeader`s under separate `v-if`s would remount the ticker on
           every entry into edit mode. Also mounted ABOVE the loading state, so the
           chrome never flashes in and out. -->
      <GuestBrandHeader :subtitle="editing ? 'Úprava objednávky' : 'Vaša objednávka'" />

      <div v-if="loading" class="mx-auto w-full max-w-[520px] px-4 sm:px-7 py-4 sm:py-7 flex-1">
        <div class="sub" style="text-align:center;padding:32px 0">Načítavam…</div>
      </div>

      <!-- ===================== g-status EDIT MODE (§UC-GX-007) =====================
           Items-only by construction: there is no name/phone/email field anywhere in
           here. Identity is frozen at submit (GSO-T4) precisely because anyone
           holding the URL could otherwise rewrite someone else's contact details.

           The column WIDENS to the grid layout (760, not the read view's 520) — the
           product cards need it, and it is the same scaffold as `/g/:token`. -->
      <template v-else-if="editing">
        <div class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7 pb-2 sm:pb-2 flex flex-col gap-[14px] flex-1">
          <div class="banner slim">
            <span class="dot"></span>
            <span style="min-width:0">Upravujete objednávku pre <b>{{ order?.guest_name }}</b>. Zmeny sa prejavia po uložení.</span>
          </div>

          <!-- A 400 (bounds, or a stock limit whose per-product detail lines ride in
               `details`) keeps the guest IN edit mode with their cart intact; a
               409/410 exits and reloads, so it surfaces as `status-error` instead. -->
          <div v-if="editError" class="banner danger slim" role="alert">
            <span class="dot"></span><span data-testid="edit-error" style="min-width:0">{{ editError }}</span>
          </div>

          <!-- The SHARED grid (GSO-T4: one home, two screens — extend, never fork).
               `availability` here is the server's `excludeGuestOrderId`-adjusted map,
               so the grams this sub-order already holds are not shown as taken; the
               grid must not care which screen feeds it. -->
          <GuestProductGrid
            v-model="cart"
            v-model:active-tab="activeTab"
            :products="products"
            :availability="availability"
            :is-bakery="isBakery"
          />
        </div>

        <!-- ⚠ A DIRECT CHILD OF `.app`, after the page column. The theme's
             `.cartbar` is `position:sticky` and wins over `.app > *` by being
             declared later at equal specificity; the shipped `fixed` footer would
             not have survived that rule at all, and its `h-36` spacer would now be
             144px of dead space at the end of the page. -->
        <div class="cartbar">
          <div class="meta" style="align-items:center">
            <span class="sum" data-testid="edit-total">Celkom: {{ fmtEur(cartTotal) }}</span>
            <span class="sub" style="font-size:13px">Položiek: {{ cartItems.length }}</span>
          </div>
          <div class="actions">
            <button type="button" class="btn sm" data-testid="abort-edit" :disabled="saving" @click="stopEditing">Späť</button>
            <button type="button" class="btn accent sm" data-testid="save-edit" :disabled="saving" @click="saveEdit">{{ saving ? 'Ukladám…' : 'Uložiť zmeny' }}</button>
          </div>
          <!-- Entry point 2 of 3 into the cancel confirm. Deliberately OUTSIDE
               `.actions` (whose `.btn` children are `flex:1; min-height:46px`) so it
               keeps ghost weight — cancelling is not a peer of saving. -->
          <button
            type="button"
            class="btn ghost sm"
            style="color:var(--danger);margin-top:4px"
            data-testid="cancel-order"
            :disabled="saving"
            @click="requestCancel"
          >Zrušiť objednávku</button>
        </div>
      </template>

      <!-- ===================== g-status READ VIEW (§UC-GX-006) =====================
           Four states off the SERVER's flags, never off a guess:
             editable     `items_editable`            → Upraviť + Zaplatiť
             paid-frozen  `editable && isPaid`        → pills + ghost cancel only
             read-only    `!editable && !isCancelled` → Zaplatiť + warn banner
             cancelled    `status === 'cancelled'`    → danger banner, struck lines
           `items_editable = editable && !paid` (GSO-T6), so the paid case can never
           show an edit affordance the backend would 409. -->
      <div
        v-else
        class="mx-auto w-full max-w-[520px] px-4 sm:px-7 py-4 sm:py-7 flex flex-col gap-[14px]"
        data-testid="guest-status"
      >
        <!-- ⚠ `line-height:normal` at the CALL SITE, and it is load-bearing: the
             guest-name line below carries no class, so preflight's `1.5` strut
             reaches it while `.h-screen` and `.sub` declare their own. A9/A10 are
             CLASS lists and cannot reach an element with no class — the fix belongs
             here, never as a widening of A10 (friends-theme.css, A10 block).
             MEASURED on this build: the block is 103px at `normal` and 108px at
             `1.5` — +5px of drift, which is exactly the class A10 exists to undo. -->
        <div style="line-height:normal">
          <h1 class="h-screen text-[30px] sm:text-[36px]">{{ cycle?.name }}</h1>
          <!-- The prototype adds "a odovzdá" to the shipped line; the separate
               "Tovar vám odovzdá {host}." footer line is dropped as a result. -->
          <div class="sub" style="margin-top:8px">Vaša objednávka · organizuje a odovzdá {{ host?.first_name }}</div>
          <div style="font-weight:700;margin-top:4px">{{ order?.guest_name }}</div>
        </div>

        <!-- Cancelled is TERMINAL (the lifecycle diagram has no cancelled →
             submitted edge, and GSO-T5's host-delete produces the same state), so it
             replaces the pills outright rather than adding a third one. -->
        <div v-if="isCancelled" class="banner danger" data-testid="status-cancelled">
          <span class="dot"></span>
          <span style="min-width:0">Táto objednávka bola <b>zrušená</b>. Ak si chcete objednať znova, požiadajte kolegu o odkaz na spoločnú objednávku.</span>
        </div>

        <!-- Flags with SINGLE OWNERS (GSO-T6 Decision 2): `paid` is the ADMIN's,
             `delivered` is the HOST's. Read-only here — this page owns neither, and
             offers no control that could write one. -->
        <div v-else class="flex flex-wrap gap-2">
          <span class="statuspill" :class="isPaid ? 'ok' : 'warn'" data-testid="status-paid"><span class="sq"></span>{{ isPaid ? 'Zaplatené' : 'Nezaplatené' }}</span>
          <span class="statuspill" :class="isDelivered ? 'ok' : 'off'" data-testid="status-delivered"><span class="sq"></span>{{ isDelivered ? 'Odovzdané' : 'Zatiaľ neodovzdané' }}</span>
        </div>

        <!-- Items + total. A cancelled sub-order KEEPS its lines — GSO-T4 cancels by
             `UPDATE … SET total = 0, status = 'cancelled'` and never deletes rows,
             because the status predicate is what releases the stock and what every
             aggregate filters on. They are the record of what was called off, so
             they are shown struck under their own heading and WITHOUT a total. -->
        <div class="card" style="padding:16px">
          <div v-if="isCancelled" class="field-lbl" :style="items.length > 0 ? null : 'margin:0'">Zrušené položky</div>

          <!-- ⚠ `line-height:normal` is LOAD-BEARING here too, and by much more: the
               left `<span>` of each line carries no class, so preflight's 1.5 reaches
               it while its `.mono` sibling (covered by A10) is already at `normal` —
               the two halves of one row would sit on different strut heights.
               MEASURED on a 3-item order: 108px at `normal` against 133.5px at `1.5`,
               i.e. +8.5px on EVERY line. -->
          <div
            v-if="items.length > 0"
            style="display:flex;flex-direction:column;gap:6px;font-size:13.5px;color:var(--ink-dim);line-height:normal"
            :style="{ textDecoration: isCancelled ? 'line-through' : 'none' }"
          >
            <div
              v-for="item in items"
              :key="item.id"
              style="display:flex;justify-content:space-between;gap:10px"
              data-testid="status-item"
            >
              <!-- `×` is U+00D7 MULTIPLICATION SIGN, not the letter "x" (prototype).
                   Line amounts are BARE `toFixed(2)` — no " EUR": the card's own
                   "Celkom" row states the unit and these are a breakdown. -->
              <span>{{ item.product_name }} ({{ variantText(item) }}) ×{{ item.quantity }}</span>
              <span class="mono">{{ (item.price * item.quantity).toFixed(2) }}</span>
            </div>
          </div>
          <!-- Shipped zero-item fallback, kept (§UC-GX-006 item 3). It carries
               `status-total` itself, so exactly ONE node ever holds that testid. -->
          <div v-else-if="!isCancelled" class="sub" data-testid="status-total">Žiadne položky · {{ fmtEur(order?.total) }}</div>

          <template v-if="!isCancelled && items.length > 0">
            <hr class="divider" style="margin:12px 0" />
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
              <span class="field-lbl" style="margin:0">Celkom</span>
              <span class="display" style="font-size:22px" data-testid="status-total">{{ fmtEur(order?.total) }}</span>
            </div>
          </template>
        </div>

        <!-- ================= actions, by state (§UC-GX-006 item 4) =================
             Every branch is gated on a SERVER flag, so the page can never offer an
             action the backend would refuse. -->

        <!-- editable: Upraviť + Zaplatiť. The pay button is `flex:1.6` — it is what
             the guest is here to do; editing is the smaller of the two. -->
        <div v-if="itemsEditable && !isCancelled" style="display:flex;gap:8px">
          <button type="button" class="btn" style="flex:1" data-testid="start-edit" @click="startEditing">Upraviť</button>
          <button
            v-if="!isPaid && hasPaymentDetails"
            type="button"
            class="btn ok"
            style="flex:1.6"
            data-testid="open-payment"
            @click="showPaymentModal = true"
          >Zaplatiť</button>
        </div>

        <!-- paid-frozen: the pills already say Zaplatené, so there is no banner and
             no thank-you line (resolved conflict #5 — the prototype is pills + a
             ghost cancel and nothing else). No edit mode to enter: the server 409s a
             non-empty edit once `paid` is set, but a literal `items: []` still
             cancels, which is exactly what this button sends. Entry point 3 of 3. -->
        <button
          v-else-if="editable && isPaid && !isCancelled"
          type="button"
          class="btn ghost sm"
          style="color:var(--danger)"
          data-testid="cancel-order"
          :disabled="saving"
          @click="requestCancel"
        >{{ saving ? 'Ruším…' : 'Zrušiť objednávku' }}</button>

        <!-- read-only / locked: the money is still owed, so Zaplatiť STAYS. GSO-T4's
             read resolver is deliberately 404-only — a locked cycle or a dead link
             must still render the order and reach the payment reference. -->
        <template v-else-if="!editable && !isCancelled">
          <button
            v-if="!isPaid && hasPaymentDetails"
            type="button"
            class="btn ok block"
            data-testid="open-payment"
            @click="showPaymentModal = true"
          >Zaplatiť</button>
          <div class="banner warn slim" data-testid="status-readonly">
            <span class="dot"></span><span style="min-width:0">{{ readOnlyReason }}</span>
          </div>
        </template>

        <!-- An error from a cancel started OUTSIDE edit mode (the paid-frozen button
             above) has nowhere else to appear — `edit-error` is not mounted here. -->
        <div v-if="editError" class="banner danger slim" role="alert">
          <span class="dot"></span><span data-testid="status-error" style="min-width:0">{{ editError }}</span>
        </div>

        <!-- Lead capture (§UC-GSO-015 / §UC-GX-009 — restyle is RD-GX-4's). Offered
             in ALL FOUR states, cancelled included: resolved conflict #3 makes the
             SERVER's `available` flag the authority over the prototype, which hides
             it when cancelled. A cancelled guest is still a lead (GSO-T10 returns
             201 there), and a locked cycle is exactly when they ask. A dead link
             clears `available`, so nothing is offered that would 410. Hidden while
             editing, where the cart has the screen. -->
        <GuestInviteRequest
          v-if="inviteRequest.available"
          :token="token"
          :order-token="orderToken"
          :name="order?.guest_name || ''"
          :phone="order?.guest_phone || ''"
          :email="order?.guest_email || ''"
          :requested="inviteRequest.requested"
        />
      </div>
    </template>

    <!-- ================= Zrušiť objednávku? confirm (§UC-GX-008) =================
         ⚠ MOUNTED WITH `v-if`, and that is load-bearing, not a style choice.
         `NeoModal` has no `open` prop — the parent owns mounting — and three
         shipped guest specs locate controls with role+name queries that are
         unscoped or scoped only to `getByRole('dialog')` (`guest-status.spec.js:665`,
         `guest-order.spec.js:879`, `guest-lead-capture.spec.js:466` — each clicks a
         "Zavrieť" that must resolve to exactly one node). An
         always-mounted dialog would keep its own footer in the DOM AND leave
         `.modal-scrim` (pointer-events:auto over the whole viewport) swallowing
         those clicks.

         The × is named "Zatvoriť dialóg" — a deliberate SYNONYM, because Playwright
         matches accessible names as a case-insensitive SUBSTRING. Neither footer
         label here is a substring of the other or of the ×.

         ⚠ ONE PAYLOAD: `confirmCancel()` sends a literal `items: []`. Anything else
         — `items` absent, non-array, non-empty-but-unpriceable — must 400
         non-destructively server-side, and this modal must never send it. -->
    <NeoModal
      v-if="showCancelConfirm"
      title="Zrušiť objednávku?"
      subtitle="Objednávka sa zruší a už ju nebude možné obnoviť. Ak si budete chcieť objednať znova, požiadajte kolegu o odkaz."
      @close="showCancelConfirm = false"
    >
      <div class="banner danger slim">
        <span class="dot"></span><span style="min-width:0">Toto sa nedá vrátiť späť.</span>
      </div>
      <template #footer>
        <button type="button" class="btn gx-foot-btn" data-testid="keep-order" @click="showCancelConfirm = false">Ponechať</button>
        <button
          type="button"
          class="btn danger gx-foot-btn"
          data-testid="confirm-cancel-order"
          :disabled="saving"
          @click="confirmCancel"
        >{{ saving ? 'Ruším…' : 'Zrušiť objednávku' }}</button>
      </template>
    </NeoModal>

    <!-- Same payment modal friends and the confirmation screen use (§UC-GX-005).
         Since RD-GX-2 it carries the payment-reference copy row, which is now the
         ONLY place the reference is shown. It mounts its own `NeoModal` under
         `v-if="open"`, so nothing of it is in the DOM while closed. -->
    <PaymentModal
      v-if="payment"
      :open="showPaymentModal"
      :amount="payment.amount"
      :reference="payment.reference"
      :iban="payment.iban"
      :revolut-username="payment.revolut_username"
      @close="showPaymentModal = false"
    />
  </div>
</template>

<!-- ⚠ THE 320px FOOTER, MEASURED — not assumed to wrap. `.btn` is
     `white-space:nowrap` and `.m-foot .btn` is `flex:1`, so a footer row that does
     not fit gives NO degradation signal at all: no shrink, no wrap, no ellipsis —
     the buttons paint outside the modal's 4px border and `.modal-scrim` grows a
     horizontal scrollbar. Same hazard RD-FO-4 and RD-GX-1 each measured one screen
     over — but with different labels, and the numbers below are this footer's own.

     The arithmetic at viewport W: the scrim takes 18px a side, `.modal` 4px of
     border a side, `.m-foot` 18px of padding a side, and the two buttons are
     separated by an 8px gap — so the row has `W − 80` to spend. Measured on this
     build against the MIN-CONTENT need (a clone of `.m-foot` at `width:min-content`
     — NOT the flex-resolved width, which is bounded below by each item's own
     min-content and therefore hides how far the ROW overflows):

       at the canon 16px a side:  Ponechať 101.25 + Zrušiť objednávku 159.77 + 8
                                  = 269.02   against 240 @320px  → over by 29.02
       at RD-FO-4/RD-GX-1's 10px: Ponechať  89.25 + Zrušiť objednávku 147.77 + 8
                                  = 245.02   against 240 @320px  → STILL over by 5.02

     ⚠ 10px is NOT enough here, unlike on the two footers that set the precedent:
     "Zrušiť objednávku" is the longest confirm label on this shell (127.77px of
     glyphs alone against RD-FO-4's 136.05 for a label that had 4 more px of room).
     6px a side takes the row to 229.02 — 10.98px of headroom, the same order of
     slack RD-GX-1 left itself, so a wider face than the one measured still fits.
     (`.btn` min-content is width-invariant, so the same numbers hold at 320/335/378;
     only `available` moves.)

     Fixed by spending horizontal PADDING, not copy: §UC-GX-008 pins both labels
     verbatim. `.m-foot .btn` is `flex:1` (grow 1, basis 0) with the flexbox default
     `min-width:auto`, so each button's MIN-CONTENT is its floor and the padding only
     ever moves that floor.

     ⚠ NOT "invisible at every width" — RD-FO-4 and RD-GX-1 both claimed that of
     their own reliefs, and MEASURED HERE IT IS NOT TRUE, so it was recorded rather
     than repeated. RD-GX-4 then went back and measured those two as well: the claim
     is false there too (on the `Spôsob prevzatia` and guest-checkout footers; it
     does hold for the three whose min-content sum already sits under the even
     split), and both call-site comments now carry their own numbers. Resolved
     widths here, with the relief vs. with the canon 16px:

       378px   145.00 / 145.00      against   130.23 / 159.77
       320px    92.23 / 139.77      against   101.25 / 159.77  (which OVERFLOWS)
       >400px  identical — the query does not apply

     At 378px the canon floor pins "Zrušiť objednávku" at its own min-content and
     squeezes "Ponechať" to what is left; the relief lowers both floors under the
     even split, so flex distributes evenly and the footer becomes SYMMETRIC. That
     is a visible change and a better one, but it is a change, and the prototype
     renders the lopsided version. Accepted on the same basis the two precedent rows
     chose 400px: one threshold across all three footers on this shell beats three,
     it stays below the 420px cap where `.modal` stops being viewport-bound, and it
     leaves room for a wider face than the one measured. 6px rather than the
     precedents' 10px because 10px still overflowed here (see the arithmetic above)
     — this is the longest confirm label on the shell.

     Scoped to this view's own footer buttons: `.m-foot .btn` is module 02's rule and
     every other dialog on this shell keeps its canon padding. (Vue's scope attribute
     lands on slot content authored here even though `NeoModal` teleports it to
     `body` — verified on the rendered node, which carries this component's
     `data-v-*`.) -->
<style scoped>
@media (max-width: 400px) {
  .gx-foot-btn {
    padding-left: 6px;
    padding-right: 6px;
  }
}
</style>
