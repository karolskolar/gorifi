<script setup>
// Guest share links — "Zdieľať s kolegami" (05 §UC-KG-006, 19 §UC-GL-008).
// ⚠ GL-T6b: TWO sections. FIRST the host's STANDING link (one per host, never tied
// to a round — `GET /guest-links/standing`, minted lazily) with the „kto čaká"
// count and „Nový stály odkaz"; BELOW it, under „Odkaz len na túto objednávku",
// the per-cycle link described next, rendered only with a `cycleId`.
// The host owns exactly one link per cycle (`guest_order_links`); colleagues
// order through /g/:token without an account and the host hands the goods over.
// Shared by FriendOrder.vue (the "Kolegovia" panel) and FriendPortalSession.vue
// (cycle-card share row), so both entry points drive the same
// create / regenerate / deactivate logic.
//
// RD-KG-2 recomposed the TEMPLATE onto NeoModal (UC-DS-010) + NeoCopyRow
// (UC-DS-011). The component API is frozen — props `open`/`cycleId`/`cycleName`,
// emit `update:open` — and the whole sequencing below survives verbatim. Only
// `copyLink`/`copied` were deleted: NeoCopyRow owns the clipboard write and the
// 2-second "Skopírované!" flip (resolved conflict 4), including the fallback
// behaviour the bespoke `document.execCommand` branch used to provide.
import { ref, computed, watch } from 'vue'
import api from '../api'
import { ordersAccusativeLabel, waitingLabel } from '@/lib/plural'
import NeoModal from '@/components/neo/NeoModal.vue'
import NeoCopyRow from '@/components/neo/NeoCopyRow.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  cycleId: { type: [String, Number], default: null },
  cycleName: { type: String, default: '' }
})

const emit = defineEmits(['update:open'])

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const link = ref(null) // { id, token, active, ... } or null when not shared yet
const confirmRegenerate = ref(false)

// How many LIVE (non-cancelled) colleague sub-orders hang off this link. Drives the
// regeneration block below (PO decision, 2026-08-31).
//
// ⚠ READ FROM `totals.count`, NEVER FROM `guest_orders`. The payload does carry the
// sub-order rows, and since GR-T5 each one carries its `order_token` — which is why
// the standing rule two comments down says this component keeps only `data.link` and
// must not start reading `guest_orders`. `totals` is an aggregate of two numbers and
// carries no credential, so counting from it satisfies the PO's requirement without
// touching that pin (`share-dialog.spec.js:611`: no token in the rendered HTML).
//
// ⚠ NO EXTRA REQUEST, by construction: every response this component already reads
// — the GET, the POST and the PATCH — answers with `{ link, guest_orders, totals }`,
// so the count is refreshed from whatever the last call returned.
//
// `totals.count` is the SERVER's live count (helpers/guest-orders.js `subOrderTotals`
// filters on `guestOrderStatus() !== 'cancelled'`), which is the same predicate the
// backend's 409 gate uses — so what the dialog says and what the route enforces can
// never disagree.
const liveOrders = ref(0)

// The PO's rule: a host may not regenerate a link colleagues are already ordering
// through. The backend refuses it with 409 `reason:'has_orders'`; the dialog does not
// offer an action that is going to be refused, and says why instead.
const regenerateBlocked = computed(() => liveOrders.value > 0)

const regenerateBlockedCopy = computed(() =>
  `Cez tento odkaz už máte ${ordersAccusativeLabel(liveOrders.value)} od kolegov, preto nový odkaz nie je možné vygenerovať. Ak ho potrebujete, kontaktujte správcu.`
)

// navigator.share exists on mobile browsers only — the copy row is the
// fallback everywhere else, so the share BUTTON is absent rather than relabeled
// (resolved conflict 3; pinned `toHaveCount(0)` in guest-link.spec.js).
const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

// ⚠ This dialog renders the LINK token only. The payload it reads DOES now carry
// each sub-order's `order_token` (14 §UC-GR-006, GR-T5 — the GSO-T2 exclusion was
// deliberately reversed so a host can re-send a colleague their own order link):
// this component keeps only `data.link` and must never render one.
// `share-dialog.spec.js:611` asserts no token reaches the rendered HTML — that pin
// is what stands between the reversal and a token in the DOM, so do not weaken it,
// and do not start reading `guest_orders` here.
const guestUrl = computed(() =>
  link.value ? `${window.location.origin}/g/${link.value.token}` : ''
)

// One dialog instance is reused for every cycle (FriendPortal renders a share
// button per cycle card), so responses MUST be sequence-guarded: a slow GET for a
// cycle the host already closed would otherwise land on top of the cycle now on
// screen. That is not cosmetic — the host would copy the wrong /g/:token (their
// colleagues then order into the wrong cycle), and toggleActive()/saveLink()
// would act on the stale link.value.id, hitting a different cycle's row.
// Every request bumps loadSeq and drops its own result if it is no longer the
// newest one.
//
// ⚠ Load-bearing, not legacy: `guest-link.spec.js`'s "slow load … cannot
// overwrite" test reproduces exactly that corruption with a `page.route` delay.
// The RD-KG-2 restyle must not restructure this watcher.
let loadSeq = 0

// Load on every open so a link created from the other entry point shows up, and
// clear on close so a reopen can never flash the previous cycle's link.
//
// NeoModal has no `open` prop — the parent owns the mount — so the template
// gates it with `v-if="open"`. This watcher is what keeps "clear on close, load
// on open" true under that mount, and it runs on THIS component, which stays
// mounted for the lifetime of its host view.
watch(() => props.open, async (isOpen) => {
  const seq = ++loadSeq
  error.value = ''
  confirmRegenerate.value = false
  link.value = null
  // Cleared with `link` for the same reason: a reopen must never read the previous
  // cycle's order count, which would block (or unblock) regeneration on the wrong row.
  liveOrders.value = 0
  saving.value = false
  loading.value = false
  if (!isOpen || !props.cycleId) return

  loading.value = true
  try {
    const data = await api.getGuestLink(props.cycleId)
    if (seq !== loadSeq) return
    link.value = data.link
    liveOrders.value = data.totals?.count || 0
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e.message
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}, { immediate: true })

// ---------------------------------------------------------------------------
// GL-T6b · 19 §UC-GL-008 — THE STANDING SECTION (R9.4): the host's one link that
// never expires with a round, shown FIRST; the per-cycle link below is demoted
// under „Odkaz len na túto objednávku" and rendered only with a `cycleId`.
//
// ⚠ ITS OWN SEQUENCE COUNTER, never `loadSeq`. The two reads run in parallel on
// every open and each drops only ITS OWN stale result — a per-cycle POST/PATCH
// bumping `loadSeq` must not orphan an in-flight standing read, and a standing
// regenerate must not orphan a per-cycle one. Same rule as `loadSeq` otherwise:
// bumped on open AND close, so a slow read from a previous open can never land
// on the reopened dialog (pinned in guest-standing-link.spec.js „⚠ loadSeq").
//
// ⚠ Keeps `url_path` and the COUNT only — the payload has no names/phones by
// construction (19 §UC-GL-001), and `standing.token` is not stored separately.
// The URL IS rendered (NeoCopyRow text + `title`), exactly like the per-cycle one:
// it is the host's share URL (§UC-GL-008 placement bullet 3), not the admin's
// never-in-the-DOM rule (FriendDetail.vue, GL-T6a).
//
// ⚠ Works with `cycleId = null` (module 18's menu entry for a closed round): this
// watcher never reads the cycle. No trigger reaches that today — the drawer row and
// the cartbar icon are `state === 'open'` only — so it is SOURCE-pinned.
let standingSeq = 0
const standingPath = ref('')
const waitingCount = ref(0)
const standingError = ref('') // a failed READ — no copy row, no rotation offered
const standingRegenError = ref('') // a failed ROTATION — its own sentence, row kept
const confirmStanding = ref(false)
const standingSaving = ref(false)

const standingUrl = computed(() =>
  standingPath.value ? `${window.location.origin}${standingPath.value}` : ''
)

// §UC-GL-008 item 3 — native share PREFERS the standing URL; the per-cycle one is
// the fallback only when the standing read FAILED (never merely „not loaded yet",
// or a quick tap would share the per-cycle URL and a slow one the standing URL).
const shareUrl = computed(() => standingUrl.value || (standingError.value ? guestUrl.value : ''))

watch(() => props.open, async (isOpen) => {
  const seq = ++standingSeq
  standingPath.value = ''
  waitingCount.value = 0
  standingError.value = ''
  standingRegenError.value = ''
  confirmStanding.value = false
  standingSaving.value = false
  if (!isOpen) return

  try {
    const data = await api.getStandingGuestLink()
    if (seq !== standingSeq) return
    standingPath.value = data?.standing?.url_path || ''
    waitingCount.value = Number(data?.waiting_count) || 0
  } catch (e) {
    if (seq !== standingSeq) return
    standingError.value = `Stály odkaz sa nepodarilo načítať: ${e.message}`
  }
}, { immediate: true })

// The two confirms share „Áno, vygenerovať", so they never stand open together.
function openStandingConfirm() {
  confirmRegenerate.value = false
  standingRegenError.value = ''
  confirmStanding.value = true
}

function openCycleConfirm() {
  confirmStanding.value = false
  confirmRegenerate.value = true
}

// No `has_orders` gate (19 D2): rotating strands nobody who has ordered — every
// sub-order resolves by `order_token` — so no blocked state exists here.
// ⚠ The JS guard is not redundant with `:disabled` (a dispatched click ignores it).
async function regenerateStanding() {
  if (standingSaving.value) return
  const seq = ++standingSeq
  standingSaving.value = true
  standingRegenError.value = ''
  try {
    const data = await api.regenerateStandingGuestLink()
    if (seq !== standingSeq) return
    standingPath.value = data?.standing?.url_path || standingPath.value
    waitingCount.value = Number(data?.waiting_count) || 0
    confirmStanding.value = false
  } catch (e) {
    if (seq !== standingSeq) return
    standingRegenError.value = `Nový stály odkaz sa nepodarilo vygenerovať: ${e.message}`
  } finally {
    if (seq === standingSeq) standingSaving.value = false
  }
}

// Create the link, or issue a fresh token for an existing one. The backend keeps
// the same link row, so sub-orders colleagues already placed are preserved.
async function saveLink() {
  const seq = ++loadSeq // invalidates any in-flight GET so it cannot clobber this
  error.value = ''
  saving.value = true
  try {
    const data = await api.createGuestLink(props.cycleId)
    if (seq !== loadSeq) return
    link.value = data.link
    liveOrders.value = data.totals?.count || 0
    confirmRegenerate.value = false
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e.message
  } finally {
    if (seq === loadSeq) saving.value = false
  }
}

async function toggleActive() {
  if (!link.value) return
  const seq = ++loadSeq
  const targetId = link.value.id
  const nextActive = !link.value.active
  error.value = ''
  saving.value = true
  try {
    const data = await api.setGuestLinkActive(targetId, nextActive)
    if (seq !== loadSeq) return
    link.value = data.link
    liveOrders.value = data.totals?.count || 0
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e.message
  } finally {
    if (seq === loadSeq) saving.value = false
  }
}

// Native share sheet on mobile; the button is hidden where navigator.share is
// unavailable, so the copy row is always the fallback.
//
// ⚠ The share-sheet name and `document.title` move TOGETHER — the app must not
// introduce itself under one name in a message linking to a tab called another.
// 05 §UC-KG-006 left this OPEN; the original decision kept both strings on
// "Gorifi", and on 2026-08-12 the product owner renamed the tab to Podpultovka,
// so both strings are now "Podpultovka" (tab pinned by public-flow.spec.js,
// this payload by share-dialog.spec.js).
async function nativeShare() {
  if (!canNativeShare || !shareUrl.value) return
  try {
    await navigator.share({
      title: 'Objednávka Podpultovka',
      text: `Pridajte sa k mojej objednávke - ${props.cycleName || 'objednávka'}`,
      url: shareUrl.value
    })
  } catch (e) {
    // User dismissed the share sheet — nothing to report
  }
}

// Notes on the template below (kept here so the rendered DOM stays identical to
// the prototype's in dev as well as prod):
//
// · `v-if="open"` on NeoModal is not a micro-optimisation. Two IMMUTABLE specs
//   (`guest-host-view.spec.js:890,929`) locate the page-level share affordances
//   with an UNSCOPED `getByRole('button', { name: /Zdieľať/ })`; leaving this
//   dialog mounted while closed would add its own "Zdieľať odkaz" to that set
//   and turn a `toBeHidden()` into a strict-mode violation.
// · Every bold lead sits on ONE source line with the text that follows it. Vue's
//   `condense` whitespace mode deletes a whitespace node that contains a
//   newline, so breaking `</b>` and `— kolegovia…` across lines would silently
//   render "Odkaz je deaktivovaný— kolegovia…".
// · No `line-height` fix-ups are needed here: every text-bearing element carries
//   a class already in UC-DS-001 A10 (`.sub`, `.banner`, `.copyrow .val`,
//   `.confirmbox`, and `.field-help` for the two UC-GR-009 standing lines) or in
//   A9 (`.btn`), and the only unclassed block — the actions row — contains
//   buttons only. Nothing here may widen A10.
</script>

<template>
  <NeoModal
    v-if="open"
    title="Zdieľať s kolegami"
    @close="emit('update:open', false)"
  >
    <!-- Name the cycle: from the portal several open cycles sit side by side, so
         an unlabelled URL cannot be verified by the host (GSO-T2; pinned by
         `toContainText(cycleBName)`). -->
    <template #subtitle>
      <!-- `data-user-copy` on the NAME only (FUP-T22): a cycle name is admin free text. -->
      <template v-if="cycleName"><b style="color: var(--ink)" data-user-copy>{{ cycleName }}</b><br></template>Kolegovia si objednajú cez váš odkaz — bez registrácie. Zásielku prevezmete vy a odovzdáte im ju.
    </template>

    <!-- 1. Error — first in the body in EVERY state, so a failure is never read
         as "no link yet". Same `.banner.danger.slim` shape as the panel
         (RD-KG-1): `span.dot` + a `min-width:0` block so a long server message
         cannot push the modal sideways at 320px. -->
    <div v-if="error" class="banner danger slim" role="alert">
      <span class="dot"></span>
      <div style="min-width:0">{{ error }}</div>
    </div>

    <!-- GL-T6b · 19 §UC-GL-008 — THE STANDING SECTION, first after the error banner
         (which stays the FIRST body child — `share-dialog.spec.js`'s error-state pin).
         Its lines are `div.field-lbl` / `div.field-help` / `span.badge`, never a
         `p.sub` (single-element pinned) and never a `<b>` (none in `#subtitle`); its
         confirm is `div.standing-confirm`, NOT `.confirmbox` (whose copy and single
         `<b>` are pinned); no button name here matches `/Zdieľať/` except the ONE
         native-share button, which is absent without `navigator.share`. -->
    <div data-testid="standing-link" class="gsd-section">
      <div class="field-lbl gsd-lbl">Stály odkaz pre kolegov</div>
      <div v-if="standingError" class="banner danger slim" role="alert" data-testid="standing-error">
        <span class="dot"></span>
        <div style="min-width:0">{{ standingError }}</div>
      </div>
      <div v-else-if="!standingPath" class="field-help">Načítavam...</div>
      <template v-else>
        <NeoCopyRow :value="standingUrl" value-testid="standing-link-url" />

        <!-- §UC-GL-008 item 3 — the ONE native-share button lives HERE while the
             standing link is known; the per-cycle section renders it only as the
             fallback after a failed standing read. -->
        <button
          v-if="canNativeShare"
          type="button"
          class="btn accent block"
          @click="nativeShare"
        >
          <NeoIcon name="share" /> Zdieľať odkaz
        </button>

        <div class="field-help" data-testid="standing-copy">Tento odkaz platí stále — pred otvorením objednávky, počas nej aj po nej. Kolegovia cez neho uvidia aktuálnu objednávku, alebo sa zapíšu, aby dostali správu, keď sa otvorí.</div>

        <!-- The „kto čaká" COUNT — only when > 0; no names exist to render. -->
        <div v-if="waitingCount > 0" data-testid="waiting-count"><span class="badge acc">{{ waitingLabel(waitingCount) }}</span></div>

        <div v-if="!confirmStanding">
          <button type="button" class="btn ghost sm" @click="openStandingConfirm">Nový stály odkaz</button>
        </div>
        <div v-else class="standing-confirm" data-testid="standing-confirm">
          <span>Starý stály odkaz prestane fungovať. Objednávky, ktoré kolegovia už vytvorili, zostanú funkčné.</span>
          <div class="row">
            <button
              type="button"
              class="btn sm dark"
              :disabled="standingSaving"
              @click="regenerateStanding"
            >{{ standingSaving ? 'Generujem...' : 'Áno, vygenerovať' }}</button>
            <button
              type="button"
              class="btn sm ghost"
              @click="confirmStanding = false"
            >Nie</button>
          </div>
        </div>
        <div v-if="standingRegenError" class="field-help gsd-err" role="alert" data-testid="standing-regen-error">{{ standingRegenError }}</div>
      </template>
    </div>

    <!-- The per-cycle section, DEMOTED (§UC-GL-008 item 4) and rendered only with a
         `cycleId`. Everything inside `per-cycle-link` is the shipped body verbatim.
         ⚠ The loading `.sub` stays a DIRECT `.m-body` child (`.m-body > .sub` is
         pinned), so it sits between the label and the wrapper, not inside it. -->
    <div v-if="cycleId" class="field-lbl gsd-lbl" data-testid="per-cycle-label">Odkaz len na túto objednávku</div>

    <!-- 2. Loading -->
    <div v-if="loading" class="sub" style="text-align:center">Načítavam...</div>

    <div v-else-if="cycleId" data-testid="per-cycle-link" class="gsd-section">
      <!-- 3. Not shared yet. Not in the prototype — composed from its
           primary-action pattern; the copy is pinned by e2e and by the GSO-T2
           register rule (impersonal vy-form, no gendered participle). -->
      <template v-if="!link">
        <p class="sub">Odkaz ešte nie je vytvorený.</p>
        <button
          type="button"
          class="btn accent block"
          :disabled="saving"
          @click="saveLink()"
        >{{ saving ? 'Vytváram...' : 'Vytvoriť odkaz' }}</button>
      </template>

      <template v-else>
        <!-- 4. Link exists. A deactivated link keeps its URL on screen — the
             host may want to copy it before reactivating. -->
        <div v-if="!link.active" class="banner warn slim">
          <span class="dot"></span>
          <span><b>Odkaz je deaktivovaný</b> - kolegovia si cez neho nemôžu objednať.</span>
        </div>

        <!-- `value-testid` is the approved UC-DS-011 extension: the testid sits
             on the `.val` node, never on the row, so a text assertion does not
             swallow the copy button's label. -->
        <NeoCopyRow :value="guestUrl" value-testid="guest-link-url" />

        <!-- ⚠ 14 §UC-GR-009 line 1 — the standing "one link for everyone"
             statement. The recovery incident's host almost certainly regenerated
             because "Vygenerovať nový odkaz" read as "share with one more
             colleague", which silently severed every colleague already holding
             the old URL. It answers the copy row directly above it, so it sits
             immediately under it, and only in the link-exists state (with no link
             there is nothing to mis-share yet).
             ⚠ `div.field-help`, NOT `p.sub`: `share-dialog.spec.js:239,:579` pin
             `dialog.locator('p.sub')` as a SINGLE element, so a second one here
             is a strict-mode violation in an immutable spec. `.field-help` is
             A10-covered, so no line-height fix-up is needed and A10 does not
             widen. Copy is DRAFT pending PO sign-off (14 §OPEN). -->
        <div v-if="link.active" class="field-help" data-testid="share-standing-copy">Ten istý odkaz platí pre všetkých kolegov - každý si cez neho vytvorí vlastnú objednávku. Pre ďalšieho kolegu nevytvárajte nový odkaz.</div>

        <!-- Native share sheet — rendered only where navigator.share exists, and
             HERE only as the fallback after a failed standing read (GL-T6b). -->
        <button
          v-if="canNativeShare && standingError"
          type="button"
          class="btn accent block"
          @click="nativeShare"
        >
          <NeoIcon name="share" /> Zdieľať odkaz
        </button>

        <!-- ⚠ 14 §UC-GR-009 line 2 — when regeneration IS the right move. It is
             STANDING text directly above the actions row, deliberately NOT copy
             inside the `.confirmbox`: the host has to read it BEFORE reaching for
             the button, and the box's copy plus its single `<b>` are pinned
             verbatim by `share-dialog.spec.js:417-418`. "dostal" refers to
             *odkaz* (a third-party noun), not the reader, so the vy-form register
             pin holds. Copy is DRAFT pending PO sign-off (14 §OPEN). -->
        <div v-if="!regenerateBlocked" class="field-help" data-testid="regen-guidance">Nový odkaz vygenerujte len vtedy, ak sa pôvodný dostal k nesprávnym ľuďom - kolegom potom treba poslať nový.</div>

        <!-- ⚠ THE REGENERATION BLOCK (PO decision, 2026-08-31). Once a colleague has
             ordered through this link, regenerating it would stop everyone who has
             NOT ordered yet from reaching the offer — so the affordance is REPLACED
             by the reason, not merely disabled: a disabled button still reads as "you
             may do this, later", and the host has nothing to wait for.
             The guidance line above is swapped out with it, because "regenerate only
             on a leak" would be telling the host to do something this state forbids.
             Deactivation stays available — revoking a leaked link is exactly what a
             host with live orders still needs, and it strands nobody (existing orders
             resolve by `order_token`, §UC-GR-001/002).
             ⚠ `div.field-help` for the §UC-GR-009 placement reason: `p.sub` is pinned
             as a SINGLE element in an immutable spec, and `.field-help` is A10-covered
             so no line-height fix-up is needed and A10 does not widen.
             Copy is DRAFT pending PO sign-off (14 §OPEN) — mirrored as a constant in
             `guest-order-recovery.spec.js`, so sign-off stays a two-place edit. -->
        <div v-else class="field-help" data-testid="regen-blocked">{{ regenerateBlockedCopy }}</div>

        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <!-- Deactivation is REVERSIBLE — the same button toggles back. -->
          <button
            type="button"
            class="btn ghost sm"
            :disabled="saving"
            @click="toggleActive"
          >{{ link.active ? 'Deaktivovať odkaz' : 'Znova aktivovať' }}</button>
          <button
            v-if="!confirmRegenerate && !regenerateBlocked"
            type="button"
            class="btn ghost sm"
            @click="openCycleConfirm"
          >Vygenerovať nový odkaz</button>
        </div>

        <!-- ⚠ The second sentence is a factual promise about somebody else's
             orders and MUST NOT be softened: the server UPDATEs the token on the
             existing row (never DELETE+INSERT), so every sub-order already
             hanging off `guest_orders.link_id` survives. -->
        <!-- ⚠ `&& !regenerateBlocked` is not redundant with the button's own guard.
             The count refreshes from the POST/PATCH responses, so a colleague's order
             can land (via a deactivate/reactivate round-trip) while this box is
             already open — and then the box would still offer a confirm the server
             is going to 409. The box closes itself instead. -->
        <div v-if="confirmRegenerate && !regenerateBlocked" class="confirmbox">
          <span><b>Starý odkaz prestane fungovať.</b> Objednávky, ktoré vám kolegovia už poslali, zostanú zachované.</span>
          <div class="row">
            <button
              type="button"
              class="btn sm dark"
              :disabled="saving"
              @click="saveLink()"
            >{{ saving ? 'Generujem...' : 'Áno, vygenerovať' }}</button>
            <button
              type="button"
              class="btn sm ghost"
              @click="confirmRegenerate = false"
            >Zrušiť</button>
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <button type="button" class="btn" @click="emit('update:open', false)">Zavrieť</button>
    </template>
  </NeoModal>
</template>

<style scoped>
/* GL-T6b — the two sections keep `.m-body`'s own 12px rhythm inside their wrapper. */
.gsd-section{display:flex;flex-direction:column;gap:12px;min-width:0}
/* `.field-lbl`'s 8px bottom margin on top of the 12px gap would double the space. */
.gsd-lbl{margin-bottom:0}
.gsd-err{color:var(--danger)}
/* The standing confirm: `.confirmbox`'s look under its OWN class (19 §UC-GL-008 item
   2 — that class's copy and single `<b>` are pinned), `line-height:normal` as A10
   gives `.confirmbox`. */
.standing-confirm{border:3px solid var(--nb-ink);border-radius:10px;background:var(--warn-soft);padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13.5px;line-height:normal}
.standing-confirm .row{display:flex;gap:8px}
</style>
