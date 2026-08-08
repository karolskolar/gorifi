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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { fmtEur } from '@/lib/money'
import FriendBalanceCard from '@/components/FriendBalanceCard.vue'
import GuestShareDialog from '@/components/GuestShareDialog.vue'
import BrandChrome from '@/components/neo/BrandChrome.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoCheckbox from '@/components/neo/NeoCheckbox.vue'
import NeoModal from '@/components/neo/NeoModal.vue'

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
const profilePacketaAddress = ref('')
const profileSaving = ref(false)

// Archive
const showArchive = ref(false)

// Subscriptions
const subscriptions = ref([]) // ['coffee', 'bakery']
const showSubscriptionModal = ref(false)
const subCoffee = ref(true)
const subBakery = ref(true)
const subSaving = ref(false)

// Vouchers
const pendingVouchers = ref([])
const currentVoucher = ref(null)
const showVoucherModal = ref(false)
const voucherResolved = ref(null) // { action: 'accept'|'decline', amount, cycleName }
const resolvingVoucher = ref(false)

// Auth mode
const authMode = ref('legacy') // 'legacy' | 'transition' | 'modern'
const loginTab = ref('shared') // 'shared' | 'personal'

// Personal login fields
const loginUsername = ref('')
const loginPassword = ref('')
// Modern login only (UC-FL-002): the eye toggle flips the password input's
// `type` and nothing else — it never touches `loginPassword`.
const showLoginPassword = ref(false)

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

// Forced password change: admin reset this friend's password, so on login they
// must choose their own before continuing (non-dismissable). The current
// password is prefilled with the one they just logged in with.
const forcedPasswordChange = ref(false)
const forcedNewPassword = ref('')
const forcedNewPasswordConfirm = ref('')
const forcedError = ref('')
const forcedSaving = ref(false)

// Invite modal
const showInviteModal = ref(false)
const inviteCode = ref('')
const inviteLoading = ref(false)
const inviteCopied = ref(false)

// Guest share dialog — the cycle whose link is being shared (null = closed)
const shareCycle = ref(null)

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
    // Auth mode decides which login UI renders — fetch it on its own so a
    // failing friends-list call can never poison it back to the 'legacy'
    // default (that regression showed anonymous users an empty name dropdown).
    try {
      authMode.value = (await api.getAuthMode()).authMode
    } catch {
      // keep the 'legacy' default
    }

    // The name dropdown only exists in legacy/transition mode. Modern login
    // needs no list at all; failure is non-fatal.
    if (authMode.value !== 'modern') {
      try {
        friends.value = await api.getFriendsLoginList()
      } catch {
        friends.value = []
      }
    }

    // Set default login tab based on auth mode
    if (authMode.value === 'modern') {
      loginTab.value = 'personal'
    }

    // Check localStorage for saved auth
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)

        // Token-based restore. Expired tokens are dropped locally (no server
        // round-trip); old plaintext-password entries fall through to login.
        if (parsed.friendId && parsed.token && (!parsed.expiresAt || Date.now() < parsed.expiresAt)) {
          savedAuth.value = parsed
          currentFriend.value = { id: parsed.friendId, name: parsed.friendName, uid: parsed.friendUid }
          selectedFriendId.value = String(parsed.friendId)
          setFriendsToken(parsed.token)
          setFriendsAuthInfo({
            friendId: parsed.friendId,
            friendName: parsed.friendName,
            friendUid: parsed.friendUid
          })
          try {
            await loadCycles()
            await checkPendingVouchers()
            authState.value = 'authenticated'
            window.scrollTo(0, 0)
            hydrateCurrentFriend(parsed.friendId)
            return
          } catch {
            // Token expired or invalid, clear and show login
            localStorage.removeItem(STORAGE_KEY)
            clearFriendsPassword()
            authState.value = 'login'
          }
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
        currentFriend.value = { id: memoryAuthInfo.friendId, name: memoryAuthInfo.friendName, uid: memoryAuthInfo.friendUid }
        selectedFriendId.value = String(memoryAuthInfo.friendId)
        try {
          await loadCycles()
          await checkPendingVouchers()
          authState.value = 'authenticated'
          window.scrollTo(0, 0)
          hydrateCurrentFriend(memoryAuthInfo.friendId)
          return
        } catch {
          clearFriendsPassword()
          authState.value = 'login'
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

// Fill in the fields the login/restore payloads don't carry (packeta_address,
// username, hasCredentials, display_name) from the owner-scoped profile
// endpoint. Fire-and-forget: the portal works without it.
async function hydrateCurrentFriend(friendId) {
  try {
    const full = await api.getFriendProfile(friendId)
    currentFriend.value = { ...currentFriend.value, ...full }
  } catch {
    // non-fatal — keep the minimal object
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

    // Token-only auth: never store or replay the plaintext password (SEC-A1)
    if (result.token) {
      setFriendsToken(result.token)
    }

    // Full friend data comes from the auth response — the public login list
    // only carries id + name + hasCredentials.
    const listEntry = friends.value.find(f => f.id === parseInt(selectedFriendId.value))
    const friendData = { ...(listEntry || {}), ...(result.friend || {}), hasCredentials: result.hasCredentials }
    currentFriend.value = friendData

    // Set auth info in memory
    setFriendsAuthInfo({
      friendId: friendData.id,
      friendName: friendData.name,
      friendUid: friendData.uid
    })

    // Save to localStorage if remember me is checked (token + expiry only)
    if (rememberMe.value && result.token) {
      const storageData = {
        friendId: friendData.id,
        friendName: friendData.name,
        friendUid: friendData.uid,
        token: result.token,
        expiresAt: result.expiresAt,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storageData))
      savedAuth.value = storageData
    }

    // Load cycles
    await loadCycles()
    await checkPendingVouchers()
    authState.value = 'authenticated'
    window.scrollTo(0, 0)

    // In transition mode, prompt credential setup if user doesn't have personal credentials
    if (authMode.value === 'transition' && result.hasCredentials === false) {
      showCredentialSetup.value = true
    }

    // Admin reset this friend's password → force them to set a new one now.
    if (result.mustChangePassword) {
      changeCurrentPassword.value = password.value
      forcedPasswordChange.value = true
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

    // The auth response carries the friend data — no admin-only list fetch
    // here (GET /friends is requireAdmin and 401s for friends).
    currentFriend.value = { ...result.friend, hasCredentials: true }
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
        token: result.token,
        expiresAt: result.expiresAt
      }))
    }

    await loadCycles()
    await checkPendingVouchers()
    authState.value = 'authenticated'
    window.scrollTo(0, 0)

    // Admin reset this friend's password → force them to set a new one now.
    if (result.mustChangePassword) {
      changeCurrentPassword.value = loginPassword.value
      forcedPasswordChange.value = true
    }
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

async function checkPendingVouchers() {
  try {
    const friendId = selectedFriendId.value || getFriendsAuthInfo()?.friendId
    if (!friendId) return
    const vouchers = await api.getPendingVouchers(friendId)
    pendingVouchers.value = vouchers
    if (vouchers.length > 0) {
      currentVoucher.value = vouchers[0]
      showVoucherModal.value = true
    }
  } catch (e) {
    console.error('Voucher check failed:', e)
  }
}

async function resolveVoucher(action) {
  if (!currentVoucher.value || resolvingVoucher.value) return
  resolvingVoucher.value = true
  // A retry must not leave the previous attempt's banner standing (RD-FL-3).
  error.value = ''
  try {
    await api.resolveVoucher(currentVoucher.value.id, action)
    const amount = currentVoucher.value.voucher_amount
    const cycleName = currentVoucher.value.cycle_name
    voucherResolved.value = { action, amount, cycleName }

    pendingVouchers.value = pendingVouchers.value.filter(v => v.id !== currentVoucher.value.id)
    if (pendingVouchers.value.length > 0) {
      currentVoucher.value = pendingVouchers.value[0]
      voucherResolved.value = null
    } else {
      showVoucherModal.value = false
      currentVoucher.value = null
      setTimeout(() => { voucherResolved.value = null }, 5000)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    resolvingVoucher.value = false
  }
}

function switchUser() {
  // Clear auth state and go back to login.
  //
  // ⚠ `error` must go with it. `authenticate`/`authenticatePersonal` clear
  // `authError` and `saveCredentials` clears `setupError` — SIBLING refs;
  // `loadInitialData` is the only other writer that clears `error` itself, and
  // it returns early on a successful session restore (line ~178) without ever
  // reaching its own reset on the re-login path. So a failed profile/
  // subscription/invite/voucher write left `error` set, and the banner RD-FL-3
  // added would re-render it verbatim on the NEXT authenticated session — which
  // the legacy dropdown lets be a DIFFERENT person on a shared device. Before
  // the banner the stale ref was merely invisible; surfacing it is what makes
  // clearing it this row's job.
  //
  // The same reasoning covers two siblings found in the same review sweep, so
  // the rule this row establishes is the general one: SESSION-SCOPED DISPLAY
  // STATE DIES WITH THE SESSION.
  //  - `voucherResolved` names money ("Kredit 4.20 € pridaný") and its own
  //    5s timeout is set at resolve time, so without this it renders on the
  //    LOGIN screen for whoever logs in next.
  //  - `subscriptions` prefills the subscription modal. `loadCycles`'s
  //    subscription GET is a silent catch, so if the next friend's GET fails
  //    the modal prefills the PREVIOUS friend's preferences and "Uložiť"
  //    writes them onto the new friend — a cross-account write, not just a
  //    stale read.
  //  - `showArchive` (RD-FL-4) is the mildest case of the same rule and is reset
  //    for consistency, not for safety: it holds no data — `cycles` is cleared
  //    two lines down and refetched per friend — so at worst it carried one bit
  //    ("somebody expanded the archive") into the next session. But UC-FL-008
  //    pins the fold as DEFAULT-CLOSED, and a component instance that survives a
  //    logout is the only path on which the next session could open expanded.
  error.value = ''
  voucherResolved.value = null
  subscriptions.value = []
  showArchive.value = false
  clearFriendsPassword()
  localStorage.removeItem(STORAGE_KEY)
  savedAuth.value = null
  currentFriend.value = null
  selectedFriendId.value = ''
  password.value = ''
  loginUsername.value = ''
  loginPassword.value = ''
  inviteCode.value = ''
  authState.value = 'login'
  cycles.value = []
}

function goToCycle(cycleId) {
  router.push(`/cycle/${cycleId}`)
}

// ⚠ `getStatusVariant` / `getStatusText` / `formatPrice` were deleted with the
// shadcn cycle cards they served (RD-FL-4). The status labels are now literal in
// the badge row — the theme gives each status its OWN badge variant
// (`muted`/`acc`/plain), so a shared text helper would have had to be paired with
// a shared class helper anyway, and the prototype writes all three out. Money
// goes through `fmtEur` (UC-DS-012), which — unlike `formatPrice` — renders
// `0.00 EUR` instead of `-` and never emits `NaN EUR`.
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
  profilePacketaAddress.value = currentFriend.value?.packeta_address || ''
  showProfileModal.value = true
}

async function saveProfile() {
  if (!profileName.value.trim()) return

  profileSaving.value = true
  // A retry must not leave the previous attempt's banner standing (RD-FL-3).
  error.value = ''
  try {
    const friendId = selectedFriendId.value
    const updated = await api.updateFriendProfile(friendId, {
      name: profileName.value.trim(),
      packeta_address: profilePacketaAddress.value.trim() || null
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
  // A retry must not leave the previous attempt's banner standing (RD-FL-3).
  error.value = ''
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

  if (!setupPassword.value || setupPassword.value.length < 8) {
    setupError.value = 'Heslo musí mať aspoň 8 znakov'
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
      if (result.expiresAt) parsed.expiresAt = result.expiresAt
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

  if (!changeNewPassword.value || changeNewPassword.value.length < 8) {
    changePasswordError.value = 'Nové heslo musí mať aspoň 8 znakov'
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
        if (result.expiresAt) parsed.expiresAt = result.expiresAt
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

// Forced password change (after an admin reset). Non-dismissable: the friend
// must set their own password before using the app. The backend skips the
// current-password check when must_change_password is set, so we only collect
// the new password here.
async function submitForcedPasswordChange() {
  forcedError.value = ''
  if (!forcedNewPassword.value || forcedNewPassword.value.length < 8) {
    forcedError.value = 'Nové heslo musí mať aspoň 8 znakov'
    return
  }
  if (forcedNewPassword.value !== forcedNewPasswordConfirm.value) {
    forcedError.value = 'Heslá sa nezhodujú'
    return
  }

  forcedSaving.value = true
  try {
    const result = await api.changeFriendPassword(
      selectedFriendId.value,
      changeCurrentPassword.value,
      forcedNewPassword.value
    )
    if (result.token) {
      setFriendsToken(result.token)
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        parsed.token = result.token
        if (result.expiresAt) parsed.expiresAt = result.expiresAt
        delete parsed.password
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
      }
    }
    forcedNewPassword.value = ''
    forcedNewPasswordConfirm.value = ''
    changeCurrentPassword.value = ''
    forcedPasswordChange.value = false
  } catch (e) {
    forcedError.value = e.message
  } finally {
    forcedSaving.value = false
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

// The quantity that FOLDS INTO the "Objednané ·" badge (03 resolved conflict #6:
// the separate "☕ 0.25 kg" line is dropped). Bakery counts pieces, coffee counts
// weight — the same split the dropped line used, so nothing about WHICH number is
// shown changes, only where it renders.
function orderQuantityLabel(cycle) {
  if (cycle.type === 'bakery') return `${cycle.orderItemCount} ks`
  return formatKilos(cycle.orderKilos)
}

async function openInviteModal() {
  showInviteModal.value = true
  inviteCopied.value = false
  inviteLoading.value = true
  // A retry must not leave the previous attempt's banner standing (RD-FL-3).
  error.value = ''
  try {
    const friendId = getFriendsAuthInfo()?.friendId
    const data = await api.getMyInviteCode(friendId)
    inviteCode.value = data.inviteCode
  } catch (e) {
    error.value = e.message
  } finally {
    inviteLoading.value = false
  }
}

function getInviteUrl() {
  return `${window.location.origin}/invite/${inviteCode.value}`
}

// Guest share link straight from the cycle list, so the host does not have to
// open a cycle first. Same dialog (and logic) as FriendOrder.vue.
function openShareDialog(cycle) {
  shareCycle.value = cycle
}

async function copyInviteLink() {
  try {
    await navigator.clipboard.writeText(getInviteUrl())
    inviteCopied.value = true
    setTimeout(() => { inviteCopied.value = false }, 2000)
  } catch (e) {
    // Fallback for older browsers
    const input = document.createElement('input')
    input.value = getInviteUrl()
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    document.body.removeChild(input)
    inviteCopied.value = true
    setTimeout(() => { inviteCopied.value = false }, 2000)
  }
}
</script>

<template>
  <div class="app">
    <!-- Brand chrome (UC-FL-001): appbar + hazard tape + ticker, mounted in ALL
         three states as the first child of `.app`, full-bleed and NOT sticky
         (UC-DS-005/006). One instance — the state only swaps its slot contents
         and the ticker copy, so the chrome never remounts on login/logout.

         AUTHENTICATED APPBAR (UC-FL-004, row RD-FL-3): titles block → profile,
         pencil BETWEEN `.titles` and `.grow` via the `#after-titles` slot that
         RD-DS-5 added for exactly this, rotated "Pozvať" chip → invite, logout
         glyph → switchUser(). The tap targets are plain spans in the prototype;
         `.titles`, the chip and the logout glyph carry the house zero-pixel ARIA
         layer (role + tabindex + Enter/Space) so the bar is operable without a
         mouse — same enhancement as NeoCheckbox, NeoModal's `.m-x` and the login
         eye toggle. The chip's accessible name is its own visible text
         ("Pozvať"), never an aria-label that would contradict it.

         ⚠ The pencil is the ONE control that does NOT get that layer: it is
         `aria-hidden`, pointer-only. That enhancement exists for controls that
         are the ONLY route to their action (NeoCheckbox, `.m-x`, the eye
         toggle); the pencil is not one — it is an immediately-adjacent
         duplicate of `.titles`, same handler, and its name would have to be
         "Upraviť profil" too. Exposing it gave the bar two consecutive tab
         stops both announcing "Upraviť profil, button" — 50% redundancy on a
         four-control bar. UC-FL-004 asks for a span with `title` only, and
         `portal.jsx:101` is a bare span; keyboard users reach the action via
         `.titles`, and "tapping name or pencil opens the profile modal" still
         holds literally for pointer input. -->
    <BrandChrome
      :ticker="authState === 'authenticated'
        ? '+++ ČLENSKÝ OKRUH +++ PRE TÝCH, ČO VEDIA +++'
        : '+++ VSTUP LEN PRE SVOJICH +++ HESLO NEDÁVAJ ĎALEJ +++'"
      :titles-action="authState === 'authenticated' ? 'Upraviť profil' : ''"
      @titles-click="openProfileModal"
    >
      <template #titles>
        <template v-if="authState === 'authenticated'">
          <span class="t">{{ getCurrentFriendName() }}</span>
          <span class="s">{{ getCurrentFriendUid() }}</span>
        </template>
        <template v-else>
          <span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>
          <span class="s">Členský vstup</span>
        </template>
      </template>
      <template #after-titles>
        <span
          v-if="authState === 'authenticated'"
          data-testid="profile-pencil"
          aria-hidden="true"
          title="Upraviť profil"
          style="opacity:.75;display:flex;cursor:pointer"
          @click="openProfileModal"
        >
          <NeoIcon name="pencil" />
        </span>
      </template>
      <template #trailing>
        <template v-if="authState === 'authenticated'">
          <span
            class="chip acc"
            role="button"
            tabindex="0"
            title="Pozvi priateľa"
            style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"
            @click="openInviteModal"
            @keydown.enter.prevent="openInviteModal"
            @keydown.space.prevent="openInviteModal"
          ><NeoIcon name="invite" /> Pozvať</span>
          <span
            role="button"
            tabindex="0"
            aria-label="Odhlásiť sa"
            title="Odhlásiť sa"
            style="opacity:.85;display:flex;cursor:pointer"
            @click="switchUser"
            @keydown.enter.prevent="switchUser"
            @keydown.space.prevent="switchUser"
          >
            <NeoIcon name="logout" />
          </span>
        </template>
        <span v-else class="chip acc">Len pre svojich</span>
      </template>
    </BrandChrome>

    <!-- The voucher banner keeps its own (untouched) look per UC-FL-001, but it
         must sit on the SAME geometry as the page column below it — it used to
         be `max-w-4xl` (896px) against a 760px column, overhanging 68px a side
         at 1180px. Alignment only; nothing inside is restyled. -->
    <div v-if="voucherResolved && !showVoucherModal" class="mx-auto w-full max-w-[760px] px-4 sm:px-7 mt-4">
      <div v-if="voucherResolved.action === 'accept'" class="bg-green-900/30 border border-green-700/50 rounded-lg p-4 flex items-center gap-3">
        <span class="text-2xl">✅</span>
        <div>
          <div class="font-semibold text-green-400">Kredit {{ voucherResolved.amount.toFixed(2) }} € pridaný</div>
          <div class="text-sm text-muted-foreground">Bude odpočítaný z tvojej ďalšej objednávky</div>
        </div>
      </div>
      <div v-else class="bg-purple-900/20 border border-purple-700/30 rounded-lg p-4 flex items-center gap-3">
        <span class="text-2xl">💚</span>
        <div>
          <div class="font-semibold">Ďakujeme za podporu!</div>
          <div class="text-sm text-muted-foreground">Tvoj voucher {{ voucherResolved.amount.toFixed(2) }} € bol venovaný projektu</div>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && authState === 'loading'" class="sub" style="text-align:center;padding:48px 0">Načítavam...</div>

    <!-- Global Error -->
    <div v-else-if="error && authState === 'loading'" class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-12">
      <div class="banner danger">
        <span class="dot"></span>
        <div><strong>Chyba:</strong> {{ error }}</div>
      </div>
    </div>

    <!-- ==================================================================
         Modern login (UC-FL-002) — `auth_mode = 'modern'` only.
         Native elements + theme classes, no `ui/` components: this is the
         prototype's f-login screen, values transcribed from portal.jsx.
         The legacy/transition card below is deliberately untouched
         (UC-FL-003) — the two branches never overlap.
         ================================================================== -->
    <div
      v-else-if="authState === 'login' && authMode === 'modern'"
      class="mx-auto flex w-full max-w-[480px] flex-col gap-5 p-5 sm:p-8"
    >
      <div class="text-center mt-2 sm:mt-6">
        <!-- `h-screen` is the theme's DISPLAY-HEADING class inside `.app`, not
             Tailwind's height utility (UC-DS-001). It is correct here. -->
        <h1 class="h-screen text-[40px] sm:text-[52px]">Kto <span class="hl">klope?</span></h1>
        <div class="sub" style="margin-top:12px;font-size:14px">Prihláste sa užívateľským menom a heslom.</div>
      </div>

      <div class="card flex flex-col gap-4 p-[18px] sm:p-6">
        <!-- The prototype has no login-error state; `.banner danger slim`
             follows 02 §UC-DS-013's semantic grammar and keeps the card compact. -->
        <div v-if="authError" class="banner danger slim">
          <span class="dot"></span>
          <div>{{ authError }}</div>
        </div>

        <div>
          <label class="field-lbl" for="pp-login-username">Užívateľské meno</label>
          <input
            id="pp-login-username"
            v-model="loginUsername"
            class="inp"
            type="text"
            placeholder="napr. lego"
            autocapitalize="none"
            autocorrect="off"
            autocomplete="username"
          />
        </div>

        <div>
          <label class="field-lbl" for="pp-login-password">Heslo</label>
          <div style="position:relative">
            <input
              id="pp-login-password"
              v-model="loginPassword"
              class="inp"
              :type="showLoginPassword ? 'text' : 'password'"
              placeholder="Zadajte heslo"
              style="padding-right:48px"
              autocomplete="current-password"
              @keyup.enter="authenticatePersonal()"
            />
            <!-- Bare span + @click per the prototype: NOT a <button>, so it can
                 never act as a submit control. The role/tabindex/aria layer
                 renders no pixel and is the same permitted enhancement
                 NeoCheckbox and NeoModal's × already make. -->
            <span
              role="button"
              tabindex="0"
              :aria-label="showLoginPassword ? 'Skryť heslo' : 'Zobraziť heslo'"
              :aria-pressed="showLoginPassword ? 'true' : 'false'"
              :style="{
                position: 'absolute',
                right: '14px',
                top: '50%',
                transform: 'translateY(-50%)',
                cursor: 'pointer',
                color: showLoginPassword ? 'var(--accent)' : 'var(--ink-dim)',
                display: 'flex'
              }"
              @click="showLoginPassword = !showLoginPassword"
              @keydown.enter.prevent="showLoginPassword = !showLoginPassword"
              @keydown.space.prevent="showLoginPassword = !showLoginPassword"
            >
              <NeoIcon name="eye" />
            </span>
          </div>
        </div>

        <!-- A `<label>` only forwards clicks to labelable elements, and
             NeoCheckbox is a `span[role=checkbox]` — so nothing here toggles by
             itself. The row declares `cursor:pointer` across its full width, so
             all three zones must honour it, each by a different mechanism and
             each exactly once:
               · the box   → NeoCheckbox's own handler;
               · the text  → the `@click` on the span;
               · the 10px  → `@click.self` on the label, which fires ONLY when
                 gap       the label itself is the event target. Without `.self`
                           the label would also catch the two clicks above and
                           double-toggle them back to their previous state. -->
        <label
          style="display:flex;align-items:center;gap:10px;font-size:14px;cursor:pointer"
          @click.self="rememberMe = !rememberMe"
        >
          <NeoCheckbox v-model="rememberMe" aria-label="Zapamätať si ma na tomto zariadení" />
          <span @click="rememberMe = !rememberMe">Zapamätať si ma na tomto zariadení</span>
        </label>

        <button
          class="btn accent block"
          :disabled="loading || !loginUsername || !loginPassword"
          @click="authenticatePersonal()"
        >
          {{ loading ? 'Overujem...' : 'Prihlásiť sa' }}
        </button>
      </div>

      <div
        class="card dashed"
        style="padding:14px;font-size:13.5px;color:var(--ink-dim);display:flex;gap:10px;align-items:flex-start"
      >
        <span style="display:flex;margin-top:1px"><NeoIcon name="lock" /></span>
        <span>Nemáte účet? Podpultovka je na pozvánky — požiadajte kamoša, ktorý už objednáva, alebo si objednajte cez jeho odkaz bez účtu.</span>
      </div>
    </div>

    <!-- Login Form -->
    <div v-else-if="authState === 'login'" class="max-w-md mx-auto px-4 py-8">
      <!-- Coffee cup image -->
      <div class="flex justify-center mb-6">
        <img
          src="/coffee-cup.png"
          alt="Coffee Cup"
          class="h-48 object-contain"
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
    <!-- Standard page column (UC-DS-005): 760px max, centered, 16px phone /
         28px desktop side padding. Contents are restyled by RD-FL-3/4/5. -->
    <div v-else-if="authState === 'authenticated'" class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-6">
      <!-- ⚠ The authenticated error surface (RD-FL-1 residual). `error` has four
           writers that ALL run while authenticated — resolveVoucher, saveProfile,
           saveSubscriptions and openInviteModal — yet the only branch rendering
           it was keyed on `authState === 'loading'`, which is unreachable (the
           outer catch in loadInitialData sets `error` and `authState = 'login'`
           in the same breath). A failed profile save, subscription save, invite
           fetch or voucher resolve was therefore SILENT. This banner is that
           missing surface.

           Lifecycle: each of the four writers now clears `error` before it runs,
           so a successful retry removes a stale message rather than leaving it
           contradicting the screen; `switchUser` clears it too, so a message
           never outlives its session; and the × is the escape hatch for the case
           where the user simply abandons the action (e.g. closes the invite
           modal).

           ⚠ When UC-FL-009/011 move the profile/subscription/invite messages
           INTO their modals (RD-FL-6/7), this banner is left with `resolveVoucher`
           as its only writer — and that is the ONE writer it cannot actually
           serve. The voucher modal is a hand-rolled `fixed inset-0 z-50
           bg-black/70` scrim with NO dismiss control, and `resolveVoucher`
           leaves `showVoucherModal` true on failure, so the banner renders
           underneath it (verified at 378px: `elementFromPoint` over the banner
           returns the scrim) and is only reachable once a retry succeeds — which
           clears it. Pre-existing and silent before RD-FL-3, not a regression of
           it. So RD-FL-6/7 must NOT read this as "the banner survives for
           vouchers": whichever row next touches the voucher modal owns giving it
           its own in-modal error surface, and this banner may then be retired
           with the last writer that can reach it. -->
      <div v-if="error" class="banner danger mb-5" role="alert">
        <span class="dot"></span>
        <div style="min-width:0"><strong>Chyba:</strong> {{ error }}</div>
        <button
          type="button"
          class="btn ghost sm"
          aria-label="Zavrieť upozornenie"
          style="margin-left:auto;flex-shrink:0"
          @click="error = ''"
        >
          <NeoIcon name="close" />
        </button>
      </div>

      <!-- Balance Card -->
      <FriendBalanceCard :friend-id="selectedFriendId" />

      <!-- Section header (UC-FL-006).

           ⚠ PINNED: `<h2>` with the accessible name "Objednávkové cykly" —
           FIVE e2e specs locate it with `getByRole('heading', { name:
           'Objednávkové cykly' })`. The name concatenates across the `.hl`
           span, so the highlight costs nothing; the space before the span is
           load-bearing. `h-screen` is the theme's DISPLAY-HEADING class inside
           `.app` (UC-DS-001), not Tailwind's height utility — it is blocklisted
           as a Tailwind candidate in `tailwind.config.js` for exactly this. -->
      <div class="flex justify-between items-center" style="margin-bottom:14px">
        <h2 class="h-screen text-[28px] sm:text-[34px]">Objednávkové <span class="hl">cykly</span></h2>
        <!-- The gear is the ONLY route to the subscription modal, so it takes
             the house zero-pixel ARIA layer (role + tabindex + Enter/Space) —
             the same enhancement NeoCheckbox, NeoModal's `.m-x` and the login
             eye toggle make, and the same rule that kept it OFF the appbar
             pencil (which merely duplicates `.titles`). The prototype's bare
             span would be unreachable without a mouse. -->
        <span
          role="button"
          tabindex="0"
          aria-label="Nastavenia odberu"
          title="Nastavenia odberu"
          style="color:var(--ink-dim);cursor:pointer;display:flex"
          @click="openSubscriptionModal"
          @keydown.enter.prevent="openSubscriptionModal"
          @keydown.space.prevent="openSubscriptionModal"
        >
          <NeoIcon name="gear" />
        </span>
      </div>

      <div v-if="cycles.length === 0" class="sub" style="text-align:center;padding:48px 0">
        Žiadne dostupné cykly
      </div>

      <template v-else>
        <!-- Active cycles — `status !== 'completed'`, so PLANNED, OPEN and
             LOCKED all render here, in the order the API returns them. -->
        <div v-if="activeCycles.length === 0" class="sub" style="text-align:center;padding:32px 0">
          Žiadne aktívne cykly
        </div>
        <div v-else style="display:flex;flex-direction:column;gap:16px">
          <!-- ⚠ PINNED: the card root is a `div` carrying the LITERAL class
               `p-4` (= the prototype's 16px padding). `guest-link.spec.js`'s
               `cardFor()` is
                 page.locator('div.p-4', { has: getByRole('heading', { name, exact: true }) })
               so this element must hold BOTH the `<h3>` cycle name and the
               share button. Consequences that must survive future edits:
                 · nothing else in this view may carry `p-4` while containing a
                   cycle-name heading — notably the page column above, which is
                   deliberately `px-4 sm:px-7 py-6` and NOT `p-4`, or the
                   locator would match column AND card and trip strict mode;
                 · `p-4` is a Tailwind utility here, not theme CSS. `.card`
                   itself declares no padding, so it is also the real padding.

               `.card.hl` (open only) is the white card with the 6px magenta
               shadow; planned cards are inert per UC-FL-006. -->
          <div
            v-for="cycle in activeCycles"
            :key="cycle.id"
            class="card p-4"
            :class="{ hl: cycle.status === 'open' }"
            :style="{
              cursor: cycle.status === 'planned' ? 'default' : 'pointer',
              opacity: cycle.status === 'planned' ? 0.85 : 1
            }"
            @click="cycle.status !== 'planned' && goToCycle(cycle.id)"
          >
            <!-- Header row: name + date on the left, order total + chevron on
                 the right (non-planned only — a planned cycle leads nowhere and
                 has no order). -->
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
              <div style="min-width:0">
                <!-- ⚠ PINNED: an `<h3>` whose text content is EXACTLY the cycle
                     name — no nested spans, no icon, no whitespace-bearing
                     children. `guest-link.spec.js` matches it with
                     `{ exact: true }`, and `mobile-no-h-overflow.spec.js:73`
                     clicks the name text to navigate (the card-level click).
                     `.display` uppercases via CSS only, so `textContent` and the
                     accessible name are untouched. -->
                <h3 class="display" style="font-size:22px;line-height:1;overflow-wrap:anywhere">{{ cycle.name }}</h3>
                <div
                  v-if="cycle.expected_date"
                  class="mono sub"
                  style="font-size:12px;margin-top:7px;display:flex;align-items:center;gap:6px"
                >
                  <NeoIcon name="cal" /> {{ cycle.expected_date }}
                </div>
              </div>
              <div
                v-if="cycle.status !== 'planned'"
                style="display:flex;align-items:center;gap:8px;flex-shrink:0"
              >
                <!-- `orderTotal` ALREADY includes the delivery fee (the backend
                     sums `total + delivery_fee`) — never re-add it here. -->
                <span v-if="cycle.hasOrder" class="display" style="font-size:18px">{{ fmtEur(cycle.orderTotal) }}</span>
                <span style="color:var(--accent);display:flex"><NeoIcon name="chev" /></span>
              </div>
            </div>

            <!-- Plan block — the admin's multiline `plan_note`, one line per row
                 via `white-space:pre-line` (the prototype renders an array).
                 ⚠ `overflow-wrap:anywhere` is REQUIRED, not cosmetic, and does a
                 different job from `pre-line`: pre-line keeps one line per row
                 but will not break a long unbreakable token. `plan_note` is free
                 admin text, so a pasted Google Docs/Sheets URL is the obvious
                 real case — without this the whole DOCUMENT scrolled sideways on
                 a phone (531px against a 320px viewport). Neither `.card` nor the
                 page column clips, so the wrap has to happen here. UC-DS-005:
                 minimum supported width 320px with zero horizontal overflow. -->
            <div
              v-if="cycle.plan_note"
              class="mono"
              style="font-size:12px;color:var(--ink-faint);margin-top:10px;line-height:1.7;white-space:pre-line;overflow-wrap:anywhere"
            >{{ cycle.plan_note }}</div>

            <!-- Badge row: type × status × order.
                 ⚠ resolved conflict #1 — NO delivery-method badge (Packeta /
                 pickup) on the portal card any more; it lives on the order
                 screen (module 04) only.
                 ⚠ resolved conflict #6 — the ordered quantity FOLDS INTO the ok
                 badge ("Objednané · 0.25 kg" / "Objednané · 3 ks"); the separate
                 "☕ 0.25 kg" line is dropped.
                 A locked cycle without an order gets NO third badge. -->
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">
              <span class="badge" :class="cycle.type === 'bakery' ? 'acc-o' : 'solid'">{{ getCycleTypeLabel(cycle.type) }}</span>
              <span v-if="cycle.status === 'planned'" class="badge muted">Plánovaný</span>
              <span v-else-if="cycle.status === 'open'" class="badge acc">Otvorený</span>
              <span v-else class="badge">Uzamknutý</span>
              <span v-if="cycle.hasOrder" class="badge ok">Objednané · {{ orderQuantityLabel(cycle) }}</span>
              <span v-else-if="cycle.status === 'open'" class="badge warn">Neobjednané</span>
            </div>

            <!-- ⚠ SEAM — RD-FL-5 replaces exactly this element with UC-FL-007's
                 share ROW: the `border-top: 2px solid rgba(10,10,10,0.12)` /
                 `padding-top:12px; margin-top:12px` bar carrying the colleague
                 count on the left ("N kolegovia cez váš odkaz" /
                 "Objednávate aj pre kolegov?") and a `button.btn.sm` with the
                 share glyph, visible text "Zdieľať" and
                 `aria-label="Zdieľať s kolegami"` on the right.

                 It ships here as the UNCHANGED shadcn button rather than being
                 removed, because `guest-link.spec.js` — which this row may not
                 edit — asserts the button's accessible name INSIDE `div.p-4`,
                 that a locked card has none, and that the click does not
                 navigate. Dropping it would take the suite below baseline and
                 leave the `p-4` pin unverifiable. So: same behaviour, same
                 accessible name, transitional look (UC-DS-002), placed as the
                 card's LAST child directly under the badge row — which is
                 exactly where the designed row goes. -->
            <Button
              v-if="cycle.status === 'open'"
              variant="ghost"
              size="sm"
              class="h-7 px-2 -ml-2 mt-3 gap-1.5 text-muted-foreground hover:text-foreground"
              @click.stop="openShareDialog(cycle)"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342A3 3 0 106.316 10.658m0 2.684l8.632 4.316m-8.632-7l8.632-4.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
              <span class="text-xs">Zdieľať s kolegami</span>
            </Button>
          </div>
        </div>

        <!-- Archive fold (UC-FL-008). Plain UI state: not persisted, not in the
             URL, default closed — and cleared by `switchUser` so the next
             session on a shared device also opens closed. -->
        <div v-if="archivedCycles.length > 0">
          <!-- `.chev.open` is the theme's own rotate-90 + accent transition, so
               the rotation and the colour come from one class, not from
               Tailwind. Keyboard layer as on the gear: this toggle is the only
               route to the archived cycles. -->
          <div
            role="button"
            tabindex="0"
            :aria-expanded="showArchive ? 'true' : 'false'"
            data-testid="archive-toggle"
            style="display:flex;align-items:center;gap:8px;margin-top:18px;cursor:pointer;font-weight:600;font-size:14px;color:var(--ink-dim)"
            @click="showArchive = !showArchive"
            @keydown.enter.prevent="showArchive = !showArchive"
            @keydown.space.prevent="showArchive = !showArchive"
          >
            <span class="chev" :class="{ open: showArchive }"><NeoIcon name="chev" /></span>
            <span>Archív ({{ archivedCycles.length }})</span>
          </div>

          <div v-if="showArchive" style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
            <!-- Flat 2px-border rows. ⚠ resolved conflict #4: the prototype's
                 archive rows are inert, the repo navigates — repo is canonical
                 for behaviour, so they keep calling `goToCycle`.
                 The name is a plain bold div, NOT a heading: `guest-link.spec.js`
                 matches cycle cards by `div.p-4` + heading, and an archived row
                 must never be able to answer that locator. -->
            <div
              v-for="cycle in archivedCycles"
              :key="cycle.id"
              class="card flat"
              style="padding:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;opacity:.85;cursor:pointer"
              @click="goToCycle(cycle.id)"
            >
              <div style="min-width:0">
                <div style="font-weight:700;font-size:15px;overflow-wrap:anywhere">{{ cycle.name }}</div>
                <div style="display:flex;gap:6px;margin-top:7px;flex-wrap:wrap">
                  <span class="badge" style="font-size:10.5px;padding:2px 7px">{{ getCycleTypeLabel(cycle.type) }}</span>
                  <span class="badge muted" style="font-size:10.5px;padding:2px 7px">Dokončený</span>
                </div>
              </div>
              <span
                v-if="cycle.hasOrder"
                class="mono"
                style="font-size:13px;flex-shrink:0"
              >{{ fmtEur(cycle.orderTotal) }}</span>
            </div>
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
          <div class="space-y-2">
            <Label>Adresa Packeta výdajného miesta</Label>
            <Input
              v-model="profilePacketaAddress"
              placeholder="napr. Z-BOX Hlavná 15, Bratislava"
              :disabled="profileSaving"
            />
            <p class="text-xs text-muted-foreground">Adresa výdajného miesta pre doručenie Packetou (voliteľné)</p>
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

    <!-- Forced password change (UC-FL-012) — non-dismissable gate.
         `closable: false` kills ×, scrim-close and Esc (UC-DS-010), and with
         `trapFocus` deriving from it, Tab cannot walk out into the page behind
         the scrim either — which is what makes it a gate rather than a
         suggestion. `data-testid` falls through onto `.modal` (attrs are bound
         first there, so `role="dialog"` stays ours). -->
    <NeoModal
      v-if="forcedPasswordChange"
      data-testid="forced-password-change"
      title="Nastavte si nové heslo"
      :closable="false"
    >
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="sub">
          Administrátor vám resetoval heslo. Pred pokračovaním si prosím nastavte vlastné nové heslo.
        </div>

        <div v-if="forcedError" class="banner danger slim">
          <span class="dot"></span>
          <div>{{ forcedError }}</div>
        </div>

        <div>
          <label class="field-lbl" for="pp-forced-new-password">Nové heslo</label>
          <input
            id="pp-forced-new-password"
            v-model="forcedNewPassword"
            class="inp"
            type="password"
            :disabled="forcedSaving"
          />
        </div>
        <div>
          <label class="field-lbl" for="pp-forced-new-password-confirm">Potvrdiť nové heslo</label>
          <input
            id="pp-forced-new-password-confirm"
            v-model="forcedNewPasswordConfirm"
            class="inp"
            type="password"
            :disabled="forcedSaving"
            @keyup.enter="submitForcedPasswordChange()"
          />
        </div>
      </div>
      <template #footer>
        <button
          class="btn accent block"
          :disabled="forcedSaving || !forcedNewPassword || !forcedNewPasswordConfirm"
          @click="submitForcedPasswordChange()"
        >
          {{ forcedSaving ? 'Ukladám...' : 'Nastaviť heslo a pokračovať' }}
        </button>
      </template>
    </NeoModal>

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

    <!-- Invite modal -->
    <Dialog :open="showInviteModal" @update:open="showInviteModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pozvi priateľa</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <p class="text-sm text-muted-foreground">
            Pošli tento odkaz priateľovi. Po registrácii ho admin pridá do skupiny.
          </p>
          <div v-if="inviteLoading" class="text-center py-4 text-muted-foreground">
            Načítavam...
          </div>
          <div v-else-if="inviteCode" class="space-y-3">
            <div class="flex items-center gap-2">
              <Input :model-value="getInviteUrl()" readonly class="font-mono text-sm" />
              <Button @click="copyInviteLink" variant="outline" size="sm" class="shrink-0">
                {{ inviteCopied ? 'Skopírované!' : 'Kopírovať' }}
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showInviteModal = false">Zavrieť</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Share with colleagues (guest link) — shared with FriendOrder -->
    <GuestShareDialog
      :open="!!shareCycle"
      :cycle-id="shareCycle?.id"
      :cycle-name="shareCycle?.name || ''"
      @update:open="val => !val && (shareCycle = null)"
    />

    <!-- Voucher modal — markup deliberately untouched (out of scope, 00-overview).
         It only needs the teleport: `.app>*{position:relative;z-index:1}`
         (UC-DS-001) wins the specificity tie against Tailwind's `.fixed`/`.z-50`
         because friends-theme.css is imported last, so a hand-rolled fixed
         overlay left as a DIRECT child of `.app` collapses into page flow.
         `<Teleport to="body">` is the same escape NeoModal documents; this
         subtree uses no theme tokens, so it renders exactly as before. -->
    <Teleport to="body">
    <div v-if="showVoucherModal && currentVoucher" class="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div class="bg-card rounded-2xl p-7 max-w-sm w-full shadow-2xl">
        <div class="text-center mb-5">
          <div class="text-4xl mb-2">🎁</div>
          <div class="text-xl font-bold mb-1.5">Máš voucher!</div>
          <div class="text-sm text-muted-foreground">
            Za tvoju objednávku z cyklu <span class="font-semibold text-foreground">{{ currentVoucher.cycle_name }}</span> ti patrí zľavový voucher.
          </div>
        </div>
        <div class="bg-muted rounded-xl p-4 text-center mb-5">
          <div class="text-sm text-muted-foreground mb-1">
            Hodnota voucheru je {{ Math.round(currentVoucher.supplier_discount - currentVoucher.applied_discount) }}% z tvojej objednávky
          </div>
          <div class="text-3xl font-bold text-green-400">{{ currentVoucher.voucher_amount.toFixed(2) }} €</div>
        </div>
        <div class="flex flex-col gap-2.5">
          <button
            @click="resolveVoucher('accept')"
            :disabled="resolvingVoucher"
            class="w-full bg-green-500 hover:bg-green-600 text-green-950 font-semibold py-3.5 rounded-xl transition-colors disabled:opacity-50"
          >
            {{ resolvingVoucher ? 'Spracovávam...' : 'Použiť ako kredit na ďalšiu objednávku' }}
          </button>
          <button
            @click="resolveVoucher('decline')"
            :disabled="resolvingVoucher"
            class="w-full border border-border text-muted-foreground hover:text-foreground py-3.5 rounded-xl transition-colors disabled:opacity-50"
          >
            Nepotrebujem — podporím projekt 💚
          </button>
        </div>
        <div class="text-center mt-3.5 text-xs text-muted-foreground/50">
          Toto rozhodnutie je jednorazové a nedá sa zmeniť.
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>
