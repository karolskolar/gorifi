<script>
// ⚠ A PLAIN `<script>` BLOCK, and it is load-bearing — this is the ONLY way to get
// module scope in an SFC that also uses `<script setup>`.
//
// `<script setup>` compiles its ENTIRE body into the component's `setup()` function,
// so a `const` declared at its top level is created FRESH FOR EVERY COMPONENT
// INSTANCE. The first cut of the single-shot guard lived there and looked module-scope;
// it was per-mount, and an in-SPA Back to `/magic/:token` fired the POST a SECOND time
// — spending a single-use credential twice. Caught by the guard's own e2e test
// ("Expected: 1, Received: 2"); nothing else in the app would have noticed, because the
// server refuses the replay and the page shows the same neutral card either way.
// Only imports are hoisted out of `<script setup>`; everything else is not.
//
// Keyed by token rather than a bare boolean, which is a strict superset of
// §UC-ML-005's wording ("a module-scope `redeemAttempted` ref"): it holds the same
// guarantee for the token in hand and additionally does not deadlock a genuinely
// DIFFERENT link opened in the same page session. A fresh document load legitimately
// re-attempts (new module state) — that is fine, because the server's `used_at IS NULL`
// predicate is the real single-use authority; this guard exists so that ONE page
// session cannot double-fire.
const redeemAttempted = new Set()
</script>

<script setup>
// `/magic/:token` — the page a mailed login link lands on (09 §UC-ML-005), ML-T3.
//
// ⚠ REDEMPTION IS A POST FIRED BY THIS PAGE'S JS, NEVER A GET SIDE EFFECT. Corporate
// mail scanners and link-prefetchers (the Outlook SafeLinks class) follow GET links;
// if the SPA's document GET burned the token, the human's own click would always land
// on "already used". So the document GET stays side-effect-free and the credential is
// spent by an explicit `POST /api/magic-link/redeem` from `onMounted`. Residual risk —
// a scanner that EXECUTES JS — is accepted and recorded in 09 §Accepted risks.
//
// ⚠ NO DESIGN-CANON SCREEN EXISTS for this route. It is composed from the
// `InviteRegister.vue` precedent (2026-08-12), which is itself composed from the two
// shipped public-screen patterns: the branded 480px column, and the guest g-dead card
// for TERMINAL states — centred with `flex-1`, never top-aligned, because a two-line
// terminal state at the top of the page is a headline stranded over ~1000px of empty
// halftone.
//
// ⚠ Every child of `.app` here is an ordinary flow element. Nothing is `fixed`,
// `sticky` or `absolute`, so the `.app > *` trap (a `(0,1,0)` theme rule that
// neutralises Tailwind positioning utilities on a DIRECT child) cannot bite. Keep it
// that way: a hand-rolled overlay added here would have to teleport out of `.app`.
//
// Slovak is vy-form throughout, and no participle addresses the reader.
// ⚠ COPY STATUS: the neutral failure sentence comes from the SERVER (one literal,
// §UC-ML-005) and is PROPOSED, NOT SIGNED — as is the headline above it (the
// consolidated §UC-ML-006 OPEN).

import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api, { clearFriendsPassword, setFriendsToken, setFriendsAuthInfo } from '../api'
import BrandChrome from '@/components/neo/BrandChrome.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'

const route = useRoute()
const router = useRouter()

const STORAGE_KEY = 'gorifi_friend_auth'

// ⚠ THE ONLY SENTENCE THIS PAGE EVER SHOWS ON FAILURE, byte-identical to the server's
// single 401 literal — and it is rendered UNCONDITIONALLY, never `e.message`.
//
// The first cut used `e?.message || NEUTRAL_FAILURE`, which could never reach the
// fallback: `api.js`'s `request()` always throws an Error with a non-empty `.message`.
// Measured live on the built page, that rendered raw English on a public Slovak screen
// — an aborted request showed **"Failed to fetch"**, a 500 showed "Chyba servera", a
// 429 the limiter's sentence — to someone who by definition already cannot log in, on a
// page with no retry affordance (the single-shot guard means only a full reload
// re-attempts). Nothing is lost by dropping the server's string: the server has exactly
// ONE failure literal and this constant is that literal.
//
// It also keeps the client half of the enumeration guarantee: the page must not have a
// second failure vocabulary, because a transport-level distinction ("Failed to fetch"
// vs the neutral sentence) is still a distinction rendered next to a token.
const NEUTRAL_FAILURE =
  'Odkaz na prihlásenie už nie je platný. Požiadajte o nový na prihlasovacej obrazovke.'

const state = ref('verifying') // verifying | failed
const error = ref('')

// ⚠ THE SINGLE-SHOT GUARD lives in the plain `<script>` block above — see the comment
// there for why it CANNOT live here.

onMounted(async () => {
  const token = String(route.params.token || '')

  if (redeemAttempted.has(token)) {
    // Already spent by this page session. We cannot know the outcome of that earlier
    // attempt, and a single-use token cannot be probed again to find out — so say the
    // one thing that is true either way.
    error.value = NEUTRAL_FAILURE
    state.value = 'failed'
    return
  }
  redeemAttempted.add(token)

  try {
    const result = await api.redeemMagicLink(token)

    // ⚠ THE SESSION BOUNDARY. This device may already hold SOMEONE ELSE's session —
    // clicking a valid login link means "log in as this link's owner" (§UC-ML-005), so
    // nothing of the previous friend may survive. `clearFriendsPassword()` drops the
    // in-memory token, the legacy shared password AND the cached auth info in one call;
    // the stored payload is then OVERWRITTEN with a fresh object, never merged into the
    // old one (a merge would carry a stale `friendName`, and worse, any flag a previous
    // session had set).
    clearFriendsPassword()
    setFriendsToken(result.token)
    setFriendsAuthInfo({
      friendId: result.friend.id,
      friendName: result.friend.name,
      friendUid: result.friend.uid
    })

    const payload = {
      friendId: result.friend.id,
      friendName: result.friend.name,
      friendUid: result.friend.uid,
      token: result.token,
      expiresAt: result.expiresAt,
      // Provenance for §UC-ML-008's non-blocking prompt. ML-T6 reads it (and adds its
      // own `magicPromptDismissed` sibling); nothing consumes it yet, and writing it
      // here is what makes "a fresh redemption resets the prompt" true by construction.
      viaMagicLink: true
    }
    // §UC-ML-005 / resolved conflict #4: an account already carrying
    // `must_change_password` keeps its FORCED flow. Carried in the stored payload
    // because the portal is reached by a route change, not by a prop — and consumed
    // there by 03 §UC-FL-012's EXISTING gate, not by new gate code.
    if (result.mustChangePassword) payload.mustChangePassword = true

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))

    // `replace`, not `push`: the magic URL must not sit in the history behind the
    // portal, where Back would return to a token that is now spent.
    router.replace('/')
  } catch {
    // ⚠ The caught error is DELIBERATELY not read — see NEUTRAL_FAILURE's comment.
    error.value = NEUTRAL_FAILURE
    state.value = 'failed'
  }
})

function backToLogin() {
  router.push('/')
}
</script>

<template>
  <!-- `flex flex-col` + the theme's `min-height:100vh` is what lets the terminal
       state's zone take `flex-1` and centre its card in the viewport (the g-dead
       layout). Without it `flex-1` is inert and the card sits under the header. -->
  <div class="app flex flex-col">
    <!-- ONE chrome instance for both states, mounted as the first child of `.app`,
         full-bleed and not sticky (UC-DS-005/006) — the same shape every other
         public screen uses. It stays OUTSIDE the state branch so a friend who
         reached a dead link can still tell what they reached. -->
    <BrandChrome
      subtitle="Prihlásenie"
      ticker="+++ TOVAR POD PULTOM +++ IBA PRE STÁLYCH +++"
    >
      <template #titles>
        <span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>
        <span class="s">Prihlásenie</span>
      </template>
    </BrandChrome>

    <!-- Mounting: the house loading register, same wording pattern as
         `InviteRegister.vue`'s "Overujem pozvánku...". -->
    <div
      v-if="state === 'verifying'"
      class="sub"
      style="text-align:center;padding:48px 0"
      data-testid="magic-verifying"
    >
      Overujem odkaz...
    </div>

    <!-- ================= Neutral failure =================
         ONE message for unknown / expired / used / inactive / ineligible /
         legacy-mode / malformed — the server sends a single literal and this page
         renders it verbatim. It must never branch on anything: any distinction here
         would rebuild, on the client, the oracle the server refuses to be.
         ⚠ `inline-flex` on the icon badge is load-bearing, not cosmetic: Tailwind
         preflight declares `svg{display:block}`, which puts the padlock on its own
         line inside a plain `inline-block` badge. Same fix, same reason as the guest
         dead card and the invite screen. -->
    <div
      v-else
      class="flex-1 flex items-center justify-center p-5 sm:p-10"
    >
      <div
        class="card p-[22px] sm:p-[30px]"
        style="max-width:400px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center"
        data-testid="magic-failed"
      >
        <span
          class="badge danger"
          style="font-size:13px;padding:6px 14px;transform:rotate(-2deg);display:inline-flex;align-items:center;gap:4px"
        ><NeoIcon name="lock" /><span>Slepá ulička</span></span>
        <!-- Single line at ≥390px (measured h1 height 30px); it WRAPS to two lines at
             320px (61px) and that is fine — no `1.3` override is needed here because
             this headline contains no `.hl`. The InviteRegister override exists for a
             specific collision: `.hl` paints a filled block plus a `0 4px 0` ink
             underline shadow, which at `.95` overlaps the line above and clips the
             underline. ⚠ Adding an `.hl` span — or a longer headline — to THIS h1
             brings that rule back with it. -->
        <h1 class="h-screen text-[32px] sm:text-[38px]">Odkaz už neplatí</h1>
        <div class="sub" style="font-size:14px" data-testid="magic-error">{{ error }}</div>
        <button class="btn block" style="margin-top:4px" @click="backToLogin">
          Späť na prihlásenie
        </button>
      </div>
    </div>
  </div>
</template>
