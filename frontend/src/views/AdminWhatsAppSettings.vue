<script setup>
// 21 §UC-WA-012 (WA-T7) — the `a-wa-settings` screen: „WhatsApp bot“.
//
// Admin = the old shadcn skin (no `neo/` classes, no Podpultovka tokens); the prototype
// `admin2.jsx AWaSettings` is LAYOUT/FLOW only. Four cards + a runbook fold:
//   Stav               — the `gorifi-wa` health (via the API's proxy), pause/resume, the test message
//   Spárovať telefón   — ONLY while `state = 'qr'`: the pairing QR as an `<img>` data URL
//   Tempo odosielania  — pace + hourly cap (process-reported, else the documented defaults), opt-in count
//   Šablóny            — the six templates (WA-T2's GET/PUT): Zapnuté/Neskôr toggle, inline edit
//   „Pre správcu servera“ — the operator runbook (re-pair, library bump)
//
// ⚠ THE QR IS A PAIRING CREDENTIAL (§UC-WA-012). It lives ONLY in the `health` ref of this
// instance — never in storage, never logged, never rendered anywhere else — and is
// dropped on unmount. Only a `data:image/…` URL is ever rendered: a health body naming
// any other URL is not fetched (the CSP's `img-src 'self' data:` would block it anyway).
//
// ⚠ Polling: health every 5 s while mounted, stopped on unmount. `healthSeq` is the
// `loadSeq` guard (CLAUDE.md): only the LATEST request's answer is applied, and a pause
// toggle bumps it so a poll issued before the write cannot repaint the old state.
//
// ⚠ Every gated control has a JS guard as well as `disabled` — a dispatched click
// ignores the attribute (CLAUDE.md). Per-template pending state is per KEY.
//
// D7: no „Odpojiť/Pripojiť“ in v1 — re-pairing is the runbook.
import { ref, reactive, computed, onMounted, onUnmounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'

const router = useRouter()

// Server bounds, mirrored as `maxlength` (CLAUDE.md): `routes/admin.js` (32) and
// `helpers/template-render.js MAX_BODY_LENGTH` (1000).
const MAX_TEST_PHONE = 32
const MAX_TEMPLATE_BODY = 1000
const POLL_MS = 5000
// The documented defaults (21 §UC-WA-011 env table) when the process reports none.
const DEFAULT_PACE = { min_ms: 3000, max_ms: 10000 }
const DEFAULT_HOURLY_MAX = 30

const STATE_WORDS = {
  starting: 'spúšťa sa',
  qr: 'čaká na spárovanie',
  disconnected: 'odpojené',
  auth_failure: 'chyba prihlásenia',
  paused: 'pozastavené',
}

const error = ref('')

// ── Health ──────────────────────────────────────────────────────────────────
const health = ref(null)
const healthError = ref('')
let healthSeq = 0
let pollTimer = null
let unmounted = false

async function loadHealth() {
  const seq = ++healthSeq
  try {
    const h = await api.getWhatsappHealth()
    if (unmounted || seq !== healthSeq) return
    health.value = h
    healthError.value = ''
    if (typeof h.paused === 'boolean' && !pausing.value) paused.value = h.paused
  } catch (e) {
    if (unmounted || seq !== healthSeq) return
    // The API itself failed: the process state is UNKNOWN — drop the last answer (and
    // with it any QR) rather than keep painting a stale one.
    health.value = null
    healthError.value = e.message || 'Stav sa nepodarilo načítať'
  }
}

const reachable = computed(() => health.value?.reachable === true)
const connected = computed(() => reachable.value && health.value.state === 'connected')
const stateWord = computed(() => {
  if (!health.value) return ''
  if (!reachable.value) return 'proces nebeží'
  if (connected.value) return ''
  const s = health.value.state
  return STATE_WORDS[s] || (typeof s === 'string' && s ? s : 'neznámy stav')
})
const showQrCard = computed(() => reachable.value && health.value.state === 'qr')
const qrSrc = computed(() => {
  const qr = showQrCard.value ? health.value.qr : null
  return typeof qr === 'string' && qr.startsWith('data:image/') ? qr : null
})

// „+421905123456“ ⇒ „+421 905 123 456“ (SK/CZ nine-digit national numbers); anything
// else is shown as the process reported it.
function formatNumber(n) {
  if (typeof n !== 'string' || !n) return '—'
  const m = /^\+(42[01])(\d{3})(\d{3})(\d{3})$/.exec(n)
  return m ? `+${m[1]} ${m[2]} ${m[3]} ${m[4]}` : n
}

// A SQLite UTC stamp (`YYYY-MM-DD HH:MM:SS`) or an ISO instant ⇒ `d. m. yyyy HH:mm`
// in Europe/Bratislava; an unparsable value is shown raw, none is „—“.
function formatStamp(v) {
  if (typeof v !== 'string' || !v) return '—'
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return v
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bratislava', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]))
  return `${Number(p.day)}. ${Number(p.month)}. ${p.year} ${p.hour}:${p.minute}`
}

const queueText = computed(() => {
  const q = health.value?.queue
  const n = (x) => (Number.isFinite(x) ? x : 0)
  return q && typeof q === 'object' ? `${n(q.released)} / ${n(q.sent_today)} / ${n(q.failed)}` : '—'
})

const seconds = (ms) => String(Math.round(ms / 100) / 10).replace('.', ',')
const paceText = computed(() => {
  const p = reachable.value ? health.value.pace : null
  const ok = p && Number.isFinite(p.min_ms) && Number.isFinite(p.max_ms) && p.min_ms >= 0 && p.max_ms >= p.min_ms
  const pace = ok ? p : DEFAULT_PACE
  return `${seconds(pace.min_ms)}–${seconds(pace.max_ms)} s`
})
const hourlyText = computed(() => {
  const h = reachable.value ? health.value.hourly_max : null
  return String(Number.isInteger(h) && h >= 0 ? h : DEFAULT_HOURLY_MAX)
})
const optInText = computed(() => {
  const o = health.value?.opt_in
  return o && Number.isFinite(o.on) && Number.isFinite(o.total) ? `${o.on} z ${o.total} priateľov` : '—'
})

// ── Pause / resume ──────────────────────────────────────────────────────────
const paused = ref(false)
const pausing = ref(false)

async function togglePause() {
  if (pausing.value) return
  pausing.value = true
  error.value = ''
  try {
    const res = await api.updateAdminSettings({ whatsappPaused: !paused.value })
    paused.value = res.whatsappPaused === true
    // A poll issued BEFORE the write must not repaint the old flag.
    healthSeq++
    loadHealth()
  } catch (e) {
    error.value = e.message
  } finally {
    pausing.value = false
  }
}

// ── Test message ────────────────────────────────────────────────────────────
const testPhone = ref('')
const savedTestPhone = ref('')
const savingPhone = ref(false)
const sendingTest = ref(false)
const testError = ref('')
const testOk = ref('')

const phoneDirty = computed(() => testPhone.value !== savedTestPhone.value)
// Disabled until a number is SAVED — and while the field differs from what is saved, the
// message would go to the saved number, not the typed one.
const canSendTest = computed(() => savedTestPhone.value.trim() !== '' && !phoneDirty.value && !sendingTest.value)

async function saveTestPhone() {
  if (savingPhone.value || !phoneDirty.value) return
  savingPhone.value = true
  testError.value = ''
  testOk.value = ''
  try {
    const res = await api.updateAdminSettings({ whatsappTestPhone: testPhone.value })
    savedTestPhone.value = res.whatsappTestPhone ?? ''
    testPhone.value = savedTestPhone.value
  } catch (e) {
    testError.value = e.message
  } finally {
    savingPhone.value = false
  }
}

async function sendTest() {
  if (!canSendTest.value) return
  sendingTest.value = true
  testError.value = ''
  testOk.value = ''
  try {
    await api.sendWhatsappTest()
    testOk.value = 'Testovacia správa je vo fronte — bot ju odošle na uložené číslo.'
    loadHealth()
  } catch (e) {
    testError.value = e.message
  } finally {
    sendingTest.value = false
  }
}

// ── Templates ───────────────────────────────────────────────────────────────
const templates = ref([])
const placeholders = ref([])
const templatesLoaded = ref(false)
const templatesError = ref('')
const pending = reactive({})
const rowErrors = reactive({})
const editingKey = ref(null)
const editingBody = ref('')

async function loadTemplates() {
  templatesError.value = ''
  try {
    const res = await api.getNotificationTemplates()
    templates.value = Array.isArray(res.templates) ? res.templates : []
    placeholders.value = Array.isArray(res.placeholders) ? res.placeholders : []
    templatesLoaded.value = true
  } catch (e) {
    templatesError.value = e.message
  }
}

function replaceTemplate(next) {
  templates.value = templates.value.map((t) => (t.key === next.key ? { ...t, ...next } : t))
}

// „3 na štart · 2 pripravené · 1 vlastná“ — computed from `enabled`: the enabled and the
// disabled templates other than `custom`, which is always the one „vlastná“.
const summary = computed(() => {
  const rest = templates.value.filter((t) => t.key !== 'custom')
  const on = rest.filter((t) => t.enabled).length
  const off = rest.length - on
  const offWord = off === 1 ? 'pripravená' : off >= 2 && off <= 4 ? 'pripravené' : 'pripravených'
  const custom = templates.value.some((t) => t.key === 'custom') ? ' · 1 vlastná' : ''
  return `${on} na štart · ${off} ${offWord}${custom}`
})

async function toggleTemplate(t) {
  if (pending[t.key]) return
  pending[t.key] = true
  rowErrors[t.key] = ''
  try {
    replaceTemplate(await api.updateNotificationTemplate(t.key, { enabled: !t.enabled }))
  } catch (e) {
    rowErrors[t.key] = e.message
  } finally {
    pending[t.key] = false
  }
}

// ⚠ ONE editor at a time (`editingKey`), so a new one may not open while ANY template
// write is in flight: the in-flight save's completion would otherwise land on the NEW
// editor's state (review, WA-T7). Disabled in the template too; this is the JS guard.
const anyPending = computed(() => Object.values(pending).some(Boolean))

function startEdit(t) {
  if (anyPending.value) return
  editingKey.value = t.key
  editingBody.value = t.body || ''
  rowErrors[t.key] = ''
}

function cancelEdit() {
  if (editingKey.value) rowErrors[editingKey.value] = ''
  editingKey.value = null
  editingBody.value = ''
}

async function saveEdit(t) {
  if (pending[t.key] || editingKey.value !== t.key) return
  pending[t.key] = true
  rowErrors[t.key] = ''
  try {
    replaceTemplate(await api.updateNotificationTemplate(t.key, { body: editingBody.value }))
    // Close the editor only if it is still THIS template's — a slow save of A must never
    // close or discard another template's open editor (defence in depth: `startEdit()`
    // already refuses while a write is pending).
    if (editingKey.value === t.key) {
      editingKey.value = null
      editingBody.value = ''
    }
  } catch (e) {
    rowErrors[t.key] = e.reason === 'unknown_placeholder' && e.token
      ? `Neznámy zástupný symbol ${e.token} — šablóna sa neuložila.`
      : e.message
  } finally {
    pending[t.key] = false
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const s = await api.getAdminSettings()
    paused.value = s.whatsappPaused === true
    savedTestPhone.value = s.whatsappTestPhone || ''
    testPhone.value = savedTestPhone.value
  } catch (e) {
    error.value = e.message
  }
}

onMounted(() => {
  loadSettings()
  loadTemplates()
  loadHealth()
  pollTimer = setInterval(loadHealth, POLL_MS)
})

onUnmounted(() => {
  unmounted = true
  healthSeq++
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  health.value = null
})

watchEffect(() => {
  document.title = 'WhatsApp bot - Gorifi Admin'
})
</script>

<template>
  <div class="min-h-screen bg-background">
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            data-testid="wa-back"
            aria-label="Späť na nastavenia"
            @click="router.push('/admin/settings')"
            class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <div>
            <h1 class="text-xl font-bold">WhatsApp bot</h1>
            <p class="text-xs text-primary-foreground/70">Nastavenia · WhatsApp bot</p>
          </div>
        </div>
      </div>
    </header>

    <main class="max-w-5xl mx-auto px-4 py-8">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div class="grid gap-6 md:grid-cols-2 items-start">
        <div class="space-y-6 min-w-0">
          <!-- Stav -->
          <Card data-testid="wa-status-card">
            <CardHeader>
              <div class="flex items-center justify-between gap-2">
                <CardTitle>Stav</CardTitle>
                <Badge
                  v-if="health"
                  data-testid="wa-status-badge"
                  :class="connected ? 'bg-green-100 text-green-800 border-transparent hover:bg-green-100' : ''"
                  :variant="connected ? 'outline' : 'destructive'"
                >{{ connected ? 'Pripojené' : 'Odpojené' }}</Badge>
              </div>
              <CardDescription v-if="stateWord" data-testid="wa-state-word">{{ stateWord }}</CardDescription>
              <CardDescription v-else-if="!health && !healthError">Zisťujem stav…</CardDescription>
              <CardDescription v-if="healthError" class="text-destructive" data-testid="wa-health-error">{{ healthError }}</CardDescription>
            </CardHeader>
            <CardContent class="space-y-4">
              <dl v-if="reachable" class="text-sm divide-y">
                <div class="flex justify-between gap-4 py-1.5">
                  <dt class="text-muted-foreground">Číslo bota</dt>
                  <dd class="font-mono" data-testid="wa-number">{{ formatNumber(health.number) }}</dd>
                </div>
                <div class="flex justify-between gap-4 py-1.5">
                  <dt class="text-muted-foreground">Zariadenie</dt>
                  <dd>WhatsApp Web · server</dd>
                </div>
                <div class="flex justify-between gap-4 py-1.5">
                  <dt class="text-muted-foreground">Posledná správa</dt>
                  <dd data-testid="wa-last-sent">{{ formatStamp(health.last_sent_at) }}</dd>
                </div>
                <div class="flex justify-between gap-4 py-1.5">
                  <dt class="text-muted-foreground">Vo fronte / odoslané / chyby</dt>
                  <dd class="font-mono" data-testid="wa-queue">{{ queueText }}</dd>
                </div>
                <div v-if="health.last_error" class="flex justify-between gap-4 py-1.5">
                  <dt class="text-muted-foreground">Posledná chyba</dt>
                  <dd class="text-destructive text-right min-w-0" style="overflow-wrap:anywhere" data-testid="wa-last-error">{{ health.last_error }}</dd>
                </div>
              </dl>

              <div>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="wa-pause-toggle"
                  :disabled="pausing"
                  @click="togglePause"
                >{{ paused ? 'Obnoviť odosielanie' : 'Pozastaviť odosielanie' }}</Button>
              </div>

              <div class="pt-4 border-t space-y-2">
                <Label for="waTestPhone">Testovacie číslo</Label>
                <div class="flex gap-2">
                  <Input
                    id="waTestPhone"
                    v-model="testPhone"
                    data-testid="wa-test-phone"
                    type="tel"
                    :maxlength="MAX_TEST_PHONE"
                    placeholder="0905 123 456"
                    class="flex-1"
                  />
                  <Button
                    variant="outline"
                    data-testid="wa-test-phone-save"
                    :disabled="savingPhone || !phoneDirty"
                    @click="saveTestPhone"
                  >{{ savingPhone ? 'Ukladám...' : 'Uložiť' }}</Button>
                </div>
                <Button
                  size="sm"
                  data-testid="wa-test-send"
                  :disabled="!canSendTest"
                  @click="sendTest"
                >{{ sendingTest ? 'Odosielam...' : 'Poslať testovaciu správu' }}</Button>
                <p v-if="testError" class="text-sm text-destructive" data-testid="wa-test-error">{{ testError }}</p>
                <p v-if="testOk" class="text-sm text-green-700" data-testid="wa-test-ok">{{ testOk }}</p>
              </div>
            </CardContent>
          </Card>

          <!-- Spárovať telefón — only while state = 'qr' -->
          <Card v-if="showQrCard" data-testid="wa-qr-card">
            <CardHeader>
              <CardTitle>Spárovať telefón</CardTitle>
              <CardDescription>Na telefóne s číslom bota: WhatsApp → Prepojené zariadenia → Prepojiť zariadenie → naskenujte.</CardDescription>
            </CardHeader>
            <CardContent class="flex flex-col items-center gap-3 text-center">
              <img
                v-if="qrSrc"
                :src="qrSrc"
                data-testid="wa-qr-img"
                alt="QR kód na spárovanie"
                class="w-56 h-56 border rounded bg-white"
                style="image-rendering: pixelated"
              />
              <p class="text-xs font-mono text-muted-foreground">QR sa obnoví o ~20 s</p>
            </CardContent>
          </Card>

          <!-- Tempo odosielania -->
          <Card data-testid="wa-pace-card">
            <CardHeader>
              <CardTitle>Tempo odosielania</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3">
              <dl class="text-sm divide-y">
                <div class="flex justify-between gap-4 py-1.5">
                  <dt class="text-muted-foreground">Odstup medzi správami</dt>
                  <dd class="font-mono" data-testid="wa-pace-gap">{{ paceText }}</dd>
                </div>
                <div class="flex justify-between gap-4 py-1.5">
                  <dt class="text-muted-foreground">Max. za hodinu</dt>
                  <dd class="font-mono" data-testid="wa-pace-hourly">{{ hourlyText }}</dd>
                </div>
                <div class="flex justify-between gap-4 py-1.5">
                  <dt class="text-muted-foreground">Súhlas (opt-in)</dt>
                  <dd data-testid="wa-opt-in">{{ optInText }}</dd>
                </div>
              </dl>
              <p class="text-xs text-muted-foreground">Správy sa odosielajú len ľuďom so zapnutým súhlasom v profile. Bez platného čísla sa riadok preskočí a označí.</p>
            </CardContent>
          </Card>
        </div>

        <!-- Šablóny -->
        <Card class="min-w-0" data-testid="wa-templates-card">
          <CardHeader>
            <div class="flex items-center justify-between gap-2">
              <CardTitle>Šablóny</CardTitle>
              <span v-if="templatesLoaded" class="text-sm text-muted-foreground" data-testid="wa-templates-summary">{{ summary }}</span>
            </div>
          </CardHeader>
          <CardContent class="space-y-3">
            <p v-if="templatesError" class="text-sm text-destructive">{{ templatesError }}</p>
            <p v-else-if="!templatesLoaded" class="text-sm text-muted-foreground">Načítavam...</p>
            <div
              v-for="t in templates"
              :key="t.key"
              :data-testid="`wa-template-${t.key}`"
              :data-template-key="t.key"
              :class="['rounded-lg border px-3 py-3', t.enabled ? '' : 'bg-muted/40']"
            >
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <span class="font-medium text-sm">{{ t.name }}</span>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="wa-template-toggle"
                    :aria-pressed="t.enabled ? 'true' : 'false'"
                    :title="t.enabled ? 'Vypnúť šablónu' : 'Zapnúť šablónu'"
                    :disabled="pending[t.key]"
                    :class="[
                      'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors disabled:opacity-50',
                      t.enabled ? 'border-transparent bg-green-100 text-green-800 hover:bg-green-200' : 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80'
                    ]"
                    @click="toggleTemplate(t)"
                  >{{ t.enabled ? 'Zapnuté' : 'Neskôr' }}</button>
                  <Button
                    v-if="editingKey !== t.key"
                    variant="ghost"
                    size="sm"
                    data-testid="wa-template-edit"
                    :disabled="anyPending"
                    @click="startEdit(t)"
                  >Upraviť</Button>
                </div>
              </div>

              <template v-if="editingKey === t.key">
                <textarea
                  v-model="editingBody"
                  data-testid="wa-template-textarea"
                  :aria-label="`Text šablóny ${t.name}`"
                  :maxlength="MAX_TEMPLATE_BODY"
                  rows="4"
                  class="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                ></textarea>
                <p v-if="placeholders.length" class="text-xs text-muted-foreground mt-1">Povolené: {{ placeholders.join(' ') }}</p>
                <div class="flex gap-2 mt-2">
                  <Button size="sm" data-testid="wa-template-save" :disabled="pending[t.key]" @click="saveEdit(t)">
                    {{ pending[t.key] ? 'Ukladám...' : 'Uložiť' }}
                  </Button>
                  <Button size="sm" variant="outline" data-testid="wa-template-cancel" :disabled="pending[t.key]" @click="cancelEdit">Zrušiť</Button>
                </div>
              </template>
              <template v-else>
                <p v-if="t.body" class="text-sm text-muted-foreground mt-1.5 whitespace-pre-line" style="overflow-wrap:anywhere" data-testid="wa-template-body">{{ t.body }}</p>
                <p v-else class="text-sm text-muted-foreground italic mt-1.5">(bez textu)</p>
              </template>
              <p v-if="rowErrors[t.key]" class="text-sm text-destructive mt-1" data-testid="wa-template-error">{{ rowErrors[t.key] }}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- Runbook -->
      <details class="mt-6 rounded-lg border bg-card px-4 py-3 text-sm" data-testid="wa-runbook">
        <summary class="cursor-pointer font-medium">Pre správcu servera</summary>
        <div class="mt-3 space-y-3 text-muted-foreground">
          <div>
            <p class="font-medium text-foreground">Znovu spárovať telefón</p>
            <ol class="list-decimal pl-5 space-y-1 mt-1">
              <li><code class="font-mono text-xs">pm2 stop gorifi-wa</code></li>
              <li>zmažte priečinok <code class="font-mono text-xs">wa-session/</code> (<code class="font-mono text-xs">/var/www/gorifi/wa-session</code>)</li>
              <li><code class="font-mono text-xs">pm2 restart /var/www/gorifi/ecosystem.config.cjs --only gorifi-wa</code></li>
              <li>naskenujte QR kód na tejto stránke (karta „Spárovať telefón“)</li>
            </ol>
          </div>
          <div>
            <p class="font-medium text-foreground">Po zmene WhatsApp Web (bot prestane odosielať)</p>
            <p class="mt-1">V priečinku <code class="font-mono text-xs">wa/</code> spustite <code class="font-mono text-xs">npm update whatsapp-web.js</code> a nasaďte (<code class="font-mono text-xs">./deploy/deploy.sh production wa</code>).</p>
          </div>
        </div>
      </details>
    </main>
  </div>
</template>
