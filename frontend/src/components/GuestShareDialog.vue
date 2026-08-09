<script setup>
// Guest share link for one cycle — "Zdieľať s kolegami" (05 §UC-KG-006).
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

// navigator.share exists on mobile browsers only — the copy row is the
// fallback everywhere else, so the share BUTTON is absent rather than relabeled
// (resolved conflict 3; pinned `toHaveCount(0)` in guest-link.spec.js).
const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

// ⚠ The host sees the LINK token only. A guest's `order_token` (their private
// edit URL) is never exposed to the host anywhere in this module — the payload
// this dialog reads does not carry it (GSO-T2 hard invariant).
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
  saving.value = false
  loading.value = false
  if (!isOpen || !props.cycleId) return

  loading.value = true
  try {
    const data = await api.getGuestLink(props.cycleId)
    if (seq !== loadSeq) return
    link.value = data.link
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e.message
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}, { immediate: true })

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
// ⚠ The payload is deliberately UNCHANGED by the rebrand. `document.title` is
// still "Gorifi - Objednávky" (pinned by public-flow.spec.js), so renaming the
// share sheet alone would have the app introduce itself as Podpultovka in a
// message linking to a tab called Gorifi. 05 §UC-KG-006 leaves this OPEN; the
// decision recorded here is to keep both strings verbatim.
async function nativeShare() {
  if (!canNativeShare || !guestUrl.value) return
  try {
    await navigator.share({
      title: 'Objednávka Gorifi',
      text: `Pridajte sa k mojej objednávke — ${props.cycleName || 'objednávkový cyklus'}`,
      url: guestUrl.value
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
//   `.confirmbox`) or in A9 (`.btn`), and the only unclassed block — the actions
//   row — contains buttons only. Nothing here may widen A10.
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
      <template v-if="cycleName"><b style="color: var(--ink)">{{ cycleName }}</b><br></template>Kolegovia si objednajú cez váš odkaz — bez registrácie. Zásielku prevezmete vy a odovzdáte im ju.
    </template>

    <!-- 1. Error — first in the body in EVERY state, so a failure is never read
         as "no link yet". Same `.banner.danger.slim` shape as the panel
         (RD-KG-1): `span.dot` + a `min-width:0` block so a long server message
         cannot push the modal sideways at 320px. -->
    <div v-if="error" class="banner danger slim" role="alert">
      <span class="dot"></span>
      <div style="min-width:0">{{ error }}</div>
    </div>

    <!-- 2. Loading -->
    <div v-if="loading" class="sub" style="text-align:center">Načítavam...</div>

    <template v-else>
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
          <span><b>Odkaz je deaktivovaný</b> — kolegovia si cez neho nemôžu objednať.</span>
        </div>

        <!-- `value-testid` is the approved UC-DS-011 extension: the testid sits
             on the `.val` node, never on the row, so a text assertion does not
             swallow the copy button's label. -->
        <NeoCopyRow :value="guestUrl" value-testid="guest-link-url" />

        <!-- Native share sheet — rendered only where navigator.share exists. -->
        <button
          v-if="canNativeShare"
          type="button"
          class="btn accent block"
          @click="nativeShare"
        >
          <NeoIcon name="share" /> Zdieľať odkaz
        </button>

        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <!-- Deactivation is REVERSIBLE — the same button toggles back. -->
          <button
            type="button"
            class="btn ghost sm"
            :disabled="saving"
            @click="toggleActive"
          >{{ link.active ? 'Deaktivovať odkaz' : 'Znova aktivovať' }}</button>
          <button
            v-if="!confirmRegenerate"
            type="button"
            class="btn ghost sm"
            @click="confirmRegenerate = true"
          >Vygenerovať nový odkaz</button>
        </div>

        <!-- ⚠ The second sentence is a factual promise about somebody else's
             orders and MUST NOT be softened: the server UPDATEs the token on the
             existing row (never DELETE+INSERT), so every sub-order already
             hanging off `guest_orders.link_id` survives. -->
        <div v-if="confirmRegenerate" class="confirmbox">
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
    </template>

    <template #footer>
      <button type="button" class="btn" @click="emit('update:open', false)">Zavrieť</button>
    </template>
  </NeoModal>
</template>
