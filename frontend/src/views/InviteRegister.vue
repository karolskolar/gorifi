<script setup>
// The public invite-registration screen (`/invite/:code`) on the Podpultovka skin.
//
// ⚠ It has NO design-canon screen of its own — module 03 explicitly puts this route
// out of scope (`03-friend-login-portal.md:587`). So it is composed from the two
// established PUBLIC-screen precedents rather than invented: the modern login
// (`FriendPortal.vue`, UC-FL-002) for the branded column + `.card` form, and the
// guest dead-link card (`GuestOrder.vue` g-dead, §UC-GX-010) for the terminal
// states. Everything here is a theme class inside an `.app` root — no `ui/`
// components, which is what the old skin on this route was made of.
//
// ⚠ The Goriffee logo is GONE (product decision, 2026-08-12). This route was its
// only consumer app-wide, and `frontend/public/goriffee-logo.svg` is deleted with
// it. It was the roastery's mark on the ordering app's own registration page: the
// new chrome carries the Podpultovka wordmark like every other public screen, and
// no other restyled screen shows a partner logo. This also retires RD-DS-6's
// "colour treatment differs — design sign-off pending" residual, since the asset
// needing sign-off no longer renders anywhere.
//
// ⚠ NO PLACEHOLDERS on the fields (the 2026-08-10 login decision, 81abbf9): labels
// only, the inputs are empty until typed in. Asserted as absent in the spec, so a
// placeholder cannot creep back.
//
// Slovak register is impersonal/vy-form throughout — the old copy addressed the
// reader informally and with gendered participles ("Pozval/a ťa", "Tvoje meno",
// "Popros priateľa"). `Pozvánka od X` replaces the participle outright rather than
// carrying a "/a" slash form; the GSO-T10 rule (a participle is fine for a THIRD
// party, not for the reader) would have permitted "Pozval vás", but a noun phrase
// needs no gender at all.

import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import BrandChrome from '@/components/neo/BrandChrome.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'

const route = useRoute()

const state = ref('loading') // loading | form | success | invalid
const inviterName = ref('')
const error = ref('')
const submitting = ref(false)

const name = ref('')
const phone = ref('')
const email = ref('')

onMounted(async () => {
  try {
    const data = await api.validateInviteCode(route.params.code)
    inviterName.value = data.inviterName
    state.value = 'form'
  } catch (e) {
    state.value = 'invalid'
  }
})

async function submit() {
  error.value = ''

  // Kept even though the button is `:disabled` on the same condition: Enter in any
  // field still calls this, so the guard is reachable and is not dead code.
  if (!name.value.trim() || !phone.value.trim()) {
    error.value = 'Meno a telefón sú povinné'
    return
  }

  submitting.value = true
  try {
    await api.submitInvitation({
      invite_code: route.params.code,
      name: name.value.trim(),
      phone: phone.value.trim(),
      email: email.value.trim() || null
    })
    state.value = 'success'
  } catch (e) {
    error.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <!-- `flex flex-col` + the theme's `min-height:100vh` is what lets the invalid
       state's zone take `flex-1` and centre its card in the viewport (the g-dead
       layout). Without it `flex-1` is inert and the card sits under the header. -->
  <div class="app flex flex-col">
    <!-- ONE chrome instance for all four states, mounted as the first child of
         `.app`, full-bleed and not sticky (UC-DS-005/006) — the same shape
         `FriendPortal.vue` uses. It must stay OUTSIDE the state branch:
         `self-hosted-fonts.spec.js` sweeps this route with an unknown code
         precisely because the chrome renders even then, and a guest who mistypes
         a link must still be able to tell what they reached (the g-dead lesson). -->
    <BrandChrome
      subtitle="Registrácia"
      ticker="+++ VSTUP LEN NA POZVÁNKU +++ TOVAR POD PULTOM +++"
    >
      <template #titles>
        <span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>
        <span class="s">Registrácia</span>
      </template>
      <template #trailing>
        <span class="chip acc">Na pozvánku</span>
      </template>
    </BrandChrome>

    <!-- Loading -->
    <div
      v-if="state === 'loading'"
      class="sub"
      style="text-align:center;padding:48px 0"
      data-testid="invite-loading"
    >
      Overujem pozvánku...
    </div>

    <!-- ================= Invalid code =================
         The g-dead composition (§UC-GX-010): the card FLOATS in the halftone
         field rather than sitting under the header — there is no page here.
         ⚠ `inline-flex` on the icon badge is load-bearing, not cosmetic: Tailwind
         preflight declares `svg{display:block}`, which puts the padlock on its own
         line inside a plain `inline-block` badge. Same fix, same reason as the
         guest dead card. -->
    <div
      v-else-if="state === 'invalid'"
      class="flex-1 flex items-center justify-center p-5 sm:p-10"
    >
      <div
        class="card p-[22px] sm:p-[30px]"
        style="max-width:400px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center"
        data-testid="invite-invalid"
      >
        <span
          class="badge danger"
          style="font-size:13px;padding:6px 14px;transform:rotate(-2deg);display:inline-flex;align-items:center;gap:4px"
        ><NeoIcon name="lock" /><span>Slepá ulička</span></span>
        <!-- Single line at both sizes in a 400px card, so the theme's
             `.h-screen{line-height:.95}` stands — no inline override. -->
        <h1 class="h-screen text-[32px] sm:text-[38px]">Pozvánka neplatí</h1>
        <div class="sub" style="font-size:14px">
          Tento odkaz na pozvánku už neplatí alebo neexistuje.
        </div>
        <div class="sub" style="font-size:13.5px">
          Požiadajte o nový odkaz priateľa, ktorý vás pozval.
        </div>
      </div>
    </div>

    <!-- ================= Registration form =================
         Column geometry copied from the modern login (480px, same paddings and
         gap) — the two screens are the same kind of thing and sit one tap apart
         in the funnel. -->
    <div
      v-else-if="state === 'form'"
      class="mx-auto flex w-full max-w-[480px] flex-col gap-5 p-5 sm:p-8"
      data-testid="invite-form"
    >
      <!-- `line-height:normal` on the unclassed wrapper: A9/A10 are CLASS lists
           and cannot reach an element carrying no class, so `html{line-height:1.5}`
           would apply here. A zero delta today (every child is a block declaring
           its own leading), kept so the pattern stays safe to copy — the same
           basis RD-FL-8b kept the remember-me label on. -->
      <div class="text-center mt-2 sm:mt-6" style="line-height:normal">
        <span
          class="badge acc-o"
          style="transform:rotate(-2deg)"
          data-testid="invite-inviter"
        >Pozvánka od {{ inviterName }}</span>
        <!-- ⚠ `line-height:1.3` OVERRIDES `.h-screen{line-height:.95}`, and it is
             not cosmetic: this headline WRAPS at 480px and `.hl` paints a filled
             block plus a `0 4px 0` ink underline shadow, so at .95 the second
             line's block overlaps the first line's descenders and clips the
             underline. Exactly the g-confirm headline lesson. Inline because
             A9/A10 cannot beat a class rule that declares its own value.
             ⚠ ONE LINE: a newline before `<span>` is a whitespace node Vue's
             `condense` mode DELETES, gluing "medzi" to "svojimi". -->
        <h1 class="h-screen text-[36px] sm:text-[48px]" style="line-height:1.3;margin-top:14px">Vitajte medzi <span class="hl">svojimi</span></h1>
        <!-- 20px, not 12px: the highlight's underline shadow extends 4px BELOW the
             text box, so a smaller margin reads as less air than it declares. -->
        <div class="sub" style="margin-top:20px;font-size:14px">
          Nechajte nám kontakt a pridáme vás do najbližšej objednávky.
        </div>
      </div>

      <div class="card flex flex-col gap-4 p-[18px] sm:p-6">
        <div v-if="error" class="banner danger slim">
          <span class="dot"></span>
          <div>{{ error }}</div>
        </div>

        <div>
          <label class="field-lbl" for="ir-name">Meno a priezvisko</label>
          <input
            id="ir-name"
            v-model="name"
            class="inp"
            type="text"
            autocomplete="name"
            @keyup.enter="submit"
          />
        </div>

        <div>
          <label class="field-lbl" for="ir-phone">Telefón</label>
          <input
            id="ir-phone"
            v-model="phone"
            class="inp"
            type="tel"
            autocomplete="tel"
            @keyup.enter="submit"
          />
        </div>

        <div>
          <label class="field-lbl" for="ir-email">Email</label>
          <input
            id="ir-email"
            v-model="email"
            class="inp"
            type="email"
            autocapitalize="none"
            autocorrect="off"
            autocomplete="email"
            @keyup.enter="submit"
          />
          <!-- The old skin folded this into the label as "(pre zásielkovňu,
               voliteľné)". `.field-lbl` is `text-transform:uppercase`, so a
               parenthetical there renders as caps and reads as shouting; the
               theme has `.field-help` for exactly this. -->
          <div class="field-help">Nepovinné. Potrebujeme ho len pre doručenie zásielkovňou.</div>
        </div>

        <button
          class="btn accent block"
          :disabled="submitting || !name.trim() || !phone.trim()"
          @click="submit"
        >
          {{ submitting ? 'Odosielam...' : 'Odoslať registráciu' }}
        </button>
      </div>
    </div>

    <!-- ================= Success =================
         Deliberately NO "Odoslané" badge above the headline: the g-confirm
         declutter (2026-08-12) removed exactly that, because the badge, the
         headline and the appbar subtitle were three statements of one fact. -->
    <div
      v-else-if="state === 'success'"
      class="flex-1 flex items-center justify-center p-5 sm:p-8"
      data-testid="invite-success"
    >
      <!-- CENTRED on the halftone field, like the invalid card and for the same
           reason: this is a TERMINAL state with two lines of content, and the
           g-confirm top-aligned column only works there because a sum card, a line
           list and a payment button follow it. Top-aligned, this screen was a
           headline stranded above ~1000px of empty background. -->
      <div class="flex w-full max-w-[420px] flex-col gap-4" style="line-height:normal">
        <div class="text-center">
          <!-- Wraps at this width, so the same `line-height:1.3` rule as the form
               headline applies. ONE LINE for the `condense` reason above. -->
          <h1 class="h-screen text-[36px] sm:text-[44px]" style="line-height:1.3">Registrácia je <span class="hl">odoslaná</span></h1>
          <!-- Provenance, not a repeat of the headline: it confirms WHICH invite was
               used, which is the one thing the applicant cannot otherwise verify. -->
          <div class="sub" style="margin-top:20px;font-size:14px">
            Pozvánka od {{ inviterName }} je zaevidovaná.
          </div>
        </div>

        <!-- The practical next step. Deliberately does NOT promise a channel or a
             deadline the app cannot keep: an admin picks the invitation up by hand
             from `/admin/invitations`, so "ozveme sa" is as specific as this screen
             is entitled to be. -->
        <div class="card" style="padding:16px">
          <div class="field-lbl">Čo bude ďalej</div>
          <div class="sub" style="font-size:14px">
            Ozveme sa vám na číslo, ktoré ste zadali, a pridáme vás do najbližšej objednávky.
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
