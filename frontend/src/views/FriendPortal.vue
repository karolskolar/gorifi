<script setup>
// =============================================================================
// The ANONYMOUS surface + the auth handshake (03 §UC-FL-001..003, UC-FL-012's
// trigger). Everything that only exists WHILE a friend is signed in lives in
// `FriendPortalSession.vue` and is destroyed with them — see the header there
// for why (RD-FL-8a item 1).
//
// ⚠ THE RULE THIS FILE NOW OBEYS: the parent owns the AUTH HANDSHAKE — identity,
// token, localStorage, auth mode, the login forms. That state exists before the
// session view and outlives it by design, and clearing it IS the act of logging
// out rather than a clean-up someone can forget. Everything DERIVED from a
// session — fetched domain data, form state, display flags, in-flight flags —
// belongs in the child, where the unmount clears it with no list to maintain.
//
// If you are adding a ref here, check it against that line first. Six rows in a
// row added one to the wrong side.
// =============================================================================

import { ref, computed, onMounted, watchEffect } from 'vue'
import api, { clearFriendsPassword, getFriendsPassword, setFriendsAuthInfo, getFriendsAuthInfo, setFriendsToken, getFriendsToken } from '../api'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import BrandChrome from '@/components/neo/BrandChrome.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoCheckbox from '@/components/neo/NeoCheckbox.vue'
import FriendPortalSession from './FriendPortalSession.vue'

// --- Auth state -------------------------------------------------------------
const authState = ref('loading') // 'loading' | 'login' | 'authenticated'
// The restored localStorage payload. It is the identity FALLBACK the appbar and
// the profile prefill use when a session was restored from a token and the full
// friend row has not been hydrated yet.
const savedAuth = ref(null) // { friendId, friendName, friendUid, token, expiresAt }
// The full friend row, rendered by the appbar in this file and handed to the
// session view. Parent-owned because the appbar is ONE instance across all three
// auth states (UC-FL-001) and must not remount on login/logout.
const currentFriend = ref(null)

// The legacy/transition login dropdown. Anonymous data, fetched once at mount —
// not session state.
const friends = ref([])

// --- Login form -------------------------------------------------------------
const selectedFriendId = ref('')
const password = ref('')
const rememberMe = ref(true)
const authError = ref('')
const loginTab = ref('shared') // 'shared' | 'personal'
const loginUsername = ref('')
const loginPassword = ref('')
// Modern login only (UC-FL-002): the eye toggle flips the password input's
// `type` and nothing else — it never touches `loginPassword`.
//
// ⚠ Still reset explicitly in `switchUser`, and it must be: it belongs to the
// LOGIN screen, which is this component, so no unmount clears it. Left set it
// renders the NEXT person's own password in cleartext with no action by them
// (RD-FL-6). Same for the three credential fields above it.
const showLoginPassword = ref(false)

// --- Page state -------------------------------------------------------------
const loading = ref(true)
// ⚠ Initial-load failure only. Its sole writer is `loadInitialData`'s outer
// catch. The AUTHENTICATED page banner is a different ref, owned by the session
// view, so a message can no longer outlive the session that produced it.
const error = ref('')

// Server auth mode — configuration, not session state.
const authMode = ref('legacy') // 'legacy' | 'transition' | 'modern'

// ⚠ WHAT THE HANDSHAKE PRODUCED, handed to the session view once at mount:
//   · `cycles`  — the payload of `GET /friends/cycles`, which is ALSO the
//     request that decides whether the token is good (see `beginSession`). The
//     session view seeds its list from it, so a login stays at ONE cycles
//     request rather than two.
//   · `subscriptions` — the type filter behind that list, awaited in the
//     handshake for the same reason it always was: the gear must not be
//     openable before it has landed, or the modal prefills "everything".
//   · `mustChangePassword` + `currentPassword` — UC-FL-012's gate and the
//     plaintext password the friend just logged in with. The password stays on
//     THIS side of the boundary because it is a login credential — the two form
//     refs above already hold it — and the session view reads it at submit time
//     without copying it into a ref of its own.
//   · `needsCredentialSetup` — transition mode, `hasCredentials === false`.
//
// ⚠ This is the one session-shaped ref the child's `:key`/unmount cannot cover,
// because it is produced BEFORE the child exists. `switchUser` clears it with
// the token and the identity, which is the same act.
const entry = ref(null)

// ⚠ The session view's `:key`. It keys the HANDSHAKE, not the identity, and the
// difference is not cosmetic.
//
// `entry` is seeded into the child ONCE, at `setup()` — `cycles`,
// `subscriptions`, `needsCredentialSetup`, `mustChangePassword` — and nothing
// re-seeds it afterwards. Keying on `selectedFriendId` would therefore fire at
// the wrong moment: `authenticatePersonal` writes `selectedFriendId` and only
// THEN awaits `beginSession()`, so Vue flushes the key change at that first
// await, while `entry` still holds the PREVIOUS friend's payload. In the exact
// scenario the key exists to insure against — a friend switch that never leaves
// `authState === 'authenticated'` — friend B would mount against friend A's
// cycle list, keep it permanently, and fire `loadGuestCounts` over A's cycle ids
// with B's token. The key would protect the refs and leak the payload.
//
// Bumped inside `beginSession()` immediately before `entry.value` is written, so
// it fires exactly when a FRESH payload is ready and never before. It also
// covers the same friend re-authenticating, which an identity key cannot.
const sessionSeq = ref(0)

const STORAGE_KEY = 'gorifi_friend_auth'

// The session view, for the two appbar controls that act on it.
const session = ref(null)

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
            await beginSession()
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
          await beginSession()
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

/**
 * The single entry point into an authenticated session, shared by both restore
 * paths and both login paths.
 *
 * ⚠ The `GET /friends/cycles` here is the SESSION PROBE, not a convenience: it
 * is the call whose failure means the token is no good, and every caller relies
 * on that — the restore paths fall back to the login screen in their `catch`,
 * and the login paths surface it as `authError`. It THROWS on purpose. Its
 * payload is exactly what the session view needs first, so it is handed over in
 * `entry` rather than re-requested, which keeps a login at one cycles request.
 *
 * `authState` flips only after it resolves, so the authenticated shell never
 * flashes on an expired token — the behaviour this file has always had.
 */
async function beginSession({ mustChangePassword = false, currentPassword = '', needsCredentialSetup = false } = {}) {
  const cycles = await api.getFriendsCycles(selectedFriendId.value)

  // ⚠ Fetched HERE rather than on the child's mount, and the ordering is the
  // point: it is what decides which cycles the list is allowed to show, so the
  // subscription modal must never be openable before it has landed. Awaiting it
  // in the handshake is also exactly what the pre-extraction `loadCycles()` did
  // — same two sequential requests, same "resolved before the authenticated
  // paint" guarantee. Failure is non-fatal (it only prefills a modal) and must
  // never take the session down with it.
  let subscriptions = []
  try {
    subscriptions = (await api.getSubscriptions(selectedFriendId.value)).types || []
  } catch {
    // non-critical
  }

  // ⚠ Bumped HERE, one statement before the payload it keys. Every fresh
  // handshake re-creates the session view; see `sessionSeq`'s declaration.
  sessionSeq.value++
  entry.value = { cycles, subscriptions, mustChangePassword, currentPassword, needsCredentialSetup }
  authState.value = 'authenticated'
  window.scrollTo(0, 0)
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

    await beginSession({
      // In transition mode, prompt credential setup if the friend has no
      // personal credentials yet.
      needsCredentialSetup: authMode.value === 'transition' && result.hasCredentials === false,
      // Admin reset this friend's password → force them to set a new one now.
      mustChangePassword: !!result.mustChangePassword,
      currentPassword: result.mustChangePassword ? password.value : '',
    })
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

    await beginSession({
      // Admin reset this friend's password → force them to set a new one now.
      mustChangePassword: !!result.mustChangePassword,
      currentPassword: result.mustChangePassword ? loginPassword.value : '',
    })
  } catch (e) {
    authError.value = e.message
  } finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------------------
// What the session view sends back up. The parent is the single owner of the
// credential store (token + localStorage) and of `currentFriend`, because both
// outlive any one session; the child never touches either directly.
// ---------------------------------------------------------------------------

/** A fresh session token from a password change / credential setup. */
function onToken({ token, expiresAt } = {}) {
  if (!token) return
  setFriendsToken(token)
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    const parsed = JSON.parse(stored)
    parsed.token = token
    if (expiresAt) parsed.expiresAt = expiresAt
    delete parsed.password // Remove old password
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
  }
}

/** `PUT /friends/:id/profile` succeeded: the appbar, the dropdown and the
 *  stored display name all have to follow. */
function onProfileSaved(updated) {
  currentFriend.value = { ...currentFriend.value, ...updated }

  const idx = friends.value.findIndex(f => f.id === parseInt(selectedFriendId.value))
  if (idx >= 0) {
    friends.value[idx] = { ...friends.value[idx], ...updated }
  }

  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    const parsed = JSON.parse(stored)
    parsed.friendName = updated.name
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
  }
}

/** Merge fields into the friend row and nothing else (credential setup).
 *  ⚠ Deliberately NOT `onProfileSaved`, and the reason is BEHAVIOUR
 *  PRESERVATION, not a missing field. `POST /friends/:id/setup-credentials`
 *  does return a name (`friends.js` selects `id, name, uid, username`), so a
 *  shared handler would not blank anything. What it WOULD do is add two writes
 *  the pre-extraction `saveCredentials()` never made — `parsed.friendName` in
 *  localStorage and the `friends[]` login-list row — on an action that changes
 *  a username and a password and leaves the display name untouched. Two emits
 *  keep the two call sites byte-identical to what they replaced; folding them
 *  into one would be a silent behaviour change smuggled in by a refactor. */
function onFriendMerged(fields) {
  currentFriend.value = { ...currentFriend.value, ...fields }
}

/** UC-FL-012's gate is satisfied — drop the stashed plaintext password. */
function onForcedComplete() {
  if (entry.value) entry.value = { ...entry.value, mustChangePassword: false, currentPassword: '' }
}

// ---------------------------------------------------------------------------

function switchUser() {
  // ⚠ THIS FUNCTION IS SHORT ON PURPOSE, and it must stay that way.
  //
  // It used to clear ~35 refs across seven blocks, and it leaked in SIX
  // consecutive rows anyway — `error`/`voucherResolved`/`subscriptions`
  // (RD-FL-3), `showArchive` (RD-FL-4), `guestSummaries` (RD-FL-5), the
  // credential-setup block holding a PLAINTEXT password that auto-rendered in
  // the next person's dialog and `showLoginPassword` (RD-FL-6), then
  // `setupSaving`/`changePasswordSaving`/`profileSaving` (RD-FL-7). The sixth
  // was found by a reviewer sweeping the component, not by reviewing the list.
  //
  // RD-FL-8a removed the list rather than extending it: every one of those refs
  // now lives in `FriendPortalSession.vue`, which `authState` unmounts on the
  // line below, so they are re-created from their initializers on the next
  // login. What remains here is exactly what an unmount CANNOT cover, and each
  // line is one of three kinds:
  //
  //   1. THE CREDENTIAL STORE — `clearFriendsPassword`, the in-memory token via
  //      the same call, and the localStorage entry. These are module- and
  //      browser-level, not component state; no unmount touches them, and
  //      clearing them IS logging out.
  //   2. THE IDENTITY the appbar renders — `savedAuth`, `currentFriend`,
  //      `selectedFriendId`. They live here because BrandChrome is one instance
  //      across all three auth states and must not remount (UC-FL-001); the
  //      child's `:key` cannot reach them.
  //   3. THE LOGIN FORM — `password`, `loginUsername`, `loginPassword`,
  //      `showLoginPassword`. This component IS the login screen, so nothing
  //      unmounts them. The first three hold plaintext credentials and the
  //      fourth inverts the masking default for the next person.
  //
  // Plus `entry`, the handshake payload: produced BEFORE the child exists, so
  // the key cannot cover it, and it carries the plaintext password of the
  // forced-change path. And `error`, whose one writer is `loadInitialData` —
  // kept for the same reason as the form refs: it is this component's own.
  clearFriendsPassword()
  localStorage.removeItem(STORAGE_KEY)
  savedAuth.value = null
  currentFriend.value = null
  selectedFriendId.value = ''
  password.value = ''
  loginUsername.value = ''
  loginPassword.value = ''
  showLoginPassword.value = false
  entry.value = null
  error.value = ''
  authState.value = 'login'
}

// The two appbar controls that act on the session view. Calling exposed methods
// rather than owning `showProfileModal`/`showInviteModal` here is the point: a
// pair of "is this dialog open" booleans in the parent is exactly the session
// state this split exists to keep out of it (and `showProfileModal` surviving a
// logout was one of RD-FL-6's findings).
function openProfile() {
  session.value?.openProfileModal()
}

function openInvite() {
  session.value?.openInviteModal()
}

// ⚠ `getStatusVariant` / `getStatusText` / `formatPrice` were deleted with the
// shadcn cycle cards they served (RD-FL-4); `getCurrentFriendLoginName` was
// deleted by RD-FL-8a as a byte-identical, uncalled duplicate of
// `currentFriendName`.
//
// Both identity reads fall back to the restored localStorage payload, because a
// token restore knows the stored name before `hydrateCurrentFriend` lands.
const currentFriendName = computed(() => currentFriend.value?.name || savedAuth.value?.friendName || '')
// ⚠ NOT rendered in the appbar any more (product decision, 2026-08-09). The
// authenticated titles used to be `<name> / <uid>`; they are now the Podpultovka
// wordmark with the name demoted to `.s`, so the appbar reads as the BRAND and no
// user identifier is on screen. The wordmark is therefore constant across both auth
// states and only `.s` varies — do not reintroduce a per-state `.t`.
// The computed stays because `FriendPortalSession` still passes the uid down to the
// profile/invite modal, which is where a friend is meant to read their own code.
const currentFriendUid = computed(() => currentFriend.value?.uid || savedAuth.value?.friendUid || '')

// Computed: friends to show in dropdown (exclude those with credentials in transition mode)
const dropdownFriends = computed(() => {
  if (authMode.value === 'transition') {
    return friends.value.filter(f => !f.hasCredentials)
  }
  return friends.value
})
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
      @titles-click="openProfile"
    >
      <template #titles>
        <span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>
        <span class="s">{{ authState === 'authenticated' ? currentFriendName : 'Členský vstup' }}</span>
      </template>
      <template #after-titles>
        <span
          v-if="authState === 'authenticated'"
          data-testid="profile-pencil"
          aria-hidden="true"
          title="Upraviť profil"
          style="opacity:.75;display:flex;cursor:pointer"
          @click="openProfile"
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
            @click="openInvite"
            @keydown.enter.prevent="openInvite"
            @keydown.space.prevent="openInvite"
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
        <!-- ⚠ `line-height:normal`: the FOURTH plain-text site (RD-FL-8b). Same
             class as the three above — unclassed markup that A10's class list
             cannot reach, so `html{line-height:1.5}` applies and the span
             computes 21 px against the canon's ~16.4. It is invisible TODAY
             only because the 24 px `.cbox` sibling dominates this flex line, so
             there is no geometry delta to see — but the moment this pattern is
             reused without a 24 px sibling the drift becomes real. Fixed rather
             than tolerated so the pattern is safe to copy. See
             friends-theme.css §A10, "WHAT THIS RULE STILL CANNOT REACH". -->
        <label
          style="display:flex;align-items:center;gap:10px;font-size:14px;line-height:normal;cursor:pointer"
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

      <!-- ⚠ `line-height:normal` is NOT in the prototype and is not decoration:
           this block is PLAIN TEXT with no theme class, so A10's class list
           cannot reach it and Tailwind preflight's `html{line-height:1.5}`
           applies. Measured canon-vs-port at both 378 and 1180 px: the card was
           94.75 px against the canon's 82 (+12.75) — the largest single fidelity
           delta module 03 had. See friends-theme.css §A10, "WHAT THIS RULE STILL
           CANNOT REACH". -->
      <div
        class="card dashed"
        style="padding:14px;font-size:13.5px;line-height:normal;color:var(--ink-dim);display:flex;gap:10px;align-items:flex-start"
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

    <!-- ==================================================================
         The AUTHENTICATED surface (UC-FL-004..012) — one child component whose
         lifetime IS the session (RD-FL-8a item 1).

         ⚠ `v-if`, NOT `v-show`, and that is the load-bearing part: logging out
         DESTROYS this instance, so every ref inside it is re-created from its
         initializer on the next login. `switchUser()` therefore has no list of
         session refs to clear — and no list to forget, which is what it did in
         six consecutive rows.

         ⚠ But `v-show` is not the mutation to reach for when testing that claim,
         and the reason is itself worth knowing: this child is a FRAGMENT
         (multi-root) component — nine root nodes, the voucher banner, the page
         column and seven portalled dialogs. Vue cannot apply `display:none` to a
         component with no single root element, so `v-show` here is a runtime
         NO-OP ("Runtime directive used on component with non-element root
         node") and the session surface simply stays visible on the login screen.
         Building it fails `portal-session-boundary.spec.js` in 3 places, but the
         diagnostics are `pp-login-password holds "ownPassB34"` and "credential
         dialog not found" — the net catches it, NOT by the leak mechanism. This
         is also why `v-show` can never be the "cheap" refactor here: it does not
         do the thing someone reaching for it thinks it does. The instance-
         preserving mutation that genuinely probes the leak is `<KeepAlive>`.

         ⚠ `:key="sessionSeq"` is the SECOND line, and it keys the HANDSHAKE, not
         the identity. Removing it while keeping the `v-if` leaves the boundary
         spec GREEN: no path today changes the session without also leaving
         `authState === 'authenticated'` (the dropdown renders only on the login
         branch, and `switchUser` blanks the id in the same tick it drops the
         state), so the key never fires. It is NOT what protects you today — do
         not let a refactor keep it and drop the `v-if`. It is insurance for a
         friend-switch-in-place that no path currently reaches.

         ⚠ Why the key is `sessionSeq` and not `selectedFriendId`, MEASURED —
         because this is the one part a passing suite cannot tell you, the
         scenario being unreachable. RD-FL-8a reproduced this file's exact
         sequence in a standalone Vue 3 page:

             identity.value = 'B'     // the :key source, written FIRST (line ~333)
             await …                  // beginSession()'s awaits — Vue FLUSHES here
             payload.value = B        // `entry`, written LAST

         with a child that seeds from `payload` once in `setup()`, exactly as
         `FriendPortalSession` does. Result:
           · `:key = identity`   → "child mounted, seeded payload = {who:'A'}"
           · `:key = sessionSeq` → "child mounted, seeded payload = {who:'B'}"
         An identity key therefore protects the refs and LEAKS THE PAYLOAD: the
         new instance mounts against the previous friend's `cycles`, keeps them
         permanently (nothing re-seeds `entry`), and fires `loadGuestCounts` over
         their cycle ids with the new friend's token. Bumping `sessionSeq` one
         statement before `entry.value` closes that window by construction, and
         being monotonic it also covers the same friend re-authenticating, which
         an identity key cannot (it would transit A → '' → A).

         ⚠ Do NOT try to probe this with `<KeepAlive>`: wrapping this element
         caches nothing, because the only placement that keeps the `v-if`/`v-else-if`
         chain valid puts `<KeepAlive>` INSIDE the conditional branch, where it is
         destroyed along with it. Verified: with `<KeepAlive>` and no key at all,
         all three boundary tests still pass. The `v-if` remains the primary
         defence.

         It is a fragment component: the voucher banner and the page column land
         as direct children of `.app`, exactly where they were, so
         `.app>*{position:relative;z-index:1}` (UC-DS-001) still lifts them over
         the halftone texture. -->
    <FriendPortalSession
      v-else-if="authState === 'authenticated'"
      ref="session"
      :key="sessionSeq"
      :friend-id="selectedFriendId"
      :friend="currentFriend"
      :friend-name="currentFriendName"
      :friend-uid="currentFriendUid"
      :entry="entry"
      @profile-saved="onProfileSaved"
      @friend-merged="onFriendMerged"
      @token="onToken"
      @forced-complete="onForcedComplete"
    />
  </div>
</template>
