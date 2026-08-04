<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
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
import {
  availabilityMap,
  cartLines,
  formatPrice,
  itemsPayload,
  linesTotal,
  variantText
} from '@/lib/guest-cart'

// Public guest ordering page — route `/g/:token` (§UC-GSO-001..003).
//
// Same product-card layout as FriendOrder.vue (incl. bakery variant grouping),
// stripped of everything that needs an account: no login, no delivery/pickup
// modal, no drafts, no auto-save. Checkout is name + mobile (+ optional email)
// and one submit; the sub-order is created only by that submit.
//
// The grid itself lives in `components/GuestProductGrid.vue` and the cart maths in
// `lib/guest-cart.js` (GSO-T4), shared with the status/edit screen at
// `/g/:token/o/:orderToken` — this page owns only the cycle header, the cart
// footer and checkout.
//
// Prices arrive from the server with the cycle markup already applied, so this
// page never multiplies by markup_ratio itself — what the guest sees is exactly
// what gets frozen onto guest_order_items.price.

const route = useRoute()
const token = computed(() => route.params.token)

const GUEST_STORAGE_KEY = 'gorifi_guest_orders'

const loading = ref(true)
const unavailable = ref(null) // { status, reason, message } when the link is dead
const cycle = ref(null)
const host = ref(null)
const products = ref([])
const availability = ref({})

const cart = ref({}) // { `${productId}-${variant}`: quantity }
const activeTab = ref('')

const showCheckout = ref(false)
const submitting = ref(false)
const checkoutError = ref('')
const guestName = ref('')
const guestPhone = ref('')
const guestEmail = ref('')

// Confirmation state (§UC-GSO-003)
const confirmation = ref(null) // { order, items, payment, status_url }
const showPaymentModal = ref(false)

const isBakery = computed(() => cycle.value?.type === 'bakery')

const cartItems = computed(() => cartLines(cart.value, products.value))
const cartTotal = computed(() => linesTotal(cartItems.value))

const backgroundClass = computed(() => {
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

watchEffect(() => {
  document.title = cycle.value?.name ? `${cycle.value.name} - Objednávka` : 'Objednávka'
})

onMounted(load)

async function load() {
  loading.value = true
  unavailable.value = null
  try {
    const data = await api.getGuestOrderPage(token.value)
    cycle.value = data.cycle
    host.value = data.host
    products.value = data.products || []
    availability.value = availabilityMap(data.availability)
  } catch (e) {
    // 404 = no such link, 410 = deactivated or cycle closed. Both dead ends, but
    // they need different wording.
    unavailable.value = {
      status: e.status || 0,
      reason: e.reason || null,
      message: e.message
    }
  } finally {
    loading.value = false
  }
}

const unavailableTitle = computed(() => {
  if (!unavailable.value) return ''
  if (unavailable.value.status === 404) return 'Odkaz neexistuje'
  if (unavailable.value.reason === 'inactive') return 'Odkaz už nie je aktívny'
  if (unavailable.value.reason === 'closed') return 'Objednávanie je uzavreté'
  return 'Objednávka nie je dostupná'
})

function openCheckout() {
  checkoutError.value = ''
  showCheckout.value = true
}

// Decision 7: name + mobile required (>= 9 digits), email optional. The server
// validates the same rule — this is only so the guest finds out immediately.
function validateIdentity() {
  if (!guestName.value.trim()) return 'Zadajte svoje meno.'
  const digits = guestPhone.value.replace(/\D/g, '')
  if (digits.length < 9) return 'Zadajte telefónne číslo (aspoň 9 číslic).'
  return ''
}

async function submitOrder() {
  const problem = validateIdentity()
  if (problem) {
    checkoutError.value = problem
    return
  }
  if (cartItems.value.length === 0) {
    checkoutError.value = 'Košík je prázdny.'
    return
  }

  submitting.value = true
  checkoutError.value = ''
  try {
    const payload = {
      guest_name: guestName.value.trim(),
      guest_phone: guestPhone.value.trim(),
      items: itemsPayload(cartItems.value)
    }
    const email = guestEmail.value.trim()
    if (email) payload.guest_email = email

    const result = await api.submitGuestOrder(token.value, payload)
    const statusUrl = `${window.location.origin}${result.status_path}`
    confirmation.value = { ...result, status_url: statusUrl }
    rememberStatusUrl(result, statusUrl)

    showCheckout.value = false
    // §UC-GSO-003: the confirmation opens the payment modal straight away.
    if (result.payment?.iban || result.payment?.revolut_username) {
      showPaymentModal.value = true
    }
  } catch (e) {
    // 409 = the cycle was locked while the guest was shopping; 400 = validation
    // or a stock limit (details lists the products).
    checkoutError.value = [e.message, ...(e.details || [])].join(' ')
  } finally {
    submitting.value = false
  }
}

// Keep the personal status URL on the device so the guest can come back to it
// (the page itself is served by GSO-T4). Stored per link token, newest wins.
function rememberStatusUrl(result, statusUrl) {
  try {
    const raw = localStorage.getItem(GUEST_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    const store = parsed && typeof parsed === 'object' ? parsed : {}
    store[token.value] = {
      order_id: result.order.id,
      order_token: result.order.order_token,
      status_url: statusUrl,
      guest_name: result.order.guest_name,
      cycle_name: cycle.value?.name || '',
      total: result.order.total,
      saved_at: new Date().toISOString()
    }
    localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(store))
  } catch (e) {
    // Private mode / full storage: the URL is still on screen, so this is
    // convenience only and must never break the confirmation.
  }
}

// Which button most recently copied: 'reference' | 'status-url' | ''. A single
// ref rather than passing a ref in from the template — template refs are
// unwrapped, so a `flag.value = true` on the argument would throw on a plain
// boolean and the "Skopírované" label would never appear.
const copiedTarget = ref('')

async function copyText(text, target) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch (e) {
    // Fallback for browsers without the async clipboard API (mirrors
    // GuestShareDialog.copyLink) — a guest on an old mobile browser still needs
    // the status URL.
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
  copiedTarget.value = target
  setTimeout(() => {
    if (copiedTarget.value === target) copiedTarget.value = ''
  }, 2000)
}
</script>

<template>
  <div :class="['min-h-screen transition-colors', backgroundClass]">
    <div v-if="loading" class="max-w-4xl mx-auto px-4 py-16 text-center text-muted-foreground">
      Načítavam…
    </div>

    <!-- Dead link: deactivated, unknown, or a cycle that is no longer open -->
    <div v-else-if="unavailable" class="max-w-md mx-auto px-4 py-16">
      <Card data-testid="guest-unavailable">
        <CardContent class="p-6 text-center space-y-3">
          <div class="text-4xl">🔒</div>
          <h1 class="text-xl font-semibold">{{ unavailableTitle }}</h1>
          <p class="text-sm text-muted-foreground">{{ unavailable.message }}</p>
          <p class="text-sm text-muted-foreground">
            Ak ste odkaz dostali od kolegu, požiadajte ho o nový.
          </p>
        </CardContent>
      </Card>
    </div>

    <!-- Confirmation (§UC-GSO-003) -->
    <div v-else-if="confirmation" class="max-w-md mx-auto px-4 py-8">
      <Card data-testid="guest-confirmation">
        <CardContent class="p-6 space-y-4">
          <div class="text-center space-y-1">
            <div class="text-4xl">✅</div>
            <h1 class="text-xl font-semibold">Objednávka je odoslaná</h1>
            <p class="text-sm text-muted-foreground">
              {{ cycle?.name }} · organizuje {{ host?.first_name }}
            </p>
          </div>

          <div class="rounded-lg border p-3 space-y-1 text-sm">
            <div class="flex justify-between">
              <span class="text-muted-foreground">Suma na úhradu</span>
              <span class="font-semibold">{{ formatPrice(confirmation.payment.amount) }}</span>
            </div>
            <div v-for="item in confirmation.items" :key="item.id" class="flex justify-between text-xs text-muted-foreground">
              <span>{{ item.product_name }} ({{ variantText(item) }}) x{{ item.quantity }}</span>
              <span>{{ formatPrice(item.price * item.quantity) }}</span>
            </div>
          </div>

          <!-- Payment reference. Revolut cannot pre-fill a note, so the guest has
               to paste it there themselves. -->
          <div class="space-y-1">
            <Label class="text-xs text-muted-foreground">Poznámka k platbe (uveďte ju pri platbe)</Label>
            <div class="flex gap-2">
              <div
                data-testid="payment-reference"
                class="flex-1 rounded-md border bg-muted/40 px-3 py-2 text-sm font-mono break-all"
              >{{ confirmation.payment.reference }}</div>
              <Button variant="outline" size="sm" data-testid="copy-reference" @click="copyText(confirmation.payment.reference, 'reference')">
                {{ copiedTarget === 'reference' ? 'Skopírované' : 'Kopírovať' }}
              </Button>
            </div>
          </div>

          <Button
            v-if="confirmation.payment.iban || confirmation.payment.revolut_username"
            class="w-full"
            @click="showPaymentModal = true"
          >
            Zaplatiť
          </Button>

          <!-- Personal status URL (page served by GSO-T4) -->
          <div class="space-y-1">
            <Label class="text-xs text-muted-foreground">Odkaz na vašu objednávku — uložte si ho</Label>
            <div class="flex gap-2">
              <Input :model-value="confirmation.status_url" readonly data-testid="guest-status-url" class="text-xs" />
              <Button variant="outline" size="sm" data-testid="copy-status-url" @click="copyText(confirmation.status_url, 'status-url')">
                {{ copiedTarget === 'status-url' ? 'Skopírované' : 'Kopírovať' }}
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">
              Na tomto odkaze uvidíte stav objednávky. Odkaz je uložený aj v tomto prehliadači.
            </p>
          </div>

          <p class="text-xs text-muted-foreground text-center">
            Tovar vám odovzdá {{ host?.first_name }}.
          </p>
        </CardContent>
      </Card>
    </div>

    <!-- Ordering (§UC-GSO-001/002) -->
    <div v-else class="max-w-4xl mx-auto px-4 py-4">
      <Card class="mb-4">
        <CardContent class="p-4">
          <h1 class="text-lg font-semibold">{{ cycle?.name }}</h1>
          <p class="text-sm text-muted-foreground">
            Spoločná objednávka · organizuje {{ host?.first_name }}
          </p>
          <p v-if="cycle?.expected_date" class="text-xs text-primary mt-1">
            📅 Objednávka do: <span class="font-medium">{{ cycle.expected_date }}</span>
          </p>
          <p v-if="cycle?.plan_note" class="text-xs text-muted-foreground mt-1">{{ cycle.plan_note }}</p>
          <p class="text-xs text-muted-foreground mt-2">
            Účet netreba. Vyberte si tovar, na konci zadajte meno a telefón.
          </p>
        </CardContent>
      </Card>

      <GuestProductGrid
        v-model="cart"
        v-model:active-tab="activeTab"
        :products="products"
        :availability="availability"
        :is-bakery="isBakery"
      />


      <!-- Sticky cart footer -->
      <div class="fixed bottom-0 left-0 right-0 bg-card shadow-lg border-t z-50">
        <div class="max-w-4xl mx-auto px-4 py-2">
          <div class="flex justify-between items-center gap-2 mb-1.5">
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-muted-foreground">Položiek: {{ cartItems.length }}</span>
              <span class="mx-1 text-xs">|</span>
              <span class="font-semibold text-sm" data-testid="cart-total">Celkom: {{ formatPrice(cartTotal) }}</span>
            </div>
            <Button size="sm" class="h-8 text-xs" data-testid="open-checkout" :disabled="cartItems.length === 0" @click="openCheckout">
              Objednať
            </Button>
          </div>

          <details v-if="cartItems.length > 0" class="mt-1">
            <summary class="text-sm text-muted-foreground cursor-pointer">Zobraziť položky v košíku</summary>
            <div class="mt-2 text-sm max-h-48 overflow-y-auto">
              <div v-for="item in cartItems" :key="item.key" class="flex justify-between py-1 border-b border-border">
                <span>{{ item.product_name }} ({{ variantText(item) }}) x{{ item.quantity }}</span>
                <span>{{ formatPrice(item.total) }}</span>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div class="h-32"></div>
    </div>

    <!-- Checkout: name + mobile required, email optional -->
    <Dialog :open="showCheckout" @update:open="val => showCheckout = val">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Dokončiť objednávku</DialogTitle>
          <DialogDescription>
            Suma na úhradu: <strong>{{ formatPrice(cartTotal) }}</strong>. Platba prevodom, tovar vám odovzdá {{ host?.first_name }}.
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-3">
          <div class="space-y-1">
            <Label for="guest-name">Meno *</Label>
            <Input id="guest-name" v-model="guestName" data-testid="guest-name" placeholder="Meno a priezvisko" maxlength="120" />
          </div>
          <div class="space-y-1">
            <Label for="guest-phone">Mobil *</Label>
            <Input id="guest-phone" v-model="guestPhone" data-testid="guest-phone" placeholder="0901 234 567" inputmode="tel" maxlength="32" />
          </div>
          <div class="space-y-1">
            <Label for="guest-email">E-mail (nepovinné)</Label>
            <Input id="guest-email" v-model="guestEmail" data-testid="guest-email" placeholder="meno@example.com" inputmode="email" maxlength="160" />
          </div>

          <Alert v-if="checkoutError" variant="destructive">
            <AlertDescription data-testid="checkout-error">{{ checkoutError }}</AlertDescription>
          </Alert>
        </div>

        <DialogFooter class="flex gap-2">
          <Button variant="outline" class="flex-1" @click="showCheckout = false">Späť</Button>
          <Button class="flex-1" data-testid="guest-submit" :disabled="submitting" @click="submitOrder">
            {{ submitting ? 'Odosielam…' : 'Odoslať objednávku' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Same payment modal friends use: Revolut link + Pay by Square QR -->
    <PaymentModal
      v-if="confirmation"
      :open="showPaymentModal"
      :amount="confirmation.payment.amount"
      :reference="confirmation.payment.reference"
      :iban="confirmation.payment.iban"
      :revolut-username="confirmation.payment.revolut_username"
      @close="showPaymentModal = false"
    />
  </div>
</template>
