<script setup>
import { ref, watch, onMounted } from 'vue'
import { encode, PaymentOptions, CurrencyCode, Version } from 'bysquare'
import QRCode from 'qrcode'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

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

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}
</script>

<template>
  <Dialog :open="open" @update:open="val => !val && emit('close')">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Platba</DialogTitle>
        <DialogDescription>
          Suma na úhradu: <strong>{{ formatPrice(amount) }}</strong>
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <!-- Revolut button -->
        <a
          v-if="revolutUsername"
          :href="`https://revolut.me/${revolutUsername}`"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center justify-center gap-2 w-full px-4 py-3 bg-[#0075EB] hover:bg-[#0066cc] text-white rounded-lg font-medium transition-colors"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.1 6.8c-.3-1.2-1-2.2-2-2.9-.9-.7-2.1-1-3.3-1H6.2L4 20.1h4.1l1-5.5h3.7c1.6 0 3-.5 4.1-1.4 1.1-.9 1.9-2.2 2.2-3.8l.5-2.6zM16 9.2l-.2 1c-.2.9-.6 1.5-1.2 2-.6.5-1.4.7-2.3.7H9.1l1-5.5h3.2c.7 0 1.2.2 1.6.6.4.4.5.9.4 1.5l-.3 1.7z"/>
          </svg>
          Zaplatiť cez Revolut
        </a>

        <!-- Pay by Square QR -->
        <div v-if="iban" class="text-center space-y-2">
          <p class="text-sm text-muted-foreground">Pay by Square (QR kód pre bankovú appku)</p>
          <div v-if="qrDataUrl" class="flex justify-center">
            <img :src="qrDataUrl" alt="Pay by Square QR" class="w-48 h-48" />
          </div>
          <div v-else-if="qrError" class="text-sm text-red-500 py-4">
            Nepodarilo sa vygenerovat QR kod.
          </div>
          <div v-else class="py-4 text-sm text-muted-foreground animate-pulse">
            Generujem QR kod...
          </div>
          <p class="text-xs text-muted-foreground">IBAN: {{ iban }}</p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')" class="w-full">
          Zavrieť
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
