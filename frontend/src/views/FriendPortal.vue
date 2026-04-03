<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api, { setFriendsPassword, clearFriendsPassword, getFriendsPassword, setFriendsAuthInfo, getFriendsAuthInfo, setFriendsToken, getFriendsToken } from '../api'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import FriendBalanceCard from '@/components/FriendBalanceCard.vue'

const router = useRouter()

// Auth state
const authState = ref('loading') // 'loading' | 'login' | 'authenticated'
const savedAuth = ref(null) // { friendId, friendName } from localStorage

// Data
const friends = ref([])
const cycles = ref([])
const currentFriend = ref(null) // full friend object with uid, name, display_name

// Form state
const selectedFriendId = ref('')
const password = ref('')
const rememberMe = ref(true)

// UI state
const loading = ref(true)
const error = ref('')
const authError = ref('')

// Profile editing
const showProfileModal = ref(false)
const profileName = ref('')
const profileSaving = ref(false)

// Archive
const showArchive = ref(false)

// Subscriptions
const subscriptions = ref([]) // ['coffee', 'bakery']
const showSubscriptionModal = ref(false)
const subCoffee = ref(true)
const subBakery = ref(true)
const subSaving = ref(false)

// Auth mode
const authMode = ref('legacy') // 'legacy' | 'transition' | 'modern'
const loginTab = ref('shared') // 'shared' | 'personal'

// Personal login fields
const loginUsername = ref('')
const loginPassword = ref('')

// Credential setup modal
const showCredentialSetup = ref(false)
const setupUsername = ref('')
const setupPassword = ref('')
const setupPasswordConfirm = ref('')
const setupError = ref('')
const setupSaving = ref(false)
const usernameAvailable = ref(null) // null = not checked, true/false
const usernameChecking = ref(false)
let usernameCheckTimeout = null

// Password change
const showPasswordChange = ref(false)
const changeCurrentPassword = ref('')
const changeNewPassword = ref('')
const changeNewPasswordConfirm = ref('')
const changePasswordError = ref('')
const changePasswordSaving = ref(false)
const changePasswordSuccess = ref('')

const STORAGE_KEY = 'gorifi_friend_auth'

onMounted(async () => {
  await loadInitialData()
})

// Set page title
watchEffect(() => {
  document.title = 'Gorifi - Objednávky'
})

async function loadInitialData() {
  loading.value = true
  authState.value = 'loading'
  error.value = ''

  try {
    // Fetch auth mode and friends list in parallel
    const [modeResult, friendsList] = await Promise.all([
      api.getAuthMode(),
      api.getFriends(true)
    ])
    authMode.value = modeResult.authMode
    friends.value = friendsList

    // Set default login tab based on auth mode
    if (authMode.value === 'modern') {
      loginTab.value = 'personal'
    }

    // Check localStorage for saved auth
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const friendExists = friends.value.find(f => f.id === parsed.friendId)

        // Token-based restore (new format)
        if (friendExists && parsed.token) {
          savedAuth.value = parsed
          currentFriend.value = friendExists
          selectedFriendId.value = String(parsed.friendId)
          setFriendsToken(parsed.token)
          setFriendsAuthInfo({
            friendId: parsed.friendId,
            friendName: parsed.friendName,
            friendUid: parsed.friendUid
          })
          try {
            await loadCycles()
            authState.value = 'authenticated'
    window.scrollTo(0, 0)
            return
          } catch {
            // Token expired or invalid, clear and show login
            localStorage.removeItem(STORAGE_KEY)
            clearFriendsPassword()
            authState.value = 'login'
          }
        }
        // Password-based restore (old format, backward compat)
        else if (friendExists && parsed.password) {
          savedAuth.value = parsed
          currentFriend.value = friendExists
          selectedFriendId.value = String(parsed.friendId)
          password.value = parsed.password
          await authenticate(true)
          return
        } else {
          localStorage.removeItem(STORAGE_KEY)
          authState.value = 'login'
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY)
        authState.value = 'login'
      }
    } else {
      // Check for in-memory auth (when "remember me" was not checked)
      const memoryToken = getFriendsToken()
      const memoryPassword = getFriendsPassword()
      const memoryAuthInfo = getFriendsAuthInfo()
      if ((memoryToken || memoryPassword) && memoryAuthInfo) {
        const friendExists = friends.value.find(f => f.id === memoryAuthInfo.friendId)
        if (friendExists) {
          currentFriend.value = friendExists
          selectedFriendId.value = String(memoryAuthInfo.friendId)
          try {
            await loadCycles()
            authState.value = 'authenticated'
    window.scrollTo(0, 0)
            return
          } catch {
            clearFriendsPassword()
            authState.value = 'login'
          }
        }
      }
      authState.value = 'login'
    }
  } catch (e) {
    error.value = e.message
    authState.value = 'login'
  } finally {
    loading.value = false
  }
}

async function authenticate(silent = false) {
  if (!selectedFriendId.value || !password.value) {
    if (!silent) authError.value = 'Vyberte meno a zadajte heslo'
    return
  }

  authError.value = ''
  if (!silent) loading.value = true

  try {
    // Validate password with server
    const result = await api.authenticateFriends(password.value, selectedFriendId.value)

    // Set token for subsequent requests (new system)
    if (result.token) {
      setFriendsToken(result.token)
    }
    // Also set password as fallback
    setFriendsPassword(password.value)

    // Get full friend data
    const selectedFriend = friends.value.find(f => f.id === parseInt(selectedFriendId.value))
    currentFriend.value = selectedFriend

    // Set auth info in memory
    setFriendsAuthInfo({
      friendId: parseInt(selectedFriendId.value),
      friendName: selectedFriend.name,
      friendUid: selectedFriend.uid
    })

    // Save to localStorage if remember me is checked
    if (rememberMe.value && selectedFriend) {
      const storageData = {
        friendId: parseInt(selectedFriendId.value),
        friendName: selectedFriend.name,
        friendUid: selectedFriend.uid,
      }
      // Save token if available, otherwise password (backward compat)
      if (result.token) {
        storageData.token = result.token
      } else {
        storageData.password = password.value
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storageData))
      savedAuth.value = storageData
    }

    // Load cycles
    await loadCycles()
    authState.value = 'authenticated'
    window.scrollTo(0, 0)

    // In transition mode, prompt credential setup if user doesn't have personal credentials
    if (authMode.value === 'transition' && result.hasCredentials === false) {
      showCredentialSetup.value = true
    }
  } catch (e) {
    if (!silent) {
      authError.value = e.message
    } else {
      // Silent auth failed, show login
      localStorage.removeItem(STORAGE_KEY)
      clearFriendsPassword()
      authState.value = 'login'
    }
  } finally {
    loading.value = false
  }
}

async function authenticatePersonal() {
  if (!loginUsername.value || !loginPassword.value) {
    authError.value = 'Zadajte užívateľské meno a heslo'
    return
  }

  authError.value = ''
  loading.value = true

  try {
    const result = await api.authenticateFriendsPersonal(loginUsername.value.toLowerCase(), loginPassword.value)

    // Set token for subsequent requests
    setFriendsToken(result.token)

    // Refresh friends list to find full friend data
    friends.value = await api.getFriends(true)
    const friend = friends.value.find(f => f.id === result.friend.id)
    currentFriend.value = friend || result.friend
    selectedFriendId.value = String(result.friend.id)

    setFriendsAuthInfo({
      friendId: result.friend.id,
      friendName: result.friend.name,
      friendUid: result.friend.uid
    })

    if (rememberMe.value) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        friendId: result.friend.id,
        friendName: result.friend.name,
        friendUid: result.friend.uid,
        token: result.token
      }))
    }

    await loadCycles()
    authState.value = 'authenticated'
    window.scrollTo(0, 0)
  } catch (e) {
    authError.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadCycles() {
  cycles.value = await api.getFriendsCycles(selectedFriendId.value)
  // Load subscriptions
  try {
    const subs = await api.getSubscriptions(selectedFriendId.value)
    subscriptions.value = subs.types || []
  } catch (e) {
    // Non-critical
  }
}

function switchUser() {
  // Clear auth state and go back to login
  clearFriendsPassword()
  localStorage.removeItem(STORAGE_KEY)
  savedAuth.value = null
  currentFriend.value = null
  selectedFriendId.value = ''
  password.value = ''
  loginUsername.value = ''
  loginPassword.value = ''
  authState.value = 'login'
  cycles.value = []
}

function goToCycle(cycleId) {
  router.push(`/cycle/${cycleId}`)
}

function getStatusVariant(status) {
  switch (status) {
    case 'open': return 'default'
    case 'locked': return 'secondary'
    case 'completed': return 'outline'
    default: return 'outline'
  }
}

function getStatusText(status) {
  switch (status) {
    case 'open': return 'Otvorený'
    case 'locked': return 'Uzamknutý'
    case 'completed': return 'Dokončený'
    default: return status
  }
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

function getCurrentFriendName() {
  // Show login name (display_name is admin-only)
  return currentFriend.value?.name || savedAuth.value?.friendName || ''
}

function getCurrentFriendLoginName() {
  return currentFriend.value?.name || savedAuth.value?.friendName || ''
}

function getCurrentFriendUid() {
  return currentFriend.value?.uid || savedAuth.value?.friendUid || ''
}

function openProfileModal() {
  profileName.value = currentFriend.value?.name || savedAuth.value?.friendName || ''
  showProfileModal.value = true
}

async function saveProfile() {
  if (!profileName.value.trim()) return

  profileSaving.value = true
  try {
    const friendId = selectedFriendId.value
    const updated = await api.updateFriendProfile(friendId, {
      name: profileName.value.trim()
    })

    // Update local state
    currentFriend.value = { ...currentFriend.value, ...updated }

    // Update friends list
    const idx = friends.value.findIndex(f => f.id === parseInt(friendId))
    if (idx >= 0) {
      friends.value[idx] = { ...friends.value[idx], ...updated }
    }

    // Update localStorage
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      parsed.friendName = updated.name
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
    }

    showProfileModal.value = false
  } catch (e) {
    error.value = e.message
  } finally {
    profileSaving.value = false
  }
}

function openSubscriptionModal() {
  subCoffee.value = subscriptions.value.length === 0 || subscriptions.value.includes('coffee')
  subBakery.value = subscriptions.value.length === 0 || subscriptions.value.includes('bakery')
  showSubscriptionModal.value = true
}

async function saveSubscriptions() {
  subSaving.value = true
  try {
    const types = []
    if (subCoffee.value) types.push('coffee')
    if (subBakery.value) types.push('bakery')
    await api.updateSubscriptions(selectedFriendId.value, types)
    subscriptions.value = types
    showSubscriptionModal.value = false
    // Reload cycles with new filter
    await loadCycles()
  } catch (e) {
    error.value = e.message
  } finally {
    subSaving.value = false
  }
}

// Username validation with debounce
function checkUsernameAvailability() {
  usernameAvailable.value = null
  if (usernameCheckTimeout) clearTimeout(usernameCheckTimeout)

  const username = setupUsername.value.toLowerCase()
  if (!username || username.length < 3 || !/^[a-z0-9._-]+$/.test(username)) {
    return
  }

  usernameChecking.value = true
  usernameCheckTimeout = setTimeout(async () => {
    try {
      const result = await api.checkUsername(username)
      usernameAvailable.value = result.available
    } catch {
      usernameAvailable.value = null
    } finally {
      usernameChecking.value = false
    }
  }, 400)
}

async function saveCredentials() {
  setupError.value = ''

  const username = setupUsername.value.toLowerCase().trim()
  if (!username || username.length < 3 || !/^[a-z0-9._-]+$/.test(username)) {
    setupError.value = 'Užívateľské meno musí mať aspoň 3 znaky a obsahovať len malé písmená, čísla, _ a -'
    return
  }

  if (!setupPassword.value || setupPassword.value.length < 4) {
    setupError.value = 'Heslo musí mať aspoň 4 znaky'
    return
  }

  if (setupPassword.value !== setupPasswordConfirm.value) {
    setupError.value = 'Heslá sa nezhodujú'
    return
  }

  setupSaving.value = true
  try {
    const result = await api.setupCredentials(selectedFriendId.value, username, setupPassword.value)

    // Update token
    if (result.token) {
      setFriendsToken(result.token)
    }

    // Update local state
    if (result.friend) {
      currentFriend.value = { ...currentFriend.value, ...result.friend }
    }

    // Update localStorage with new token
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (result.token) parsed.token = result.token
      delete parsed.password // Remove old password
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
    }

    showCredentialSetup.value = false
    // Reset form
    setupUsername.value = ''
    setupPassword.value = ''
    setupPasswordConfirm.value = ''
  } catch (e) {
    setupError.value = e.message
  } finally {
    setupSaving.value = false
  }
}

async function changePassword() {
  changePasswordError.value = ''
  changePasswordSuccess.value = ''

  if (!changeCurrentPassword.value) {
    changePasswordError.value = 'Zadajte aktuálne heslo'
    return
  }

  if (!changeNewPassword.value || changeNewPassword.value.length < 4) {
    changePasswordError.value = 'Nové heslo musí mať aspoň 4 znaky'
    return
  }

  if (changeNewPassword.value !== changeNewPasswordConfirm.value) {
    changePasswordError.value = 'Nové heslá sa nezhodujú'
    return
  }

  changePasswordSaving.value = true
  try {
    const result = await api.changeFriendPassword(selectedFriendId.value, changeCurrentPassword.value, changeNewPassword.value)

    // Update token
    if (result.token) {
      setFriendsToken(result.token)
      // Update localStorage
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        parsed.token = result.token
        delete parsed.password
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
      }
    }

    changePasswordSuccess.value = 'Heslo bolo úspešne zmenené'
    changeCurrentPassword.value = ''
    changeNewPassword.value = ''
    changeNewPasswordConfirm.value = ''
    // Auto-hide success after 3s
    setTimeout(() => { changePasswordSuccess.value = '' }, 3000)
  } catch (e) {
    changePasswordError.value = e.message
  } finally {
    changePasswordSaving.value = false
  }
}

// Computed: friends to show in dropdown (exclude those with credentials in transition mode)
const dropdownFriends = computed(() => {
  if (authMode.value === 'transition') {
    return friends.value.filter(f => !f.hasCredentials)
  }
  return friends.value
})

const activeCycles = computed(() => cycles.value.filter(c => c.status !== 'completed'))
const archivedCycles = computed(() => cycles.value.filter(c => c.status === 'completed'))

function getCycleTypeLabel(type) {
  if (type === 'bakery') return 'Pekáreň'
  return 'Káva'
}

function formatKilos(kilos) {
  if (!kilos || kilos === 0) return '0 kg'
  return `${kilos.toFixed(2)} kg`
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow sticky top-0 z-40">
      <div class="max-w-4xl mx-auto px-4 py-3 flex justify-between items-center">
        <div v-if="authState === 'authenticated'" class="flex items-center gap-3">
          <div class="flex flex-col">
            <span class="text-lg font-semibold">{{ getCurrentFriendName() }}</span>
            <span class="text-primary-foreground/70 text-xs font-mono">{{ getCurrentFriendUid() }}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            @click="openProfileModal"
            class="text-primary-foreground/50 hover:text-primary-foreground hover:bg-primary-foreground/10"
            title="Upraviť profil"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </Button>
        </div>
        <div v-else class="flex-1 flex justify-center">
          <img
            src="https://www.goriffee.com/wp-content/uploads/2024/02/01-GORIFFEE-Logo-RGB-400x110.png"
            alt="Goriffee"
            class="h-10 object-contain"
          />
        </div>
        <Button
          v-if="authState === 'authenticated'"
          variant="ghost"
          @click="switchUser"
          class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
        >
          Zmeniť používateľa
        </Button>
      </div>
    </header>

    <!-- Loading -->
    <div v-if="loading && authState === 'loading'" class="text-center py-12 text-muted-foreground">Načítavam...</div>

    <!-- Global Error -->
    <div v-else-if="error && authState === 'loading'" class="max-w-4xl mx-auto px-4 py-12">
      <Alert variant="destructive">
        <AlertDescription>
          <strong>Chyba:</strong> {{ error }}
        </AlertDescription>
      </Alert>
    </div>

    <!-- Login Form -->
    <div v-else-if="authState === 'login'" class="max-w-md mx-auto px-4 py-8">
      <!-- Three friends image -->
      <div class="flex justify-center mb-6">
        <img
          src="https://www.goriffee.com/wp-content/uploads/2025/01/goriffee_three_friends-1.png"
          alt="Goriffee Friends"
          class="h-32 object-contain"
        />
      </div>
      <Card>
        <CardHeader class="text-center">
          <CardTitle>Prihlásenie</CardTitle>
          <CardDescription v-if="authMode === 'modern'">Prihláste sa užívateľským menom a heslom</CardDescription>
          <CardDescription v-else>Vyberte svoje meno a zadajte heslo</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <Alert v-if="authError" variant="destructive">
            <AlertDescription>{{ authError }}</AlertDescription>
          </Alert>

          <!-- Tab switcher (only in transition mode) -->
          <div v-if="authMode === 'transition'" class="flex rounded-lg border p-1 gap-1">
            <button
              @click="loginTab = 'shared'; authError = ''"
              class="flex-1 px-3 py-1.5 text-sm rounded-md transition-colors"
              :class="loginTab === 'shared' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
            >
              Spoločné heslo
            </button>
            <button
              @click="loginTab = 'personal'; authError = ''"
              class="flex-1 px-3 py-1.5 text-sm rounded-md transition-colors"
              :class="loginTab === 'personal' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
            >
              Osobné prihlásenie
            </button>
          </div>

          <!-- Shared password login (legacy + transition shared tab) -->
          <template v-if="authMode !== 'modern' && loginTab === 'shared'">
            <div class="space-y-2">
              <Label>Vyberte svoje meno</Label>
              <Select v-model="selectedFriendId">
                <SelectTrigger>
                  <SelectValue placeholder="-- Vyberte --" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="f in dropdownFriends" :key="f.id" :value="String(f.id)">
                    {{ f.name }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-2">
              <Label>Heslo</Label>
              <Input
                v-model="password"
                type="password"
                placeholder="Zadajte heslo"
                @keyup.enter="authenticate()"
              />
            </div>

            <label class="flex items-center gap-2 cursor-pointer">
              <input v-model="rememberMe" type="checkbox" class="rounded border-input" />
              <span class="text-sm text-muted-foreground">Zapamätať si ma na tomto zariadení</span>
            </label>

            <Button
              @click="authenticate()"
              :disabled="loading || !selectedFriendId || !password"
              class="w-full"
            >
              {{ loading ? 'Overujem...' : 'Prihlásiť sa' }}
            </Button>
          </template>

          <!-- Personal login (transition personal tab + modern) -->
          <template v-if="authMode === 'modern' || loginTab === 'personal'">
            <div class="space-y-2">
              <Label>Užívateľské meno</Label>
              <Input
                v-model="loginUsername"
                type="text"
                placeholder="Zadajte užívateľské meno"
                autocomplete="username"
                autocapitalize="none"
                autocorrect="off"
              />
            </div>

            <div class="space-y-2">
              <Label>Heslo</Label>
              <Input
                v-model="loginPassword"
                type="password"
                placeholder="Zadajte heslo"
                autocomplete="current-password"
                @keyup.enter="authenticatePersonal()"
              />
            </div>

            <label class="flex items-center gap-2 cursor-pointer">
              <input v-model="rememberMe" type="checkbox" class="rounded border-input" />
              <span class="text-sm text-muted-foreground">Zapamätať si ma na tomto zariadení</span>
            </label>

            <Button
              @click="authenticatePersonal()"
              :disabled="loading || !loginUsername || !loginPassword"
              class="w-full"
            >
              {{ loading ? 'Overujem...' : 'Prihlásiť sa' }}
            </Button>
          </template>
        </CardContent>
      </Card>
    </div>

    <!-- Authenticated - Cycle List -->
    <div v-else-if="authState === 'authenticated'" class="max-w-4xl mx-auto px-4 py-6">
      <!-- Balance Card -->
      <FriendBalanceCard :friend-id="selectedFriendId" />

      <div class="flex justify-between items-center mb-4">
        <h2 class="text-xl font-semibold text-foreground">Objednávkové cykly</h2>
        <Button
          variant="ghost"
          size="icon"
          @click="openSubscriptionModal"
          title="Nastavenia odberu"
          class="text-muted-foreground hover:text-foreground"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </Button>
      </div>

      <div v-if="cycles.length === 0" class="text-center py-12 text-muted-foreground">
        Žiadne dostupné cykly
      </div>

      <template v-else>
        <!-- Active cycles -->
        <div v-if="activeCycles.length === 0" class="text-center py-8 text-muted-foreground">
          Žiadne aktívne cykly
        </div>
        <div v-else class="space-y-3">
          <Card
            v-for="cycle in activeCycles"
            :key="cycle.id"
            class="cursor-pointer hover:shadow-md transition-shadow"
            :class="cycle.type === 'bakery' ? 'bg-orange-50/70 border-orange-200' : 'bg-gray-50 border-gray-200'"
            @click="goToCycle(cycle.id)"
          >
            <CardContent class="p-4">
              <div class="flex justify-between items-start">
                <div class="flex-1">
                  <h3 class="font-semibold text-foreground">{{ cycle.name }}</h3>
                  <div v-if="cycle.expected_date" class="text-sm text-primary mt-1">
                    📅 {{ cycle.expected_date }}
                  </div>
                  <div class="flex items-center gap-2 mt-2">
                    <Badge v-if="cycle.type === 'bakery'" variant="outline" class="border-orange-400 text-orange-600 bg-orange-50">
                      Pekáreň
                    </Badge>
                    <Badge v-else variant="outline" class="border-amber-700 text-amber-800 bg-amber-100">
                      Káva
                    </Badge>
                    <Badge :variant="getStatusVariant(cycle.status)">
                      {{ getStatusText(cycle.status) }}
                    </Badge>
                    <Badge v-if="cycle.hasOrder" variant="outline" class="border-green-500 text-green-700">
                      Objednané
                    </Badge>
                    <Badge v-else-if="cycle.status === 'open'" variant="outline" class="border-yellow-500 text-yellow-700">
                      Neobjednané
                    </Badge>
                  </div>
                  <div v-if="cycle.hasOrder" class="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                    <span v-if="cycle.type === 'bakery'">🥐 {{ cycle.orderItemCount }} ks</span>
                    <span v-else>☕ {{ formatKilos(cycle.orderKilos) }}</span>
                  </div>
                </div>
                <div class="text-right">
                  <span v-if="cycle.hasOrder" class="text-sm font-medium text-foreground">
                    {{ formatPrice(cycle.orderTotal) }}
                  </span>
                  <svg class="w-5 h-5 text-muted-foreground mt-2 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <!-- Archived cycles -->
        <div v-if="archivedCycles.length > 0" class="mt-6">
          <button
            @click="showArchive = !showArchive"
            class="flex items-center gap-2 w-full text-left py-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg
              class="w-4 h-4 transition-transform"
              :class="showArchive ? 'rotate-90' : ''"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            <span class="text-sm font-medium">Archív ({{ archivedCycles.length }})</span>
          </button>

          <div v-if="showArchive" class="space-y-3 mt-3">
            <Card
              v-for="cycle in archivedCycles"
              :key="cycle.id"
              class="cursor-pointer hover:shadow-md transition-shadow opacity-75"
              :class="cycle.type === 'bakery' ? 'bg-orange-50/70 border-orange-200' : 'bg-gray-50 border-gray-200'"
              @click="goToCycle(cycle.id)"
            >
              <CardContent class="p-4">
                <div class="flex justify-between items-start">
                  <div class="flex-1">
                    <h3 class="font-semibold text-foreground">{{ cycle.name }}</h3>
                    <div v-if="cycle.expected_date" class="text-sm text-primary mt-1">
                      📅 {{ cycle.expected_date }}
                    </div>
                    <div class="flex items-center gap-2 mt-2">
                      <Badge v-if="cycle.type === 'bakery'" variant="outline" class="border-orange-400 text-orange-600 bg-orange-50">
                        Pekáreň
                      </Badge>
                      <Badge v-else variant="outline" class="border-amber-700 text-amber-800 bg-amber-100">
                        Káva
                      </Badge>
                      <Badge :variant="getStatusVariant(cycle.status)">
                        {{ getStatusText(cycle.status) }}
                      </Badge>
                      <Badge v-if="cycle.hasOrder" variant="outline" class="border-green-500 text-green-700">
                        Objednané
                      </Badge>
                    </div>
                    <div v-if="cycle.hasOrder" class="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                      <span v-if="cycle.type === 'bakery'">🥐 {{ cycle.orderItemCount }} ks</span>
                      <span v-else>☕ {{ formatKilos(cycle.orderKilos) }}</span>
                    </div>
                  </div>
                  <div class="text-right">
                    <span v-if="cycle.hasOrder" class="text-sm font-medium text-foreground">
                      {{ formatPrice(cycle.orderTotal) }}
                    </span>
                    <svg class="w-5 h-5 text-muted-foreground mt-2 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </template>
    </div>

    <!-- Subscription Modal -->
    <Dialog :open="showSubscriptionModal" @update:open="showSubscriptionModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nastavenia odberu</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <p class="text-sm text-muted-foreground">Vyberte, ktoré typy objednávok chcete vidieť:</p>
          <label class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/50">
            <input v-model="subCoffee" type="checkbox" class="rounded" />
            <span class="font-medium">Káva</span>
          </label>
          <label class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/50">
            <input v-model="subBakery" type="checkbox" class="rounded" />
            <span class="font-medium">Pekáreň</span>
          </label>
          <p class="text-xs text-muted-foreground">Ak nevyberiete nič, budú sa zobrazovať všetky cykly.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showSubscriptionModal = false" :disabled="subSaving">
            Zrušiť
          </Button>
          <Button @click="saveSubscriptions" :disabled="subSaving">
            {{ subSaving ? 'Ukladám...' : 'Uložiť' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Profile Edit Modal -->
    <Dialog :open="showProfileModal" @update:open="showProfileModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upraviť profil</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <div class="space-y-2">
            <Label class="text-muted-foreground">Jedinečné ID</Label>
            <div class="font-mono text-sm bg-muted px-3 py-2 rounded">{{ getCurrentFriendUid() }}</div>
            <p class="text-xs text-muted-foreground">Toto ID sa nedá zmeniť</p>
          </div>
          <div v-if="currentFriend?.username" class="space-y-2">
            <Label class="text-muted-foreground">Užívateľské meno</Label>
            <div class="font-mono text-sm bg-muted px-3 py-2 rounded">{{ currentFriend.username }}</div>
          </div>
          <div class="space-y-2">
            <Label>Prihlasovacie meno *</Label>
            <Input
              v-model="profileName"
              placeholder="Vaše prihlasovacie meno"
              :disabled="profileSaving"
            />
            <p class="text-xs text-muted-foreground">Toto meno sa zobrazuje pri prihlasovaní</p>
          </div>

          <!-- Password change section (only if user has credentials) -->
          <template v-if="currentFriend?.hasCredentials">
            <div class="border-t pt-4 mt-4">
              <button
                @click="showPasswordChange = !showPasswordChange"
                class="text-sm font-medium text-primary hover:underline"
              >
                {{ showPasswordChange ? 'Skryť zmenu hesla' : 'Zmeniť heslo' }}
              </button>
            </div>

            <template v-if="showPasswordChange">
              <Alert v-if="changePasswordError" variant="destructive">
                <AlertDescription>{{ changePasswordError }}</AlertDescription>
              </Alert>
              <Alert v-if="changePasswordSuccess" class="border-green-200 bg-green-50">
                <AlertDescription class="text-green-700">{{ changePasswordSuccess }}</AlertDescription>
              </Alert>

              <div class="space-y-2">
                <Label>Aktuálne heslo</Label>
                <Input v-model="changeCurrentPassword" type="password" :disabled="changePasswordSaving" />
              </div>
              <div class="space-y-2">
                <Label>Nové heslo</Label>
                <Input v-model="changeNewPassword" type="password" :disabled="changePasswordSaving" />
              </div>
              <div class="space-y-2">
                <Label>Potvrdiť nové heslo</Label>
                <Input
                  v-model="changeNewPasswordConfirm"
                  type="password"
                  :disabled="changePasswordSaving"
                  @keyup.enter="changePassword()"
                />
              </div>
              <Button
                @click="changePassword()"
                :disabled="changePasswordSaving || !changeCurrentPassword || !changeNewPassword || !changeNewPasswordConfirm"
                size="sm"
              >
                {{ changePasswordSaving ? 'Mením heslo...' : 'Zmeniť heslo' }}
              </Button>
            </template>
          </template>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showProfileModal = false" :disabled="profileSaving">
            Zrušiť
          </Button>
          <Button @click="saveProfile" :disabled="!profileName.trim() || profileSaving">
            {{ profileSaving ? 'Ukladám...' : 'Uložiť' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Credential Setup Modal -->
    <Dialog :open="showCredentialSetup" @update:open="showCredentialSetup = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nastavte si osobné prihlásenie</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <p class="text-sm text-muted-foreground">
            Nastavte si vlastné užívateľské meno a heslo pre bezpečnejšie prihlasovanie.
          </p>

          <Alert v-if="setupError" variant="destructive">
            <AlertDescription>{{ setupError }}</AlertDescription>
          </Alert>

          <div class="space-y-2">
            <Label>Užívateľské meno</Label>
            <Input
              v-model="setupUsername"
              type="text"
              placeholder="napr. janko_hrasko"
              autocapitalize="none"
              autocorrect="off"
              :disabled="setupSaving"
              @input="checkUsernameAvailability"
            />
            <p v-if="usernameChecking" class="text-xs text-muted-foreground">Overujem dostupnosť...</p>
            <p v-else-if="usernameAvailable === true" class="text-xs text-green-600">Užívateľské meno je voľné</p>
            <p v-else-if="usernameAvailable === false" class="text-xs text-red-600">Toto meno je už obsadené</p>
            <p class="text-xs text-muted-foreground">Len malé písmená, čísla, bodka (.), podtržník (_) a pomlčka (-). Min. 3 znaky.</p>
          </div>

          <div class="space-y-2">
            <Label>Heslo</Label>
            <Input
              v-model="setupPassword"
              type="password"
              placeholder="Minimálne 4 znaky"
              :disabled="setupSaving"
            />
          </div>

          <div class="space-y-2">
            <Label>Potvrdiť heslo</Label>
            <Input
              v-model="setupPasswordConfirm"
              type="password"
              placeholder="Zopakujte heslo"
              :disabled="setupSaving"
              @keyup.enter="saveCredentials()"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showCredentialSetup = false" :disabled="setupSaving">
            Neskôr
          </Button>
          <Button
            @click="saveCredentials()"
            :disabled="setupSaving || !setupUsername || !setupPassword || !setupPasswordConfirm || usernameAvailable === false"
          >
            {{ setupSaving ? 'Ukladám...' : 'Nastaviť' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
