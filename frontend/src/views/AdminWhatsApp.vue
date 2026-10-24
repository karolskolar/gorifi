<script setup>
// 21 §UC-WA-009 (WA-T8) — the `a-wa` composer: „Správy skupinám“ at `/admin/whatsapp`
// (`?cycle=<id>&segment=<key>`).
//
// „Správa sa nikdy neodošle sama.“ Three cards over ONE selected group of the outbox:
//   Komu    — the cycle's outbox groups (`GET /segments` → `groups`) + the computed,
//             not-yet-composed segments (`computed`) with „Pripraviť správy (n)“
//   Šablóna — the group's TEMPLATE (WA-T2's PUT on blur, 400 inline), placeholder chips
//             inserting at the caret, „Prepísať texty vo fronte (n)“ (`/rerender`)
//   Náhľad  — the group's rows (`GET /notifications`), per-row badge / inline body edit /
//             „×“ delete, then per tab: „Poslať skupine (n)“ + „Skúsiť znova (n)“ (bot)
//             or „Otvoriť chat“ → `manual-sent` (wa.me)
//
// Admin = the old shadcn skin (no `neo/` classes, no Podpultovka tokens); the prototype
// `admin2.jsx AWa` is LAYOUT/FLOW only.
//
// ⚠⚠ THE wa.me URL IS COMPOSED IN JS AT CLICK TIME and never rendered into a DOM
// attribute — nor is a row's body: a guest row's body may carry `/g/o/<order_token>`
// (CLAUDE.md „compose the URL in JS at click time“). The body is rendered as TEXT only
// (it IS the message, admin-only); the editor's textarea gets it through the `value`
// PROPERTY (`v-model`), not an attribute.
//
// ⚠ Conventions (CLAUDE.md §Frontend): every gated action has a JS guard beside its
// `disabled`; per-row pending/errors keyed by id; the cycle → segments → rows loaders are
// each `seq`-guarded (switching groups fast must not paint a stale list); a refused row
// edit keeps the row's server text (the editor stays open with the error); `maxlength`
// mirrors the server's 1000; the body column is `min-w-0` + `overflow-wrap:anywhere`.
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { useWaHealth } from '../lib/use-wa-health.js'
import { messagesLabel, releasedMessagesAdjective, recipientsLabel } from '../lib/plural.js'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'

const route = useRoute()
const router = useRouter()

// `helpers/template-render.js MAX_BODY_LENGTH` — the template PUT and the row PATCH.
const MAX_BODY = 1000
const TOAST_MS = 3500

const error = ref('')

// ── Health: the offline/pause banner + the wa.me „released row“ rule ────────────────
// `lib/use-wa-health.js` — the settings page's loader, one home (5 s poll, seq-guarded).
// WA-T8 review: the 5 s health tick also RE-READS the rows while any visible row is
// `released`, so they flip to `Odoslané` without a reload (§UC-WA-009 „within the poll
// interval“; the stub-sender proof is WA-T9's). `loadRows()` is seq-guarded.
const { health, connected, paused: botPaused } = useWaHealth({
  onHealth: () => {
    if (selectedKey.value && rows.value.some((r) => r.status === 'released')) loadRows()
  },
})
// 21 §UC-WA-009: „when the health proxy reports state ≠ connected or whatsapp_paused = 1“.
const showOfflineBanner = computed(() => !!health.value && (!connected.value || botPaused.value))

// ── Cycles ──────────────────────────────────────────────────────────────────────────
const cycles = ref([])
const cycleId = ref(null)
const cyclesLoaded = ref(false)

const STATUS_WORDS = { planned: 'plánovaná', open: 'otvorená', locked: 'uzamknutá', completed: 'ukončená' }
const cycleLabel = (c) => `${c.name}${STATUS_WORDS[c.status] ? ` · ${STATUS_WORDS[c.status]}` : ''}`

const queryInt = (v) => (typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v) ? Number(v) : null)
const querySegment = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 80 ? v : null)

// 21 §UC-WA-009: the cycle from the query, else the newest `locked`, else the newest
// `open` — „newest“ = the highest id (creation order). Neither ⇒ the newest of any
// status (DRAFT fallback, learnings 15 §WA-T8).
function defaultCycleId(list, fromQuery) {
  if (fromQuery !== null && list.some((c) => c.id === fromQuery)) return fromQuery
  for (const status of ['locked', 'open']) {
    const hit = list.find((c) => c.status === status)
    if (hit) return hit.id
  }
  return list.length ? list[0].id : null
}

async function loadCycles() {
  try {
    const list = await api.getCycles()
    cycles.value = (Array.isArray(list) ? list : []).slice().sort((a, b) => b.id - a.id)
    cycleId.value = defaultCycleId(cycles.value, queryInt(route.query.cycle))
  } catch (e) {
    error.value = e.message
  } finally {
    cyclesLoaded.value = true
  }
}

// ── Segments (the Komu card) ────────────────────────────────────────────────────────
const groups = ref([])
const computedSegs = ref([])
const cycleInfo = ref(null)
const segmentsError = ref('')
let segSeq = 0

async function loadSegments() {
  const mine = ++segSeq
  const id = cycleId.value
  if (!id) return
  try {
    const res = await api.getNotificationSegments(id)
    if (mine !== segSeq) return
    groups.value = Array.isArray(res.groups) ? res.groups : []
    computedSegs.value = Array.isArray(res.computed) ? res.computed : []
    cycleInfo.value = res.cycle || null
    segmentsError.value = ''
  } catch (e) {
    if (mine !== segSeq) return
    segmentsError.value = e.message
  }
}

const groupBadgeCount = (g) => (g.counts?.queued || 0) + (g.counts?.released || 0) + (g.counts?.failed || 0)

// ── Selection ───────────────────────────────────────────────────────────────────────
const selectedKey = ref(null)
const deepLinkMiss = ref(false)

const selectedGroup = computed(() => groups.value.find((g) => g.segment_key === selectedKey.value) || null)
const selectedComputed = computed(() => computedSegs.value.find((c) => c.key === selectedKey.value) || null)
const selectedTemplateKey = computed(() => selectedGroup.value?.template_key || selectedComputed.value?.template_key || null)
const selectedName = computed(() => selectedGroup.value?.name || selectedComputed.value?.name || selectedKey.value || '')

// A deep link names a group EXACTLY, or (the distribution board's „Správa skupine“) a
// PREFIX without the date — `handed_over:pickup:<loc>` / `handed_over:packeta` — which
// resolves to that target's NEWEST hand-over day present in the outbox (ISO dates sort
// lexicographically). Nothing matching ⇒ no selection + a hint.
function resolveDeepLink(raw) {
  if (!raw) return null
  if (groups.value.some((g) => g.segment_key === raw) || computedSegs.value.some((c) => c.key === raw)) return raw
  const prefixed = groups.value.map((g) => g.segment_key).filter((k) => k.startsWith(`${raw}:`)).sort()
  return prefixed.length ? prefixed[prefixed.length - 1] : null
}

function resetGroupState() {
  // WA-T8 review: an in-flight row GET of the previous group/cycle must never paint under
  // the new one — even when the new one loads no rows at all (an empty cycle).
  rowsSeq++
  rowsLoading.value = false
  flaggedIds.value = []
  releaseError.value = ''
  rerenderNote.value = ''
  editingId.value = null
  editingBody.value = ''
  for (const k of Object.keys(rowErrors)) delete rowErrors[k]
  waitlistFreshKey = null
  staleIds.value = []
}

function selectKey(key, { writeQuery = true } = {}) {
  if (!key) return
  if (key !== selectedKey.value) {
    selectedKey.value = key
    resetGroupState()
    rows.value = []
  }
  deepLinkMiss.value = false
  if (writeQuery) router.replace({ query: { cycle: String(cycleId.value), segment: key } })
  loadRows()
}

// ── Rows (the Náhľad card) ──────────────────────────────────────────────────────────
const rows = ref([])
const rowsLoading = ref(false)
const rowsError = ref('')
const rowPending = reactive({})
const rowErrors = reactive({})
let rowsSeq = 0

async function loadRows() {
  const mine = ++rowsSeq
  const key = selectedKey.value
  const id = cycleId.value
  if (!key || !id) { rows.value = []; return }
  rowsLoading.value = true
  try {
    const res = await api.getNotifications(id, key)
    if (mine !== rowsSeq) return
    rows.value = Array.isArray(res.rows) ? res.rows : []
    rowsError.value = ''
    maybeRefreshWaitlist()
  } catch (e) {
    if (mine !== rowsSeq) return
    rowsError.value = e.message
  } finally {
    if (mine === rowsSeq) rowsLoading.value = false
  }
}

function replaceRow(next) {
  if (!next || !Number.isInteger(next.id)) return
  rows.value = rows.value.map((r) => (r.id === next.id ? next : r))
}

// Skipped rows render greyed at the BOTTOM (§UC-WA-009); everything else in id order.
const orderedRows = computed(() => [
  ...rows.value.filter((r) => r.status !== 'skipped'),
  ...rows.value.filter((r) => r.status === 'skipped'),
])
const countOf = (status) => rows.value.filter((r) => r.status === status).length
const queuedCount = computed(() => countOf('queued'))
const failedCount = computed(() => countOf('failed'))
// „Prepísať texty vo fronte (n)“: the rerender touches `queued` AND (WA-T8 decision 1)
// `failed` rows — the repair door before „Skúsiť znova“.
const rerenderableCount = computed(() => queuedCount.value + failedCount.value)

function badgeText(row) {
  switch (row.status) {
    case 'queued': return 'Vo fronte'
    case 'released': return 'Uvoľnené'
    case 'sent':
      if (row.sent_via === 'wa_me') return 'Odoslané · wa.me'
      if (row.sent_via === 'email' || row.channel === 'email') return 'Odoslané · e-mail'
      return 'Odoslané'
    case 'failed': return 'Chyba'
    case 'skipped': return row.error === 'no_phone' ? 'Bez platného čísla' : 'Preskočené'
    default: return row.status
  }
}
function badgeClass(row) {
  if (row.status === 'sent') return 'bg-green-100 text-green-800 border-transparent hover:bg-green-100'
  if (row.status === 'released') return 'bg-blue-100 text-blue-800 border-transparent hover:bg-blue-100'
  if (row.status === 'failed') return 'bg-destructive text-destructive-foreground border-transparent'
  return 'bg-secondary text-secondary-foreground border-transparent'
}

// The warning outline is the ROW's `unresolved` (the release gate's stored answer,
// WA-T5) — never a client rescan of the body (a guest NAMED „{suma}“ must not light up).
// `null` = never computed ⇒ release refuses it too (a legacy row: rerender first).
const flaggedIds = ref([])
function unresolvedOf(row) {
  // `queued` AND `failed` (WA-T8 review): a failed row rewritten by the repair door can
  // carry a literal, and the retry refuses it exactly like the release.
  if (row.status !== 'queued' && row.status !== 'failed') return null
  if (!Array.isArray(row.unresolved)) return []
  return row.unresolved.length ? row.unresolved : null
}
const isFlagged = (row) => unresolvedOf(row) !== null || flaggedIds.value.includes(row.id)
function unresolvedText(row) {
  const u = unresolvedOf(row)
  if (u && u.length) return `Doplňte ${u.join(' ')}`
  if (u) return 'Text treba prepísať — „Prepísať texty vo fronte“.'
  return 'Správa sa nedá uvoľniť — skontrolujte text.'
}
const rowEls = {}
const setRowEl = (id) => (el) => { if (el) rowEls[id] = el; else delete rowEls[id] }

async function scrollToFlagged() {
  if (!flaggedIds.value.length) return
  await nextTick()
  const first = flaggedIds.value.map((id) => rowEls[id]).find(Boolean)
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

const displayPhone = (row) => row.phone || row.phone_e164 || '—'

// ── Tabs ────────────────────────────────────────────────────────────────────────────
// PO 2026-09-19: the default tab is „Cez bota“.
const tab = ref('bot')
// The waitlist re-render runs ONCE per group load (`resetGroupState()` clears its marker),
// never on every tab re-entry — it would overwrite per-row edits each time (WA-T8 review).
function setTab(next) {
  if (next !== 'bot' && next !== 'manual') return
  tab.value = next
  maybeRefreshWaitlist()
}

// ── Toast ───────────────────────────────────────────────────────────────────────────
const toast = ref('')
let toastTimer = null
function showToast(text) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = ''; toastTimer = null }, TOAST_MS)
}
onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = null
})
// „n správ uvoľnených — bot ich odošle s odstupom 3–10 s“ (21 §UC-WA-009), declined.
const releasedToast = (n) => `${messagesLabel(n)} ${releasedMessagesAdjective(n)} — bot ${n === 1 ? 'ju' : 'ich'} odošle s odstupom 3–10 s`

// ── Templates (the Šablóna card) ────────────────────────────────────────────────────
const templates = reactive({})
const placeholders = ref([])
const templatesLoaded = ref(false)
// Drafts and refusals are kept PER TEMPLATE KEY (WA-T8 review): switching to another group
// never drops a refused edit or its message silently.
const drafts = reactive({})
const templateErrors = reactive({})
const templateNote = ref('')
const templateSaving = ref(false)
const textareaRef = ref(null)
const inflightSaves = {}

const selectedTemplate = computed(() => (selectedTemplateKey.value ? templates[selectedTemplateKey.value] || null : null))
const templateDraft = computed({
  get: () => {
    const key = selectedTemplateKey.value
    if (!key) return ''
    return typeof drafts[key] === 'string' ? drafts[key] : (templates[key]?.body || '')
  },
  set: (value) => { if (selectedTemplateKey.value) drafts[selectedTemplateKey.value] = value },
})
const templateError = computed(() => (selectedTemplateKey.value ? templateErrors[selectedTemplateKey.value] || '' : ''))

async function loadTemplates() {
  try {
    const res = await api.getNotificationTemplates()
    for (const t of Array.isArray(res.templates) ? res.templates : []) templates[t.key] = t
    placeholders.value = Array.isArray(res.placeholders) ? res.placeholders : []
    templatesLoaded.value = true
  } catch (e) {
    error.value = e.message
  }
}

watch(selectedTemplateKey, () => { templateNote.value = '' })

// PUT on blur (21 §UC-WA-009). Resolves TRUE when the template `key` is saved (or had
// nothing to save) and FALSE when the PUT was refused — compose and rerender AWAIT it and
// abort on false (their click blurs the textarea; racing the PUT would build rows from the
// OLD template, and building them from a refused draft's predecessor silently is worse).
function saveTemplate(key = selectedTemplateKey.value) {
  if (!key) return Promise.resolve(true)
  if (inflightSaves[key]) return inflightSaves[key].then(() => saveTemplate(key))
  const t = templates[key]
  const sent = drafts[key]
  if (!t) return Promise.resolve(true)
  // A draft reverted to the SAVED text is clean again (WA-T8 re-review): its old refusal
  // must not keep compose/rerender blocked.
  if (typeof sent !== 'string' || sent === (t.body || '')) {
    templateErrors[key] = ''
    delete drafts[key]
    return Promise.resolve(true)
  }
  templateSaving.value = true
  templateErrors[key] = ''
  templateNote.value = ''
  inflightSaves[key] = (async () => {
    try {
      const next = await api.updateNotificationTemplate(key, { body: sent })
      templates[key] = next
      if (drafts[key] === sent) delete drafts[key]
      if (selectedTemplateKey.value === key) templateNote.value = 'Šablóna uložená.'
      return true
    } catch (e) {
      templateErrors[key] = e.reason === 'unknown_placeholder' && e.token
        ? `Neznámy zástupný symbol ${e.token} — šablóna sa neuložila.`
        : e.message
      return false
    } finally {
      templateSaving.value = false
      delete inflightSaves[key]
    }
  })()
  return inflightSaves[key]
}

// Chips insert at the caret. `@mousedown.prevent` on the chip keeps the textarea's
// focus AND selection, so nothing blurs (and saves) half-way; the blur after the edit
// saves the result.
function insertPlaceholder(token) {
  const el = textareaRef.value
  if (!el || !selectedTemplate.value) return
  const value = templateDraft.value
  const start = Number.isInteger(el.selectionStart) ? el.selectionStart : value.length
  const end = Number.isInteger(el.selectionEnd) ? el.selectionEnd : start
  const next = value.slice(0, start) + token + value.slice(end)
  if (next.length > MAX_BODY) return
  templateDraft.value = next
  nextTick(() => {
    el.focus()
    const caret = start + token.length
    el.setSelectionRange(caret, caret)
  })
}

// ── Group actions ───────────────────────────────────────────────────────────────────
const composePending = reactive({})
const composeErrors = reactive({})
const releasing = ref(false)
const retrying = ref(false)
const rerendering = ref(false)
const releaseError = ref('')
const rerenderNote = ref('')

const composeBlocked = (c) => !c.template_enabled || !(c.count > 0)
  || (c.requires_open_cycle && cycleInfo.value?.status !== 'open')
function composeHint(c) {
  // 21 §UC-WA-004's own copy (also the compose 409's message).
  if (!c.template_enabled) return 'Šablóna je vypnutá — zapnite ju v Nastaveniach'
  if (c.requires_open_cycle && cycleInfo.value?.status !== 'open') return 'Len pre otvorenú objednávku.'
  if (!(c.count > 0)) return 'V tejto skupine nikto nie je.'
  return ''
}

async function compose(c) {
  if (composeBlocked(c) || composePending[c.key]) return
  composePending[c.key] = true
  composeErrors[c.key] = ''
  try {
    // An unsaved / refused edit of THIS group's template must not be bypassed.
    if (!(await saveTemplate(c.template_key))) {
      composeErrors[c.key] = 'Šablóna sa neuložila — opravte ju a skúste znova.'
      return
    }
    await api.composeNotifications(cycleId.value, c.key)
    await loadSegments()
    selectKey(c.key)
  } catch (e) {
    composeErrors[c.key] = e.message
  } finally {
    composePending[c.key] = false
  }
}

async function release() {
  if (releasing.value || queuedCount.value === 0 || !selectedKey.value) return
  releasing.value = true
  releaseError.value = ''
  try {
    const res = await api.releaseNotifications(cycleId.value, selectedKey.value)
    flaggedIds.value = []
    showToast(releasedToast(res.released || 0))
  } catch (e) {
    releaseError.value = e.message
    if (e.reason === 'unresolved_placeholders' && Array.isArray(e.ids)) flaggedIds.value = e.ids
  } finally {
    releasing.value = false
  }
  // Nothing was released on a 409 — the list is read back either way.
  await loadRows()
  loadSegments()
  await scrollToFlagged()
}

async function retry() {
  if (retrying.value || failedCount.value === 0 || !selectedKey.value) return
  retrying.value = true
  releaseError.value = ''
  try {
    const res = await api.retryNotifications(cycleId.value, selectedKey.value)
    flaggedIds.value = []
    showToast(releasedToast(res.released || 0))
  } catch (e) {
    releaseError.value = e.message
    // WA-T8 review: the retry has the release's all-or-nothing gate.
    if (e.reason === 'unresolved_placeholders' && Array.isArray(e.ids)) flaggedIds.value = e.ids
  } finally {
    retrying.value = false
  }
  await loadRows()
  loadSegments()
  await scrollToFlagged()
}

async function rerender() {
  if (rerendering.value || rerenderableCount.value === 0 || !selectedKey.value) return
  rerendering.value = true
  rerenderNote.value = ''
  releaseError.value = ''
  try {
    if (!(await saveTemplate())) {
      releaseError.value = 'Šablóna sa neuložila — texty sa neprepísali.'
      return
    }
    const res = await api.rerenderNotifications(cycleId.value, selectedKey.value)
    const left = Array.isArray(res.unchanged) ? res.unchanged.length : 0
    rerenderNote.value = left
      ? `Prepísané: ${res.rerendered || 0}. Bez zmeny: ${left} — príjemca už nie je v skupine alebo nemá kontakt.`
      : `Prepísané: ${res.rerendered || 0}.`
  } catch (e) {
    releaseError.value = e.message
  } finally {
    rerendering.value = false
  }
  await loadRows()
  loadSegments()
}

// ── Per-row actions ─────────────────────────────────────────────────────────────────
const editingId = ref(null)
const editingBody = ref('')

// `queued` rows, and (WA-T8 review) `failed` ones — the only way to fill a hand-filled
// placeholder (`{tracking}`) the repair door's re-render left in a failed row.
const editable = (row) => row.status === 'queued' || row.status === 'failed'
function startEdit(row) {
  if (!editable(row) || rowPending[row.id]) return
  editingId.value = row.id
  editingBody.value = row.body || ''
  rowErrors[row.id] = ''
}
function cancelEdit() {
  if (editingId.value !== null) rowErrors[editingId.value] = ''
  editingId.value = null
  editingBody.value = ''
}
async function saveEdit(row) {
  if (editingId.value !== row.id || rowPending[row.id]) return
  rowPending[row.id] = true
  rowErrors[row.id] = ''
  try {
    replaceRow(await api.updateNotificationBody(row.id, editingBody.value))
    flaggedIds.value = flaggedIds.value.filter((id) => id !== row.id)
    if (editingId.value === row.id) cancelEdit()
  } catch (e) {
    rowErrors[row.id] = e.message
    if (e.reason === 'not_queued') { cancelEdit(); loadRows() }
  } finally {
    rowPending[row.id] = false
  }
}

async function removeRow(row) {
  if ((row.status !== 'queued' && row.status !== 'skipped') || rowPending[row.id]) return
  rowPending[row.id] = true
  rowErrors[row.id] = ''
  try {
    await api.deleteNotification(row.id)
    rows.value = rows.value.filter((r) => r.id !== row.id)
    if (editingId.value === row.id) cancelEdit()
    loadSegments()
  } catch (e) {
    rowErrors[row.id] = e.message
    loadRows()
  } finally {
    rowPending[row.id] = false
  }
}

// ── wa.me (the „Ručne z môjho čísla“ tab) ───────────────────────────────────────────
// ⚠ A queued WAITLIST row's body carries the host's STANDING link as it was at compose;
// the wa.me tick does not re-render (WA-T5 decision 9a/13), so a rotated link would go
// out dead. Before any „Otvoriť chat“ of a waitlist group the tab re-renders the group
// ONCE (`/rerender` — the release does the same inside its tx) and keeps the buttons
// disabled until the fresh rows are in. The window.open itself must stay SYNCHRONOUS in
// the click (a popup opened after an await is blocked on mobile Safari), which is why
// the refresh happens up front and not inside the click.
let waitlistFreshKey = null
const waitlistRefreshing = ref(false)
// The rows that re-render could NOT refresh (`unchanged` — the person left the segment or
// the link is gone): their text may carry a revoked link ⇒ no chat for them.
const staleIds = ref([])
const isWaitlistGroup = computed(() => typeof selectedKey.value === 'string' && selectedKey.value.startsWith('waitlist:'))

async function maybeRefreshWaitlist() {
  if (tab.value !== 'manual' || !isWaitlistGroup.value || waitlistRefreshing.value) return
  const marker = `${cycleId.value}|${selectedKey.value}`
  if (waitlistFreshKey === marker || queuedCount.value === 0) return
  waitlistFreshKey = marker
  waitlistRefreshing.value = true
  try {
    const res = await api.rerenderNotifications(cycleId.value, selectedKey.value)
    staleIds.value = Array.isArray(res.unchanged) ? res.unchanged : []
  } catch (e) {
    // A disabled/blank waitlist template refuses the re-render; the rows keep the text
    // they were composed with (what the admin sees in the preview).
  } finally {
    waitlistRefreshing.value = false
  }
  await loadRows()
}

function waMeUrl(row) {
  const digits = typeof row.phone_e164 === 'string' ? row.phone_e164.replace(/\D/g, '') : ''
  if (!digits || typeof row.body !== 'string' || !row.body.trim()) return null
  return `https://wa.me/${digits}?text=${encodeURIComponent(row.body)}`
}
// A queued row any time; a RELEASED row only while the bot is not connected (the
// server's `bot_active` 409 is the real guard — this only hides a door that would 409).
// A RELEASED row needs a POSITIVE reading that the bot is down (`health` loaded and not
// connected) — an unknown health is not „down“ (WA-T8 review). A waitlist row the up-front
// re-render could not refresh (`staleIds`) gets no chat.
const canOpenChat = (row) => row.channel === 'whatsapp' && !!row.phone_e164 && typeof row.body === 'string'
  && !!row.body.trim() && !waitlistRefreshing.value && !staleIds.value.includes(row.id)
  && (row.status === 'queued' || (row.status === 'released' && !!health.value && !connected.value))

async function openChat(row) {
  if (!canOpenChat(row) || rowPending[row.id]) return
  const url = waMeUrl(row)
  if (!url) return
  rowPending[row.id] = true
  rowErrors[row.id] = ''
  // Composed HERE, at click time, and handed straight to the browser — never stored in
  // the DOM. `noopener,noreferrer` = the spec's `rel="noopener noreferrer"`.
  window.open(url, '_blank', 'noopener,noreferrer')
  try {
    replaceRow(await api.markNotificationManualSent(row.id))
    loadSegments()
  } catch (e) {
    rowErrors[row.id] = e.reason === 'bot_active' ? 'Bot je pripojený — správu pošle bot' : e.message
    if (e.reason === 'not_waiting' || e.reason === 'not_pending') loadRows()
  } finally {
    rowPending[row.id] = false
  }
}

// ── Cycle switch + lifecycle ────────────────────────────────────────────────────────
async function enterCycle({ deepLink = null } = {}) {
  selectedKey.value = null
  resetGroupState()
  rows.value = []
  groups.value = []
  computedSegs.value = []
  cycleInfo.value = null
  deepLinkMiss.value = false
  if (!cycleId.value) return
  const id = cycleId.value
  await loadSegments()
  if (cycleId.value !== id) return
  if (deepLink) {
    const key = resolveDeepLink(deepLink)
    if (key) { selectKey(key, { writeQuery: false }); return }
    deepLinkMiss.value = true
    return
  }
  // No deep link: the first group that still has something to send, else the first.
  const first = groups.value.find((g) => groupBadgeCount(g) > 0) || groups.value[0]
  if (first) selectKey(first.segment_key, { writeQuery: false })
}

function onCycleChange() {
  router.replace({ query: cycleId.value ? { cycle: String(cycleId.value) } : {} })
  enterCycle()
}

onMounted(async () => {
  loadTemplates()
  await loadCycles()
  await enterCycle({ deepLink: querySegment(route.query.segment) })
})

watchEffect(() => {
  document.title = 'Správy skupinám - Gorifi Admin'
})
</script>

<template>
  <div class="min-h-screen bg-background">
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center gap-4">
        <div class="flex items-center gap-4 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            data-testid="wa-composer-back"
            aria-label="Späť na prehľad"
            @click="router.push('/admin/dashboard')"
            class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <div class="min-w-0">
            <h1 class="text-xl font-bold">Správy skupinám</h1>
            <p class="text-xs text-primary-foreground/70" data-testid="wa-composer-sub">Správa sa nikdy neodošle sama. Skupinu vyberiete, text skontrolujete, odošlete jedným tlačidlom.</p>
          </div>
        </div>
        <Button
          variant="ghost"
          data-testid="wa-settings-link"
          @click="router.push('/admin/whatsapp/settings')"
          class="shrink-0 text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
        >Nastavenia bota →</Button>
      </div>
    </header>

    <main class="max-w-7xl mx-auto px-4 py-6 space-y-4">
      <Alert v-if="error" variant="destructive">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <!-- Cycle selector + the tab pair -->
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="space-y-1 min-w-0">
          <label for="waCycle" class="text-sm font-medium">Objednávka</label>
          <select
            id="waCycle"
            v-model="cycleId"
            data-testid="wa-cycle-select"
            class="block w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm"
            @change="onCycleChange"
          >
            <option v-for="c in cycles" :key="c.id" :value="c.id">{{ cycleLabel(c) }}</option>
          </select>
        </div>
        <div class="inline-flex rounded-md border p-1 bg-muted/50" role="tablist" aria-label="Spôsob odoslania">
          <button
            type="button"
            role="tab"
            data-testid="wa-tab-bot"
            :aria-selected="tab === 'bot' ? 'true' : 'false'"
            :class="['rounded px-3 py-1.5 text-sm font-medium', tab === 'bot' ? 'bg-background shadow' : 'text-muted-foreground']"
            @click="setTab('bot')"
          >Cez bota (Podpultovka)</button>
          <button
            type="button"
            role="tab"
            data-testid="wa-tab-manual"
            :aria-selected="tab === 'manual' ? 'true' : 'false'"
            :class="['rounded px-3 py-1.5 text-sm font-medium', tab === 'manual' ? 'bg-background shadow' : 'text-muted-foreground']"
            @click="setTab('manual')"
          >Ručne z môjho čísla (wa.me)</button>
        </div>
      </div>

      <Alert v-if="showOfflineBanner" data-testid="wa-offline-banner" class="border-amber-300 bg-amber-50 text-amber-900">
        <AlertDescription>Bot je odpojený — správy zostanú vo fronte. Môžete ich poslať ručne v záložke wa.me.</AlertDescription>
      </Alert>

      <p v-if="cyclesLoaded && !cycles.length" class="text-sm text-muted-foreground" data-testid="wa-no-cycles">Zatiaľ nie je žiadna objednávka.</p>

      <div v-else class="grid gap-6 lg:grid-cols-12 items-start">
        <!-- Komu -->
        <Card class="lg:col-span-3 min-w-0" data-testid="wa-komu">
          <CardHeader>
            <CardTitle>Komu</CardTitle>
          </CardHeader>
          <CardContent class="space-y-3">
            <p v-if="segmentsError" class="text-sm text-destructive">{{ segmentsError }}</p>
            <p v-if="deepLinkMiss" class="text-sm text-muted-foreground" data-testid="wa-deeplink-miss">Pre túto skupinu zatiaľ nie sú žiadne správy.</p>
            <p v-if="!groups.length && !segmentsError" class="text-sm text-muted-foreground" data-testid="wa-no-groups">Zatiaľ žiadne správy vo fronte.</p>
            <button
              v-for="g in groups"
              :key="`${g.segment_key}|${g.template_key}`"
              type="button"
              :data-testid="`wa-group-${g.segment_key}`"
              :data-segment-key="g.segment_key"
              :aria-pressed="selectedKey === g.segment_key ? 'true' : 'false'"
              :class="[
                'w-full text-left rounded-lg border px-3 py-2 transition-colors',
                selectedKey === g.segment_key ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
              ]"
              @click="selectKey(g.segment_key)"
            >
              <div class="flex items-start justify-between gap-2">
                <span class="text-sm font-medium min-w-0" style="overflow-wrap:anywhere">{{ g.name || g.segment_key }}</span>
                <Badge variant="outline" data-testid="wa-group-count">{{ groupBadgeCount(g) }}</Badge>
              </div>
              <div class="mt-1 flex flex-wrap gap-1.5 text-xs">
                <span v-if="g.counts?.sent" class="rounded bg-green-100 px-1.5 text-green-800" data-testid="wa-group-sent">{{ g.counts.sent }} odoslané</span>
                <span v-if="g.counts?.failed" class="rounded bg-red-100 px-1.5 text-red-800" data-testid="wa-group-failed">{{ g.counts.failed }} chyby</span>
                <span v-if="g.counts?.skipped" class="rounded bg-muted px-1.5 text-muted-foreground" data-testid="wa-group-skipped">{{ g.counts.skipped }} preskočené</span>
              </div>
            </button>

            <div class="pt-3 border-t space-y-2">
              <div
                v-for="c in computedSegs"
                :key="c.key"
                :data-testid="`wa-computed-${c.key}`"
                :class="['rounded-lg border px-3 py-2 space-y-1.5', c.template_enabled ? '' : 'bg-muted/40', selectedKey === c.key ? 'border-primary' : '']"
              >
                <button type="button" class="text-left text-sm font-medium w-full" style="overflow-wrap:anywhere" @click="selectKey(c.key)">{{ c.name }}</button>
                <p v-if="c.excluded_opt_out || c.no_phone" class="text-xs text-muted-foreground">
                  <span v-if="c.excluded_opt_out">{{ c.excluded_opt_out }} bez súhlasu</span>
                  <span v-if="c.excluded_opt_out && c.no_phone"> · </span>
                  <span v-if="c.no_phone">{{ c.no_phone }} bez čísla</span>
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  :data-testid="`wa-compose-${c.key}`"
                  :disabled="composeBlocked(c) || composePending[c.key]"
                  @click="compose(c)"
                >Pripraviť správy ({{ c.count || 0 }})</Button>
                <p v-if="composeHint(c)" class="text-xs text-muted-foreground" :data-testid="`wa-compose-hint-${c.key}`">{{ composeHint(c) }}</p>
                <p v-if="composeErrors[c.key]" class="text-xs text-destructive">{{ composeErrors[c.key] }}</p>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">Skupiny vznikajú samy: z odovzdania balíčkov (Distribúcia), z otvorenej objednávky a z čakajúcich hostí.</p>
          </CardContent>
        </Card>

        <!-- Šablóna -->
        <Card class="lg:col-span-4 min-w-0" data-testid="wa-template-card">
          <CardHeader>
            <CardTitle data-testid="wa-template-title">Šablóna{{ selectedTemplate ? ` · ${selectedTemplate.name}` : '' }}</CardTitle>
            <CardDescription v-if="selectedTemplate && !selectedTemplate.enabled" data-testid="wa-template-disabled">Šablóna je vypnutá — zapnite ju v Nastaveniach</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <p v-if="!selectedKey" class="text-sm text-muted-foreground">Vyberte skupinu vľavo.</p>
            <template v-else-if="selectedTemplate">
              <div class="flex flex-wrap gap-1.5" data-testid="wa-placeholders">
                <button
                  v-for="p in placeholders"
                  :key="p"
                  type="button"
                  data-testid="wa-placeholder-chip"
                  class="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-muted/70"
                  @mousedown.prevent
                  @click="insertPlaceholder(p)"
                >{{ p }}</button>
              </div>
              <textarea
                ref="textareaRef"
                v-model="templateDraft"
                data-testid="wa-template-text"
                :aria-label="`Text šablóny ${selectedTemplate.name}`"
                :maxlength="MAX_BODY"
                rows="7"
                class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                @blur="saveTemplate()"
              ></textarea>
              <p v-if="templateError" class="text-sm text-destructive" data-testid="wa-template-error">{{ templateError }}</p>
              <p v-else-if="templateSaving" class="text-xs text-muted-foreground">Ukladám...</p>
              <p v-else-if="templateNote" class="text-xs text-muted-foreground" data-testid="wa-template-saved">{{ templateNote }}</p>
              <Button
                v-if="rerenderableCount > 0"
                size="sm"
                variant="outline"
                data-testid="wa-rerender"
                :disabled="rerendering"
                @click="rerender"
              >Prepísať texty vo fronte ({{ rerenderableCount }})</Button>
              <p v-if="rerenderNote" class="text-xs text-muted-foreground" data-testid="wa-rerender-note">{{ rerenderNote }}</p>
            </template>
            <p v-else-if="templatesLoaded" class="text-sm text-muted-foreground">Táto skupina nemá šablónu.</p>
          </CardContent>
        </Card>

        <!-- Náhľad -->
        <Card class="lg:col-span-5 min-w-0" data-testid="wa-preview">
          <CardHeader>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <CardTitle data-testid="wa-preview-title">Náhľad · {{ recipientsLabel(rows.length) }}</CardTitle>
              <div v-if="selectedKey && tab === 'bot'" class="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid="wa-release"
                  :disabled="releasing || queuedCount === 0"
                  @click="release"
                >Poslať skupine ({{ queuedCount }})</Button>
                <Button
                  v-if="failedCount > 0"
                  size="sm"
                  variant="outline"
                  data-testid="wa-retry"
                  :disabled="retrying"
                  @click="retry"
                >Skúsiť znova ({{ failedCount }})</Button>
              </div>
            </div>
            <CardDescription v-if="selectedKey">{{ selectedName }}</CardDescription>
            <CardDescription v-if="selectedKey && tab === 'manual'" data-testid="wa-manual-help">Každý riadok otvorí chat s predvyplneným textom vo vašom WhatsAppe.</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <p v-if="releaseError" class="text-sm text-destructive" data-testid="wa-release-error">{{ releaseError }}</p>
            <p v-if="rowsError" class="text-sm text-destructive">{{ rowsError }}</p>
            <p v-if="!selectedKey" class="text-sm text-muted-foreground">Vyberte skupinu vľavo.</p>
            <p v-else-if="!rowsLoading && !rows.length" class="text-sm text-muted-foreground" data-testid="wa-no-rows">V tejto skupine zatiaľ nie sú žiadne správy.</p>

            <div
              v-for="row in orderedRows"
              :key="row.id"
              :ref="setRowEl(row.id)"
              :data-testid="`wa-row-${row.id}`"
              :data-status="row.status"
              :data-unresolved="isFlagged(row) ? 'true' : 'false'"
              :class="[
                'rounded-lg border px-3 py-2.5 space-y-1.5',
                row.status === 'skipped' ? 'opacity-60 bg-muted/40' : '',
                isFlagged(row) ? 'border-amber-500 ring-2 ring-amber-300' : ''
              ]"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="text-sm font-medium" style="overflow-wrap:anywhere" data-testid="wa-row-name">{{ row.name || '—' }}</div>
                  <div class="text-xs font-mono text-muted-foreground" data-testid="wa-row-phone">
                    {{ displayPhone(row) }}<span v-if="row.channel === 'email'" class="font-sans"> · e-mail</span>
                  </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <Badge
                    data-testid="wa-row-badge"
                    :class="badgeClass(row)"
                    :title="row.status === 'failed' && row.error ? row.error : undefined"
                  >{{ badgeText(row) }}</Badge>
                  <button
                    v-if="row.status === 'queued' || row.status === 'skipped'"
                    type="button"
                    data-testid="wa-row-delete"
                    :aria-label="`Odstrániť správu pre ${row.name || 'príjemcu'}`"
                    :disabled="rowPending[row.id]"
                    class="rounded px-1.5 text-lg leading-none text-muted-foreground hover:text-destructive disabled:opacity-50"
                    @click="removeRow(row)"
                  >×</button>
                </div>
              </div>

              <template v-if="editingId === row.id">
                <textarea
                  v-model="editingBody"
                  data-testid="wa-row-textarea"
                  :aria-label="`Text správy pre ${row.name || 'príjemcu'}`"
                  :maxlength="MAX_BODY"
                  rows="4"
                  class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                ></textarea>
                <div class="flex gap-2">
                  <Button size="sm" data-testid="wa-row-save" :disabled="rowPending[row.id]" @click="saveEdit(row)">{{ rowPending[row.id] ? 'Ukladám...' : 'Uložiť' }}</Button>
                  <Button size="sm" variant="outline" data-testid="wa-row-cancel" :disabled="rowPending[row.id]" @click="cancelEdit">Zrušiť</Button>
                </div>
              </template>
              <template v-else>
                <p class="text-sm whitespace-pre-line min-w-0" style="overflow-wrap:anywhere" data-testid="wa-row-body">{{ row.body || '' }}</p>
              </template>

              <p v-if="isFlagged(row)" class="text-xs font-medium text-amber-800" data-testid="wa-row-unresolved">{{ unresolvedText(row) }}</p>
              <p v-if="tab === 'manual' && staleIds.includes(row.id)" class="text-xs text-muted-foreground" data-testid="wa-row-stale">Text sa nepodarilo obnoviť — chat sa neotvorí. Hosť už pravdepodobne nečaká.</p>
              <p v-if="rowErrors[row.id]" class="text-xs text-destructive" data-testid="wa-row-error">{{ rowErrors[row.id] }}</p>

              <div class="flex flex-wrap gap-2">
                <Button
                  v-if="editable(row) && editingId !== row.id"
                  size="sm"
                  variant="ghost"
                  data-testid="wa-row-edit"
                  :disabled="rowPending[row.id]"
                  @click="startEdit(row)"
                >Upraviť text</Button>
                <template v-if="tab === 'manual'">
                  <span
                    v-if="row.status === 'sent' && row.sent_via === 'wa_me'"
                    class="inline-flex items-center rounded-md border px-3 py-1 text-sm text-green-800 bg-green-50"
                    data-testid="wa-row-opened"
                  >Otvorené ✓</span>
                  <Button
                    v-else-if="canOpenChat(row)"
                    size="sm"
                    variant="outline"
                    data-testid="wa-row-open"
                    :disabled="rowPending[row.id]"
                    @click="openChat(row)"
                  >Otvoriť chat</Button>
                </template>
              </div>
            </div>

            <p v-if="selectedKey && tab === 'bot'" class="text-xs text-muted-foreground" data-testid="wa-bot-help">Bot posiela s odstupom 3–10 s, max. 30 správ/hod. Pri chybe prihlásenia sa zastaví a ukáže to tu.</p>
            <p v-if="selectedKey && failedCount > 0" class="text-xs text-muted-foreground" data-testid="wa-failed-help">Pri chybe opravte kontakt v profile príjemcu, potom „Prepísať texty vo fronte“ a „Skúsiť znova“.</p>
          </CardContent>
        </Card>
      </div>
    </main>

    <Teleport to="body">
      <div
        v-if="toast"
        data-testid="wa-toast"
        role="status"
        aria-live="polite"
        class="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-lg"
      >{{ toast }}</div>
    </Teleport>
  </div>
</template>
