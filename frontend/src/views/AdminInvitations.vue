<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { api } from '../api'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const invitations = ref([])
const activeFilter = ref('pending') // 'pending' | 'processed' | 'rejected' | ''

const onboardingLinks = ref([])
const onboardingLoading = ref(true)
const onboardingError = ref('')
const newLinkNote = ref('')
const showNewLinkInput = ref(false)
const authMode = ref(null)

const baseUrl = computed(() => window.location.origin)

async function loadOnboardingLinks() {
  onboardingLoading.value = true
  try {
    onboardingLinks.value = await api.getOnboardingLinks()
  } catch (e) {
    onboardingError.value = e.message || 'Nepodarilo sa načítať linky'
  } finally {
    onboardingLoading.value = false
  }
}

async function loadAuthMode() {
  try {
    const settings = await api.getAdminSettings()
    authMode.value = settings.authMode || 'legacy'
  } catch (e) {
    // Non-fatal
  }
}

async function createOnboardingLink() {
  if (!newLinkNote.value.trim()) return
  try {
    await api.createOnboardingLink(newLinkNote.value.trim())
    newLinkNote.value = ''
    showNewLinkInput.value = false
    await loadOnboardingLinks()
  } catch (e) {
    alert(e.message || 'Nepodarilo sa vytvoriť link')
  }
}

async function toggleOnboardingLink(link) {
  try {
    await api.updateOnboardingLink(link.id, { active: !link.active })
    await loadOnboardingLinks()
  } catch (e) {
    alert(e.message || 'Chyba pri zmene stavu')
  }
}

async function regenerateOnboardingLink(link) {
  if (!confirm(`Vygenerovať nový token pre "${link.note}"? Pôvodná URL prestane fungovať.`)) return
  try {
    await api.regenerateOnboardingLink(link.id)
    await loadOnboardingLinks()
  } catch (e) {
    alert(e.message || 'Chyba pri regenerácii tokenu')
  }
}

async function deleteOnboardingLink(link) {
  if (link.registration_count > 0) return
  if (!confirm(`Vymazať link "${link.note}"?`)) return
  try {
    await api.deleteOnboardingLink(link.id)
    await loadOnboardingLinks()
  } catch (e) {
    alert(e.message || 'Chyba pri mazaní linku')
  }
}

function copyLink(token) {
  const url = `${baseUrl.value}/onboard/${token}`
  navigator.clipboard.writeText(url).catch(() => {
    alert('Nepodarilo sa skopírovať URL')
  })
}

onMounted(async () => {
  await Promise.all([loadInvitations(), loadOnboardingLinks(), loadAuthMode()])
})

watchEffect(() => {
  document.title = 'Pozvánky - Gorifi Admin'
})

async function loadInvitations() {
  loading.value = true
  error.value = ''
  try {
    invitations.value = await api.getInvitations(activeFilter.value || undefined)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function setFilter(status) {
  activeFilter.value = status
  await loadInvitations()
}

async function updateStatus(id, status) {
  try {
    await api.updateInvitation(id, { status })
    await loadInvitations()
  } catch (e) {
    error.value = e.message
  }
}

async function deleteInvitation(id) {
  if (!confirm('Naozaj chcete vymazať túto pozvánku?')) return
  try {
    await api.deleteInvitation(id)
    await loadInvitations()
  } catch (e) {
    error.value = e.message
  }
}

// ── Approval dialog (07 §UC-IA-006) ──────────────────────────────────────────
// One click turns a pending invitation into a friend WITH WORKING CREDENTIALS, and
// this dialog is the ONLY holder of the plaintext temp password: it exists in the
// approve response, is rendered here, and is unrecoverable once the dialog closes
// (the recovery path is the per-friend password reset in AdminFriends).
//
// ⚠ NO NAVIGATION. This replaces the retired `?create=1` flow, which pushed the admin
// to /admin/friends with the applicant's name/phone/e-mail in the QUERY STRING
// (07 resolved conflict #1). Navigating away would also unmount the dialog and
// destroy the password with it.
const approveOpen = ref(false)
const approveInv = ref(null)
const approveUsername = ref('')
const approveNote = ref('')
const approveError = ref('')
const approveSaving = ref(false)
const approveResult = ref(null)
const approveCopied = ref(false)

// The username suggestion, exactly per §UC-IA-006: NFD → strip combining marks →
// lowercase → whitespace runs to '.' → drop everything outside [a-z0-9._-] → clamp 30.
// ⚠ The diacritics strip is not cosmetic: `validateUsername` rejects [^a-z0-9._-], so
// a naive lowercase of "Ján Kováč" would suggest "ján.kováč" — a prefill the endpoint
// 400s on. A result shorter than 3 prefills EMPTY for the same reason: an unusable
// suggestion is worse than an empty required field.
function slugifyUsername(name) {
  const slug = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 30)
  return slug.length >= 3 ? slug : ''
}

// The signed credential message (§UC-IA-006), VERBATIM. Deliberately ty-form —
// it is the admin's personal message to someone they invited, not app copy — with a
// plain hyphen. Do not re-word or "fix" the register.
const credentialsMessage = computed(() => {
  if (!approveResult.value) return ''
  const { username, tempPassword } = approveResult.value
  return `Ahoj, tvoj účet je pripravený. Prihlás sa na ${baseUrl.value} - užívateľské meno: ${username}, dočasné heslo: ${tempPassword}. Po prvom prihlásení si nastav vlastné heslo.`
})

function openApproveDialog(invitation) {
  approveInv.value = invitation
  // The applicant's own request wins; the slug is only the fallback.
  approveUsername.value = invitation.username || slugifyUsername(invitation.name)
  approveNote.value = invitation.inviter_name ? `Pozval/a: ${invitation.inviter_name}` : ''
  approveError.value = ''
  approveResult.value = null
  approveCopied.value = false
  approveSaving.value = false
  approveOpen.value = true
}

// Closing is ALWAYS an explicit user action (button / Esc / scrim) — never a timeout,
// never automatic on success — and it drops the plaintext.
function setApproveOpen(open) {
  approveOpen.value = open
  if (!open) {
    approveResult.value = null
    approveInv.value = null
    approveUsername.value = ''
    approveNote.value = ''
    approveError.value = ''
    approveCopied.value = false
  }
}

async function confirmApprove() {
  if (!approveInv.value || approveSaving.value || approveResult.value) return
  const username = approveUsername.value.trim().toLowerCase()
  approveSaving.value = true
  approveError.value = ''
  try {
    approveResult.value = await api.approveInvitation(approveInv.value.id, {
      username,
      note: approveNote.value.trim(),
    })
    // ⚠ The list refreshes BEHIND the still-open dialog: the row must leave the
    // pending queue (the approval really happened) while the credentials stay on
    // screen. Anything that closed the dialog to refresh would destroy them.
    await loadInvitations()
  } catch (e) {
    // 400/409 render INLINE with the field still editable, so the admin fixes the
    // username and retries without reopening (the "two pending invitations request
    // the same username" race lands here).
    approveError.value = e.message || 'Pozvánku sa nepodarilo schváliť'
  } finally {
    approveSaving.value = false
  }
}

// ⚠ Enter submits on KEYDOWN, never on keyup — this is a security guard, not a style
// choice. Enter on a focused row trigger activates the button during KEYDOWN; Radix
// then synchronously moves focus into `approve-username`, so the KEYUP half of that
// same physical keypress lands on the input. A `@keyup.enter` handler there fired the
// approval instantly, before the admin had seen the dialog — minting a real account
// and a one-time temp password nobody ever read, leaving the friend permanently
// locked out while the invitation read `processed`. Keydown cannot see that event:
// its target was the button. `event.repeat` covers the remaining case of Enter being
// HELD down, where auto-repeat would deliver genuine keydowns to the freshly focused
// input ~500 ms later.
function onEnterSubmit(event) {
  if (event.repeat) return
  confirmApprove()
}

// ⚠ §UC-IA-006's "after close the plaintext is unrecoverable by design" is about the
// EXPLICIT close action. An accidental route change is not that: browser Back (or the
// header's back chevron) unmounts this view and takes the only copy of the temp
// password with it, silently. A page RELOAD is deliberately NOT guarded — that is
// ordinary SPA behaviour and no route guard sees it.
onBeforeRouteLeave(() => {
  if (!approveResult.value) return true
  return window.confirm(
    'Dočasné heslo je zobrazené len teraz — po odchode zo stránky sa už nedá zobraziť. Naozaj chcete odísť?'
  )
})

function copyCredentials() {
  navigator.clipboard.writeText(credentialsMessage.value).then(() => {
    approveCopied.value = true
    setTimeout(() => { approveCopied.value = false }, 2000)
  }).catch(() => {
    alert('Nepodarilo sa skopírovať správu')
  })
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const pendingCount = computed(() => {
  if (activeFilter.value === 'pending') return invitations.value.length
  return null
})
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-3">
          <button @click="router.push('/admin/dashboard')" class="hover:bg-primary-foreground/10 rounded p-1 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd" />
            </svg>
          </button>
          <h1 class="text-xl font-bold">Pozvánky</h1>
        </div>
      </div>
    </header>

    <main class="max-w-5xl mx-auto p-4 space-y-6">
      <!-- Auth-mode warning -->
      <Alert v-if="authMode === 'legacy'" class="mb-4 border-amber-300 bg-amber-50">
        <AlertDescription class="text-amber-800">
          Auth mode je <strong>'legacy'</strong> — používatelia z onboardingu sa po
          vypršaní úvodnej session nebudú môcť znovu prihlásiť, kým neprepneš na
          <strong>'modern'</strong> v Nastaveniach.
        </AlertDescription>
      </Alert>

      <!-- Onboarding links section -->
      <section class="mb-8">
        <div class="flex justify-between items-center mb-3">
          <h2 class="text-lg font-semibold">Onboarding linky (pekáreň)</h2>
          <Button v-if="!showNewLinkInput" size="sm" @click="showNewLinkInput = true">+ Nový link</Button>
        </div>

        <div v-if="showNewLinkInput" class="flex gap-2 mb-3">
          <Input
            v-model="newLinkNote"
            placeholder="napr. Máj onboarding"
            @keyup.enter="createOnboardingLink"
            class="flex-1"
          />
          <Button @click="createOnboardingLink" :disabled="!newLinkNote.trim()">Vytvoriť</Button>
          <Button variant="ghost" @click="showNewLinkInput = false; newLinkNote = ''">Zrušiť</Button>
        </div>

        <div v-if="onboardingLoading" class="text-muted-foreground py-4">Načítavam…</div>
        <div v-else-if="onboardingError" class="text-destructive py-4">{{ onboardingError }}</div>
        <div v-else-if="onboardingLinks.length === 0" class="text-muted-foreground py-4">
          Zatiaľ žiadne onboarding linky.
        </div>
        <div v-else class="space-y-3">
          <Card v-for="link in onboardingLinks" :key="link.id">
            <CardContent class="p-4">
              <div class="flex items-start justify-between gap-3 mb-2">
                <div class="font-semibold">{{ link.note }}</div>
                <div class="flex items-center gap-2 shrink-0">
                  <button
                    @click="toggleOnboardingLink(link)"
                    :class="['text-xs px-2 py-1 rounded-full border',
                      link.active ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-muted border-border text-muted-foreground']"
                  >
                    {{ link.active ? 'Aktívny' : 'Neaktívny' }}
                  </button>
                  <button
                    @click="regenerateOnboardingLink(link)"
                    title="Vygenerovať nový token"
                    class="text-muted-foreground hover:text-foreground"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  <button
                    @click="deleteOnboardingLink(link)"
                    :disabled="link.registration_count > 0"
                    :title="link.registration_count > 0 ? 'Link má registrácie — najprv ho deaktivuj' : 'Vymazať'"
                    class="text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
              <div class="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                <code class="font-mono text-xs bg-muted px-2 py-1 rounded truncate flex-1">
                  {{ baseUrl }}/onboard/{{ link.token }}
                </code>
                <Button size="sm" variant="outline" @click="copyLink(link.token)">Kopírovať</Button>
              </div>
              <div class="text-xs text-muted-foreground">
                {{ link.registration_count }} registrácií · Vytvorené {{ formatDate(link.created_at) }}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <!-- Filter tabs -->
      <div class="flex gap-2">
        <Button
          :variant="activeFilter === 'pending' ? 'default' : 'outline'"
          size="sm"
          @click="setFilter('pending')"
        >
          Čakajúce
        </Button>
        <Button
          :variant="activeFilter === 'processed' ? 'default' : 'outline'"
          size="sm"
          @click="setFilter('processed')"
        >
          Spracované
        </Button>
        <Button
          :variant="activeFilter === 'rejected' ? 'default' : 'outline'"
          size="sm"
          @click="setFilter('rejected')"
        >
          Zamietnuté
        </Button>
        <Button
          :variant="activeFilter === '' ? 'default' : 'outline'"
          size="sm"
          @click="setFilter('')"
        >
          Všetky
        </Button>
      </div>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">
        Načítavam...
      </div>

      <Card v-else-if="invitations.length === 0">
        <CardContent class="py-12 text-center text-muted-foreground">
          Žiadne pozvánky
        </CardContent>
      </Card>

      <Card v-else>
        <CardContent class="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Meno</TableHead>
                <TableHead>Telefón</TableHead>
                <TableHead class="hidden sm:table-cell">Email</TableHead>
                <TableHead>Pozval/a</TableHead>
                <TableHead class="hidden sm:table-cell">Dátum</TableHead>
                <TableHead class="text-right">Akcie</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="inv in invitations" :key="inv.id">
                <TableCell class="font-medium">
                  {{ inv.name }}
                  <Badge v-if="inv.status === 'pending'" variant="outline" class="ml-2 text-xs text-yellow-600 border-yellow-600/30">Čaká</Badge>
                  <Badge v-else-if="inv.status === 'processed'" variant="outline" class="ml-2 text-xs text-green-600 border-green-600/30">Spracované</Badge>
                  <Badge v-else-if="inv.status === 'rejected'" variant="outline" class="ml-2 text-xs text-red-600 border-red-600/30">Zamietnuté</Badge>
                </TableCell>
                <TableCell>
                  <a :href="'tel:' + inv.phone" class="text-primary hover:underline">{{ inv.phone }}</a>
                </TableCell>
                <TableCell class="hidden sm:table-cell">
                  <template v-if="inv.email">
                    <a :href="'mailto:' + inv.email" class="text-primary hover:underline">{{ inv.email }}</a>
                  </template>
                  <span v-else class="text-muted-foreground">-</span>
                </TableCell>
                <TableCell>
                  <span>{{ inv.inviter_name }}</span>
                  <span class="text-xs text-muted-foreground ml-1">({{ inv.inviter_uid }})</span>
                  <!-- GSO-T10 (§Lead Capture): where the lead came from. Sits in the
                       "Pozval/a" cell because that is the provenance column — the
                       inviting friend is the host of the guest link. `source` is set
                       server-side; NULL means the classic invite-code registration,
                       which needs no tag. -->
                  <div
                    v-if="inv.source === 'guest_order'"
                    class="text-xs text-violet-700"
                    data-testid="invitation-source-guest"
                  >
                    Prišiel cez hosťovskú objednávku
                  </div>
                </TableCell>
                <TableCell class="hidden sm:table-cell text-muted-foreground text-sm">
                  {{ formatDate(inv.created_at) }}
                </TableCell>
                <TableCell class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <template v-if="inv.status === 'pending'">
                      <Button size="sm" variant="outline" @click="openApproveDialog(inv)" title="Vytvoriť priateľa s prihlásením">
                        Vytvoriť
                      </Button>
                      <Button size="sm" variant="outline" class="text-green-600 hover:text-green-700" @click="updateStatus(inv.id, 'processed')">
                        Spracované
                      </Button>
                      <Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" @click="updateStatus(inv.id, 'rejected')">
                        Zamietnuť
                      </Button>
                    </template>
                    <template v-else>
                      <Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" @click="deleteInvitation(inv.id)">
                        Vymazať
                      </Button>
                    </template>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>

    <!-- Approval dialog (07 §UC-IA-006). Two states in ONE dialog: the form, and the
         credentials. It never navigates, and on success it stays open while the list
         refreshes behind it — it is the only place the plaintext temp password ever
         exists, so closing it (button / Esc / scrim, always an explicit user action)
         destroys the credential by design. -->
    <Dialog :open="approveOpen" @update:open="setApproveOpen">
      <DialogContent data-testid="approve-dialog">
        <DialogHeader>
          <DialogTitle>
            {{ approveResult ? 'Prihlasovacie údaje' : 'Vytvoriť priateľa z pozvánky' }}
          </DialogTitle>
        </DialogHeader>

        <!-- ── FORM STATE ── -->
        <div v-if="!approveResult" class="space-y-4 py-2">
          <!-- Read-only summary: what the admin is approving. The phone is here on
               purpose — it is the mitigation for the accepted risk that approval does
               no digit-normalised duplicate check. -->
          <div class="rounded-md border bg-muted/40 px-3 py-2 text-sm space-y-1" data-testid="approve-summary">
            <div class="font-medium">{{ approveInv?.name }}</div>
            <div class="text-muted-foreground">
              {{ approveInv?.phone }}
              <template v-if="approveInv?.email"> · {{ approveInv.email }}</template>
            </div>
            <div class="text-muted-foreground">
              Pozval/a: {{ approveInv?.inviter_name || '-' }} · {{ formatDate(approveInv?.created_at) }}
            </div>
            <!-- GSO-T10: the same provenance tag as the list row. A guest lead is a
                 stranger the host vouched for, not a friend-of-a-friend referral. -->
            <div
              v-if="approveInv?.source === 'guest_order'"
              class="text-xs text-violet-700"
              data-testid="approve-source-guest"
            >
              Prišiel cez hosťovskú objednávku
            </div>
          </div>

          <!-- 400/409 render INLINE, with the username field still editable, so the
               admin retries without reopening the dialog. -->
          <Alert v-if="approveError" variant="destructive" data-testid="approve-error">
            <AlertDescription>{{ approveError }}</AlertDescription>
          </Alert>

          <div class="space-y-2">
            <Label>Prihlasovacie meno *</Label>
            <Input
              v-model="approveUsername"
              data-testid="approve-username"
              type="text"
              maxlength="30"
              autocapitalize="none"
              autocorrect="off"
              :disabled="approveSaving"
              @keydown.enter="onEnterSubmit"
            />
            <p class="text-xs text-muted-foreground">
              Len malé písmená, čísla, bodka (.), podtržník (_) a pomlčka (-). Min. 3 znaky.
            </p>
          </div>

          <div class="space-y-2">
            <Label>Poznámka (voliteľné)</Label>
            <Input
              v-model="approveNote"
              data-testid="approve-note"
              type="text"
              :disabled="approveSaving"
              @keydown.enter="onEnterSubmit"
            />
            <p class="text-xs text-muted-foreground">
              Interná poznámka pre admina (nezobrazuje sa priateľovi).
            </p>
          </div>
        </div>

        <!-- ── SUCCESS STATE: the only copy of the plaintext ── -->
        <div v-else class="space-y-4 py-2" data-testid="approve-credentials">
          <Alert class="border-amber-300 bg-amber-50">
            <AlertDescription class="text-amber-800">
              Dočasné heslo vidíte <strong>iba teraz</strong>. Po zatvorení okna sa už nedá zobraziť —
              pošlite ho priateľovi hneď. Pri prvom prihlásení si nastaví vlastné heslo.
            </AlertDescription>
          </Alert>

          <div class="rounded-md bg-muted px-3 py-2 font-mono text-sm space-y-1">
            <div>
              <span class="text-muted-foreground">Prihlásenie: </span>
              <span data-testid="approve-login-url">{{ baseUrl }}</span>
            </div>
            <div>
              <span class="text-muted-foreground">Meno: </span>
              <span data-testid="approve-cred-username">{{ approveResult.username }}</span>
            </div>
            <div>
              <span class="text-muted-foreground">Heslo: </span>
              <span data-testid="approve-cred-password">{{ approveResult.tempPassword }}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <template v-if="!approveResult">
            <Button variant="outline" :disabled="approveSaving" @click="setApproveOpen(false)">Zrušiť</Button>
            <Button
              data-testid="approve-submit"
              :disabled="approveSaving || !approveUsername.trim()"
              @click="confirmApprove"
            >
              {{ approveSaving ? 'Vytváram...' : 'Vytvoriť priateľa' }}
            </Button>
          </template>
          <template v-else>
            <Button variant="outline" data-testid="approve-copy" @click="copyCredentials">
              {{ approveCopied ? 'Skopírované!' : 'Kopírovať správu' }}
            </Button>
            <Button data-testid="approve-close" @click="setApproveOpen(false)">Zavrieť</Button>
          </template>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
