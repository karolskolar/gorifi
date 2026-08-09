<script setup>
import { ref, computed } from 'vue'
import api from '../api'
import NeoIcon from '@/components/neo/NeoIcon.vue'

// Lead capture (§UC-GSO-015, §Lead Capture; restyled by 06 §UC-GX-009) — ONE
// component for BOTH guest screens: the confirmation on `/g/:token` and the status
// page on `/g/:token/o/:orderToken`. Same seam rule as GuestProductGrid: extend
// this, never fork it.
//
// ⚠ THE RESTYLE INVERTS THE SHIPPED VISUAL PRIORITY, deliberately. The shipped card
// was "deliberately LOW-KEY" — a dashed muted box with a text-style link — on the
// argument that a recruitment box must not compete with the payment information.
// The prototype's `GuestInviteCta` is the opposite: a pink `--hi` card with a
// rotated icon box and a display-face headline. The prototype wins (00-overview:
// prototype copy and visuals are final), and the competing-with-payment worry is
// answered by PLACEMENT instead — both screens keep the CTA below the sum card, the
// pay button and (on g-confirm) the status-URL row.
//
// ⚠ BEHAVIOUR IS GSO-T10'S AND UNCHANGED BY THIS ROW. The CTA writes through
// `POST /api/guest/:token/orders/:orderToken/invite-request` (no auth headers — the
// token PAIR in the URL is the whole credential) and creates an `invitations` row
// credited to the HOST. Client validation strings, the 409 handling and the
// prefill-at-open-time rule below are all byte-identical to the shipped ones.
//
// Contact details are PREFILLED from the guest's own sub-order (Decision 7 already
// required name + mobile) but stay editable — a guest may want a different e-mail on
// their account than the one they used for a one-off coffee.
//
// Copy note (resolved conflict #2): the fold line is the prototype's
// "Chcete si objednať sami?", not the shipped "Chcete si nabudúce objednať sami?".
// Both satisfy the CLAUDE.md GSO-T10 pin, which is about the vy-form register and
// the absence of a reader-gendered participle ("Chceš si … sám?" fails both); the
// pin does not reach the word "nabudúce", which the unfolded body still carries.
// `guest-lead-capture.spec.js:470` is re-pinned for it — §UC-GX-011 item 1, the one
// sanctioned e2e edit this row spends.

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
  <!-- ⚠ `data-testid="invite-cta"` RIDES ON EACH STATE'S OWN ROOT, not on a wrapper.
       §UC-GX-009 pins "root keeps `data-testid=invite-cta`", and the four states have
       three different roots (`.card`, `.banner.ok.slim`, `.banner.slim`) — exactly as
       the prototype, which returns the banner directly when done. A wrapper `<div>`
       would satisfy the testid but add an unclassed block to a `gap`-ed flex column,
       and unclassed blocks are the very thing the A10 note warns about. -->

  <!-- 3. Submitted in THIS session (a 201 we saw). Prototype verbatim, including the
         bolded first sentence. -->
  <div v-if="done" class="banner ok slim" data-testid="invite-cta">
    <span class="dot"></span>
    <span data-testid="invite-done" style="min-width:0"><b>Žiadosť o účet je odoslaná.</b> Správca sa vám ozve.</span>
  </div>

  <!-- 4. Already queued — server-known (`invite_request.requested`) or learned from a
         409. The prototype has no such state; neutral `.banner.slim` (accent-soft) is
         the styling decision §UC-GX-009 records, and the `.dot` comes with the banner
         idiom — every other banner on this shell carries one. Shipped copy kept, and
         deliberately NOT an invitation to retry: the server would only 409 again. -->
  <div v-else-if="alreadyRequested" class="banner slim" data-testid="invite-cta">
    <span class="dot"></span>
    <span data-testid="invite-requested" style="min-width:0">Žiadosť o účet už evidujeme. Správca sa vám ozve.</span>
  </div>

  <!-- 1 + 2. One `.card` for both the folded and the unfolded state (prototype:
         same node, different child), pink `--hi` so it reads as an offer rather than
         as another piece of order data. -->
  <div v-else class="card" style="padding:10px 12px;background:var(--hi)" data-testid="invite-cta">
    <!-- FOLDED. The icon box is a 36×36 white tile with its own 3px border and 2px
         shadow, rotated −3° — the one rotated element on these screens besides the
         badges. `display:flex` on it is what centres the 17px glyph; without it the
         svg would sit on the tile's baseline. -->
    <div v-if="!open" style="display:flex;gap:10px;align-items:center">
      <span
        style="width:36px;height:36px;flex-shrink:0;border:3px solid var(--nb-ink);border-radius:9px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:2px 2px 0 var(--nb-ink);transform:rotate(-3deg)"
      >
        <NeoIcon name="invite" />
      </span>
      <!-- `.display` is uppercase by class; `line-height:.95` is the prototype's and
           overrides A10's `normal` for this one headline. `min-width:0` lets the
           headline shrink instead of pushing the button off a 320px card. -->
      <div class="display" style="flex:1;min-width:0;font-size:17px;line-height:.95">Chcete si objednať sami?</div>
      <button
        type="button"
        class="btn sm"
        style="flex-shrink:0;min-height:34px;padding:6px 10px;font-size:12.5px"
        data-testid="invite-cta-open"
        @click="openForm"
      >Požiadať o účet</button>
    </div>

    <!-- UNFOLDED. `padding:4px` inside the card's own 10/12 is the prototype's
         (so the form sits 14/16 in, not 10/12). Fields are the module's `Field` port:
         a native `label.field-lbl` + `input.inp`, never `ui/label` / `ui/input`. -->
    <div v-else style="display:flex;flex-direction:column;gap:12px;padding:4px">
      <div class="display" style="font-size:21px;line-height:.95">Žiadosť o vlastný účet</div>
      <!-- Prototype copy — it drops the shipped ", bez kolegu", which said the same
           thing about the host twice. -->
      <div class="sub" style="font-size:13px">Správca vás pridá medzi priateľov a nabudúce si objednáte priamo.</div>

      <!-- The GSO-T3 bounds mirrored as `maxlength` (120 / 32 / 160). The server
           re-validates through the SHARED `validateIdentity()` the checkout also
           uses, but a silently truncated 200 000-char name is what the mirror
           prevents. -->
      <div>
        <label class="field-lbl" for="invite-name">Meno *</label>
        <input
          id="invite-name"
          v-model="form.name"
          class="inp"
          type="text"
          data-testid="invite-name"
          maxlength="120"
        />
      </div>
      <div>
        <label class="field-lbl" for="invite-phone">Mobil *</label>
        <input
          id="invite-phone"
          v-model="form.phone"
          class="inp"
          type="text"
          data-testid="invite-phone"
          inputmode="tel"
          maxlength="32"
        />
      </div>
      <div>
        <label class="field-lbl" for="invite-email">E-mail (nepovinné)</label>
        <input
          id="invite-email"
          v-model="form.email"
          class="inp"
          type="text"
          data-testid="invite-email"
          placeholder="meno@example.com"
          inputmode="email"
          maxlength="160"
        />
      </div>

      <!-- Client-side messages verbatim ("Zadajte meno." / "Zadajte telefónne číslo
           (aspoň 9 číslic)."); anything else here is the server's own message. -->
      <div v-if="error" class="banner danger slim" role="alert">
        <span class="dot"></span><span data-testid="invite-error" style="min-width:0">{{ error }}</span>
      </div>

      <div style="display:flex;gap:8px">
        <button type="button" class="btn sm" style="flex:1" :disabled="submitting" @click="open = false">Späť</button>
        <button
          type="button"
          class="btn sm dark"
          style="flex:1"
          data-testid="invite-submit"
          :disabled="submitting"
          @click="submit"
        >{{ submitting ? 'Odosielam…' : 'Odoslať žiadosť' }}</button>
      </div>
    </div>
  </div>
</template>
