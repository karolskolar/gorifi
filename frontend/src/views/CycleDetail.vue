<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'

const route = useRoute()
const router = useRouter()

const cycle = ref(null)
const products = ref([])
const friends = ref([])
const orders = ref([])
const summary = ref(null)

const loading = ref(true)
const activeTab = ref('products')
const error = ref('')

// Product modal
const showProductModal = ref(false)
const editingProduct = ref(null)
const productForm = ref({
  name: '', description1: '', description2: '', roast_type: '', purpose: '', price_250g: '', price_1kg: '', image: ''
})
const imagePreview = ref(null)
const isDragging = ref(false)

// Drag & drop for product list
const dragOverProductId = ref(null)
const droppingProductId = ref(null)

// Friend modal
const showFriendModal = ref(false)
const newFriendName = ref('')

// CSV import
const csvFile = ref(null)

// Google Sheets import
const gsheetUrl = ref('')
const gsheetLoading = ref(false)
const gsheetFormat = ref('multirow')  // 'simple' or 'multirow'

// Password settings
const sharedPassword = ref('')
const passwordSaving = ref(false)
const passwordMessage = ref('')

const cycleId = computed(() => route.params.id)
const baseUrl = computed(() => window.location.origin)
const sharedOrderLink = computed(() => `${baseUrl.value}/order/${cycleId.value}`)

onMounted(async () => {
  await loadAll()
})

async function loadAll() {
  loading.value = true
  try {
    const [cycleData, productsData, friendsData, ordersData, summaryData] = await Promise.all([
      api.getCycle(cycleId.value),
      api.getProducts(cycleId.value),
      api.getFriends(cycleId.value),
      api.getOrders(cycleId.value),
      api.getCycleSummary(cycleId.value)
    ])
    cycle.value = cycleData
    products.value = productsData
    friends.value = friendsData
    orders.value = ordersData
    summary.value = summaryData
    sharedPassword.value = cycleData.shared_password || ''
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

async function savePassword() {
  passwordSaving.value = true
  passwordMessage.value = ''
  try {
    await api.updateCycle(cycleId.value, { shared_password: sharedPassword.value || null })
    passwordMessage.value = 'Heslo bolo ulozene'
    setTimeout(() => { passwordMessage.value = '' }, 3000)
  } catch (e) {
    error.value = e.message
  } finally {
    passwordSaving.value = false
  }
}

function copySharedLink() {
  navigator.clipboard.writeText(sharedOrderLink.value)
  alert('Odkaz bol skopirovany!')
}

// Product actions
function openProductModal(product = null) {
  editingProduct.value = product
  if (product) {
    productForm.value = {
      ...product,
      price_250g: product.price_250g || '',
      price_1kg: product.price_1kg || '',
      image: product.image || ''
    }
    imagePreview.value = product.image || null
  } else {
    productForm.value = { name: '', description1: '', description2: '', roast_type: '', purpose: '', price_250g: '', price_1kg: '', image: '' }
    imagePreview.value = null
  }
  showProductModal.value = true
}

async function saveProduct() {
  const data = {
    ...productForm.value,
    cycle_id: cycleId.value,
    price_250g: productForm.value.price_250g ? parseFloat(productForm.value.price_250g) : null,
    price_1kg: productForm.value.price_1kg ? parseFloat(productForm.value.price_1kg) : null,
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
  if (!confirm('Naozaj vymazat tento produkt?')) return
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

    let message = `${result.products.length} produktov bolo importovanych z Google Sheets`
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
          error.value = 'Chyba pri ukladani obrazku: ' + err.message
        } finally {
          droppingProductId.value = null
        }
      }
      reader.readAsDataURL(file)
      return
    }
  }

  if (!imageUrl) {
    error.value = 'Nepodarilo sa ziskat URL obrazku. Skuste iny obrazok.'
    return
  }

  // Download image from URL via backend
  droppingProductId.value = productId
  try {
    await api.uploadProductImageFromUrl(productId, imageUrl)
    await loadAll()
  } catch (err) {
    error.value = 'Chyba pri stahivani obrazku: ' + err.message
  } finally {
    droppingProductId.value = null
  }
}

// Friend actions
async function addFriend() {
  if (!newFriendName.value.trim()) return
  await api.createFriend({ cycle_id: cycleId.value, name: newFriendName.value })
  newFriendName.value = ''
  showFriendModal.value = false
  await loadAll()
}

async function deleteFriend(id) {
  if (!confirm('Naozaj vymazat tohto priatela a jeho objednavku?')) return
  await api.deleteFriend(id)
  await loadAll()
}

// Order actions
async function togglePaid(order) {
  await api.markPaid(order.order_id, !order.paid)
  await loadAll()
}

// Summary
function copySummary() {
  if (!summary.value) return

  let text = `Objednavka - ${cycle.value.name}\n`
  text += '='.repeat(30) + '\n\n'

  for (const item of summary.value.items) {
    text += `${item.name} ${item.variant}: ${item.total_quantity}x\n`
  }

  text += '\n' + '='.repeat(30) + '\n'
  text += `Celkom poloziek: ${summary.value.totalItems}\n`
  text += `Celkova suma: ${summary.value.totalPrice.toFixed(2)} EUR\n`

  navigator.clipboard.writeText(text)
  alert('Sumar bol skopirovany do schranky!')
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}
</script>

<template>
  <div class="min-h-screen bg-amber-50">
    <!-- Header -->
    <header class="bg-amber-800 text-white shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <button @click="router.push('/admin/dashboard')" class="text-amber-200 hover:text-white">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 class="text-xl font-bold">{{ cycle?.name || 'Nacitavam...' }}</h1>
            <span v-if="cycle" :class="['text-sm px-2 py-0.5 rounded-full', cycle.status === 'open' ? 'bg-green-500' : cycle.status === 'locked' ? 'bg-yellow-500' : 'bg-gray-500']">
              {{ cycle.status === 'open' ? 'Otvoreny' : cycle.status === 'locked' ? 'Uzamknuty' : 'Dokonceny' }}
            </span>
          </div>
        </div>
        <div class="flex gap-2">
          <button
            v-if="cycle?.status !== 'completed'"
            @click="toggleLock"
            class="px-4 py-2 bg-amber-700 rounded-lg hover:bg-amber-600 transition-colors"
          >
            {{ cycle?.status === 'locked' ? 'Odomknut' : 'Uzamknut' }}
          </button>
          <button
            v-if="cycle?.status === 'locked'"
            @click="markCompleted"
            class="px-4 py-2 bg-green-600 rounded-lg hover:bg-green-500 transition-colors"
          >
            Oznacit ako dokonceny
          </button>
          <button
            @click="router.push(`/admin/cycle/${cycleId}/distribution`)"
            class="px-4 py-2 bg-amber-700 rounded-lg hover:bg-amber-600 transition-colors"
          >
            Distribucia
          </button>
        </div>
      </div>
    </header>

    <!-- Tabs -->
    <div class="bg-white border-b">
      <div class="max-w-7xl mx-auto px-4">
        <nav class="flex gap-4">
          <button
            v-for="tab in ['products', 'friends', 'orders', 'summary']"
            :key="tab"
            @click="activeTab = tab"
            :class="['py-4 px-2 border-b-2 font-medium transition-colors', activeTab === tab ? 'border-amber-600 text-amber-600' : 'border-transparent text-gray-500 hover:text-gray-700']"
          >
            {{ tab === 'products' ? 'Produkty' : tab === 'friends' ? 'Priatelia' : tab === 'orders' ? 'Objednavky' : 'Sumar' }}
          </button>
        </nav>
      </div>
    </div>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-6">
      <div v-if="error" class="mb-4 p-4 bg-red-50 text-red-700 rounded-lg">{{ error }}</div>

      <div v-if="loading" class="text-center py-12 text-gray-500">Nacitavam...</div>

      <!-- Products Tab -->
      <div v-else-if="activeTab === 'products'">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-lg font-semibold">Produkty ({{ products.length }})</h2>
          <button @click="openProductModal()" class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700">
            + Pridat produkt
          </button>
        </div>

        <!-- Import section -->
        <div class="bg-white rounded-lg shadow p-4 mb-4">
          <h3 class="text-sm font-medium text-gray-700 mb-3">Import produktov</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <!-- Google Sheets import -->
            <div>
              <label class="block text-xs text-gray-500 mb-1">Z Google Sheets (verejny sheet)</label>
              <!-- Format selector -->
              <div class="flex gap-4 mb-2">
                <label class="flex items-center text-sm cursor-pointer">
                  <input type="radio" v-model="gsheetFormat" value="multirow" class="mr-1.5" />
                  Viacriadkovy (3 riadky = 1 produkt)
                </label>
                <label class="flex items-center text-sm cursor-pointer">
                  <input type="radio" v-model="gsheetFormat" value="simple" class="mr-1.5" />
                  Jednoduchy (1 riadok = 1 produkt)
                </label>
              </div>
              <div class="flex gap-2">
                <input
                  v-model="gsheetUrl"
                  type="text"
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  class="flex-1 px-3 py-2 border rounded-lg text-sm"
                  :disabled="gsheetLoading"
                />
                <button
                  @click="importGoogleSheets"
                  :disabled="!gsheetUrl.trim() || gsheetLoading"
                  class="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {{ gsheetLoading ? 'Importujem...' : 'Importovat' }}
                </button>
              </div>
            </div>
            <!-- CSV import -->
            <div>
              <label class="block text-xs text-gray-500 mb-1">Z CSV suboru</label>
              <div class="flex gap-2">
                <input type="file" accept=".csv" @change="onFileChange" class="flex-1 text-sm" />
                <button
                  v-if="csvFile"
                  @click="importCSV"
                  class="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm whitespace-nowrap"
                >
                  Importovat
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-lg shadow overflow-hidden">
          <table class="w-full">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-3 py-3 text-left text-sm font-medium text-gray-600 w-16">Foto</th>
                <th class="px-3 py-3 text-left text-sm font-medium text-gray-600">Nazov</th>
                <th class="px-3 py-3 text-left text-sm font-medium text-gray-600">Chutovy profil</th>
                <th class="px-3 py-3 text-left text-sm font-medium text-gray-600">Prazenie</th>
                <th class="px-3 py-3 text-left text-sm font-medium text-gray-600">Ucel</th>
                <th class="px-3 py-3 text-right text-sm font-medium text-gray-600">250g</th>
                <th class="px-3 py-3 text-right text-sm font-medium text-gray-600">1kg</th>
                <th class="px-3 py-3 text-right text-sm font-medium text-gray-600">Akcie</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr
                v-for="product in products"
                :key="product.id"
                :class="[
                  'hover:bg-gray-50 transition-all duration-150',
                  dragOverProductId === product.id ? 'bg-amber-100 ring-2 ring-amber-400 ring-inset' : '',
                  droppingProductId === product.id ? 'opacity-50' : ''
                ]"
                @dragover="handleProductDragOver($event, product.id)"
                @dragleave="handleProductDragLeave($event, product.id)"
                @drop="handleProductDrop($event, product.id)"
              >
                <td class="px-3 py-2">
                  <div :class="[
                    'w-12 h-12 rounded overflow-hidden flex items-center justify-center transition-all',
                    dragOverProductId === product.id ? 'ring-2 ring-amber-500 bg-amber-50' : 'bg-gray-100'
                  ]">
                    <div v-if="droppingProductId === product.id" class="animate-pulse">
                      <svg class="w-6 h-6 text-amber-500 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    </div>
                    <img v-else-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                    <svg v-else class="w-6 h-6 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                </td>
                <td class="px-3 py-2">
                  <div class="font-medium">{{ product.name }}</div>
                  <div v-if="product.description1" class="text-sm text-gray-500">{{ product.description1 }}</div>
                </td>
                <td class="px-3 py-2 text-sm text-gray-600 max-w-xs">
                  <span v-if="product.description2" class="line-clamp-2">{{ product.description2 }}</span>
                  <span v-else class="text-gray-300">-</span>
                </td>
                <td class="px-3 py-2 text-sm">{{ product.roast_type || '-' }}</td>
                <td class="px-3 py-2 text-sm">{{ product.purpose || '-' }}</td>
                <td class="px-3 py-2 text-sm text-right">{{ formatPrice(product.price_250g) }}</td>
                <td class="px-3 py-2 text-sm text-right">{{ formatPrice(product.price_1kg) }}</td>
                <td class="px-3 py-2 text-right">
                  <button @click="openProductModal(product)" class="text-blue-600 hover:text-blue-800 mr-2 text-sm">Upravit</button>
                  <button @click="deleteProduct(product.id)" class="text-red-600 hover:text-red-800 text-sm">Vymazat</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Friends Tab -->
      <div v-else-if="activeTab === 'friends'">
        <!-- Shared Link Settings -->
        <div class="bg-white rounded-lg shadow p-4 mb-6">
          <h3 class="text-sm font-semibold text-gray-700 mb-3">Nastavenia zdielaneho odkazu</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <!-- Password -->
            <div>
              <label class="block text-xs text-gray-500 mb-1">Heslo pre priatov (povinne)</label>
              <div class="flex gap-2">
                <input
                  v-model="sharedPassword"
                  type="text"
                  placeholder="Zadajte heslo"
                  class="flex-1 px-3 py-2 border rounded-lg text-sm"
                />
                <button
                  @click="savePassword"
                  :disabled="passwordSaving"
                  class="px-3 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm disabled:opacity-50"
                >
                  {{ passwordSaving ? 'Ukladam...' : 'Ulozit' }}
                </button>
              </div>
              <p v-if="passwordMessage" class="text-xs text-green-600 mt-1">{{ passwordMessage }}</p>
            </div>
            <!-- Shared Link -->
            <div>
              <label class="block text-xs text-gray-500 mb-1">Zdielany odkaz pre vsetkych</label>
              <div class="flex gap-2">
                <input
                  :value="sharedOrderLink"
                  readonly
                  class="flex-1 px-3 py-2 border rounded-lg text-sm bg-gray-50"
                />
                <button
                  @click="copySharedLink"
                  class="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm whitespace-nowrap"
                >
                  Kopirovat
                </button>
              </div>
              <p v-if="!sharedPassword" class="text-xs text-amber-600 mt-1">Najprv nastavte heslo, aby odkaz fungoval</p>
            </div>
          </div>
        </div>

        <div class="flex justify-between items-center mb-4">
          <h2 class="text-lg font-semibold">Priatelia ({{ friends.length }})</h2>
          <button @click="showFriendModal = true" class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700">
            + Pridat priatela
          </button>
        </div>

        <div class="grid gap-3">
          <div v-for="friend in friends" :key="friend.id" class="bg-white rounded-lg shadow p-4 flex justify-between items-center">
            <div>
              <div class="font-medium">{{ friend.name }}</div>
              <div class="text-sm text-gray-500">
                {{ friend.order_status === 'submitted' ? `Objednane: ${formatPrice(friend.total)}` : 'Neobjednane' }}
                <span v-if="friend.paid" class="ml-2 text-green-600">Zaplatene</span>
              </div>
            </div>
            <div class="flex gap-2">
              <button @click="deleteFriend(friend.id)" class="text-red-600 hover:text-red-800 text-sm">
                Vymazat
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Orders Tab -->
      <div v-else-if="activeTab === 'orders'">
        <h2 class="text-lg font-semibold mb-4">Objednavky</h2>

        <div class="bg-white rounded-lg shadow overflow-hidden">
          <table class="w-full">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-4 py-3 text-left text-sm font-medium text-gray-600">Priatel</th>
                <th class="px-4 py-3 text-left text-sm font-medium text-gray-600">Status</th>
                <th class="px-4 py-3 text-right text-sm font-medium text-gray-600">Suma</th>
                <th class="px-4 py-3 text-center text-sm font-medium text-gray-600">Zaplatene</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="friend in friends" :key="friend.id" class="hover:bg-gray-50">
                <td class="px-4 py-3 font-medium">{{ friend.name }}</td>
                <td class="px-4 py-3">
                  <span :class="['px-2 py-1 rounded-full text-xs font-medium', friend.order_status === 'submitted' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600']">
                    {{ friend.order_status === 'submitted' ? 'Odoslane' : 'Neodoslane' }}
                  </span>
                </td>
                <td class="px-4 py-3 text-right">{{ formatPrice(friend.total) }}</td>
                <td class="px-4 py-3 text-center">
                  <button
                    v-if="friend.order_id"
                    @click="togglePaid(friend)"
                    :class="['w-6 h-6 rounded border-2 flex items-center justify-center', friend.paid ? 'bg-green-500 border-green-500 text-white' : 'border-gray-300']"
                  >
                    <svg v-if="friend.paid" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Summary Tab -->
      <div v-else-if="activeTab === 'summary'">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-lg font-semibold">Sumar objednavky</h2>
          <button @click="copySummary" class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700">
            Kopirovat do schranky
          </button>
        </div>

        <div class="bg-white rounded-lg shadow p-6">
          <div v-if="summary?.items.length === 0" class="text-center text-gray-500 py-8">
            Zatial ziadne objednavky
          </div>
          <div v-else>
            <table class="w-full mb-6">
              <thead>
                <tr class="border-b">
                  <th class="py-2 text-left font-medium">Produkt</th>
                  <th class="py-2 text-left font-medium">Varianta</th>
                  <th class="py-2 text-right font-medium">Pocet</th>
                  <th class="py-2 text-right font-medium">Suma</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(item, i) in summary.items" :key="i" class="border-b border-gray-100">
                  <td class="py-2">{{ item.name }}</td>
                  <td class="py-2">{{ item.variant }}</td>
                  <td class="py-2 text-right">{{ item.total_quantity }}x</td>
                  <td class="py-2 text-right">{{ formatPrice(item.total_price) }}</td>
                </tr>
              </tbody>
            </table>

            <div class="border-t pt-4 flex justify-between text-lg font-semibold">
              <span>Celkom poloziek: {{ summary.totalItems }}</span>
              <span>Celkova suma: {{ formatPrice(summary.totalPrice) }}</span>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Product Modal -->
    <div v-if="showProductModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" @click.stop>
        <h3 class="text-lg font-semibold mb-4">{{ editingProduct ? 'Upravit produkt' : 'Novy produkt' }}</h3>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Left column - Image -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">Fotografia produktu</label>
            <div
              @drop="handleDrop"
              @dragover="handleDragOver"
              @dragleave="handleDragLeave"
              :class="[
                'border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer',
                isDragging ? 'border-amber-500 bg-amber-50' : 'border-gray-300 hover:border-gray-400'
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
                  class="absolute top-2 right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600"
                >
                  &times;
                </button>
              </div>
              <div v-else class="py-8">
                <svg class="w-12 h-12 mx-auto text-gray-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p class="text-sm text-gray-500">Kliknite alebo pretiahnite obrazok</p>
                <p class="text-xs text-gray-400 mt-1">JPG, PNG, max 5MB</p>
              </div>
            </div>
          </div>

          <!-- Right column - Fields -->
          <div class="space-y-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Nazov *</label>
              <input v-model="productForm.name" class="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Popis (podnadpis)</label>
              <input v-model="productForm.description1" class="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Chutovy profil</label>
              <textarea v-model="productForm.description2" rows="2" class="w-full px-3 py-2 border rounded-lg text-sm"></textarea>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Prazenie</label>
                <input v-model="productForm.roast_type" class="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Ucel</label>
                <input v-model="productForm.purpose" class="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Cena 250g (EUR)</label>
                <input v-model="productForm.price_250g" type="number" step="0.01" class="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Cena 1kg (EUR)</label>
                <input v-model="productForm.price_1kg" type="number" step="0.01" class="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
            </div>
          </div>
        </div>

        <div class="flex gap-3 justify-end mt-6 pt-4 border-t">
          <button @click="showProductModal = false" class="px-4 py-2 text-gray-600 hover:text-gray-800">Zrusit</button>
          <button @click="saveProduct" class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Ulozit</button>
        </div>
      </div>
    </div>

    <!-- Friend Modal -->
    <div v-if="showFriendModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-md" @click.stop>
        <h3 class="text-lg font-semibold mb-4">Novy priatel</h3>
        <input
          v-model="newFriendName"
          placeholder="Meno priatela"
          class="w-full px-4 py-2 border rounded-lg mb-4"
          @keyup.enter="addFriend"
        />
        <div class="flex gap-3 justify-end">
          <button @click="showFriendModal = false" class="px-4 py-2 text-gray-600 hover:text-gray-800">Zrusit</button>
          <button @click="addFriend" class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Pridat</button>
        </div>
      </div>
    </div>
  </div>
</template>
