<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import BalanceBadge from '@/components/BalanceBadge.vue'

const route = useRoute()
const router = useRouter()

const cycle = ref(null)
const products = ref([])
const orders = ref([])
const summary = ref(null)

const loading = ref(true)
const activeTab = ref('products')
const error = ref('')

// Product modal
const showProductModal = ref(false)
const editingProduct = ref(null)
const productForm = ref({
  name: '', description1: '', description2: '', roast_type: '', purpose: '', price_150g: '', price_200g: '', price_250g: '', price_500g: '', price_1kg: '', price_20pc5g: '', image: '', roastery: '', stock_limit_g: ''
})
const imagePreview = ref(null)
const isDragging = ref(false)

// Roasteries
const roasteries = ref([])

// Drag & drop for product list
const dragOverProductId = ref(null)
const droppingProductId = ref(null)

// CSV import
const csvFile = ref(null)

// Google Sheets import
const gsheetUrl = ref('')
const gsheetLoading = ref(false)
const gsheetFormat = ref('multirow')  // 'simple' or 'multirow'
const importRoastery = ref('')  // roastery to assign to imported products

// Summary roastery filter
const summaryRoasteryFilter = ref('')  // '' = all, '_default' = no roastery, or roastery name

// Markup ratio
const markupPercent = ref(0)
const markupSaving = ref(false)

// Parcel delivery
const parcelEnabled = ref(false)
const parcelFee = ref(0)
const parcelSaving = ref(false)

// Expected date
const expectedDate = ref('')
const expectedDateSaving = ref(false)

// Plan note
const planNote = ref('')
const planNoteSaving = ref(false)

// Cycle name editing
const editingCycleName = ref(false)
const cycleNameEdit = ref('')

const cycleId = computed(() => route.params.id)

// Expandable orders
const expandedOrders = ref(new Set())

function toggleExpand(orderId) {
  if (expandedOrders.value.has(orderId)) {
    expandedOrders.value.delete(orderId)
  } else {
    expandedOrders.value.add(orderId)
  }
  expandedOrders.value = new Set(expandedOrders.value) // trigger reactivity
}

const isBakery = computed(() => cycle.value?.type === 'bakery')

const ordersView = ref('friend') // 'friend' or 'product'
const expandedProducts = ref(new Set())

function toggleExpandProduct(key) {
  if (expandedProducts.value.has(key)) {
    expandedProducts.value.delete(key)
  } else {
    expandedProducts.value.add(key)
  }
  expandedProducts.value = new Set(expandedProducts.value)
}

const submittedOrders = computed(() => orders.value.filter(o => o.status === 'submitted' || o.status === 'draft'))

// Group by product: { productKey: { product_name, purpose, variant, total_quantity, total_price, friends: [{ friend_name, quantity, price }] } }
const ordersByProduct = computed(() => {
  const map = {}
  for (const order of submittedOrders.value) {
    if (!order.items) continue
    for (const item of order.items) {
      const key = `${item.product_id}-${item.variant}`
      if (!map[key]) {
        map[key] = {
          key,
          product_name: item.product_name,
          variant_label: item.variant_label || null,
          purpose: item.purpose,
          variant: item.variant,
          total_quantity: 0,
          total_price: 0,
          friends: []
        }
      }
      map[key].total_quantity += item.quantity
      map[key].total_price += item.price * item.quantity
      map[key].friends.push({
        friend_name: order.friend_name,
        quantity: item.quantity,
        price: item.price * item.quantity
      })
    }
  }
  // Sort friends within each product by quantity desc
  const result = Object.values(map)
  for (const p of result) {
    p.friends.sort((a, b) => b.quantity - a.quantity)
  }
  // Sort products by purpose then name
  result.sort((a, b) => {
    const purposeOrder = { 'Espresso': 1, 'Filter': 2, 'Kapsule': 3, 'Slané': 4, 'Sladké': 5 }
    const pa = purposeOrder[a.purpose] || 6
    const pb = purposeOrder[b.purpose] || 6
    if (pa !== pb) return pa - pb
    return a.product_name.localeCompare(b.product_name)
  })
  return result
})

const orderTotals = computed(() => ({
  count_150g: submittedOrders.value.reduce((sum, o) => sum + (o.count_150g || 0), 0),
  count_200g: submittedOrders.value.reduce((sum, o) => sum + (o.count_200g || 0), 0),
  count_250g: submittedOrders.value.reduce((sum, o) => sum + (o.count_250g || 0), 0),
  count_500g: submittedOrders.value.reduce((sum, o) => sum + (o.count_500g || 0), 0),
  count_1kg: submittedOrders.value.reduce((sum, o) => sum + (o.count_1kg || 0), 0),
  count_20pc5g: submittedOrders.value.reduce((sum, o) => sum + (o.count_20pc5g || 0), 0),
  count_unit: submittedOrders.value.reduce((sum, o) => sum + (o.count_unit || 0), 0),
  total: submittedOrders.value.reduce((sum, o) => sum + (o.total || 0), 0)
}))

const COFFEE_VARIANT_COLUMNS = [
  { label: '150g', countField: 'count_150g' },
  { label: '200g', countField: 'count_200g' },
  { label: '250g', countField: 'count_250g' },
  { label: '500g', countField: 'count_500g' },
  { label: '1kg',  countField: 'count_1kg' },
  { label: '20ks', countField: 'count_20pc5g' },
]

const visibleVariantColumns = computed(() =>
  COFFEE_VARIANT_COLUMNS.filter(col => (orderTotals.value[col.countField] || 0) > 0)
)

onMounted(async () => {
  await loadAll()
})

// Set page title
watchEffect(() => {
  document.title = cycle.value?.name ? `${cycle.value.name} - Gorifi Admin` : 'Gorifi Admin'
})

async function loadAll() {
  loading.value = true
  try {
    const [cycleData, productsData, ordersData, summaryData, roasteriesData] = await Promise.all([
      api.getCycle(cycleId.value),
      api.getProducts(cycleId.value),
      api.getOrders(cycleId.value),
      api.getCycleSummary(cycleId.value),
      api.getRoasteries()
    ])
    cycle.value = cycleData
    products.value = productsData
    orders.value = ordersData
    summary.value = summaryData
    roasteries.value = roasteriesData
    // Initialize markup percentage from cycle data (ratio 1.19 = 19%)
    markupPercent.value = Math.round(((cycleData.markup_ratio || 1.0) - 1) * 100)
    // Initialize expected date
    expectedDate.value = cycleData.expected_date || ''
    planNote.value = cycleData.plan_note || ''
    parcelEnabled.value = !!cycleData.parcel_enabled
    parcelFee.value = cycleData.parcel_fee || 0
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Cycle actions
async function toggleLock() {
  const newStatus = cycle.value.status === 'locked' ? 'open' : 'locked'
  await api.updateCycle(cycleId.value, { status: newStatus })
  await loadAll()
}

async function markCompleted() {
  await api.updateCycle(cycleId.value, { status: 'completed' })
  await loadAll()
}

function startEditingCycleName() {
  cycleNameEdit.value = cycle.value?.name || ''
  editingCycleName.value = true
}

async function saveCycleName() {
  if (!cycleNameEdit.value.trim()) return
  try {
    await api.updateCycle(cycleId.value, { name: cycleNameEdit.value.trim() })
    await loadAll()
    editingCycleName.value = false
  } catch (e) {
    error.value = e.message
  }
}

function cancelEditingCycleName() {
  editingCycleName.value = false
  cycleNameEdit.value = ''
}

async function saveMarkup() {
  markupSaving.value = true
  error.value = ''
  try {
    // Convert percentage to ratio (19% -> 1.19)
    const ratio = 1 + (markupPercent.value / 100)
    await api.updateCycle(cycleId.value, { markup_ratio: ratio })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    markupSaving.value = false
  }
}

async function saveParcel() {
  parcelSaving.value = true
  error.value = ''
  try {
    await api.updateCycle(cycleId.value, {
      parcel_enabled: parcelEnabled.value,
      parcel_fee: parcelEnabled.value ? parcelFee.value : 0
    })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    parcelSaving.value = false
  }
}

async function saveExpectedDate() {
  expectedDateSaving.value = true
  error.value = ''
  try {
    await api.updateCycle(cycleId.value, { expected_date: expectedDate.value || null })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    expectedDateSaving.value = false
  }
}

async function savePlanNote() {
  planNoteSaving.value = true
  error.value = ''
  try {
    await api.updateCycle(cycleId.value, { plan_note: planNote.value || null })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    planNoteSaving.value = false
  }
}

async function openPlannedCycle() {
  await api.updateCycle(cycleId.value, { status: 'open' })
  await loadAll()
}

// Product actions
function openProductModal(product = null) {
  editingProduct.value = product
  if (product) {
    productForm.value = {
      ...product,
      price_150g: product.price_150g || '',
      price_200g: product.price_200g || '',
      price_250g: product.price_250g || '',
      price_500g: product.price_500g || '',
      price_1kg: product.price_1kg || '',
      price_20pc5g: product.price_20pc5g || '',
      image: product.image || '',
      roastery: product.roastery || '',
      stock_limit_g: product.stock_limit_g || ''
    }
    imagePreview.value = product.image || null
  } else {
    productForm.value = { name: '', description1: '', description2: '', roast_type: '', purpose: '', price_150g: '', price_200g: '', price_250g: '', price_500g: '', price_1kg: '', price_20pc5g: '', image: '', roastery: '', stock_limit_g: '' }
    imagePreview.value = null
  }
  showProductModal.value = true
}

async function saveProduct() {
  const data = {
    ...productForm.value,
    cycle_id: cycleId.value,
    price_150g: productForm.value.price_150g ? parseFloat(productForm.value.price_150g) : null,
    price_200g: productForm.value.price_200g ? parseFloat(productForm.value.price_200g) : null,
    price_250g: productForm.value.price_250g ? parseFloat(productForm.value.price_250g) : null,
    price_500g: productForm.value.price_500g ? parseFloat(productForm.value.price_500g) : null,
    price_1kg: productForm.value.price_1kg ? parseFloat(productForm.value.price_1kg) : null,
    price_20pc5g: productForm.value.price_20pc5g ? parseFloat(productForm.value.price_20pc5g) : null,
    image: productForm.value.image || null,
    roastery: productForm.value.roastery || null,
    stock_limit_g: productForm.value.stock_limit_g ? parseInt(productForm.value.stock_limit_g) : null
  }

  if (editingProduct.value) {
    await api.updateProduct(editingProduct.value.id, data)
  } else {
    await api.createProduct(data)
  }

  showProductModal.value = false
  await loadAll()
}

function duplicateProduct(product) {
  editingProduct.value = null
  productForm.value = {
    ...product,
    name: product.name + ' (kópia)',
    price_150g: product.price_150g || '',
    price_200g: product.price_200g || '',
    price_250g: product.price_250g || '',
    price_500g: product.price_500g || '',
    price_1kg: product.price_1kg || '',
    price_20pc5g: product.price_20pc5g || '',
    image: product.image || '',
    roastery: product.roastery || '',
    stock_limit_g: product.stock_limit_g || ''
  }
  imagePreview.value = product.image || null
  showProductModal.value = true
}

async function deleteProduct(id) {
  if (!confirm('Naozaj vymazať tento produkt?')) return
  await api.deleteProduct(id)
  await loadAll()
}

async function importCSV() {
  if (!csvFile.value) return

  const formData = new FormData()
  formData.append('file', csvFile.value)
  if (importRoastery.value) {
    formData.append('roastery', importRoastery.value)
  }

  try {
    await api.importProducts(cycleId.value, formData)
    csvFile.value = null
    await loadAll()
  } catch (e) {
    error.value = e.message
  }
}

function onFileChange(event) {
  csvFile.value = event.target.files[0]
}

async function importGoogleSheets() {
  if (!gsheetUrl.value.trim()) return

  gsheetLoading.value = true
  error.value = ''

  try {
    const result = gsheetFormat.value === 'multirow'
      ? await api.importFromGoogleSheetsMultirow(cycleId.value, gsheetUrl.value, importRoastery.value)
      : await api.importFromGoogleSheets(cycleId.value, gsheetUrl.value, importRoastery.value)

    gsheetUrl.value = ''
    await loadAll()

    let message = `${result.products.length} produktov bolo importovaných z Google Sheets`
    if (result.warnings && result.warnings.length > 0) {
      message += `\n\nUpozornenia:\n${result.warnings.join('\n')}`
    }
    alert(message)
  } catch (e) {
    error.value = e.message
  } finally {
    gsheetLoading.value = false
  }
}

// Image handling
function handleImageSelect(event) {
  const file = event.target.files[0]
  if (file) processImageFile(file)
}

function handleDrop(event) {
  event.preventDefault()
  isDragging.value = false
  const file = event.dataTransfer.files[0]
  if (file && file.type.startsWith('image/')) {
    processImageFile(file)
  }
}

function handleDragOver(event) {
  event.preventDefault()
  isDragging.value = true
}

function handleDragLeave() {
  isDragging.value = false
}

function processImageFile(file) {
  const reader = new FileReader()
  reader.onload = (e) => {
    productForm.value.image = e.target.result
    imagePreview.value = e.target.result
  }
  reader.readAsDataURL(file)
}

function removeImage() {
  productForm.value.image = ''
  imagePreview.value = null
}

// Drag & drop image from external webpage to product row
function handleProductDragOver(event, productId) {
  event.preventDefault()
  dragOverProductId.value = productId
}

function handleProductDragLeave(event, productId) {
  // Only clear if we're actually leaving the element (not entering a child)
  if (!event.currentTarget.contains(event.relatedTarget)) {
    dragOverProductId.value = null
  }
}

async function handleProductDrop(event, productId) {
  event.preventDefault()
  dragOverProductId.value = null

  // Try to get image URL from various drag data types
  let imageUrl = null

  // Check for URL in dataTransfer
  const url = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    imageUrl = url
  }

  // Check for HTML content (img tag)
  const html = event.dataTransfer.getData('text/html')
  if (!imageUrl && html) {
    const match = html.match(/src=["']([^"']+)["']/)
    if (match && match[1]) {
      imageUrl = match[1]
    }
  }

  // Check for files (local file drop)
  if (!imageUrl && event.dataTransfer.files.length > 0) {
    const file = event.dataTransfer.files[0]
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = async (e) => {
        droppingProductId.value = productId
        try {
          await api.updateProduct(productId, { image: e.target.result })
          await loadAll()
        } catch (err) {
          error.value = 'Chyba pri ukladaní obrázku: ' + err.message
        } finally {
          droppingProductId.value = null
        }
      }
      reader.readAsDataURL(file)
      return
    }
  }

  if (!imageUrl) {
    error.value = 'Nepodarilo sa získať URL obrázku. Skúste iný obrázok.'
    return
  }

  // Download image from URL via backend
  droppingProductId.value = productId
  try {
    await api.uploadProductImageFromUrl(productId, imageUrl)
    await loadAll()
  } catch (err) {
    error.value = 'Chyba pri sťahovaní obrázku: ' + err.message
  } finally {
    droppingProductId.value = null
  }
}

// Order actions
async function togglePaid(order) {
  await api.markPaid(order.id, !order.paid)
  await loadAll()
}

// Summary
async function loadSummaryForRoastery(roasteryFilter) {
  summaryRoasteryFilter.value = roasteryFilter
  try {
    summary.value = await api.getCycleSummary(cycleId.value, roasteryFilter || undefined)
  } catch (e) {
    error.value = e.message
  }
}

function copySummary() {
  if (!summary.value) return

  const roasteryLabel = summaryRoasteryFilter.value && summaryRoasteryFilter.value !== '_default'
    ? ` (${summaryRoasteryFilter.value})`
    : summaryRoasteryFilter.value === '_default' ? ' (hlavná pražiareň)' : ''
  let text = `Objednávka - ${cycle.value.name}${roasteryLabel}\n`
  text += '='.repeat(30) + '\n\n'

  // Group items by purpose
  const purposeOrder = ['Espresso', 'Filter', 'Kapsule']
  const grouped = {}

  for (const item of summary.value.items) {
    const purpose = item.purpose || 'Ostatné'
    if (!grouped[purpose]) grouped[purpose] = []
    grouped[purpose].push(item)
  }

  // Output items grouped by purpose
  const sortedPurposes = [...purposeOrder.filter(p => grouped[p]), ...Object.keys(grouped).filter(p => !purposeOrder.includes(p))]

  for (const purpose of sortedPurposes) {
    text += `--- ${purpose} ---\n`
    for (const item of grouped[purpose]) {
      const details = [item.description1, item.roast_type].filter(Boolean).join(', ')
      const nameWithDetails = details ? `${item.name} - ${details}` : item.name
      const variantDisplay = item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant)
      text += `${nameWithDetails} ${variantDisplay}: ${item.total_quantity}x\n`
    }
    text += '\n'
  }

  text += '='.repeat(30) + '\n'
  text += `Celkom položiek: ${summary.value.totalItems}\n`
  text += `Celková suma: ${summary.value.totalPrice.toFixed(2)} EUR\n`

  navigator.clipboard.writeText(text)
  alert('Sumár bol skopírovaný do schránky!')
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

function getStatusVariant(status) {
  switch (status) {
    case 'planned': return 'outline'
    case 'open': return 'default'
    case 'locked': return 'secondary'
    case 'completed': return 'outline'
    default: return 'outline'
  }
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex flex-wrap justify-between items-center gap-2">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="router.push('/admin/dashboard')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <div>
            <div v-if="editingCycleName" class="flex items-center gap-2">
              <input
                v-model="cycleNameEdit"
                @keyup.enter="saveCycleName"
                @keyup.escape="cancelEditingCycleName"
                class="text-xl font-bold bg-primary-foreground/20 text-primary-foreground border border-primary-foreground/30 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary-foreground/50"
                autofocus
              />
              <button @click="saveCycleName" class="text-primary-foreground/70 hover:text-primary-foreground">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
              </button>
              <button @click="cancelEditingCycleName" class="text-primary-foreground/70 hover:text-primary-foreground">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <h1 v-else class="text-xl font-bold flex items-center gap-2 cursor-pointer group" @click="startEditingCycleName">
              {{ cycle?.name || 'Načítavam...' }}
              <svg class="w-4 h-4 text-primary-foreground/50 group-hover:text-primary-foreground transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </h1>
            <Badge v-if="cycle" :variant="getStatusVariant(cycle.status)" class="mt-1 text-primary-foreground bg-primary-foreground/20 border-primary-foreground/30">
              {{ cycle.status === 'planned' ? 'Plánovaný' : cycle.status === 'open' ? 'Otvorený' : cycle.status === 'locked' ? 'Uzamknutý' : 'Dokončený' }}
            </Badge>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button
            v-if="cycle?.status === 'planned'"
            variant="secondary"
            size="sm"
            @click="openPlannedCycle"
            class="bg-green-600 hover:bg-green-700 text-white"
          >
            Otvoriť objednávanie
          </Button>
          <Button
            v-if="cycle?.status === 'open' || cycle?.status === 'locked'"
            variant="secondary"
            size="sm"
            @click="toggleLock"
          >
            {{ cycle?.status === 'locked' ? 'Odomknúť' : 'Uzamknúť' }}
          </Button>
          <Button
            v-if="cycle?.status === 'locked'"
            variant="secondary"
            size="sm"
            @click="markCompleted"
            class="bg-green-600 hover:bg-green-700 text-white"
          >
            Označiť ako dokončený
          </Button>
          <Button
            variant="secondary"
            size="sm"
            @click="router.push(`/admin/cycle/${cycleId}/distribution`)"
          >
            Distribúcia
          </Button>
        </div>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-6">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <template v-else>
        <Tabs v-model="activeTab">
        <TabsList class="mb-6">
          <TabsTrigger value="products">Produkty</TabsTrigger>
          <TabsTrigger value="orders">Objednávky</TabsTrigger>
          <TabsTrigger value="summary">Sumár</TabsTrigger>
        </TabsList>

        <!-- Products Tab -->
        <TabsContent value="products">
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-lg font-semibold">Produkty ({{ products.length }})</h2>
            <Button @click="openProductModal()">
              + Pridať produkt
            </Button>
          </div>

          <!-- Cycle settings -->
          <Card class="mb-4">
            <CardContent class="p-4 space-y-4">
              <!-- Expected date -->
              <div class="space-y-1">
                <Label class="text-sm font-medium">Očakávaný dátum objednávky:</Label>
                <div class="flex items-center gap-2">
                  <Input
                    v-model="expectedDate"
                    type="text"
                    placeholder="napr. 15. februára 2026"
                    class="flex-1"
                    :disabled="expectedDateSaving"
                  />
                  <Button
                    @click="saveExpectedDate"
                    :disabled="expectedDateSaving"
                    size="sm"
                  >
                    {{ expectedDateSaving ? 'Ukladám...' : 'Uložiť' }}
                  </Button>
                </div>
              </div>
              <!-- Plan note -->
              <div class="space-y-2">
                <Label>Plán objednávky</Label>
                <textarea
                  v-model="planNote"
                  placeholder="napr. 1. - 3. máj objednávanie&#10;4. - 5. máj dodávka"
                  rows="4"
                  class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                ></textarea>
                <Button size="sm" @click="savePlanNote" :disabled="planNoteSaving">
                  {{ planNoteSaving ? 'Ukladám...' : 'Uložiť plán' }}
                </Button>
              </div>
              <!-- Markup ratio -->
              <div class="space-y-1">
                <Label class="text-sm font-medium">Prirážka pre priateľov:</Label>
                <div class="flex items-center gap-2">
                  <Input
                    v-model.number="markupPercent"
                    type="number"
                    step="1"
                    min="0"
                    max="100"
                    class="w-20 text-center"
                    :disabled="markupSaving"
                  />
                  <span class="text-muted-foreground">%</span>
                  <Button
                    @click="saveMarkup"
                    :disabled="markupSaving"
                    size="sm"
                  >
                    {{ markupSaving ? 'Ukladám...' : 'Uložiť' }}
                  </Button>
                  <span v-if="cycle?.markup_ratio && cycle.markup_ratio !== 1.0" class="text-sm text-muted-foreground">
                    (cena × {{ cycle.markup_ratio.toFixed(2) }})
                  </span>
                </div>
              </div>
              <!-- Parcel delivery -->
              <div class="space-y-1">
                <Label class="text-sm font-medium">Doručenie Packetou:</Label>
                <div class="flex items-center gap-2">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" v-model="parcelEnabled" class="rounded" :disabled="parcelSaving" />
                    <span class="text-sm">Povoliť</span>
                  </label>
                  <template v-if="parcelEnabled">
                    <Input
                      v-model.number="parcelFee"
                      type="number"
                      step="0.5"
                      min="0"
                      class="w-24 text-center"
                      :disabled="parcelSaving"
                      placeholder="Cena"
                    />
                    <span class="text-muted-foreground">EUR</span>
                  </template>
                  <Button
                    @click="saveParcel"
                    :disabled="parcelSaving"
                    size="sm"
                  >
                    {{ parcelSaving ? 'Ukladám...' : 'Uložiť' }}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <!-- Import section (coffee only) -->
          <Card v-if="!isBakery" class="mb-4">
            <CardContent class="p-4">
              <h3 class="text-sm font-medium text-foreground mb-3">Import produktov</h3>
              <!-- Roastery selector for import -->
              <div v-if="roasteries.length > 0" class="mb-3">
                <Label class="text-xs text-muted-foreground mb-1">Pražiareň pre importované produkty</Label>
                <select v-model="importRoastery" class="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                  <option value="">— Žiadna —</option>
                  <option v-for="r in roasteries" :key="r.id" :value="r.name">{{ r.name }}</option>
                </select>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <!-- Google Sheets import -->
                <div>
                  <Label class="text-xs text-muted-foreground mb-1">Z Google Sheets (verejný sheet)</Label>
                  <!-- Format selector -->
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
                    <Input
                      v-model="gsheetUrl"
                      placeholder="https://docs.google.com/spreadsheets/d/..."
                      :disabled="gsheetLoading"
                      class="text-sm"
                    />
                    <Button
                      @click="importGoogleSheets"
                      :disabled="!gsheetUrl.trim() || gsheetLoading"
                      class="whitespace-nowrap"
                    >
                      {{ gsheetLoading ? 'Importujem...' : 'Importovať' }}
                    </Button>
                  </div>
                </div>
                <!-- CSV import -->
                <div>
                  <Label class="text-xs text-muted-foreground mb-1">Z CSV súboru</Label>
                  <div class="flex gap-2">
                    <input type="file" accept=".csv" @change="onFileChange" class="flex-1 text-sm" />
                    <Button
                      v-if="csvFile"
                      @click="importCSV"
                      class="whitespace-nowrap"
                    >
                      Importovať
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-16">Foto</TableHead>
                  <TableHead>Názov</TableHead>
                  <template v-if="isBakery">
                    <TableHead>Kategória</TableHead>
                    <TableHead>Praženie</TableHead>
                    <TableHead class="text-right">Hmotnosť</TableHead>
                    <TableHead class="text-right">Cena/ks</TableHead>
                    <TableHead>Zloženie</TableHead>
                  </template>
                  <template v-else>
                    <TableHead>Chutový profil</TableHead>
                    <TableHead>Praženie</TableHead>
                    <TableHead>Účel</TableHead>
                    <TableHead class="text-right">150g</TableHead>
                    <TableHead class="text-right">200g</TableHead>
                    <TableHead class="text-right">250g</TableHead>
                    <TableHead class="text-right">500g</TableHead>
                    <TableHead class="text-right">1kg</TableHead>
                    <TableHead class="text-right">20ks×5g</TableHead>
                  </template>
                  <TableHead class="text-right">Akcie</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow
                  v-for="product in products"
                  :key="product.id"
                  :class="[
                    'transition-all duration-150',
                    dragOverProductId === product.id ? 'bg-accent ring-2 ring-primary ring-inset' : '',
                    droppingProductId === product.id ? 'opacity-50' : ''
                  ]"
                  @dragover="handleProductDragOver($event, product.id)"
                  @dragleave="handleProductDragLeave($event, product.id)"
                  @drop="handleProductDrop($event, product.id)"
                >
                  <TableCell>
                    <div :class="[
                      'w-12 h-12 rounded overflow-hidden flex items-center justify-center transition-all',
                      dragOverProductId === product.id ? 'ring-2 ring-primary bg-accent' : 'bg-muted'
                    ]">
                      <div v-if="droppingProductId === product.id" class="animate-pulse">
                        <svg class="w-6 h-6 text-primary animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      </div>
                      <img v-else-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                      <svg v-else class="w-6 h-6 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div class="flex items-center gap-2">
                      <span class="font-medium">{{ product.name }}</span>
                      <span v-if="product.roastery" class="text-xs bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">{{ product.roastery }}</span>
                      <span v-if="product.stock_limit_g" class="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">max {{ product.stock_limit_g >= 1000 ? (product.stock_limit_g / 1000) + ' kg' : product.stock_limit_g + 'g' }}</span>
                    </div>
                    <div v-if="product.description1" class="text-sm text-muted-foreground">{{ product.description1 }}</div>
                  </TableCell>
                  <template v-if="isBakery">
                    <TableCell class="text-sm">{{ product.purpose || '-' }}</TableCell>
                    <TableCell class="text-sm">{{ product.roast_type || '-' }}</TableCell>
                    <TableCell class="text-sm text-right">{{ product.weight_grams ? `${product.weight_grams}g` : '-' }}</TableCell>
                    <TableCell class="text-sm text-right">{{ formatPrice(product.price_unit) }}</TableCell>
                    <TableCell class="text-sm text-muted-foreground max-w-xs">
                      <span v-if="product.composition" class="line-clamp-1">{{ product.composition }}</span>
                      <span v-else>-</span>
                    </TableCell>
                  </template>
                  <template v-else>
                    <TableCell class="text-sm text-muted-foreground max-w-xs">
                      <span v-if="product.description2" class="line-clamp-2">{{ product.description2 }}</span>
                      <span v-else class="text-muted-foreground/50">-</span>
                    </TableCell>
                    <TableCell class="text-sm">{{ product.roast_type || '-' }}</TableCell>
                    <TableCell class="text-sm">{{ product.purpose || '-' }}</TableCell>
                    <TableCell class="text-sm text-right">{{ formatPrice(product.price_150g) }}</TableCell>
                    <TableCell class="text-sm text-right">{{ formatPrice(product.price_200g) }}</TableCell>
                    <TableCell class="text-sm text-right">{{ formatPrice(product.price_250g) }}</TableCell>
                    <TableCell class="text-sm text-right">{{ formatPrice(product.price_500g) }}</TableCell>
                    <TableCell class="text-sm text-right">{{ formatPrice(product.price_1kg) }}</TableCell>
                    <TableCell class="text-sm text-right">{{ formatPrice(product.price_20pc5g) }}</TableCell>
                  </template>
                  <TableCell class="text-right">
                    <Button variant="ghost" size="sm" @click="openProductModal(product)">Upraviť</Button>
                    <Button variant="ghost" size="sm" @click="duplicateProduct(product)" title="Duplikovať">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                    </Button>
                    <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="deleteProduct(product.id)">Vymazať</Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <!-- Orders Tab -->
        <TabsContent value="orders">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold">Objednávky ({{ submittedOrders.length }})</h2>
            <div v-if="submittedOrders.length > 0" class="flex gap-1 bg-muted rounded-lg p-1">
              <button
                @click="ordersView = 'friend'"
                :class="['px-3 py-1 text-sm rounded-md transition-colors', ordersView === 'friend' ? 'bg-background shadow font-medium' : 'text-muted-foreground hover:text-foreground']"
              >
                Podľa priateľa
              </button>
              <button
                @click="ordersView = 'product'"
                :class="['px-3 py-1 text-sm rounded-md transition-colors', ordersView === 'product' ? 'bg-background shadow font-medium' : 'text-muted-foreground hover:text-foreground']"
              >
                Podľa produktu
              </button>
            </div>
          </div>

          <div v-if="orders.length === 0" class="text-center py-12 text-muted-foreground">
            Zatiaľ žiadne objednávky
          </div>

          <!-- Product view -->
          <Card v-else-if="ordersView === 'product'">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10"></TableHead>
                  <TableHead>Produkt</TableHead>
                  <TableHead class="text-center">Ks</TableHead>
                  <TableHead class="text-right">Suma</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <template v-for="product in ordersByProduct" :key="product.key">
                  <TableRow class="cursor-pointer hover:bg-muted/50" @click="toggleExpandProduct(product.key)">
                    <TableCell class="p-2">
                      <button class="w-8 h-8 flex items-center justify-center rounded hover:bg-muted transition-colors">
                        <svg
                          class="w-4 h-4 transition-transform"
                          :class="{ 'rotate-90': expandedProducts.has(product.key) }"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </TableCell>
                    <TableCell>
                      <div class="flex items-center gap-2">
                        <Badge
                          v-if="product.purpose"
                          variant="outline"
                          :class="{
                            'border-stone-400 text-stone-600 bg-stone-50': product.purpose === 'Espresso',
                            'border-sky-400 text-sky-600 bg-sky-50': product.purpose === 'Filter',
                            'border-amber-400 text-amber-600 bg-amber-50': product.purpose === 'Kapsule' || product.purpose === 'Slané',
                            'border-pink-400 text-pink-600 bg-pink-50': product.purpose === 'Sladké'
                          }"
                          class="text-xs"
                        >
                          {{ product.purpose }}
                        </Badge>
                        <span class="font-medium">{{ product.product_name }}</span>
                        <span class="text-xs text-muted-foreground">({{ product.variant_label ? product.variant_label : (product.variant === 'unit' ? 'ks' : product.variant) }})</span>
                      </div>
                    </TableCell>
                    <TableCell class="text-center font-medium">{{ product.total_quantity }}</TableCell>
                    <TableCell class="text-right">{{ formatPrice(product.total_price) }}</TableCell>
                  </TableRow>
                  <!-- Expanded friends list -->
                  <template v-if="expandedProducts.has(product.key)">
                    <TableRow v-for="(f, i) in product.friends" :key="`${product.key}-${i}`" class="bg-muted/30">
                      <TableCell></TableCell>
                      <TableCell class="text-sm text-muted-foreground">{{ f.friend_name }}</TableCell>
                      <TableCell class="text-center text-sm text-muted-foreground">{{ f.quantity }}</TableCell>
                      <TableCell class="text-right text-sm text-muted-foreground">{{ formatPrice(f.price) }}</TableCell>
                    </TableRow>
                  </template>
                </template>
              </TableBody>
              <tfoot>
                <TableRow class="font-semibold bg-muted">
                  <TableCell></TableCell>
                  <TableCell>Celkom</TableCell>
                  <TableCell class="text-center">{{ ordersByProduct.reduce((s, p) => s + p.total_quantity, 0) }}</TableCell>
                  <TableCell class="text-right">{{ formatPrice(orderTotals.total) }}</TableCell>
                </TableRow>
              </tfoot>
            </Table>
          </Card>

          <!-- Friend view -->
          <Card v-else>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10"></TableHead>
                  <TableHead>Priateľ</TableHead>
                  <TableHead class="text-right">Zostatok</TableHead>
                  <template v-if="isBakery">
                    <TableHead class="text-center">Ks</TableHead>
                  </template>
                  <template v-else>
                    <TableHead
                      v-for="col in visibleVariantColumns"
                      :key="col.label"
                      class="text-center"
                    >{{ col.label }}</TableHead>
                  </template>
                  <TableHead>Status</TableHead>
                  <TableHead class="text-right">Suma</TableHead>
                  <TableHead class="text-center">Zaplatené</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <template v-for="order in submittedOrders" :key="order.id || order.friend_id">
                  <TableRow>
                    <TableCell class="p-2">
                      <button
                        v-if="order.status !== 'none'"
                        @click="toggleExpand(order.id)"
                        class="w-8 h-8 flex items-center justify-center rounded hover:bg-muted transition-colors"
                      >
                        <svg
                          class="w-4 h-4 transition-transform"
                          :class="{ 'rotate-90': expandedOrders.has(order.id) }"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </TableCell>
                    <TableCell class="font-medium">{{ order.friend_name }}</TableCell>
                    <TableCell class="text-right">
                      <BalanceBadge :balance="order.friend_balance || 0" />
                    </TableCell>
                    <template v-if="isBakery">
                      <TableCell class="text-center">{{ order.count_unit || 0 }}</TableCell>
                    </template>
                    <template v-else>
                      <TableCell
                        v-for="col in visibleVariantColumns"
                        :key="col.label"
                        class="text-center"
                      >{{ order[col.countField] || 0 }}</TableCell>
                    </template>
                    <TableCell>
                      <div class="flex flex-wrap gap-1">
                        <Badge
                          :variant="order.status === 'submitted' ? 'default' : order.status === 'none' ? 'outline' : 'secondary'"
                          :class="order.status === 'none' ? 'text-muted-foreground' : ''"
                        >
                          {{ order.status === 'submitted' ? 'Odoslane' : order.status === 'none' ? 'Neobjednane' : 'Rozpracovane' }}
                        </Badge>
                        <Badge
                          v-if="order.pickup_location_name"
                          variant="outline"
                          class="border-blue-400 text-blue-600 bg-blue-50"
                        >
                          {{ order.pickup_location_name }}
                        </Badge>
                        <Badge
                          v-else-if="order.pickup_location_note"
                          variant="outline"
                          class="border-gray-400 text-gray-600 bg-gray-50"
                        >
                          {{ order.pickup_location_note }}
                        </Badge>
                        <Badge
                          v-if="order.packeta_address"
                          variant="outline"
                          class="border-red-400 text-red-600 bg-red-50"
                        >
                          Packeta
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell class="text-right">
                      {{ formatPrice((order.total || 0) + (order.delivery_fee || 0)) }}
                      <div v-if="order.delivery_fee" class="text-xs text-muted-foreground">
                        ({{ formatPrice(order.total) }} + {{ formatPrice(order.delivery_fee) }} doručenie)
                      </div>
                    </TableCell>
                    <TableCell class="text-center">
                      <button
                        v-if="order.status !== 'none'"
                        @click="togglePaid(order)"
                        :class="['w-6 h-6 rounded border-2 flex items-center justify-center mx-auto', order.paid ? 'bg-green-500 border-green-500 text-white' : 'border-border']"
                      >
                        <svg v-if="order.paid" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                      <span v-else class="text-muted-foreground">-</span>
                    </TableCell>
                  </TableRow>
                  <!-- Expanded items row -->
                  <TableRow v-if="order.status !== 'none' && expandedOrders.has(order.id)">
                    <TableCell :colspan="6 + (isBakery ? 1 : visibleVariantColumns.length)" class="bg-muted/50 p-4">
                      <div v-if="order.items && order.items.length > 0" class="space-y-1">
                        <div v-for="item in order.items" :key="`${item.product_id}-${item.variant}`" class="flex justify-between py-1 text-sm">
                          <span>
                            <Badge
                              v-if="item.purpose"
                              variant="outline"
                              :class="{
                                'border-stone-400 text-stone-600 bg-stone-50': item.purpose === 'Espresso',
                                'border-sky-400 text-sky-600 bg-sky-50': item.purpose === 'Filter',
                                'border-amber-400 text-amber-600 bg-amber-50': item.purpose === 'Kapsule' || item.purpose === 'Slané',
                                'border-pink-400 text-pink-600 bg-pink-50': item.purpose === 'Sladké'
                              }"
                              class="mr-2 text-xs"
                            >
                              {{ item.purpose }}
                            </Badge>
                            {{ item.product_name }} ({{ item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant) }})
                          </span>
                          <span class="text-muted-foreground">{{ item.quantity }}x - {{ formatPrice(item.price * item.quantity) }}</span>
                        </div>
                      </div>
                      <div v-else class="text-sm text-muted-foreground">Žiadne položky</div>
                    </TableCell>
                  </TableRow>
                </template>
              </TableBody>
              <tfoot>
                <TableRow class="font-semibold bg-muted">
                  <TableCell></TableCell>
                  <TableCell>Celkom</TableCell>
                  <TableCell></TableCell>
                  <template v-if="isBakery">
                    <TableCell class="text-center">{{ orderTotals.count_unit }}</TableCell>
                  </template>
                  <template v-else>
                    <TableCell
                      v-for="col in visibleVariantColumns"
                      :key="col.label"
                      class="text-center"
                    >{{ orderTotals[col.countField] }}</TableCell>
                  </template>
                  <TableCell></TableCell>
                  <TableCell class="text-right">{{ formatPrice(orderTotals.total) }}</TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </tfoot>
            </Table>
          </Card>
        </TabsContent>

        <!-- Summary Tab -->
        <TabsContent value="summary">
          <div class="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 mb-4">
            <h2 class="text-lg font-semibold">Sumár objednávky</h2>
            <Button size="sm" @click="copySummary" class="self-start sm:self-auto">
              Kopírovať do schranky
            </Button>
          </div>

          <!-- Roastery filter -->
          <div v-if="summary?.roasteries?.length > 0" class="flex gap-2 mb-4 flex-wrap">
            <Button
              size="sm"
              :variant="summaryRoasteryFilter === '' ? 'default' : 'outline'"
              @click="loadSummaryForRoastery('')"
            >Všetky</Button>
            <Button
              size="sm"
              :variant="summaryRoasteryFilter === '_default' ? 'default' : 'outline'"
              @click="loadSummaryForRoastery('_default')"
            >Hlavná pražiareň</Button>
            <Button
              v-for="r in summary.roasteries"
              :key="r"
              size="sm"
              :variant="summaryRoasteryFilter === r ? 'default' : 'outline'"
              @click="loadSummaryForRoastery(r)"
            >{{ r }}</Button>
          </div>

          <Card>
            <CardContent class="p-3 sm:p-6">
              <div v-if="summary?.items.length === 0" class="text-center text-muted-foreground py-8">
                Zatiaľ žiadne objednávky
              </div>
              <div v-else>
                <div class="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Účel</TableHead>
                        <TableHead>Produkt</TableHead>
                        <TableHead>Varianta</TableHead>
                        <TableHead class="text-right">Počet</TableHead>
                        <TableHead class="text-right">Suma</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow v-for="(item, i) in summary.items" :key="i">
                        <TableCell>
                          <Badge
                            v-if="item.purpose"
                            variant="outline"
                            :class="{
                              'border-stone-400 text-stone-600 bg-stone-50': item.purpose === 'Espresso',
                              'border-sky-400 text-sky-600 bg-sky-50': item.purpose === 'Filter',
                              'border-amber-400 text-amber-600 bg-amber-50': item.purpose === 'Kapsule' || item.purpose === 'Slané',
                                  'border-pink-400 text-pink-600 bg-pink-50': item.purpose === 'Sladké'
                            }"
                          >
                            {{ item.purpose }}
                          </Badge>
                          <span v-else class="text-muted-foreground">-</span>
                        </TableCell>
                        <TableCell>{{ item.name }}<span v-if="item.description1 || item.roast_type" class="text-muted-foreground"> - {{ [item.description1, item.roast_type].filter(Boolean).join(', ') }}</span></TableCell>
                        <TableCell>{{ item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant) }}</TableCell>
                        <TableCell class="text-right">{{ item.total_quantity }}x</TableCell>
                        <TableCell class="text-right">{{ formatPrice(item.total_price) }}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>

                <div class="md:hidden divide-y">
                  <div v-for="(item, i) in summary.items" :key="i" class="py-3 first:pt-0 last:pb-0">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span
                            v-if="item.purpose"
                            class="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                            :class="{
                              'bg-stone-500': item.purpose === 'Espresso',
                              'bg-sky-500': item.purpose === 'Filter',
                              'bg-amber-500': item.purpose === 'Kapsule' || item.purpose === 'Slané',
                              'bg-pink-500': item.purpose === 'Sladké'
                            }"
                            :title="item.purpose"
                          ></span>
                          <span class="font-medium text-sm">{{ item.name }}</span>
                        </div>
                        <div v-if="item.description1 || item.roast_type" class="text-xs text-muted-foreground mt-0.5">
                          {{ [item.description1, item.roast_type].filter(Boolean).join(', ') }}
                        </div>
                        <div class="text-xs text-muted-foreground mt-1">
                          {{ item.total_quantity }}× {{ item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant) }}
                        </div>
                      </div>
                      <div class="text-sm font-semibold whitespace-nowrap">{{ formatPrice(item.total_price) }}</div>
                    </div>
                  </div>
                </div>

                <div class="border-t pt-4 mt-4 flex flex-col sm:flex-row sm:justify-between gap-1 text-base sm:text-lg font-semibold">
                  <span>Celkom položiek: {{ summary.totalItems }}</span>
                  <span>Celková suma: {{ formatPrice(summary.totalPrice) }}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        </Tabs>
      </template>
    </main>

    <!-- Product Modal -->
    <Dialog :open="showProductModal" @update:open="showProductModal = $event">
      <DialogContent class="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ editingProduct ? 'Upraviť produkt' : 'Nový produkt' }}</DialogTitle>
        </DialogHeader>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 py-4">
          <!-- Left column - Image -->
          <div>
            <Label class="mb-2">Fotografia produktu</Label>
            <div
              @drop="handleDrop"
              @dragover="handleDragOver"
              @dragleave="handleDragLeave"
              :class="[
                'border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer',
                isDragging ? 'border-primary bg-accent' : 'border-border hover:border-muted-foreground'
              ]"
              @click="$refs.imageInput.click()"
            >
              <input
                ref="imageInput"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                @change="handleImageSelect"
                class="hidden"
              />

              <div v-if="imagePreview" class="relative">
                <img :src="imagePreview" class="max-h-48 mx-auto rounded" />
                <button
                  @click.stop="removeImage"
                  class="absolute top-2 right-2 bg-destructive text-destructive-foreground rounded-full w-6 h-6 flex items-center justify-center hover:bg-destructive/90"
                >
                  &times;
                </button>
              </div>
              <div v-else class="py-8">
                <svg class="w-12 h-12 mx-auto text-muted-foreground mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p class="text-sm text-muted-foreground">Kliknite alebo preťahnite obrázok</p>
                <p class="text-xs text-muted-foreground/70 mt-1">JPG, PNG, max 5MB</p>
              </div>
            </div>
          </div>

          <!-- Right column - Fields -->
          <div class="space-y-3">
            <div class="space-y-1">
              <Label>Názov *</Label>
              <Input v-model="productForm.name" />
            </div>
            <div class="space-y-1">
              <Label>Popis (podnadpis)</Label>
              <Input v-model="productForm.description1" />
            </div>
            <div class="space-y-1">
              <Label>Chutový profil</Label>
              <textarea v-model="productForm.description2" rows="2" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"></textarea>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1">
                <Label>Praženie</Label>
                <Input v-model="productForm.roast_type" />
              </div>
              <div class="space-y-1">
                <Label>Účel</Label>
                <Input v-model="productForm.purpose" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1">
                <Label>Pražiareň</Label>
                <select v-model="productForm.roastery" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                  <option value="">— Žiadna —</option>
                  <option v-for="r in roasteries" :key="r.id" :value="r.name">{{ r.name }}</option>
                </select>
              </div>
              <div class="space-y-1">
                <Label>Limit zásob (g)</Label>
                <Input v-model="productForm.stock_limit_g" type="number" placeholder="Napr. 1000 = max 1 kg" />
              </div>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <div class="space-y-1">
                <Label>150g (EUR)</Label>
                <Input v-model="productForm.price_150g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>200g (EUR)</Label>
                <Input v-model="productForm.price_200g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>250g (EUR)</Label>
                <Input v-model="productForm.price_250g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>500g (EUR)</Label>
                <Input v-model="productForm.price_500g" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>1kg (EUR)</Label>
                <Input v-model="productForm.price_1kg" type="number" step="0.01" />
              </div>
              <div class="space-y-1">
                <Label>20ks×5g (EUR)</Label>
                <Input v-model="productForm.price_20pc5g" type="number" step="0.01" />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="showProductModal = false">Zrušiť</Button>
          <Button @click="saveProduct">Uložiť</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

  </div>
</template>
