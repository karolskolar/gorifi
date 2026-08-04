<script setup>
import { ref, computed } from 'vue'
import api from '../api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

// Lead capture (§UC-GSO-015, §Lead Capture) — ONE component for BOTH guest screens:
// the confirmation on `/g/:token` and the status page on `/g/:token/o/:orderToken`.
// Same seam rule as GuestProductGrid: extend this, never fork it.
//
// Deliberately LOW-KEY. Both screens exist to tell the guest what to pay and where
// to pay it; a recruitment box that competes with the payment information would cost
// more than the lead is worth. So: one line of text and a text-style button, folded
// away until it is tapped.
//
// The CTA writes through `POST /api/guest/:token/orders/:orderToken/invite-request`
// (no auth headers — the token pair in the URL is the whole credential) and creates
// an `invitations` row credited to the HOST. The wording is the spec's, moved to the
// vy-form the rest of these screens use: the spec's "Chceš si nabudúce objednať
// sám?" both addresses the reader informally and genders them, and CLAUDE.md pins
// impersonal/vy-form with no reader-gendered participles.
//
// Contact details are PREFILLED from the guest's own sub-order (Decision 7 already
// required name + mobile) but stay editable — a guest may want a different e-mail on
// their account than the one they used for a one-off coffee.

const props = defineProps({
  token: { type: String, required: true },
  orderToken: { type: String, required: true },
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  // From the server (`invite_request.requested`): this phone already has a pending
  // invitation, so the form would only be answered with a 409.
  requested: { type: Boolean, default: false }
})

const open = ref(false)
const submitting = ref(false)
const error = ref('')
const done = ref(false)
// Discovered from a 409 — the same state as `requested`, just learned the hard way
// (e.g. the guest asked from another device, or edited the number to one that is
// already queued).
const conflict = ref(false)

const alreadyRequested = computed(() => conflict.value || props.requested)

const form = ref({ name: '', phone: '', email: '' })

function openForm() {
  error.value = ''
  // Read the props at OPEN time, not at setup: on the status page they arrive with
  // the async load, after this component's first render.
  form.value = {
    name: props.name || '',
    phone: props.phone || '',
    email: props.email || ''
  }
  open.value = true
}

// Mirrors the server's rule (Decision 7) so the guest finds out immediately; the
// backend validates it again regardless.
function validate() {
  if (!form.value.name.trim()) return 'Zadajte meno.'
  if (form.value.phone.replace(/\D/g, '').length < 9) return 'Zadajte telefónne číslo (aspoň 9 číslic).'
  return ''
}

async function submit() {
  const problem = validate()
  if (problem) {
    error.value = problem
    return
  }
  submitting.value = true
  error.value = ''
  try {
    const payload = {
      name: form.value.name.trim(),
      phone: form.value.phone.trim()
    }
    const mail = form.value.email.trim()
    if (mail) payload.email = mail

    await api.requestGuestAccount(props.token, props.orderToken, payload)
    done.value = true
    open.value = false
  } catch (e) {
    // 409 = a pending request for this number is already queued. That is not
    // something the guest can fix and a retry would only 409 again, so the form
    // closes and says so instead of inviting a pointless second submission.
    if (e.status === 409) {
      conflict.value = true
      open.value = false
    } else {
      error.value = e.message
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div
    class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
    data-testid="invite-cta"
  >
    <!-- Submitted in this session -->
    <p v-if="done" data-testid="invite-done" class="text-emerald-700">
      Žiadosť o účet je odoslaná. Správca sa vám ozve.
    </p>

    <!-- Already queued (server-known, or learned from a 409) -->
    <p v-else-if="alreadyRequested" data-testid="invite-requested">
      Žiadosť o účet už evidujeme. Správca sa vám ozve.
    </p>

    <!-- Folded away: one line and a text-style button -->
    <div v-else-if="!open" class="flex flex-wrap items-center justify-between gap-2">
      <span>Chcete si nabudúce objednať sami?</span>
      <Button
        variant="link"
        size="sm"
        class="h-auto p-0 text-xs"
        data-testid="invite-cta-open"
        @click="openForm"
      >
        Požiadať o účet
      </Button>
    </div>

    <!-- Unfolded: the prefilled invitation form -->
    <div v-else class="space-y-2">
      <p>
        Správca vás pridá medzi priateľov a nabudúce si objednáte priamo, bez kolegu.
      </p>
      <div class="space-y-1">
        <Label for="invite-name" class="text-xs">Meno *</Label>
        <Input id="invite-name" v-model="form.name" data-testid="invite-name" maxlength="120" />
      </div>
      <div class="space-y-1">
        <Label for="invite-phone" class="text-xs">Mobil *</Label>
        <Input id="invite-phone" v-model="form.phone" data-testid="invite-phone" inputmode="tel" maxlength="32" />
      </div>
      <div class="space-y-1">
        <Label for="invite-email" class="text-xs">E-mail (nepovinné)</Label>
        <Input id="invite-email" v-model="form.email" data-testid="invite-email" inputmode="email" maxlength="160" />
      </div>

      <Alert v-if="error" variant="destructive">
        <AlertDescription data-testid="invite-error">{{ error }}</AlertDescription>
      </Alert>

      <div class="flex gap-2 pt-1">
        <Button variant="outline" size="sm" class="flex-1 h-8 text-xs" :disabled="submitting" @click="open = false">
          Späť
        </Button>
        <Button size="sm" class="flex-1 h-8 text-xs" data-testid="invite-submit" :disabled="submitting" @click="submit">
          {{ submitting ? 'Odosielam…' : 'Odoslať žiadosť' }}
        </Button>
      </div>
    </div>
  </div>
</template>
