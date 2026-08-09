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
import NeoCopyRow from '@/components/neo/NeoCopyRow.vue'

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
// ⚠ A DEDICATED error ref, not the page-level `error` (UC-FL-011 moves the fetch
// failure into the modal body). Two reasons it is not the shared one:
//   · the page banner is suppressed per open modal (`error && !showProfileModal`),
//     so sharing `error` would need one more `&& !showInviteModal` term per modal
//     — a condition that grows with every dialog and is wrong the moment someone
//     forgets a term;
//   · shared, ANY other writer (`saveProfile`, `saveSubscriptions`,
//     `resolveVoucher`) could put a message in this modal's banner that its own
//     fetch never produced. Scoped by construction beats scoped by reachability,
//     which is the same rule this row's session-boundary spec exists to enforce.
// The profile modal keeps the shared ref + suppression (RD-FL-6, out of scope
// here) — retiring that is a seam for RD-FL-8's component extraction.
const inviteError = ref('')
// The GSO-T2 `loadSeq` rule applied to the invite fetch: `openInviteModal` is
// re-entrant (chip → close → chip) and, more importantly, survives a logout as a
// promise in flight. Without the guard, session A's invite code can land in
// session B's modal — and an invite code is an identity, not decoration:
// registrations through it are credited to A. `switchUser` bumps it too.
let inviteSeq = 0

// Guest share dialog — the cycle whose link is being shared (null = closed)
const shareCycle = ref(null)

// Colleague counts for the UC-FL-007 share row, keyed by cycle id. CONTEXT ONLY
// — nothing on this screen is gated on them; a missing entry simply renders the
// "Objednávate aj pre kolegov?" fallback, which is also the failure surface (the
// fetch is non-blocking and error-swallowing, never the `error` banner).
const guestCounts = ref({})

// ⚠ Sequence guard for that batch — the GSO-T2 `loadSeq` rule, and here it is
// NOT the cosmetic case: a count is another friend's colleague data. `loadCycles`
// bumps it (so a refetch's results win over an older in-flight batch) and
// `switchUser` bumps it too, so a response still in flight when the session ends
// is DROPPED rather than written onto the next person's screen. Clearing the map
// in `switchUser` is not enough on its own: the stale response lands AFTER the
// clear, so the guard is the only thing standing between it and the next session.
let guestCountSeq = 0

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
  // Bumped BEFORE the awaits: an older count batch must never outlive the list
  // it was fetched for (subscription saves re-run this, so it happens in-session
  // too, not only across logins).
  const seq = ++guestCountSeq
  cycles.value = await api.getFriendsCycles(selectedFriendId.value)
  // Fire-and-forget on purpose — the cycle list must render at once, and a
  // colleague count is decoration on it (UC-FL-007).
  loadGuestCounts(seq, cycles.value)
  // Load subscriptions
  try {
    const subs = await api.getSubscriptions(selectedFriendId.value)
    subscriptions.value = subs.types || []
  } catch (e) {
    // Non-critical
  }
}

// One `GET /api/guest-links/cycle/:id` per OPEN cycle (the only cards that carry
// the share row — typically 1–2). Existing friend-authenticated endpoint from
// GSO-T2; `totals.count` already excludes cancelled sub-orders (GSO-T5), which is
// exactly the prototype's `liveSubs.length` semantics. No API change.
async function loadGuestCounts(seq, list) {
  await Promise.all(
    list
      .filter(c => c.status === 'open')
      .map(async (cycle) => {
        try {
          const data = await api.getGuestLink(cycle.id)
          if (seq !== guestCountSeq) return
          const count = Number(data?.totals?.count)
          // Written even when 0, so a colleague cancelling is reflected on the
          // next load instead of leaving a stale badge standing.
          //
          // ⚠ That self-healing is SUCCESS-PATH ONLY. `guestCounts` is a merge
          // map that is never reset per batch, so a refetch that FAILS leaves
          // the previous count standing rather than falling back to the
          // "Objednávate aj pre kolegov?" copy — showing last-known-good is the
          // better UX, but do not read this as "the map heals on error".
          // It is not a cross-session leak: `switchUser()` is the only
          // authenticated→login transition and it clears the map outright.
          guestCounts.value = { ...guestCounts.value, [cycle.id]: Number.isFinite(count) ? count : 0 }
        } catch {
          // Swallowed: no link yet, a 404 on a stale cycle id, or an offline
          // blip all render the "Objednávate aj pre kolegov?" fallback.
        }
      })
  )
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
  // `authError` on entry — the one sibling that really does heal itself before
  // it can be re-rendered. (`saveCredentials` clears `setupError` too, but only
  // when the NEXT person submits, i.e. long after the stale message has been
  // shown to them; see the credential-setup entry below.)
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
  //  - `guestCounts` (RD-FL-5) is the OPPOSITE end of that scale from
  //    `showArchive`: it holds another friend's colleague data, so leaving it
  //    behind would show the next person on a shared device how many colleagues
  //    the PREVIOUS host had ordering through their link. Bumping the sequence
  //    counter with it is what stops an in-flight response re-filling the map
  //    immediately after this clear.
  //  - The PROFILE MODAL's state (RD-FL-6) spans the whole scale at once, so
  //    all of it goes:
  //      · `changePasswordSuccess` ("Heslo bolo úspešne zmenené") is a green
  //        banner that its own 3s timeout may not have cleared yet — it would
  //        otherwise appear inside the NEXT person's profile modal, telling
  //        them their password was changed. Exactly the `voucherResolved` class
  //        of bug, one modal deeper.
  //      · `changePasswordError` likewise names a failure of a session that
  //        has ended.
  //      · `showPasswordChange` is the `showArchive` case: one bit of "somebody
  //        expanded the fold", and UC-FL-009 specifies the fold as
  //        default-closed.
  //      · the three password fields are the SEVERE case and the reason this
  //        block is not optional. `changeCurrentPassword` holds a plaintext
  //        password (and is also prefilled at login for the forced-change
  //        path). A friend who types it, cancels and hands the device over
  //        would leave it sitting in the next person's "Aktuálne heslo" field
  //        — recoverable from the DOM, and submitted verbatim on their next
  //        change attempt.
  //      · `profileName`/`profilePacketaAddress` are re-prefilled by
  //        `openProfileModal()` on every open, so they can never RENDER stale;
  //        they are cleared anyway so no field of a former session survives in
  //        memory, and so the rule needs no per-ref exception.
  //  - ⚠ The CREDENTIAL-SETUP modal is the SECOND plaintext credential this
  //    component holds across a logout, and the WORSE of the two, because it
  //    needs no action at all from the next person to render:
  //    `authenticate()` (line ~301) re-raises `showCredentialSetup` for
  //    ANY transition-mode friend whose `hasCredentials` is false, which on a
  //    shared device is routinely a different person from the one who just
  //    dismissed it with "Neskôr". Reproduced in ONE component instance with
  //    no reload: A types a username + password, presses "Neskôr", logs out;
  //    B logs in with the shared password and the dialog opens by itself,
  //    prefilled with A's username and A's plaintext password — and "Nastaviť"
  //    would write A's password onto B's account. `saveCredentials()` clears
  //    these on its SUCCESS path only, so every cancel path leaks.
  //    (`forcedNewPassword`/`forcedNewPasswordConfirm` are NOT in this block
  //    and must not be: that gate is `closable:false` and focus-trapped, so
  //    the logout control is unreachable while it holds anything.)
  //  - The SUBSCRIPTION and INVITE modals (RD-FL-7) are the two this row adds,
  //    and both are cleared BY CONSTRUCTION rather than by reachability — the
  //    reviewer sweep that found `showLoginPassword` proved that "the opener
  //    recomputes it, so it cannot render stale" is a claim about today's
  //    call graph, not about the refs. `e2e/tests/portal-session-boundary.spec.js`
  //    now enumerates the SURFACE for exactly this reason.
  //      · `showSubscriptionModal`/`showInviteModal` are the `showProfileModal`
  //        case: a dialog left open across a logout renders over the LOGIN
  //        screen, and the subscription one would then write the previous
  //        friend's two booleans onto whoever logs in next.
  //      · `subCoffee`/`subBakery` are re-derived by `openSubscriptionModal()`
  //        from `subscriptions` (cleared three lines up), so they cannot render
  //        stale today; reset to their initial `true` anyway so no preference of
  //        a former session survives in memory and the rule needs no exception.
  //      · `inviteCode` (cleared further down, pre-existing) is an IDENTITY, not
  //        decoration: registrations through it are credited to its owner.
  //        `inviteSeq++` is what stops a response still in flight from writing
  //        A's code into B's modal — the `guestCountSeq` lesson, and the reason
  //        clearing the ref alone is not enough.
  //      · `inviteError` names a failure of a session that has ended, and the
  //        modal renders it verbatim on open (`voucherResolved`'s class).
  //      · `inviteLoading`/`subSaving` are in-flight flags; left true by a
  //        logout mid-request they open the next person's modal with its buttons
  //        permanently disabled / stuck on "Načítavam...".
  //  - ⚠ `setupSaving`/`changePasswordSaving` are the SAME in-flight shape, in
  //    blocks this function already clears in full — added in the RD-FL-7 review
  //    after the two above made the shape explicit. Both are reachable: a
  //    `finally` only runs when the request settles, and BOTH dialogs are
  //    dismissable while one is in flight (NeoModal's Esc/× and radix's Esc
  //    ignore a disabled footer), so "submit → Esc → logout" leaves the flag set.
  //    `setupSaving` is the worst of the four, because its dialog is AUTO-RAISED
  //    for the next person (transition mode, `hasCredentials === false`) and both
  //    its footer buttons are `:disabled="setupSaving"` — so the next friend gets
  //    an inert dialog they did nothing to summon and cannot dismiss.
  //    `profileSaving` is cleared with them, closing the class rather than
  //    leaving one member of it behind: the RD-FL-7 review deferred it to
  //    RD-FL-8's convergence seam, but that seam is about where a failure
  //    MESSAGE renders (`profileError`/`subError`) — a boolean in-flight flag
  //    raises no such question, and there is no `profileError` ref to converge
  //    with (the profile modal writes the shared `error`, cleared at the top).
  //    Leaving the one modal that is NOT auto-raised as the sole uncleared case
  //    would just be an exception the next sweep has to re-derive.
  //  - `usernameAvailable`/`usernameChecking` are the mild `showArchive` end of
  //    the same modal: with the field cleared, a leftover "Užívateľské meno je
  //    voľné" would describe a name that is no longer in the box. The pending
  //    debounce is cancelled with them — otherwise its 400ms callback lands
  //    AFTER this clear and re-writes the flag, which is the `guestCountSeq`
  //    lesson in miniature.
  error.value = ''
  voucherResolved.value = null
  subscriptions.value = []
  showArchive.value = false
  guestCounts.value = {}
  guestCountSeq++
  showProfileModal.value = false
  showPasswordChange.value = false
  changeCurrentPassword.value = ''
  changeNewPassword.value = ''
  changeNewPasswordConfirm.value = ''
  changePasswordError.value = ''
  changePasswordSuccess.value = ''
  changePasswordSaving.value = false
  profileName.value = ''
  profilePacketaAddress.value = ''
  profileSaving.value = false
  showSubscriptionModal.value = false
  subCoffee.value = true
  subBakery.value = true
  subSaving.value = false
  showInviteModal.value = false
  inviteError.value = ''
  inviteLoading.value = false
  inviteSeq++
  showCredentialSetup.value = false
  setupUsername.value = ''
  setupPassword.value = ''
  setupPasswordConfirm.value = ''
  setupError.value = ''
  setupSaving.value = false
  if (usernameCheckTimeout) clearTimeout(usernameCheckTimeout)
  usernameCheckTimeout = null
  usernameAvailable.value = null
  usernameChecking.value = false
  // The `showArchive` end of the scale — except the bit it carries is "render my
  // password in cleartext". Left set, the next person's own password field opens
  // as `type="text"` with no action by them, on a shared device. It exposes no
  // PRIOR secret, which is why it is the mild case, but it inverts a security
  // default across a session boundary.
  showLoginPassword.value = false
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
  // ⚠ `error` is a PAGE-level ref shared with `openInviteModal`,
  // `saveSubscriptions` and `resolveVoucher`, and the profile modal renders it
  // as its own `.banner.danger.slim` while suppressing the page banner. So a
  // message left standing by any of those would open here looking like the
  // profile save had failed — and without the page banner's `Chyba:` prefix or
  // its dismiss ×, so it could not be cleared without closing the modal.
  // UC-FL-009 scopes the in-modal banner to `saveProfile()`'s own errors. Same
  // "a retry must not leave the previous attempt's banner standing" rule
  // `saveProfile`/`resolveVoucher` apply, one step earlier.
  error.value = ''
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
  // RD-FL-6's opener rule (see `openProfileModal`): this modal has no banner of
  // its own, so a stale `error` would keep rendering in the page banner BEHIND
  // the scrim while the user works here, and re-surface as if this dialog had
  // failed the moment they close it. `saveSubscriptions` clears it too — this
  // moves the reset one step earlier, to the point where the user takes the
  // action, rather than the point where it is submitted.
  error.value = ''
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
  // Same call, same data, same "fetch on every open" (UC-FL-011) — only where
  // the failure lands changed.
  const seq = ++inviteSeq
  showInviteModal.value = true
  inviteCode.value = ''
  inviteError.value = ''
  inviteLoading.value = true
  // The page banner is NOT this modal's surface any more, but the opener still
  // clears it: RD-FL-6's rule applies to every opener, and a message from a
  // failed profile/subscription/voucher write standing behind the scrim is
  // noise the user cannot dismiss without closing this dialog first.
  error.value = ''
  try {
    const friendId = getFriendsAuthInfo()?.friendId
    const data = await api.getMyInviteCode(friendId)
    if (seq !== inviteSeq) return
    inviteCode.value = data.inviteCode
  } catch (e) {
    if (seq !== inviteSeq) return
    inviteError.value = e.message
  } finally {
    if (seq === inviteSeq) inviteLoading.value = false
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

// ⚠ `copyInviteLink()` and `inviteCopied` were DELETED here (RD-FL-7).
// `NeoCopyRow` (UC-DS-011) owns the whole control now: the 2 s "Skopírované!"
// flip, restarting that window on a re-click, the clipboard write and its
// failure handling, and clearing the timer if the modal unmounts inside the
// window — which the view's version did not do. The URL is still built by
// `getInviteUrl()` from `window.location.origin`; the primitive only renders
// and copies the string it is handed.
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
           with the last writer that can reach it.

           ⚠ RD-FL-6 took the first of those steps: while the profile modal is
           open the message renders INSIDE it (`.banner.danger.slim`, UC-FL-009)
           and this banner stands down, so `error` has exactly ONE surface at
           any moment — two would have been a strict-mode ambiguity for every
           `.banner.danger` query as well as a visible duplicate. It is a
           suppression, not a handover: the moment the modal closes (including
           "Zrušiť" after a failed save) this banner renders the same message,
           which is what keeps the failure visible and dismissable. -->
      <div v-if="error && !showProfileModal" class="banner danger mb-5" role="alert">
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

            <!-- Share row (UC-FL-007) — OPEN cycles only: a locked cycle offers
                 no share affordance at all (pinned `toHaveCount(0)` in
                 `guest-link.spec.js`), and a planned one has nothing to order
                 into yet. This replaced RD-FL-4's transitional shadcn button in
                 place; it stays the card's LAST child, directly under the badge
                 row, and keeps the whole affordance inside `div.p-4`.

                 ⚠ resolved conflict #2 — the VISIBLE label is the prototype's
                 "Zdieľať", while `aria-label="Zdieľať s kolegami"` carries the
                 accessible name `guest-link.spec.js` locates the button by. Both
                 contracts hold with zero spec edits; neither may be dropped in
                 favour of the other.

                 ⚠ `@click.stop` is mandatory, not stylistic: the card root
                 navigates on click, so without it the share tap would leave the
                 portal before the dialog could be seen (pinned — after the click
                 the URL stays `/`).

                 The left half is context only. `guestCounts` is filled by a
                 non-blocking batch after `loadCycles`; while it is in flight, has
                 failed, or the host simply has no colleagues yet, the row reads
                 "Objednávate aj pre kolegov?" — there is deliberately no loading
                 or error state, because a missing count costs the host nothing. -->
            <div
              v-if="cycle.status === 'open'"
              data-testid="share-row"
              style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;border-top:2px solid rgba(10,10,10,0.12);padding-top:12px"
            >
              <span class="sub" style="display:flex;align-items:center;gap:6px;min-width:0">
                <!-- The badge appears only when the count is > 0 — a "0" mono
                     chip next to "kolegovia cez váš odkaz" would read as a
                     failure rather than as an invitation. -->
                <template v-if="guestCounts[cycle.id] > 0">
                  <span class="tabbadge">{{ guestCounts[cycle.id] }}</span>
                  <span style="overflow-wrap:anywhere">kolegovia cez váš odkaz</span>
                </template>
                <span v-else style="overflow-wrap:anywhere">Objednávate aj pre kolegov?</span>
              </span>
              <button
                type="button"
                class="btn sm"
                aria-label="Zdieľať s kolegami"
                style="flex-shrink:0"
                @click.stop="openShareDialog(cycle)"
              >
                <NeoIcon name="share" /> Zdieľať
              </button>
            </div>
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

    <!-- Subscription modal (UC-FL-010) — `portal.jsx:149-159` node for node.
         `.m-body` is already `flex-direction:column; gap:12px`, so the four
         children need no wrapper and no spacing of their own.

         Script behaviour is UNCHANGED: `openSubscriptionModal()` still presets
         the two booleans (empty list ⇒ both), `saveSubscriptions()` still builds
         `types` from them, PUTs `/subscriptions/friend/:id` and re-runs
         `loadCycles()` so the filter applies without a reload. -->
    <NeoModal
      v-if="showSubscriptionModal"
      title="Nastavenia odberu"
      @close="showSubscriptionModal = false"
    >
      <div class="sub">Vyberte, ktoré typy objednávok chcete vidieť:</div>

      <!-- ⚠ Three click zones, one toggle each — RD-FL-2's remember-me pattern,
           and the reason it exists: a `<label>` only forwards clicks to LABELABLE
           elements, and `NeoCheckbox` is a `span[role=checkbox]`, so the wrapper
           forwards nothing by itself. UC-FL-010 requires the whole label surface
           to toggle, so each zone gets its own mechanism, and exactly once:
             · the box     → NeoCheckbox's own handler;
             · the text    → the `@click` on the span;
             · the padding → `@click.self` on the label, which fires ONLY when the
               and gap       label itself is the event target. Without `.self` the
                             label would also catch the two clicks above and
                             double-toggle them straight back.
           The label cannot name the checkbox either (same non-labelable reason),
           hence `aria-label` on the control — otherwise the box announces as an
           unnamed checkbox.
           Default magenta, NOT `ok`: green is reserved for hand-over semantics
           (UC-DS-009). -->
      <label
        class="card flat"
        style="padding:12px 14px;display:flex;align-items:center;gap:12px;cursor:pointer"
        @click.self="subCoffee = !subCoffee"
      >
        <NeoCheckbox v-model="subCoffee" aria-label="Káva" />
        <span style="font-weight:700" @click="subCoffee = !subCoffee">Káva</span>
      </label>
      <label
        class="card flat"
        style="padding:12px 14px;display:flex;align-items:center;gap:12px;cursor:pointer"
        @click.self="subBakery = !subBakery"
      >
        <NeoCheckbox v-model="subBakery" aria-label="Pekáreň" />
        <span style="font-weight:700" @click="subBakery = !subBakery">Pekáreň</span>
      </label>

      <div class="field-help">Ak nevyberiete nič, zobrazia sa všetky cykly.</div>

      <template #footer>
        <button type="button" class="btn" :disabled="subSaving" @click="showSubscriptionModal = false">
          Zrušiť
        </button>
        <button type="button" class="btn accent" :disabled="subSaving" @click="saveSubscriptions">
          {{ subSaving ? 'Ukladám...' : 'Uložiť' }}
        </button>
      </template>
    </NeoModal>

    <!-- Profile modal (UC-FL-009) — the first CLOSABLE form-bearing NeoModal.
         Composed from `portal.jsx:176-199`: same nodes, same inline styles.
         `.m-body` is itself `flex-direction:column; gap:12px`, so every field
         group is a bare `<div>` — no wrapper spacing of our own.

         ⚠ It is also the row that closed NeoModal's scrim-drag seam: releasing
         a text selection over the scrim used to fire `@click.self` and throw
         the half-typed form away. See the UC-DS-010 amendment.

         Script behavior is UNCHANGED (`saveProfile` / `changePassword` keep
         their side-effects verbatim); only the rendering moved. -->
    <NeoModal
      v-if="showProfileModal"
      title="Upraviť profil"
      @close="showProfileModal = false"
    >
      <!-- ⚠ The page-level `error` banner is SUPPRESSED while this modal is
           open (see its `v-if` up in the authenticated column) and the same
           message renders here instead — UC-FL-009: "render inside the modal
           body so the user sees it in context". One surface at a time, so
           there is never a duplicate; the page banner takes over the moment
           the modal closes, which is what keeps a failed save visible after
           "Zrušiť". -->
      <div v-if="error" class="banner danger slim">
        <span class="dot"></span>
        <div style="min-width:0">{{ error }}</div>
      </div>

      <!-- Read-only identity row. `div.copyrow > div.val` is the prototype's
           READ-ONLY box style — deliberately WITHOUT NeoCopyRow's button
           (UC-DS-011 is the copy control; this is just its box). The two
           boxes are content-sized, exactly as `portal.jsx` renders them: no
           `flex:1`, so each is as wide as its own label/value and the pair
           shrinks (`.val` carries `min-width:0`) rather than overflowing.

           ⚠ `<label for=…>` only associates with LABELABLE elements, and a
           `div` is not one, so the association runs the other way here:
           the label carries the id and the box points at it with
           `aria-labelledby`. That is what keeps `getByLabel` resolving on a
           non-input — plain `for` would silently associate with nothing. -->
      <div style="display:flex;gap:10px">
        <div>
          <label id="pp-profile-uid-lbl" class="field-lbl">Jedinečné ID</label>
          <div class="copyrow">
            <div class="val" aria-labelledby="pp-profile-uid-lbl" data-testid="profile-uid">{{ getCurrentFriendUid() }}</div>
          </div>
        </div>
        <!-- Username renders only when there IS one: legacy friends have no
             credentials at all (repo behavior beats the prototype's demo
             friend, who always does). -->
        <div v-if="currentFriend?.username">
          <label id="pp-profile-username-lbl" class="field-lbl">Užívateľské meno</label>
          <div class="copyrow">
            <div class="val" aria-labelledby="pp-profile-username-lbl" data-testid="profile-username">{{ currentFriend.username }}</div>
          </div>
        </div>
      </div>

      <div>
        <label class="field-lbl" for="pp-profile-name">Prihlasovacie meno *</label>
        <input
          id="pp-profile-name"
          v-model="profileName"
          class="inp"
          :disabled="profileSaving"
        />
        <div class="field-help">Toto meno vidí správca a kolegovia.</div>
      </div>

      <div>
        <label class="field-lbl" for="pp-profile-packeta">Adresa Packeta výdajného miesta</label>
        <input
          id="pp-profile-packeta"
          v-model="profilePacketaAddress"
          class="inp"
          placeholder="napr. Z-BOX Hlavná 15, Bratislava"
          :disabled="profileSaving"
        />
        <div class="field-help">Predvolená adresa pre doručenie Packetou (voliteľné).</div>
      </div>

      <!-- Password-change fold — only for friends who HAVE a password (repo
           behavior; a legacy shared-password friend has nothing to change). -->
      <div
        v-if="currentFriend?.hasCredentials"
        style="border-top:2px solid rgba(10,10,10,0.12);padding-top:12px"
      >
        <button
          type="button"
          class="btn ghost sm"
          style="color:var(--accent);font-weight:700;padding:0"
          @click="showPasswordChange = !showPasswordChange"
        >
          {{ showPasswordChange ? 'Skryť zmenu hesla' : 'Zmeniť heslo' }}
        </button>
        <!-- ⚠ The toggle and the submit button share the string "Zmeniť heslo",
             but never at the same time: the toggle reads "Skryť zmenu hesla"
             exactly when the submit exists. `getByRole('button', { name:
             'Zmeniť heslo' })` therefore stays unambiguous in both states. -->
        <div
          v-if="showPasswordChange"
          style="display:flex;flex-direction:column;gap:12px;margin-top:12px"
        >
          <div v-if="changePasswordError" class="banner danger slim">
            <span class="dot"></span>
            <div style="min-width:0">{{ changePasswordError }}</div>
          </div>
          <div v-if="changePasswordSuccess" class="banner ok slim">
            <span class="dot"></span>
            <div style="min-width:0">{{ changePasswordSuccess }}</div>
          </div>

          <div>
            <label class="field-lbl" for="pp-profile-current-password">Aktuálne heslo</label>
            <input
              id="pp-profile-current-password"
              v-model="changeCurrentPassword"
              class="inp"
              type="password"
              :disabled="changePasswordSaving"
            />
          </div>
          <div>
            <label class="field-lbl" for="pp-profile-new-password">Nové heslo</label>
            <input
              id="pp-profile-new-password"
              v-model="changeNewPassword"
              class="inp"
              type="password"
              :disabled="changePasswordSaving"
            />
          </div>
          <div>
            <label class="field-lbl" for="pp-profile-new-password-confirm">Potvrdiť nové heslo</label>
            <input
              id="pp-profile-new-password-confirm"
              v-model="changeNewPasswordConfirm"
              class="inp"
              type="password"
              :disabled="changePasswordSaving"
              @keyup.enter="changePassword()"
            />
          </div>
          <button
            type="button"
            class="btn sm dark"
            :disabled="changePasswordSaving || !changeCurrentPassword || !changeNewPassword || !changeNewPasswordConfirm"
            @click="changePassword()"
          >
            {{ changePasswordSaving ? 'Mením heslo...' : 'Zmeniť heslo' }}
          </button>
        </div>
      </div>

      <template #footer>
        <button type="button" class="btn" :disabled="profileSaving" @click="showProfileModal = false">
          Zrušiť
        </button>
        <button
          type="button"
          class="btn accent"
          :disabled="!profileName.trim() || profileSaving"
          @click="saveProfile"
        >
          {{ profileSaving ? 'Ukladám...' : 'Uložiť' }}
        </button>
      </template>
    </NeoModal>

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

    <!-- Invite modal (UC-FL-011) — `portal.jsx:162-167`. The title keeps its
         familiar "Pozvi priateľa" (resolved conflict #5); the body copy is
         vy-form.

         ⚠ The prototype's `https://podpultovka.sk/invite/LEGO-9F2K` is demo
         data. The real value is `getInviteUrl()` — `window.location.origin` +
         the code fetched on every open — so the link works on localhost, on
         staging and in production without a build-time host anywhere. -->
    <NeoModal
      v-if="showInviteModal"
      title="Pozvi priateľa"
      @close="showInviteModal = false"
    >
      <div class="sub">Pošlite tento odkaz priateľovi. Po registrácii ho správca pridá do skupiny.</div>

      <!-- Three mutually exclusive states for one fetch. The failure renders
           HERE rather than in the page banner (UC-FL-011's one permitted UX
           correction): the user asked for a link, so the answer — link or
           reason — belongs where they are looking, not behind the scrim. It
           uses the modal's own `inviteError`, so nothing another action failed
           at can ever appear in it. -->
      <div v-if="inviteLoading" class="sub" style="text-align:center">Načítavam...</div>
      <div v-else-if="inviteError" class="banner danger slim">
        <span class="dot"></span>
        <div style="min-width:0">{{ inviteError }}</div>
      </div>
      <NeoCopyRow v-else-if="inviteCode" :value="getInviteUrl()" />

      <template #footer>
        <button type="button" class="btn" @click="showInviteModal = false">Zavrieť</button>
      </template>
    </NeoModal>

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
