<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import GuestBrandHeader from '@/components/GuestBrandHeader.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoModal from '@/components/neo/NeoModal.vue'
import PaymentModal from '@/components/PaymentModal.vue'
import GuestProductGrid from '@/components/GuestProductGrid.vue'
import GuestInviteRequest from '@/components/GuestInviteRequest.vue'
import { fmtEur } from '@/lib/money'
import {
  availabilityMap,
  cartLines,
  itemsPayload,
  linesTotal,
  variantText
} from '@/lib/guest-cart'

// Public guest ordering page — route `/g/:token` (§UC-GSO-001..003, restyled by
// 06 §UC-GX-001/002/003).
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
//
// ⚠ THE SUBMIT IS UNTOUCHED BY THE RESTYLE. `api.js guestRequest()` sends NO auth
// headers on any guest call — the URL token IS the credential (GSO-T3) — and the
// payload below is byte-identical to the shipped one: trimmed name/phone, email
// only when non-empty, `itemsPayload(cartItems)`. The GSO-T3 input bounds are
// mirrored as `maxlength` on the three inputs and must stay.
//
// ⚠ TWO SCREENS ON THIS ROUTE ARE STILL OLD-SKIN, deliberately: the confirmation
// (RD-GX-2, 06 §UC-GX-004 — its payment-reference row and status-URL input are
// pinned verbatim by `guest-order.spec.js:875–893`, which only RD-GX-2 may
// re-point) and the dead-link card (RD-GX-4, §UC-GX-010). They now sit inside the
// `.app` root, so they inherit the cream background and the halftone — an accepted
// interim, exactly the half-migrated `.app` 02 §UC-DS-002 provides for.

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
  <!-- ⚠ `.app` brings `.app > * { position:relative; z-index:1 }` with it, which
       NEUTRALISES every Tailwind positioning utility on a DIRECT child — `fixed`,
       `absolute`, `sticky` alike, silently. That is precisely why the cart footer
       below is on the THEME class `.cartbar` and not on utilities:
       `:where(.app,.modal-layer) .cartbar` (friends-theme.css:158) has the same
       (0,1,0) specificity but is declared LATER, so its
       `position:sticky; bottom:0; z-index:50` wins the cascade. The shipped
       `fixed bottom-0 z-50` footer plus its `<div class="h-32">` spacer are both
       GONE (§UC-GX-003): with `sticky` the spacer would be 128px of dead space at
       the end of every page, and `fixed` would not survive `.app>*` at all.

       `flex flex-col` + the theme's `min-height:100vh` is the prototype's `GOrder`
       root layout, and it is what lets the page column take `flex-1` so the bar
       sits at the viewport bottom on a short page.

       The per-tab background tinting (`backgroundClass`: bg-sky-100 / bg-stone-200
       / bg-amber-100 / …) is REMOVED — §UC-GX-001 item 1: the prototype background
       is a uniform `--bg` everywhere. -->
  <div class="app flex flex-col">
    <!-- Dead link: deactivated, unknown, or a cycle that is no longer open.
         ⚠ OLD SKIN ON PURPOSE — restyled by RD-GX-4 (§UC-GX-010, three copy
         variants + the badge/centered-card composition). Untouched here beyond
         inheriting the `.app` background. -->
    <div v-if="unavailable" class="max-w-md mx-auto px-4 py-16">
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

    <!-- Confirmation (§UC-GSO-003).
         ⚠ OLD SKIN ON PURPOSE — restyled by RD-GX-2 (§UC-GX-004). Its payment
         reference, its `<input>`-based status URL and its two "Kopírovať" buttons
         are pinned VERBATIM by `guest-order.spec.js:875–893`, and those three
         re-points are RD-GX-2's sanctioned e2e edits (§UC-GX-011 items 2–4). This
         row spends zero of them, so this block must not move. -->
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
              <span class="font-semibold">{{ fmtEur(confirmation.payment.amount) }}</span>
            </div>
            <div v-for="item in confirmation.items" :key="item.id" class="flex justify-between text-xs text-muted-foreground">
              <span>{{ item.product_name }} ({{ variantText(item) }}) x{{ item.quantity }}</span>
              <span>{{ fmtEur(item.price * item.quantity) }}</span>
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

          <!-- Lead capture (§UC-GSO-015). LAST on the screen, on purpose: the payment
               information above it is why the guest is here. -->
          <GuestInviteRequest
            :token="token"
            :order-token="confirmation.order.order_token"
            :name="confirmation.order.guest_name || ''"
            :phone="confirmation.order.guest_phone || ''"
            :email="confirmation.order.guest_email || ''"
          />
        </CardContent>
      </Card>
    </div>

    <!-- ======================= g-order (§UC-GX-001..003) ======================= -->
    <template v-else>
      <!-- Guest chrome: wordmark + "Bez účtu" chip + hazard tape + ticker,
           full-bleed and NOT sticky — it scrolls away and `.cat-tabs` (inside the
           grid) owns the top edge alone (02 §UC-DS-005: at most one sticky bar per
           edge, and `.cartbar` already owns the bottom).

           Rendered ABOVE the loading state as well, so the chrome never flashes in
           and out between "Načítavam…" and the loaded page (§UC-GX-001). -->
      <GuestBrandHeader subtitle="Objednávka cez odkaz" />

      <div v-if="loading" class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7 flex-1">
        <div class="sub" style="text-align:center;padding:32px 0">Načítavam…</div>
      </div>

      <template v-else>
        <!-- The page column is the settled geometry (02 §UC-DS-005): 760px max,
             centred, 16px phone / 28px desktop, written as axis utilities. `pb-2`
             is repeated at both breakpoints so the `sm` layer cannot re-raise it;
             that 8px bottom is the prototype's `paddingBottom: 8`. `flex-1` is
             what pins the cartbar to the viewport bottom on a short page. -->
        <div class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7 pb-2 sm:pb-2 flex flex-col gap-[14px] flex-1">
          <!-- Hero (§UC-GX-001 item 4). `.card.hl` = white, 3px ink border and a
               6px MAGENTA offset shadow (the plain `.card` shadow is ink) — the one
               card on the guest surface that carries the accent shadow. -->
          <div class="card hl p-4 sm:p-5">
            <h1 class="h-screen text-[30px] sm:text-[38px]">{{ cycle?.name }}</h1>
            <div class="sub" style="margin-top:8px;font-size:14px">Spoločná objednávka · organizuje <b style="color:var(--ink)">{{ host?.first_name }}</b></div>
            <!-- Deadline line: VERBATIM from the API, no reformatting and no 📅 —
                 the design language has no emoji, the calendar is `NeoIcon`. The
                 icon and the text are flex children with a 6px gap, so the newline
                 between them is a whitespace-only node Vue's `condense` mode
                 deletes; the gap, not a space, is what separates them. -->
            <div
              v-if="cycle?.expected_date"
              class="mono"
              style="font-size:12.5px;margin-top:6px;display:flex;align-items:center;gap:6px;color:var(--ink-dim)"
            >
              <NeoIcon name="cal" />
              <span>Objednávka do: {{ cycle.expected_date }}</span>
            </div>
            <div class="flex flex-wrap gap-[6px] mt-3">
              <span class="badge acc">Login netreba</span>
              <span class="badge">Platba prevodom</span>
              <span class="badge acc-o">Tovar odovzdá {{ host?.first_name }}</span>
            </div>
            <!-- Prototype copy, replacing the shipped "Účet netreba. Vyberte si
                 tovar, na konci zadajte meno a telefón." — "Účet netreba" now lives
                 in the appbar chip, so repeating it here would be twice. -->
            <div class="sub" style="margin-top:10px;font-size:13px">Vyberte si tovar, na konci zadáte len meno a telefón.</div>
            <!-- Admin-entered copy: the prototype is silent on it, but dropping it
                 would be a behaviour regression, so it is retained as one more
                 `.sub` line (§UC-GX-001 item 4, last bullet). -->
            <div v-if="cycle?.plan_note" class="sub" style="margin-top:6px;font-size:13px">{{ cycle.plan_note }}</div>
          </div>

          <GuestProductGrid
            v-model="cart"
            v-model:active-tab="activeTab"
            :products="products"
            :availability="availability"
            :is-bakery="isBakery"
          />
        </div>

        <!-- ============================ .cartbar (§UC-GX-003) ============================
             A DIRECT CHILD OF `.app`, after the page column — see the note on the
             root. One accent action only (Objednať), disabled on an empty cart.
             `<details>` renders only when the cart has lines (shipped rule). -->
        <div class="cartbar" data-testid="cartbar">
          <div class="meta">
            <span v-if="cycle?.expected_date" class="deadline">Objednávka do: {{ cycle.expected_date }}</span>
            <span class="sub" style="font-size:13px">Položiek: {{ cartItems.length }}</span>
          </div>
          <div class="meta" style="margin-top:2px;align-items:center">
            <span class="sum" data-testid="cart-total">Celkom: {{ fmtEur(cartTotal) }}</span>
            <button
              type="button"
              class="btn accent sm"
              data-testid="open-checkout"
              :disabled="cartItems.length === 0"
              @click="openCheckout"
            >Objednať</button>
          </div>

          <!-- ⚠ `line-height:normal` ON THE `<details>` ITSELF. `.cartbar details
               summary` is `display:inline-flex`, so the `<details>` block
               establishes a line box whose STRUT comes from its own inherited
               line-height; preflight's 1.5 makes the whole bar 3px taller than the
               canon. A9/A10 are CLASS lists and this element carries no class, so
               no addition to them can reach it — RD-FO-3 measured and fixed the
               identical site on the friend cartbar. -->
          <details v-if="cartItems.length > 0" style="line-height:normal">
            <summary>Zobraziť položky v košíku</summary>
            <div class="lines">
              <!-- `×` is U+00D7 MULTIPLICATION SIGN, not the letter "x". -->
              <div v-for="item in cartItems" :key="item.key" class="ln">
                <span>{{ item.product_name }} ({{ variantText(item) }}) ×{{ item.quantity }}</span>
                <span class="mono">{{ fmtEur(item.total) }}</span>
              </div>
            </div>
          </details>
        </div>
      </template>
    </template>

    <!-- ===================== Checkout modal (§UC-GX-003) =====================
         ⚠ MOUNTED WITH `v-if`, and that is load-bearing, not a style choice.
         `NeoModal` has no `open` prop — the parent owns mounting, exactly as the
         prototype's modal enum does — and three shipped, NON-EDITABLE guest specs
         locate controls with UNSCOPED role+name queries
         (`guest-order.spec.js:865`, `guest-status.spec.js:664`,
         `guest-lead-capture.spec.js:466` all click an unscoped "Zavrieť"). An
         always-mounted dialog would keep its own footer buttons in the DOM behind
         the payment modal AND leave `.modal-scrim` (pointer-events:auto over the
         whole viewport) swallowing the click.

         `role="dialog"` comes from the primitive, which is what the specs'
         `getByRole('dialog')` needs, and the × is deliberately named "Zatvoriť
         dialóg" — a SYNONYM, because Playwright matches accessible names as a
         case-insensitive SUBSTRING and "Zavrieť dialóg" would collide with the
         spec-verbatim "Zavrieť" footer buttons. Nothing in this footer may be
         named as a substring of another control in the same dialog either.

         The three inputs keep the GSO-T3 bounds as `maxlength` (120 / 32 / 160) —
         the server re-validates, but a silently truncated 200 000-char name is what
         the mirror prevents. -->
    <NeoModal
      v-if="showCheckout"
      title="Dokončiť objednávku"
      @close="showCheckout = false"
    >
      <template #subtitle>Suma na úhradu: <b class="mono" style="color:var(--ink)">{{ fmtEur(cartTotal) }}</b>. Platba prevodom, tovar vám odovzdá {{ host?.first_name }}.</template>

      <!-- `.m-body` is itself a 12px-gap flex column, so each field is a bare
           wrapper with a native `label.field-lbl` (no `ui/label`) — the same
           `Field` port module 03's profile modal established. -->
      <div>
        <label class="field-lbl" for="guest-name">Meno *</label>
        <input
          id="guest-name"
          v-model="guestName"
          class="inp"
          type="text"
          data-testid="guest-name"
          placeholder="Meno a priezvisko"
          maxlength="120"
        />
      </div>
      <div>
        <label class="field-lbl" for="guest-phone">Mobil *</label>
        <input
          id="guest-phone"
          v-model="guestPhone"
          class="inp"
          type="text"
          data-testid="guest-phone"
          placeholder="0901 234 567"
          inputmode="tel"
          maxlength="32"
        />
      </div>
      <div>
        <label class="field-lbl" for="guest-email">E-mail (nepovinné)</label>
        <input
          id="guest-email"
          v-model="guestEmail"
          class="inp"
          type="text"
          data-testid="guest-email"
          placeholder="meno@example.com"
          inputmode="email"
          maxlength="160"
        />
      </div>

      <!-- Client-side messages verbatim (§UC-GX-003); server errors keep the
           shipped join `[e.message, ...(e.details || [])].join(' ')`, which is what
           carries a 400's per-product stock detail lines. -->
      <div v-if="checkoutError" class="banner danger slim" role="alert">
        <span class="dot"></span><span data-testid="checkout-error">{{ checkoutError }}</span>
      </div>

      <template #footer>
        <button type="button" class="btn gx-foot-btn" @click="showCheckout = false">Späť</button>
        <button
          type="button"
          class="btn accent gx-foot-btn"
          data-testid="guest-submit"
          :disabled="submitting"
          @click="submitOrder"
        >{{ submitting ? 'Odosielam…' : 'Odoslať objednávku' }}</button>
      </template>
    </NeoModal>

    <!-- Same payment modal friends use: Revolut link + Pay by Square QR.
         ⚠ Its internals are RD-GX-2's (§UC-GX-005) — untouched here. -->
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

<!-- ⚠ THE 320px FOOTER, MEASURED — not assumed to wrap. `.btn` is
     `white-space:nowrap` and `.m-foot .btn` is `flex:1`, so a footer row that does
     not fit gives NO degradation signal at all: no shrink, no wrap, no ellipsis —
     the buttons paint outside the modal's 4px border and `.modal-scrim` (whose
     `overflow-y:auto` computes `overflow-x` to `auto`) grows a horizontal
     scrollbar. Same hazard RD-FO-4 measured one screen over.

     The arithmetic at viewport W: the scrim takes 18px a side, `.modal` 4px of
     border a side, `.m-foot` 18px of padding a side, and the two buttons are
     separated by an 8px gap — so the row has `W − 80` to spend. Measured on this
     build against the MIN-CONTENT need (a clone of `.m-foot` at `width:min-content`
     — NOT the flex-resolved width, which always sums to the container and therefore
     hides the overflow completely), at the canon `.btn` padding of 16px a side:

       Späť 69.13 + Odoslať objednávku 171.05 + 8 gap = 248.18   against 240 @320px

     It overflows by 8.18px, i.e. every viewport below ~328px. (`.btn` min-content
     is width-invariant, so the same 248.18 was measured at 320/335/340/360/378 —
     only `available` moves.)

     Fixed by spending horizontal PADDING, not copy: §UC-GX-003 pins both labels
     verbatim. 10px a side takes the row to 224.18, which clears 240 with 15.8px to
     spare. The buttons are `flex:1`, so they re-grow to fill the row either way —
     the padding is only ever their MINIMUM, which is why this is invisible at every
     width and only ever prevents the overflow (verified: resolved widths and the
     rendered footer are unchanged at 378px). 400px rather than 328px, and 10px
     rather than a tighter value, for the reasons RD-FO-4 recorded on `.fo-foot-btn`
     — it costs nothing above the threshold, stays below the 420px cap where
     `.modal` stops being viewport-bound, and leaves room for a wider face than the
     one measured. Scoped to this view's own footer buttons: `.m-foot .btn` is
     module 02's rule and every other dialog on this shell keeps its canon padding.
     (Vue's scope attribute lands on slot content authored here even though
     `NeoModal` teleports it to `body`.) -->
<style scoped>
@media (max-width: 400px) {
  .gx-foot-btn {
    padding-left: 10px;
    padding-right: 10px;
  }
}
</style>
