<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'

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

function createFriendFromInvitation(invitation) {
  const params = new URLSearchParams({ create: '1', name: invitation.name })
  router.push(`/admin/friends?${params.toString()}`)
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
                </TableCell>
                <TableCell class="hidden sm:table-cell text-muted-foreground text-sm">
                  {{ formatDate(inv.created_at) }}
                </TableCell>
                <TableCell class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <template v-if="inv.status === 'pending'">
                      <Button size="sm" variant="outline" @click="createFriendFromInvitation(inv)" title="Vytvoriť priateľa">
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
  </div>
</template>
