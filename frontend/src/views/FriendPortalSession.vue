<script setup>
// =============================================================================
// The AUTHENTICATED friend surface (03 §UC-FL-004..012), extracted from
// FriendPortal.vue by RD-FL-8a.
//
// ⚠ WHY THIS FILE EXISTS — and it is not tidiness. `switchUser()` leaked session
// state in SIX consecutive rows: `error`/`voucherResolved`/`subscriptions`
// (RD-FL-3), `showArchive` (RD-FL-4), `guestSummaries` (RD-FL-5), the
// credential-setup block — which held a PLAINTEXT password and auto-rendered it
// in the next person's dialog — and `showLoginPassword` (RD-FL-6), then
// `setupSaving`/`changePasswordSaving`/`profileSaving` (RD-FL-7). The sixth was
// found by a reviewer sweeping the component, not by reviewing the ref list the
// previous five had assembled. List-review had demonstrably stopped working, and
// every row still added refs to a 2117-line component holding ~40 top-level refs
// across TWO disjoint lifetimes (the anonymous login screen, and a session).
//
// The fix is structural. The parent renders this component as
//
//     <FriendPortalSession v-if="authState === 'authenticated'" :key="friendId" … />
//
// so ending a session DESTROYS the instance and every ref in this file is
// re-created from its initializer on the next login. There is no list to forget.
// The in-repo precedent is `GuestShareDialog.vue`, which holds session data too
// and has never leaked because it resets on both edges of its `open` watch.
//
// ⚠ It also closes a SEVENTH class that was never reported, because nobody had
// looked: `switchUser()` never cleared the voucher block
// (`showVoucherModal`/`currentVoucher`/`pendingVouchers`), `shareCycle`, or the
// four forced-gate refs either. The voucher one is the same severity as the
// password leak that prompted RD-FL-6 — an unresolved voucher modal survived the
// logout and rendered ANOTHER FRIEND'S € AMOUNT over the login screen. That it
// was found by writing this component rather than by reviewing the list is the
// whole argument for the structural fix, restated: the list was never complete,
// and five rows of careful list-review never noticed.
//
// ⚠ WHAT IS LOAD-BEARING: the parent's `v-if` (not `v-show`). Swapping it for
// `v-show` keeps this instance alive across a logout and every one of the six
// leaks comes back at once — `e2e/tests/portal-session-boundary.spec.js` is the
// net that catches it. The `:key="friendId"` is belt-and-braces on top: today no
// path changes the friend id without also leaving the authenticated state, so
// the key never fires; it is here so that if one ever becomes reachable, an
// identity change re-creates the session rather than re-pointing it.
//
// ⚠ WHAT STAYS IN THE PARENT, and why the key cannot cover it: the auth
// handshake itself — identity, token, localStorage, auth mode and the login
// form. Those exist BEFORE this component and outlive it by design; clearing
// them IS the act of logging out, not a clean-up someone can forget. See
// `switchUser()`.
// =============================================================================

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api, { getFriendsAuthInfo } from '../api'
// ⚠ No `@/components/ui/*` import remains in this file. The credential-setup
// dialog was the last radix consumer on the authenticated friend surface; it now
// composes on `NeoModal`, so `Input`/`Label`/`Button`/`Alert`/`Dialog*` are gone.
// UC-DS-004 rule 4 keeps radix ADMIN-only — do not re-introduce one here.
import { fmtEur } from '@/lib/money'
import { VARIANT_GRAMS } from '@/lib/guest-cart'
import { colleaguesLabel } from '@/lib/plural'
import FriendBalanceCard from '@/components/FriendBalanceCard.vue'
import GuestShareDialog from '@/components/GuestShareDialog.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoCheckbox from '@/components/neo/NeoCheckbox.vue'
import NeoModal from '@/components/neo/NeoModal.vue'
import NeoCopyRow from '@/components/neo/NeoCopyRow.vue'

const router = useRouter()

const props = defineProps({
  // The authenticated friend's id. Also the parent's `:key`, so a change of
  // identity re-creates this instance rather than re-pointing it.
  friendId: { type: [String, Number], required: true },
  // The full friend row as the parent knows it (login/restore payload merged
  // with `hydrateCurrentFriend`'s profile fetch). Read-only here: every write
  // goes back up as an emit, because the appbar renders the same object and
  // outlives this component.
  friend: { type: Object, default: null },
  // Identity already resolved against the localStorage fallback by the parent
  // (`currentFriend?.name || savedAuth?.friendName`), so this file never has to
  // know that a restored session may carry only the stored name.
  friendName: { type: String, default: '' },
  friendUid: { type: String, default: '' },
  // ⚠ What the AUTH HANDSHAKE produced, handed over once at mount:
  //   · `cycles`  — the payload of the probe request the parent already made to
  //     validate the token (`GET /friends/cycles`). Seeding from it is what
  //     keeps a login at ONE cycles request rather than two.
  //   · `mustChangePassword` + `currentPassword` — UC-FL-012's forced gate. The
  //     plaintext password stays the PARENT's (it is a login credential, and the
  //     parent already holds it in `password`/`loginPassword`); this component
  //     reads it at submit time and never copies it into a ref of its own.
  //   · `needsCredentialSetup` — transition mode, `hasCredentials === false`.
  entry: { type: Object, default: () => ({}) },
})

const emit = defineEmits([
  // `PUT /friends/:id/profile` succeeded — the parent owns `currentFriend`, the
  // login list and the stored display name.
  'profile-saved',
  // Merge these fields into `currentFriend` and nothing else (credential setup).
  'friend-merged',
  // A fresh session token: the parent owns `setFriendsToken` and localStorage.
  // ⚠ This component never touches either — one owner for the credential store.
  'token',
  // UC-FL-012's gate is satisfied; the parent may drop the stashed plaintext.
  'forced-complete',
  // 09 §UC-ML-008 "Teraz nie": persist `magicPromptDismissed` into the stored payload.
  // ⚠ An emit rather than a write, for the same reason `token` is one — the parent is
  // the single owner of localStorage, and this component must never touch it.
  'magic-prompt-dismissed',
])

// ---------------------------------------------------------------------------
// Cycle list
// ---------------------------------------------------------------------------

// Seeded from the handshake, so the first paint needs no request of its own.
const cycles = ref(Array.isArray(props.entry?.cycles) ? props.entry.cycles : [])

// Archive fold (UC-FL-008): plain UI state, not persisted, not in the URL,
// default closed. It used to need an explicit reset in `switchUser` so the next
// session on a shared device also opened closed — the initializer is that reset
// now.
const showArchive = ref(false)

// The type filter behind that list, also seeded from the handshake — the gear
// must never be openable before it has landed, or the modal prefills "show
// everything" and "Uložiť" writes that over the friend's real preferences.
const subscriptions = ref(Array.isArray(props.entry?.subscriptions) ? props.entry.subscriptions : []) // ['coffee', 'bakery']

// Colleague aggregates for the UC-FL-007 share row, keyed by cycle id:
// `{ count, grams, units }`. CONTEXT ONLY — nothing on this screen is gated on
// them; a missing entry simply renders the "Objednávate aj pre kolegov?"
// fallback, which is also the failure surface (the fetch is non-blocking and
// error-swallowing, never the `error` banner).
//
// It carries the QUANTITY as well as the count because the host's real question
// on this card is how much coffee they are collecting for other people — the
// count alone says nothing about whether that is one 250g bag or 4 kg.
const guestSummaries = ref({})

// ⚠ Sequence guard for that batch — the GSO-T2 `loadSeq` rule. It is NOT the
// cosmetic case: a count is another friend's colleague data. `loadCycles` bumps
// it so a refetch's results win over an older in-flight batch.
//
// ⚠ The CROSS-SESSION half of RD-FL-5's guarantee is now structural: a response
// still in flight when the session ends lands on a DESTROYED component, so it
// can write nothing. This counter is what still covers the IN-SESSION half
// (saving subscriptions re-runs `loadCycles`). Both halves stay mutation-tested
// in `portal-share-row.spec.js`; do not fold them into one.
let guestCountSeq = 0

// ---------------------------------------------------------------------------
// Modals and their own error surfaces
// ---------------------------------------------------------------------------

// ⚠ ONE error surface per action (RD-FL-8a item 4). Before this row the view ran
// three different strategies at once: a shared page-level `error` suppressed per
// open modal (`error && !showProfileModal`), a dedicated `inviteError`, and the
// page banner. The suppression was a condition that grew by one term per dialog
// and was wrong the moment someone forgot a term; worse, ANY writer could put a
// message into a modal whose own action never produced it. Every action now owns
// its ref, and the page banner's condition is plain `error`.
//
// ⚠ The three modal openers no longer clear `error` either. They did so because
// a message left by ANY writer would otherwise sit behind their scrim; with
// `resolveVoucher` the only writer left, that is unreachable — its modal is a
// full-screen scrim with no dismiss control and it stays up on failure, so the
// gear, the appbar chip and `.titles` cannot be clicked while `error` is set.
// Keeping the clears would have preserved the "any opener may wipe any message"
// coupling this item removes.
const error = ref('')

const showProfileModal = ref(false)
const profileName = ref('')
const profilePacketaAddress = ref('')
// UC-FC-009: the friend's own contact data. Seeded on modal OPEN from the
// hydrated profile (the session-boundary rule — never module-level defaults),
// with the open-time originals kept so `saveProfile` only sends a field the
// friend actually CHANGED (PATCH semantics; an untouched field is left to
// whatever the server already holds). FUP-T5 put `packeta_address` on the same
// rule, so `name` is now the only key always present.
const profilePhone = ref('')
const profileEmail = ref('')
const profilePhoneOriginal = ref('')
const profileEmailOriginal = ref('')
// FUP-T5: `packeta_address` joins the same delta. `hydrateCurrentFriend` is
// fire-and-forget, so this modal is openable BEFORE the profile GET lands — the
// field then renders empty and an unconditional send WIPED a stored address.
// Seeded per OPEN like every other original, so it carries no state across
// friends (the session-boundary rule).
const profilePacketaOriginal = ref('')
const profileSaving = ref(false)
const profileError = ref('')

const showSubscriptionModal = ref(false)
const subCoffee = ref(true)
const subBakery = ref(true)
const subSaving = ref(false)
// ⚠ Not cosmetic. A failed `saveSubscriptions()` leaves this modal OPEN, and the
// page banner then renders BEHIND the scrim with its dismiss unreachable — the
// user sees a dialog that simply "did nothing". (Measured; not a regression —
// radix behaved identically before the NeoModal port.)
const subError = ref('')

// Vouchers
const pendingVouchers = ref([])
const currentVoucher = ref(null)
const showVoucherModal = ref(false)
const voucherResolved = ref(null) // { action: 'accept'|'decline', amount, cycleName }
const resolvingVoucher = ref(false)

// Password change (inside the profile modal)
const showPasswordChange = ref(false)
const changeCurrentPassword = ref('')
const changeNewPassword = ref('')
const changeNewPasswordConfirm = ref('')
const changePasswordError = ref('')
const changePasswordSaving = ref(false)
const changePasswordSuccess = ref('')

// Credential setup (transition mode)
const showCredentialSetup = ref(!!props.entry?.needsCredentialSetup)
const setupUsername = ref('')
const setupPassword = ref('')
const setupPasswordConfirm = ref('')
const setupError = ref('')
const setupSaving = ref(false)
const usernameAvailable = ref(null) // null = not checked, true/false
const usernameChecking = ref(false)
let usernameCheckTimeout = null

// Forced password change (UC-FL-012): admin reset this friend's password, so on
// login they must choose their own before continuing (non-dismissable).
//
// ⚠ It lives HERE, not in the parent, even though a login response triggers it.
// Its four transient refs are session state of exactly the shape that leaked six
// times; in the parent they would need an explicit reset that `switchUser` today
// deliberately SKIPS, on the argument that the gate is `closable:false` and
// focus-trapped so the logout control is unreachable while it holds anything.
// That is an argument from reachability — the very thing the session-boundary
// spec exists because it stopped working. Here they die with the instance and
// need no argument. The one thing that must NOT move is the plaintext password
// the friend just logged in with: that is a login credential, the parent already
// holds it, and it is read from `props.entry` at submit time rather than copied.
//
// ⚠ It is also no longer the same ref as the profile modal's "Aktuálne heslo"
// field. Sharing `changeCurrentPassword` between the two bought nothing (the
// gate traps focus, so the profile modal is unreachable while it is up) and
// meant a login could prefill a visible password input.
const forcedPasswordChange = ref(!!props.entry?.mustChangePassword)
const forcedNewPassword = ref('')
const forcedNewPasswordConfirm = ref('')
const forcedError = ref('')
const forcedSaving = ref(false)

// ---------------------------------------------------------------------------
// Magic-link session provenance (09 §UC-ML-008)
// ---------------------------------------------------------------------------

// "This session was born of a magic link AND still carries the server's
// `currentPassword` waiver." Seeded ONCE from the handshake, like every other piece of
// session state in this file, so it dies with the instance — the six-leak rule.
//
// ⚠ The `!mustChangePassword` term is the resolved-conflict-#4 suppression, and it
// belongs in the SEED rather than in a computed over `props.entry`. In the forced flow
// the friend never reaches the profile modal's password fold (the gate is
// focus-trapped and non-dismissable), and satisfying that gate re-mints with NULL
// `via` — so from the very first paint to the last, a forced session genuinely has no
// waiver to offer. Reading the prop reactively instead would flip this to `true` the
// moment `onForcedComplete` clears it upstream, i.e. it would show the prompt exactly
// once the waiver was gone: the one state it must never appear in.
//
// It is cleared by the two writers that consume the waiver — `changePassword()` and
// `submitForcedPasswordChange()` — because both re-mint, and the parent's `onToken`
// drops the same flag from the stored payload in the same tick. Keeping the two in
// step is what stops the modal hiding a field the server has started requiring again.
const magicLinkSession = ref(!!props.entry?.viaMagicLink && !props.entry?.mustChangePassword)

// Dismissal is a SIBLING of the provenance, never a replacement for it: "Teraz nie"
// silences the invitation, it does not retire the waiver, so the hidden
// current-password field must survive a dismissal. Seeded from the stored payload so a
// dismissal made before a reload is still in force after it.
const magicPromptDismissed = ref(!!props.entry?.magicPromptDismissed)

// §UC-ML-008's visibility rule, verbatim: `viaMagicLink && !magicPromptDismissed`.
const showMagicPrompt = computed(() => magicLinkSession.value && !magicPromptDismissed.value)

function dismissMagicPrompt() {
  magicPromptDismissed.value = true
  // The ref alone would die with the reload, which is the exact case a dismissal is
  // for; the parent persists it into `gorifi_friend_auth`.
  emit('magic-prompt-dismissed')
}

/** The prompt's call to action: the EXISTING change-password UI, already unfolded. */
function openMagicPasswordChange() {
  openProfileModal()
  showPasswordChange.value = true
}

// Invite modal
const showInviteModal = ref(false)
const inviteCode = ref('')
const inviteLoading = ref(false)
// A DEDICATED error ref (UC-FL-011 moves the fetch failure into the modal body):
// scoped by construction beats scoped by reachability. Since RD-FL-8a every
// modal follows this pattern; this one is simply where it started.
const inviteError = ref('')
// The GSO-T2 `loadSeq` rule applied to the invite fetch: `openInviteModal` is
// re-entrant (chip → close → chip), and an invite code is an IDENTITY, not
// decoration — registrations through it are credited to its owner. The
// cross-session case is structural now (this component is gone), so the counter
// covers re-entrancy within one session.
let inviteSeq = 0

// Guest share dialog — the cycle whose link is being shared (null = closed)
const shareCycle = ref(null)

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

onMounted(async () => {
  const seq = ++guestCountSeq
  // `cycles` and `subscriptions` are already seeded from the handshake, so the
  // only fetch the first render still owes is the voucher check.
  await checkPendingVouchers()
  // ⚠ Issued LAST, deliberately — see `loadGuestCounts`.
  loadGuestCounts(seq, cycles.value)
})

onBeforeUnmount(() => {
  // ⚠ Everything that outlives a Vue instance on its own has to be cancelled
  // here. Destroying the component stops its refs from being WRITTEN, but it
  // does not stop work already in flight from being ISSUED.
  //
  //   · a pending `setTimeout` — `switchUser` used to cancel it; ours now.
  //   · the two sequence counters. `loadGuestCounts`'s worker loop has exactly
  //     one exit, `if (seq !== guestCountSeq) return`, and nothing bumped it on
  //     unmount — so after a logout the capped queue kept DISPATCHING. Against
  //     the e2e database's 135 open cycles that is ~132 further
  //     `GET /api/guest-links/cycle/:id`, now token-less (`clearFriendsPassword()`
  //     has already run), each 401ing into the empty catch while competing for
  //     connections with the NEXT login's own requests. The concurrency cap
  //     holds it to 3 sockets, which is the only reason it was survivable —
  //     the cap was masking this, not fixing it. Bumping both counters makes
  //     the loop exit before its next dispatch.
  if (usernameCheckTimeout) clearTimeout(usernameCheckTimeout)
  usernameCheckTimeout = null
  guestCountSeq++
  inviteSeq++
})

async function loadSubscriptions() {
  try {
    const subs = await api.getSubscriptions(props.friendId)
    subscriptions.value = subs.types || []
  } catch (e) {
    // Non-critical: it only prefills the subscription modal.
  }
}

// Re-fetch the list. Only invalidated by a subscription change today — the first
// render is seeded from the handshake.
async function loadCycles() {
  // Bumped BEFORE the awaits: an older count batch must never outlive the list
  // it was fetched for.
  const seq = ++guestCountSeq
  cycles.value = await api.getFriendsCycles(props.friendId)
  await loadSubscriptions()
  loadGuestCounts(seq, cycles.value)
}

// ⚠ The concurrency cap is the point of this function (RD-FL-8a item 3).
//
// It used to `Promise.all` one `GET /api/guest-links/cycle/:id` per OPEN cycle in
// a single tick, on the assumption — written into the code — that there would be
// "typically 1–2" of them. Cycles are never auto-closed, so that assumption
// decays silently with age: the e2e database reaches 135 open cycles, and 135
// XHRs issued at once queue behind the browser's 6-connection-per-host limit
// with the portal's OWN requests stuck behind them. That really happened; it
// flaked `portal-session-boundary.spec.js` until `muteGuestCounts` was added to
// paper over it.
//
// Two bounds, both required:
//   · at most GUEST_COUNT_CONCURRENCY in flight, leaving at least half the
//     connection budget for the balance card, the order pages and navigation;
//   · the batch is issued only AFTER the subscription and voucher fetches have
//     settled (see `onMounted`), so decoration can never be ahead of the two
//     calls that decide what the screen shows.
// The sequence guard is re-checked before each DISPATCH as well as before each
// write, so a superseded batch stops issuing rather than merely stops writing.
const GUEST_COUNT_CONCURRENCY = 3

async function loadGuestCounts(seq, list) {
  const queue = list.filter(c => c.status === 'open')
  let next = 0

  const worker = async () => {
    while (next < queue.length) {
      if (seq !== guestCountSeq) return
      const cycle = queue[next++]
      try {
        const data = await api.getGuestLink(cycle.id)
        if (seq !== guestCountSeq) return
        // Written even when the count is 0, so a colleague cancelling is
        // reflected on the next load instead of leaving a stale figure standing.
        //
        // ⚠ That self-healing is SUCCESS-PATH ONLY. `guestSummaries` is a merge
        // map that is never reset per batch, so a refetch that FAILS leaves the
        // previous entry standing rather than falling back to the "Objednávate
        // aj pre kolegov?" copy — showing last-known-good is the better UX, but
        // do not read this as "the map heals on error". It is not a
        // cross-session leak: the map dies with this component.
        guestSummaries.value = { ...guestSummaries.value, [cycle.id]: summariseSubOrders(data) }
      } catch {
        // Swallowed: no link yet, a 404 on a stale cycle id, or an offline blip
        // all render the "Objednávate aj pre kolegov?" fallback.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(GUEST_COUNT_CONCURRENCY, queue.length) }, worker)
  )
}

// One cycle's colleague aggregate, out of the GSO-T2 `{ link, guest_orders,
// totals }` payload the batch above already fetches. No new request and no new
// endpoint: `guest_orders` carries its `items` (helpers/guest-orders.js
// `attachItems`), so the quantity is derivable from what is on the wire.
//
// ⚠ CANCELLED sub-orders count for NEITHER figure — the same rule the server's
// own `totals` applies (`subOrderTotals`) and the same status predicate every
// guest aggregate in the backend uses. `count` is taken from `totals` rather than
// recomputed, so the number beside the quantity can never disagree with the
// host's "Objednávky kolegov" tab; only the quantity is derived here.
function summariseSubOrders(data) {
  const count = Number(data?.totals?.count)
  const orders = Array.isArray(data?.guest_orders) ? data.guest_orders : []
  let grams = 0
  let units = 0
  for (const order of orders) {
    if ((order?.status || 'submitted') === 'cancelled') continue
    for (const item of order?.items || []) {
      const quantity = Number(item?.quantity) || 0
      grams += (VARIANT_GRAMS[item?.variant] || 0) * quantity
      units += quantity
    }
  }
  return { count: Number.isFinite(count) ? count : 0, grams, units }
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

async function checkPendingVouchers() {
  try {
    const friendId = props.friendId || getFriendsAuthInfo()?.friendId
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

// ---------------------------------------------------------------------------
// Cycle card helpers
// ---------------------------------------------------------------------------

function goToCycle(cycleId) {
  router.push(`/cycle/${cycleId}`)
}

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
// weight — the same split the dropped line used.
function orderQuantityLabel(cycle) {
  if (cycle.type === 'bakery') return `${cycle.orderItemCount} ks`
  return formatKilos(cycle.orderKilos)
}

// The colleagues' quantity on the share row — the same bakery/coffee split the
// badge above uses, but fed by `guestSummaries` rather than by the cycle row.
//
// ⚠ Trailing zeros are STRIPPED here ("4 kg", not "4.00 kg"), which is the
// RD-FO-2 rule from FriendOrder's stock bar and NOT `formatKilos`. The two are
// fed from different units — `cycle.orderKilos` arrives as kilos from the API,
// this one is summed in GRAMS off the sub-order items — and the design canon for
// this row prints "4 kg". Empty string when there is nothing to show: the
// template appends this after a "· " separator, and " · 0 kg" next to a live
// colleague count would read as a failure rather than as "no weight yet" (the
// real case being a bakery-only cycle, or the count arriving without items).
function guestQuantityLabel(cycle) {
  const summary = guestSummaries.value[cycle.id]
  if (!summary) return ''
  if (cycle.type === 'bakery') return summary.units > 0 ? `${summary.units} ks` : ''
  if (!summary.grams) return ''
  return `${Math.round(summary.grams / 10) / 100} kg`
}

// Guest share link straight from the cycle list, so the host does not have to
// open a cycle first. Same dialog (and logic) as FriendOrder.vue.
function openShareDialog(cycle) {
  shareCycle.value = cycle
}

// ---------------------------------------------------------------------------
// Profile (UC-FL-009)
// ---------------------------------------------------------------------------

function openProfileModal() {
  // Its OWN ref, so nothing another action failed at can open in this banner —
  // the reason `error` is not reused here (RD-FL-8a item 4).
  profileError.value = ''
  profileName.value = props.friendName || ''
  profilePacketaAddress.value = props.friend?.packeta_address || ''
  // UC-FC-009: seeded per OPEN, from THIS session's hydrated friend — the
  // session-boundary rule (nothing may survive from a previous friend's edit).
  profilePhone.value = props.friend?.phone || ''
  profileEmail.value = props.friend?.email || ''
  profilePhoneOriginal.value = profilePhone.value
  profileEmailOriginal.value = profileEmail.value
  profilePacketaOriginal.value = profilePacketaAddress.value
  showProfileModal.value = true
}

async function saveProfile() {
  if (!profileName.value.trim()) return

  profileSaving.value = true
  // A retry must not leave the previous attempt's banner standing (RD-FL-3).
  profileError.value = ''
  try {
    const payload = {
      name: profileName.value.trim()
    }
    // FUP-T5: `packeta_address` rides along on the SAME rule as the contact
    // fields below — only when the friend actually changed it. Sending it
    // unconditionally meant a save from an UNHYDRATED modal (the field renders
    // empty until `hydrateCurrentFriend` lands) wrote `null` over a stored
    // address. An intentional clear is still a change, so it still travels as
    // `null` — never as `''`.
    if (profilePacketaAddress.value.trim() !== profilePacketaOriginal.value.trim()) {
      payload.packeta_address = profilePacketaAddress.value.trim() || null
    }
    // UC-FC-009: contact fields ride along ONLY when changed (trim() || null —
    // clearing is allowed, no confirm; the admin's "Bez e-mailu" badge is the
    // operational signal). Untouched fields stay absent, so an admin's
    // concurrent edit of them is not clobbered.
    if (profilePhone.value.trim() !== profilePhoneOriginal.value.trim()) {
      payload.phone = profilePhone.value.trim() || null
    }
    if (profileEmail.value.trim() !== profileEmailOriginal.value.trim()) {
      payload.email = profileEmail.value.trim() || null
    }
    const updated = await api.updateFriendProfile(props.friendId, payload)
    // The parent owns `currentFriend`, the login-list row and the stored display
    // name — all three outlive this component.
    emit('profile-saved', updated)
    showProfileModal.value = false
  } catch (e) {
    profileError.value = e.message
  } finally {
    profileSaving.value = false
  }
}

async function changePassword() {
  changePasswordError.value = ''
  changePasswordSuccess.value = ''

  // ⚠ 09 §UC-ML-008 — CONDITIONAL, because the field it guards is conditionally
  // hidden. On a magic-link session the friend by definition does not know the current
  // password, so demanding it client-side would make the waiver unreachable from the
  // one UI it exists for. The SERVER is authoritative regardless: it reads
  // `friend_sessions.via` itself, so a client that skipped this check without the
  // waiver still gets a 401 it renders in the banner below.
  if (!magicLinkSession.value && !changeCurrentPassword.value) {
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
    const result = await api.changeFriendPassword(props.friendId, changeCurrentPassword.value, changeNewPassword.value)

    if (result.token) {
      emit('token', { token: result.token, expiresAt: result.expiresAt })
    }

    // ⚠ 09 §UC-ML-008 — the change re-minted with NULL `via`, so the waiver is gone
    // server-side. Clearing it here in the same tick brings the "Aktuálne heslo" field
    // back and retires the prompt for good; the parent's `onToken` (already emitted
    // above) drops the matching flags from the stored payload, so a reload agrees.
    magicLinkSession.value = false

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

// ---------------------------------------------------------------------------
// Subscriptions (UC-FL-010)
// ---------------------------------------------------------------------------

function openSubscriptionModal() {
  subError.value = ''
  subCoffee.value = subscriptions.value.length === 0 || subscriptions.value.includes('coffee')
  subBakery.value = subscriptions.value.length === 0 || subscriptions.value.includes('bakery')
  showSubscriptionModal.value = true
}

async function saveSubscriptions() {
  subSaving.value = true
  // A retry must not leave the previous attempt's banner standing (RD-FL-3).
  subError.value = ''
  try {
    const types = []
    if (subCoffee.value) types.push('coffee')
    if (subBakery.value) types.push('bakery')
    await api.updateSubscriptions(props.friendId, types)
    subscriptions.value = types
    showSubscriptionModal.value = false
    // Reload cycles with new filter
    await loadCycles()
  } catch (e) {
    subError.value = e.message
  } finally {
    subSaving.value = false
  }
}

// ---------------------------------------------------------------------------
// Credential setup (transition mode)
// ---------------------------------------------------------------------------

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
    const result = await api.setupCredentials(props.friendId, username, setupPassword.value)

    // ⚠ This is the THIRD `onToken` emitter and — unlike `changePassword()` and
    // `submitForcedPasswordChange()` — it deliberately does NOT clear
    // `magicLinkSession` (09 §UC-ML-008). It cannot need to: §UC-ML-003 eligibility
    // requires a `password_hash`, so a magic-link session implies credentials already
    // exist, and `POST /friends/:id/setup-credentials` answers 409 in that case and
    // emits no token at all. Even if it were somehow reached, the parent's `onToken`
    // drops the stored flags anyway, so the two halves stay consistent — the local ref
    // would merely lag until the next load. Recorded rather than "fixed" so a future
    // reader does not mistake the asymmetry for an oversight. (ML-T6 review.)
    if (result.token) {
      emit('token', { token: result.token, expiresAt: result.expiresAt })
    }
    if (result.friend) {
      emit('friend-merged', result.friend)
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

// ---------------------------------------------------------------------------
// Forced password change (UC-FL-012)
// ---------------------------------------------------------------------------

// Non-dismissable: the friend must set their own password before using the app.
// The backend skips the current-password check when must_change_password is set,
// so we only collect the new password here — but the plaintext one they logged
// in with is still sent, exactly as before, read from the handshake payload.
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
      props.friendId,
      props.entry?.currentPassword || '',
      forcedNewPassword.value
    )
    if (result.token) {
      emit('token', { token: result.token, expiresAt: result.expiresAt })
    }
    forcedNewPassword.value = ''
    forcedNewPasswordConfirm.value = ''
    forcedPasswordChange.value = false
    // 09 §UC-ML-008: this change re-minted with NULL `via` too. `magicLinkSession` is
    // already false in the forced flow (see its seed), so this is belt-and-braces
    // against a future edit that loosens the seed — not a live state change.
    magicLinkSession.value = false
    // The parent drops the stashed plaintext password with this.
    emit('forced-complete')
  } catch (e) {
    forcedError.value = e.message
  } finally {
    forcedSaving.value = false
  }
}

// ---------------------------------------------------------------------------
// Invite (UC-FL-011)
// ---------------------------------------------------------------------------

async function openInviteModal() {
  const seq = ++inviteSeq
  showInviteModal.value = true
  inviteCode.value = ''
  inviteError.value = ''
  inviteLoading.value = true
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

// ⚠ `copyInviteLink()` and `inviteCopied` were DELETED (RD-FL-7). `NeoCopyRow`
// (UC-DS-011) owns the whole control now: the 2 s "Skopírované!" flip, restarting
// that window on a re-click, the clipboard write and its failure handling, and
// clearing the timer if the modal unmounts inside the window.

// ---------------------------------------------------------------------------
// The appbar lives in the PARENT (it renders in all three auth states as ONE
// instance that never remounts, UC-FL-001), but two of its controls act on this
// component. Exposed rather than lifted into props/emits: the alternative is a
// pair of "open this modal" booleans owned by the parent, which is precisely the
// session state this extraction exists to keep out of it.
// ---------------------------------------------------------------------------
defineExpose({ openProfileModal, openInviteModal })
</script>

<template>
  <!-- The voucher outcome banner keeps its own (untouched) look per UC-FL-001,
       but it must sit on the SAME geometry as the page column below it.
       Alignment only; nothing inside is restyled.

       ⚠ It renders from INSIDE the session component, which is what makes
       RD-FL-3's `voucherResolved` clear structural: its 5 s timeout is set at
       resolve time, so a logout inside that window used to leave "Kredit 4.20 €
       pridaný" standing on the LOGIN screen for whoever came next. There is
       nowhere for it to render now. -->
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

  <!-- Standard page column (UC-DS-005): 760px max, centered, 16px phone /
       28px desktop padding — on BOTH axes, matching the prototype, which pads
       the column uniformly. ⚠ The vertical half must stay split as
       `py-4 sm:py-7` and must NEVER be collapsed into `p-4 sm:p-7`: the cycle
       card below is pinned on the literal class token `p-4` (see `cardFor()`
       further down), so an all-sides utility here would make that locator match
       the column as well and trip Playwright strict mode. RD-FL-8b: was `py-6`
       (24px), which was 8px over on phone and 4px under on desktop. -->
  <div class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7">
    <!-- ⚠ The page-level error banner. After RD-FL-8a's convergence it has
         exactly ONE writer left — `resolveVoucher` — because the profile,
         subscription and invite failures each render in their own modal body
         (UC-FL-009/010/011). That is why the `&& !showProfileModal` suppression
         term is gone: with no shared writers there is nothing to suppress, and
         the term was a condition that had to grow by one clause per dialog.

         ⚠ Pre-existing and unchanged: the one writer it has is the one it cannot
         actually serve. The voucher modal is a hand-rolled `fixed inset-0 z-50
         bg-black/70` scrim with NO dismiss control, and `resolveVoucher` leaves
         `showVoucherModal` true on failure, so this banner renders underneath it
         and is only reachable once a retry succeeds — which clears it. Whichever
         row next touches the voucher modal owns giving it an in-modal error
         surface, after which this banner can be retired with its last writer. -->
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

    <!-- The magic-link prompt (09 §UC-ML-008).

         ⚠ PLAIN `.banner` — INFORMATIONAL, per 02 §UC-DS-013's semantic grammar.
         Not `danger`, not `warn`: the friend just logged in successfully and nothing
         is wrong. It is an invitation, and it is non-blocking by product decision
         (resolved conflict #4: a magic link is a LOGIN, not a reset — the old password
         keeps working until they change it).

         ⚠ Suppressed ENTIRELY in the forced flow — see `magicLinkSession`'s seed. That
         is not merely tidiness: 03 §UC-FL-012's gate is focus-trapped, so a banner
         behind it would be an unreachable control offering a choice the friend does
         not have. -->
    <div v-if="showMagicPrompt" class="banner mb-5" data-testid="magic-prompt">
      <span class="dot"></span>
      <div style="min-width:0;display:flex;flex-direction:column;gap:10px">
        <div>Prihlásenie cez e-mailový odkaz prebehlo úspešne. Chcete si nastaviť nové heslo?</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button
            type="button"
            class="btn sm dark"
            data-testid="magic-prompt-set"
            @click="openMagicPasswordChange"
          >
            Nastaviť nové heslo
          </button>
          <button
            type="button"
            class="btn ghost sm"
            data-testid="magic-prompt-dismiss"
            @click="dismissMagicPrompt"
          >
            Teraz nie
          </button>
        </div>
      </div>
    </div>

    <!-- Balance Card -->
    <FriendBalanceCard :friend-id="friendId" />

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
                 deliberately `px-4 sm:px-7 py-4 sm:py-7` and NOT `p-4`, or the
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
              <!-- ⚠ Noto Sans Condensed BOLD, not `.mono` (product decision
                   2026-08-13, extending the product-card brief to this screen).
                   `.mono` is REMOVED rather than overridden: leaving it on an
                   element rendered in a condensed sans would be a lie, and other
                   specs read `.mono` as "this is the mono face". `.sub` stays —
                   it carries the colour, and it is what keeps A10's
                   `line-height:normal` reaching this row now that `.mono` is gone.
                   `data-testid` exists because the shipped locators were
                   `.mono.sub` / `.mono` nth(1), which this change retires. -->
              <div
                v-if="cycle.expected_date"
                class="sub"
                data-testid="cycle-date"
                style="font-family:var(--font-cond);font-weight:700;font-size:14px;margin-top:7px;display:flex;align-items:center;gap:6px"
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
          <!-- ⚠ Noto Sans Condensed MEDIUM, not `.mono` — same decision as the date
               row above. The inline `line-height:1.7` is unchanged and still the only
               thing declaring it, so the A9/A10 invariant `portal-fidelity.spec.js`
               pins (12px × 1.7 = 20.4px) survives the class going away. -->
          <div
            v-if="cycle.plan_note"
            data-testid="cycle-plan"
            style="font-family:var(--font-cond);font-weight:500;font-size:13.5px;color:var(--ink-faint);margin-top:10px;line-height:1.7;white-space:pre-line;overflow-wrap:anywhere"
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
               into yet. It stays the card's LAST child, directly under the
               badge row, and keeps the whole affordance inside `div.p-4`.

               ⚠ resolved conflict #2 — the VISIBLE label is the prototype's
               "Zdieľať", while `aria-label="Zdieľať s kolegami"` carries the
               accessible name `guest-link.spec.js` locates the button by. Both
               contracts hold with zero spec edits; neither may be dropped in
               favour of the other.

               ⚠ `@click.stop` is mandatory, not stylistic: the card root
               navigates on click, so without it the share tap would leave the
               portal before the dialog could be seen (pinned — after the click
               the URL stays `/`).

               The left half is context only. `guestSummaries` is filled by a
               non-blocking, concurrency-capped batch; while it is in flight,
               has failed, or the host simply has no colleagues yet, the row
               reads "Objednávate aj pre kolegov?" — there is deliberately no
               loading or error state, because a missing count costs the host
               nothing.

               ⚠ The count is a DECLINED phrase plus the quantity ("3 kolegovia
               · 4 kg") on its own emphasised line, with "objednali cez váš
               odkaz" underneath — it replaces the `.tabbadge` chip and the
               single "N | kolegovia cez váš odkaz" line. The host's question
               here is how much coffee they are collecting for other people, and
               a bare count answers it only if every colleague buys one bag.
               `guestQuantityLabel` yields an empty string rather than "0 kg"
               when there is no weight to show (see it for why), so the "· "
               separator is conditional on the label, not on the count. -->
          <div
            v-if="cycle.status === 'open'"
            data-testid="share-row"
            style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;border-top:2px solid rgba(10,10,10,0.12);padding-top:12px"
          >
            <span class="sub" style="display:flex;flex-direction:column;gap:1px;min-width:0">
              <template v-if="guestSummaries[cycle.id]?.count > 0">
                <span
                  data-testid="share-row-count"
                  style="font-weight:700;font-size:15px;color:var(--ink);overflow-wrap:anywhere"
                >{{ colleaguesLabel(guestSummaries[cycle.id].count) }}<template v-if="guestQuantityLabel(cycle)"> · {{ guestQuantityLabel(cycle) }}</template></span>
                <span style="overflow-wrap:anywhere">objednali cez váš odkaz</span>
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
           URL, default closed — and re-created closed for the next session,
           because this whole component is. -->
      <div v-if="archivedCycles.length > 0">
        <!-- `.chev.open` is the theme's own rotate-90 + accent transition, so
             the rotation and the colour come from one class, not from
             Tailwind. Keyboard layer as on the gear: this toggle is the only
             route to the archived cycles.

             ⚠ `line-height:normal` is not in the prototype and is not
             decoration — this row and the archive row's name below are PLAIN
             TEXT with no theme class, so A10's class list cannot reach them and
             Tailwind preflight's `html{line-height:1.5}` applies. Measured
             canon-vs-port at 378 and 1180 px: this row 21 px against the canon's
             16, the row name 22.5 against 18. See friends-theme.css §A10,
             "WHAT THIS RULE STILL CANNOT REACH". -->
        <div
          role="button"
          tabindex="0"
          :aria-expanded="showArchive ? 'true' : 'false'"
          data-testid="archive-toggle"
          style="display:flex;align-items:center;gap:8px;margin-top:18px;cursor:pointer;font-weight:600;font-size:14px;line-height:normal;color:var(--ink-dim)"
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
              <div style="font-weight:700;font-size:15px;line-height:normal;overflow-wrap:anywhere">{{ cycle.name }}</div>
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
       `.m-body` is already `flex-direction:column; gap:12px`, so the children
       need no wrapper and no spacing of their own. -->
  <NeoModal
    v-if="showSubscriptionModal"
    title="Nastavenia odberu"
    @close="showSubscriptionModal = false"
  >
    <!-- ⚠ This modal's OWN failure surface (RD-FL-8a item 4), and it is not
         cosmetic. `saveSubscriptions()` leaves the dialog OPEN on failure, so
         before this the message went to the page banner — which renders BEHIND
         the scrim, with its dismiss × unreachable. The user saw a modal that had
         simply "did nothing". Same `.banner.danger.slim` grammar the profile
         modal and the modern login card use (02 §UC-DS-013). -->
    <div v-if="subError" class="banner danger slim">
      <span class="dot"></span>
      <div style="min-width:0">{{ subError }}</div>
    </div>

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
       the half-typed form away. See the UC-DS-010 amendment. -->
  <NeoModal
    v-if="showProfileModal"
    title="Upraviť profil"
    @close="showProfileModal = false"
  >
    <!-- ⚠ `profileError`, this modal's OWN ref (RD-FL-8a item 4). It used to
         render the shared page-level `error` while SUPPRESSING the page banner
         (`error && !showProfileModal`) — one surface at a time, but at the cost
         of a suppression term per dialog and of any other writer being able to
         put a message here that this modal's save never produced. UC-FL-009
         scopes the in-modal banner to `saveProfile()`'s own errors; it is scoped
         by construction now rather than by reachability. -->
    <div v-if="profileError" class="banner danger slim">
      <span class="dot"></span>
      <div style="min-width:0">{{ profileError }}</div>
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
          <div class="val" aria-labelledby="pp-profile-uid-lbl" data-testid="profile-uid">{{ friendUid }}</div>
        </div>
      </div>
      <!-- Username renders only when there IS one: legacy friends have no
           credentials at all (repo behavior beats the prototype's demo
           friend, who always does). -->
      <div v-if="friend?.username">
        <label id="pp-profile-username-lbl" class="field-lbl">Užívateľské meno</label>
        <div class="copyrow">
          <div class="val" aria-labelledby="pp-profile-username-lbl" data-testid="profile-username">{{ friend.username }}</div>
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

    <!-- UC-FC-009: the friend's own contact data. Mobil keeps its format-example
         placeholder (a format example, not a label substitute — the admin modal
         does the same); Email has NO placeholder (the 2026-08-10 no-placeholder
         login decision) and carries the vy-form recovery hint verbatim.
         `maxlength` mirrors the server bounds (MAX_PHONE_LENGTH 32 /
         MAX_EMAIL_LENGTH 160 — the GSO-T3 mirror convention). -->
    <div>
      <label class="field-lbl" for="pp-profile-phone">Mobil</label>
      <input
        id="pp-profile-phone"
        v-model="profilePhone"
        class="inp"
        maxlength="32"
        placeholder="+421 900 000 000"
        :disabled="profileSaving"
      />
    </div>

    <div>
      <label class="field-lbl" for="pp-profile-email">Email</label>
      <input
        id="pp-profile-email"
        v-model="profileEmail"
        class="inp"
        type="email"
        maxlength="160"
        :disabled="profileSaving"
      />
      <div class="field-help">Bez e-mailu vám nevieme poslať odkaz na obnovenie prístupu.</div>
    </div>

    <!-- Password-change fold — only for friends who HAVE a password (repo
         behavior; a legacy shared-password friend has nothing to change). -->
    <div
      v-if="friend?.hasCredentials"
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

        <!-- ⚠ 09 §UC-ML-008 — CONDITIONALLY HIDDEN, never removed. A friend who came
             in on a magic link does not know this password; that is why they used the
             link. `portal-profile-modal.spec.js` pins this modal heavily and passes
             UNCHANGED precisely because `magicLinkSession` is false on every
             password-login session, so that spec renders the byte-identical markup it
             always did. Only a redeemed session sees the difference. -->
        <div v-if="!magicLinkSession">
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
        <!-- ⚠ The `!changeCurrentPassword` term drops WITH the field (§UC-ML-008).
             Leaving it in would leave the submit permanently disabled on exactly the
             sessions the waiver exists for — the form would render and never submit. -->
        <button
          type="button"
          class="btn sm dark"
          :disabled="changePasswordSaving || (!magicLinkSession && !changeCurrentPassword) || !changeNewPassword || !changeNewPasswordConfirm"
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

  <!-- Credential setup (transition mode) — the LAST radix dialog on the friend
       surface, now on the house shell. This file imports nothing from
       `@/components/ui/*` any more.

       ⚠ NO CANON SCREEN EXISTS for it: the prototype has no transition mode.
       Everything below is the profile modal's vocabulary
       (`.banner danger slim` + `.dot`, `.field-lbl` + `.inp` + `.field-help`,
       `.btn` / `.btn accent` in `#footer`) applied 1:1 — no new theme class, and
       `friends-theme.css` is untouched.

       ⚠ BEHAVIOUR IS FROZEN. Validation, the debounced availability check and
       its three messages, the disabled predicate, `@keyup.enter` and all three
       button labels are byte-identical to the radix version. Two SECURITY specs
       drive this dialog — `portal-profile-modal.spec.js:772` ("must not open
       pre-filled with the previous friend's credentials") and
       `portal-session-boundary.spec.js:430` ("the AUTO-RAISED credential-setup
       dialog is part of that surface") — because it AUTO-RAISES for any
       transition-mode friend without credentials, so a leaked field shows one
       friend another's plaintext password.

       ⚠ `title-heading` is not cosmetic: those specs resolve this dialog with
       `getByRole('heading', { name: 'Nastavte si osobné prihlásenie' })`, and
       `NeoModal`'s `.m-title` is a `<div>` by default. See the prop's note in
       `NeoModal.vue`.

       ⚠ `v-if`, not an `:open` prop — the shell has none, and an always-mounted
       modal would park a second `role="dialog"` (plus a click-swallowing scrim)
       on every portal screen. Esc and × both route to `@close`, which is what
       keeps the boundary spec's "Esc — the escape hatch the disabled footer does
       not close off" path alive while `setupSaving` is true.

       ⚠ The password placeholder says "Minimálne 4 znaky" while
       `saveCredentials()` rejects anything under 8. That is a shipped
       inconsistency the boundary spec explicitly leans on ("not this row's to
       fix"); the string stays verbatim. -->
  <NeoModal
    v-if="showCredentialSetup"
    title="Nastavte si osobné prihlásenie"
    title-heading
    @close="showCredentialSetup = false"
  >
    <div class="sub">
      Nastavte si vlastné užívateľské meno a heslo pre bezpečnejšie prihlasovanie.
    </div>

    <div v-if="setupError" class="banner danger slim">
      <span class="dot"></span>
      <div style="min-width:0">{{ setupError }}</div>
    </div>

    <div>
      <label class="field-lbl" for="pp-setup-username">Užívateľské meno</label>
      <input
        id="pp-setup-username"
        v-model="setupUsername"
        class="inp"
        type="text"
        placeholder="napr. janko_hrasko"
        autocapitalize="none"
        autocorrect="off"
        :disabled="setupSaving"
        @input="checkUsernameAvailability"
      />
      <!-- The live-availability triple. `.field-help` is A10-covered, so the two
           coloured variants need no call-site `line-height`; the colours are the
           theme tokens `FriendBalanceCard` already uses for money-good/money-bad,
           not Tailwind's palette. -->
      <div v-if="usernameChecking" class="field-help">Overujem dostupnosť...</div>
      <div v-else-if="usernameAvailable === true" class="field-help" style="color:var(--ok-deep);font-weight:700">Užívateľské meno je voľné</div>
      <div v-else-if="usernameAvailable === false" class="field-help" style="color:var(--danger);font-weight:700">Toto meno je už obsadené</div>
      <div class="field-help">Len malé písmená, čísla, bodka (.), podtržník (_) a pomlčka (-). Min. 3 znaky.</div>
    </div>

    <div>
      <label class="field-lbl" for="pp-setup-password">Heslo</label>
      <input
        id="pp-setup-password"
        v-model="setupPassword"
        class="inp"
        type="password"
        placeholder="Minimálne 4 znaky"
        :disabled="setupSaving"
      />
    </div>

    <div>
      <label class="field-lbl" for="pp-setup-password-confirm">Potvrdiť heslo</label>
      <input
        id="pp-setup-password-confirm"
        v-model="setupPasswordConfirm"
        class="inp"
        type="password"
        placeholder="Zopakujte heslo"
        :disabled="setupSaving"
        @keyup.enter="saveCredentials()"
      />
    </div>

    <template #footer>
      <button
        type="button"
        class="btn"
        :disabled="setupSaving"
        @click="showCredentialSetup = false"
      >
        Neskôr
      </button>
      <button
        type="button"
        class="btn accent"
        :disabled="setupSaving || !setupUsername || !setupPassword || !setupPasswordConfirm || usernameAvailable === false"
        @click="saveCredentials()"
      >
        {{ setupSaving ? 'Ukladám...' : 'Nastaviť' }}
      </button>
    </template>
  </NeoModal>

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
</template>
