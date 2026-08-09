<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import GuestBrandHeader from '@/components/GuestBrandHeader.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoModal from '@/components/neo/NeoModal.vue'
import NeoCopyRow from '@/components/neo/NeoCopyRow.vue'
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
// The confirmation (g-confirm) was restyled by RD-GX-2 and no longer holds a
// payment-reference row: the reference moved into the Platba modal (§UC-GX-005,
// resolved conflict #4). The dead-link card (g-dead) is RD-GX-4's — every screen
// on this route is now on the neo shell.

const route = useRoute()
const router = useRouter()
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

// ================= g-dead (§UC-GX-010) =================
// The TITLES are the shipped ones, unchanged. What §UC-GX-010 adds is a matching
// prototype DESCRIPTION per variant, replacing the raw server `e.message` the
// shipped card printed under every title — "Odkaz už nie je aktívny." under
// "Odkaz už nie je aktívny" was the server's own sentence repeated as its own
// explanation.
//
// ⚠ The three variants are safe to discriminate HERE and nowhere else. The server
// names the reason explicitly on this route (404 unknown / 410 `inactive` / 410
// `closed`, GSO-T3), so the page is reading a fact, not guessing. GSO-T10's "the
// page cannot distinguish a lock from a dead link" is about the STATUS page, whose
// payload only clears `editable` — and that page correspondingly never routes to a
// dead card, it shows the read-only banner (§UC-GX-006).
//
// The `anything else` row (network, 5xx) keeps BOTH shipped strings: the fallback
// title and the server's message as the description. There is no prototype copy
// for a failure the prototype has no concept of, and inventing one would claim
// knowledge the page does not have.
const unavailableTitle = computed(() => {
  if (!unavailable.value) return ''
  if (unavailable.value.status === 404) return 'Odkaz neexistuje'
  if (unavailable.value.reason === 'inactive') return 'Odkaz už nie je aktívny'
  if (unavailable.value.reason === 'closed') return 'Objednávanie je uzavreté'
  return 'Objednávka nie je dostupná'
})

const unavailableText = computed(() => {
  if (!unavailable.value) return ''
  if (unavailable.value.status === 404) return 'Tento odkaz sme nenašli. Skontrolujte, či je skopírovaný celý.'
  if (unavailable.value.reason === 'inactive') return 'Kolega, ktorý objednávku organizuje, tento odkaz deaktivoval.'
  if (unavailable.value.reason === 'closed') return 'Cyklus sa medzičasom uzamkol — objednávky už neprijímame.'
  return unavailable.value.message
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

// §UC-GX-004 item 6 — a NEW affordance from the prototype: pure navigation to the
// personal status page, no API call. `status_path` comes straight off the submit
// response (`/g/:token/o/:orderToken`), so this never composes a URL itself.
//
// The two copy controls this screen used to own are gone: `NeoCopyRow`
// (02 §UC-DS-011) owns the clipboard write, its own 2 s "Skopírované!" window and
// the missing-clipboard fallback, per instance. The old shared `copiedTarget` ref
// was a single page-level flag for two buttons — the exact shape `NeoCopyRow`
// replaces with per-instance state.
function goToStatus() {
  if (confirmation.value?.status_path) router.push(confirmation.value.status_path)
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
    <!-- ======================= g-dead (§UC-GX-010) =======================
         Dead link: unknown, deactivated (link or host), or a cycle that is no
         longer open. Three copy variants off the SERVER's own reason code, plus
         the shipped fallback — see the `unavailableText` note in the script.

         The card FLOATS: the zone takes `flex-1` and centres on both axes, so on
         a tall viewport the card sits in the middle of the halftone background
         rather than under the header (`16-shot.png`). That is the whole layout —
         there is no page column here, because there is no page.

         The header is the same `GuestBrandHeader` every guest screen carries, with
         this route's own subtitle. It was ABSENT from the shipped dead card, which
         meant a guest who mistyped a link got an unbranded box on a white page and
         no way to tell what they had reached. -->
    <template v-if="unavailable">
      <GuestBrandHeader subtitle="Objednávka cez odkaz" />

      <div class="flex-1 flex items-center justify-center p-5 sm:p-10">
        <div
          class="card p-[22px] sm:p-[30px]"
          style="max-width:400px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center"
          data-testid="guest-unavailable"
        >
          <!-- ⚠ `inline-flex` ON THE BADGE, AND IT IS NOT COSMETIC — the prototype's
               `{I.lock()} Slepá ulička` inside a plain `display:inline-block` badge
               DOES NOT PORT. Tailwind preflight declares `svg{display:block}`, so the
               transcribed markup put the padlock on a line of its own and pushed the
               label underneath it. Measured on this build, prototype vs. the literal
               port: badge 148.93 × 41.14 against 128.85 × 52.41 (11.3px taller,
               20px narrower), glyph centre +0.22 from the badge centre against
               −6.13. `16-shot.png` shows one line, so the port is the deviation.
               `inline-flex; align-items:center; gap:4px` restores it, landing at
               149.31 × 38.15 with the glyph +1.73 off centre. The 4px is not a round
               number by accident: it replaces the prototype's literal space
               character, whose advance in Figtree 13px measures 3.62px (and which a
               flex container would strip from the anonymous text item anyway) — 6px
               was tried first and overshot the width by 2.4px. The residual −3px of
               height is the baseline-aligned line box the prototype gets for free
               from an inline svg; it is tighter, not wrong, and is left. Scoped to
               this badge — `.badge` is module 02's rule and every text-only badge on
               this shell keeps `inline-block`. -->
          <span class="badge danger" style="font-size:13px;padding:6px 14px;transform:rotate(-2deg);display:inline-flex;align-items:center;gap:4px"><NeoIcon name="lock" /><span>Slepá ulička</span></span>
          <h1 class="h-screen text-[32px] sm:text-[38px]">{{ unavailableTitle }}</h1>
          <div class="sub" style="font-size:14px">{{ unavailableText }}</div>
          <div class="sub" style="font-size:13.5px">Ak ste odkaz dostali od kolegu, požiadajte ho o nový.</div>
        </div>
      </div>
    </template>

    <!-- ======================= g-confirm (§UC-GX-004) =======================
         The post-submit confirmation. NARROWER than g-order on purpose: 520px,
         not 760 — there is no product grid here, and the prototype `GConfirm`
         sets its own column.

         REMOVED from the shipped screen (resolved conflict #4 + prototype): the
         on-card payment-reference block — the reference now lives ONLY in the
         Platba modal (§UC-GX-005) — the "✅" emoji header, and the "Tovar vám
         odovzdá {host}." footer line, which the checkout subtitle already said. -->
    <template v-else-if="confirmation">
      <GuestBrandHeader subtitle="Objednávka odoslaná" />

      <div
        class="mx-auto w-full max-w-[520px] px-4 sm:px-7 py-4 sm:py-7 flex flex-col gap-4"
        data-testid="guest-confirmation"
      >
        <!-- `line-height:normal` on this unclassed wrapper. An unclassed block
             inherits preflight's `1.5` with nothing to override it, and A9/A10 are
             CLASS lists that cannot reach an element carrying no class — so the fix
             belongs at the call site, never as a widening of A10 (friends-theme.css,
             A10 block). MEASURED HERE AS A ZERO DELTA (133.59 px either way): the
             `.badge`'s own box is taller than the strut and `.h-screen`/`.sub`
             declare their own line-height, so nothing moves today. Kept on the same
             basis RD-FL-8b kept the remember-me label — the pattern must be safe to
             copy, and the next line added to this block would not be. -->
        <div style="text-align:center;margin-top:6px;line-height:normal">
          <span class="badge ok-solid" style="font-size:13px;padding:6px 14px;transform:rotate(-2deg)">✔ Odoslané</span>
          <!-- `.hl` = the magenta highlight with the 4px ink underline shadow.
               ⚠ ONE LINE: a newline before `<span>` is a whitespace node Vue's
               `condense` mode DELETES, silently gluing "je" to "odoslaná". -->
          <h1 class="h-screen text-[34px] sm:text-[40px]" style="margin-top:12px">Objednávka je <span class="hl">odoslaná</span></h1>
          <div class="sub" style="margin-top:10px">{{ cycle?.name }} · organizuje {{ host?.first_name }}</div>
        </div>

        <!-- Sum card. `.field-lbl` carries its own 8px bottom margin, which the
             prototype zeroes here because the row is a flex baseline pair. -->
        <div class="card" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
            <span class="field-lbl" style="margin:0">Suma na úhradu</span>
            <span class="display" style="font-size:24px">{{ fmtEur(confirmation.payment.amount) }}</span>
          </div>
          <hr class="divider" style="margin:12px 0" />
          <!-- Item lines are BARE `toFixed(2)` — no " EUR" (prototype): the card's
               own heading already states the unit, and the lines are a breakdown,
               not a set of prices. `×` is U+00D7 MULTIPLICATION SIGN, not "x".
               ⚠ `line-height:normal` here is LOAD-BEARING, unlike the header
               wrapper's: the left `<span>` carries no class, so preflight's 1.5
               reaches it and its `.mono` sibling (covered by A10) does not match.
               MEASURED on this build: 16 px per line at `normal`, 20.25 px at 1.5 —
               +4.25 px on every item, which is exactly the class of drift the A10
               block exists to undo. -->
          <div style="display:flex;flex-direction:column;gap:5px;font-size:13.5px;color:var(--ink-dim);line-height:normal">
            <div
              v-for="item in confirmation.items"
              :key="item.id"
              style="display:flex;justify-content:space-between;gap:10px"
            >
              <span>{{ item.product_name }} ({{ variantText(item) }}) ×{{ item.quantity }}</span>
              <span class="mono">{{ (item.price * item.quantity).toFixed(2) }}</span>
            </div>
          </div>
        </div>

        <!-- Shipped gate kept (§UC-GX-004 item 3): with neither IBAN nor Revolut
             there is nothing for the modal to open onto — the reference alone is a
             transfer note with nowhere to send it. -->
        <button
          v-if="confirmation.payment.iban || confirmation.payment.revolut_username"
          type="button"
          class="btn ok block"
          @click="showPaymentModal = true"
        >Zaplatiť</button>

        <!-- Personal status URL (page served by GSO-T4). `NeoCopyRow` owns the
             clipboard write and the 2 s "Skopírované!" flip; the testid falls
             through to its `.copyrow` root, so the value is read as text and the
             button as `getByTestId('guest-status-url').getByRole('button')`
             (§UC-GX-011 items 3/4). The helper line is prototype-silent and
             RETAINED — it is the only place the localStorage behaviour is
             explained. -->
        <div>
          <label class="field-lbl">Odkaz na vašu objednávku — uložte si ho</label>
          <NeoCopyRow :value="confirmation.status_url" data-testid="guest-status-url" />
          <p class="field-help">Na tomto odkaze uvidíte stav objednávky. Odkaz je uložený aj v tomto prehliadači.</p>
        </div>

        <!-- Lead capture (§UC-GSO-015 / §UC-GX-009 — restyle is RD-GX-4's). Kept
             late on the screen, on purpose: the payment information above it is
             why the guest is here. -->
        <GuestInviteRequest
          :token="token"
          :order-token="confirmation.order.order_token"
          :name="confirmation.order.guest_name || ''"
          :phone="confirmation.order.guest_phone || ''"
          :email="confirmation.order.guest_email || ''"
        />

        <button type="button" class="btn ghost sm" style="align-self:center" @click="goToStatus">
          Zobraziť stav objednávky
          <NeoIcon name="chev" />
        </button>
      </div>
    </template>

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

    <!-- Same payment modal friends use (§UC-GX-005): Revolut link, the real
         Pay-by-Square QR, and — since RD-GX-2 — the payment-reference copy row,
         which is now the ONLY place the reference is shown. It mounts its own
         `NeoModal` under `v-if="open"`, so nothing of it is in the DOM while
         `showPaymentModal` is false. -->
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
     spare.

     ⚠ CORRECTED BY RD-GX-4 — "invisible at every width" WAS WRONG, and the
     parenthetical "verified: resolved widths and the rendered footer are unchanged
     at 378px" that used to stand here was wrong with it. `.m-foot .btn` is `flex:1`
     (grow 1, basis 0) with the flexbox default `min-width:auto`, so each button's
     MIN-CONTENT is its floor — and the relief is only invisible while the even
     split clears BOTH floors. "Odoslať objednávku" needs 171.05 at the canon 16px,
     which is above the even split at every width the query covers, so it is pinned
     at its own min-content and "Späť" takes what is left. Re-measured on this build
     (relief vs. the canon 16px, same page, same face):

       399px   151.95 / 159.05     against   139.95 / 171.05
       378px   130.95 / 159.05     against   118.95 / 171.05
       360px   112.95 / 159.05     against   100.95 / 171.05
       320px    65.11 / 166.89     against    71.52 / 178.89  (which OVERFLOWS)
                ⚠ this row alone was captured on the FALLBACK face, before Figtree
                loaded — its floors are 59.52/166.89 (relief) and 71.52/178.89
                (canon), so the canon sum is 258.41, not the 248.18 quoted above
                for Figtree. Both faces overflow 240 and both are cleared by the
                relief (fallback 234.41, 5.59px spare; Figtree 224.18, 15.8px), so
                the conclusion is face-independent — but do not read 248.18 and
                this row as the same measurement.
       >400px  identical — the query does not apply

     So the relief moves 12px from the accent button to "Späť" on every phone
     viewport. It is a visible change and a small one — unlike the cancel confirm on
     GuestOrderStatus.vue, where the same relief tips the row past the even split
     and the footer becomes symmetric — but it is a change, and it is recorded
     rather than repeated. The claim stands only in the two senses that matter: the
     relief never makes the footer WORSE, and it is what stops the overflow.

     400px rather than 328px, and 10px rather than a tighter value, for the reasons
     RD-FO-4 recorded on `.fo-foot-btn` — it costs nothing above the threshold,
     stays below the 420px cap where `.modal` stops being viewport-bound, and leaves
     room for a wider face than the one measured. Scoped to this view's own footer
     buttons: `.m-foot .btn` is module 02's rule and every other dialog on this
     shell keeps its canon padding. (Vue's scope attribute lands on slot content
     authored here even though `NeoModal` teleports it to `body`.) -->
<style scoped>
@media (max-width: 400px) {
  .gx-foot-btn {
    padding-left: 10px;
    padding-right: 10px;
  }
}
</style>
