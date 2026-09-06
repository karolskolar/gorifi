<script setup>
import { ref, onMounted, computed, nextTick, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { variantText } from '@/lib/guest-cart'

// ── SHEET GEOMETRY ───────────────────────────────────────────────────────────
// Spare Print Premium A4, 8 etikiet 105 × 74 mm: A4 (210 × 297 mm) divided into
// exact eighths, 2 columns × 4 rows, edge to edge, no page margin.
//
// 297 / 4 = 74.25 — the sheet is MARKETED as "74" but the die-cut is 74.25, and
// rounding it down accumulates a full millimetre of drift by the bottom row.
// Every number the layout depends on lives here so a printer that lands slightly
// off can be corrected in one place instead of hunted through the CSS.
const LABELS_PER_SHEET = 8

const cols = 2
const rows = 4
const labelW = 105
const labelH = 74.25

const route = useRoute()
const router = useRouter()
const cycleId = route.params.id

const cycle = ref(null)
const labels = ref([])
const loading = ref(true)
const error = ref('')
const showGuides = ref(true)
const sheetsEl = ref(null)

onMounted(async () => {
  try {
    const data = await api.getCycleLabels(cycleId)
    cycle.value = data.cycle
    labels.value = data.labels
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
    await nextTick()
    fitAll()
  }
})

watchEffect(() => {
  document.title = cycle.value ? `Štítky - ${cycle.value.name}` : 'Štítky'
})

// Labels chunked into sheets of 8. The grid could reflow on its own, but an
// explicit sheet element is what gives each page a hard `break-after` — relying
// on the browser to paginate a single tall grid puts a page break THROUGH a
// label at some zoom levels, and half a sticker is worse than a wasted one.
const sheets = computed(() => {
  const out = []
  for (let i = 0; i < labels.value.length; i += LABELS_PER_SHEET) {
    out.push(labels.value.slice(i, i + LABELS_PER_SHEET))
  }
  return out
})

function itemLine(item) {
  const spec = [item.purpose, variantText(item)].filter(Boolean).join(' · ')
  return spec ? `${item.product_name} · ${spec}` : item.product_name
}

// ── AUTO-FIT ─────────────────────────────────────────────────────────────────
// The item list is the only variable-height part of a label. Real orders run to
// about 10–12 lines and fit at the normal scale; the dense scale exists so that a
// freak 20-line order stays COMPLETE rather than being silently truncated — a
// sticker that omits items is worse than a sticker that is hard to read, because
// the bag gets packed wrong and nobody can tell from looking at it.
//
// Measured rather than counted: a line's height depends on whether the product
// name wraps, which depends on the name, so any items-per-label constant would be
// a guess that is wrong for long roastery names.
function fitAll() {
  // Scoped to this component's own root — a document-wide query would be a
  // latent bug the moment any other view renders something with this testid.
  const root = sheetsEl.value
  if (!root) return
  for (const el of root.querySelectorAll('[data-testid="label"]')) {
    const list = el.querySelector('[data-role="items"]')
    if (!list) continue
    el.classList.remove('dense')
    if (list.scrollHeight > list.clientHeight) el.classList.add('dense')
  }
}

function printSheet() {
  window.print()
}
</script>

<template>
  <div class="labels-page">
    <!-- Everything in here is screen-only: the printed page must contain the
         stickers and nothing else, or the grid shifts and the sheet is wasted. -->
    <header class="no-print bg-primary text-primary-foreground shadow">
      <div class="max-w-5xl mx-auto px-4 py-4 flex justify-between items-center gap-4">
        <div class="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
            @click="router.push(`/admin/cycle/${cycleId}/distribution`)"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <h1 class="text-xl font-bold truncate">Štítky - {{ cycle?.name || 'Načítavam...' }}</h1>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <label class="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input v-model="showGuides" type="checkbox" class="accent-current" />
            Vodiace čiary
          </label>
          <Button variant="secondary" :disabled="loading || !labels.length" @click="printSheet">
            Tlačiť
          </Button>
        </div>
      </div>
    </header>

    <div class="no-print max-w-5xl mx-auto px-4 pt-4">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <template v-else>
        <p v-if="!labels.length" class="text-center py-12 text-muted-foreground">
          Tento cyklus nemá žiadne odoslané objednávky, takže niet čo tlačiť.
        </p>
        <div v-else class="mb-4 rounded-md border bg-muted/40 px-4 py-3 text-sm">
          <p class="font-semibold">{{ labels.length }} štítkov na {{ sheets.length }} hárkoch (105 × 74,25 mm)</p>
          <p class="text-muted-foreground mt-1">
            V dialógu tlače nastavte mierku na <strong>100 % / „Skutočná veľkosť“</strong> a okraje na
            <strong>žiadne</strong>. Voľba „Prispôsobiť strane“ posunie každý štítok.
          </p>
        </div>
      </template>
    </div>

    <!-- The sheets themselves -->
    <main ref="sheetsEl" :class="['sheets', { 'show-guides': showGuides }]">
      <section v-for="(sheet, s) in sheets" :key="s" class="sheet" data-testid="sheet">
        <article v-for="(label, i) in sheet" :key="`${s}-${i}`" class="label" data-testid="label">
          <template v-if="label.kind === 'packeta'">
            <div class="packeta-tag">PACKETA</div>
            <div class="name name-packeta">{{ label.name }}</div>
            <!-- Both slots ALWAYS render: Packeta requires a phone and an
                 e-mail to create a shipment, so a missing one is a blocker the
                 admin has to see on the sticker, not an absence to hide. -->
            <div class="contact">
              <div :class="{ missing: !label.phone }">{{ label.phone || '—' }}</div>
              <div :class="{ missing: !label.email }">{{ label.email || '—' }}</div>
            </div>
            <div class="addr">
              <span class="addr-label">Výdajné miesto</span>
              {{ label.address }}
            </div>
          </template>

          <template v-else>
            <div class="name">{{ label.name }}</div>
            <div v-if="label.via" class="via">cez: {{ label.via }}</div>
            <!-- The slot stays even when empty: most friend profiles have no
                 phone yet, and a reserved line keeps every label the same shape
                 while the numbers are filled in over time. -->
            <div class="contact" :class="{ missing: !label.phone }">{{ label.phone || '—' }}</div>
            <div v-if="label.place" class="place">Odber: {{ label.place }}</div>
            <div class="rule"></div>
            <div class="items" data-role="items">
              <div v-for="(item, k) in label.items" :key="k" class="item">
                <span class="qty">{{ item.quantity }}×</span>
                <span class="what">{{ itemLine(item) }}</span>
              </div>
            </div>
          </template>
        </article>
      </section>
    </main>
  </div>
</template>

<style scoped>
/* Geometry is bound from the constants above so the CSS and the script can
   never disagree about what a sheet is. */
.sheets {
  --label-w: v-bind('labelW + "mm"');
  --label-h: v-bind('labelH + "mm"');
  --cols: v-bind('cols');
  --rows: v-bind('rows');
  --pad-x: 7mm;   /* horizontal inset — cutting tolerance safety */
  --pad-y: 5.5mm; /* vertical inset */
}

.sheet {
  width: calc(var(--label-w) * var(--cols));
  height: calc(var(--label-h) * var(--rows));
  display: grid;
  grid-template-columns: repeat(var(--cols), var(--label-w));
  grid-template-rows: repeat(var(--rows), var(--label-h));
  background: #fff;
  color: #000;
  /* Screen only — on paper the sheet IS the page. */
  margin: 0 auto 8mm;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12);
}

.label {
  width: var(--label-w);
  height: var(--label-h);
  box-sizing: border-box;
  padding: var(--pad-y) var(--pad-x);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
  /* A label must never be split across pages. */
  break-inside: avoid;
  page-break-inside: avoid;
}

.show-guides .label {
  outline: 0.1mm dashed #bbb;
  outline-offset: -0.05mm;
}

.name {
  font-size: 13pt;
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.1pt;
}
.name-packeta { margin-top: 2mm; }

.via {
  font-size: 8.5pt;
  color: #555;
  margin-top: 0.4mm;
}

.contact {
  font-size: 9pt;
  margin-top: 1.2mm;
  line-height: 1.3;
}

.missing { color: #bbb; }

.place {
  font-size: 9.5pt;
  font-weight: 600;
  margin-top: 1.2mm;
  line-height: 1.25;
}

.rule {
  border-top: 0.35mm solid #000;
  margin: 2mm 0 1.6mm;
}

.items {
  font-size: 8.5pt;
  line-height: 1.28;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.item { display: flex; gap: 1.6mm; }
.qty { font-weight: 700; flex: 0 0 auto; min-width: 5.5mm; }
.what { flex: 1 1 auto; }

/* Auto-fit fallback — see fitAll(). Applied per label, never globally, so one
   long order does not shrink the type on everyone else's sticker. */
.label.dense .name { font-size: 11.5pt; }
.label.dense .items { font-size: 7pt; line-height: 1.18; }

.packeta-tag {
  align-self: flex-start;
  font-size: 8pt;
  font-weight: 700;
  letter-spacing: 0.6pt;
  background: #000;
  color: #fff;
  padding: 0.7mm 2mm;
  border-radius: 0.8mm;
}

.addr {
  font-size: 11pt;
  line-height: 1.32;
  margin-top: auto;
  padding-top: 2mm;
  border-top: 0.35mm solid #000;
}

.addr-label {
  font-size: 7.5pt;
  text-transform: uppercase;
  letter-spacing: 0.5pt;
  color: #555;
  display: block;
  margin-bottom: 0.6mm;
}

@media screen {
  .labels-page { background: #f4f4f5; min-height: 100vh; padding-bottom: 8mm; }
  .sheets { padding-top: 4mm; }
}

@media print {
  @page { size: A4 portrait; margin: 0; }

  .no-print { display: none !important; }

  .labels-page { background: #fff; padding: 0; }

  .sheet {
    margin: 0;
    box-shadow: none;
    break-after: page;
    page-break-after: always;
  }
  .sheet:last-child { break-after: auto; page-break-after: auto; }

  /* Guides are a screen aid for checking alignment; they must never print. */
  .show-guides .label { outline: none; }
}
</style>
