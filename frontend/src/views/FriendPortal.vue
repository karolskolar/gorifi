<script setup>
import { ref, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api, { setFriendsPassword, clearFriendsPassword, getFriendsPassword } from '../api'
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
    // Get friends list (public endpoint)
    friends.value = await api.getFriends(true) // active only

    // Check localStorage for saved auth
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        // Verify the friend still exists
        const friendExists = friends.value.find(f => f.id === parsed.friendId)
        if (friendExists && parsed.password) {
          savedAuth.value = parsed
          // Restore current friend data from friends list (has latest data)
          currentFriend.value = friendExists
          selectedFriendId.value = String(parsed.friendId)
          // Try to authenticate with saved password
          password.value = parsed.password
          await authenticate(true)
          return
        } else {
          // Friend no longer exists or no password saved, clear storage
          localStorage.removeItem(STORAGE_KEY)
          authState.value = 'login'
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY)
        authState.value = 'login'
      }
    } else {
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
    await api.authenticateFriends(password.value, selectedFriendId.value)

    // Set password for subsequent requests
    setFriendsPassword(password.value)

    // Get full friend data
    const selectedFriend = friends.value.find(f => f.id === parseInt(selectedFriendId.value))
    currentFriend.value = selectedFriend

    // Save to localStorage if remember me is checked
    if (rememberMe.value && selectedFriend) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        friendId: parseInt(selectedFriendId.value),
        friendName: selectedFriend.name,
        friendUid: selectedFriend.uid,
        password: password.value
      }))
      savedAuth.value = {
        friendId: parseInt(selectedFriendId.value),
        friendName: selectedFriend.name,
        friendUid: selectedFriend.uid
      }
    }

    // Load cycles
    await loadCycles()
    authState.value = 'authenticated'
  } catch (e) {
    if (!silent) {
      authError.value = e.message
    } else {
      // Silent auth failed, show login
      localStorage.removeItem(STORAGE_KEY)
      authState.value = 'login'
    }
  } finally {
    loading.value = false
  }
}

async function loadCycles() {
  cycles.value = await api.getFriendsCycles(selectedFriendId.value)
}

function switchUser() {
  // Clear auth state and go back to login
  clearFriendsPassword()
  localStorage.removeItem(STORAGE_KEY)
  savedAuth.value = null
  currentFriend.value = null
  selectedFriendId.value = ''
  password.value = ''
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

function formatKilos(kilos) {
  if (!kilos || kilos === 0) return '0 kg'
  return `${kilos.toFixed(2)} kg`
}

function formatProgress(submitted, total) {
  if (total === 0) return '-'
  const percent = Math.round((submitted / total) * 100)
  return `${submitted}/${total} priateľov (${percent}%)`
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
          <CardDescription>Vyberte svoje meno a zadajte heslo</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <Alert v-if="authError" variant="destructive">
            <AlertDescription>{{ authError }}</AlertDescription>
          </Alert>

          <div class="space-y-2">
            <Label>Vyberte svoje meno</Label>
            <Select v-model="selectedFriendId">
              <SelectTrigger>
                <SelectValue placeholder="-- Vyberte --" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="f in friends" :key="f.id" :value="String(f.id)">
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
        </CardContent>
      </Card>
    </div>

    <!-- Authenticated - Cycle List -->
    <div v-else-if="authState === 'authenticated'" class="max-w-4xl mx-auto px-4 py-6">
      <!-- Balance Card -->
      <FriendBalanceCard :friend-id="selectedFriendId" />

      <h2 class="text-xl font-semibold mb-4 text-foreground">Objednávkové cykly</h2>

      <div v-if="cycles.length === 0" class="text-center py-12 text-muted-foreground">
        Žiadne dostupné cykly
      </div>

      <div v-else class="space-y-3">
        <Card
          v-for="cycle in cycles"
          :key="cycle.id"
          class="cursor-pointer hover:shadow-md transition-shadow"
          @click="goToCycle(cycle.id)"
        >
          <CardContent class="p-4">
            <div class="flex justify-between items-start">
              <div class="flex-1">
                <h3 class="font-semibold text-foreground">{{ cycle.name }}</h3>
                <div class="flex items-center gap-2 mt-2">
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
                <div class="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                  <span>☕ {{ formatKilos(cycle.totalKilos) }}</span>
                  <span>•</span>
                  <span>{{ formatProgress(cycle.submittedOrders, cycle.totalFriends) }}</span>
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
          <div class="space-y-2">
            <Label>Prihlasovacie meno *</Label>
            <Input
              v-model="profileName"
              placeholder="Vaše prihlasovacie meno"
              :disabled="profileSaving"
            />
            <p class="text-xs text-muted-foreground">Toto meno sa zobrazuje pri prihlasovaní</p>
          </div>
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
  </div>
</template>
