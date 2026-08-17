<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { loadGis } from '../lib/gis'

const baseUrl = computed(() => window.location.origin)
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const router = useRouter()

const friendsPassword = ref('')
const paymentIban = ref('')
const paymentRevolutUsername = ref('')
const authMode = ref('legacy')
const savingAuthMode = ref(false)
const loading = ref(true)
const saving = ref(false)
const savingPayment = ref(false)
const error = ref('')
const successMessage = ref('')

// Pickup locations
const pickupLocations = ref([])
const newLocationName = ref('')
const newLocationAddress = ref('')
const editingLocationId = ref(null)
const editingLocationName = ref('')
const editingLocationAddress = ref('')
const openMenuId = ref(null)

// 10 §UC-GA-010 — the admin Google allowlist. `googleClientId` null (an unconfigured
// deployment, or a failed probe) hides the whole section and makes `loadGis()`
// unreachable, so nothing is requested from Google.
const googleClientId = ref(null)
const googleEntries = ref([])
const googleBusy = ref(false)
const googleAddButtonEl = ref(null)
// ⚠ "the list failed to load" is a THIRD state, not a flavour of empty. See
// `loadGoogleSection()` — on an access-audit screen those two must never be confused.
const googleLoadFailed = ref(false)

// Roasteries
const roasteries = ref([])
const newRoasteryName = ref('')
const editingRoasteryId = ref(null)
const editingRoasteryName = ref('')

function closeMenuOnOutsideClick(e) {
  if (openMenuId.value && !e.target.closest('.relative')) {
    openMenuId.value = null
  }
}

onMounted(async () => {
  document.addEventListener('click', closeMenuOnOutsideClick)
  await loadSettings()
})

onUnmounted(() => {
  document.removeEventListener('click', closeMenuOnOutsideClick)
})

// Set page title
watchEffect(() => {
  document.title = 'Nastavenia - Gorifi Admin'
})

async function loadSettings() {
  loading.value = true
  error.value = ''

  try {
    const [settings, locations, roasteriesData] = await Promise.all([
      api.getAdminSettings(),
      api.getAllPickupLocations(),
      api.getRoasteries()
    ])
    friendsPassword.value = settings.friendsPassword || ''
    paymentIban.value = settings.paymentIban || ''
    paymentRevolutUsername.value = settings.paymentRevolutUsername || ''
    authMode.value = settings.authMode || 'legacy'
    pickupLocations.value = locations
    roasteries.value = roasteriesData
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }

  // ⚠ AFTER the main load and OUTSIDE its try, so a Google problem can never take the
  // settings page down — this page is the operator's route back to a working state.
  await loadGoogleSection()
}

// ═══════════════════════════════════════════════════════════════════════════
// 10 §UC-GA-010 — "Prihlásenie cez Google"
// ═══════════════════════════════════════════════════════════════════════════

async function loadGoogleSection() {
  try {
    const mode = await api.getAuthMode()
    googleClientId.value = mode.googleClientId || null
  } catch {
    googleClientId.value = null
  }
  // ⚠ The ALLOWLIST fetch is gated on the client id purely to avoid a pointless
  // request on an unconfigured deployment. The ROUTE itself has no such gate — an
  // operator who unsets the env must still be able to see and revoke what is there —
  // so if this section is ever shown unconditionally, nothing server-side changes.
  if (!googleClientId.value) return
  // ⚠⚠ A FAILED LOAD IS ITS OWN STATE, AND THIS IS AN ACCESS-AUDIT SCREEN.
  // Before this flag existed, a rotated token or a network blip left `googleEntries`
  // at `[]` and the section rendered "Zatiaľ žiadny Google účet. Do administrácie sa
  // dá prihlásiť len heslom." — a POSITIVE FACTUAL CLAIM about who can reach the
  // admin portal, which may be false, on the one screen whose job is answering
  // exactly that question. An admin reading it would conclude Google access is off
  // while an account still holds it. "I could not load the list" is the only honest
  // thing to say, and it is also the only one that tells them to retry.
  googleLoadFailed.value = false
  try {
    googleEntries.value = (await api.getAdminGoogleAllowlist()).entries || []
  } catch (e) {
    googleLoadFailed.value = true
    googleEntries.value = []
    error.value = e.message
    // ⚠ `mountGoogleAddButton()` is deliberately NOT reached: without it the mount
    // point stays unrendered rather than sitting there as an empty box promising an
    // add control that never appears (the template hides the whole add block in this
    // state for the same reason).
    return
  }
  await mountGoogleAddButton()
}

/**
 * Google's own button — the ONLY way an account enters the allowlist.
 *
 * ⚠ There is deliberately NO text field here. §UC-GA-010: the admin proves possession
 * of the account being added, so the identity comes out of a verified ID token and
 * never out of a form. No hand-typed identities, no e-mail-based matching, ever.
 *
 * ⚠ `gis.initialize()` UNCONDITIONALLY (the GA-T6/GA-T7 rule — GIS keeps ONE global
 * callback and the LAST `initialize()` owns it). `AdminLogin.vue` is a different view
 * and the two cannot be mounted together, so no collision is reachable today; the rule
 * is followed anyway because a guard flag is exactly what produced the friend-side bug
 * where a button rendered perfectly and did nothing.
 */
async function mountGoogleAddButton() {
  await nextTick()
  let gis
  try {
    gis = await loadGis(googleClientId.value)
  } catch {
    // Silent: the rest of the settings page works, and the entry list — including the
    // remove buttons — is still fully usable. Revocation must never depend on Google.
    return
  }
  if (!gis) return

  await nextTick()
  const el = googleAddButtonEl.value
  if (!el || !googleClientId.value) return

  gis.initialize({ client_id: googleClientId.value, callback: onGoogleAllowlistCredential })
  el.innerHTML = ''
  gis.renderButton(el, {
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'rectangular',
    logo_alignment: 'center',
    locale: 'sk',
    width: Math.max(200, Math.min(Math.round(el.clientWidth) || 320, 400)),
  })
}

async function onGoogleAllowlistCredential(response) {
  const credential = response && response.credential
  if (!credential) return

  error.value = ''
  successMessage.value = ''
  googleBusy.value = true
  try {
    // The server answers with the whole (stripped) list, so no second request.
    const result = await api.addAdminGoogleAccount(credential)
    googleEntries.value = result.entries || []
    // ⚠ "aktualizovaný", not "pridaný": a re-add of an account already on the list is
    // an idempotent 200 that only refreshes its e-mail (§UC-GA-010), and telling the
    // admin it was "added" would describe a second entry that does not exist.
    successMessage.value = 'Zoznam Google účtov bol aktualizovaný'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e) {
    error.value = e.message
  } finally {
    googleBusy.value = false
  }
}

async function removeGoogleAccount(email) {
  // ⚠ NO "you are removing the last one" guard, by design (§UC-GA-010): password auth
  // is the PERMANENT backup, so Google lockout is recoverable and the empty state is
  // legitimate — it simply means nobody logs into admin with Google.
  if (!confirm(`Naozaj odobrať ${email} zo zoznamu?`)) return
  error.value = ''
  googleBusy.value = true
  try {
    const result = await api.removeAdminGoogleAccount(email)
    googleEntries.value = result.entries || []
  } catch (e) {
    error.value = e.message
  } finally {
    googleBusy.value = false
  }
}

function formatGoogleDate(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('sk-SK')
}

// Roastery functions
async function addRoastery() {
  if (!newRoasteryName.value.trim()) return
  error.value = ''
  try {
    await api.createRoastery({ name: newRoasteryName.value.trim() })
    newRoasteryName.value = ''
    roasteries.value = await api.getRoasteries()
  } catch (e) {
    error.value = e.message
  }
}

function startEditRoastery(r) {
  editingRoasteryId.value = r.id
  editingRoasteryName.value = r.name
}

async function saveRoastery(id) {
  if (!editingRoasteryName.value.trim()) return
  error.value = ''
  try {
    await api.updateRoastery(id, { name: editingRoasteryName.value.trim() })
    editingRoasteryId.value = null
    roasteries.value = await api.getRoasteries()
  } catch (e) {
    error.value = e.message
  }
}

function cancelEditRoastery() {
  editingRoasteryId.value = null
}

async function deleteRoastery(id) {
  if (!confirm('Naozaj vymazať túto pražiareň?')) return
  error.value = ''
  try {
    await api.deleteRoastery(id)
    roasteries.value = await api.getRoasteries()
  } catch (e) {
    error.value = e.message
  }
}

async function addLocation() {
  if (!newLocationName.value.trim()) return
  error.value = ''
  try {
    await api.createPickupLocation({ name: newLocationName.value.trim(), address: newLocationAddress.value.trim() })
    newLocationName.value = ''
    newLocationAddress.value = ''
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

function startEditLocation(loc) {
  editingLocationId.value = loc.id
  editingLocationName.value = loc.name
  editingLocationAddress.value = loc.address || ''
}

async function saveLocation(id) {
  if (!editingLocationName.value.trim()) return
  error.value = ''
  try {
    await api.updatePickupLocation(id, { name: editingLocationName.value.trim(), address: editingLocationAddress.value.trim() })
    editingLocationId.value = null
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

function cancelEditLocation() {
  editingLocationId.value = null
}

async function toggleLocationActive(loc) {
  error.value = ''
  try {
    await api.updatePickupLocation(loc.id, { active: !loc.active })
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

async function toggleLocationType(loc, field, value) {
  error.value = ''
  try {
    await api.updatePickupLocation(loc.id, { [field]: value })
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

async function deleteLocation(id) {
  error.value = ''
  try {
    await api.deletePickupLocation(id)
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

async function saveSettings() {
  saving.value = true
  error.value = ''
  successMessage.value = ''

  try {
    await api.updateAdminSettings({ friendsPassword: friendsPassword.value })
    successMessage.value = 'Nastavenia boli uložené'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function saveAuthMode() {
  savingAuthMode.value = true
  error.value = ''
  successMessage.value = ''

  try {
    const result = await api.updateAdminSettings({ authMode: authMode.value })
    authMode.value = result.authMode
    successMessage.value = 'Režim autentifikácie bol uložený'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e) {
    error.value = e.message
  } finally {
    savingAuthMode.value = false
  }
}

async function savePaymentSettings() {
  savingPayment.value = true
  error.value = ''
  successMessage.value = ''

  try {
    await api.updateAdminSettings({
      paymentIban: paymentIban.value,
      paymentRevolutUsername: paymentRevolutUsername.value
    })
    successMessage.value = 'Platobné údaje boli uložené'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e) {
    error.value = e.message
  } finally {
    savingPayment.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            @click="router.push('/admin/dashboard')"
            class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <h1 class="text-xl font-bold">Nastavenia</h1>
        </div>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-2xl mx-auto px-4 py-8">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <Alert v-if="successMessage" class="mb-4 border-green-500 bg-green-50 text-green-800">
        <AlertDescription>{{ successMessage }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">
        Načítavam...
      </div>

      <Card v-else>
        <CardHeader>
          <CardTitle>Heslo pre priatelov</CardTitle>
          <CardDescription>
            Toto heslo budú používať všetci priatelia na prihlásenie do objednávkového portálu.
            Kazdy si vyberie svoje meno zo zoznamu a zada toto spolocne heslo.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-2">
            <Label for="friendsPassword">Heslo</Label>
            <Input
              id="friendsPassword"
              v-model="friendsPassword"
              type="text"
              placeholder="Zadajte heslo pre priatelov"
            />
            <p class="text-xs text-muted-foreground">
              Heslo je zobrazene ako text pre jednoduchsie zdielanie.
            </p>
          </div>

          <div class="pt-4">
            <Button @click="saveSettings" :disabled="saving">
              {{ saving ? 'Ukladám...' : 'Uložiť heslo' }}
            </Button>
          </div>

          <div class="pt-4 border-t">
            <p class="text-sm text-muted-foreground">
              <strong>Odkaz pre priatelov:</strong> {{ baseUrl }}/
            </p>
            <p class="text-xs text-muted-foreground mt-1">
              Priatelia pristupia na hlavnu stranku, kde sa prihlasia pomocou tohto hesla.
            </p>
          </div>
        </CardContent>
      </Card>

      <!-- Auth Mode -->
      <Card v-if="!loading" class="mt-6">
        <CardHeader>
          <CardTitle>Režim autentifikácie</CardTitle>
          <CardDescription>
            Ovládajte, ako sa priatelia prihlasujú do portálu.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-3">
            <label class="flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/50" :class="authMode === 'legacy' ? 'border-primary bg-primary/5' : ''">
              <input type="radio" v-model="authMode" value="legacy" class="mt-1" />
              <div>
                <div class="font-medium">Spoločné heslo (pôvodné)</div>
                <p class="text-xs text-muted-foreground">Priatelia si vyberú meno zo zoznamu a zadajú spoločné heslo. Aktuálne správanie.</p>
              </div>
            </label>
            <label class="flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/50" :class="authMode === 'transition' ? 'border-primary bg-primary/5' : ''">
              <input type="radio" v-model="authMode" value="transition" class="mt-1" />
              <div>
                <div class="font-medium">Prechodný režim</div>
                <p class="text-xs text-muted-foreground">Obe možnosti prihlásenia — spoločné heslo aj osobné prihlásenie. Po prihlásení spoločným heslom budú priatelia vyzvaní na nastavenie vlastných prihlasovacích údajov.</p>
              </div>
            </label>
            <label class="flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/50" :class="authMode === 'modern' ? 'border-primary bg-primary/5' : ''">
              <input type="radio" v-model="authMode" value="modern" class="mt-1" />
              <div>
                <div class="font-medium">Osobné prihlásenie</div>
                <p class="text-xs text-muted-foreground">Len užívateľské meno a heslo. Zoznam mien sa nezobrazuje.</p>
                <Alert v-if="authMode === 'modern'" class="mt-2 border-yellow-300 bg-yellow-50">
                  <AlertDescription class="text-yellow-800 text-xs">
                    Priatelia bez nastavených prihlasovacích údajov sa nebudú môcť prihlásiť. Pred prepnutím overte, že všetci majú nastavené údaje.
                  </AlertDescription>
                </Alert>
              </div>
            </label>
          </div>

          <div class="pt-4">
            <Button @click="saveAuthMode" :disabled="savingAuthMode">
              {{ savingAuthMode ? 'Ukladám...' : 'Uložiť režim' }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <!-- ═══════════════════════════════════════════════════════════════════
           10 §UC-GA-010 — Prihlásenie cez Google

           ⚠ HIDDEN ENTIRELY when `googleClientId` is null (the mailer no-op
           precedent): an unconfigured deployment renders no Google control and
           makes no request to accounts.google.com.

           ⚠ There is NO input field, and that is the design: an account joins the
           allowlist only by signing in through Google's own button, which proves
           possession. A typed address would be an identity nobody confirmed.
           ═══════════════════════════════════════════════════════════════════ -->
      <Card v-if="!loading && googleClientId" class="mt-6" data-testid="admin-google-section">
        <CardHeader>
          <CardTitle>Prihlásenie cez Google</CardTitle>
          <CardDescription>
            Google účty, ktoré majú prístup do administrácie. Prihlásenie heslom zostáva
            vždy funkčné ako záložná možnosť.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- ⚠ The failure state comes FIRST: it must win over both the list and the
               empty state, because "I could not load this" is not "this is empty". -->
          <div
            v-if="googleLoadFailed"
            data-testid="admin-google-error"
            class="text-sm rounded-lg border border-destructive/50 text-destructive px-3 py-2"
          >
            Zoznam Google účtov sa nepodarilo načítať. Skúste stránku obnoviť — kým sa
            nenačíta, tu nie je vidieť, kto má prístup.
          </div>

          <div v-else-if="googleEntries.length > 0" class="space-y-2">
            <div
              v-for="entry in googleEntries"
              :key="`${entry.email}|${entry.added_at}`"
              data-testid="admin-google-entry"
              class="flex items-center gap-3 px-3 py-2 rounded-lg border"
            >
              <div class="flex-1 min-w-0">
                <div class="font-medium truncate">{{ entry.email }}</div>
                <div v-if="entry.added_at" class="text-xs text-muted-foreground">
                  Pridaný {{ formatGoogleDate(entry.added_at) }}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                class="text-destructive flex-shrink-0"
                :disabled="googleBusy"
                @click="removeGoogleAccount(entry.email)"
              >
                Odobrať
              </Button>
            </div>
          </div>
          <div v-else data-testid="admin-google-empty" class="text-sm text-muted-foreground py-2">
            Zatiaľ žiadny Google účet. Do administrácie sa dá prihlásiť len heslom.
          </div>

          <!-- ⚠ Hidden while the list failed to load: `mountGoogleAddButton()` was
               never reached on that path, so rendering the mount would leave an empty
               box promising a control that never appears. -->
          <div v-if="!googleLoadFailed" class="pt-4 border-t space-y-2">
            <Label>Pridať Google účet, ktorým sa chcete prihlasovať</Label>
            <!-- A bare mount point: Google's brand guidelines forbid restyling the
                 GIS button, so it carries no Button class. -->
            <div
              ref="googleAddButtonEl"
              data-testid="admin-google-add"
              class="flex justify-start min-h-[44px]"
            ></div>
            <p class="text-xs text-muted-foreground">
              Prihláste sa účtom, ktorý chcete pridať — potvrdíte tým, že vám patrí.
            </p>
          </div>
        </CardContent>
      </Card>

      <!-- Payment Settings -->
      <Card v-if="!loading" class="mt-6">
        <CardHeader>
          <CardTitle>Platobne udaje</CardTitle>
          <CardDescription>
            Tieto udaje sa zobrazia priatelom po odoslani objednavky, aby mohli zaplatit.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-2">
            <Label for="paymentIban">IBAN</Label>
            <Input
              id="paymentIban"
              v-model="paymentIban"
              type="text"
              placeholder="SK..."
            />
            <p class="text-xs text-muted-foreground">
              Pre generovanie Pay by Square QR kodu (skenovatelny slovenskymi bankovymi appkami).
            </p>
          </div>

          <div class="space-y-2">
            <Label for="paymentRevolutUsername">Revolut username</Label>
            <Input
              id="paymentRevolutUsername"
              v-model="paymentRevolutUsername"
              type="text"
              placeholder="napr. karolskolar"
            />
            <p class="text-xs text-muted-foreground">
              Pre tlacidlo na platbu cez Revolut (revolut.me odkaz).
            </p>
          </div>

          <div class="pt-4">
            <Button @click="savePaymentSettings" :disabled="savingPayment">
              {{ savingPayment ? 'Ukladám...' : 'Uložiť platobné údaje' }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <!-- Pickup Locations -->
      <Card v-if="!loading" class="mt-6">
        <CardHeader>
          <CardTitle>Miesta vyzdvihnutia</CardTitle>
          <CardDescription>
            Miesta, kde si priatelia môžu vyzdvihnúť objednanú kávu alebo pečivo.
            Pri odoslaní objednávky si vyberajú jedno z týchto miest.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- Existing locations -->
          <div v-if="pickupLocations.length > 0" class="space-y-2">
            <div
              v-for="loc in pickupLocations"
              :key="loc.id"
              :class="['flex items-center gap-3 px-3 py-2 rounded-lg border', !loc.active ? 'opacity-50 bg-muted' : '']"
            >
              <template v-if="editingLocationId === loc.id">
                <div class="flex-1 flex gap-2 items-center">
                  <Input v-model="editingLocationName" placeholder="Názov" class="flex-1" />
                  <Input v-model="editingLocationAddress" placeholder="Adresa" class="flex-1" />
                  <Button size="sm" @click="saveLocation(loc.id)">Uložiť</Button>
                  <Button size="sm" variant="outline" @click="cancelEditLocation">Zrušiť</Button>
                </div>
              </template>
              <template v-else>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-1">
                    <span class="font-medium">{{ loc.name }}</span>
                    <span v-if="loc.address" class="text-sm text-muted-foreground">· {{ loc.address }}</span>
                  </div>
                </div>
                <label class="flex items-center gap-1 text-xs cursor-pointer flex-shrink-0" :class="loc.for_coffee ? 'text-foreground' : 'text-muted-foreground'">
                  <input type="checkbox" :checked="loc.for_coffee" @change="toggleLocationType(loc, 'for_coffee', $event.target.checked)" class="rounded" />
                  Káva
                </label>
                <label class="flex items-center gap-1 text-xs cursor-pointer flex-shrink-0" :class="loc.for_bakery ? 'text-foreground' : 'text-muted-foreground'">
                  <input type="checkbox" :checked="loc.for_bakery" @change="toggleLocationType(loc, 'for_bakery', $event.target.checked)" class="rounded" />
                  Pekáreň
                </label>
                <div class="relative flex-shrink-0">
                  <button
                    @click="openMenuId = openMenuId === loc.id ? null : loc.id"
                    class="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  >
                    <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                    </svg>
                  </button>
                  <div
                    v-if="openMenuId === loc.id"
                    class="absolute right-0 top-full mt-1 z-10 bg-popover border rounded-md shadow-md py-1 min-w-[140px]"
                  >
                    <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-muted" @click="startEditLocation(loc); openMenuId = null">Upraviť</button>
                    <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-muted" @click="toggleLocationActive(loc); openMenuId = null">
                      {{ loc.active ? 'Deaktivovať' : 'Aktivovať' }}
                    </button>
                    <button class="w-full text-left px-3 py-1.5 text-sm text-destructive hover:bg-muted" @click="deleteLocation(loc.id); openMenuId = null">Vymazať</button>
                  </div>
                </div>
              </template>
            </div>
          </div>
          <div v-else class="text-sm text-muted-foreground py-2">
            Zatiaľ žiadne miesta. Pridajte prvé miesto vyzdvihnutia.
          </div>

          <!-- Add new location -->
          <div class="pt-4 border-t space-y-2">
            <Label>Pridať nové miesto</Label>
            <div class="flex gap-2">
              <Input v-model="newLocationName" placeholder="Názov" class="flex-1" />
              <Input v-model="newLocationAddress" placeholder="Adresa (voliteľné)" class="flex-1" />
              <Button @click="addLocation" :disabled="!newLocationName.trim()">Pridať</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Roasteries -->
      <Card v-if="!loading" class="mt-6">
        <CardHeader>
          <CardTitle>Pražiarne</CardTitle>
          <CardDescription>
            Zoznam pražiarní, z ktorých objednávate kávu. Pražiareň označená ako predvolená je hlavná pražiareň pre výpočet zliav.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- Existing roasteries -->
          <div v-if="roasteries.length > 0" class="space-y-2">
            <div
              v-for="r in roasteries"
              :key="r.id"
              class="flex items-center gap-3 px-3 py-2 rounded-lg border"
            >
              <template v-if="editingRoasteryId === r.id">
                <div class="flex-1 flex gap-2 items-center">
                  <Input v-model="editingRoasteryName" placeholder="Názov" class="flex-1" />
                  <Button size="sm" @click="saveRoastery(r.id)">Uložiť</Button>
                  <Button size="sm" variant="outline" @click="cancelEditRoastery">Zrušiť</Button>
                </div>
              </template>
              <template v-else>
                <div class="flex-1 min-w-0 flex items-center gap-2">
                  <span class="font-medium">{{ r.name }}</span>
                  <span v-if="r.is_default" class="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">Predvolená</span>
                </div>
                <Button v-if="!r.is_default" size="sm" variant="ghost" @click="startEditRoastery(r)">Upraviť</Button>
                <Button v-if="!r.is_default" size="sm" variant="ghost" class="text-destructive" @click="deleteRoastery(r.id)">Vymazať</Button>
              </template>
            </div>
          </div>
          <div v-else class="text-sm text-muted-foreground py-2">
            Zatiaľ žiadne pražiarne.
          </div>

          <!-- Add new roastery -->
          <div class="pt-4 border-t space-y-2">
            <Label>Pridať novú pražiareň</Label>
            <div class="flex gap-2">
              <Input v-model="newRoasteryName" placeholder="Názov pražiarne" class="flex-1" />
              <Button @click="addRoastery" :disabled="!newRoasteryName.trim()">Pridať</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  </div>
</template>
