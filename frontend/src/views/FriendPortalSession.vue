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

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api, { getFriendsAuthInfo } from '../api'
// 10 §UC-GA-012 — the ONE home for the GIS script. Never a second injector.
import { loadGis } from '../lib/gis'
// ⚠ No `@/components/ui/*` import remains in this file. The credential-setup
// dialog was the last radix consumer on the authenticated friend surface; it now
// composes on `NeoModal`, so `Input`/`Label`/`Button`/`Alert`/`Dialog*` are gone.
// UC-DS-004 rule 4 keeps radix ADMIN-only — do not re-introduce one here.
import { fmtEur, roundMoney, isInDebt } from '@/lib/money'
import { VARIANT_GRAMS } from '@/lib/guest-cart'
import { colleaguesLabel, ordersAccusativeLabel, weeksLabel } from '@/lib/plural'
import { kgLabel } from '@/lib/kg'
// 18 §UC-PI-002 — the SHORT date forms. A date standing alone (here: the drawer's
// „Otvorené do …“ sub-line) comes from `lib/dates.js`; a date inside one of module
// 17's composed sentences comes from `cycle-stages.js` (PI-T1 §1).
import { fmtDate, fmtDayMonth, fmtWeekdayDayMonth, weeksUntil } from '@/lib/dates'
// 18 §UC-PI-002 — the ONE home of "which round is this landing about, and in what
// state". Never re-derive open/locked/closed beside it.
import { resolveLanding, nextTextIsNote } from '@/lib/portal-state'
// 18 §UC-PI-008/010 — the money surfaces (PI-T7).
//
// ⚠⚠ ONE TRIGGER, ONE MOUNT, and this import block is where that is enforced.
// `FriendBalanceCard.vue` is module 03's card RE-PURPOSED into the „Zostatok
// a platby“ view: it owns the one `data-testid="pay-balance"` control and now takes
// the balance as PROPS instead of fetching it. `DebtBanner.vue` is the landing's
// §UC-PI-008 banner, mounted at three call sites (one per landing state) with the
// `isInDebt()` (`lib/money.js`, the ONE home since the PI-T7 review) inside it. Neither mounts a `PaymentModal`: this file
// mounts exactly ONE for the balance, at the bottom of the template, and both
// surfaces open it through `openBalancePayment()`. A second mount would give „what
// does this friend owe" two homes that can disagree — see `FriendBalanceCard`'s
// header and CLAUDE.md §Money & data.
import FriendBalanceCard from '@/components/FriendBalanceCard.vue'
import FriendTransactionList from '@/components/FriendTransactionList.vue'
import DebtBanner from '@/components/DebtBanner.vue'
import PaymentModal from '@/components/PaymentModal.vue'
// 18 §UC-PI-005 — the landing IS the order screen. `FriendOrder.vue` is the ONE home
// of that surface and is mounted here in `mode="landing"`; it is never forked, and no
// slice of it is copied into this file. It also owns the only `GuestShareDialog`
// instance on the friend surface (§UC-PI-011) — this view used to mount a SECOND one
// for the cycle card's share row, and that instance is gone with the card.
import FriendOrder from '@/views/FriendOrder.vue'
// 18 §UC-PI-006 — the closed landing's state modal. Parametrised (title / intro /
// lead are props) because PI-T5 mounts the SAME component for §UC-PI-007's
// „locked, no own order" variant; a second modal would be the defect.
import LandingStateModal from '@/components/LandingStateModal.vue'
// 18 §UC-PI-007 — the LOCKED landing's own-order card and „Kde je vaša káva".
// ⚠ `CartLineList` is THE one home for an ordered-items list (product decision
// 2026-08-12) and `CycleTimeline` is module 17's ONE rendering of the six steps
// (17 §UC-CS-006). Both are mounted here, neither is forked, and this view builds
// no step array of its own — it hands `:cycle` over and 17 decides which step is
// „now".
import CartLineList from '@/components/CartLineList.vue'
import CycleTimeline from '@/components/CycleTimeline.vue'
// 18 §UC-PI-009 — „Moje objednávky". `lib/order-lines.js` is the ONE home of the
// mapping from a server `order_items` row into `CartLineList`'s line shape (PI-T5
// hoisted it out of `FriendOrder.vue` naming this view as its second consumer);
// `lib/history-badges.js` is the ONE home of the SHORT badge words — a sanctioned
// SECOND vocabulary beside module 17's long timeline labels, argued at length in
// that file's header. Do not replace it with `cycle-stages.js STEPS`.
import { deliveryExtras, orderLines } from '@/lib/order-lines'
import { historyBadge } from '@/lib/history-badges'
// 18 §UC-PI-012 — „Ako to funguje". The whole view is ONE component with an
// `asGate` prop, because PI-T9 (§UC-PI-013) reuses this exact page as the
// first-login gate and a second copy with a checkbox on it is the defect that row
// would otherwise create. ⚠ It deliberately does NOT mount `CycleTimeline`: the
// explainer describes the process in general, the timeline reports where ONE round
// is now (argued in that component's header).
import PortalExplainer from '@/components/PortalExplainer.vue'
import { STANDING_GUEST_LINK } from '@/lib/features'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoModal from '@/components/neo/NeoModal.vue'
import NeoCopyRow from '@/components/neo/NeoCopyRow.vue'
import NeoDrawer from '@/components/neo/NeoDrawer.vue'

const router = useRouter()
const route = useRoute()

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
  // ⚠ FUP-T20: there is no `friendUid` prop any more. Its only consumer was the
  // profile modal's read-only `Jedinečné ID` box, which that row removed; the uid
  // still lives in the stored session and on the admin's own surfaces.
  // ⚠ What the AUTH HANDSHAKE produced, handed over once at mount:
  //   · `cycles`  — the payload of the probe request the parent already made to
  //     validate the token (`GET /friends/cycles`). Seeding from it is what
  //     keeps a login at ONE cycles request rather than two.
  //   · `mustChangePassword` + `currentPassword` — UC-FL-012's forced gate. The
  //     plaintext password stays the PARENT's (it is a login credential, and the
  //     parent already holds it in `password`/`loginPassword`); this component
  //     reads it at submit time and never copies it into a ref of its own.
  //   · `needsCredentialSetup` — transition mode, `hasCredentials === false`.
  //   · `googleLinked` + `googlePromptDismissed` — 10 §UC-GA-006. ⚠ These may be
  //     ABSENT, and absence is meaningful: see `googlePromptEligible` below.
  //   · `explainerPending` — 18 §UC-PI-013. TRUE only on a LOGIN whose friend has
  //     never acknowledged „Ako to funguje"; a restore never sets it. Read ONCE, at
  //     mount, into `explainerGate` below — it is a one-shot instruction, not state.
  //   · `freshLogin` — 18 §UC-PI-015 (PI-T10). TRUE on a LOGIN, absent on a restore,
  //     same boundary as `explainerPending` and for the same stated reason. Read ONCE
  //     into `profileAutoOpenArmed`; it carries NO phone number (none of the login
  //     payloads does), so the auto-open waits on `hydrateCurrentFriend`.
  entry: { type: Object, default: () => ({}) },
  // ⚠ CONFIGURATION, not handshake state — the parent's two `GET /friends/auth-mode`
  // values, passed down rather than re-fetched. They are props (not `entry` keys)
  // because they belong to the DEPLOYMENT, not to this login: `entry` dies with the
  // session by design, and these two are identical for every friend on the device.
  authMode: { type: String, default: 'legacy' },
  googleClientId: { type: String, default: null },
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
  // 18 §UC-PI-004 — the drawer's „Odhlásiť sa“ footer. An EMIT, not a call: ending a
  // session means clearing the credential store, localStorage and the identity the
  // appbar renders, all of which are the parent's (`switchUser()`, and its header
  // explains why those three cannot move here). This component only asks.
  'logout',
])

// ---------------------------------------------------------------------------
// Cycle list
// ---------------------------------------------------------------------------

// Seeded from the handshake, so the first paint needs no request of its own.
const cycles = ref(Array.isArray(props.entry?.cycles) ? props.entry.cycles : [])

// ⚠ RETIRED BY PI-T3 (18 §UC-PI-005/016), listed so nothing reads the gap as an
// oversight: `showArchive` (the UC-FL-008 fold), `subscriptions` (the gear's seed —
// the COLUMN and `GET/PUT /api/subscriptions/friend/:id` are KEPT, only the UI is
// gone, §UC-PI-016) and `guestSummaries` (the per-card colleague MAP). The landing
// has one round, so there is one count, below.

// The colleagues who ordered through this friend's link IN THE CURRENT OPEN ROUND —
// `{ count, grams }`, or `null` for "not loaded, still loading, or failed".
//
// ⚠ 18 §UC-PI-004 item 4: „ONE `GET /guest-links/cycle/:id` for the current open
// cycle". Module 03 fanned this out over EVERY open cycle behind a 3-at-a-time
// concurrency cap, because the e2e database reaches 135 open rounds and an
// unbounded `Promise.all` starved the portal's own requests behind the browser's
// 6-connection limit. The landing resolves exactly one round, so the fan-out — and
// the cap that bounded it — are gone: the bound is now ONE, which is the stronger
// form of the same property and is pinned as such in `portal-menu.spec.js`.
//
// CONTEXT ONLY: nothing is gated on it. A failure renders the „Pošlite odkaz
// kolegom" sub-line, which is also the not-yet-loaded copy — never an error banner.
const colleagues = ref(null)

// ⚠ Sequence guard for that fetch — the GSO-T2 `loadSeq` rule, KEPT although the
// fan-out it was written for is gone. A count is another friend's colleague data.
//
// ⚠ TWO HALVES, AND ONLY ONE OF THEM IS REACHABLE TODAY — said out loud rather
// than left to be discovered:
//   · CROSS-SESSION is structural: the parent's `v-if` + `:key` DESTROYS this
//     component on logout, so a response still in flight lands on a dead instance
//     and can write nothing. `portal-menu.spec.js` pins it in both directions.
//   · IN-SESSION was reachable through `loadCycles()`, whose ONLY caller was
//     `saveSubscriptions()` — retired here with the gear (§UC-PI-016). With one
//     cycles load per session there is no second batch to supersede, so this
//     counter's live job is the `onBeforeUnmount` bump alone. It stays because the
//     next in-session reloader (a post-submit `hasOrder` refresh, PI-T6's history)
//     would otherwise reintroduce the race silently; nothing can red it today, and
//     no test pretends otherwise.
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

// ⚠ The subscription modal's five refs are RETIRED (§UC-PI-016): bakery is retiring,
// so the cycle-type filter has nothing left to filter. The table, the two routes and
// `GET /friends/cycles`'s SERVER-side filter all stay — no schema change, no route
// removal, no data deleted.

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

// First password (inside the profile modal) — GA-T11, 10 §UC-GA-007.
//
// ⚠ THE FOLD ABOVE IS HIDDEN FOR EXACTLY THE PEOPLE WHO NEED THIS ONE. It is keyed on
// `hasCredentials`, so a friend with no `password_hash` sees no password control at
// all; `showCredentialSetup` below only fires in TRANSITION mode, and the forced gate
// only when an admin reset a password that exists. For one whole module that left a
// credential-less friend with no on-screen way to get a password (`PUT
// /:id/change-password` 400s for them — it changes a password, and there is none).
// `POST /friends/:id/set-password` is the route that closes it.
//
// ⚠ Session-scoped by construction, like every ref in this file: the parent's `v-if`
// destroys this instance on logout, so the typed password cannot survive into the next
// person's dialog — the RD-FL-6 leak, restated. No module scope, no localStorage.
const showPasswordSet = ref(false)
const firstUsername = ref('')
const firstPassword = ref('')
const firstPasswordConfirm = ref('')
const firstPasswordError = ref('')
const firstPasswordSaving = ref(false)

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

// ---------------------------------------------------------------------------
// Google link prompt (10 §UC-GA-006)
// ---------------------------------------------------------------------------

// ⚠⚠ THE TRIGGER, and every term in it is load-bearing.
//
// STRICT `=== false`, never `!props.entry?.googleLinked`. The two fields are ABSENT on
// every handshake that is not a fresh non-Google modern login (see `beginSession`'s
// note in `FriendPortal.vue`), and `!undefined` is `true` — a truthiness test would
// open this modal for a friend who is ALREADY LINKED, on top of ML-T6's magic prompt,
// which is precisely the "one modal per login, maximum" §UC-GA-006 forbids. The
// omission upstream IS the enforcement mechanism.
//
// ⚠ `authMode === 'modern'` is NOT in §UC-GA-006's literal condition and is required
// anyway: GA-T5 put a modern-only guard on `PUT /:id/google-link` (409
// `field:'auth_mode'`), so on a legacy/transition deployment the spec's own condition
// would offer a link whose every attempt 409s. The spec predates that guard.
//
// ⚠ The blocking gates are the "one modal per login" rule: when either fired, the
// prompt SKIPS this login entirely rather than queueing behind it. Reading them from
// the SEED (not reactively) is what makes that true — `forcedPasswordChange` clears
// itself when the friend satisfies the gate, and a reactive read would pop this modal
// open at that exact moment.
//
// ⚠ SESSION BOUNDARY (§UC-GA-006, restated as a requirement after this file's six
// leaks): everything below is `ref`s seeded ONCE at setup from the handshake. NO
// module-level state, NO localStorage, NO state keyed on the friend id — the component
// is keyed on the auth handshake (`:key="sessionSeq"`), so a "Teraz nie" dies with the
// session and the next friend on this device gets their own decision. `<script setup>`
// compiles into `setup()`, so these consts are genuinely per-instance (the ML-T3
// hazard, working FOR us here) — do not "fix" them into a plain `<script>` block.
// ⚠ ACCEPTED RESIDUAL — the voucher overlay, and why it is NOT fixed here. GA-T7 will
// face the same temptation, so the reasoning lives with the seed rather than in a
// commit message.
//
// `onMounted` awaits `checkPendingVouchers()`, which raises `showVoucherModal` with NO
// user action. That overlay is a hand-rolled `fixed inset-0 z-50` teleport while
// `NeoModal`'s `.modal-layer` is `z-index: 200`, so a friend who is unlinked,
// un-dismissed AND has a pending voucher gets this prompt painted OVER the voucher
// modal, whose buttons stay unreachable behind our scrim until the prompt is closed.
// Recoverable (close the prompt and the voucher is there), and it needs both
// conditions to coincide.
//
// The obvious fix — a `!hasPendingVoucher` term — is the one thing that must not be
// done: the voucher check is ASYNC, so the term could only be evaluated after it
// resolves, which turns this seed into a `watch`. SEEDED-ONCE-AT-SETUP is precisely
// what makes the session boundary safe here (the six leaks in this file were all state
// that outlived or re-evaluated across a handshake), and a `watch` reintroduces the
// async-flush hazard for a z-order overlap. Wrong trade; leave it.
const googlePromptEligible = ref(
  !!props.googleClientId &&
  props.authMode === 'modern' &&
  props.entry?.googleLinked === false &&
  props.entry?.googlePromptDismissed === false &&
  !props.entry?.mustChangePassword &&
  !props.entry?.needsCredentialSetup
)

// "Teraz nie" (and the ×, and a completed link) live here — CLIENT-SIDE ONLY, no
// server write, so the prompt may return at the next login (§UC-GA-006).
const googlePromptClosed = ref(false)

const showGooglePrompt = computed(() => googlePromptEligible.value && !googlePromptClosed.value)

// 'ask' → the three options · 'link' → the GIS button · 'done' → the linked address.
const googlePromptStage = ref('ask')
const googlePromptButtonEl = ref(null)
const googlePromptBusy = ref(false)
// ONE error surface for this action (the RD-FL-8a rule): the 409 renders HERE,
// verbatim from the server, and never in the page banner behind the scrim.
const googleLinkError = ref('')
const googleLinkedEmail = ref('')

function closeGooglePrompt() {
  googlePromptClosed.value = true
}

/** "Áno, teraz" — swap the body to Google's own button (§UC-GA-006). */
async function startGoogleLink() {
  googleLinkError.value = ''
  googlePromptStage.value = 'link'
  await nextTick()

  let gis
  try {
    gis = await loadGis(props.googleClientId)
  } catch {
    // ⚠ NOT silent, unlike the login card's loader. There the friend still has the
    // password form in front of them; here they asked for exactly one thing and an
    // empty box would be the whole answer. `loadGis` is timeout-bounded, so this
    // branch is reached in bounded time.
    googleLinkError.value = 'Google sa nepodarilo načítať. Skúste to prosím neskôr.'
    googlePromptStage.value = 'ask'
    return
  }
  if (!gis) return

  // ⚠ RE-READ after the await: the friend may have closed the modal while the script
  // was in flight, in which case `googlePromptButtonEl` is null and `renderButton`
  // would throw.
  await nextTick()
  const el = googlePromptButtonEl.value
  if (!el || googlePromptStage.value !== 'link') return

  // ⚠ Unconditional, and it takes over GIS's ONE global callback. That is why
  // `beginSession()` resets the parent's `googleInitialised` — otherwise the login
  // card after a logout would render a button wired to this unmounted component.
  gis.initialize({ client_id: props.googleClientId, callback: onGoogleLinkCredential })
  el.innerHTML = ''
  gis.renderButton(el, {
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'rectangular',
    logo_alignment: 'center',
    locale: 'sk',
    // Same clamp as the login card: GIS caps at 400 and refuses anything under 200.
    width: Math.max(200, Math.min(Math.round(el.clientWidth) || 320, 400)),
  })
}

/**
 * The GIS credential, handed to the friend-owned link route (§UC-GA-004).
 *
 * ⚠ NO RETRY LOOP (§UC-GA-006). A 409 means the account belongs to someone else —
 * re-firing the same credential can only produce the same answer, so the message is
 * rendered inline and the modal stays open for the friend to decide.
 */
async function onGoogleLinkCredential(response) {
  const credential = response && response.credential
  if (!credential) return

  googleLinkError.value = ''
  googlePromptBusy.value = true
  try {
    const result = await api.linkFriendGoogle(props.friendId, credential)
    googleLinkedEmail.value = result.googleEmail || ''
    // ⚠ DELIBERATE DEVIATION from §UC-GA-006, which says success "shows the linked
    // `google_email` + closes". It shows it and waits for an explicit `Zavrieť`: an
    // auto-close flashes the one confirmation the friend ever gets for this action,
    // and it would race any assertion that the address was displayed at all. The
    // clause's intent — the prompt does not linger as an offer once it has been
    // taken — is met by the three options being REMOVED in this stage.
    googlePromptStage.value = 'done'
    // ⚠ GA-T7 DISCHARGES THIS SEAM'S FIRST OBLIGATION, right here: the profile
    // section reads the SAME session-scoped state, so a link taken from the prompt
    // must show up there without a reload (§UC-GA-007's "stays consistent within the
    // session"). The second obligation — the unconditional `initialize()` — is
    // discharged in `mountGoogleProfileButton()` below.
    googleLinkedInSession.value = true
    googleEmailInSession.value = result.googleEmail || ''
    // ⚠ Seam for GA-T7 (§UC-GA-007), TWO obligations:
    //   1. The profile modal's Google section links and unlinks the SAME friend within
    //      this session, and §UC-GA-007 requires the two to agree. When it lands, the
    //      handshake-scoped "is this friend linked" state it introduces must be
    //      written here too.
    //   2. ⚠ That section must call `gis.initialize()` UNCONDITIONALLY before its
    //      `renderButton`, exactly as `startGoogleLink()` does — never behind a
    //      "already initialised" flag. GIS keeps ONE global callback, and the profile
    //      modal and this prompt can both exist within a single session, so whichever
    //      rendered last owns it. That is the same hazard `beginSession()`'s
    //      `googleInitialised = false` reset covers for the login card.
  } catch (e) {
    // The server's own sentence, verbatim — §UC-GA-004's 409 says nothing about WHICH
    // friend holds the account, and a rewrite here could only make that worse.
    googleLinkError.value = e.message
  } finally {
    googlePromptBusy.value = false
  }
}

/** "Už sa nepýtať" — the one option that writes (§UC-GA-004, one-way by design). */
async function dismissGooglePromptForever() {
  googleLinkError.value = ''
  googlePromptBusy.value = true
  try {
    await api.dismissGooglePrompt(props.friendId)
    closeGooglePrompt()
  } catch (e) {
    // Keep the modal open on failure: closing it would claim a persistence that did
    // not happen, and the prompt would then be back at the next login with no
    // explanation.
    googleLinkError.value = e.message
  } finally {
    googlePromptBusy.value = false
  }
}

// ---------------------------------------------------------------------------
// First-password fold in the profile modal (GA-T11, 10 §UC-GA-007)
// ---------------------------------------------------------------------------

// ⚠ STRICT `=== false`, never `!props.friend?.hasCredentials` — the same trap
// `googlePromptEligible` and `googleNoPassword` document. `hasCredentials` is ABSENT
// until the owner-scoped profile fetch lands (and absent for good on a stubbed or
// failed hydrate), and `!undefined` is `true`, which would offer a first-password form
// to a friend who has a perfectly good password — and whose every submit the server
// would then 409. Absence means "not known", not "no password".
//
// ⚠ AND THE MODE TERM IS NOT DECORATION: `POST /:id/set-password` answers 409
// `field: 'auth_mode'` outside modern mode, deliberately (a shared password can mint
// anybody's session there, so minting a credential is credential PLANTING). Offering
// the fold on a legacy or transition deployment would offer a form every attempt
// refuses. Transition mode already has its own answer — `needsCredentialSetup` raises
// the credential-setup dialog, which calls `setup-credentials` and works there.
const canSetFirstPassword = computed(
  () => props.friend?.hasCredentials === false && props.authMode === 'modern'
)

// Whether the form must also ask for a name to log in with — DERIVED, never assumed,
// because a friend who reaches this fold may well already have one: admin
// `PUT /:id/admin-username` writes `friends.username` without touching
// `password_hash`, and it is the only writer that does (GA-T11's corrected
// reachability finding). So both states are real, and the field renders only for the
// one that needs it. The server decides the same thing independently: it honours a
// supplied username only while the column is NULL, and never as a rename (FUP-T20).
const firstNeedsUsername = computed(() => canSetFirstPassword.value && !props.friend?.username)

// ---------------------------------------------------------------------------
// Google section in the profile modal (10 §UC-GA-007)
// ---------------------------------------------------------------------------
//
// The always-available MANUAL trigger, as opposed to the once-per-login prompt above.
// It shares that prompt's state and its hazards; what is new here is the unlink.
//
// ⚠ SESSION BOUNDARY (§UC-GA-006, which §UC-GA-007 says applies identically). This is
// the ONE piece of "is this friend linked" state in this component, seeded ONCE at
// setup from the handshake and written by BOTH surfaces (the prompt and this section),
// which is what keeps them consistent within a session. Per-instance `ref`s in a
// `<script setup>` that is keyed on the handshake — NO module scope, NO localStorage,
// NO map keyed on the friend id. A link made by friend A must not make friend B look
// linked on this same page, and A's unlink must not un-link B.
//
// `null` = "this session has not decided", which is the honest state on a session
// RESTORE and a magic-link login — neither publishes the two Google fields (the strict
// `=== false` note above says why the omission is deliberate). The display then follows
// the owner-scoped profile fetch (`props.friend`, hydrated by the parent under its own
// sessionSeq guard), exactly as `hasCredentials`/`username` already do in this modal.
const googleLinkedInSession = ref(
  typeof props.entry?.googleLinked === 'boolean' ? props.entry.googleLinked : null
)
const googleEmailInSession = ref('')

const googleSectionLinked = computed(() => (
  googleLinkedInSession.value === null
    ? !!props.friend?.googleLinked
    : googleLinkedInSession.value
))
// Only meaningful while linked. The handshake carries no address (§UC-GA-003 publishes
// `googleLinked` alone), so a seeded-true session falls through to the profile fetch
// until an action in this session produces one.
const googleSectionEmail = computed(() => (
  googleSectionLinked.value
    ? (googleEmailInSession.value || props.friend?.google_email || '')
    : ''
))

// ⚠⚠ THE MODE GATE IS ON THE *LINK* HALF ONLY, and the asymmetry is the whole point.
//
// GA-T5's `field:'auth_mode'` 409 guards `PUT /:id/google-link` — and nothing else.
// `DELETE /:id/google-link` (`friends.js:1295`) carries NO mode guard and works on
// every deployment. So gating the whole section on modern mode (as this row first
// shipped) would take a linked friend's self-service UNLINK away on a legacy or
// transition deployment — a capability §UC-GA-007 grants and the server still honours
// — for a reason that applies only to the other half. That state is reachable: a
// deployment can roll modern back to transition after friends have already linked.
//
// Hence: OFFERING a link needs modern mode, because otherwise every attempt 409s;
// SEVERING one needs only a client id, because the endpoint accepts it.
const googleCanLink = computed(
  () => !!props.googleClientId && props.authMode === 'modern'
)

// The section renders when it has something to say: an existing link to show and
// sever, or (in modern mode) an offer to make. An unlinked friend outside modern mode
// gets no trace — a bare "Google" heading over nothing is worse than absence, and
// §UC-GA-007's "unconfigured deployments show no trace" spirit covers it.
const googleSectionVisible = computed(
  () => !!props.googleClientId && (googleSectionLinked.value || googleCanLink.value)
)

// ⚠ The no-password warning, driven by EITHER of §UC-GA-007's two sources. STRICT
// `=== false` on the client half: `hasCredentials` is absent until the profile fetch
// lands, and `!undefined` would cry wolf at a friend who has a perfectly good password
// (the same trap `googlePromptEligible` documents). The server half is the backstop —
// GA-T5 answers `warning: 'no_password'` on the unlink itself, which covers the case
// where this client never learned the friend's credential state at all.
const googleUnlinkWarned = ref(false)
const googleNoPassword = computed(
  () => googleUnlinkWarned.value || props.friend?.hasCredentials === false
)

// The confirm §UC-GA-007 requires, inline in the section rather than a second modal —
// the `GuestShareDialog` regenerate precedent. A NeoModal on top of a NeoModal would
// stack two `.modal-layer`s, and the profile modal is closable, so the friend could
// dismiss the one UNDERNEATH the confirm.
const googleConfirmUnlink = ref(false)
const googleSectionBusy = ref(false)
const googleProfileButtonEl = ref(null)

/**
 * Render Google's own button into the section.
 *
 * ⚠⚠ `gis.initialize()` IS CALLED UNCONDITIONALLY, never behind an "already
 * initialised" flag — the second obligation of GA-T6's seam, and the one live bug this
 * whole area has already produced. GIS registers ONE GLOBAL callback and the LAST
 * `initialize()` owns it; the login card, the post-login prompt and this section can
 * all run within a single session. A guard flag here would leave the callback with
 * whichever surface registered first, so this button would render perfectly and do
 * nothing — the exact failure GA-T6 found on the login card after a logout. The login
 * card takes it back through `beginSession()`'s `googleInitialised = false` reset.
 */
async function mountGoogleProfileButton() {
  // `googleCanLink`, not `googleSectionVisible`: the section is also visible to a
  // LINKED friend outside modern mode, and there is no button to render for them.
  if (!googleCanLink.value || googleSectionLinked.value) return
  await nextTick()

  let gis
  try {
    gis = await loadGis(props.googleClientId)
  } catch {
    // ⚠ SILENT, unlike the prompt's loud failure — and the difference is deliberate.
    // The prompt is a modal the friend opened to do exactly one thing; this is a
    // section of a form they opened to edit their name, so an empty box beside four
    // working fields is a degradation, not a dead end. `loadGis` is timeout-bounded.
    return
  }
  if (!gis) return

  // ⚠ RE-READ after the await: the friend may have closed the modal, or linked from
  // somewhere else, while the script was in flight — `renderButton` would then throw
  // on a null element.
  await nextTick()
  const el = googleProfileButtonEl.value
  if (!el || !showProfileModal.value || !googleCanLink.value || googleSectionLinked.value) return

  gis.initialize({ client_id: props.googleClientId, callback: onGoogleProfileCredential })
  el.innerHTML = ''
  gis.renderButton(el, {
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'rectangular',
    logo_alignment: 'center',
    locale: 'sk',
    // Same clamp as the login card and the prompt: GIS caps at 400 and refuses
    // anything under 200.
    width: Math.max(200, Math.min(Math.round(el.clientWidth) || 320, 400)),
  })
}

/** The GIS credential, handed to the friend-owned link route (§UC-GA-004). */
async function onGoogleProfileCredential(response) {
  const credential = response && response.credential
  if (!credential) return

  profileError.value = ''
  googleSectionBusy.value = true
  try {
    const result = await api.linkFriendGoogle(props.friendId, credential)
    // In place, no reload, and the prompt's view of this session moves with it.
    googleLinkedInSession.value = true
    googleEmailInSession.value = result.googleEmail || ''
    googleConfirmUnlink.value = false
    // ⚠ NOT `google_prompt_dismissed` — §UC-GA-007 says this section touches that flag
    // in NEITHER direction, and there is no call to `api.dismissGooglePrompt` here.
  } catch (e) {
    // §UC-GA-007: "A 409 renders in the modal's existing error slot." The server's own
    // sentence, verbatim — it names no friend and a rewrite could only make that worse.
    profileError.value = e.message
  } finally {
    googleSectionBusy.value = false
  }
}

async function confirmGoogleUnlink() {
  profileError.value = ''
  googleSectionBusy.value = true
  try {
    const result = await api.unlinkFriendGoogle(props.friendId)
    if (result && result.warning === 'no_password') googleUnlinkWarned.value = true
    googleLinkedInSession.value = false
    googleEmailInSession.value = ''
    googleConfirmUnlink.value = false
    // The section is usable again immediately: a fresh button, freshly initialised.
    mountGoogleProfileButton()
  } catch (e) {
    // Keep the confirm open on failure — closing it would claim a severance that did
    // not happen, and the section would still be showing the link it failed to remove.
    profileError.value = e.message
  } finally {
    googleSectionBusy.value = false
  }
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

// ⚠ `shareCycle` is GONE with the card that fed it (§UC-PI-011): this view mounts no
// `GuestShareDialog` any more. The ONE instance lives in `FriendOrder.vue` and the
// drawer reaches it through `requestShareDialog()` below.

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

onMounted(async () => {
  // ⚠ 18 §UC-PI-013 — THE FIRST-LOGIN GATE'S ONE NAVIGATION, and it is FIRST in this
  // hook on purpose: it must land before the first paint settles, or the friend sees
  // the shop flash past on their way to the explainer.
  //
  // `replace`, not `push` — §UC-PI-013's word, and the reason it gives is wrong (so was
  // the first correction of it). ⚠ THE REAL REASON: `push` leaves a ONE-TAP BYPASS of the
  // gate. `explainerGate` is raised ONCE, at setup, and the watch below lowers it on any
  // transition OUT of the explainer view — so back → `/` → `view === 'shop'` would end the
  // gate UNSTAMPED, and the ref cannot re-raise. `replace` removes the `/` entry, so that
  // tap does not exist. (It does NOT remove `/ako-to-funguje`: after „Rozumiem" pushes `/`,
  // back returns here — harmless, the gate has lowered and the write has happened.)
  //
  // ⚠ PRECEDENCE IS STRUCTURAL, NOT CODED HERE. §UC-PI-013 puts the forced
  // password-change gate (03 §UC-FL-012) and the Google link prompt (10 §UC-GA-006)
  // ahead of the explainer, and both are `NeoModal`s over WHATEVER view is mounted —
  // so the explainer simply waits underneath them and is what the friend meets when
  // the modal closes. Adding an `if (!forcedPasswordChange)` here would INVERT that:
  // the friend would finish the forced change and land on the shop, having never been
  // shown the page the gate exists to show them.
  //
  // ⚠ UNCONDITIONAL on the current path, deliberately. A friend who logged in on a
  // deep-linked `/zostatok` (the three portal routes render the login card on their
  // own URL — PI-T1) still meets the explainer first; it is the FIRST login, and the
  // view they asked for is one tap away afterwards.
  if (explainerGate.value && route.path !== '/ako-to-funguje') {
    router.replace('/ako-to-funguje')
  }

  const seq = ++guestCountSeq
  // 18 §UC-PI-004 — ONE balance request per session load, for the drawer badge
  // (and, from PI-T7, the landing debt banner). Fire-and-forget: the badge is
  // decoration on a menu that is not even open yet, so it must not delay the
  // voucher check, and it owns no error surface (see `loadBalance`). It is
  // issued BEFORE the `await` below rather than after, so the one request it
  // makes is already in flight while the voucher check settles.
  loadBalance()
  // `cycles` is already seeded from the handshake, so the only fetch the first
  // render still owes is the voucher check. (`subscriptions` no longer rides along:
  // §UC-PI-016 retired the modal it prefilled, and with it one request per login.)
  await checkPendingVouchers()
  // ⚠ Issued LAST, deliberately — see `loadColleagueCount`.
  loadColleagueCount(seq)
})

onBeforeUnmount(() => {
  // ⚠ Everything that outlives a Vue instance on its own has to be cancelled
  // here. Destroying the component stops its refs from being WRITTEN, but it
  // does not stop work already in flight from being ISSUED.
  //
  //   · a pending `setTimeout` — `switchUser` used to cancel it; ours now.
  //   · the two sequence counters. `loadGuestCounts`'s worker loop had exactly
  //     one exit, `if (seq !== guestCountSeq) return`, and nothing bumped it on
  //     unmount — so after a logout the capped queue kept DISPATCHING. Against
  //     the e2e database's 135 open cycles that was ~132 further
  //     `GET /api/guest-links/cycle/:id`, now token-less (`clearFriendsPassword()`
  //     has already run), each 401ing into the empty catch while competing for
  //     connections with the NEXT login's own requests.
  //     ⚠ PI-T3: the queue is one request now (§UC-PI-004), so the dispatch half of
  //     that story is historical — but the WRITE half is not, and the bump is what
  //     still stops a response that lands after the unmount from being applied.
  if (usernameCheckTimeout) clearTimeout(usernameCheckTimeout)
  usernameCheckTimeout = null
  guestCountSeq++
  inviteSeq++
})

// ⚠ `loadSubscriptions()` and `loadCycles()` are DELETED, not merely unused.
// `loadCycles()` had exactly ONE caller — `saveSubscriptions()` — and the gear that
// reached it is retired (§UC-PI-016). `cycles` is seeded from the handshake and is
// not refetched within a session; the next row that needs a refresh adds the caller
// back beside the `guestCountSeq` bump, which is why that counter stays.

/**
 * The colleague count behind drawer item 4 — ONE `GET /guest-links/cycle/:id`, for
 * the CURRENT OPEN round only (18 §UC-PI-004).
 *
 * ⚠ Issued after the voucher check has settled (see `onMounted`), the ordering rule
 * module 03 established: decoration must never be ahead of the two calls that decide
 * what the screen shows. And issued at most ONCE per session load whatever the
 * payload contains — with 40 open rounds in `cycles` this still fires one request,
 * which is the bound that replaces RD-FL-8a's 3-at-a-time cap.
 *
 * Non-blocking and error-swallowing: `colleagues` stays `null`, and `null` renders
 * the same „Pošlite odkaz kolegom" copy as a genuine zero (§UC-PI-004 item 4:
 * „failure ⇒ the „Pošlite odkaz kolegom" sub, never an error").
 */
async function loadColleagueCount(seq) {
  const cycle = landing.value.state === 'open' ? landing.value.currentCycle : null
  if (!cycle) return
  try {
    const data = await api.getGuestLink(cycle.id)
    if (seq !== guestCountSeq) return
    colleagues.value = summariseSubOrders(data)
  } catch {
    // Swallowed: no link yet, a 404, or an offline blip all render the same sub-line.
  }
}

// One cycle's colleague aggregate, out of the GSO-T2 `{ link, guest_orders,
// totals }` payload the fetch above already returns. No new request and no new
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
  for (const order of orders) {
    if ((order?.status || 'submitted') === 'cancelled') continue
    for (const item of order?.items || []) {
      const quantity = Number(item?.quantity) || 0
      grams += (VARIANT_GRAMS[item?.variant] || 0) * quantity
    }
  }
  return { count: Number.isFinite(count) ? count : 0, grams }
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

// ⚠ RETIRED BY PI-T3 (§UC-PI-005): `goToCycle()`, `activeCycles`, `archivedCycles`,
// `getCycleTypeLabel()`, `formatKilos()` and `orderQuantityLabel()` were the cycle
// LIST's helpers and died with it. `/cycle/:id` is still a live route (§UC-PI-018) —
// it is simply no longer reachable from a card on this screen.

// ---------------------------------------------------------------------------
// 18 §UC-PI-001/002 — WHICH VIEW, and WHICH ROUND (PI-T1; the four view BODIES
// are PI-T3..T8).
//
// ⚠ BOTH ARE `computed`, AND BOTH LIVE HERE RATHER THAN IN `FriendPortal.vue`.
// That is the session-boundary rule, not a placement preference (see this file's
// header): every piece of state module 18 adds — `view`, `menuOpen`,
// `closedModalDismissed`, the resolved round, history expansion, balance,
// explainer state, drawer counts — belongs on THIS side of the parent's
// `v-if` + `:key="sessionSeq"`, so that logging out destroys it with no list to
// maintain. Hoisting any of it into the parent, into a plain `<script>` block or
// into `localStorage` would let friend A's session greet friend B.
//
// Being a `computed` off `route`/`cycles` is itself part of that: it holds no
// value of its own, so there is nothing for a logout to fail to clear.
// ---------------------------------------------------------------------------

/**
 * Which of the four views this route asks for: `shop` | `history` | `balance` |
 * `explainer` (`router.js` `meta.view`). The fallback is `shop` — the deep link
 * `/cycle/:id` never mounts this component, so an unmapped route can only be a
 * new one someone forgot to give a `meta.view`, and the offer is the safe answer.
 */
const view = computed(() => route.meta?.view || 'shop')

/**
 * The landing's round and state, from the ONE home (`lib/portal-state.js`).
 * Recomputed whenever `cycles` is reloaded; `resolveLanding` is pure, so this
 * never fires a request of its own.
 */
const landing = computed(() => resolveLanding(cycles.value))

// ---------------------------------------------------------------------------
// 18 §UC-PI-003/004 — THE APPBAR PER STATE, AND THE DRAWER (PI-T2).
//
// ⚠ ALL OF IT LIVES HERE, on the session side of the parent's `v-if` +
// `:key="sessionSeq"`, for the reason the block above states: `menuOpen`, the
// balance, the drawer's labels and the appbar's own subtitle are SESSION data,
// and a logout must destroy them with no list to maintain. The parent renders
// `BrandChrome` (one instance across all three auth states — 03 §UC-FL-001, it
// must not remount on login), so it READS `appbar` below through the exposed
// session; it stores nothing of its own, and when the session is gone the whole
// object is gone with it.
// ---------------------------------------------------------------------------

const menuOpen = ref(false)

function openMenu() {
  menuOpen.value = true
}

// ---------------------------------------------------------------------------
// 18 §UC-PI-006 / §UC-PI-007 — THE LANDING'S STATE MODAL (PI-T4; PI-T5 added its
// second consumer).
//
// ⚠ ONE DISMISSAL FLAG FOR BOTH STATES, deliberately. `LandingStateModal.vue` is one
// parametrised component (PI-T4 built it that way precisely so §UC-PI-007's „locked,
// NO own order" variant is three different strings, not a second modal), and the
// flag answers „has this friend already been told why there is nothing to order in
// this session?". A landing is closed or locked, never both; two flags would differ
// only when an admin changed a round's status mid-session, and the honest answer
// there is still „they have been told".
//
// ⚠⚠ ONCE PER SESSION, WITH NO PERSISTENCE, AND THE STATE LIVES *HERE*.
// PO clarification 2026-09-19 (a): „modal once per closed period" IS the spec's
// per-SESSION rule — a reload shows it again. So:
//
//   · NOT `localStorage` / `sessionStorage`. This component is `:key`-ed on the auth
//     HANDSHAKE and destroyed on logout (`FriendPortal.vue`'s `v-if` + `:key`), which
//     is the six-leak guard: a stored flag would survive that boundary and friend B
//     would land on a closed offer with friend A's dismissal already applied. There
//     is nothing about this flag that is worth reintroducing that class of bug for.
//   · NOT a plain `<script>` block. `<script setup>` has no module scope (CLAUDE.md
//     §Frontend), so a `let` hoisted up there is ONE value shared by every instance
//     the tab ever mounts — the same leak with a shorter fuse.
//   · NOT the parent. PI-T1's source pin forbids landing state in `FriendPortal.vue`
//     outright, and for the same reason: the parent outlives the session.
//
// A `ref` in this component is therefore not the lazy option, it is the only one
// that expires when the session does.
const stateModalDismissed = ref(false)

/**
 * The modal is showing: the closed offer, the `shop` view, not yet dismissed.
 *
 * ⚠ Gated on the VIEW as well as the state. Navigating to „Zostatok a platby" and
 * back must not put a modal over the balance view on the way — and §UC-PI-006 places
 * it on the landing, not on the session.
 *
 * ⚠ …and that term is DEFENCE IN DEPTH TODAY, said out loud because the alternative
 * is someone later reading it as the thing that enforces the rule. The enforcer is
 * the TEMPLATE: the modal is mounted inside the `view === 'shop' && state ===
 * 'closed'` branch, so dropping this term alone changes nothing observable
 * (measured — mutation M10 reddened zero tests). It takes hoisting the modal out of
 * that branch to break it, which is the realistic defect and which `portal-landing`
 * §5 does pin. The term stays: a later row that moves the mount is exactly the
 * change that would otherwise ship a modal over the balance view.
 */
const showClosedModal = computed(() => (
  view.value === 'shop' && landing.value.state === 'closed' && !stateModalDismissed.value
))

/**
 * §UC-PI-007's „Locked, NO own order" branch — „the closed-state treatment with the
 * modal title „Objednávky sú uzavreté"" (GP-T7, PO decision 2026-09-24: ~~„uzamknuté"~~).
 *
 * ⚠ `hasOrder` is the ONE discriminator, and it is the cycles payload's (a SUBMITTED
 * order, `routes/friends.js`) rather than anything this view derives: a friend who
 * ordered gets the own-order card and never this modal, and a draft is not an
 * objednávka. The same `view === 'shop'` defence-in-depth term as above, for the same
 * measured reason (PI-T4 §4: the mount's template branch is what enforces it today).
 */
const showLockedModal = computed(() => (
  view.value === 'shop'
  && landing.value.state === 'locked'
  && !landing.value.currentCycle?.hasOrder
  && !stateModalDismissed.value
))

/** ×, Esc, scrim, „Prezrieť ponuku" and „Ako to funguje" all mean the same thing. */
function dismissStateModal() {
  stateModalDismissed.value = true
}

function stateModalToExplainer() {
  dismissStateModal()
  router.push('/ako-to-funguje')
}

// ---------------------------------------------------------------------------
// 18 §UC-PI-005/011 — THE EMBEDDED ORDER SURFACE, AND THE ONE SHARE DIALOG
// ---------------------------------------------------------------------------

/**
 * The `FriendOrder.vue` instance this view mounts in `mode="landing"` (open state
 * only). `null` on every other view and state, which is exactly what the two
 * readers below are written to cope with.
 */
const landingOrder = ref(null)

/**
 * The landing cart's total, read through `FriendOrder`'s `defineExpose` — drawer
 * item 1's „ · v košíku …" clause. `0` while the component is not mounted.
 */
const landingCartTotal = computed(() => Number(landingOrder.value?.cartTotal) || 0)

/**
 * The `FriendOrder.vue` instance the CLOSED landing mounts for its read-only
 * catalogue (PI-T4) — GL-T6c's third bridge to the one share dialog. Like
 * `lockedOrder`, a SEPARATE ref from `landingOrder`, whose other reader
 * (`landingCartTotal`) means „the OPEN round's cart". `null` when the closed landing
 * has no catalogue (`landing-empty`), which is the one state with no mount at all.
 */
const closedOrder = ref(null)


/**
 * Drawer item 4's condition — „is there an instance this row can reach?".
 *
 * ⚠ SUPERSEDES §UC-PI-004's „`state === 'open'` only" (GL-T6c, 19 §UC-GL-008 acceptance
 * clause 1 and R9.4 „the host can copy the link any time"): the standing link is
 * cycle-independent, so a round that is not open no longer hides the row — it hides
 * the PER-CYCLE section, inside the dialog. ⚠ The ONE state still without the row is a
 * closed landing with no catalogue (no locked and no completed round ever — `landing-
 * empty`): nothing mounts `FriendOrder` there, and the one-instance rule forbids
 * mounting a second dialog to cover it. Recorded as a gap (learnings 11 §GL-T6c), not
 * papered over with a row that does nothing.
 */
const shareRowShown = computed(() => {
  const l = landing.value
  if (l.state === 'open') return true
  // Parked standing link (PO 2026-09-29, `lib/features.js`): locked/closed would open
  // a dialog with nothing left in it, so the row is `state === 'open'` only again.
  if (!STANDING_GUEST_LINK) return false
  if (l.state === 'locked') return !!l.currentCycle
  return !!l.catalogCycle
})

/**
 * Drawer item 4's action (§UC-PI-011): open THE share dialog — the one instance,
 * which lives in `FriendOrder.vue`.
 *
 * ⚠ THE PENDING FLAG IS NOT DEFENSIVE PADDING. Item 4's condition is the landing
 * STATE (`open`), not the current VIEW, so the row is offered on „Moje objednávky"
 * and „Zostatok a platby" too — where the embedded `FriendOrder` is not mounted and
 * `landingOrder` is `null`. Navigating to `/` and opening the dialog once the
 * instance exists is what makes the row mean the same thing from every view; the
 * alternative (a second `GuestShareDialog` mounted here) is precisely what
 * §UC-PI-011 forbids.
 *
 * ⚠⚠ IT IS ALSO DISARMED ON EVERY PATH THAT DOES NOT REACH THE INSTANCE, and that
 * is the half a first version got wrong (PI-T3 review). A flag that is set and never
 * cleared is a dialog that opens UNBIDDEN later: the friend arrives on the offer
 * minutes afterwards and a share dialog they never asked for is waiting. Three exits:
 * the instance is already here (open now), we are on `/` with no instance at all (the
 * round is not open — nothing to share), or the push was REFUSED (drop it).
 *
 * ⚠ SAID PLAINLY, as with `guestCountSeq` above: the second and third exits have NO
 * REACHABLE TRIGGER TODAY and no test can red them. Item 4 renders only when the round
 * is open, and no guard currently refuses a push INTO `/` (the landing's own leave
 * guard fires on the way OUT). They are here because the cost is two lines and the
 * failure they prevent is silent and user-visible; what IS pinned — in
 * `portal-landing.spec.js` §3 — is the reachable half: after the row has opened the
 * dialog from another view, returning to `/` must not re-open it.
 */
const pendingShare = ref(false)

async function requestShareDialog() {
  if (shareHost.value?.openShareDialog) {
    shareHost.value.openShareDialog()
    return
  }
  // Already on the offer with no instance ⇒ the closed landing without a catalogue
  // (the row is hidden there), so there is nothing to wait for.
  if (route.path === '/') return
  // ⚠ GL-T6c: arriving on a closed / no-order-locked offer from another view would
  // raise the landing's STATE modal (once per session) AND the share dialog the
  // friend asked for — two `NeoModal`s stacked on one layer. The explicit request
  // wins: it counts as the state modal's dismissal, and the slim banner that
  // replaces the modal still says what the modal said. (On `/` itself the modal is
  // necessarily dismissed already — its scrim covers the hamburger.)
  if (landing.value.state !== 'open') dismissStateModal()
  pendingShare.value = true
  // `router.push` RESOLVES WITH a NavigationFailure rather than rejecting when a
  // guard cancels or redirects it — so the falsy check is the success case.
  const failure = await router.push('/')
  if (failure) pendingShare.value = false
}


// ---------------------------------------------------------------------------
// 18 §UC-PI-007 — THE LOCKED LANDING'S OWN-ORDER CARD (PI-T5)
// ---------------------------------------------------------------------------

/**
 * The `FriendOrder.vue` instance the LOCKED landing mounts (read-only grid, tabs
 * kept). A SEPARATE ref from `landingOrder`, not a reuse of it.
 *
 * ⚠ `landingOrder` means „the OPEN landing's live order surface" and two readers
 * depend on that meaning: `landingCartTotal` feeds drawer item 1's „ · v košíku …"
 * clause, and ~~`requestShareDialog()` treats „the instance exists" as „there is a
 * round to share"~~ (GL-T6c: it now asks `shareHost`, which includes THIS ref — the
 * read-only mount's dialog is standing-only). A read-only mount has an empty cart by
 * construction, so pointing `landingOrder` at one would answer the cart question with
 * a mount that cannot mean it. PI-T4 made the same call for the closed catalogue
 * (which GL-T6c gave its own `closedOrder` ref for the same reason).
 */
const lockedOrder = ref(null)

/**
 * 19 §UC-GL-008 / GL-T6c — the mounted `FriendOrder` that holds THE share dialog on
 * the current landing, whichever state it is in. Three refs, one instance at a time
 * (the three mounts sit in mutually exclusive `v-if` branches), and ONE dialog in
 * source — the `portal-landing.spec.js` §4 mount COUNTS are unchanged (FriendOrder 1,
 * session 0, parent 0); only its bridge regex follows the call to `shareHost`.
 *
 * ⚠ On the open landing it is the live order surface and the dialog carries the
 * round (per-cycle section included); on the two read-only mounts `FriendOrder`
 * passes `cycleId = null` itself (`shareCycleId`), so the dialog is standing-only.
 * The session decides WHICH instance, never what the dialog shows.
 */
const shareHost = computed(() => landingOrder.value || lockedOrder.value || closedOrder.value)

// ⚠ Declared HERE, after all three refs, because `watch()` reads its source at setup
// and a `const` above its declaration is in the TDZ. It was `watch(landingOrder, …)`
// up with `requestShareDialog()` until GL-T6c widened it to the three mounts.
watch(shareHost, (instance) => {
  if (!instance || !pendingShare.value) return
  pendingShare.value = false
  instance.openShareDialog()
})

/**
 * §UC-PI-007 item 2's data — „renders from FriendOrder's loaded `order` (no second
 * loader)". `null` until that mount has loaded, which is what the card's `v-if`
 * waits on.
 *
 * ⚠ THE SESSION HOLDS NO COPY. This is a read THROUGH `defineExpose` (a `computed`
 * travels unwrapped via Vue's `proxyRefs`, so it stays reactive), for the same
 * reason drawer item 1 reads `cartTotal` rather than modelling a cart: a second home
 * for „what did this friend order" is the thing the whole surface is built to avoid.
 */
const lockedOwnOrder = computed(() => lockedOrder.value?.ownOrder || null)

/**
 * „Zaplatiť {total}" — it opens `FriendOrder`'s OWN `PaymentModal`, the one that
 * already carries this order's server-issued variable symbol.
 *
 * ⚠ NEVER A SECOND `PaymentModal` MOUNT for the same order (15 §UC-PL-004 D4 and
 * CLAUDE.md: the balance modal has one home too, and PI-T7 RELOCATES that one rather
 * than adding another). ⚠ And nothing here writes money: `paid` is the admin's
 * toggle and this surface posts no `transactions` row at all.
 */
function payOwnOrder() {
  lockedOrder.value?.openPaymentModal?.()
}

/**
 * `landing.nextText` is the admin's `plan_note` verbatim (17's branch 2) — person-typed,
 * so the two warn banners mark it `data-user-copy` (FUP-T22 / 18 §UC-PI-017) and leave
 * 17's two app sentences readable to the vocabulary sweep. One home:
 * `lib/portal-state.js nextTextIsNote()`, which `LandingStateModal.vue` also reads.
 */
const nextIsNote = computed(() => nextTextIsNote(landing.value.nextCycle, landing.value.nextOpening))

/**
 * §UC-PI-007 item 4's next-round banner: „<b>Ďalšia objednávka</b> {short} — ponuku
 * si už môžete prezrieť nižšie."
 *
 * ⚠⚠ THE DATE HERE IS THE SHORT FORM, AND THAT IS NOT A CALL-SITE RESOLUTION OF THE
 * RECORDED PO QUESTION. The conflict (learnings 10 §1, PI-T4 §1) is about ONE
 * sentence — module 17's „Ďalšia objednávka sa otvorí približne {fmtDay}" — which
 * this banner is NOT: §UC-PI-007 specifies a different, shorter sentence that
 * `nextOpeningText()` cannot produce and does not own. The rule PI-T1 wrote for
 * exactly this case applies unchanged: a date standing alone after a preposition is
 * SHORT and comes from `lib/dates.js`; only a date INSIDE one of 17's composed
 * sentences is long. Reformatting 17's sentence here, or importing `fmtDay` for this
 * one, is what would create the second home.
 *
 * ⚠ `nextOpening.date` is the „is `opens_at` usable" predicate (it already encodes
 * the `2026-02-31` round-trip refusal), exactly as `LandingStateModal.vue` uses it —
 * what is RENDERED is `fmtDayMonth`.
 */
const nextRoundShort = computed(() => {
  const next = landing.value.nextCycle
  if (landing.value.nextOpening?.date && next?.opens_at) {
    return { kind: 'date', date: fmtDayMonth(next.opens_at) }
  }
  if (next?.plan_note) return { kind: 'note', note: next.plan_note }
  return { kind: 'none' }
})

// ── the balance, fetched ONCE per session ────────────────────────────────────
//
// §UC-PI-004 item 3: "Balance for item 3 comes from the same
// `api.getFriendBalance(friendId)` call the debt banner uses (UC-PI-008) — one
// request per session load, shared state." So it is fetched HERE, at session
// level, and NOT per drawer open: a menu that refetched on every open would put
// a request behind a gesture people make constantly, and two components each
// holding their own answer is how „what does this friend owe" acquires two homes.
//
// `null` means "not loaded (or failed)", which is exactly the state the badge is
// specified to render as NOTHING — a menu must never show a money figure it is
// not sure of, and a failed balance is not a reason to shout at someone opening
// a menu. There is no error surface and no retry by design.
//
// ~~⚠ PI-T7 SEAM. `FriendBalanceCard.vue` still makes its OWN `getFriendBalance`
// call … So today a session load makes TWO balance requests, and that is KNOWN.~~
// **CLOSED by PI-T7 (2026-09-20).** The card takes `balance` / `payment` /
// `loading` / `error` as PROPS and fetches nothing; this is the only
// `api.getFriendBalance` call on the friend surface, and a landing load makes
// exactly ONE. `payment-links.spec.js`'s exact-count pin was rewritten with it
// (it asserted `toBe(2)` and named the two readers, precisely so this row could
// not leave a stale claim behind).
//
// ⚠ THREE CONSUMERS, ONE ANSWER: the drawer badge (§UC-PI-004 item 3), the landing
// debt banner (§UC-PI-008) and the account card (§UC-PI-010) all read these refs.
// That is the whole point — the day `balancePaymentBlock()` changes, there is one
// place that quotes it.
//
// ⚠ THE ERROR IS AUDIENCE-SCOPED, and that is spec, not caution. `balanceError` is
// rendered ONLY by the card on `/zostatok` (§UC-PI-010: „error `.banner.danger.slim`
// (shipped copy)“). The drawer badge and the debt banner render NOTHING on a failure
// (§UC-PI-008: „a failed balance fetch renders NO banner and no error on the landing
// (the balance view owns the error surface)“) — they get that for free from
// `balance` being `null`, without a second predicate about loading.
const balance = ref(null)
// The server's `payment` block, QUOTED — never recomposed on the client.
const balancePayment = ref(null)
const balanceLoading = ref(true)
const balanceError = ref('')

async function loadBalance() {
  if (!props.friendId) return
  balanceLoading.value = true
  balanceError.value = ''
  // ⚠ CLEARED BEFORE THE READ, not merged after it — the defence-in-depth rule that
  // came up here from `FriendBalanceCard.vue` with the mount (CLAUDE.md §Money &
  // data). It is NOT what keeps one session's payment block out of the next
  // session's: that is structural and lives in `FriendPortal.vue`, which mounts this
  // component with `v-if` + `:key="sessionSeq"` and DESTROYS the subtree on logout
  // (the six-leak guard named in this file's header). What the clear covers is the
  // gap a FAILED reload leaves: without it the card paints its error banner while a
  // stale block sits behind a „Zaplatiť“ that still opens. Closing the dialog with
  // it is the same rule — a dialog quoting a debt that is no longer on screen has
  // no owner.
  balancePayment.value = null
  showBalancePayment.value = false
  try {
    const data = await api.getFriendBalance(props.friendId)
    const value = Number(data?.balance)
    balance.value = Number.isFinite(value) ? value : null
    balancePayment.value = data?.payment || null
  } catch (e) {
    balance.value = null
    balanceError.value = e.message
  } finally {
    balanceLoading.value = false
  }
}

/**
 * §UC-PI-010 business rule: „The view reloads balance + transactions on mount (a
 * payment marked by the admin shows after re-entering the view — no polling)."
 *
 * ⚠ AND THAT IS NOT A CONTRADICTION OF „one request per session load". §UC-PI-004's
 * sentence is about the LANDING load — the drawer badge must not cost a request per
 * menu open. Re-entering `/zostatok` is a deliberate navigation to the screen whose
 * whole subject is the number, and a stale one there is the bug the rule names. The
 * transactions half needs no code here: `FriendTransactionList` is `v-if`-gated on
 * this view, so leaving unmounts it and coming back re-runs its `onMounted`.
 */
// ⚠ ON ENTERING THE BALANCE VIEW FROM **ANY** OTHER VIEW — not only from the landing.
// `history → balance` and `explainer → balance` re-read too, which is the behaviour
// §UC-PI-010 wants; the docs said „`shop → balance`" and were narrower than the code
// (review, 2026-09-20). The `prev !== 'balance'` term is belt-and-braces: a watcher
// cannot fire on an unchanged value, so it can never be false here.
watch(view, (next, prev) => {
  if (next === 'balance' && prev !== 'balance') loadBalance()
})

// ⚠⚠ THE ONE BALANCE `PaymentModal` IN THE TREE, and the one function that opens it.
// `FriendBalanceCard`'s „Zaplatiť {suma}" (`pay-balance`, on `/zostatok`) and
// `DebtBanner`'s „Zaplatiť" (`debt-banner-pay`, on the landing) both call this; the
// mount is at the bottom of the template. PL-T4 put both in the card, which module
// 18 RELOCATES rather than duplicates (15 §UC-PL-007 item 4, CLAUDE.md §Money &
// data): a mount inside the card cannot be opened from a banner on another view, and
// the second mount that would fix that is exactly the defect — two components each
// holding their own copy of `balancePaymentBlock()`'s answer.
//
// ⚠ Nothing here writes money. Opening or closing this modal posts no
// `transactions` row, and `close` deliberately does NOT reload the balance: paying
// through a link changes nothing in the ledger until the admin records the transfer,
// and a refreshed-looking balance would tell the friend otherwise.
const showBalancePayment = ref(false)

function openBalancePayment() {
  showBalancePayment.value = true
}

// The „Zaplatiť“ gate, shared by both surfaces so they can never disagree about
// whether this debt is payable: a block, and somewhere to send the money. The DEBT
// half of the predicate lives in each surface (the card's `balanceState`, the
// banner's `-0.01` threshold), because the card also renders the settled and credit
// states while the banner renders nothing at all.
const canPayBalance = computed(() => !!balancePayment.value
  && !!(balancePayment.value.iban || balancePayment.value.revolut_username))

// ── the appbar (§UC-PI-003) ──────────────────────────────────────────────────

/**
 * The `.titles .s` line: a FIXED string per view, never free text and never the
 * friend's name any more (§UC-PI-003; the name moved into the drawer header).
 * `shop` splits on the landing state: a LOCKED round the friend actually ordered
 * in is „Vaša objednávka“, everything else is „Aktuálna ponuka“.
 */
const appbarSubtitle = computed(() => {
  if (view.value === 'history') return 'Moje objednávky'
  if (view.value === 'balance') return 'Zostatok a platby'
  if (view.value === 'explainer') return 'Ako to funguje'
  const l = landing.value
  if (l.state === 'locked' && l.currentCycle?.hasOrder) return 'Vaša objednávka'
  return 'Aktuálna ponuka'
})

/**
 * The three state tickers (§UC-PI-003). The prototype's „ĎALŠIE KOLO“ is rewritten
 * to „ĎALŠIA OBJEDNÁVKA“ — 18 resolved conflict 1 / §16: no „kolo“ or „cyklus“
 * anywhere a friend can read (§UC-PI-017).
 *
 * ⚠ The week count is `lib/dates.js weeksUntil()` + `lib/plural.js weeksLabel()`,
 * i.e. 18's own short rule, NOT 17's `inWeeksText()`. They genuinely differ:
 * `inWeeksText` switches to DAYS under a week (PO decision O6) and this ticker is
 * specified as weeks-or-nothing („…else DÁME VEDIEŤ“). Uppercased in JS rather
 * than left to `.ticker { text-transform:uppercase }`, because `textContent` — what
 * Playwright's `toContainText` reads — does not apply a text-transform.
 */
const appbarTicker = computed(() => {
  const state = landing.value.state
  if (state === 'open') return '+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++'
  if (state === 'locked') return '+++ OBJEDNÁVKY UZAVRETÉ +++ KÁVA JE NA CESTE +++'
  const weeks = weeksUntil(landing.value.nextCycle?.opens_at)
  const suffix = weeks !== null && weeks >= 1 ? `O ${weeksLabel(weeks).toUpperCase()}` : 'DÁME VEDIEŤ'
  return `+++ OBJEDNÁVKY ZATVORENÉ +++ ĎALŠIA OBJEDNÁVKA ${suffix} +++`
})

/**
 * Everything `FriendPortal.vue`'s `BrandChrome` needs, as ONE object — exposed
 * rather than emitted, so the parent holds no state of its own (a ref there would
 * survive the logout that unmounts this component, which is the whole six-leak
 * class). It is a `computed`: it has no value to clear.
 */
const appbar = computed(() => ({
  // The explainer swaps the hamburger for a back chevron (prototype `portal2.jsx`
  // :309) — there is nowhere to go back to from the other three views.
  menu: view.value !== 'explainer',
  subtitle: appbarSubtitle.value,
  ticker: appbarTicker.value,
  // The lock chip is present whenever the round is NOT open, and it is decorative
  // (`aria-hidden`) — the state is spoken by the banner, not by a glyph.
  lock: landing.value.state === 'open'
    ? null
    : landing.value.state === 'locked' ? 'Objednávky sú uzavreté' : 'Objednávky sú zatvorené',
}))

// ── the drawer's rows (§UC-PI-004) ───────────────────────────────────────────

/** Rounds the friend has actually ordered in — 18 resolved conflict 8. */
const orderedCycles = computed(() => cycles.value.filter((c) => c && c.hasOrder))

/**
 * Item 1's sub-line. Open ⇒ „Otvorené do {fmtDate(closes_at)}“, or the bare
 * „Objednávky sú otvorené“ when no deadline is stored; closed/locked ⇒
 * „Objednávky sú zatvorené“.
 *
 * ⚠ The „ · v košíku {fmtEur(cartTotal)}" clause reads the LANDING's cart, and it
 * reads it off the embedded `FriendOrder` through `defineExpose` rather than keeping
 * a copy: the cart model has one home (§UC-PI-005), and a drawer that summed its own
 * would be the second. `> 0` is the spec's gate, so an empty basket adds nothing.
 * `landingCartTotal` is `0` whenever the component is not mounted (closed/locked, or
 * another view), which collapses to the same thing.
 */
const shopSub = computed(() => {
  const l = landing.value
  if (l.state !== 'open') return 'Objednávky sú zatvorené'
  const closes = fmtDate(l.currentCycle?.closes_at)
  const head = closes ? `Otvorené do ${closes}` : 'Objednávky sú otvorené'
  const cart = landingCartTotal.value
  return cart > 0 ? `${head} · v košíku ${fmtEur(cart)}` : head
})

/**
 * §UC-PI-004 item 4's sub-line: „{colleaguesLabel(count)} · {kgLabel(grams)} cez váš
 * odkaz", and „Pošlite odkaz kolegom" for a zero count, a failure or a load still in
 * flight — the three are DELIBERATELY indistinguishable (a missing count costs the
 * host nothing, and a menu is no place for an error surface).
 *
 * ⚠ `kgLabel()` returns the WHOLE „X kg" string (FUP-T24, and §UC-PI-004 says so in
 * its own footnote) — „… {kg} kg" would render „0.25 kg kg".
 *
 * ⚠ The zero-GRAMS guard drops the „· " separator rather than printing „· 0 kg",
 * which is module 03's copy decision carried over: „3 kolegovia · 0 kg" reads as a
 * failure, „3 kolegovia cez váš odkaz" reads as what it is (the real case being a
 * count that arrived without item rows).
 */
const shareSub = computed(() => {
  const c = colleagues.value
  if (!c || !c.count) return 'Pošlite odkaz kolegom'
  const qty = c.grams ? ` · ${kgLabel(c.grams)}` : ''
  return `${colleaguesLabel(c.count)}${qty} cez váš odkaz`
})

/** Item 2's sub-line: „{n} objednávky · naposledy {cycleName}“, or „Zatiaľ žiadne“ — as `{ text, data }`. */
const historySub = computed(() => {
  const list = orderedCycles.value
  if (!list.length) return { text: 'Zatiaľ žiadne', data: '' }
  // `cycles` arrives `ORDER BY created_at DESC` (friends.js), so the first row
  // carrying an order is the most recent one.
  // ⚠ The cycle NAME is returned APART from the app text (PI-T11 review): it is admin
  // free text, and `NeoDrawer.vue` renders it in its own `data-user-copy` span so the
  // vocabulary sweep reads „3 objednávky · naposledy" and never the name (FUP-T22).
  // Composing it into one string here made the whole sub-line unmarkable.
  return { text: `${ordersAccusativeLabel(list.length)} · naposledy`, data: list[0].name }
})

/**
 * The rows, in the spec's order. `view` maps the four navigating rows onto `.on`.
 *
 * ⚠ RECORDED SPEC DISCREPANCY (§UC-PI-004): the business rule says „the item whose
 * view is current gets `.on`“ and its parenthetical says „(only items 1/2/6 map to
 * a view)“ — but item 3's action IS a view (`/zostatok`, `meta.view: 'balance'`),
 * so FOUR rows map, not three. The prototype agrees (`portal2.jsx` renders
 * `Item k="balance"` through the same `view === k ? " on"` test as the others), and
 * the general rule is the one written as a rule. Implemented as the general rule;
 * the parenthetical reads as a miscount.
 *
 * ⚠ Item 4 („Zdieľať s kolegami") is CONDITIONAL on `shareRowShown` — ~~`state ===
 * 'open'`, 05 §UC-KG-002's „a locked or closed round offers no share affordance at
 * all"~~ SUPERSEDED by GL-T6c (19 §UC-GL-008): the row now opens the standing-only
 * dialog on the locked and closed landings too; KG-002 still holds for the PER-CYCLE
 * link. It is the only row that opens a dialog belonging to another component; see
 * `requestShareDialog()`.
 */
const menuItems = computed(() => {
  const rows = [
    { key: 'shop', view: 'shop', icon: 'bag', label: 'Aktuálna ponuka', sub: shopSub.value },
    {
      key: 'history', view: 'history', icon: 'list', label: 'Moje objednávky',
      sub: historySub.value.text, subData: historySub.value.data,
    },
    {
      key: 'balance',
      view: 'balance',
      icon: 'wallet',
      label: 'Zostatok a platby',
      // While it is loading (or after a failure) there is NO badge — never a
      // placeholder figure. `-0.01` is the spec's threshold, so a balance that
      // rounds to zero is not painted as debt.
      badge: balance.value === null
        ? null
        // ⚠ `isInDebt`, not a fourth copy of the comparison (`lib/money.js`).
        : { text: fmtEur(balance.value), tone: isInDebt(balance.value) ? 'danger' : 'ok' },
    },
    ...(shareRowShown.value
      ? [{ key: 'share', icon: 'share', label: 'Zdieľať s kolegami', sub: shareSub.value }]
      : []),
    { key: 'invite', icon: 'invite', label: 'Pozvať priateľa', sub: 'Váš pozývací odkaz' },
    { key: 'explainer', view: 'explainer', icon: 'help', label: 'Ako to funguje' },
    { key: 'profile', icon: 'user', label: 'Profil', sub: 'Meno, telefón, Packeta, heslo' },
  ]
  return rows.map((row) => ({ ...row, on: !!row.view && row.view === view.value }))
})

/**
 * §UC-PI-004: "Choosing any item closes the drawer first, then acts." Not
 * cosmetic — a `router.push` out of a view whose leave guard prompts (PI-T3) would
 * otherwise run with the drawer still on the modal layer, over the confirm.
 */
function onMenuSelect(key) {
  menuOpen.value = false
  if (key === 'invite') return openInviteModal()
  if (key === 'profile') return openProfileModal()
  if (key === 'share') return requestShareDialog()
  const path = key === 'history' ? '/moje-objednavky' : key === 'balance' ? '/zostatok' : key === 'explainer' ? '/ako-to-funguje' : '/'
  if (route.path !== path) router.push(path)
}

function onMenuLogout() {
  menuOpen.value = false
  emit('logout')
}

/**
 * The explainer view's back chevron (§UC-PI-003 `#leading`). It lives here, not in
 * the parent, so that ROUTING has one home on the authenticated surface — the same
 * place `view`, `onMenuSelect` and (from PI-T9) the explainer gate's
 * `router.replace` live. Keeping the parent router-free is also what keeps
 * `portal-shell.spec.js`'s source pin („no `route.meta` in `FriendPortal.vue`")
 * meaningful rather than incidental.
 */
function backHome() {
  if (route.path !== '/') router.push('/')
}

// ---------------------------------------------------------------------------
// 18 §UC-PI-012 — „AKO TO FUNGUJE", THE EXPLAINER (PI-T8).
//
// The view itself is `components/PortalExplainer.vue`; everything this file owns
// is the ONE thing the component cannot know — whether the round a friend is
// looking at charges for Packeta — and where „Späť na ponuku" goes.
// ---------------------------------------------------------------------------

/**
 * §UC-PI-012 item 4: the Packeta badge is gated on
 * `(currentCycle ?? catalogCycle)?.parcel_enabled`.
 *
 * ⚠ THE `??` IS RESOLVED HERE, not in the component, because `landing` is THIS
 * file's shape (`lib/portal-state.js`). And it is not `currentCycle` alone:
 * `currentCycle` is NULL under `closed` (PI-T1 §2), which is the state the
 * explainer is most likely to be READ in — a friend with nothing to order is
 * exactly the one reading how it works. Dropping `catalogCycle` would silently
 * hide the fee for the majority of visits to this page.
 *
 * ⚠ `parcel_enabled` arrives from SQLite as 0/1, so it is coerced here: the
 * component's prop is a real `Boolean` and `0` would be `true` to a truthiness
 * test written at the call site later.
 */
const explainerCycle = computed(() => landing.value.currentCycle ?? landing.value.catalogCycle ?? null)
const explainerParcelEnabled = computed(() => !!explainerCycle.value?.parcel_enabled)
const explainerParcelFee = computed(() => Number(explainerCycle.value?.parcel_fee) || 0)

/**
 * 18 §UC-PI-013 (PI-T9) — THE FIRST-LOGIN GATE, which is this same page with one
 * checkbox on it.
 *
 * ⚠ A `ref` SEEDED ONCE, not a computed over `props.entry`. The flag has to STOP
 * being true the moment the gate is answered: the friend can reach the explainer
 * again from the drawer in the very same session, and §UC-PI-013 says an explainer
 * opened from the menu never writes anything and shows no checkbox. A computed would
 * keep the checkbox (and the stamping branch) alive for the rest of the session.
 *
 * ⚠ It is SESSION state, on the session side of the parent's `v-if` + `:key` — the
 * six-leak guard. A logout destroys it; there is no list to maintain.
 */
const explainerGate = ref(!!props.entry?.explainerPending)

/**
 * ⚠ THE GATE IS ONE-SHOT PER ARRIVAL, AND „Rozumiem" IS NOT ITS ONLY EXIT — this
 * watch is a MEASURED fix, not symmetry for its own sake. §UC-PI-003 puts a BACK
 * CHEVRON on the explainer view where the hamburger is elsewhere, so the friend can
 * leave the gate without answering it. Lowering the flag only in `onExplainerDone`
 * left it RAISED after that escape, and the next visit from the drawer — an explainer
 * the friend navigated to ON PURPOSE — still carried the pre-ticked „Už mi to
 * neukazovať" and would have STAMPED the column on „Rozumiem". §UC-PI-013 forbids
 * exactly that („opening the explainer from the menu never writes anything"), so the
 * gate ends when the friend leaves the VIEW, however they leave it.
 *
 * ⚠ It watches the TRANSITION OUT (`before === 'explainer'`), never `view !==
 * 'explainer'` on its own: the session mounts on `shop` and `router.replace` happens a
 * tick later, so the simpler predicate would fire once at mount and lower the flag
 * before the gate had ever rendered.
 *
 * The explicit lowering inside `onExplainerDone` stays: it has to happen BEFORE the
 * `hide` branch can run a second time, and this watch fires only after the navigation.
 */
watch(view, (now, before) => {
  if (before === 'explainer' && now !== 'explainer') explainerGate.value = false
})

/**
 * The explainer's one action (§UC-PI-012 item 8). From the menu it is „Späť na
 * ponuku" and means exactly the back chevron.
 *
 * ⚠ THE `hide` FLAG IS READ ONLY WHILE `explainerGate` IS TRUE. `PortalExplainer`
 * emits `{ hide }` in BOTH modes (one payload shape, its header says so) and `hide`
 * defaults to `true` — so reading it without the gate check would stamp the column
 * every time a friend closed the explainer from the menu, which §UC-PI-013 forbids in
 * as many words. The gate flag, not the payload, is what makes this a write.
 *
 * ⚠ FIRE-AND-FORGET, error SWALLOWED (§UC-PI-013: "the UX must not block on it").
 * The friend is on their way to the shop; a failed stamp costs them one more explainer
 * at their next login and nothing else. `.catch(() => {})` rather than `await` — an
 * `await` here would make the navigation wait on a request whose answer is never read.
 */
function onExplainerDone(payload) {
  if (explainerGate.value) {
    // Lowered FIRST, so a second click (or a re-entry from the drawer in this same
    // session) can no longer take the writing branch.
    explainerGate.value = false
    if (payload?.hide) {
      api.markExplainerSeen(props.friendId).catch(() => {})
    }
  }
  backHome()
}

// ---------------------------------------------------------------------------
// 18 §UC-PI-015 + PO 2026-09-19(c) — THE PROFILE MODAL'S AUTO-OPEN (PI-T10)
// ---------------------------------------------------------------------------

/**
 * „This login has not yet been shown the profile modal." ONE-SHOT, session-scoped.
 *
 * ⚠ IT IS A REF ON THE SESSION SIDE of the parent's `v-if` + `:key="sessionSeq"` —
 * the six-leak boundary §UC-PI-001 states. A logout destroys it; there is no
 * `localStorage`, no module scope (`<script setup>` has none), nothing keyed on the
 * friend id. „Dismissible per session" is exactly this ref being lowered when the
 * modal opens: the friend closes it and it does not come back until the NEXT LOGIN.
 *
 * ⚠ SEEDED FROM `entry.freshLogin`, which only the three LOGIN paths pass — see
 * `FriendPortal.vue beginSession`. A restore (every reload, every deep link) leaves
 * it false, inheriting §UC-PI-013's „a restore is not a login" boundary verbatim.
 */
const profileAutoOpenArmed = ref(!!props.entry?.freshLogin)

/**
 * ⚠ THE HYDRATE GATE, and it is a `hasOwnProperty`, not a truthiness test.
 *
 * `phone` is in NONE of the login payloads (PI-T9 pinned that set), so `props.friend`
 * carries no `phone` KEY until `hydrateCurrentFriend()`'s `GET /:id/profile` lands.
 * `!props.friend?.phone` would therefore be `true` for every friend for the first few
 * hundred milliseconds of every login — including friends who HAVE a phone, who would
 * see the modal flash open and (worse) stay open. Asking whether the key EXISTS is
 * what turns „I do not know yet" into „not yet", and it is also what puts this last in
 * the precedence chain for free: the fetch settles after the gates have painted.
 *
 * ⚠ A FAILED hydrate therefore never auto-opens. Accepted and deliberate: that fetch
 * is documented fire-and-forget and allowed to fail silently, and the cost of a miss
 * is one more prompt at the next login — the same trade `onExplainerDone` makes.
 */
const profilePhoneKnown = computed(
  () => !!props.friend && Object.prototype.hasOwnProperty.call(props.friend, 'phone')
)
const profilePhoneMissing = computed(() => !String(props.friend?.phone ?? '').trim())

/**
 * ⚠⚠ PRECEDENCE IS CODED HERE, AND THAT IS THE OPPOSITE OF PI-T9'S EXPLAINER — say
 * why, because the next reader will see the disagreement.
 *
 * The explainer gate is a `router.replace`: a VIEW, which the forced-password gate and
 * the Google prompt simply paint over, so its precedence is structural and coding it
 * would have INVERTED the rule (learnings 10 §PI-T9.10). This one is a `NeoModal`, and
 * a modal opened while another modal is up does not wait underneath it — it stacks,
 * traps focus against its sibling and puts a scrim over a gate the friend cannot
 * dismiss. So the three gates PO clarification (c) names are terms in the trigger,
 * read REACTIVELY (each of them clears in place when the friend satisfies it, and this
 * modal is supposed to arrive at exactly that moment).
 *
 * ⚠⚠ THE TERM LIST IS „EVERY SURFACE THAT RAISES ITSELF WITHOUT THE FRIEND ASKING",
 * NOT „the gates clarification (c) names". PI-T10's first pass enumerated the latter
 * and shipped a measured defect: on a CLOSED landing — the normal state for most of the
 * month — a phone-less friend got `dialogs=2`, „Objednávky sú zatvorené" AND „Upraviť
 * profil", scrim over scrim. Found in review by BUILDING that login rather than reading
 * the list. The class is the standing one: a rule stated narrower than what it protects
 * reads as licence for everything it failed to name — and this comment is where that
 * class is supposed to be caught.
 *
 * ⚠⚠ THE LIST BELOW IS DERIVED, AND THE DERIVATION IS THE PART THAT MATTERS — because
 * a hand-kept list under a class rule reads as complete and has now been wrong TWICE
 * (round 1 missed the two landing state modals; round 2 missed the voucher overlay).
 * THE DERIVATION: walk every overlay MOUNT in this file's template — ~~`<NeoModal>`,
 * `<LandingStateModal>`, `<NeoDrawer>`, and the teleported `fixed inset-0` voucher div~~
 * **every `*Modal`/`*Dialog`/`*Drawer` component and every `fixed` element, whatever its
 * shape (PI-T12: that four-shape list missed `<PaymentModal :open>`, the TENTH mount)** —
 * and ask of each „can this raise with NO friend action?" Yes ⇒ it is a term.
 * ⚠ `portal-profile-modal.spec.js` PINS THAT WALK IN SOURCE, so an EIGHTH self-raising
 * overlay reds instead of silently stacking — and, since PI-T12, it pins the COUNTS
 * too (10 mounts, 8 terms) and derives the exact term set, so a term added or dropped
 * reds as well. Do not maintain the list by hand; add the mount and let the pin tell you.
 *
 * The seven self-raising surfaces, and why each is one:
 *   · `forcedPasswordChange`  — 03 §UC-FL-012, non-dismissable `NeoModal`.
 *   · `showCredentialSetup`   — 03 §UC-FL-011, auto-raised from the same handshake.
 *   · `showGooglePrompt`      — 10 §UC-GA-006.
 *   · `explainerGate`         — 18 §UC-PI-013 (a VIEW, but it owns that first login).
 *   · `showClosedModal` / `showLockedModal` — 18 §UC-PI-006/007, the landing STATE
 *     modals. They raise themselves with no friend action, exactly like the rest,
 *     and they are the common case rather than the edge.
 *   · `showVoucherModal`      — 05 §UC-KG: `onMounted` AWAITS `checkPendingVouchers()`
 *     and it raises the overlay with no friend action. ⚠ It is the worst one to stack
 *     on: it is a hand-rolled `fixed inset-0 z-50` teleport while `.modal-layer` is
 *     `z-index: 200`, so the profile form paints OVER it — measured,
 *     `elementFromPoint()` over the voucher's own button returned `INPUT.inp` — and the
 *     decision under it („Toto rozhodnutie je jednorazové a nedá sa zmeniť") is
 *     irreversible and cannot be dismissed, only answered.
 *     ⚠ The „ACCEPTED RESIDUAL — the voucher overlay" note further up this file does
 *     NOT license leaving it out: its whole argument is that `googlePromptEligible` is
 *     a SEEDED-ONCE ref and an async term would turn that seed into a `watch`. This
 *     trigger is already a watch, so the term costs nothing that argument was protecting.
 * Only the first, third and fourth are in clarification (c); the rest were added
 * deliberately and are each pinned by a test that reds when the term is deleted.
 *
 * ⚠ NOT self-raising, so NOT terms (each checked, not assumed): `showInviteModal` and
 * `showBalancePayment` need a friend's click; `showPasswordChange` / `showPasswordSet`
 * are FOLDS inside the profile modal, not overlays; the drawer needs the hamburger.
 *
 * ⚠ QUEUE BEHIND, NOT IN FRONT. Every term is a `computed`/`ref` that clears in place,
 * so the profile modal arrives the moment the friend dismisses whatever was there —
 * which is clarification (c)'s „runs AFTER … resolve", not a race for the same layer.
 * ⚠ `showMagicPrompt` is NOT a term: its mount is `div.banner[data-testid="magic-prompt"]`,
 * not a modal, so there is nothing to stack on. (The first draft cited a LINE NUMBER
 * here and it was wrong twice over — stale when written, and staler once this very
 * comment grew. Cite the selector.)
 */
watch(
  () => profileAutoOpenArmed.value
    && !forcedPasswordChange.value
    && !showCredentialSetup.value
    && !showGooglePrompt.value
    && !explainerGate.value
    && !showClosedModal.value
    && !showLockedModal.value
    && !showVoucherModal.value
    // ⚠ NOT a self-raising surface — a term of a DIFFERENT kind, and the only one.
    // `openProfileModal()` unconditionally re-seeds all four fields from `props.friend`,
    // so without this the auto-open can fire on a modal the friend ALREADY HAS OPEN and
    // wipe what they typed: hydrate is still in flight (`profilePhoneKnown` false, so the
    // trigger is false), the friend opens Profil from the drawer and starts typing, the
    // profile GET lands, and the watch re-prefills over them. Narrow and recoverable,
    // and one term in an expression that already had to be right.
    && !showProfileModal.value
    && profilePhoneKnown.value
    && profilePhoneMissing.value,
  (ready) => {
    if (!ready) return
    // Lowered FIRST, so closing the modal cannot re-arm it and a later flip of any
    // gate term cannot open it a second time in this session.
    profileAutoOpenArmed.value = false
    openProfileModal()
  },
  { immediate: true }
)

// ---------------------------------------------------------------------------
// 18 §UC-PI-009 — „MOJE OBJEDNÁVKY", THE HISTORY VIEW (PI-T6).
//
// The rounds the friend actually ordered in, newest first, each a card with a short
// badge and a lazily fetched line list. It REPLACES 03 §UC-FL-008's „Archív" fold
// (supersession map) and it is READ-ONLY: no „Otvoriť" link into the round (PO
// decision — §UC-PI-009's `OPEN:` resolved to „omitted"; the deep link `/cycle/:id`
// still exists, history is a reading surface). Nothing here writes anything at all.
//
// ⚠ ALL FOUR PIECES OF STATE BELOW LIVE ON THE SESSION SIDE of the parent's
// `v-if` + `:key="sessionSeq"` — the boundary rule §UC-PI-001 states and this file's
// header explains: never `localStorage` (friend A's rounds would greet friend B),
// never a plain `<script>` block (`<script setup>` has no module scope, so a `let`
// up there is ONE cache shared by every instance the tab ever mounts — CLAUDE.md
// §Frontend), never the parent (it outlives the session). A `ref` here expires when
// the session does, with no list to maintain.
// ---------------------------------------------------------------------------

/**
 * The ONE expanded round's cycle id, or `null` (§UC-PI-009: „One round expanded at
 * a time (prototype toggle)"). A single scalar IS the rule — a per-row boolean set
 * would let two rows be open and would need a second mechanism to stop it.
 */
const expandedRound = ref(null)

/**
 * The per-round line cache: `cycleId → { lines, extras }`, „cached per round for
 * the session" (§UC-PI-009). Collapsing and re-expanding a round re-renders from
 * here and fires no second request.
 *
 * ⚠ KEYED BY CYCLE ID, and that is the structural half of „a stale response never
 * writes into another round": every write lands under the id it was fetched for,
 * and the template reads `roundLines[expandedRound]`, so a response arriving after
 * the friend moved on paints nothing. The single `lines` ref this view could have
 * had instead is exactly the defect that shape prevents.
 */
const roundLines = ref({})

/**
 * Per-row pending and per-row error, both keyed the same way (§UC-PI-009:
 * „per-row pending + a per-row `rowSeq`"; the repo convention for per-row mutations,
 * CLAUDE.md §Frontend).
 *
 * ⚠ PER ROW, NOT ONE FLAG. With one shared flag a round whose lines are already
 * cached renders „Načítavam..." over them whenever ANOTHER round's request happens
 * to be in flight — and an error from round A would paint a red banner inside
 * round B. Measured: one shared pending flag reds `portal-history.spec.js` §4's
 * first test (mutation M4).
 */
const roundPending = ref({})
const roundError = ref({})

/**
 * The per-row sequence counters — `cycleId → seq` (§UC-PI-009's `rowSeq`, the
 * `loadSeq` rule of GSO-T2 applied per row).
 *
 * ⚠ A plain `Map`, deliberately NOT a `ref`: nothing renders from it, and a
 * reactive counter would re-run every computed that touches this view on each
 * fetch. It is still session-scoped — it is a `const` inside `<script setup>`, i.e.
 * per INSTANCE, and the instance dies with the session (the same reason
 * `guestCountSeq` and `inviteSeq` are plain `let`s above).
 *
 * ⚠⚠ SAID PLAINLY, because the alternative is a comment promising a test that does
 * not exist: ON TODAY'S CODE THIS GUARD REDS NOTHING BY ITSELF. Two things already
 * make a cross-row paint impossible — the cache is keyed by id (above) and
 * `toggleRound` refuses to start a second fetch while one is pending for that row —
 * so there is no reachable path where a stale response has anywhere wrong to go.
 * MEASURED: deleting every `roundSeq` check leaves `portal-history.spec.js` at
 * 15/15 green (mutation M5). What reds is the realistic FUTURE defect this guard is
 * here for — a writer who gives this view one shared `lines`/`pending` pair again,
 * the shape it would have had without the rule (mutation M5′, measured at **3 red**:
 * §3's „ONE round is expanded at a time" and both of §4's). Kept and documented
 * rather than quietly dropped, exactly as PI-T5 kept `showLockedModal`'s `hasOrder`
 * term (learnings 10 §9).
 */
const roundSeq = new Map()

/** Rounds with a submitted order, newest first — the list itself (resolved
 *  conflict 8: „a round without one is not an objednávka"). `GET /friends/cycles`
 *  already sorts `created_at DESC`, so this is `orderedCycles` verbatim; the drawer's
 *  item-2 sub-line counts the SAME list, which is what keeps „{n} objednávky" and the
 *  number of cards on screen from ever disagreeing. */
const historyRounds = computed(() => orderedCycles.value)

/**
 * Toggle one round open (and every other one closed).
 *
 * The fetch is LAZY — „fetched lazily on first expand … cached per round for the
 * session" — so a friend with thirty rounds costs one request per round they
 * actually open, and none for the rest.
 */
function toggleRound(cycle) {
  const id = cycle?.id
  if (id == null) return
  if (expandedRound.value === id) {
    expandedRound.value = null
    return
  }
  expandedRound.value = id
  // Already fetched, or its request is still in flight: nothing to start. The
  // second half is what makes a double click one request rather than two.
  if (roundLines.value[id] || roundPending.value[id]) return
  loadRoundLines(id)
}

/**
 * Fetch one round's lines through the EXISTING endpoint (`GET /orders/cycle/:id/
 * friend/:id` — §UC-PI-009 names it; no new route, no new payload).
 *
 * ⚠ The mapping is `lib/order-lines.js`'s, never a second normaliser: `orderLines()`
 * computes `price × quantity` from the SNAPSHOT price the server stored at submit
 * (a price the admin edited after the round locked must not rewrite what the friend
 * is told they ordered) and `deliveryExtras()` renders `orders.delivery_fee` as an
 * EXTRA, never as an item — it has never been an `order_items` row.
 *
 * ⚠ NO `purposeOrder`: `CartLineList` groups by purpose and this view never loads
 * the round's catalogue, so there is no category strip to align the groups with.
 * The component's documented fallback — first-appearance order, i.e. the server's —
 * is the right answer here and the only available one.
 */
async function loadRoundLines(id) {
  const seq = (roundSeq.get(id) || 0) + 1
  roundSeq.set(id, seq)
  roundPending.value[id] = true
  delete roundError.value[id]
  try {
    const data = await api.getOrderByFriend(id, props.friendId)
    if (roundSeq.get(id) !== seq) return
    roundLines.value[id] = {
      lines: orderLines(data?.items),
      extras: deliveryExtras(data?.order?.delivery_fee),
      // ⚠ THE TOTAL IS RE-QUOTED FROM THIS FETCH, and that is a fix, not a
      // convenience (PI-T6 review). The header's `round.orderTotal` comes from
      // `cycles`, seeded from the auth handshake and **never reloaded in-session** —
      // `loadCycles()` was deleted with the gear (see the note above), and
      // `FriendOrder` emits nothing, so a re-submit on the landing updates no row.
      // The lines below, by contrast, are fetched live. For the CURRENT OPEN round —
      // which §UC-PI-009 deliberately lists and highlights, and which `PUT /orders`
      // still accepts — a friend could edit and re-submit on „/", open „Moje
      // objednávky", expand that round, and read a stale total above lines that sum
      // to something else. Quoting the fetch keeps the two halves of one card
      // describing the same order.
      total: typeof data?.order?.total === 'number'
        ? roundMoney(data.order.total + (data.order.delivery_fee || 0))
        : null,
    }
  } catch (e) {
    if (roundSeq.get(id) !== seq) return
    // The error surface is INSIDE the card (§UC-PI-009), never the page-level
    // banner: it is one row's failure, and the other rows are fine.
    roundError.value[id] = e?.message || 'Objednávku sa nepodarilo načítať.'
  } finally {
    if (roundSeq.get(id) === seq) roundPending.value[id] = false
  }
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
  // §UC-GA-007: the CONFIRM is per-open UI state — an unlink the friend backed out of
  // (or closed the modal on) must not be half-armed when they come back. The link
  // state itself is NOT reset here: it belongs to the session, not to the modal.
  googleConfirmUnlink.value = false
  showProfileModal.value = true
  // Fire-and-forget: the GIS script load must not delay the modal, and its own failure
  // path is silent by design.
  mountGoogleProfileButton()
}

async function saveProfile() {
  // ⚠ 18 §UC-PI-015 — the JS half of the two disabled terms. A `disabled` attribute
  // does NOT stop a dispatched click reaching the handler (CLAUDE.md), and the modal
  // can also be submitted from the keyboard, so both required fields are re-checked
  // here. Mobil joined `name` with PI-T10; the SERVER refuses a blank phone too
  // (400 `{field:'phone'}`), which is the rule this guard only mirrors.
  if (!profileName.value.trim() || !profilePhone.value.trim()) return

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

/**
 * Set a FIRST password (GA-T11) — the fold the change-password one above cannot serve.
 *
 * ⚠ The client rules are the SERVER's rules, restated so a mistyped form does not cost
 * a round trip; the server stays authoritative and its refusals render in the same
 * banner. Length 8 and the username format are copied from `validateUsername` /
 * `friends.js` verbatim — if one moves, both move.
 */
async function submitFirstPassword() {
  firstPasswordError.value = ''

  const username = firstUsername.value.toLowerCase().trim()
  if (firstNeedsUsername.value) {
    if (username.length < 3 || username.length > 30 || !/^[a-z0-9._-]+$/.test(username)) {
      firstPasswordError.value = 'Meno musí mať 3 – 30 znakov a obsahovať len malé písmená, čísla, bodku, podtržník a pomlčku'
      return
    }
  }

  if (!firstPassword.value || firstPassword.value.length < 8) {
    firstPasswordError.value = 'Heslo musí mať aspoň 8 znakov'
    return
  }

  if (firstPassword.value !== firstPasswordConfirm.value) {
    firstPasswordError.value = 'Heslá sa nezhodujú'
    return
  }

  firstPasswordSaving.value = true
  try {
    const result = await api.setFirstPassword(
      props.friendId,
      firstPassword.value,
      firstNeedsUsername.value ? username : null
    )

    // ⚠ The token FIRST and unconditionally: the route invalidates every session of
    // this friend (including the one this request presented — `change-password`'s
    // contract, copied), so without handing the re-mint to the parent the friend would
    // be logged out by succeeding.
    if (result.token) {
      emit('token', { token: result.token, expiresAt: result.expiresAt })
    }
    // `hasCredentials: true` rides in `result.friend`, so the fold below this one —
    // the change-password one, keyed on exactly that field — replaces this one in
    // place, with no reload and no second fetch.
    if (result.friend) {
      emit('friend-merged', result.friend)
    }

    showPasswordSet.value = false
    firstUsername.value = ''
    firstPassword.value = ''
    firstPasswordConfirm.value = ''
  } catch (e) {
    firstPasswordError.value = e.message
  } finally {
    firstPasswordSaving.value = false
  }
}

// ⚠ Subscriptions (UC-FL-010) — the modal, `openSubscriptionModal()` and
// `saveSubscriptions()` are RETIRED (18 §UC-PI-016). `api.updateSubscriptions` and
// `PUT /api/subscriptions/friend/:id` are untouched and still answer 200; the
// server-side filter in `GET /friends/cycles` is untouched too. Only the UI is gone.

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
// ⚠ `appbar` is exposed as well as the two openers (18 §UC-PI-003): `BrandChrome`
// is the PARENT's one instance across all three auth states, so the parent has to
// read the per-view subtitle, the ticker and the lock chip from somewhere — and
// „somewhere" must not be a ref of its own, or friend A's chrome greets friend B.
// A `computed` read through the exposed session dies with the session.
defineExpose({ openProfileModal, openInviteModal, openMenu, backHome, appbar })
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
  <!-- ⚠ `data-testid="portal-landing"` — 18 §UC-PI-019 item 1: THE „portal is
       ready" MARKER, present in every view and in every landing state. It replaces
       the heading gate `getByRole('heading', { name: 'Objednávkové cykly' })` that
       ~30 spec files used to wait on, precisely because that heading is a
       STRUCTURE this module retires (§UC-PI-005) — a gate tied to one screen's
       copy cannot survive the screen. Tests reach it through
       `e2e/helpers/portal.js expectLanding()`, one home, so the next IA change
       edits one file rather than thirty.

       ⚠ It sits on the PAGE COLUMN, which is the session's only unconditional
       element: this is a fragment component (the voucher banner is its sibling),
       so there is no single root to carry it, and the column is the one node that
       renders in all four views, all three states and behind every modal gate.

       `data-view` publishes `route.meta.view` (§UC-PI-001) and
       `data-landing-state` the resolver's answer (§UC-PI-002) — the DOM handle
       those two rules are asserted through while their VIEWS are still being
       built (PI-T3..T8). Neither is user copy; both are read by e2e only. -->
  <div
    class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7"
    data-testid="portal-landing"
    :data-view="view"
    :data-landing-state="landing.state"
  >
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

    <!-- ⚠ WHAT WAS HERE AND IS GONE (PI-T7, §UC-PI-008): module 03's „Môj účet"
         balance card, which rendered on EVERY view and in every landing state.
         A settled or positive balance must never appear on the landing at all —
         R2.3, a product decision, not an oversight — so the card moved into the
         „Zostatok a platby" view below and the landing keeps only the debt banner,
         positioned per state by §UC-PI-005/006/007. -->

    <!-- ═══════════════ 18 §UC-PI-005 — THE LANDING, OPEN STATE (PI-T3) ═══════════
         ⚠ WHAT WAS HERE AND IS GONE: module 03's cycle LIST — the „Objednávkové
         cykly" heading, the „Nastavenia odberu" gear, the `div.p-4` cards with their
         badge matrix, the UC-FL-007 share row and the UC-FL-008 „Archív" fold
         (§UC-PI-005/011/016; the two spec files that pinned them,
         `portal-cycles.spec.js` and `portal-share-row.spec.js`, are deleted in the
         same commit and their surviving properties moved to `portal-landing.spec.js`
         / `portal-menu.spec.js`). Nothing gated on the heading any more — PI-T1 moved
         that gate onto `data-testid="portal-landing"` above, which is why this
         deletion is safe rather than merely sanctioned.

         ⚠ The CLOSED and LOCKED landings are PI-T4's and PI-T5's. Until they land,
         those two states render the chrome, the balance card and nothing else —
         that is the planned increment, not an omission. -->

    <template v-if="view === 'shop' && landing.state === 'open' && landing.currentCycle">
      <!-- 1. THE STATUS LINE (§UC-PI-005 item 1).
           „<b>Objednávky do {fmtWeekdayDayMonth(closes_at)}</b> Káva príde okolo
           {expected_date} — <a>Ako to funguje?</a>"

           · `closes_at` null ⇒ the bare „<b>Objednávky sú otvorené.</b>";
           · `expected_date` null ⇒ the „Káva príde …" clause is omitted. It is ADMIN
             FREE TEXT and is rendered VERBATIM (PI-T1: `lib/dates.js` formats the
             ISO columns, never this one);
           · the „Ako to funguje?" link renders in BOTH branches — it is the way into
             the explainer, not a decoration on the deadline sentence.

           ⚠ The date is `fmtWeekdayDayMonth` from `lib/dates.js` — a date standing
           alone after a preposition is SHORT (PI-T1 §1); `cycle-stages.js` owns the
           long form only inside module 17's composed sentences. -->
      <div class="banner slim" data-testid="landing-status">
        <span class="dot"></span>
        <div style="min-width:0;overflow-wrap:anywhere">
          <template v-if="landing.currentCycle.closes_at">
            <b>Objednávky do {{ fmtWeekdayDayMonth(landing.currentCycle.closes_at) }}</b>
          </template>
          <template v-else><b>Objednávky sú otvorené.</b></template>
          <!-- ⚠ THE EM DASH BELONGS TO THE „Káva príde" CLAUSE, NOT TO THE LINK.
               §UC-PI-005 writes the sentence as „… Káva príde okolo {expected_date} —
               <a>Ako to funguje?</a>", and the spec drops only the „Káva príde …" half
               when `expected_date` is null. Rendering the dash unconditionally left
               „Objednávky sú otvorené. — Ako to funguje?" — an orphan dash introducing
               nothing. The LINK survives both branches (it is the way into the
               explainer, not a decoration on the deadline); only its separator is
               conditional. ⚠ PO: if a separator is wanted in the bare branch it is a
               copy decision, not a template one — both branches are pinned in
               `portal-landing.spec.js`, so changing either is a deliberate edit. -->
          <template v-if="landing.currentCycle.expected_date">Káva príde okolo {{ landing.currentCycle.expected_date }} —</template>
          <!-- ⚠ `{{ ' ' }}`, NOT TEMPLATE WHITESPACE. Vue's compiler condenses the
               whitespace between a `v-if` template and its next sibling, so when the
               clause above is dropped the link fused onto the sentence:
               „Objednávky sú otvorené.Ako to funguje?" (measured). An explicit space
               text node renders in BOTH branches and is what the fallback test's
               whole-string pin holds. -->
          {{ ' ' }}<router-link to="/ako-to-funguje" style="font-weight:700">Ako to funguje?</router-link>
        </div>
      </div>

      <!-- 2. THE DEBT BANNER (§UC-PI-008) — one of three call sites for ONE
              component; the debt predicate is `lib/money.js isInDebt()` and lives inside it. -->
      <DebtBanner :balance="balance" :can-pay="canPayBalance" @pay="openBalancePayment" />

      <!-- 3./4. THE ORDER SURFACE AND ITS `.cartbar` (§UC-PI-005 items 3 and 4).
           ⚠ ONE HOME, EXTENDED — never forked, never partially copied. The `ref` is
           how the drawer reaches `openShareDialog()` and `cartTotal` (§UC-PI-011,
           §UC-PI-004 item 1) without this view holding either.

           ⚠ `:key` on the cycle id: `FriendOrder` loads its order from `onMounted`
           only and has no watch on its cycle (a lifetime assumption recorded in its
           own header), so re-pointing the same instance at a different round would
           leave `order`/`cart`/`paymentVs` from the previous one. The key re-creates
           it instead, which is the assumption this file must not quietly break. -->
      <FriendOrder
        ref="landingOrder"
        :key="landing.currentCycle.id"
        mode="landing"
        :cycle-id="landing.currentCycle.id"
        :friend-id="friendId"
      />
    </template>

    <!-- ═══════════════ 18 §UC-PI-006 — THE LANDING, CLOSED STATE (PI-T4) ═══════
         R1.3: no open round ⇒ a read-only catalogue behind a dismissible state
         modal, then a slim banner. `landing.state === 'closed'` means „no `open`
         and no `locked` round" (`lib/portal-state.js`) — the LOCKED landing is
         PI-T5's and keeps its own branch. -->
    <template v-else-if="view === 'shop' && landing.state === 'closed'">
      <!-- 1. THE STATE MODAL — once per session (see `closedModalDismissed`).
           ⚠ Its title/intro are passed as PROPS, not baked into the component:
           §UC-PI-007's no-order LOCKED variant is the same modal with „Objednávky
           sú uzavreté" (GP-T7, PO 2026-09-24: ~~uzamknuté~~) / „Táto objednávka je už uzavretá — káva je objednaná
           v pražiarni." and PI-T5 must not need a second one.

           ⚠ `timelineCycle` is `nextCycle ?? catalogCycle` (§UC-PI-006) and it is
           handed to `CycleTimeline` as `:cycle` — module 17 decides which dot is
           „now". This view never builds a step array. -->
      <LandingStateModal
        v-if="showClosedModal"
        title="Objednávky sú zatvorené"
        intro="Káva sa objednáva spoločne, v termínoch — pár dní naraz, potom ju nakúpime v pražiarni a rozdáme si ju."
        :next-cycle="landing.nextCycle"
        :next-opening="landing.nextOpening"
        :timeline-cycle="landing.nextCycle || landing.catalogCycle"
        @close="dismissStateModal"
        @explainer="stateModalToExplainer"
      />

      <!-- 2. …AND AFTER DISMISSAL, THE SLIM BANNER THAT REPLACES IT.
           ⚠⚠ THIS IS WHERE THE TWO DATE FORMATS MEET, AND IT IS A RECORDED PO
           QUESTION, NOT A DEFECT WITH AN OWNER. `landing.nextText` is module 17's
           composed sentence („Ďalšia objednávka sa otvorí približne 3. OKTÓBRA"),
           while the modal's card sets the same date in display type through 18's
           `fmtDayMonth` („3. 10."). Both are specified — 17 §UC-CS-005 and 18
           §UC-PI-002 — for the same sentence, and PI-T1 kept the shipped one
           because the alternative is a second home for it (learnings 10 §1, both
           options costed). ⚠ PI-T4 must NOT resolve it at a call site: reformatting
           either one here is how the second home finally gets created. It is one
           sentence with one home until the PO rules.

           `white-space:pre-line` because branch 2 of `nextText` is the admin's
           `plan_note`, verbatim, newlines and all (§UC-PI-002). Kept on ONE source
           line so the template's own indentation cannot become rendered whitespace. -->
      <div v-else class="banner warn slim" data-testid="landing-closed-banner">
        <span class="dot"></span>
        <div style="min-width:0;overflow-wrap:anywhere;white-space:pre-line"><b>Objednávky sú zatvorené.</b> <span v-if="nextIsNote" data-user-copy>{{ landing.nextText }}</span><template v-else>{{ landing.nextText }}</template></div>
      </div>

      <!-- 3. THE DEBT BANNER (§UC-PI-008) — „shown in all three landing states". -->
      <DebtBanner :balance="balance" :can-pay="canPayBalance" @pay="openBalancePayment" />

      <!-- 4. THE READ-ONLY CATALOGUE of `catalogCycle` — the newest `locked` or
             `completed` round (`lib/portal-state.js`). ⚠ NOT `currentCycle`, which
             is `null` here by design: a `planned` round has no products a friend
             may look at. -->
      <template v-if="landing.catalogCycle">
        <!-- The caption row is THIS view's (`portal2.jsx:288-290`), above the grid
             and outside `.p2-ro` so it keeps full contrast. -->
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
          <span class="field-lbl" style="min-width:0;overflow-wrap:anywhere">Minulá ponuka · <span data-user-copy>{{ landing.catalogCycle.name }}</span></span>
          <span class="sub mono" style="white-space:nowrap;font-size:12px">len na prezretie</span>
        </div>

        <!-- ⚠ THE SAME `FriendOrder`, WITH `readonly` — never a second card
             template (§UC-PI-006). It brings `.p2-ro` on the cards, disabled
             steppers, no stock bars, no cartbar, no tabgroup; the `.cat-tabs`
             strip stays live so every category is browsable.

             ⚠ NO `ref="landingOrder"`: that ref is the OPEN landing's bridge to
             `cartTotal`, and a closed round has no cart. ⚠ GL-T6c: its OWN ref,
             `closedOrder`, is drawer item 4's bridge on this landing (`shareHost`) —
             this mount's dialog is standing-only (`FriendOrder`'s `shareCycleId`
             is `null` on a `readonly` mount), so the row reaches the one instance
             without a second one being mounted here. -->
        <FriendOrder
          ref="closedOrder"
          :key="`ro-${landing.catalogCycle.id}`"
          mode="landing"
          readonly
          :cycle-id="landing.catalogCycle.id"
          :friend-id="friendId"
        />
      </template>

      <!-- No locked and no completed round has ever existed ⇒ there is no
           catalogue to show (§UC-PI-006). This one string replaces BOTH of module
           03's retired empty states, whose wording §UC-PI-017 forbids. -->
      <div
        v-else
        class="sub"
        style="text-align:center;padding:24px 0"
        data-testid="landing-empty"
      >Ponuka ešte nie je pripravená.</div>
    </template>

    <!-- ═══════════════ 18 §UC-PI-007 — THE LANDING, LOCKED STATE (PI-T5) ═══════
         R1.4: the friend ordered, the round is locked ⇒ „where is my coffee".

         ⚠ THE SHIPPED LOCKED TREATMENT IS REPLACED HERE AND NOWHERE ELSE. 04
         §UC-FO-014's `.banner.warn` („Objednávky sú uzavreté. Už nie je možné
         meniť objednávku.") and the locked cartbar stay on the `/cycle/:id` deep
         link, byte for byte — §UC-PI-007's business rule says „replaced on the
         landing only", `order-locked.spec.js` still pins them there, and
         `FriendOrder`'s own `readonly` switches are what make the difference.

         ⚠ MONEY: nothing in this branch writes a ledger row. `paid` renders
         read-only (it is the admin's toggle), `paymentTotal` includes
         `delivery_fee` for DISPLAY only (04 resolved conflict #9) and
         `transactions` rows still come only from the friend paid toggle and
         pack/unpack (CLAUDE.md §Money & data). -->
    <template v-else-if="view === 'shop' && landing.state === 'locked' && landing.currentCycle">
      <!-- 1. THE DEBT BANNER (§UC-PI-008) — „above the own-order card in `locked`",
              and above the no-order variant's modal/banner for the same reason: it
              is the first thing on this landing, before anything about the round. -->
      <DebtBanner :balance="balance" :can-pay="canPayBalance" @pay="openBalancePayment" />

      <template v-if="landing.currentCycle.hasOrder">
        <!-- 2. THE OWN-ORDER CARD (§UC-PI-007 item 2).
             ⚠ It renders from the EMBEDDED `FriendOrder`'s loaded order — „no
             second loader" — reached through that component's `defineExpose`
             (`lockedOwnOrder`). It is deliberately below the mount in the script
             and above it in the DOM: the card is the page's headline and the grid
             is the footnote, while the fetch belongs to the component that already
             owns this order's payment state, its variable symbol and its modal. -->
        <div
          v-if="lockedOwnOrder"
          class="card hl"
          style="padding:16px"
          data-testid="own-order-card"
        >
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <!-- ⚠ `line-height` INLINE — `friends-theme.css` loads after Tailwind and
                 `:where(.app,.modal-layer) .display` matches at the same specificity
                 as a utility, so the canon's value survives only as a style attribute
                 (CLAUDE.md §Frontend; the same remedy `LandingStateModal` uses).
                 ⚠ The canon's value HERE is `1` (`portal2.jsx:350`, and `:356` for the
                 total below). PI-T5 shipped `.9` — `LandingStateModal`'s 38px date value,
                 a different element — and PI-T12's `portal-fidelity` pin measured it
                 (19.8px, not 22px). -->
            <span class="display" style="font-size:22px;line-height:1">Vaša objednávka</span>
            <!-- The cycles payload's `hasOrder` is a SUBMITTED order (`routes/
                 friends.js`), so this badge has no second state to carry. -->
            <span class="badge ok">Odoslaná</span>
          </div>

          <!-- ⚠ `CartLineList` — THE one home for an ordered-items list. The Packeta
               fee arrives as an EXTRA, never an item: `orders.delivery_fee` is a
               field on the order and has never been an `order_items` row. -->
          <div style="margin-top:12px">
            <CartLineList
              :items="lockedOwnOrder.lines"
              :extras="lockedOwnOrder.extras"
              :purpose-order="lockedOwnOrder.purposeOrder"
              line-testid="own-order-line"
            />
          </div>

          <!-- ⚠ `paymentTotal`, i.e. goods + `delivery_fee` (04 resolved conflict
               #9) — the same number the „Zaplatiť" button and `PaymentModal` bill.
               `EUR` on a total, `€` on the lines above (CLAUDE.md §Frontend). -->
          <div class="p2-tot">
            <span class="field-lbl">Spolu</span>
            <span
              class="display"
              style="font-size:22px;line-height:1"
              data-testid="own-order-total"
            >{{ fmtEur(lockedOwnOrder.total) }}</span>
          </div>

          <!-- The pickup row — EXACTLY ONE of a location name, a free-text note or
               the Packeta line (`helpers/pickup.js` semantics; the precedence is
               written out in `FriendOrder`'s `orderPickupText`). Absent entirely
               when the party has no target yet, rather than an empty badge. -->
          <div
            v-if="lockedOwnOrder.pickup.data"
            style="border-top:2px solid rgba(10,10,10,0.12);margin-top:14px;padding-top:12px"
          >
            <!-- ⚠ `inline-flex` AT THE CALL SITE: `.badge` is `inline-block` and
                 Tailwind preflight makes every `svg` `display:block`, which drops
                 the glyph onto its own line (CLAUDE.md §Frontend). -->
            <span
              class="badge"
              style="display:inline-flex;align-items:center;gap:6px;white-space:normal;overflow-wrap:anywhere;text-align:left"
              data-testid="own-order-pickup"
            >
              <NeoIcon name="pin" />
              <!-- `pickup.text` is app copy („Packeta · "), `pickup.data` is typed
                   (address / location name / note) — marked on its own (FUP-T22). -->
              <span style="min-width:0">{{ lockedOwnOrder.pickup.text }}<span data-user-copy>{{ lockedOwnOrder.pickup.data }}</span></span>
            </span>
          </div>

          <!-- The payment row. ⚠ `paid` is READ-ONLY here: writing it is admin-only
               (CLAUDE.md §Money & data), and „Zaplatiť" opens the ONE `PaymentModal`
               that `FriendOrder` already mounts for this order — with the SERVER's
               variable symbol, which no client derives. The button is absent when
               no payment settings are configured (§UC-PI-007 item 2). -->
          <div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span v-if="lockedOwnOrder.paid" class="badge ok" data-testid="own-order-paid">Zaplatené</span>
            <template v-else>
              <span class="badge warn" data-testid="own-order-paid">Nezaplatené</span>
              <button
                v-if="lockedOwnOrder.canPay"
                type="button"
                class="btn sm accent"
                data-testid="own-order-pay"
                @click="payOwnOrder"
              >Zaplatiť {{ fmtEur(lockedOwnOrder.total) }}</button>
            </template>
          </div>
        </div>

        <!-- 3. „KDE JE VAŠA KÁVA" (§UC-PI-007 item 3) — module 17's VERTICAL
               timeline, the first one on the friend portal.
               ⚠ `:cycle`, never `:steps`: 17 owns the six steps, their labels and
               the „now" rule (`stageIndex()` reads `status` before `stage`, which is
               what keeps three measured stale-`stage` transitions invisible). A
               consumer that assembled steps would own their `state` field and bring
               all three back on this one screen.
               ⚠ §UC-PI-007 also names an `order` input („so 17 can mark hand-over on
               the last steps"); `CycleTimeline` has no such prop — 17 §UC-CS-006 says
               „No other props" and CS-T2 shipped it that way. Passing one would land
               as a stray fallthrough ATTRIBUTE on the root div, so it is not passed;
               the seam 17 did ship for injected content is `steps`, and using it here
               would be the fork this comment refuses. -->
        <div class="card" style="padding:16px 16px 4px" data-testid="where-is-my-coffee">
          <div class="field-lbl" style="margin-bottom:10px">Kde je vaša káva</div>
          <CycleTimeline variant="vertical" :cycle="landing.currentCycle" />
        </div>

        <!-- 4. THE NEXT-ROUND BANNER (§UC-PI-007 item 4). See `nextRoundShort` for
               why its date is the SHORT form and why that is not a call-site
               resolution of the recorded PO question: this is module 18's own
               sentence, not module 17's. `pre-line` because branch 2 is the admin's
               `plan_note`, verbatim; kept on one source line so the template's
               indentation cannot become rendered whitespace. -->
        <div class="banner slim" data-testid="landing-next-round">
          <span class="dot"></span>
          <div style="min-width:0;overflow-wrap:anywhere;white-space:pre-line"><b>Ďalšia objednávka</b> <template v-if="nextRoundShort.kind === 'date'">približne <b>{{ nextRoundShort.date }}</b></template><template v-else-if="nextRoundShort.kind === 'note'"><span data-user-copy>{{ nextRoundShort.note }}</span></template><template v-else>— dáme vedieť</template> — ponuku si už môžete prezrieť nižšie.</div>
        </div>
      </template>

      <!-- „Locked, NO own order" (§UC-PI-007) — the CLOSED-state treatment with two
           different strings. ⚠ The SAME `LandingStateModal`, parametrised by PI-T4
           for exactly this; a second modal component is the defect that
           parametrisation exists to prevent.
           ⚠ `timelineCycle` is `currentCycle` HERE, not `nextCycle ?? catalogCycle`
           as in the closed state — and that is the question the prop exists to let
           the caller answer. „Kde sme teraz" on a locked landing is the round in
           flight; handing it the PLANNED round would print „Pripravujeme ďalšiu
           objednávku" over a round whose coffee is at the roastery. -->
      <template v-else>
        <LandingStateModal
          v-if="showLockedModal"
          title="Objednávky sú uzavreté"
          intro="Táto objednávka je už uzavretá — káva je objednaná v pražiarni."
          :next-cycle="landing.nextCycle"
          :next-opening="landing.nextOpening"
          :timeline-cycle="landing.currentCycle"
          @close="dismissStateModal"
          @explainer="stateModalToExplainer"
        />

        <!-- ⚠ The same two-format collision the closed banner carries, for the same
             recorded reason: `landing.nextText` is module 17's composed sentence and
             must NOT be reformatted at this call site (learnings 10 §1). -->
        <div v-else class="banner warn slim" data-testid="landing-locked-banner">
          <span class="dot"></span>
          <div style="min-width:0;overflow-wrap:anywhere;white-space:pre-line"><b>Objednávky sú uzavreté.</b> <span v-if="nextIsNote" data-user-copy>{{ landing.nextText }}</span><template v-else>{{ landing.nextText }}</template></div>
        </div>
      </template>

      <!-- 5. THE READ-ONLY GRID of `currentCycle` (§UC-PI-007 item 5) — shared by
             both variants above, because a host with no own order is exactly the
             party §UC-PI-007's tabgroup rule is about.
             ⚠ Caption „Ponuka · {name}", NOT „Minulá ponuka · …": this round is the
             current one, it is simply no longer orderable. -->
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
        <span class="field-lbl" style="min-width:0;overflow-wrap:anywhere">Ponuka · <span data-user-copy>{{ landing.currentCycle.name }}</span></span>
        <span class="sub mono" style="white-space:nowrap;font-size:12px">len na prezretie</span>
      </div>

      <!-- ⚠ `colleagues-tab` IS THE SPLIT PI-T4 LEFT FOR THIS ROW. `readonly` alone
           used to carry both „the grid is inert" and „there is no tabgroup"; the
           locked landing needs the first without the second, because a host's
           hand-over ticks happen precisely now (05 §UC-KG-004). The closed
           catalogue passes nothing and keeps PI-T4's behaviour.
           ⚠ `ref="lockedOrder"` — a SEPARATE ref from the open landing's
           `landingOrder`, whose two readers (the cart total, the share dialog) mean
           „the OPEN round's live surface". See its note in the script. -->
      <FriendOrder
        ref="lockedOrder"
        :key="`lk-${landing.currentCycle.id}`"
        mode="landing"
        readonly
        colleagues-tab
        :cycle-id="landing.currentCycle.id"
        :friend-id="friendId"
      />
    </template>

    <!-- ═══════════════ 18 §UC-PI-009 — „MOJE OBJEDNÁVKY" (PI-T6) ════════════════
         The rounds the friend ordered in, newest first. It replaces 03 §UC-FL-008's
         „Archív" fold (supersession map), and the word „Archív" itself is gone —
         §UC-PI-017's vocabulary rule, pinned in `portal-history.spec.js` §5.

         ⚠ READ-ONLY, AND THE MISSING LINK IS A PRODUCT DECISION, NOT AN OVERSIGHT.
         §UC-PI-009: „Clicking the card toggles; the card does NOT navigate (03
         resolved conflict #4 is reversed here: the deep link `/cycle/:id` remains
         available but history is a reading surface)", and its `OPEN:` for an
         „Otvoriť" link resolved to omitted. Nothing in this block writes anything.

         ⚠ Its own flex column (`portal2.jsx:201`), because the page column is not
         one — the landing states space themselves through their children. -->
    <div v-if="view === 'history'" style="display:flex;flex-direction:column;gap:12px">
      <!-- 28px on phone / 34px on desktop (§UC-PI-009). `.h-screen .hl` is the
           theme's own accent-block rule (`friends-theme.css:59`) — the size is the
           only thing this call site supplies, and it does so through Tailwind
           because the theme deliberately declares no `font-size` for `.h-screen`. -->
      <h2 class="h-screen text-[28px] sm:text-[34px]">Moje <span class="hl">objednávky</span></h2>

      <!-- EMPTY STATE. „Lists only rounds with `hasOrder`" (resolved conflict 8), so
           a friend who has browsed but never submitted sees this rather than a list
           of rounds they had nothing to do with. -->
      <div
        v-if="!historyRounds.length"
        class="sub"
        style="text-align:center;padding:24px 0"
        data-testid="history-empty"
      >
        <div>Zatiaľ žiadne objednávky.</div>
        <router-link to="/" style="font-weight:700;text-decoration:underline">Prezrieť aktuálnu ponuku</router-link>
      </div>

      <!-- ONE CARD PER ROUND. The current round (`open` or `locked`) carries `.hl`,
           every past one `.flat` (§UC-PI-009).

           ⚠ `role="button"` + `tabindex` + Enter/Space, the repo's idiom for a
           clickable non-button (`.p2-mi`, the appbar chips): the whole card is the
           toggle, as in the prototype, and a keyboard must be able to work it.
           `aria-expanded` is what makes the state audible. -->
      <div
        v-for="round in historyRounds"
        :key="round.id"
        class="card"
        :class="round.status === 'open' || round.status === 'locked' ? 'hl' : 'flat'"
        style="padding:14px;cursor:pointer"
        role="button"
        tabindex="0"
        :aria-expanded="expandedRound === round.id"
        data-testid="history-round"
        @click="toggleRound(round)"
        @keydown.enter.prevent="toggleRound(round)"
        @keydown.space.prevent="toggleRound(round)"
      >
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div style="min-width:0">
            <!-- ⚠ `line-height` INLINE — `friends-theme.css` loads after Tailwind and
                 `:where(.app,.modal-layer) .display` matches at the same specificity
                 as a utility, so the canon's value survives only as a style attribute
                 (CLAUDE.md §Frontend). `overflow-wrap:anywhere` because a cycle name
                 is admin free text and `min-w-0` alone is not a wrapping rule. -->
            <div class="display" style="font-size:20px;line-height:1;overflow-wrap:anywhere" data-user-copy>{{ round.name }}</div>
            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
              <!-- ⚠ THE SHORT VOCABULARY, owned by `lib/history-badges.js` and
                   deliberately NOT module 17's long timeline labels — see that
                   file's header before „fixing" the duplication. -->
              <span
                class="badge"
                :class="historyBadge(round).tone"
                data-testid="history-badge"
              >{{ historyBadge(round).text }}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <!-- `orderTotal` is the server's `total + delivery_fee`, already rounded
                 (`routes/friends.js`). ⚠ Once the row is EXPANDED the total is re-quoted
                 from that fetch instead (`roundLines[id].total`), because `cycles` is
                 seeded at the handshake and never reloaded in-session — see
                 `loadRoundLines`. Either way the number is the SERVER's; this view still
                 derives no money. `EUR` on a total, `€` on the lines below.
                 ⚠ NO inline `line-height`, unlike the name beside it: the canon sets
                 `fontSize: 18` and nothing else here (`portal2.jsx:211`), so `.display`
                 is left to A10's `normal`. PI-T6 shipped `.9` (16.2px, measured by
                 PI-T12's `portal-fidelity` pin). -->
            <span
              class="display"
              style="font-size:18px"
              data-testid="history-total"
            >{{ fmtEur(roundLines[round.id]?.total ?? round.orderTotal) }}</span>
            <span class="chev" :class="{ open: expandedRound === round.id }"><NeoIcon name="chev" /></span>
          </div>
        </div>

        <!-- THE LAZY BODY. Fetched on first expand, cached per round for the
             session, per-row pending and per-row error (§UC-PI-009). -->
        <div v-if="expandedRound === round.id" style="margin-top:12px">
          <div v-if="roundPending[round.id]" class="sub" data-testid="history-loading">Načítavam...</div>
          <div v-else-if="roundError[round.id]" class="banner danger slim" data-testid="history-error">
            <span class="dot"></span>
            <div style="min-width:0">{{ roundError[round.id] }}</div>
          </div>
          <!-- ⚠ `CartLineList` — THE one home for an ordered-items list. The Packeta
               fee arrives as an EXTRA, never an item (`lib/order-lines.js`). -->
          <CartLineList
            v-else-if="roundLines[round.id]"
            :items="roundLines[round.id].lines"
            :extras="roundLines[round.id].extras"
            line-testid="history-line"
          />
        </div>
      </div>
    </div>

    <!-- ═══════════════ 18 §UC-PI-010 — „ZOSTATOK A PLATBY" (PI-T7) ══════════════
         The whole money picture, on the one screen that is allowed to show a
         settled balance. It replaces 03 §UC-FL-005's landing card AND the
         „Transakcie" modal behind it (`FriendTransactionsModal.vue`, deleted in this
         commit; the supersession map at 18 §7 records both).

         ⚠ Its own flex column (`portal2.jsx:228`), like the history view — the page
         column is not one. -->
    <div v-if="view === 'balance'" style="display:flex;flex-direction:column;gap:14px">
      <!-- 28px on phone / 34px on desktop (§UC-PI-010), the history heading's rule.
           `.h-screen .hl` is the theme's own accent-block rule; the size is the only
           thing this call site supplies. -->
      <h2 class="h-screen text-[28px] sm:text-[34px]">Zostatok <span class="hl">a platby</span></h2>

      <!-- 1. THE ACCOUNT CARD. It reads the SESSION's balance refs (one fetch per
              session load, re-run on entering this view) and emits `pay`; the modal
              it opens is mounted once, below. -->
      <FriendBalanceCard
        :balance="balance"
        :payment="balancePayment"
        :loading="balanceLoading"
        :error="balanceError"
        @pay="openBalancePayment"
      />

      <!-- 2. THE LEDGER — `FriendTransactionList.vue`, lifted verbatim out of the
              deleted modal (§UC-PI-010 item 2). It owns its own
              `api.getTransactions` call and its own loading/empty/error copy; being
              `v-if`-gated here is what makes „reloads on mount" true for it.

              ⚠ NO `.card.flat` WRAPPER, though `portal2.jsx:236` has one: the
              lifted markup's `.suborder` is ALREADY a bordered, shadowed card
              (`friends-theme.css:226`), so wrapping it would double-frame the list.
              §UC-PI-010 says the rows come over VERBATIM, which settles it — the
              prototype's `.p2-tx` row and its frame are the thing not adopted. -->
      <FriendTransactionList :friend-id="friendId" />
    </div>

    <!-- ═══════════════ 18 §UC-PI-012 — „AKO TO FUNGUJE" (PI-T8) ════════════════
         ⚠ THE WHOLE VIEW IS ONE COMPONENT, and that is the shape PI-T9 needs
         (§UC-PI-013): the first-login gate is THIS page with `as-gate` true, not a
         second screen with the same six paragraphs on it. That row passes the flag
         here and reads `@done`'s `{ hide }`; it edits neither the component nor
         `lib/roasters.js`.

         ⚠ NO `CycleTimeline` — deliberately, and it is the one thing about this
         view that will read as an omission. The six phases below ARE module 17's
         six steps, but as an explanation of the process rather than a report on one
         round; §UC-PI-012 item 3 says the live timeline is not mounted here and the
         component's header argues why. `portal-explainer.spec.js` §1 reds on an
         import of `lib/cycle-stages.js` into either file.

         ⚠ Its own column: the component declares one, like the two views above. -->
    <PortalExplainer
      v-if="view === 'explainer'"
      :as-gate="explainerGate"
      :parcel-enabled="explainerParcelEnabled"
      :parcel-fee="explainerParcelFee"
      @done="onExplainerDone"
    />
  </div>

  <!-- ⚠⚠ THE ONE BALANCE `PaymentModal` IN THE TREE (§UC-PI-008 / §UC-PI-010; 15
       §UC-PL-007 item 4 RELOCATED, never duplicated). PL-T4 mounted it inside
       `FriendBalanceCard.vue`; module 18 gives the same debt two surfaces on two
       different views, so the mount came UP here where both can reach it —
       `pay-balance` on the card and `debt-banner-pay` in the landing banner both
       call `openBalancePayment()`.

       PROPS IN / LINKS OUT: every value is the server's (`balancePaymentBlock()`),
       and nothing on this side composes a symbol, a reference or an amount.

       ⚠ `close` deliberately does NOT reload the balance: paying through a link
       changes nothing in the ledger until the admin records the transfer, and a
       refreshed-looking balance would tell the friend otherwise. No `transactions`
       row is written anywhere on this surface. -->
  <PaymentModal
    v-if="balancePayment"
    :open="showBalancePayment"
    :amount="balancePayment.amount"
    :reference="balancePayment.reference"
    :iban="balancePayment.iban"
    :revolut-username="balancePayment.revolut_username"
    :variable-symbol="balancePayment.variable_symbol"
    :creditor-name="balancePayment.creditor_name"
    @close="showBalancePayment = false"
  />

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
         (UC-DS-011 is the copy control; this is just its box). The box is
         content-sized, exactly as `portal.jsx` renders it: no `flex:1`, so it
         is as wide as its own label/value and shrinks (`.val` carries
         `min-width:0`) rather than overflowing.

         ⚠ FUP-T20 — the `Jedinečné ID` box that used to sit to the left of the
         username is REMOVED (product decision): `friends.uid` is an internal
         identifier with nothing a friend can read off it or act on. The `uid`
         itself is untouched everywhere else — it still rides in the stored
         session (`friendUid`) and the admin still shows it in its own ID column
         — so this is a presentation removal, not a data change. The flex row is
         KEPT as the row it always was; it now holds one box, and keeping it is
         what preserves the content-sized rendering the `.copyrow` box relies on.

         ⚠ `<label for=…>` only associates with LABELABLE elements, and a
         `div` is not one, so the association runs the other way here:
         the label carries the id and the box points at it with
         `aria-labelledby`. That is what keeps `getByLabel` resolving on a
         non-input — plain `for` would silently associate with nothing. -->
    <div style="display:flex;gap:10px">
      <!-- Username renders only when there IS one: legacy friends have no
           credentials at all (repo behavior beats the prototype's demo
           friend, who always does). It is READ-ONLY by design (UC-FL-009, and
           re-confirmed by FUP-T20's product decision: the admin renames, and
           module 10's Google login likely removes the need entirely). -->
      <div v-if="friend?.username">
        <!-- ⚠ 18 §UC-PI-015 (PI-T10) — the label is „Login", not „Užívateľské meno".
             §19 (newest) renames THIS row and only this row: the LOGIN SCREEN keeps
             „Užívateľské meno" (03 §UC-FL-002) and so do both username-setup dialogs
             further down this file (`pp-first-username`, `pp-setup-username`). The help
             line is worded „…ktorým sa prihlasujete…" — a VERB — on purpose: FUP-T20's
             source grep covers this file and the forbidden ADJECTIVE may not appear in
             it, copy or comment (CLAUDE.md / 07 §UC-IA-007). -->
        <label id="pp-profile-username-lbl" class="field-lbl">Login</label>
        <div class="copyrow">
          <div class="val" aria-labelledby="pp-profile-username-lbl" data-testid="profile-username">{{ friend.username }}</div>
        </div>
        <div class="field-help">Meno, ktorým sa prihlasujete. Nemení sa.</div>
      </div>
    </div>

    <!-- ⚠ FUP-T20 — THE BUG THIS ROW EXISTS FOR. This field binds `profileName`
         and writes `friends.name`, a DISPLAY label that never was a login, yet its
         label claimed to be the LOGIN NAME while its own help line one row below
         said the opposite. A friend editing "their login name" changed nothing
         about how they log in and silently renamed themselves. It is the same
         mislabel module 11 fixed in `AdminFriends.vue` (11 §UC-FC-001/003); it
         survived here because §UC-FC-002's grep guard named that ONE file.
         ⚠ THE GUARD NOW COVERS THIS FILE TOO — see CLAUDE.md / 07 §UC-IA-007: it
         must return nothing for `AdminFriends.vue` AND `FriendPortalSession.vue`,
         which is why no string here (copy or comment) spells out the forbidden
         adjective. The login is the read-only `Login` box above (⚠ relabelled from
         „Užívateľské meno" by PI-T10, 18 §UC-PI-015 row 1 — this sentence named the
         old label for eight lines after the label moved, and the grep guard cannot
         see a stale reference, only a forbidden stem) (and it
         stays read-only by product decision); `friends.name` is the PACKETA
         DELIVERY name, which is why it is required and why the help text says so. -->
    <div>
      <label class="field-lbl" for="pp-profile-name">Meno a priezvisko *</label>
      <!-- ⚠ `maxlength` ADDED BY PI-T10 (§UC-PI-015 row 2 names 120 = MAX_NAME_LENGTH).
           It was the ONE server bound on this form with no mirror — measured, not
           assumed: the field contract test reddened on `maxlength=null` here while the
           phone/e-mail/Packeta mirrors were all in place. CLAUDE.md's rule („server
           length bounds are mirrored as maxlength in the UI") had a hole exactly here. -->
      <input
        id="pp-profile-name"
        v-model="profileName"
        class="inp"
        maxlength="120"
        :disabled="profileSaving"
      />
      <div class="field-help">Celé meno. Uvádza sa na zásielke pri doručení Packetou a vidí ho správca aj kolegovia.</div>
    </div>

    <!-- UC-FC-009: the friend's own contact data. Mobil keeps its format-example
         placeholder (a format example, not a label substitute — the admin modal
         does the same); E-mail has NO placeholder (the 2026-08-10 no-placeholder
         login decision). `maxlength` mirrors the server bounds (MAX_PHONE_LENGTH 32 /
         MAX_EMAIL_LENGTH 160 — the GSO-T3 mirror convention).

         ⚠ 18 §UC-PI-015 (PI-T10) — THE ORDER OF THIS BODY IS THE CONTRACT, and it
         changed: Login → Meno a priezvisko → Mobil → E-mail → Adresa Packeta. The
         Packeta address moved to LAST (it is the optional one), and Mobil moved ahead
         of E-mail because Mobil is now REQUIRED. `portal-profile-modal.spec.js` pins
         the `.field-help` sequence, so a field moved here without its help moving reds
         that test. -->
    <div>
      <!-- ⚠ REQUIRED since PI-T10 (§UC-PI-015 row 3): the star is not decoration —
           `PATCH /friends/:id/profile` answers 400 `{field:'phone'}` on a blank phone
           (this route only; the admin PATCH may still clear one), and „Uložiť" is
           disabled while it is empty. `type="tel"` is new too. -->
      <label class="field-lbl" for="pp-profile-phone">Mobil *</label>
      <input
        id="pp-profile-phone"
        v-model="profilePhone"
        class="inp"
        type="tel"
        maxlength="32"
        placeholder="+421 900 000 000"
        :disabled="profileSaving"
      />
      <div class="field-help">Pre koordináciu objednávky a odovzdanie.</div>
    </div>

    <!-- ⚠⚠ MODULE 21 SLOT — `friends.whatsapp_opt_in` (18 §UC-PI-015 row 3½, backlog
         WA-T1). The WhatsApp opt-in `NeoCheckbox` row goes HERE, directly under Mobil
         and directly above E-mail, and its label + privacy sentence are module 21's
         strings, not this module's. PI-T10 renders NOTHING for it on purpose: an empty
         marker is what keeps the field ORDER above stable when the checkbox lands.
         Do not move this comment when adding fields. -->

    <div>
      <!-- ⚠ „E-mail", with the hyphen (§UC-PI-015 row 4). It used to be „Email"; the
           two are DIFFERENT strings to `getByLabel`, which substring-matches, so the
           rename is a real retarget rather than cosmetics. -->
      <label class="field-lbl" for="pp-profile-email">E-mail</label>
      <input
        id="pp-profile-email"
        v-model="profileEmail"
        class="inp"
        type="email"
        maxlength="160"
        :disabled="profileSaving"
      />
      <!-- ⚠ REPLACES „Bez e-mailu vám nevieme poslať odkaz na obnovenie prístupu."
           (§UC-PI-015 row 4). The recovery half survives inside the new sentence; the
           Packeta half is new, and it is why the field is worth keeping at all now
           that Mobil carries the coordination duty. The ADMIN modal's own hint („Bez
           e-mailu sa priateľovi nedá poslať…") is a different string on a different
           surface and is untouched. -->
      <div class="field-help">Voliteľné. Packeta naň posiela informácie o zásielke; slúži aj na obnovenie prístupu.</div>
    </div>

    <div>
      <label class="field-lbl" for="pp-profile-packeta">Adresa Packeta výdajného miesta</label>
      <input
        id="pp-profile-packeta"
        v-model="profilePacketaAddress"
        class="inp"
        maxlength="160"
        placeholder="napr. Z-BOX Hlavná 15, Bratislava"
        :disabled="profileSaving"
      />
      <div class="field-help">Predvolená adresa pre doručenie Packetou (voliteľné).</div>
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

    <!-- FIRST-password fold (GA-T11) — the OTHER half of the fold above, and the two
         are mutually exclusive by construction: that one needs `hasCredentials` truthy,
         this one needs it strictly `false`. It exists because the friend it serves
         could previously see NEITHER — `needsCredentialSetup` fires only in transition
         mode, and the change fold is hidden exactly when there is nothing to change.

         ⚠ The toggle says "Nastaviť heslo", NOT "Zmeniť heslo", and the difference is
         pinned in `google-auth.spec.js`: setting a first password and changing an
         existing one are different acts with different endpoints, and a friend who has
         never had a password must not be asked for a current one.
         ⚠ Same two-state trick as the fold above: the toggle reads "Skryť nastavenie
         hesla" exactly when the submit button exists, so
         `getByRole('button', { name: 'Nastaviť heslo' })` stays unambiguous in both. -->
    <div
      v-if="canSetFirstPassword"
      data-testid="profile-set-password"
      style="border-top:2px solid rgba(10,10,10,0.12);padding-top:12px"
    >
      <button
        type="button"
        class="btn ghost sm"
        style="color:var(--accent);font-weight:700;padding:0"
        @click="showPasswordSet = !showPasswordSet"
      >
        {{ showPasswordSet ? 'Skryť nastavenie hesla' : 'Nastaviť heslo' }}
      </button>
      <div v-if="!showPasswordSet" class="field-help" style="margin-top:6px">
        Zatiaľ nemáte vlastné heslo. Nastavte si ho a budete sa môcť prihlásiť menom a heslom.
      </div>

      <div
        v-if="showPasswordSet"
        style="display:flex;flex-direction:column;gap:12px;margin-top:12px"
      >
        <div v-if="firstPasswordError" class="banner danger slim">
          <span class="dot"></span>
          <div style="min-width:0">{{ firstPasswordError }}</div>
        </div>

        <!-- Rendered only when there is no name to log in with yet. It is the ONE
             place this view writes `friends.username`, and it writes it exactly once:
             the server honours it while the column is NULL and never as a rename, so
             the read-only box at the top of this modal stays the only view of an
             existing one (FUP-T20's product decision).
             ⚠ `maxlength` mirrors the server bound (`validateUsername`: 3–30) — the
             GSO-T3 mirror convention. -->
        <div v-if="firstNeedsUsername">
          <label class="field-lbl" for="pp-first-username">Užívateľské meno *</label>
          <input
            id="pp-first-username"
            v-model="firstUsername"
            class="inp"
            maxlength="30"
            autocapitalize="none"
            autocomplete="username"
            :disabled="firstPasswordSaving"
          />
          <div class="field-help">3 – 30 znakov: malé písmená, čísla, bodka, podtržník a pomlčka.</div>
        </div>

        <div>
          <label class="field-lbl" for="pp-first-password">Heslo</label>
          <input
            id="pp-first-password"
            v-model="firstPassword"
            class="inp"
            type="password"
            autocomplete="new-password"
            :disabled="firstPasswordSaving"
          />
          <div class="field-help">Aspoň 8 znakov.</div>
        </div>
        <div>
          <label class="field-lbl" for="pp-first-password-confirm">Potvrdiť heslo</label>
          <input
            id="pp-first-password-confirm"
            v-model="firstPasswordConfirm"
            class="inp"
            type="password"
            autocomplete="new-password"
            :disabled="firstPasswordSaving"
            @keyup.enter="submitFirstPassword()"
          />
        </div>

        <button
          type="button"
          class="btn sm dark"
          :disabled="firstPasswordSaving || (firstNeedsUsername && !firstUsername) || !firstPassword || !firstPasswordConfirm"
          @click="submitFirstPassword()"
        >
          {{ firstPasswordSaving ? 'Nastavujem heslo...' : 'Nastaviť heslo' }}
        </button>
      </div>
    </div>

    <!-- Google section (10 §UC-GA-007) — PURELY ADDITIVE, and that is a requirement,
         not a nicety: `portal-profile-modal.spec.js` pins this modal's labels ~10×
         and must pass unmodified. It sits UNDER the existing fields, adds no
         `.copyrow` (that count is asserted), reuses the fold's own separator style,
         and its cancel is "Nechať prepojené" rather than a second "Zrušiť" — the
         shipped spec resolves `dialog.getByRole('button', { name: 'Zrušiť' })`
         unscoped, and a second match would break it in strict mode.

         ⚠ The mode gate sits on the LINK branch only (`googleCanLink`), never on the
         section: unlink has no server-side mode guard, so a linked friend keeps it on
         every deployment. See `googleCanLink`'s declaration. -->
    <div
      v-if="googleSectionVisible"
      data-testid="profile-google"
      style="border-top:2px solid rgba(10,10,10,0.12);padding-top:12px"
    >
      <label class="field-lbl">Google</label>

      <!-- LINKED: the address (or "Prepojené" when the token carried none) + the
           unlink, behind a confirm. -->
      <template v-if="googleSectionLinked">
        <!-- The address and the unlink share ONE row (product decision, 2026-08-17:
             the stacked form spent a whole line on a short address). `flex-wrap` is
             the safety net, not the intent — at 320px the pair still fits, and if a
             very long address ever pushes past it the button drops below instead of
             overflowing the modal. ⚠ The address needs BOTH `min-width:0` (so the
             flex item may shrink) and `overflow-wrap:anywhere` (so an unbreakable
             address paints inside that box rather than through it — the RD-FO-2
             lesson: `min-width:0` alone does not break a long token). -->
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between">
          <div
            class="sub"
            data-testid="profile-google-email"
            style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere"
          >
            {{ googleSectionEmail || 'Prepojené' }}
          </div>
          <button
            v-if="!googleConfirmUnlink"
            type="button"
            class="btn sm"
            style="flex:0 0 auto"
            :disabled="googleSectionBusy"
            @click="googleConfirmUnlink = true"
          >
            Odpojiť Google účet
          </button>
        </div>
        <!-- ⚠ `.confirmbox` + `.confirmbox .row` are the THEME's own inline-confirm
             classes (friends-theme.css:285-286), used by `GuestShareDialog.vue` — the
             precedent this confirm is modelled on. 02 §UC-DS-004 rule 1 puts a theme
             class ahead of hand-rolled utilities, and it matters here beyond fidelity:
             the destructive question was a `.field-help` (13px `--ink-dim`), i.e. it
             read as dimmed helper text rather than a decision. `.confirmbox` also
             carries A10's `line-height:normal`, so no call-site override is needed. -->
        <!-- ⚠ `v-if`, not `v-else`: the button this used to alternate with now lives
             INSIDE the address row above, so there is no adjacent `v-if` sibling to
             pair with. The two states stay mutually exclusive on the same ref. -->
        <div v-if="googleConfirmUnlink" class="confirmbox" style="margin-top:10px">
          <!-- ⚠ §UC-GA-007: when the friend has no password, the confirm must say so
               BEFORE they act. §UC-GA-004 names the recovery path — the admin reset —
               and this sentence states it rather than implying the account is lost. -->
          <div v-if="googleNoPassword" class="banner warn slim" data-testid="profile-google-warning">
            <span class="dot"></span>
            <div style="min-width:0">
              Bez hesla sa nebudete môcť prihlásiť, kým vám správca nenastaví nové heslo.
            </div>
          </div>
          <span><b>Naozaj chcete odpojiť Google účet?</b></span>
          <div class="row">
            <button
              type="button"
              class="btn sm dark"
              :disabled="googleSectionBusy"
              @click="confirmGoogleUnlink"
            >
              {{ googleSectionBusy ? 'Odpájam...' : 'Áno, odpojiť' }}
            </button>
            <button
              type="button"
              class="btn sm ghost"
              :disabled="googleSectionBusy"
              @click="googleConfirmUnlink = false"
            >
              Nechať prepojené
            </button>
          </div>
        </div>
      </template>

      <!-- UNLINKED: the helper line + Google's own cross-origin iframe button. Brand
           guidelines forbid restyling it, so the container carries the layout only.
           ⚠ `v-else-if`, not `v-else`: outside modern mode there is no link to offer
           and this branch must render NOTHING (the section itself is then absent too,
           but a defensive `v-else` here could resurrect an empty box). -->
      <template v-else-if="googleCanLink">
        <div v-if="googleNoPassword" class="banner warn slim" data-testid="profile-google-warning">
          <span class="dot"></span>
          <div style="min-width:0">
            Bez hesla sa nebudete môcť prihlásiť, kým vám správca nenastaví nové heslo.
          </div>
        </div>
        <div class="field-help">Prepojte si Google účet a prihlasujte sa jedným klikom.</div>
        <div
          ref="googleProfileButtonEl"
          data-testid="google-profile-signin"
          style="margin-top:10px;display:flex;justify-content:center;min-height:44px"
        ></div>
      </template>
    </div>

    <template #footer>
      <button type="button" class="btn" :disabled="profileSaving" @click="showProfileModal = false">
        Zrušiť
      </button>
      <button
        type="button"
        class="btn accent"
        :disabled="!profileName.trim() || !profilePhone.trim() || profileSaving"
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

  <!-- Google link prompt (10 §UC-GA-006). Shown at most ONCE per login, and only for
       a successful non-Google modern login of an unlinked, un-silenced friend — the
       whole trigger lives in `googlePromptEligible`, seeded once at setup.

       ⚠ `title-heading`: the spec's acceptance criteria are written against the
       title, and `NeoModal`'s `.m-title` is a `<div>` by default.

       ⚠ THE FOOTER IS A COLUMN, and that is not a style preference. `.m-foot` is
       `display:flex` and `.m-foot .btn` is `flex:1` with `white-space:nowrap` and no
       `min-width` — a three-option row has NO degradation signal (CLAUDE.md): it
       neither shrinks nor wraps nor ellipsises, it paints outside the modal border
       and hands the scrim a horizontal scrollbar. Measured min-content for these
       three labels is ~340px against the ~224px a 320px viewport leaves inside the
       footer. The wrapper is deliberately NOT a `.btn`, so the theme's `flex:1` does
       not reach it and no specificity race is created. -->
  <NeoModal
    v-if="showGooglePrompt"
    data-testid="google-link-prompt"
    title="Prepojiť Google účet?"
    title-heading
    @close="closeGooglePrompt"
  >
    <div class="sub">Nabudúce sa prihlásite jedným klikom, bez hesla.</div>

    <div v-if="googleLinkError" class="banner danger slim">
      <span class="dot"></span>
      <div style="min-width:0">{{ googleLinkError }}</div>
    </div>

    <!-- Google's own cross-origin iframe button. Brand guidelines forbid restyling
         it, so this stays a bare mount point with no theme class (§UC-GA-005's rule,
         which applies wherever the button is rendered). -->
    <div
      v-if="googlePromptStage === 'link'"
      ref="googlePromptButtonEl"
      data-testid="google-prompt-signin"
    ></div>

    <div
      v-else-if="googlePromptStage === 'done'"
      class="banner ok slim"
      data-testid="google-prompt-linked"
    >
      <span class="dot"></span>
      <div style="min-width:0">
        Účet je prepojený<template v-if="googleLinkedEmail"> s {{ googleLinkedEmail }}</template>.
      </div>
    </div>

    <div class="field-help">Prepojenie nájdete kedykoľvek v profile.</div>

    <template #footer>
      <div class="gp-actions">
        <!-- ⚠ After a successful link the three options are GONE, not merely
             disabled: re-firing the same credential can only repeat the same answer,
             and "Už sa nepýtať" on a linked account would silence a prompt that
             already has nothing left to offer. -->
        <button
          v-if="googlePromptStage === 'done'"
          type="button"
          class="btn accent"
          @click="closeGooglePrompt"
        >
          Zavrieť
        </button>
        <template v-else>
          <button
            v-if="googlePromptStage === 'ask'"
            type="button"
            class="btn accent"
            :disabled="googlePromptBusy"
            @click="startGoogleLink"
          >
            Áno, teraz
          </button>
          <button
            type="button"
            class="btn"
            :disabled="googlePromptBusy"
            @click="closeGooglePrompt"
          >
            Teraz nie
          </button>
          <button
            type="button"
            class="btn"
            :disabled="googlePromptBusy"
            @click="dismissGooglePromptForever"
          >
            Už sa nepýtať
          </button>
        </template>
      </div>
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

  <!-- The hamburger drawer (18 §UC-PI-004). `v-if`, exactly like every NeoModal
       on this screen, and for one extra reason of its own: it carries
       `role="dialog"`, and 28 shipped spec files resolve `getByRole('dialog')`.
       Rendered-but-hidden it would turn every one of them into a strict-mode
       violation; mounted only while open, `getByRole('dialog')` still returns
       exactly one element on every screen that had one before.

       It teleports to `.modal-layer` — never a `position:fixed` child of `.app`,
       which `.app > * { position:relative; z-index:1 }` would silently flatten
       (CLAUDE.md §Frontend). `.app .p2-drawer` therefore counts 0. -->
  <NeoDrawer
    v-if="menuOpen"
    :friend-name="friendName"
    :items="menuItems"
    @select="onMenuSelect"
    @logout="onMenuLogout"
    @close="menuOpen = false"
  />

  <!-- ⚠ THE SECOND `GuestShareDialog` THAT USED TO MOUNT HERE IS GONE (18
       §UC-PI-011). It served the cycle card's share row; the card is retired, and the
       dialog now has exactly ONE instance on the friend surface, inside
       `FriendOrder.vue`. The drawer's „Zdieľať s kolegami" row reaches it through
       `requestShareDialog()` → the `defineExpose`d `openShareDialog()`. Two instances
       is how one of them stops receiving updates. -->

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
          <!-- ⚠ COPY-ONLY EDIT (18 §UC-PI-017's table). „z cyklu {name}" → the name in
               PARENTHESES: the vocabulary rule bans „cyklus" on every friend surface,
               and this modal is one. Everything else about this modal — its markup,
               its ty-form, its shadcn look — is deliberately out of scope
               (00-overview: the voucher modal is out of the restyle).
               ⚠ `data-user-copy` on the NAME ONLY (FUP-T22): a cycle name is admin
               free text, and this suite's own fixtures name cycles „… cyklus". The
               sentence around it is app copy and must stay readable to the sweep. -->
          <div class="text-sm text-muted-foreground">
            Za tvoju objednávku (<span class="font-semibold text-foreground" data-user-copy>{{ currentVoucher.cycle_name }}</span>) ti patrí zľavový voucher.
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

<style scoped>
/* 10 §UC-GA-006 — the three-option footer, stacked.
 *
 * ⚠ Scoped to this view rather than added to `friends-theme.css`: that file is a
 * byte-for-byte port of the design canon with a numbered adaptation list (A1..A12)
 * this belongs to none of (the `CatScrollArrow.vue` / cart-line precedent).
 *
 * ⚠ Nothing here re-declares a property the theme sets on `.m-foot .btn` — the
 * wrapper is not a `.btn`, so the theme's `flex:1` (0,3,0) is never in contention and
 * this needs no specificity bet. */
.gp-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
</style>
