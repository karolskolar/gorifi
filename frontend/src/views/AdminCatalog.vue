<script setup>
// AdminCatalog.vue — the coffee-product catalog admin view (module 12, PC-T7,
// 12 §UC-PC-009): the "unified import tool in the main menu". List + filters
// (incl. the needs-image affordance), edit dialog (metadata + informational
// attributes), IMPORT section (CSV + gsheet, UC-PC-004 report rendering incl.
// pending_fuzzy → merge-flow links), duplicates review with per-pair merge
// (inline confirm), the MIGRATION WORKBENCH (PC-T9, resolved decision 14 —
// checkbox table + assign/create bulk actions, replacing the retired
// auto-migration trigger; NO similarity hints anywhere), and the stats tab.
//
// ⚠ OLD ADMIN SKIN ONLY — shadcn components like every other Admin*.vue view.
// Zero Podpultovka theme classes (.app / neo/ / theme classes) — asserted in
// e2e (catalog-admin.spec.js, the UC-PC-011 admin-skin assertion).
//
// ⚠ There is NO delete action anywhere in this view (resolved decision 9):
// retirement is status='retired' via the edit dialog, and the merge tool is
// the module's only row deleter.
import { ref, computed, watch, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

const router = useRouter()

const activeTab = ref('products')
const error = ref('')

watchEffect(() => {
  document.title = 'Katalóg kávy - Gorifi Admin'
})

// ── Products list ─────────────────────────────────────────────────────────────
const products = ref([])
const loading = ref(true)
const roasteries = ref([])

const filterStatus = ref('')
const filterPurpose = ref('')
const filterRoastery = ref('')
const filterQ = ref('')
// "Chýba fotka" — the report's needs_image flag made durable: client-side over
// image === null, so the admin's post-import to-do list survives the report.
const filterNeedsImage = ref(false)

const PURPOSES = ['Espresso', 'Filter', 'Kapsule']

// Sequence guard (the GSO-T2 dialog rule, banked from PC-T7's review): the
// filter watcher fires per keystroke, so a slow earlier response must not
// overwrite a newer one.
let productsSeq = 0
async function loadProducts() {
  const seq = ++productsSeq
  loading.value = true
  try {
    const rows = await api.getCatalogProducts({
      status: filterStatus.value,
      purpose: filterPurpose.value,
      roastery: filterRoastery.value,
      q: filterQ.value,
    })
    if (seq !== productsSeq) return
    products.value = rows
  } catch (e) {
    if (seq !== productsSeq) return
    error.value = e.message
  } finally {
    if (seq === productsSeq) loading.value = false
  }
}

watch([filterStatus, filterPurpose, filterRoastery, filterQ], () => loadProducts())

const filteredProducts = computed(() =>
  filterNeedsImage.value ? products.value.filter((p) => !p.image) : products.value
)

function formatKg(v) {
  return (v || 0).toString()
}

// ── Edit dialog ───────────────────────────────────────────────────────────────
const showEdit = ref(false)
const editing = ref(null)
// Save errors render IN-DIALOG (the module-11 modalError lesson: a page-level
// Alert hides behind the radix overlay — do not "fix" this to the page Alert).
const modalError = ref('')
const editForm = ref({})
const imageUploading = ref(false)

function openEdit(product) {
  editing.value = product
  modalError.value = ''
  editForm.value = {
    name: product.name || '',
    description1: product.description1 || '',
    description2: product.description2 || '',
    roast_type: product.roast_type || '',
    purpose: product.purpose || '',
    status: product.status || 'available',
    is_new: !!product.is_new,
    curator_pick_note: product.curator_pick_note || '',
    country: product.country || '',
    region: product.region || '',
    altitude: product.altitude || '',
    farm: product.farm || '',
    variety: product.variety || '',
    processing: product.processing || '',
    price_150g: product.price_150g ?? '',
    price_200g: product.price_200g ?? '',
    price_250g: product.price_250g ?? '',
    price_500g: product.price_500g ?? '',
    price_1kg: product.price_1kg ?? '',
    price_20pc5g: product.price_20pc5g ?? '',
  }
  showEdit.value = true
}

const price = (v) => (v === '' || v === null || v === undefined ? null : parseFloat(v))

async function saveEdit() {
  if (!editing.value) return
  modalError.value = ''
  const f = editForm.value
  const data = {
    name: f.name,
    description1: f.description1 || null,
    description2: f.description2 || null,
    roast_type: f.roast_type || null,
    purpose: f.purpose || null,
    status: f.status,
    is_new: f.is_new,
    curator_pick_note: f.curator_pick_note || null,
    country: f.country || null,
    region: f.region || null,
    altitude: f.altitude || null,
    farm: f.farm || null,
    variety: f.variety || null,
    processing: f.processing || null,
    price_150g: price(f.price_150g),
    price_200g: price(f.price_200g),
    price_250g: price(f.price_250g),
    price_500g: price(f.price_500g),
    price_1kg: price(f.price_1kg),
    price_20pc5g: price(f.price_20pc5g),
  }
  try {
    await api.updateCatalogProduct(editing.value.id, data)
    showEdit.value = false
    await loadProducts()
  } catch (e) {
    // The rename-collision 409 (field:'name') and every other save error land
    // here, inside the dialog.
    modalError.value = e.message
  }
}

// Image upload — POST /:id/image (multipart), immediately on file pick. This
// is THE image home from now on: uploaded once here, future snapshots serve
// it via the UC-PC-012 COALESCE.
async function onImagePick(event) {
  const file = event.target.files[0]
  if (!file || !editing.value) return
  imageUploading.value = true
  modalError.value = ''
  try {
    const formData = new FormData()
    formData.append('image', file)
    const updated = await api.uploadCatalogProductImage(editing.value.id, formData)
    editing.value = updated
    await loadProducts()
  } catch (e) {
    modalError.value = e.message
  } finally {
    imageUploading.value = false
    event.target.value = ''
  }
}

// ── Import section ────────────────────────────────────────────────────────────
const importRoastery = ref('')
const csvFile = ref(null)
const gsheetUrl = ref('')
// The shipped default carries over from CycleDetail (multirow is the adapted
// sheet's PRIMARY path).
const gsheetFormat = ref('multirow')
const importing = ref(false)
const importError = ref('')
const importReport = ref(null)

function onCsvChange(event) {
  csvFile.value = event.target.files[0]
}

async function importCsv() {
  if (!csvFile.value) return
  importing.value = true
  importError.value = ''
  importReport.value = null
  try {
    const formData = new FormData()
    formData.append('file', csvFile.value)
    if (importRoastery.value) formData.append('roastery', importRoastery.value)
    const result = await api.importCatalogCSV(formData)
    // ⚠ A 201 does NOT mean "everything imported" — an all-nameless sheet
    // 201s with every row in `unparsed`. Always render the buckets.
    importReport.value = result.report
    csvFile.value = null
    await loadProducts()
  } catch (e) {
    importError.value = e.message
  } finally {
    importing.value = false
  }
}

async function importGsheet() {
  if (!gsheetUrl.value.trim()) return
  importing.value = true
  importError.value = ''
  importReport.value = null
  try {
    const result = gsheetFormat.value === 'multirow'
      ? await api.importCatalogGsheetMultirow(gsheetUrl.value, importRoastery.value)
      : await api.importCatalogGsheet(gsheetUrl.value, importRoastery.value)
    importReport.value = result.report
    gsheetUrl.value = ''
    await loadProducts()
  } catch (e) {
    importError.value = e.message
  } finally {
    importing.value = false
  }
}

// The pending_fuzzy "Je to premenovaný X?" link into the merge flow: the
// duplicates tab recomputes every fuzzy pair on demand, so the flagged pair is
// there with its two merge directions.
function goToDuplicates() {
  activeTab.value = 'duplicates'
}

// ── Duplicates ────────────────────────────────────────────────────────────────
const dupPairs = ref([])
const dupLoading = ref(false)
const dupError = ref('')
// Inline confirm state: which merge (target←source) awaits confirmation.
const pendingMerge = ref(null)

async function loadDuplicates() {
  dupLoading.value = true
  dupError.value = ''
  pendingMerge.value = null
  try {
    const result = await api.getCatalogDuplicates()
    dupPairs.value = result.pairs || []
  } catch (e) {
    dupError.value = e.message
  } finally {
    dupLoading.value = false
  }
}

const pairKey = (pair) => `${pair.a.id}-${pair.b.id}`

function askMerge(pair, target, source) {
  pendingMerge.value = {
    pairKey: pairKey(pair),
    targetId: target.id, targetName: target.name,
    sourceId: source.id, sourceName: source.name,
  }
}

async function confirmMerge() {
  if (!pendingMerge.value) return
  dupError.value = ''
  try {
    await api.mergeCatalogProduct(pendingMerge.value.targetId, pendingMerge.value.sourceId)
    pendingMerge.value = null
    await loadDuplicates()
    await loadProducts()
  } catch (e) {
    dupError.value = e.message
  }
}

// ── Migration workbench (PC-T9, 12 §UC-PC-006 — resolved decision 14) ────────
//
// The pending list the admin drains manually: select groups (checkboxes),
// then either assign them to an EXISTING catalog product (searchable picker)
// or create a NEW one from the selection. Resolved rows disappear from the
// RESPONSE payload — never a re-fetch, never a reload (the PM's step 3). No
// similarity hints, no suggested candidates — the picker is search, not
// suggestion.
const pendingRows = ref([])
const pendingLoading = ref(false)
// In-context (tab-level) error — carries the create-collision 409's
// catalog_id so the UI can offer assign instead, with the colliding product
// pinned and prefiltered in the picker (the 409's catalog_id is SPENT, not
// just a truthiness gate).
const migError = ref('')
const migErrorCatalogId = ref(null)
const selected = ref({}) // group key → true
let pendingSeq = 0

const groupKey = (g) => `${g.normalized_name}\u0000${g.roastery}`
const selectedRows = computed(() => pendingRows.value.filter((r) => selected.value[groupKey(r)]))
const selectedGroups = computed(() =>
  selectedRows.value.map((r) => ({ normalized_name: r.normalized_name, roastery: r.roastery }))
)
const allSelected = computed(
  () => pendingRows.value.length > 0 && selectedRows.value.length === pendingRows.value.length
)

function toggleSelectAll(event) {
  const on = event.target.checked
  const next = {}
  if (on) for (const r of pendingRows.value) next[groupKey(r)] = true
  selected.value = next
}

async function loadPending() {
  const seq = ++pendingSeq
  pendingLoading.value = true
  migError.value = ''
  migErrorCatalogId.value = null
  try {
    const result = await api.getMigrationPending()
    if (seq !== pendingSeq) return
    pendingRows.value = result.pending
    selected.value = {}
  } catch (e) {
    if (seq !== pendingSeq) return
    migError.value = e.message
  } finally {
    if (seq === pendingSeq) pendingLoading.value = false
  }
}

// One-time image conversion (PC-T10, 12 §UC-PC-014) — a small action near the
// workbench: converts legacy base64 image columns to files + URLs and renders
// the report counts.
const convertBusy = ref(false)
const convertResult = ref(null)
const convertError = ref('')

async function convertImages() {
  convertBusy.value = true
  convertError.value = ''
  try {
    convertResult.value = await api.convertCatalogImages()
  } catch (e) {
    convertError.value = e.message || 'Konverzia obrázkov zlyhala'
  } finally {
    convertBusy.value = false
  }
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(n / 1024)} kB`
}

// Resolved rows disappear in place (assign's skipped groups too — a skipped
// group has no unlinked rows left, i.e. it is resolved either way).
function removeResolved(keys) {
  const drop = new Set(keys)
  pendingRows.value = pendingRows.value.filter((r) => !drop.has(groupKey(r)))
  selected.value = {}
}

// Assign dialog — searchable catalog picker. Errors render IN-DIALOG (the
// module-11 modalError idiom).
const showAssign = ref(false)
const assignSearch = ref('')
const assignError = ref('')
const assignBusy = ref(false)

// ⚠ The picker's candidate set is its OWN unfiltered fetch, never
// `products.value` — that list reflects the products tab's status/purpose/
// roastery/q filters, and a filter left on that tab would silently hide valid
// assign targets. Retired products stay assignable (UC-PC-006 is silent, so
// any EXISTING catalog product is a valid target — the admin knows best; the
// backend has always allowed it) and are labelled "Vyradená" in the list.
const pickerProducts = ref([])
const pickerLoading = ref(false)
// The create-collision hand-off pins the colliding product: prefill the
// search with its name and float it to the top, so the 409's catalog_id is
// actually spent, not just gated on.
const pinnedId = ref(null)
let pickerSeq = 0

// Diacritic/case-insensitive search — mirrors the server's normalization
// (search, not suggestion).
const searchNorm = (s) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const assignCandidates = computed(() => {
  const q = searchNorm(assignSearch.value.trim())
  const rows = q
    ? pickerProducts.value.filter((p) => searchNorm(p.name).includes(q))
    : pickerProducts.value
  if (!pinnedId.value) return rows
  const pin = rows.filter((p) => p.id === pinnedId.value)
  return pin.length ? [...pin, ...rows.filter((p) => p.id !== pinnedId.value)] : rows
})

async function openAssignDialog(pinId = null) {
  assignError.value = ''
  assignSearch.value = ''
  pinnedId.value = pinId
  showAssign.value = true
  const seq = ++pickerSeq
  pickerLoading.value = true
  try {
    const rows = await api.getCatalogProducts({}) // unfiltered on purpose
    if (seq !== pickerSeq) return
    pickerProducts.value = rows
    if (pinId) {
      const hit = rows.find((p) => p.id === pinId)
      if (hit) assignSearch.value = hit.name
    }
  } catch (e) {
    if (seq !== pickerSeq) return
    assignError.value = e.message
  } finally {
    if (seq === pickerSeq) pickerLoading.value = false
  }
}

async function confirmAssign(catalogId) {
  if (assignBusy.value || selectedRows.value.length === 0) return
  assignBusy.value = true
  assignError.value = ''
  try {
    const keys = selectedRows.value.map(groupKey)
    await api.assignMigrationGroups(selectedGroups.value, catalogId)
    showAssign.value = false
    migError.value = ''
    migErrorCatalogId.value = null
    removeResolved(keys)
  } catch (e) {
    assignError.value = e.message
  } finally {
    assignBusy.value = false
  }
}

const createBusy = ref(false)
async function createFromSelection() {
  if (createBusy.value || selectedRows.value.length === 0) return
  createBusy.value = true
  migError.value = ''
  migErrorCatalogId.value = null
  try {
    const keys = selectedRows.value.map(groupKey)
    const result = await api.createMigrationProduct(selectedGroups.value)
    removeResolved(keys)
    // "New products appearing": append the created row (already in the list
    // shape — cycles_count + all_time_kg ride in the payload).
    products.value = [...products.value, result.catalog]
  } catch (e) {
    migError.value = e.message
    // The create-collision 409 hands off to assign (the admin just learned
    // why assign is the right verb — the identity already exists). Keep the
    // id so the hand-off opens the picker WITH the colliding product.
    migErrorCatalogId.value = (e.field === 'name' && e.catalogId) || null
  } finally {
    createBusy.value = false
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
const statsPurpose = ref('')
// '' = all time. ⚠ The API helper OMITS last_n_cycles for all time — the
// route 400s on an empty value by design.
const statsWindow = ref('')
const statsData = ref(null)
const statsLoading = ref(false)
const statsError = ref('')
const statsDetail = ref(null)
const showStatsDetail = ref(false)
const sortKey = ref('total_kg')

// Same sequence guard as loadProducts — the [statsPurpose, statsWindow]
// watcher can fire in quick succession.
let statsSeq = 0
async function loadStats() {
  const seq = ++statsSeq
  statsLoading.value = true
  statsError.value = ''
  try {
    const result = await api.getCatalogStats({
      purpose: statsPurpose.value || undefined,
      lastNCycles: statsWindow.value ? parseInt(statsWindow.value) : undefined,
    })
    if (seq !== statsSeq) return
    statsData.value = result
  } catch (e) {
    if (seq !== statsSeq) return
    statsError.value = e.message
  } finally {
    if (seq === statsSeq) statsLoading.value = false
  }
}

watch([statsPurpose, statsWindow], () => loadStats())

const sortedStats = computed(() => {
  const rows = statsData.value?.products ? [...statsData.value.products] : []
  const key = sortKey.value
  rows.sort((a, b) => (b[key] || 0) - (a[key] || 0))
  return rows
})

async function openStatsDetail(catalogId) {
  statsError.value = ''
  try {
    statsDetail.value = await api.getCatalogProductStats(catalogId)
    showStatsDetail.value = true
  } catch (e) {
    statsError.value = e.message
  }
}

// Lazy-load tab data on visit. (The dead `dupLoaded` ref from PC-T7 is gone —
// duplicates deliberately re-fetch on every visit, stats only on the first.)
const statsLoaded = ref(false)
watch(activeTab, (tab) => {
  if (tab === 'duplicates') {
    loadDuplicates()
  }
  if (tab === 'migrate') {
    loadPending()
  }
  if (tab === 'stats' && !statsLoaded.value) {
    statsLoaded.value = true
    loadStats()
  }
})

onMounted(async () => {
  await loadProducts()
  try {
    roasteries.value = await api.getRoasteries()
  } catch (e) {
    // roastery filter/selector just stays empty — not fatal
  }
})

async function logout() {
  await api.logout()
  localStorage.removeItem('adminToken')
  router.push('/admin')
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="router.push('/admin/dashboard')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <h1 class="text-xl font-bold">Katalóg kávy</h1>
        </div>
        <Button variant="ghost" @click="logout" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
          Odhlásiť sa
        </Button>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-8">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <Tabs v-model="activeTab">
        <TabsList class="mb-4">
          <TabsTrigger value="products" data-testid="catalog-tab-products">Produkty</TabsTrigger>
          <TabsTrigger value="import" data-testid="catalog-tab-import">Import</TabsTrigger>
          <TabsTrigger value="duplicates" data-testid="catalog-tab-duplicates">Duplicity</TabsTrigger>
          <TabsTrigger value="migrate" data-testid="catalog-tab-migrate">Migrácia</TabsTrigger>
          <TabsTrigger value="stats" data-testid="catalog-tab-stats">Štatistiky</TabsTrigger>
        </TabsList>

        <!-- ── Products ─────────────────────────────────────────────────── -->
        <TabsContent value="products">
          <Card class="mb-4">
            <CardContent class="p-4">
              <div class="flex flex-wrap items-end gap-3">
                <div class="space-y-1">
                  <Label class="text-xs text-muted-foreground">Hľadať</Label>
                  <Input v-model="filterQ" data-testid="catalog-search" placeholder="Názov produktu..." class="w-56" />
                </div>
                <div class="space-y-1">
                  <Label class="text-xs text-muted-foreground">Stav</Label>
                  <select v-model="filterStatus" class="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm">
                    <option value="">Všetky</option>
                    <option value="available">Dostupné</option>
                    <option value="retired">Vyradené</option>
                  </select>
                </div>
                <div class="space-y-1">
                  <Label class="text-xs text-muted-foreground">Účel</Label>
                  <select v-model="filterPurpose" class="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm">
                    <option value="">Všetky</option>
                    <option v-for="p in PURPOSES" :key="p" :value="p">{{ p }}</option>
                  </select>
                </div>
                <div v-if="roasteries.length > 0" class="space-y-1">
                  <Label class="text-xs text-muted-foreground">Pražiareň</Label>
                  <select v-model="filterRoastery" class="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm">
                    <option value="">Všetky</option>
                    <option v-for="r in roasteries" :key="r.id" :value="r.name">{{ r.name }}</option>
                  </select>
                </div>
                <label class="flex items-center gap-2 h-9 cursor-pointer text-sm">
                  <input type="checkbox" v-model="filterNeedsImage" data-testid="needs-image-filter" class="rounded" />
                  Len bez fotky
                </label>
              </div>
            </CardContent>
          </Card>

          <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

          <div v-else-if="filteredProducts.length === 0" class="text-center py-12 text-muted-foreground">
            Žiadne produkty v katalógu. Použite záložku Import alebo Migrácia.
          </div>

          <Card v-else>
            <Table data-testid="catalog-table">
              <TableHeader>
                <TableRow>
                  <TableHead class="w-16">Foto</TableHead>
                  <TableHead>Názov</TableHead>
                  <TableHead>Účel</TableHead>
                  <TableHead>Pražiareň</TableHead>
                  <TableHead class="text-center">Stav</TableHead>
                  <TableHead class="text-right">Cykly</TableHead>
                  <TableHead class="text-right">Spolu kg</TableHead>
                  <TableHead class="text-right">Akcie</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="product in filteredProducts" :key="product.id" data-testid="catalog-row" :class="{ 'opacity-50': product.status === 'retired' }">
                  <TableCell>
                    <div class="w-12 h-12 rounded overflow-hidden flex items-center justify-center bg-muted">
                      <img v-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                      <svg v-else class="w-6 h-6 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div class="font-medium">{{ product.name }}</div>
                    <div class="flex gap-1 mt-0.5">
                      <Badge v-if="!product.image" variant="outline" class="border-amber-400 text-amber-600 bg-amber-50">Chýba fotka</Badge>
                      <Badge v-if="product.is_new" variant="outline" class="border-emerald-400 text-emerald-600 bg-emerald-50">Novinka</Badge>
                    </div>
                  </TableCell>
                  <TableCell class="text-sm">{{ product.purpose || '-' }}</TableCell>
                  <TableCell class="text-sm text-muted-foreground">{{ product.roastery }}</TableCell>
                  <TableCell class="text-center">
                    <Badge :variant="product.status === 'available' ? 'default' : 'secondary'">
                      {{ product.status === 'available' ? 'Dostupná' : 'Vyradená' }}
                    </Badge>
                  </TableCell>
                  <TableCell class="text-right text-sm">{{ product.cycles_count }}</TableCell>
                  <TableCell class="text-right text-sm">{{ formatKg(product.all_time_kg) }}</TableCell>
                  <TableCell class="text-right">
                    <Button variant="ghost" size="sm" @click="openEdit(product)">Upraviť</Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <!-- ── Import ───────────────────────────────────────────────────── -->
        <TabsContent value="import">
          <Card class="mb-4">
            <CardContent class="p-4">
              <h3 class="text-sm font-medium text-foreground mb-3">Import produktov do katalógu</h3>
              <p class="text-xs text-muted-foreground mb-3">
                Import nikdy nemení žiadny cyklus — aktualizuje iba katalóg (ceny a popisy zo sheetu).
              </p>
              <div v-if="roasteries.length > 0" class="mb-3">
                <Label class="text-xs text-muted-foreground mb-1">Pražiareň pre importované produkty</Label>
                <select v-model="importRoastery" class="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm">
                  <option value="">— Predvolená —</option>
                  <option v-for="r in roasteries" :key="r.id" :value="r.name">{{ r.name }}</option>
                </select>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <!-- Google Sheets import -->
                <div>
                  <Label class="text-xs text-muted-foreground mb-1">Z Google Sheets (verejný sheet)</Label>
                  <div class="flex gap-4 mb-2">
                    <label class="flex items-center text-sm cursor-pointer">
                      <input type="radio" v-model="gsheetFormat" value="multirow" class="mr-1.5" />
                      Viacriadkový (3 riadky = 1 produkt)
                    </label>
                    <label class="flex items-center text-sm cursor-pointer">
                      <input type="radio" v-model="gsheetFormat" value="simple" class="mr-1.5" />
                      Jednoduchý (1 riadok = 1 produkt)
                    </label>
                  </div>
                  <div class="flex gap-2">
                    <Input v-model="gsheetUrl" placeholder="https://docs.google.com/spreadsheets/d/..." :disabled="importing" class="text-sm" />
                    <Button @click="importGsheet" :disabled="!gsheetUrl.trim() || importing" class="whitespace-nowrap">
                      {{ importing ? 'Importujem...' : 'Importovať' }}
                    </Button>
                  </div>
                </div>
                <!-- CSV import -->
                <div>
                  <Label class="text-xs text-muted-foreground mb-1">Z CSV súboru</Label>
                  <div class="flex gap-2">
                    <input type="file" accept=".csv" @change="onCsvChange" data-testid="import-csv-input" class="flex-1 text-sm" />
                    <Button v-if="csvFile" @click="importCsv" :disabled="importing" data-testid="import-csv-button" class="whitespace-nowrap">
                      Importovať
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Alert v-if="importError" variant="destructive" class="mb-4">
            <AlertDescription>{{ importError }}</AlertDescription>
          </Alert>

          <!-- UC-PC-004 report -->
          <Card v-if="importReport" data-testid="import-report">
            <CardContent class="p-4 space-y-4">
              <h3 class="text-sm font-medium">
                Výsledok importu:
                {{ importReport.summary.new }} nových ·
                {{ importReport.summary.matched }} spárovaných ·
                {{ importReport.summary.price_changes }} zmien cien ·
                {{ importReport.summary.pending_fuzzy }} na kontrolu ·
                {{ importReport.summary.unparsed }} nespracovaných
              </h3>

              <div v-if="importReport.new.length > 0">
                <h4 class="text-sm font-semibold mb-1">Nové produkty ({{ importReport.new.length }})</h4>
                <ul class="text-sm space-y-0.5">
                  <li v-for="entry in importReport.new" :key="entry.catalog_id" class="flex items-center gap-2">
                    {{ entry.name }}
                    <Badge v-if="entry.needs_image" variant="outline" class="border-amber-400 text-amber-600 bg-amber-50">Chýba fotka</Badge>
                  </li>
                </ul>
              </div>

              <div v-if="importReport.matched.length > 0">
                <h4 class="text-sm font-semibold mb-1">Spárované s katalógom ({{ importReport.matched.length }})</h4>
                <ul class="text-sm space-y-0.5 text-muted-foreground">
                  <li v-for="entry in importReport.matched" :key="entry.catalog_id">{{ entry.name }}</li>
                </ul>
              </div>

              <div v-if="importReport.price_changes.length > 0">
                <h4 class="text-sm font-semibold mb-1">Zmeny cien ({{ importReport.price_changes.length }})</h4>
                <ul class="text-sm space-y-0.5">
                  <li v-for="(change, i) in importReport.price_changes" :key="i">
                    {{ change.name }} — {{ change.field }}: {{ change.old ?? '—' }} → {{ change.new }}
                  </li>
                </ul>
              </div>

              <div v-if="importReport.pending_fuzzy.length > 0">
                <h4 class="text-sm font-semibold mb-1 text-amber-700">Na kontrolu — možné duplicity ({{ importReport.pending_fuzzy.length }})</h4>
                <ul class="space-y-1">
                  <li v-for="entry in importReport.pending_fuzzy" :key="entry.catalog_id" data-testid="fuzzy-entry" class="text-sm flex flex-wrap items-center gap-2">
                    <span class="font-medium">{{ entry.name }}</span>
                    <span class="text-muted-foreground">— Je to premenovaný {{ entry.candidate_name }}? ({{ Math.round(entry.similarity * 100) }}% zhoda)</span>
                    <Button variant="outline" size="sm" @click="goToDuplicates" data-testid="fuzzy-merge-link">Skontrolovať a zlúčiť</Button>
                  </li>
                </ul>
                <p class="text-xs text-muted-foreground mt-1">Produkt bol vytvorený ako nový — nič sa nezlučuje automaticky.</p>
              </div>

              <div v-if="importReport.unparsed.length > 0">
                <h4 class="text-sm font-semibold mb-1 text-destructive">Nespracované riadky ({{ importReport.unparsed.length }})</h4>
                <ul class="text-sm space-y-0.5">
                  <li v-for="(entry, i) in importReport.unparsed" :key="i" data-testid="unparsed-entry">
                    <span class="font-medium">{{ entry.reason }}</span>
                    <span v-if="entry.row !== null" class="text-muted-foreground"> (záznam č. {{ entry.row }})</span>
                  </li>
                </ul>
                <!-- The row numbers count PARSED records — blank lines in the
                     physical file offset them, so the reason string is the
                     prominent half of each entry. -->
                <p class="text-xs text-muted-foreground mt-1">Číslo záznamu počíta spracované záznamy, nie riadky súboru (prázdne riadky sa preskakujú).</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ── Duplicates ───────────────────────────────────────────────── -->
        <TabsContent value="duplicates">
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-lg font-semibold">Možné duplicity</h2>
            <Button variant="outline" @click="loadDuplicates" :disabled="dupLoading">Obnoviť</Button>
          </div>

          <Alert v-if="dupError" variant="destructive" class="mb-4">
            <AlertDescription>{{ dupError }}</AlertDescription>
          </Alert>

          <div v-if="dupLoading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

          <div v-else-if="dupPairs.length === 0" class="text-center py-12 text-muted-foreground">
            Žiadne podozrivé páry. Dva podobné názvy tej istej pražiarne by sa zobrazili tu.
          </div>

          <div v-else class="space-y-3">
            <Card v-for="pair in dupPairs" :key="pairKey(pair)" data-testid="dup-pair">
              <CardContent class="p-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div class="text-sm">
                    <div><span class="font-medium">{{ pair.a.name }}</span> <span class="text-muted-foreground">({{ pair.a.cycles_count }} cyklov)</span></div>
                    <div><span class="font-medium">{{ pair.b.name }}</span> <span class="text-muted-foreground">({{ pair.b.cycles_count }} cyklov)</span></div>
                    <div class="text-xs text-muted-foreground mt-1">Zhoda {{ Math.round(pair.similarity * 100) }}%</div>
                  </div>
                  <div v-if="!pendingMerge || pendingMerge.pairKey !== pairKey(pair)" class="flex flex-col gap-1">
                    <Button variant="outline" size="sm" @click="askMerge(pair, pair.a, pair.b)">Ponechať „{{ pair.a.name }}“</Button>
                    <Button variant="outline" size="sm" @click="askMerge(pair, pair.b, pair.a)">Ponechať „{{ pair.b.name }}“</Button>
                  </div>
                  <div v-else class="flex items-center gap-2" data-testid="merge-confirm">
                    <span class="text-sm">Zlúčiť „{{ pendingMerge.sourceName }}“ do „{{ pendingMerge.targetName }}“? História sa prepojí a druhý záznam sa zmaže.</span>
                    <Button variant="destructive" size="sm" @click="confirmMerge">Potvrdiť</Button>
                    <Button variant="outline" size="sm" @click="pendingMerge = null">Zrušiť</Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <!-- ── Migration workbench (PC-T9, resolved decision 14) ─────────── -->
        <TabsContent value="migrate">
          <!-- In-context error; the create-collision 409 offers assign instead. -->
          <Alert v-if="migError" variant="destructive" class="mb-4" data-testid="workbench-error">
            <AlertDescription class="flex flex-wrap items-center gap-2">
              <span>{{ migError }}</span>
              <Button v-if="migErrorCatalogId" variant="outline" size="sm" data-testid="workbench-assign-handoff" @click="openAssignDialog(migErrorCatalogId)">
                Priradiť k existujúcemu
              </Button>
            </AlertDescription>
          </Alert>

          <div v-if="pendingLoading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

          <div v-else-if="pendingRows.length === 0 && !migError" class="text-center py-12 text-muted-foreground" data-testid="workbench-empty">História je zmigrovaná.</div>

          <template v-else-if="pendingRows.length > 0">
            <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
              <p class="text-sm text-muted-foreground" data-testid="workbench-count">
                Nespárované produkty z histórie: <span class="font-medium text-foreground">{{ pendingRows.length }}</span>
              </p>
              <div class="flex gap-2">
                <Button :disabled="selectedRows.length === 0" data-testid="workbench-assign-button" @click="openAssignDialog()">
                  Priradiť k existujúcemu
                </Button>
                <Button :disabled="selectedRows.length === 0 || createBusy" variant="outline" data-testid="workbench-create-button" @click="createFromSelection">
                  Vytvoriť nový produkt z výberu
                </Button>
              </div>
            </div>

            <Card>
              <Table data-testid="workbench-table">
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-10">
                      <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" class="rounded" aria-label="Vybrať všetko" />
                    </TableHead>
                    <TableHead>Názov</TableHead>
                    <TableHead>Pražiareň</TableHead>
                    <TableHead class="text-right">Záznamy</TableHead>
                    <TableHead class="text-right">Cykly</TableHead>
                    <TableHead>Najnovší cyklus</TableHead>
                    <TableHead>Účel</TableHead>
                    <TableHead>Praženie</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in pendingRows" :key="groupKey(row)" data-testid="workbench-row">
                    <TableCell>
                      <input type="checkbox" v-model="selected[groupKey(row)]" data-testid="workbench-check" class="rounded" :aria-label="`Vybrať ${row.display_name}`" />
                    </TableCell>
                    <TableCell class="font-medium">{{ row.display_name }}</TableCell>
                    <TableCell class="text-sm text-muted-foreground">{{ row.roastery }}</TableCell>
                    <TableCell class="text-right text-sm" data-testid="workbench-snapshots">{{ row.snapshots }}</TableCell>
                    <TableCell class="text-right text-sm" data-testid="workbench-cycles">{{ row.cycles }}</TableCell>
                    <TableCell class="text-sm text-muted-foreground">{{ row.newest_cycle.name }}</TableCell>
                    <TableCell class="text-sm">{{ row.purpose || '-' }}</TableCell>
                    <TableCell class="text-sm">{{ row.roast_type || '-' }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </Card>
          </template>

          <!-- One-time image conversion (PC-T10, 12 §UC-PC-014) -->
          <Card class="mt-8">
            <CardContent class="p-4">
              <div class="flex flex-wrap items-center gap-3">
                <Button variant="outline" :disabled="convertBusy" data-testid="convert-images-button" @click="convertImages">
                  Konvertovať obrázky na súbory
                </Button>
                <span v-if="convertResult" class="text-sm text-muted-foreground" data-testid="convert-images-result">
                  Skonvertované: {{ convertResult.converted_catalog }} v katalógu, {{ convertResult.converted_snapshots }} v cykloch
                  · preskočené: {{ convertResult.skipped.length }}
                  · uvoľnené: {{ formatBytes(convertResult.bytes_freed) }}
                </span>
                <span v-if="convertError" class="text-sm text-destructive" data-testid="convert-images-error">{{ convertError }}</span>
              </div>
              <p class="text-xs text-muted-foreground mt-2">
                Presunie obrázky uložené v databáze (base64) do súborov. Opakované spustenie je bezpečné.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- ── Stats ────────────────────────────────────────────────────── -->
        <TabsContent value="stats">
          <Card class="mb-4">
            <CardContent class="p-4">
              <div class="flex flex-wrap items-end gap-3">
                <div class="space-y-1">
                  <Label class="text-xs text-muted-foreground">Účel</Label>
                  <select v-model="statsPurpose" class="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm">
                    <option value="">Všetky</option>
                    <option v-for="p in PURPOSES" :key="p" :value="p">{{ p }}</option>
                  </select>
                </div>
                <div class="space-y-1">
                  <Label class="text-xs text-muted-foreground">Obdobie</Label>
                  <select v-model="statsWindow" class="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm">
                    <option value="">Celé obdobie</option>
                    <option value="3">Posledné 3 cykly</option>
                    <option value="6">Posledných 6 cyklov</option>
                    <option value="12">Posledných 12 cyklov</option>
                  </select>
                </div>
                <div class="space-y-1">
                  <Label class="text-xs text-muted-foreground">Zoradiť podľa</Label>
                  <select v-model="sortKey" class="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm">
                    <option value="total_kg">Spolu kg</option>
                    <option value="friend_kg">Kg priatelia</option>
                    <option value="guest_kg">Kg hostia</option>
                    <option value="distinct_friends">Počet priateľov</option>
                    <option value="repeat_buyers">Opakovaní kupujúci</option>
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>

          <Alert v-if="statsError" variant="destructive" class="mb-4">
            <AlertDescription>{{ statsError }}</AlertDescription>
          </Alert>

          <div v-if="statsLoading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

          <Card v-else-if="statsData">
            <Table data-testid="stats-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Názov</TableHead>
                  <TableHead>Účel</TableHead>
                  <TableHead class="text-right">Spolu kg</TableHead>
                  <TableHead class="text-right">Priatelia kg</TableHead>
                  <TableHead class="text-right">Hostia kg</TableHead>
                  <TableHead class="text-right">Priatelia</TableHead>
                  <TableHead class="text-right">Opakovaní</TableHead>
                  <TableHead class="text-right">Ponúkaný</TableHead>
                  <TableHead class="text-right">Objednaný</TableHead>
                  <TableHead class="text-right">Akcie</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="row in sortedStats" :key="row.catalog_id" data-testid="stats-row">
                  <TableCell class="font-medium">{{ row.name }}</TableCell>
                  <TableCell class="text-sm">{{ row.purpose || '-' }}</TableCell>
                  <TableCell class="text-right">{{ row.total_kg }}</TableCell>
                  <TableCell class="text-right">{{ row.friend_kg }}</TableCell>
                  <TableCell class="text-right">{{ row.guest_kg }}</TableCell>
                  <TableCell class="text-right">{{ row.distinct_friends }}</TableCell>
                  <TableCell class="text-right">{{ row.repeat_buyers }}</TableCell>
                  <TableCell class="text-right">{{ row.cycles_offered }}</TableCell>
                  <TableCell class="text-right">{{ row.cycles_ordered }}</TableCell>
                  <TableCell class="text-right">
                    <Button variant="ghost" size="sm" @click="openStatsDetail(row.catalog_id)">Detail</Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <p v-if="statsData.window" class="px-4 py-2 text-xs text-muted-foreground">
              Vyhodnotené cykly: {{ statsData.window.cycle_ids.length }}
            </p>
          </Card>
        </TabsContent>
      </Tabs>
    </main>

    <!-- Edit dialog -->
    <Dialog :open="showEdit" @update:open="showEdit = $event">
      <DialogContent class="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="catalog-edit-dialog">
        <DialogHeader>
          <DialogTitle>Upraviť produkt</DialogTitle>
        </DialogHeader>

        <Alert v-if="modalError" variant="destructive" data-testid="catalog-modal-error">
          <AlertDescription>{{ modalError }}</AlertDescription>
        </Alert>

        <div v-if="editing" class="space-y-4 py-2">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <!-- Left column: image -->
            <div>
              <Label class="mb-2">Fotografia produktu</Label>
              <div class="border rounded-lg p-4 text-center">
                <img v-if="editing.image" :src="editing.image" class="max-h-40 mx-auto rounded mb-2" data-testid="catalog-image-preview" />
                <p v-else class="text-sm text-muted-foreground py-6">Bez fotky</p>
                <input type="file" accept="image/jpeg,image/png,image/webp" @change="onImagePick" :disabled="imageUploading" data-testid="catalog-image-input" class="text-sm w-full" />
                <p class="text-xs text-muted-foreground mt-2">Fotka sa nahrá do katalógu hneď a použije sa vo všetkých budúcich cykloch.</p>
              </div>
            </div>
            <!-- Right column: core fields -->
            <div class="space-y-3">
              <div class="space-y-1">
                <Label>Názov *</Label>
                <Input v-model="editForm.name" data-testid="catalog-edit-name" />
              </div>
              <div class="space-y-1">
                <Label>Pražiareň</Label>
                <Input :model-value="editing.roastery" disabled />
              </div>
              <div class="space-y-1">
                <Label>Účel</Label>
                <Input v-model="editForm.purpose" placeholder="Espresso / Filter / Kapsule" />
              </div>
              <div class="space-y-1">
                <Label>Praženie</Label>
                <Input v-model="editForm.roast_type" />
              </div>
              <div class="space-y-1">
                <Label>Stav</Label>
                <select v-model="editForm.status" data-testid="catalog-edit-status" class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm">
                  <option value="available">Dostupná</option>
                  <option value="retired">Vyradená</option>
                </select>
                <p class="text-xs text-muted-foreground">Vyradenie nemá vplyv na existujúce cykly, objednávky ani štatistiky.</p>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-1">
              <Label>Popis 1</Label>
              <textarea v-model="editForm.description1" rows="2" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"></textarea>
            </div>
            <div class="space-y-1">
              <Label>Popis 2 / chuťový profil</Label>
              <textarea v-model="editForm.description2" rows="2" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"></textarea>
            </div>
          </div>

          <!-- Informational attributes -->
          <div>
            <h4 class="text-sm font-semibold mb-1">Informačné atribúty</h4>
            <p class="text-xs text-muted-foreground mb-2">Prázdne polia sa jednoducho nezobrazia.</p>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div class="space-y-1">
                <Label>Krajina pôvodu</Label>
                <Input v-model="editForm.country" data-testid="catalog-edit-country" />
              </div>
              <div class="space-y-1">
                <Label>Región</Label>
                <Input v-model="editForm.region" />
              </div>
              <div class="space-y-1">
                <Label>Nadmorská výška</Label>
                <Input v-model="editForm.altitude" />
              </div>
              <div class="space-y-1">
                <Label>Farma</Label>
                <Input v-model="editForm.farm" />
              </div>
              <div class="space-y-1">
                <Label>Odroda</Label>
                <Input v-model="editForm.variety" />
              </div>
              <div class="space-y-1">
                <Label>Spracovanie</Label>
                <Input v-model="editForm.processing" />
              </div>
            </div>
          </div>

          <!-- Curation fields -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" v-model="editForm.is_new" class="rounded" />
              Novinka
            </label>
            <div class="space-y-1">
              <Label>Poznámka kurátora</Label>
              <Input v-model="editForm.curator_pick_note" />
            </div>
          </div>

          <!-- Prices -->
          <div>
            <h4 class="text-sm font-semibold mb-2">Aktuálne ceny (EUR)</h4>
            <div class="grid grid-cols-3 md:grid-cols-6 gap-3">
              <div class="space-y-1">
                <Label>150g</Label>
                <Input v-model="editForm.price_150g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>200g</Label>
                <Input v-model="editForm.price_200g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>250g</Label>
                <Input v-model="editForm.price_250g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>500g</Label>
                <Input v-model="editForm.price_500g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>1kg</Label>
                <Input v-model="editForm.price_1kg" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>20ks×5g</Label>
                <Input v-model="editForm.price_20pc5g" type="number" step="0.01" />
              </div>
            </div>
            <p class="text-xs text-muted-foreground mt-1">Zmena ceny platí pre budúce cykly — ceny v existujúcich cykloch sú zmrazené.</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="showEdit = false">Zrušiť</Button>
          <Button @click="saveEdit" :disabled="!editForm.name || !editForm.name.trim()">Uložiť</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Assign picker (migration workbench) — a searchable catalog PICKER,
         deliberately without suggestions (decision 14: search, not suggestion).
         Errors render in-dialog (the module-11 modalError idiom). -->
    <Dialog :open="showAssign" @update:open="showAssign = $event">
      <DialogContent class="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="assign-dialog">
        <DialogHeader>
          <DialogTitle>Priradiť k existujúcemu produktu</DialogTitle>
        </DialogHeader>

        <Alert v-if="assignError" variant="destructive" data-testid="assign-error">
          <AlertDescription>{{ assignError }}</AlertDescription>
        </Alert>

        <div class="space-y-3 py-2">
          <p class="text-sm text-muted-foreground">
            Vybrané skupiny ({{ selectedRows.length }}) sa prepoja na zvolený produkt v katalógu.
          </p>
          <Input v-model="assignSearch" data-testid="assign-search" placeholder="Hľadať v katalógu..." />
          <p v-if="pickerLoading" class="text-sm text-muted-foreground py-4 text-center">
            Načítavam...
          </p>
          <p v-else-if="assignCandidates.length === 0" class="text-sm text-muted-foreground py-4 text-center">
            Žiadny produkt nezodpovedá hľadaniu.
          </p>
          <ul v-else class="divide-y border rounded-md max-h-72 overflow-y-auto">
            <li v-for="p in assignCandidates" :key="p.id">
              <button
                type="button"
                class="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                :disabled="assignBusy"
                data-testid="assign-option"
                @click="confirmAssign(p.id)"
              >
                <span class="font-medium">{{ p.name }}</span>
                <span class="text-xs text-muted-foreground whitespace-nowrap">{{ p.roastery }}{{ p.status === 'retired' ? ' · Vyradená' : '' }}</span>
              </button>
            </li>
          </ul>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="showAssign = false">Zrušiť</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Per-product stats detail -->
    <Dialog :open="showStatsDetail" @update:open="showStatsDetail = $event">
      <DialogContent class="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="stats-detail-dialog">
        <DialogHeader>
          <DialogTitle>{{ statsDetail?.product?.name }}</DialogTitle>
        </DialogHeader>
        <div v-if="statsDetail" class="space-y-4 py-2">
          <div>
            <h4 class="text-sm font-semibold mb-1">História podľa cyklov</h4>
            <p v-if="statsDetail.history.length === 0" class="text-sm text-muted-foreground">Zatiaľ v žiadnom cykle.</p>
            <Table v-else>
              <TableHeader>
                <TableRow>
                  <TableHead>Cyklus</TableHead>
                  <TableHead class="text-right">Priatelia kg</TableHead>
                  <TableHead class="text-right">Hostia kg</TableHead>
                  <TableHead class="text-right">Spolu kg</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="h in statsDetail.history" :key="h.cycle_id">
                  <TableCell class="text-sm">{{ h.cycle_name }}</TableCell>
                  <TableCell class="text-right text-sm">{{ h.friend_kg }}</TableCell>
                  <TableCell class="text-right text-sm">{{ h.guest_kg }}</TableCell>
                  <TableCell class="text-right text-sm">{{ h.total_kg }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <div>
            <h4 class="text-sm font-semibold mb-1">Podľa priateľov</h4>
            <p v-if="statsDetail.friends.length === 0" class="text-sm text-muted-foreground">Zatiaľ žiadne objednávky priateľov.</p>
            <Table v-else>
              <TableHeader>
                <TableRow>
                  <TableHead>Priateľ</TableHead>
                  <TableHead class="text-right">Počet cyklov</TableHead>
                  <TableHead class="text-right">Spolu kg</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="f in statsDetail.friends" :key="f.friend_id">
                  <TableCell class="text-sm">{{ f.name || '-' }}</TableCell>
                  <TableCell class="text-right text-sm">{{ f.times }}</TableCell>
                  <TableCell class="text-right text-sm">{{ f.total_kg }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showStatsDetail = false">Zavrieť</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
