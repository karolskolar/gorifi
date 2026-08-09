<script setup>
// The shared "Platba" modal (06 §UC-GX-005), restyled onto the neo shell.
//
// ⚠ SHARED-CONSUMER CONTRACT, PINNED. Three callers mount this component —
// `GuestOrder.vue` (the g-confirm screen), `GuestOrderStatus.vue` (the guest's
// status page) and `FriendOrder.vue` (module 04's cart bar). Its props API is
// FROZEN: `open`, `amount`, `reference`, `iban`, `revolutUsername`; it emits
// `close` and nothing else. No admin view consumes it.
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
// kod...", "Nepodarilo sa vygenerovat QR kod.") are BEHAVIOUR and are carried
// over byte-identically from the shipped component — a restyle must not move a
// single character of the payload. Pinned by `guest-payment-modal.spec.js`, which
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

import { ref, watch } from 'vue'
import { encode, PaymentOptions, CurrencyCode, Version } from 'bysquare'
import QRCode from 'qrcode'
import NeoModal from '@/components/neo/NeoModal.vue'
import NeoCopyRow from '@/components/neo/NeoCopyRow.vue'

const props = defineProps({
  open: Boolean,
  amount: Number,
  reference: String,
  iban: String,
  revolutUsername: String
})

const emit = defineEmits(['close'])

const qrDataUrl = ref(null)
const qrError = ref(false)

watch(() => [props.open, props.iban, props.amount], async () => {
  if (props.open && props.iban) {
    await generateQr()
  }
}, { immediate: true })

async function generateQr() {
  qrError.value = false
  qrDataUrl.value = null
  try {
    const today = new Date()
    const dateStr = today.getFullYear().toString()
      + (today.getMonth() + 1).toString().padStart(2, '0')
      + today.getDate().toString().padStart(2, '0')

    const qrString = encode({
      invoiceId: '',
      payments: [{
        type: PaymentOptions.PaymentOrder,
        amount: props.amount,
        currencyCode: CurrencyCode.EUR,
        paymentDueDate: dateStr,
        variableSymbol: '',
        constantSymbol: '',
        specificSymbol: '',
        originatorsReferenceInformation: '',
        paymentNote: props.reference || '',
        bankAccounts: [{ iban: props.iban.replace(/\s/g, ''), bic: '' }],
        beneficiary: { name: 'Gorifi', street: '', city: '' }
      }]
    }, { version: Version['1.0.0'] })
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
// · SECTION ORDER IS FIXED — Revolut → QR/IBAN → reference (prototype
//   `ui.jsx PaymentModal`). `.m-body` is a 12px-gap flex column, so each section
//   is one direct child and there is no wrapper to space them.
// · The Revolut control is an `<a>`, not the prototype's inert `<button>`: it
//   navigates off-site, and `target="_blank" rel="noopener noreferrer"` plus the
//   real `href` are shipped behaviour that the re-skin keeps. It wears
//   `.btn.block` and the prototype's three inline colours (the border stays ink).
// · The `.qr .grid` pseudo-QR from `ui.jsx QRBox` is PROTOTYPE-ONLY and is never
//   rendered here (02 §UC-DS-012) — `.qr` is the 190×190 ink frame and the real
//   generated `<img>` fills its 164 px content box.
// · Callers gate the trigger that opens this modal on `iban || revolutUsername`,
//   so it never opens payment-empty; the two `v-if`s are the belt to that brace.
</script>

<template>
  <NeoModal v-if="open" title="Platba" @close="emit('close')">
    <template #subtitle>Suma na úhradu: <b class="mono">{{ formatPrice(amount) }}</b></template>

    <a
      v-if="revolutUsername"
      class="btn block"
      style="background:#0075EB;color:#fff;border-color:#0a0a0a"
      :href="`https://revolut.me/${revolutUsername}`"
      target="_blank"
      rel="noopener noreferrer"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.1 6.8c-.3-1.2-1-2.2-2-2.9-.9-.7-2.1-1-3.3-1H6.2L4 20.1h4.1l1-5.5h3.7c1.6 0 3-.5 4.1-1.4 1.1-.9 1.9-2.2 2.2-3.8l.5-2.6zM16 9.2l-.2 1c-.2.9-.6 1.5-1.2 2-.6.5-1.4.7-2.3.7H9.1l1-5.5h3.2c.7 0 1.2.2 1.6.6.4.4.5.9.4 1.5l-.3 1.7z"/></svg>
      Zaplatiť cez Revolut
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
    </div>

    <template #footer>
      <button type="button" class="btn" @click="emit('close')">Zavrieť</button>
    </template>
  </NeoModal>
</template>
