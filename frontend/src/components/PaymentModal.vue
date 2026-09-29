<script setup>
// The shared "Platba" modal (06 §UC-GX-005), restyled onto the neo shell.
//
// ⚠ SHARED-CONSUMER CONTRACT, PINNED. Four callers mount this component —
// `GuestOrder.vue` (the g-confirm screen), `GuestOrderStatus.vue` (the guest's
// status page), `FriendOrder.vue` (module 04's cart bar) and — from PL-T4 — the
// whole-balance debt (15 §UC-PL-007 item 4: its own amount, its own reference and
// its own `8`-prefixed symbol).
// ⚠ ~~That balance mount belongs to the CARD (`FriendBalanceCard.vue`), and module
// 18 (PI-T7) RELOCATES it~~ — **RELOCATED, exactly as that line promised (PI-T7,
// 18 §UC-PI-008/010).** Module 18 gives that one debt TWO surfaces on two different
// VIEWS — the „Zostatok a platby" card and the landing's debt banner — so the mount
// moved UP into `FriendPortalSession.vue`, which both reach through
// `openBalancePayment()`. There is still never more than one `PaymentModal` for the
// balance; what changed is which file holds it, and a mount inside the card is now
// the thing that would force a second. It emits `close` and nothing else. No admin
// view consumes it (swept from `router.js` by `payment-links.spec.js`).
//
// ~~Its props API is FROZEN: `open`, `amount`, `reference`, `iban`,
// `revolutUsername`.~~ **SUPERSEDED — 15 §UC-PL-004/D4 (PL-T3).** The API is
// ADDITIVE now, not frozen: `variableSymbol` and `creditorName` joined it, both
// optional Strings defaulting to `''`. Every original prop, the `close` emit, the
// `v-if` mount and the `'-'` amount guard are untouched, and a caller that passes
// neither new prop gets byte-identically what shipped (no VS row, no PayMe button,
// a `variableSymbol: ''` / `beneficiary "Gorifi"` payload). The same strike is in
// `06 §UC-GX-005` and in `15-payment-links.md`'s header — the claim was stated in
// three places and is rewritten in all three (CLAUDE.md §Documentation discipline).
// What has NOT changed is the reason the word "frozen" was there: a prop that
// REPLACES or reshapes an existing one still breaks three screens at once.
//
// ⚠ MODULE 04 INHERITS THIS RESTYLE WITH NO CHANGE ON ITS SIDE. `NeoModal`
// teleports to `<body>` and the theme tokens are declared on `.app, .modal-layer`
// (02 §UC-DS-010), so the modal is fully themed even when it is opened from a
// caller whose own root is not `.app` yet — which is exactly the state
// `GuestOrderStatus.vue` is in until RD-GX-3. Verified from the friend order
// screen as well as both guest screens.
//
// ⚠ THE `v-if` ON `<NeoModal>` IS LOAD-BEARING, not a style choice. `NeoModal`
// has no `open` prop — the parent owns mounting — and the frozen `open` prop is
// what translates the callers' boolean into that mount. Three shipped,
// NON-EDITABLE guest specs close this modal with an UNSCOPED
// `getByRole('button', { name: 'Zavrieť' })` (`guest-status.spec.js:664`,
// `guest-order.spec.js:865`, `guest-lead-capture.spec.js:466`), and
// `FriendOrder.vue` mounts this component permanently with `:open="false"`. An
// always-mounted `NeoModal` would therefore park a second "Zavrieť" and a
// full-viewport `.modal-scrim` (pointer-events:auto) in the DOM of every friend
// order page — the scrim swallowing every click on the page behind it.
//
// The × is named "Zatvoriť dialóg" by `NeoModal` — a deliberate SYNONYM, because
// Playwright matches accessible names as a case-insensitive SUBSTRING and
// "Zavrieť dialóg" would collide with the footer button those specs query
// unscoped. Nothing may be added to this dialog whose accessible name contains
// another control's.
//
// ⚠ THE QR IS MONEY A BANK APP SCANS. The `bysquare` + `qrcode` generation call
// below, the watch that triggers it and the two status strings ("Generujem QR
// kod...", "Nepodarilo sa vygenerovat QR kod.") are BEHAVIOUR. ~~The payload is
// carried over byte-identically from the shipped component — a restyle must not
// move a single character of it.~~ **AMENDED — 15 §UC-PL-004/D3 (PL-T3):** the
// payload is now composed by `lib/payment-links.js` (shared with the friend
// success modal, so the friend's first QR cannot lack the symbol the „Zaplatiť“
// one carries) and EXACTLY TWO fields moved: `variableSymbol` follows the
// server-owned VS and `beneficiary.name` follows the creditor name
// (`creditorName || 'Gorifi'`). With both props absent it is byte-identical to
// what shipped — which is what keeps `money-rounding.spec.js`'s hard-coded
// `'Gorifi'` valid. Everything else, including `qrcode`'s `width: 256`, is
// untouched and stays that way. Pinned by `guest-payment-modal.spec.js`, which
// reads the QR module matrix off the RENDERED PIXELS and compares it against an
// independent `bysquare.encode()` of the same inputs (and decodes that string
// back with `bysquare.decode()`), exactly as RD-FO-4 did for the friend success
// modal. `qrcode`'s `width: 256` is part of that contract even though `.qr`
// paints it at 164 px — do not "optimise" it to the rendered size.
//
// ⚠ THE REFERENCE IS SERVER-OWNED. `guestPaymentReference()` composes
// `G{id} / {meno} / {cyklus}` (GSO-T6: ONE formatter, so the admin's receivables
// view and the guest see the same string); the friend side passes its own
// `{meno} / {cyklus}`. This component only displays what it is given — it must
// never compose or reformat a reference.

import { computed, ref, watch } from 'vue'
import { encode, Version } from 'bysquare'
import QRCode from 'qrcode'
import { useMediaQuery } from '@vueuse/core'
import NeoModal from '@/components/neo/NeoModal.vue'
import NeoCopyRow from '@/components/neo/NeoCopyRow.vue'
import { fmtEur } from '@/lib/money'
import { payBySquarePayload, paymeLink, revolutLink } from '@/lib/payment-links'

const props = defineProps({
  open: Boolean,
  amount: Number,
  reference: String,
  iban: String,
  revolutUsername: String,
  // 15 §UC-PL-004/D4 — ADDITIVE, both optional. A caller that passes neither (module
  // 04's cart bar until PL-T4) renders exactly what shipped.
  variableSymbol: { type: String, default: '' },
  creditorName: { type: String, default: '' }
})

const emit = defineEmits(['close'])

const qrDataUrl = ref(null)
const qrError = ref(false)

// ⚠ R6.2 — THE PAYME BUTTON IS `v-if`, NOT A CSS `@media` HIDE, and that is a test
// contract as much as a design one: `guest-payment-modal.spec.js` maps `.m-body`'s
// children by tag and pins `['revolut','qr','reference']`, so an `<a>` present-but-hidden
// on desktop would count as a second Revolut bar and redden a shipped assertion for
// nothing. `useMediaQuery` is reactive, so a device that changes primary pointer
// (a tablet gaining a mouse) re-renders rather than stranding.
const coarsePointer = useMediaQuery('(pointer: coarse)')

// `''` unless the IBAN, the creditor name AND a positive amount are all present — the
// helper enforces §UC-PL-002 rule 1 ("no PayMe without a creditor name"), the template
// only asks whether there is a link.
const paymeHref = computed(() => paymeLink({
  iban: props.iban,
  amount: props.amount,
  variableSymbol: props.variableSymbol,
  reference: props.reference,
  creditorName: props.creditorName
}))

const showPayme = computed(() => !!paymeHref.value && coarsePointer.value)

const revolutHref = computed(() => revolutLink(props.revolutUsername, props.amount))

// The amount rides in the LABEL as well as the link, so what the tap will do is legible
// before the app opens. `EUR` after a total, per CLAUDE.md §Frontend; `€` is for item
// lines.
//
// ⚠ THE LABEL IS DERIVED FROM THE HREF, NOT FROM A SECOND PREDICATE OVER `amount`, so
// "the label and the link are one number" holds BY CONSTRUCTION rather than by the
// current callers' value ranges. The earlier `REVOLUT_AMOUNT_LINK && props.amount` test
// was truthiness, while the builder's is `Number.isFinite(amount) && amount > 0`: a
// negative or infinite amount would have shown a sum in the button over an href that
// carried none. Unreachable from today's three payloads — and this component gains the
// BALANCE caller in PL-T4 and the landing debt banner in module 18, which is exactly how
// a "can't happen" range assumption stops being true. Reading the href also makes the
// `REVOLUT_AMOUNT_LINK` fallback automatic: flag off ⇒ no `?amount=` ⇒ no suffix, with
// no second place to remember to flip.
const revolutAmountLabel = computed(() =>
  (revolutHref.value.includes('?amount=') ? `(${fmtEur(props.amount)})` : '')
)

// ⚠ The watch now also keys on the two new props: a surface that fills its payment block
// asynchronously (the guest status page loads it after the modal can already be open)
// would otherwise paint a VS-less QR and never redraw it.
watch(() => [props.open, props.iban, props.amount, props.variableSymbol, props.creditorName], async () => {
  if (props.open && props.iban) {
    await generateQr()
  }
}, { immediate: true })

async function generateQr() {
  qrError.value = false
  qrDataUrl.value = null
  try {
    // The payload has ONE home (`lib/payment-links.js`) shared with `FriendOrder.vue`'s
    // success modal; the two library calls stay here, because the error handling around
    // them is this component's UI. `roundMoney` lives inside the payload builder — the
    // callers' `amount` stays unrounded on purpose (see `money.js`).
    const qrString = encode(payBySquarePayload({
      amount: props.amount,
      iban: props.iban,
      variableSymbol: props.variableSymbol,
      reference: props.reference,
      creditorName: props.creditorName
    }), { version: Version['1.0.0'] })
    qrDataUrl.value = await QRCode.toDataURL(qrString, { errorCorrectionLevel: 'M', width: 256, margin: 2 })
  } catch (e) {
    console.error('QR generation failed:', e)
    qrError.value = true
  }
}

// The shipped `'-'` guard for a falsy amount is a hard invariant (§UC-GX-005):
// a modal that renders "NaN EUR" or "0.00 EUR" over a missing total would be
// worse than one that visibly says nothing is known.
function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

// Notes on the template below (kept here rather than as template comments, so the
// rendered DOM matches the prototype's in dev as well as prod):
//
// · SECTION ORDER IS FIXED — Revolut → PayMe → QR/IBAN → reference (prototype
//   `ui.jsx PaymentModal`, with PayMe inserted by 15 §UC-PL-006). `.m-body` is a
//   12px-gap flex column, so each section is one direct child and there is no
//   wrapper to space them. The VS copy row goes INSIDE the reference section
//   rather than beside it, so the section count stays what the prototype has.
// · The PayMe bar deliberately wears the DEFAULT `.btn` ink/paper colours: there
//   is no prototype screen for it and no PayMe brand asset is self-hosted —
//   pulling a remote logo would break the zero-external-requests CSP sweep
//   (`self-hosted-fonts.spec.js`). Its glyph is inline, like Revolut's.
// · The Revolut control is an `<a>`, not the prototype's inert `<button>`: it
//   navigates off-site, and `target="_blank" rel="noopener noreferrer"` plus the
//   real `href` are shipped behaviour that the re-skin keeps. It wears
//   `.btn.block` and the prototype's three inline colours (the border stays ink).
// · The `.qr .grid` pseudo-QR from `ui.jsx QRBox` is PROTOTYPE-ONLY and is never
//   rendered here (02 §UC-DS-012) — `.qr` is the 190×190 ink frame and the real
//   generated `<img>` fills its 164 px content box.
// · Callers gate the trigger that opens this modal on `iban || revolutUsername`,
//   so it never opens payment-empty; the `v-if`s are the belt to that brace. Each
//   control is gated on ITS OWN composed value (`revolutHref`, `paymeHref`), never
//   on the raw prop it was built from — a gate and a link that answer different
//   questions is how an empty `href` reaches the DOM.
</script>

<template>
  <NeoModal v-if="open" title="Platba" @close="emit('close')">
    <template #subtitle>Suma na úhradu: <b class="mono">{{ formatPrice(amount) }}</b></template>

    <!-- ⚠ GATED ON THE HREF, not on `revolutUsername` (the shipped check), so the render
         condition and the link can never disagree. `revolutLink()` returns `''` for a
         whitespace-only handle, and `PUT /settings` trims only the creditor name — so on
         the shipped gate a handle of spaces rendered `href=""`, which is a link to the
         CURRENT URL: clicking it reloads the page and, on the guest confirmation screen,
         discards the confirmation state (its payment data comes only from the submit
         response — 06 §UC-GX-004). The old code's broken external link was at least
         honest; an empty href is destructive. Same one-predicate reasoning as the amount
         label above. -->
    <a
      v-if="revolutHref"
      class="btn block"
      style="background:#0075EB;color:#fff;border-color:#0a0a0a"
      :href="revolutHref"
      target="_blank"
      rel="noopener noreferrer"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.1 6.8c-.3-1.2-1-2.2-2-2.9-.9-.7-2.1-1-3.3-1H6.2L4 20.1h4.1l1-5.5h3.7c1.6 0 3-.5 4.1-1.4 1.1-.9 1.9-2.2 2.2-3.8l.5-2.6zM16 9.2l-.2 1c-.2.9-.6 1.5-1.2 2-.6.5-1.4.7-2.3.7H9.1l1-5.5h3.2c.7 0 1.2.2 1.6.6.4.4.5.9.4 1.5l-.3 1.7z"/></svg>
      <!-- ⚠ The accessible name still STARTS with the shipped string, so every
           `getByRole('link', { name: 'Zaplatiť cez Revolut' })` (Playwright matches
           substrings) keeps resolving. The amount is a nested `.mono` span — money
           renders in Courier Prime (02 §UC-DS-012). -->
      Zaplatiť cez Revolut
      <span v-if="revolutAmountLabel" class="mono">{{ revolutAmountLabel }}</span>
    </a>

    <!-- R6.2 — the bank-app deep link, PHONES ONLY. On a desktop the QR below is the
         path to the same banking app, and a link that opens nothing would be worse
         than no link. `v-if`, never a CSS hide: see the note in the script block. -->
    <a
      v-if="showPayme"
      class="btn block"
      data-testid="payme-link"
      :href="paymeHref"
      target="_blank"
      rel="noopener noreferrer"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>
      Zaplatiť cez bankovú appku (PayMe)
    </a>

    <div v-if="iban" style="text-align:center">
      <div class="sub" style="margin-bottom:10px">Pay by Square (QR kód pre bankovú appku)</div>
      <div v-if="qrDataUrl" class="qr">
        <img :src="qrDataUrl" alt="Pay by Square QR" style="display:block;width:100%;height:100%" />
      </div>
      <div v-else-if="qrError" class="sub" style="color:var(--danger)">Nepodarilo sa vygenerovat QR kod.</div>
      <div v-else class="sub">Generujem QR kod...</div>
      <div class="sub mono" style="margin-top:10px;font-size:12px">IBAN: {{ iban }}</div>
    </div>

    <!-- The reference row now lives HERE and nowhere else (06 resolved conflict
         #4): the on-card rows on g-confirm and g-status are removed. The testid
         falls through to `NeoCopyRow`'s `.copyrow` root, so
         `getByTestId('payment-reference')` still carries the text AND
         `.getByRole('button')` addresses the copy button (§UC-GX-011 items 2/4). -->
    <div v-if="reference">
      <label class="field-lbl">Poznámka k platbe (uveďte ju pri platbe)</label>
      <NeoCopyRow :value="reference" small data-testid="payment-reference" />

      <!-- R6.3 — the variable symbol, for anyone typing the transfer by hand. It sits
           INSIDE the reference section (so `.m-body` keeps its three prototype
           children) and gets its OWN testid: `payment-reference` reads the reference
           row's text and its single button, and must keep meaning only that.
           ⚠ A surface whose payload carries no `variable_symbol` (a stale cached
           response) renders today's modal rather than a made-up symbol. -->
      <template v-if="variableSymbol">
        <label class="field-lbl" style="margin-top:10px">Variabilný symbol</label>
        <NeoCopyRow :value="variableSymbol" small data-testid="payment-vs" />
      </template>
    </div>

    <template #footer>
      <button type="button" class="btn" @click="emit('close')">Zavrieť</button>
    </template>
  </NeoModal>
</template>
