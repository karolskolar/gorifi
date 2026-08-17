<script setup>
import { ref, computed, onMounted, nextTick, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { loadGis } from '../lib/gis'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

const router = useRouter()
const password = ref('')
const error = ref('')
const loading = ref(false)
const isSetup = ref(true)

// 10 §UC-GA-011 — the Google half. `null` (the default, and what an unconfigured
// deployment serves) means NOTHING Google-related renders and `loadGis()` is never
// called, so the screen is byte-identical to what it was before this row and no
// request to accounts.google.com occurs.
//
// ⚠ NO AUTH-MODE TERM HERE, deliberately, unlike the friend login card. `auth_mode`
// governs the FRIEND surface only (§UC-GA-011); the admin has always had a personal
// credential, so resolved decision #2 does not reach this screen.
const googleClientId = ref(null)
const googleButtonEl = ref(null)

onMounted(async () => {
  // Check if already logged in
  const token = localStorage.getItem('adminToken')
  if (token) {
    try {
      const { valid } = await api.verify(token)
      if (valid) {
        router.push('/admin/dashboard')
        return
      }
    } catch {
      localStorage.removeItem('adminToken')
    }
  }

  // Check if setup is needed
  try {
    const { isSetup: setupDone } = await api.checkSetup()
    isSetup.value = setupDone
  } catch (e) {
    error.value = e.message
  }

  // ⚠ NON-BLOCKING AND SILENT (the UC-FC-005 graceful-degradation pattern). The
  // password form is the PERMANENT backup and must never wait on — or be broken by —
  // a Google probe: a failed `auth-mode` call simply leaves `googleClientId` null and
  // the screen is the one that shipped before this row.
  try {
    const mode = await api.getAuthMode()
    googleClientId.value = mode.googleClientId || null
  } catch {
    googleClientId.value = null
  }
  if (showGoogleButton.value) renderGoogleButton()
})

// ⚠ `isSetup` is part of the gate. Before the first admin password exists this card
// is a SETUP form ("Nastavte admin heslo"), and the allowlist it would authenticate
// against is necessarily empty — so a Google button there could only ever 401. It
// appears once there is an account to log into.
const showGoogleButton = computed(() => isSetup.value && !!googleClientId.value)

/**
 * Render Google's own button into the mount point below the password form.
 *
 * ⚠ `gis.initialize()` IS CALLED UNCONDITIONALLY, the GA-T6/GA-T7 rule: GIS registers
 * ONE GLOBAL callback and the LAST `initialize()` owns it. `AdminLogin.vue` and
 * `AdminSettings.vue` are separate views that cannot be mounted at the same time, so
 * no collision is reachable TODAY — but a guard flag is precisely what turned that
 * into a live bug on the friend side (a button that rendered perfectly and did
 * nothing), and nothing about this file's future mounting is guaranteed.
 */
async function renderGoogleButton() {
  let gis
  try {
    gis = await loadGis(googleClientId.value)
  } catch {
    // ⚠ SILENT. A blocked, offline or CSP-refused Google must DEGRADE to the password
    // form, never hang the login screen or shout at an admin who was about to type
    // their password anyway. `loadGis` is timeout-bounded, so this is bounded too.
    return
  }
  if (!gis) return

  // Re-read after the await: the token-verify redirect above may have swapped the
  // whole view away while the script was in flight, and `renderButton` would then
  // throw on a null element.
  await nextTick()
  const el = googleButtonEl.value
  if (!el || !showGoogleButton.value) return

  gis.initialize({ client_id: googleClientId.value, callback: onGoogleCredential })
  el.innerHTML = ''
  gis.renderButton(el, {
    theme: 'outline',
    size: 'large',
    text: 'signin_with',
    shape: 'rectangular',
    logo_alignment: 'center',
    locale: 'sk',
    // Same clamp as every other GIS mount in this app: GIS caps at 400 and refuses
    // anything under 200.
    width: Math.max(200, Math.min(Math.round(el.clientWidth) || 320, 400)),
  })
}

/**
 * The GIS credential callback. §UC-GA-011: success stores the token in
 * `localStorage.adminToken` and navigates EXACTLY as the password path does — the two
 * paths mint the same one token, so anything that diverged here would diverge for one
 * login method only.
 */
async function onGoogleCredential(response) {
  const credential = response && response.credential
  if (!credential) return

  error.value = ''
  loading.value = true
  try {
    const { token } = await api.adminGoogleLogin(credential)
    localStorage.setItem('adminToken', token)
    router.push('/admin/dashboard')
  } catch (e) {
    // The server's own sentence, verbatim, in the existing error slot — including
    // "Tento Google účet nemá prístup do administrácie", which is the whole message.
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Set page title
watchEffect(() => {
  document.title = 'Prihlásenie - Gorifi Admin'
})

async function handleSubmit() {
  if (!password.value) {
    error.value = 'Zadajte heslo'
    return
  }

  loading.value = true
  error.value = ''

  try {
    if (!isSetup.value) {
      await api.setup(password.value)
      isSetup.value = true
    }

    const { token } = await api.login(password.value)
    localStorage.setItem('adminToken', token)
    router.push('/admin/dashboard')
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background">
    <Card class="w-full max-w-md">
      <CardHeader class="text-center">
        <CardTitle class="text-3xl">Gorifi</CardTitle>
        <CardDescription>Správa objednávok kávy</CardDescription>
      </CardHeader>

      <CardContent>
        <form @submit.prevent="handleSubmit" class="space-y-4">
          <div class="space-y-2">
            <Label for="password">
              {{ isSetup ? 'Admin heslo' : 'Nastavte admin heslo' }}
            </Label>
            <Input
              id="password"
              v-model="password"
              type="password"
              :placeholder="isSetup ? 'Zadajte heslo' : 'Zvoľte heslo (min. 10 znakov)'"
            />
          </div>

          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>

          <Button type="submit" :disabled="loading" class="w-full">
            {{ loading ? 'Načítavam...' : (isSetup ? 'Prihlásiť sa' : 'Nastaviť heslo') }}
          </Button>
        </form>

        <!-- ═══════════════════════════════════════════════════════════════
             10 §UC-GA-011 — Google sign-in, BELOW the password form.

             ⚠ THE PASSWORD FORM IS NEVER REMOVED OR HIDDEN. That is the whole
             backup guarantee (brief item 3): if Google is misconfigured, the
             account is un-allowlisted, or the allowlist is emptied, the admin
             still gets in with a password. This block is purely additive —
             nothing above it was moved, restyled or reordered.

             ⚠ `v-if` on the whole block: with `googleClientId` null the screen
             is byte-identical to what it was before this row, and NO REQUEST
             TO accounts.google.com OCCURS — `renderGoogleButton()` is never
             called, so `loadGis()` never runs.

             ⚠ The container is a BARE MOUNT POINT. GIS renders its own
             cross-origin iframe here and Google's brand guidelines forbid
             restyling it, so it carries no Button class — the one accepted
             divergence from this screen's shadcn language (§Design reference).
             ═══════════════════════════════════════════════════════════════ -->
        <template v-if="showGoogleButton">
          <div data-testid="admin-google-divider" class="flex items-center gap-3 my-4">
            <span class="flex-1 border-t"></span>
            <span class="text-xs text-muted-foreground">alebo</span>
            <span class="flex-1 border-t"></span>
          </div>
          <div
            ref="googleButtonEl"
            data-testid="admin-google-signin"
            class="flex justify-center min-h-[44px]"
          ></div>
        </template>
      </CardContent>
    </Card>
  </div>
</template>
