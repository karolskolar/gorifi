<script setup>
import { ref, onMounted, onUnmounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'
import BalanceBadge from '@/components/BalanceBadge.vue'

const router = useRouter()
const friends = ref([])
const loading = ref(true)
const error = ref('')

// Modal state
const showModal = ref(false)
const editingFriend = ref(null)
// ⚠ `friendName` writes `friends.name` — a DISPLAY label, NOT a login (07 §UC-IA-007).
// The login lives on `friends.username` + `password_hash`, minted either by the
// invitation-approval dialog or by the per-row "Nastaviť username" / "Resetovať heslo"
// actions below. Never relabel this field as a credential again.
const friendName = ref('')        // friends.name — shown to the admin and to colleagues
const friendDisplayName = ref('') // friends.display_name — internal admin note (Poznámka)
const friendPhone = ref('')
const friendEmail = ref('')
const modalError = ref('')        // save errors render inside the dialog (the page Alert sits behind the overlay)

// UC-FC-002 — the truthful three-state credential derivation (fixes 07 follow-up #3).
// Derived from fields the admin list already returns: `username`,
// `hasCredentials = !!password_hash`, `must_change_password`. The old rendering
// (`username || 'Nastavené'`, green) displayed a password-without-username friend as
// credentialed while they could not log in under modern auth — that lie is retired here.
function credentialState(friend) {
  const hasUsername = !!friend.username
  if (hasUsername && friend.hasCredentials) return 'full'
  if (hasUsername || friend.hasCredentials) return 'partial'
  return 'none'
}

function credentialMissingTitle(friend) {
  return friend.username ? 'chýba heslo' : 'chýba užívateľské meno'
}

// The modal's read-only Prihlásenie line (UC-FC-003).
function credentialLine(friend) {
  const state = credentialState(friend)
  if (state === 'full') return friend.username
  if (state === 'partial') return `Neúplné — ${credentialMissingTitle(friend)}`
  return 'Nenastavené'
}

// Credential management
const showResetPasswordModal = ref(false)
const showSetUsernameModal = ref(false)
const credentialFriend = ref(null)
const resetPasswordValue = ref('')
const setUsernameValue = ref('')
const credentialError = ref('')
const credentialSaving = ref(false)
const credentialSuccess = ref('')

// Action menu state
const openMenuId = ref(null)

function handleClickOutside(e) {
  if (openMenuId.value !== null && !e.target.closest('.relative.inline-block')) {
    openMenuId.value = null
  }
}

onMounted(async () => {
  document.addEventListener('click', handleClickOutside)
  await loadFriends()
  // ⚠ The `?create=1` prefill receiver was DELETED in IA-T5 (07 §UC-IA-007). Its only
  // caller — AdminInvitations' "Vytvoriť" navigation — was retired in IA-T4 in favour of
  // an in-place approval dialog that mints real credentials. Do not reintroduce it:
  // prefilling this modal from a query string creates a friend with no login at all.
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

// Set page title
watchEffect(() => {
  document.title = 'Priatelia - Gorifi Admin'
})

async function loadFriends() {
  loading.value = true
  try {
    friends.value = await api.getFriends()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function openModal(friend = null) {
  editingFriend.value = friend
  friendName.value = friend ? friend.name : ''
  friendDisplayName.value = friend ? (friend.display_name || '') : ''
  friendPhone.value = friend ? (friend.phone || '') : ''
  friendEmail.value = friend ? (friend.email || '') : ''
  modalError.value = ''
  showModal.value = true
}

async function saveFriend() {
  if (!friendName.value.trim()) return

  modalError.value = ''
  try {
    const data = {
      name: friendName.value.trim(),
      display_name: friendDisplayName.value.trim() || null,
      phone: friendPhone.value.trim() || null,
      email: friendEmail.value.trim() || null
    }
    if (editingFriend.value) {
      await api.updateFriend(editingFriend.value.id, data)
    } else {
      await api.createFriend(data)
    }
    showModal.value = false
    friendName.value = ''
    friendDisplayName.value = ''
    friendPhone.value = ''
    friendEmail.value = ''
    editingFriend.value = null
    await loadFriends()
  } catch (e) {
    modalError.value = e.message
  }
}

async function toggleActive(friend) {
  try {
    await api.updateFriend(friend.id, { active: !friend.active })
    await loadFriends()
  } catch (e) {
    error.value = e.message
  }
}

async function deleteFriend(id) {
  if (!confirm('Naozaj vymazať tohto priateľa? Všetky jeho objednávky budú stratené.')) return

  try {
    await api.deleteFriend(id)
    await loadFriends()
  } catch (e) {
    error.value = e.message
  }
}

function toggleMenu(friendId) {
  openMenuId.value = openMenuId.value === friendId ? null : friendId
}

function closeMenu() {
  openMenuId.value = null
}

async function toggleSubscription(friend, type) {
  try {
    const current = friend.subscriptions || []
    let updated
    // If no subscriptions set (means "all"), unchecking one type means setting the other
    if (current.length === 0) {
      const allTypes = ['coffee', 'bakery']
      updated = allTypes.filter(t => t !== type)
    } else if (current.includes(type)) {
      updated = current.filter(t => t !== type)
    } else {
      updated = [...current, type]
    }
    await api.adminUpdateSubscriptions(friend.id, updated)
    friend.subscriptions = updated
  } catch (e) {
    error.value = e.message
  }
}

function openResetPassword(friend) {
  credentialFriend.value = friend
  resetPasswordValue.value = ''
  credentialError.value = ''
  credentialSuccess.value = ''
  showResetPasswordModal.value = true
}

async function resetPassword() {
  if (!resetPasswordValue.value || resetPasswordValue.value.length < 8) {
    credentialError.value = 'Heslo musí mať aspoň 8 znakov'
    return
  }
  credentialSaving.value = true
  credentialError.value = ''
  try {
    await api.adminResetFriendPassword(credentialFriend.value.id, resetPasswordValue.value)
    showResetPasswordModal.value = false
    credentialSuccess.value = `Heslo pre ${credentialFriend.value.name} bolo resetované`
    setTimeout(() => { credentialSuccess.value = '' }, 3000)
    await loadFriends()
  } catch (e) {
    credentialError.value = e.message
  } finally {
    credentialSaving.value = false
  }
}

function openSetUsername(friend) {
  credentialFriend.value = friend
  setUsernameValue.value = friend.username || ''
  credentialError.value = ''
  credentialSuccess.value = ''
  showSetUsernameModal.value = true
}

async function setUsername() {
  if (!setUsernameValue.value.trim()) {
    credentialError.value = 'Užívateľské meno je povinné'
    return
  }
  credentialSaving.value = true
  credentialError.value = ''
  try {
    await api.adminSetFriendUsername(credentialFriend.value.id, setUsernameValue.value.toLowerCase().trim())
    showSetUsernameModal.value = false
    credentialSuccess.value = `Username pre ${credentialFriend.value.name} bol nastavený`
    setTimeout(() => { credentialSuccess.value = '' }, 3000)
    await loadFriends()
  } catch (e) {
    credentialError.value = e.message
  } finally {
    credentialSaving.value = false
  }
}

// 11 §UC-FC-006 — admin severs a friend's Google link (friend lost the account, the
// wrong one got linked, offboarding). Rendered only when `googleLinked`, so a
// pre-module-10 deployment simply never shows it — the gating is DATA-driven, there is
// no feature flag.
//
// ⚠ The two confirm texts must genuinely DIFFER: for a friend with no password this
// unlink removes their last way in. The endpoint still allows it (admin authority — the
// recovery path is the existing "Resetovať heslo"), so the warning IS the guard.
// Copy is vy-form / impersonal, like the rest of this screen.
async function unlinkGoogle(friend) {
  let message = `Naozaj odpojiť účet Google od priateľa „${friend.name}“? Prihlásenie cez Google prestane fungovať.`
  if (!friend.hasCredentials) {
    message += ' Tento priateľ nemá nastavené heslo, takže sa po odpojení nebude môcť prihlásiť. Prístup mu obnovíte akciou Resetovať heslo.'
  }
  if (!confirm(message)) return

  // Row-menu actions surface failures in the PAGE-level Alert (see `deleteFriend`) —
  // this is not a dialog action, so FC-T2's in-dialog `modalError` does not apply here.
  try {
    await api.adminUnlinkFriendGoogle(friend.id)
    await loadFriends()
  } catch (e) {
    error.value = e.message
  }
}

function goToDashboard() {
  router.push('/admin/dashboard')
}

async function logout() {
  await api.logout()
  localStorage.removeItem('adminToken')
  router.push('/admin')
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="goToDashboard" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <h1 class="text-xl font-bold">Priatelia</h1>
        </div>
        <Button variant="ghost" @click="logout" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
          Odhlásiť sa
        </Button>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-2xl font-bold text-foreground">Správa priateľov ({{ friends.length }})</h2>
        <Button @click="openModal()">
          + Pridať priateľa
        </Button>
      </div>

      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <Alert v-if="credentialSuccess" class="mb-4 border-green-500 bg-green-50 text-green-800">
        <AlertDescription>{{ credentialSuccess }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">
        Načítavam...
      </div>

      <div v-else-if="friends.length === 0" class="text-center py-12">
        <p class="text-muted-foreground mb-4">Zatiaľ žiadni priatelia</p>
        <Button @click="openModal()">
          Pridať prvého priateľa
        </Button>
      </div>

      <Card v-else>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <!-- Relabel "Meno" → "Meno a priezvisko" (11 §UC-FC-002) — the surface
                   IS the manual data-cleanup tool, there is no migration. -->
              <TableHead>Meno a priezvisko</TableHead>
              <TableHead>Poznámka</TableHead>
              <TableHead>Kontakt</TableHead>
              <TableHead class="text-right">Zostatok</TableHead>
              <TableHead class="text-center">Stav</TableHead>
              <TableHead class="text-center">Prihlásenie</TableHead>
              <TableHead class="text-center">Google</TableHead>
              <TableHead class="text-center">Káva</TableHead>
              <TableHead class="text-center">Pekáreň</TableHead>
              <TableHead class="text-right">Akcie</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="friend in friends" :key="friend.id">
              <TableCell class="text-muted-foreground font-mono text-sm">{{ friend.uid || '-' }}</TableCell>
              <TableCell class="font-medium">
                {{ friend.name }}
                <Badge
                  v-if="friend.onboarding_source"
                  variant="outline"
                  class="border-gray-400 text-gray-600 bg-gray-50 ml-2 text-xs"
                >
                  {{ friend.onboarding_source }}
                </Badge>
              </TableCell>
              <TableCell class="text-muted-foreground">{{ friend.display_name || '-' }}</TableCell>
              <!-- Kontakt (11 §UC-FC-002): a missing email blocks module 09's
                   magic-link recovery — the amber badge is the admin's visibility. -->
              <TableCell data-testid="contact-cell">
                <div class="flex flex-col items-start gap-1">
                  <span v-if="friend.email" class="text-sm">{{ friend.email }}</span>
                  <Badge
                    v-else
                    variant="outline"
                    class="border-amber-500 text-amber-700 bg-amber-50 text-xs"
                  >
                    Bez e-mailu
                  </Badge>
                  <span v-if="friend.phone" class="text-xs text-muted-foreground">{{ friend.phone }}</span>
                </div>
              </TableCell>
              <TableCell class="text-right">
                <BalanceBadge :balance="friend.balance || 0" />
              </TableCell>
              <TableCell class="text-center">
                <div class="flex items-center justify-center gap-4">
                  <Switch
                    :checked="!!friend.active"
                    @update:checked="toggleActive(friend)"
                  />
                  <Badge :variant="friend.active ? 'default' : 'secondary'">
                    {{ friend.active ? 'Aktívny' : 'Neaktívny' }}
                  </Badge>
                </div>
              </TableCell>
              <!-- Prihlásenie — three truthful states (11 §UC-FC-002, fixes 07
                   follow-up #3). The old `username || 'Nastavené'` green badge showed
                   a password-without-username friend as credentialed while they could
                   not log in under modern auth. -->
              <TableCell class="text-center" data-testid="login-cell">
                <div class="flex flex-col items-center gap-1">
                  <template v-if="credentialState(friend) === 'full'">
                    <Badge variant="outline" class="border-green-500 text-green-700 text-xs">
                      {{ friend.username }}
                    </Badge>
                    <span v-if="friend.must_change_password" class="text-xs text-amber-600">dočasné heslo</span>
                  </template>
                  <Badge
                    v-else-if="credentialState(friend) === 'partial'"
                    variant="outline"
                    class="border-amber-500 text-amber-700 text-xs"
                    :title="credentialMissingTitle(friend)"
                  >
                    Neúplné
                  </Badge>
                  <span v-else class="text-xs text-muted-foreground">-</span>
                </div>
              </TableCell>
              <!-- Google — read-only state (11 §UC-FC-002). "Not linked" and "column
                   not shipped" render identically as a muted '-' by design (graceful
                   pre-module-10 degradation; googleLinked comes from UC-FC-005). -->
              <TableCell class="text-center" data-testid="google-cell">
                <Badge v-if="friend.googleLinked" variant="outline" class="border-green-500 text-green-700 text-xs">
                  {{ friend.google_email || 'Prepojené' }}
                </Badge>
                <span v-else class="text-xs text-muted-foreground">-</span>
              </TableCell>
              <TableCell class="text-center">
                <input
                  type="checkbox"
                  :checked="!friend.subscriptions?.length || friend.subscriptions.includes('coffee')"
                  @change="toggleSubscription(friend, 'coffee')"
                  class="w-4 h-4 rounded border-gray-300 cursor-pointer"
                />
              </TableCell>
              <TableCell class="text-center">
                <input
                  type="checkbox"
                  :checked="!friend.subscriptions?.length || friend.subscriptions.includes('bakery')"
                  @change="toggleSubscription(friend, 'bakery')"
                  class="w-4 h-4 rounded border-gray-300 cursor-pointer"
                />
              </TableCell>
              <TableCell class="text-right">
                <div class="relative inline-block">
                  <Button variant="ghost" size="icon" class="h-8 w-8" @click="toggleMenu(friend.id)">
                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </Button>
                  <div
                    v-if="openMenuId === friend.id"
                    class="absolute right-0 top-full mt-1 z-50 bg-white border rounded-md shadow-lg py-1 min-w-[140px]"
                  >
                    <button
                      class="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                      @click="openModal(friend); closeMenu()"
                    >
                      Upraviť
                    </button>
                    <button
                      class="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                      @click="router.push(`/admin/friends/${friend.id}`); closeMenu()"
                    >
                      Detail
                    </button>
                    <button
                      class="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                      @click="openSetUsername(friend); closeMenu()"
                    >
                      Nastaviť username
                    </button>
                    <button
                      class="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                      @click="openResetPassword(friend); closeMenu()"
                    >
                      Resetovať heslo
                    </button>
                    <!-- UC-FC-006 — only for a linked friend. On a pre-module-10 DB
                         `googleLinked` is always false, so the item never renders. -->
                    <button
                      v-if="friend.googleLinked"
                      class="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                      @click="unlinkGoogle(friend); closeMenu()"
                    >
                      Odpojiť Google
                    </button>
                    <button
                      class="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-muted transition-colors"
                      @click="deleteFriend(friend.id); closeMenu()"
                    >
                      Vymazať
                    </button>
                  </div>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <Card class="mt-6">
        <CardContent class="p-4">
          <p class="text-sm text-muted-foreground">
            <strong>Tip:</strong> Aktívni priatelia sa zobrazujú vo výbere pri objednávaní vo všetkých cykloch.
            Neaktívnych priateľov môžete kedykoľvek znova aktivovať.
          </p>
        </CardContent>
      </Card>
    </main>

    <!-- Add/Edit Friend Modal -->
    <Dialog :open="showModal" @update:open="showModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ editingFriend ? 'Upraviť priateľa' : 'Nový priateľ' }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <Alert v-if="modalError" variant="destructive">
            <AlertDescription>{{ modalError }}</AlertDescription>
          </Alert>
          <div v-if="editingFriend?.uid" class="space-y-2">
            <Label class="text-muted-foreground">Jedinečné ID</Label>
            <div class="font-mono text-sm bg-muted px-3 py-2 rounded">{{ editingFriend.uid }}</div>
          </div>
          <!-- The 4 writable fields (11 §UC-FC-003); maxlength mirrors the server
               bounds in friends.js (120/200/32/160 — the GSO-T3 mirror convention).
               The modal contains NO credential inputs — a friend gets a login only
               via approval (07) or the per-row actions below. -->
          <div class="space-y-2">
            <Label>Meno a priezvisko *</Label>
            <Input
              v-model="friendName"
              maxlength="120"
              @keyup.enter="saveFriend"
            />
            <p class="text-xs text-muted-foreground">Celé meno. Vidí ho správca a kolegovia; na prihlásenie slúži užívateľské meno.</p>
          </div>
          <div class="space-y-2">
            <Label>Poznámka (voliteľné)</Label>
            <Input
              v-model="friendDisplayName"
              maxlength="200"
              placeholder="Napr. 'Ivet a Peto', interná poznámka"
              @keyup.enter="saveFriend"
            />
            <p class="text-xs text-muted-foreground">Interná poznámka pre admina (nezobrazuje sa priateľovi)</p>
          </div>
          <div class="space-y-2">
            <Label>Mobil</Label>
            <Input
              v-model="friendPhone"
              maxlength="32"
              placeholder="napr. +421 900 000 000"
              @keyup.enter="saveFriend"
            />
          </div>
          <div class="space-y-2">
            <Label>Email</Label>
            <Input
              v-model="friendEmail"
              type="email"
              maxlength="160"
              placeholder="napr. priatel@example.sk"
              @keyup.enter="saveFriend"
            />
            <p class="text-xs text-muted-foreground">Bez e-mailu sa priateľovi nedá poslať odkaz na obnovenie prístupu.</p>
          </div>
          <div v-if="editingFriend" class="space-y-1">
            <Label class="text-muted-foreground">Prihlásenie</Label>
            <div class="text-sm font-medium">{{ credentialLine(editingFriend) }}</div>
            <p class="text-xs text-muted-foreground">Spravuje sa cez akcie Nastaviť username / Resetovať heslo.</p>
          </div>
          <div v-if="editingFriend?.googleLinked" class="space-y-1">
            <Label class="text-muted-foreground">Google</Label>
            <div class="text-sm font-medium">{{ editingFriend.google_email || 'Prepojené' }}</div>
          </div>
          <div v-if="editingFriend?.onboarding_source" class="space-y-1">
            <Label class="text-muted-foreground">Pôvod onboardingu</Label>
            <div class="text-sm font-medium">{{ editingFriend.onboarding_source }}</div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showModal = false">
            Zrušiť
          </Button>
          <Button @click="saveFriend" :disabled="!friendName.trim()">
            {{ editingFriend ? 'Uložiť' : 'Pridať' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Reset Password Modal -->
    <Dialog :open="showResetPasswordModal" @update:open="showResetPasswordModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resetovať heslo — {{ credentialFriend?.name }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <Alert v-if="credentialError" variant="destructive">
            <AlertDescription>{{ credentialError }}</AlertDescription>
          </Alert>
          <div class="space-y-2">
            <Label>Nové heslo</Label>
            <Input
              v-model="resetPasswordValue"
              type="text"
              placeholder="Minimálne 8 znakov"
              :disabled="credentialSaving"
              @keyup.enter="resetPassword()"
            />
            <p class="text-xs text-muted-foreground">Heslo je zobrazené ako text pre jednoduchšie zdieľanie s priateľom.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showResetPasswordModal = false" :disabled="credentialSaving">Zrušiť</Button>
          <Button @click="resetPassword()" :disabled="credentialSaving || !resetPasswordValue">
            {{ credentialSaving ? 'Ukladám...' : 'Resetovať heslo' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Set Username Modal -->
    <Dialog :open="showSetUsernameModal" @update:open="showSetUsernameModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nastaviť username — {{ credentialFriend?.name }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <Alert v-if="credentialError" variant="destructive">
            <AlertDescription>{{ credentialError }}</AlertDescription>
          </Alert>
          <div class="space-y-2">
            <Label>Užívateľské meno</Label>
            <Input
              v-model="setUsernameValue"
              type="text"
              placeholder="napr. janko_hrasko"
              autocapitalize="none"
              autocorrect="off"
              :disabled="credentialSaving"
              @keyup.enter="setUsername()"
            />
            <p class="text-xs text-muted-foreground">Len malé písmená, čísla, bodka (.), podtržník (_) a pomlčka (-). Min. 3 znaky.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showSetUsernameModal = false" :disabled="credentialSaving">Zrušiť</Button>
          <Button @click="setUsername()" :disabled="credentialSaving || !setUsernameValue">
            {{ credentialSaving ? 'Ukladám...' : 'Uložiť username' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
