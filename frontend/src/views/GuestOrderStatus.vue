<script setup>
import { ref, computed, onMounted, watch, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import PaymentModal from '@/components/PaymentModal.vue'
import GuestProductGrid from '@/components/GuestProductGrid.vue'
import GuestInviteRequest from '@/components/GuestInviteRequest.vue'
import {
  availabilityMap,
  cartFromOrderItems,
  cartLines,
  formatPrice,
  itemsPayload,
  linesTotal,
  variantText
} from '@/lib/guest-cart'

// The guest's personal status page — route `/g/:token/o/:orderToken`
// (§UC-GSO-004). No account and no password: the PAIR of tokens in the URL is the
// whole credential, so this page carries no auth headers at all (api.guestRequest).
//
// Three states, driven entirely by the server's `editable` flag so the page can
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

const backgroundClass = computed(() => {
  if (isCancelled.value) return 'bg-muted'
  if (isBakery.value) {
    if (activeTab.value === 'Slané') return 'bg-amber-50'
    if (activeTab.value === 'Sladké') return 'bg-pink-50'
    return 'bg-background'
  }
  if (activeTab.value === 'Espresso') return 'bg-stone-200'
  if (activeTab.value === 'Filter') return 'bg-sky-100'
  if (activeTab.value === 'Kapsule') return 'bg-amber-100'
  return 'bg-background'
})

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

// Emptying the cart cancels the sub-order, which is irreversible — so the empty
// save funnels into the same confirmation as the explicit "Zrušiť objednávku".
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

const copied = ref(false)

async function copyReference() {
  const text = payment.value?.reference
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch (e) {
    // Fallback for browsers without the async clipboard API (mirrors
    // GuestOrder.copyText) — a guest on an old mobile browser still needs it.
    try {
      const input = document.createElement('input')
      input.value = text
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
    } catch (fallbackError) {
      return // Nothing worked; the value stays selectable on screen.
    }
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <div :class="['min-h-screen transition-colors', backgroundClass]">
    <div v-if="loading" class="max-w-4xl mx-auto px-4 py-16 text-center text-muted-foreground">
      Načítavam…
    </div>

    <!-- The (link, order) pair does not resolve: a mistyped or truncated URL -->
    <div v-else-if="unavailable" class="max-w-md mx-auto px-4 py-16">
      <Card data-testid="guest-status-unavailable">
        <CardContent class="p-6 text-center space-y-3">
          <div class="text-4xl">🔎</div>
          <h1 class="text-xl font-semibold">{{ unavailableTitle }}</h1>
          <p class="text-sm text-muted-foreground">{{ unavailable.message }}</p>
          <p class="text-sm text-muted-foreground">
            Skontrolujte, či je odkaz skopírovaný celý. Ak nie, požiadajte kolegu, ktorý objednávku organizuje.
          </p>
        </CardContent>
      </Card>
    </div>

    <div v-else class="max-w-4xl mx-auto px-4 py-4">
      <Card class="mb-4" data-testid="guest-status">
        <CardContent class="p-4 space-y-3">
          <div>
            <h1 class="text-lg font-semibold">{{ cycle?.name }}</h1>
            <p class="text-sm text-muted-foreground">
              Vaša objednávka · organizuje {{ host?.first_name }}
            </p>
            <p class="text-sm mt-1">{{ order?.guest_name }}</p>
          </div>

          <!-- Cancelled is terminal: say so plainly and offer nothing else. -->
          <Alert v-if="isCancelled" data-testid="status-cancelled">
            <AlertDescription>
              Táto objednávka bola zrušená. Ak si chcete objednať znova, požiadajte kolegu o odkaz na spoločnú objednávku.
            </AlertDescription>
          </Alert>

          <!-- Flags with single owners: paid = admin, delivered = host. Read-only here. -->
          <div v-else class="flex flex-wrap gap-2 text-xs">
            <span
              data-testid="status-paid"
              :class="[
                'px-2 py-0.5 rounded-full border',
                isPaid ? 'border-emerald-400 text-emerald-700 bg-emerald-50' : 'border-amber-400 text-amber-700 bg-amber-50'
              ]"
            >{{ isPaid ? 'Zaplatené' : 'Nezaplatené' }}</span>
            <span
              data-testid="status-delivered"
              :class="[
                'px-2 py-0.5 rounded-full border',
                isDelivered ? 'border-emerald-400 text-emerald-700 bg-emerald-50' : 'border-border text-muted-foreground'
              ]"
            >{{ isDelivered ? 'Odovzdané' : 'Zatiaľ neodovzdané' }}</span>
          </div>

          <!-- Items + total. A cancelled sub-order KEEPS its lines (they are the
               record of what was called off) but owes nothing, so they are shown
               struck through under their own heading and without a total. -->
          <div v-if="items.length > 0" class="rounded-lg border divide-y">
            <div v-if="isCancelled" class="px-3 py-2 text-xs text-muted-foreground">
              Zrušené položky
            </div>
            <div
              v-for="item in items"
              :key="item.id"
              :class="['flex justify-between px-3 py-2 text-sm', isCancelled ? 'text-muted-foreground line-through' : '']"
              data-testid="status-item"
            >
              <span>{{ item.product_name }} ({{ variantText(item) }}) x{{ item.quantity }}</span>
              <span class="whitespace-nowrap">{{ formatPrice(item.price * item.quantity) }}</span>
            </div>
            <div v-if="!isCancelled" class="flex justify-between px-3 py-2 font-semibold">
              <span>Celkom</span>
              <span data-testid="status-total">{{ formatPrice(order?.total) }}</span>
            </div>
          </div>
          <div v-else-if="!isCancelled" class="text-sm text-muted-foreground" data-testid="status-total">
            Žiadne položky · {{ formatPrice(order?.total) }}
          </div>

          <!-- Payment: the reference has to be pasted into the transfer, and
               Revolut cannot pre-fill a note, so it is copyable. -->
          <template v-if="!isCancelled">
            <div class="space-y-1">
              <Label class="text-xs text-muted-foreground">Poznámka k platbe (uveďte ju pri platbe)</Label>
              <div class="flex gap-2">
                <div
                  data-testid="payment-reference"
                  class="flex-1 rounded-md border bg-muted/40 px-3 py-2 text-sm font-mono break-all"
                >{{ payment?.reference }}</div>
                <Button variant="outline" size="sm" data-testid="copy-reference" @click="copyReference">
                  {{ copied ? 'Skopírované' : 'Kopírovať' }}
                </Button>
              </div>
            </div>

            <!-- "Zaplatiť" re-opens the modal until the admin marks it paid. -->
            <Button
              v-if="!isPaid && hasPaymentDetails"
              class="w-full"
              data-testid="open-payment"
              @click="showPaymentModal = true"
            >
              Zaplatiť
            </Button>
            <p v-else-if="isPaid" class="text-sm text-emerald-700">
              Platba je zaevidovaná. Ďakujeme.
            </p>

            <p class="text-xs text-muted-foreground">
              Tovar vám odovzdá {{ host?.first_name }}.
            </p>
          </template>

          <!-- An error from a cancel started OUTSIDE edit mode (the paid case below)
               has no other place to appear — the edit screen's alert is not mounted. -->
          <Alert v-if="editError && !editing" variant="destructive">
            <AlertDescription data-testid="status-error">{{ editError }}</AlertDescription>
          </Alert>

          <!-- Edit affordance, only while the server says an edit would be accepted -->
          <div v-if="itemsEditable && !editing" class="pt-1">
            <Button variant="outline" class="w-full" data-testid="start-edit" @click="startEditing">
              Upraviť objednávku
            </Button>
          </div>
          <!-- Paid: the items are frozen server-side, so no edit button is offered —
               but cancelling is still the guest's own call, and it is the only thing
               the backend would accept here. -->
          <template v-else-if="editable && isPaid && !isCancelled && !editing">
            <Alert data-testid="paid-locked">
              <AlertDescription>
                Platba je zaevidovaná, obsah objednávky už nie je možné zmeniť.
                Zmenu vyriešte so správcom. Objednávku môžete zrušiť.
              </AlertDescription>
            </Alert>
            <Button
              variant="ghost"
              class="w-full text-destructive hover:text-destructive"
              data-testid="cancel-order"
              :disabled="saving"
              @click="requestCancel"
            >
              {{ saving ? 'Ruším…' : 'Zrušiť objednávku' }}
            </Button>
          </template>
          <Alert v-else-if="!editable && !isCancelled" data-testid="status-readonly">
            <AlertDescription>{{ readOnlyReason }}</AlertDescription>
          </Alert>

          <!-- Lead capture (§UC-GSO-015). Offered in ALL four states — editable,
               paid-frozen, read-only after the lock and cancelled — because a guest
               is a lead in every one of them, and a locked cycle is exactly when they
               ask. `available` is the server's call, so a dead link (whose endpoint
               410s) offers nothing. Hidden while editing, where the cart has the
               screen. -->
          <GuestInviteRequest
            v-if="inviteRequest.available && !editing"
            :token="token"
            :order-token="orderToken"
            :name="order?.guest_name || ''"
            :phone="order?.guest_phone || ''"
            :email="order?.guest_email || ''"
            :requested="inviteRequest.requested"
          />
        </CardContent>
      </Card>

      <!-- Edit mode: the same grid as `/g/:token`, pre-seeded with what is ordered -->
      <template v-if="editing">
        <Alert v-if="editError" variant="destructive" class="mb-4">
          <AlertDescription data-testid="edit-error">{{ editError }}</AlertDescription>
        </Alert>

        <GuestProductGrid
          v-model="cart"
          v-model:active-tab="activeTab"
          :products="products"
          :availability="availability"
          :is-bakery="isBakery"
        />

        <!-- Sticky footer, mirroring the ordering screen -->
        <div class="fixed bottom-0 left-0 right-0 bg-card shadow-lg border-t z-50">
          <div class="max-w-4xl mx-auto px-4 py-2 space-y-1.5">
            <div class="flex justify-between items-center gap-2">
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-muted-foreground">Položiek: {{ cartItems.length }}</span>
                <span class="mx-1 text-xs">|</span>
                <span class="font-semibold text-sm" data-testid="edit-total">Celkom: {{ formatPrice(cartTotal) }}</span>
              </div>
              <div class="flex gap-2">
                <Button variant="outline" size="sm" class="h-8 text-xs" data-testid="abort-edit" :disabled="saving" @click="stopEditing">
                  Späť
                </Button>
                <Button size="sm" class="h-8 text-xs" data-testid="save-edit" :disabled="saving" @click="saveEdit">
                  {{ saving ? 'Ukladám…' : 'Uložiť zmeny' }}
                </Button>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 text-xs text-destructive hover:text-destructive"
              data-testid="cancel-order"
              :disabled="saving"
              @click="requestCancel"
            >
              Zrušiť objednávku
            </Button>
          </div>
        </div>
        <div class="h-36"></div>
      </template>
    </div>

    <!-- Cancelling is irreversible (the sub-order cannot be revived), so it is
         confirmed rather than immediate. -->
    <Dialog :open="showCancelConfirm" @update:open="val => showCancelConfirm = val">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Zrušiť objednávku?</DialogTitle>
          <DialogDescription>
            Objednávka sa zruší a už ju nebude možné obnoviť. Ak si budete chcieť objednať znova, požiadajte kolegu o odkaz.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter class="flex gap-2">
          <Button variant="outline" class="flex-1" data-testid="keep-order" @click="showCancelConfirm = false">
            Ponechať
          </Button>
          <Button variant="destructive" class="flex-1" data-testid="confirm-cancel-order" :disabled="saving" @click="confirmCancel">
            {{ saving ? 'Ruším…' : 'Zrušiť objednávku' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Same payment modal friends and the confirmation screen use -->
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
