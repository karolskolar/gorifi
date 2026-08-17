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

import { computed, nextTick, ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { loadGis } from '../lib/gis'
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
// Optional (07 §UC-IA-004): the login name the applicant WANTS. It is a request,
// not a reservation — the admin can overwrite it at approval, and the availability
// check the server runs here is a courtesy (UC-IA-003).
const username = ref('')

onMounted(async () => {
  // ⚠ NOT awaited before the code check and deliberately non-blocking: the
  // registration form is the point of this screen, and a slow or failing
  // `auth-mode` must never delay or break it. `googleClientId` simply stays null,
  // which is the same state an unconfigured deployment is in — no Google control,
  // no request to Google. (The AdminDashboard pending-invitations banner precedent.)
  api.getAuthMode()
    .then((mode) => { googleClientId.value = mode?.googleClientId || null })
    .catch(() => {})

  try {
    const data = await api.validateInviteCode(route.params.code)
    inviterName.value = data.inviterName
    state.value = 'form'
  } catch (e) {
    state.value = 'invalid'
  }
})

// --- Google attach (10 §UC-GA-008) -------------------------------------------
//
// ⚠ NO AUTH-MODE TERM, and that is a decision. §UC-GA-005's login button and
// §UC-GA-006's prompt additionally require `authMode === 'modern'` because the
// endpoint they call (`PUT /:id/google-link`) answers 409 in legacy. This block
// posts to `POST /invitations/register`, which has no such refusal in any mode —
// §UC-GA-008's own condition is "rendered only when `googleClientId` is non-null",
// full stop. An identity attached on a legacy deployment is a frozen record that
// §UC-GA-009's approval copies onto the friend row; it starts working the moment
// the deployment flips, and until then the friend logs in with the username and
// password module 07's approval mints regardless of mode.
//
// ⚠ ACCEPTED RISK OF THAT DECISION, recorded rather than designed around. On a
// CONFIGURED but LEGACY deployment this block's help text promises "Po schválení sa
// budete môcť prihlásiť svojím Google účtom", and the server's collision 409 says
// "Prihláste sa cez Google" — both are true only AFTER the flip to modern, because
// `POST /friends/auth/google` answers the resolved-decision-#2 409 until then. Both
// strings are product-owner-signed in §UC-GA-008 and the render condition is
// spec-mandated, so neither is softened here. The operator note that actually
// removes the gap: ⚠ SET `GOOGLE_CLIENT_ID` AT OR AFTER THE MODERN FLIP, not before
// — an unset client id is exactly the "feature off" state this block already
// handles, so the promise is simply never made early.
const googleClientId = ref(null)
// Held in MEMORY only and sent ONLY with the submit (§UC-GA-008). Never stored,
// never put in localStorage — it is a one-shot credential.
const googleIdToken = ref('')
const googleEmail = ref('')

// The block belongs to the FORM state: on the loading/invalid/success screens
// there is nothing to attach an identity to, and rendering it there would make
// `/invite/:code` contact Google for anyone who mistyped a link.
const showGoogleBlock = computed(() => state.value === 'form' && !!googleClientId.value)
// The GIS mount exists only while nothing is attached — the captured state
// replaces it, so there is exactly one control at a time.
const showGoogleButton = computed(() => showGoogleBlock.value && !googleIdToken.value)

const googleButtonEl = ref(null)

// ⚠ Per-INSTANCE, and correct here (the FriendPortal.vue note): `initialize()`
// registers ONE global callback, so re-calling it on a re-render is pointless
// rather than harmful. The genuinely global part — one script tag, one in-flight
// promise — lives in `lib/gis.js`, which is a real module (the ML-T3 rule:
// `<script setup>` has no module scope).
//
// ⚠ The GA-T6/T7 global-callback hazard does not apply: nothing else on this route
// renders a Google control (`/invite/:code` mounts this view alone), so the last
// `initialize()` is always this block's, and an unconditional call would be
// correct too. Stated rather than assumed.
let googleInitialised = false

async function renderGoogleButton() {
  if (!showGoogleButton.value) return
  let gis
  try {
    gis = await loadGis(googleClientId.value)
  } catch {
    // ⚠ SILENT, deliberately (the login card's rule). A blocked, offline or slow
    // Google must DEGRADE — the four fields below are the whole registration and
    // Google is explicitly optional here, so the container simply stays empty.
    // `loadGis` is timeout-bounded, so this branch is reached in bounded time.
    return
  }
  if (!gis) return

  // ⚠ RE-READ after the await: the applicant may have submitted (success state) or
  // the code check may have failed while the script was in flight, in which case
  // the container is gone and `renderButton` would throw.
  await nextTick()
  const el = googleButtonEl.value
  if (!el || !showGoogleButton.value) return

  if (!googleInitialised) {
    gis.initialize({ client_id: googleClientId.value, callback: onGoogleCredential })
    googleInitialised = true
  }
  el.innerHTML = ''
  gis.renderButton(el, {
    theme: 'outline',
    size: 'large',
    text: 'signin_with',
    shape: 'rectangular',
    logo_alignment: 'center',
    locale: 'sk',
    // ⚠ Both bounds are GIS's OWN behaviour, not the spec's. §UC-GA-005 says only
    // "full available width up to GIS's 400px cap"; the 200px FLOOR is undocumented
    // there and was measured in GA-T4 — below it the library renders nothing at all,
    // which at 320px is what an unclamped `clientWidth` would produce. Attributed to
    // the measurement rather than to a spec line that does not say it.
    width: Math.max(200, Math.min(Math.round(el.clientWidth) || 320, 400)),
  })
}

// `immediate` so a block that is already showing gets its button; the watcher then
// covers every later transition (the auth-mode probe landing late, the code check
// resolving, a detach putting the mount point back).
watch(showGoogleButton, (show) => { if (show) renderGoogleButton() }, { immediate: true })

/**
 * The GIS credential callback.
 *
 * ⚠ The e-mail read here is DISPLAY ONLY and is decoded, never verified — the
 * server re-verifies the whole token with `google-auth-library` and stores the
 * address from ITS payload (§UC-GA-002: `email` only when `email_verified`). This
 * side must never be treated as a fact about the account; it exists so the
 * applicant can see WHICH account they just picked before submitting.
 */
function onGoogleCredential(response) {
  const credential = response && response.credential
  if (!credential) return
  googleIdToken.value = credential
  googleEmail.value = decodeGoogleEmail(credential)
  // A field-level failure from a previous submit is stale once the identity moves.
  if (error.value) error.value = ''
}

function decodeGoogleEmail(credential) {
  try {
    const payload = String(credential).split('.')[1]
    if (!payload) return ''
    const json = decodeURIComponent(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join('')
    )
    const claims = JSON.parse(json)
    return typeof claims.email === 'string' ? claims.email : ''
  } catch {
    // A token we cannot read is still a token the SERVER may accept — the decode
    // is for the label, not for the flow. Fall back to the neutral wording below.
    return ''
  }
}

function detachGoogle() {
  googleIdToken.value = ''
  googleEmail.value = ''
}

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
    // ⚠ `username` is OMITTED from the body when empty rather than sent as `''`
    // or `null`: the server stores NULL for an absent value and runs no validation
    // on it, which is what keeps the username-less happy path unchanged.
    const wanted = username.value.trim().toLowerCase()
    await api.submitInvitation({
      invite_code: route.params.code,
      name: name.value.trim(),
      phone: phone.value.trim(),
      email: email.value.trim() || null,
      ...(wanted ? { username: wanted } : {}),
      // ⚠ OMITTED when nothing is attached, exactly like `username` above: an
      // absent/empty `google_id_token` is what keeps the server on module 07's
      // byte-identical path (§UC-GA-008).
      ...(googleIdToken.value ? { google_id_token: googleIdToken.value } : {})
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

        <!-- ⚠ Every `maxlength` here MIRRORS a server bound (07 §UC-IA-003: name
             120, phone 32, email 160, username 30) — the GSO-T3 convention. The
             server is the boundary; these only stop a paste from reaching a 400. -->
        <div>
          <label class="field-lbl" for="ir-name">Meno a priezvisko</label>
          <input
            id="ir-name"
            v-model="name"
            class="inp"
            type="text"
            maxlength="120"
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
            maxlength="32"
            autocomplete="tel"
            @keyup.enter="submit"
          />
        </div>

        <!-- The requested login name (07 §UC-IA-004). `.inp` is mandatory, not
             stylistic: the A12 coarse-pointer 16px rule keys off that class, and
             without it a tap here re-scales the whole session on iOS.
             `autocapitalize="none"` + `autocorrect="off"` because the server
             lowercases and the charset is `[a-z0-9._-]` — iOS would otherwise
             offer "Lego" for a field that stores `lego`.
             No `autocomplete`: this is a NEW name being chosen, so neither
             `username` (which offers existing logins) nor `off` helps. -->
        <div>
          <label class="field-lbl" for="ir-username">Prihlasovacie meno</label>
          <input
            id="ir-username"
            v-model="username"
            class="inp"
            type="text"
            maxlength="30"
            autocapitalize="none"
            autocorrect="off"
            @keyup.enter="submit"
          />
          <div class="field-help">Nepovinné. 3–30 znakov: malé písmená, čísla, bodka, podčiarknik, pomlčka.</div>
        </div>

        <div>
          <label class="field-lbl" for="ir-email">Email</label>
          <input
            id="ir-email"
            v-model="email"
            class="inp"
            type="email"
            maxlength="160"
            autocapitalize="none"
            autocorrect="off"
            autocomplete="email"
            @keyup.enter="submit"
          />
          <!-- The old skin folded this into the label as "(pre zásielkovňu,
               voliteľné)". `.field-lbl` is `text-transform:uppercase`, so a
               parenthetical there renders as caps and reads as shouting; the
               theme has `.field-help` for exactly this.
               ⚠ `data-testid` because there are now TWO `.field-help` blocks on
               this screen — the spec's assertion that THIS one still says
               "Nepovinné" would otherwise be strict-mode ambiguous, and scoping it
               is what keeps it an assertion about the email hint specifically
               (07 §UC-IA-008 item 3). -->
          <div class="field-help" data-testid="invite-email-help">Nepovinné. Potrebujeme ho len pre doručenie zásielkovňou.</div>
        </div>

        <!-- ================= Optional Google attach (10 §UC-GA-008) =================
             A BORDERED block below the four fields, so it reads as an addition to
             the form rather than a fifth field. It renders only when the deployment
             serves a `googleClientId` — and only in the `form` state, which is what
             keeps the loading/invalid/success screens (and anyone who mistyped a
             code) from contacting Google at all.
             ⚠ The GIS iframe cannot wear this skin (Google's brand guidelines, the
             accepted risk in §Design reference), so the mount point below carries no
             theme class — do not "tidy" a `.btn` onto it. -->
        <div v-if="showGoogleBlock" class="ir-google" data-testid="invite-google">
          <div class="field-lbl">Prihlásenie cez Google</div>
          <div class="field-help">Nepovinné. Po schválení sa budete môcť prihlásiť svojím Google účtom.</div>

          <!-- Captured state: WHICH account, plus the way back out. The token is in
               memory only and travels with the submit. -->
          <div v-if="googleIdToken" class="ir-google-row" data-testid="invite-google-attached">
            <span class="sub ir-google-acct" data-testid="invite-google-account">{{ googleEmail || 'Google účet je pripojený' }}</span>
            <button type="button" class="btn sm" @click="detachGoogle">Zrušiť</button>
          </div>
          <!-- ⚠ `v-else`, not `v-show`: GIS renders an iframe into this node, so the
               mount point is recreated on detach and `renderGoogleButton()` runs
               again (the watcher). An emptied-but-kept container would leave the
               applicant with no way to attach a second time. -->
          <div v-else ref="googleButtonEl" class="ir-google-mount" data-testid="invite-google-signin"></div>
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

<style scoped>
/* ⚠ A SCOPED BLOCK, not an addition to `friends-theme.css` (the CatScrollArrow.vue
   and cart-line precedents): the theme is a byte-for-byte design-canon port with a
   numbered adaptation list, and a one-screen optional block belongs to none of it.
   Nothing here re-declares a property a theme rule sets on these elements. */
.ir-google {
  border: 2px dashed var(--nb-ink);
  border-radius: 10px;
  padding: 14px;
}
.ir-google-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
}
/* ⚠ `min-width:0` + clipping, not `overflow-wrap`: an e-mail address is one
   unbreakable token, and at 320px an un-clipped one paints outside the card (the
   RD-FO-2 hazard). The full address stays in the DOM. */
.ir-google-acct {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: normal;
}
.ir-google-mount {
  margin-top: 10px;
  /* GIS refuses widths under 200px, so the mount must never be squeezed below it. */
  min-height: 44px;
}
</style>
