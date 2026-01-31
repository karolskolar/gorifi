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
  name: '', description1: '', description2: '', roast_type: '', purpose: '', price_150g: '', price_200g: '', price_250g: '', price_1kg: '', price_20pc5g: '', image: ''
})
const imagePreview = ref(null)
const isDragging = ref(false)

// Drag & drop for product list
const dragOverProductId = ref(null)
const droppingProductId = ref(null)

// CSV import
const csvFile = ref(null)

// Google Sheets import
const gsheetUrl = ref('')
const gsheetLoading = ref(false)
const gsheetFormat = ref('multirow')  // 'simple' or 'multirow'


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

const orderTotals = computed(() => ({
  count_150g: orders.value.reduce((sum, o) => sum + (o.count_150g || 0), 0),
  count_200g: orders.value.reduce((sum, o) => sum + (o.count_200g || 0), 0),
  count_250g: orders.value.reduce((sum, o) => sum + (o.count_250g || 0), 0),
  count_1kg: orders.value.reduce((sum, o) => sum + (o.count_1kg || 0), 0),
  count_20pc5g: orders.value.reduce((sum, o) => sum + (o.count_20pc5g || 0), 0),
  total: orders.value.reduce((sum, o) => sum + (o.total || 0), 0)
}))

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
    const [cycleData, productsData, ordersData, summaryData] = await Promise.all([
      api.getCycle(cycleId.value),
      api.getProducts(cycleId.value),
      api.getOrders(cycleId.value),
      api.getCycleSummary(cycleId.value)
    ])
    cycle.value = cycleData
    products.value = productsData
    orders.value = ordersData
    summary.value = summaryData
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


// Product actions
function openProductModal(product = null) {
  editingProduct.value = product
  if (product) {
    productForm.value = {
      ...product,
      price_150g: product.price_150g || '',
      price_200g: product.price_200g || '',
      price_250g: product.price_250g || '',
      price_1kg: product.price_1kg || '',
      price_20pc5g: product.price_20pc5g || '',
      image: product.image || ''
    }
    imagePreview.value = product.image || null
  } else {
    productForm.value = { name: '', description1: '', description2: '', roast_type: '', purpose: '', price_150g: '', price_200g: '', price_250g: '', price_1kg: '', price_20pc5g: '', image: '' }
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
    price_1kg: productForm.value.price_1kg ? parseFloat(productForm.value.price_1kg) : null,
    price_20pc5g: productForm.value.price_20pc5g ? parseFloat(productForm.value.price_20pc5g) : null,
    image: productForm.value.image || null
  }

  if (editingProduct.value) {
    await api.updateProduct(editingProduct.value.id, data)
  } else {
    await api.createProduct(data)
  }

  showProductModal.value = false
  await loadAll()
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
      ? await api.importFromGoogleSheetsMultirow(cycleId.value, gsheetUrl.value)
      : await api.importFromGoogleSheets(cycleId.value, gsheetUrl.value)

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
function copySummary() {
  if (!summary.value) return

  let text = `Objednávka - ${cycle.value.name}\n`
  text += '='.repeat(30) + '\n\n'

  for (const item of summary.value.items) {
    text += `${item.name} ${item.variant}: ${item.total_quantity}x\n`
  }

  text += '\n' + '='.repeat(30) + '\n'
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
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
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
              {{ cycle.status === 'open' ? 'Otvorený' : cycle.status === 'locked' ? 'Uzamknutý' : 'Dokončený' }}
            </Badge>
          </div>
        </div>
        <div class="flex gap-2">
          <Button
            v-if="cycle?.status !== 'completed'"
            variant="secondary"
            @click="toggleLock"
          >
            {{ cycle?.status === 'locked' ? 'Odomknúť' : 'Uzamknúť' }}
          </Button>
          <Button
            v-if="cycle?.status === 'locked'"
            variant="secondary"
            @click="markCompleted"
            class="bg-green-600 hover:bg-green-700 text-white"
          >
            Označiť ako dokončený
          </Button>
          <Button
            variant="secondary"
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

          <!-- Import section -->
          <Card class="mb-4">
            <CardContent class="p-4">
              <h3 class="text-sm font-medium text-foreground mb-3">Import produktov</h3>
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
                  <TableHead>Chutový profil</TableHead>
                  <TableHead>Praženie</TableHead>
                  <TableHead>Účel</TableHead>
                  <TableHead class="text-right">150g</TableHead>
                  <TableHead class="text-right">200g</TableHead>
                  <TableHead class="text-right">250g</TableHead>
                  <TableHead class="text-right">1kg</TableHead>
                  <TableHead class="text-right">20ks×5g</TableHead>
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
                    <div class="font-medium">{{ product.name }}</div>
                    <div v-if="product.description1" class="text-sm text-muted-foreground">{{ product.description1 }}</div>
                  </TableCell>
                  <TableCell class="text-sm text-muted-foreground max-w-xs">
                    <span v-if="product.description2" class="line-clamp-2">{{ product.description2 }}</span>
                    <span v-else class="text-muted-foreground/50">-</span>
                  </TableCell>
                  <TableCell class="text-sm">{{ product.roast_type || '-' }}</TableCell>
                  <TableCell class="text-sm">{{ product.purpose || '-' }}</TableCell>
                  <TableCell class="text-sm text-right">{{ formatPrice(product.price_150g) }}</TableCell>
                  <TableCell class="text-sm text-right">{{ formatPrice(product.price_200g) }}</TableCell>
                  <TableCell class="text-sm text-right">{{ formatPrice(product.price_250g) }}</TableCell>
                  <TableCell class="text-sm text-right">{{ formatPrice(product.price_1kg) }}</TableCell>
                  <TableCell class="text-sm text-right">{{ formatPrice(product.price_20pc5g) }}</TableCell>
                  <TableCell class="text-right">
                    <Button variant="ghost" size="sm" @click="openProductModal(product)">Upraviť</Button>
                    <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="deleteProduct(product.id)">Vymazať</Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <!-- Orders Tab -->
        <TabsContent value="orders">
          <h2 class="text-lg font-semibold mb-4">Objednávky ({{ orders.length }})</h2>

          <div v-if="orders.length === 0" class="text-center py-12 text-muted-foreground">
            Zatiaľ žiadne objednávky
          </div>

          <Card v-else>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10"></TableHead>
                  <TableHead>Priateľ</TableHead>
                  <TableHead class="text-right">Zostatok</TableHead>
                  <TableHead class="text-center">150g</TableHead>
                  <TableHead class="text-center">200g</TableHead>
                  <TableHead class="text-center">250g</TableHead>
                  <TableHead class="text-center">1kg</TableHead>
                  <TableHead class="text-center">20ks</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead class="text-right">Suma</TableHead>
                  <TableHead class="text-center">Zaplatené</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <template v-for="order in orders" :key="order.id">
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
                    <TableCell class="text-center">{{ order.count_150g || 0 }}</TableCell>
                    <TableCell class="text-center">{{ order.count_200g || 0 }}</TableCell>
                    <TableCell class="text-center">{{ order.count_250g || 0 }}</TableCell>
                    <TableCell class="text-center">{{ order.count_1kg || 0 }}</TableCell>
                    <TableCell class="text-center">{{ order.count_20pc5g || 0 }}</TableCell>
                    <TableCell>
                      <Badge
                        :variant="order.status === 'submitted' ? 'default' : order.status === 'none' ? 'outline' : 'secondary'"
                        :class="order.status === 'none' ? 'text-muted-foreground' : ''"
                      >
                        {{ order.status === 'submitted' ? 'Odoslane' : order.status === 'none' ? 'Neobjednane' : 'Rozpracovane' }}
                      </Badge>
                    </TableCell>
                    <TableCell class="text-right">{{ formatPrice(order.total) }}</TableCell>
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
                    <TableCell colspan="11" class="bg-muted/50 p-4">
                      <div v-if="order.items && order.items.length > 0" class="space-y-1">
                        <div v-for="item in order.items" :key="`${item.product_id}-${item.variant}`" class="flex justify-between py-1 text-sm">
                          <span>{{ item.product_name }} ({{ item.variant }})</span>
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
                  <TableCell class="text-center">{{ orderTotals.count_150g }}</TableCell>
                  <TableCell class="text-center">{{ orderTotals.count_200g }}</TableCell>
                  <TableCell class="text-center">{{ orderTotals.count_250g }}</TableCell>
                  <TableCell class="text-center">{{ orderTotals.count_1kg }}</TableCell>
                  <TableCell class="text-center">{{ orderTotals.count_20pc5g }}</TableCell>
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
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-lg font-semibold">Sumár objednávky</h2>
            <Button @click="copySummary">
              Kopírovať do schranky
            </Button>
          </div>

          <Card>
            <CardContent class="p-6">
              <div v-if="summary?.items.length === 0" class="text-center text-muted-foreground py-8">
                Zatiaľ žiadne objednávky
              </div>
              <div v-else>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produkt</TableHead>
                      <TableHead>Varianta</TableHead>
                      <TableHead class="text-right">Počet</TableHead>
                      <TableHead class="text-right">Suma</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow v-for="(item, i) in summary.items" :key="i">
                      <TableCell>{{ item.name }}</TableCell>
                      <TableCell>{{ item.variant }}</TableCell>
                      <TableCell class="text-right">{{ item.total_quantity }}x</TableCell>
                      <TableCell class="text-right">{{ formatPrice(item.total_price) }}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>

                <div class="border-t pt-4 mt-4 flex justify-between text-lg font-semibold">
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
            <div class="grid grid-cols-5 gap-3">
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
