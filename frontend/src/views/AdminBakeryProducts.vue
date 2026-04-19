<script setup>
import { ref, onMounted, watchEffect } from 'vue'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const router = useRouter()
const products = ref([])
const loading = ref(true)
const error = ref('')

// Modal state
const showModal = ref(false)
const editingProduct = ref(null)
const form = ref({
  name: '', subtitle: '', description: '', composition: '', category: 'slané', image: '',
  variants: [{ label: '', weight_grams: '', price: '' }]
})
const imagePreview = ref(null)
const isDragging = ref(false)

onMounted(async () => {
  await loadProducts()
})

watchEffect(() => {
  document.title = 'Pekáreň - Gorifi Admin'
})

async function loadProducts() {
  loading.value = true
  try {
    products.value = await api.getAllBakeryProducts()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function openModal(product = null) {
  editingProduct.value = product
  if (product) {
    const variants = (product.variants && product.variants.length > 0)
      ? product.variants.map(v => ({ id: v.id, label: v.label || '', weight_grams: v.weight_grams || '', price: v.price || '' }))
      : [{ label: '', weight_grams: product.weight_grams || '', price: product.price || '' }]
    form.value = {
      name: product.name || '',
      subtitle: product.subtitle || '',
      description: product.description || '',
      composition: product.composition || '',
      category: product.category || 'slané',
      image: product.image || '',
      variants
    }
    imagePreview.value = product.image || null
  } else {
    form.value = {
      name: '', subtitle: '', description: '', composition: '', category: 'slané', image: '',
      variants: [{ label: '', weight_grams: '', price: '' }]
    }
    imagePreview.value = null
  }
  showModal.value = true
}

async function saveProduct() {
  if (!form.value.name.trim()) return
  // At least one variant with a price is required
  const validVariants = form.value.variants.filter(v => v.price)
  if (validVariants.length === 0) return

  try {
    const data = {
      name: form.value.name,
      subtitle: form.value.subtitle || null,
      description: form.value.description || null,
      composition: form.value.composition || null,
      category: form.value.category,
      image: form.value.image || null,
      variants: form.value.variants.map((v, i) => ({
        ...(v.id ? { id: v.id } : {}),
        label: v.label || null,
        weight_grams: v.weight_grams ? parseInt(v.weight_grams) : null,
        price: parseFloat(v.price),
        sort_order: i
      }))
    }
    if (editingProduct.value) {
      await api.updateBakeryProduct(editingProduct.value.id, data)
    } else {
      await api.createBakeryProduct(data)
    }
    showModal.value = false
    await loadProducts()
  } catch (e) {
    error.value = e.message
  }
}

function duplicateProduct(product) {
  editingProduct.value = null
  const variants = (product.variants && product.variants.length > 0)
    ? product.variants.map(v => ({ label: v.label || '', weight_grams: v.weight_grams || '', price: v.price || '' }))
    : [{ label: '', weight_grams: product.weight_grams || '', price: product.price || '' }]
  form.value = {
    name: (product.name || '') + ' (kópia)',
    subtitle: product.subtitle || '',
    description: product.description || '',
    composition: product.composition || '',
    category: product.category || 'slané',
    image: product.image || '',
    variants
  }
  imagePreview.value = product.image || null
  showModal.value = true
}

function addVariant() {
  form.value.variants.push({ label: '', weight_grams: '', price: '' })
}

function removeVariant(index) {
  if (form.value.variants.length > 1) {
    form.value.variants.splice(index, 1)
  }
}

async function deleteProduct(id) {
  if (!confirm('Naozaj vymazať tento produkt?')) return
  try {
    await api.deleteBakeryProduct(id)
    await loadProducts()
  } catch (e) {
    error.value = e.message
  }
}

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
    form.value.image = e.target.result
    imagePreview.value = e.target.result
  }
  reader.readAsDataURL(file)
}

function removeImage() {
  form.value.image = ''
  imagePreview.value = null
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

function getCategoryLabel(category) {
  return category === 'sladké' ? 'Sladké' : 'Slané'
}

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
          <h1 class="text-xl font-bold">Pekáreň - Katalóg</h1>
        </div>
        <Button variant="ghost" @click="logout" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
          Odhlásiť sa
        </Button>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-2xl font-bold text-foreground">Produkty pekárne ({{ products.length }})</h2>
        <Button @click="openModal()">
          + Pridať produkt
        </Button>
      </div>

      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">
        Načítavam...
      </div>

      <div v-else-if="products.length === 0" class="text-center py-12">
        <p class="text-muted-foreground mb-4">Zatiaľ žiadne produkty v katalógu</p>
        <Button @click="openModal()">
          Pridať prvý produkt
        </Button>
      </div>

      <Card v-else>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-16">Foto</TableHead>
              <TableHead>Názov</TableHead>
              <TableHead>Kategória</TableHead>
              <TableHead class="text-right">Varianty</TableHead>
              <TableHead>Zloženie</TableHead>
              <TableHead class="text-center">Stav</TableHead>
              <TableHead class="text-right">Akcie</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="product in products" :key="product.id" :class="{ 'opacity-50': !product.active }">
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
                <div v-if="product.description" class="text-sm text-muted-foreground line-clamp-1">{{ product.description }}</div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" :class="product.category === 'sladké' ? 'border-pink-400 text-pink-600 bg-pink-50' : 'border-amber-400 text-amber-600 bg-amber-50'">
                  {{ getCategoryLabel(product.category) }}
                </Badge>
              </TableCell>
              <TableCell class="text-right text-sm">
                <div v-if="product.variants && product.variants.length > 0" class="space-y-0.5">
                  <div v-for="v in product.variants" :key="v.id" class="whitespace-nowrap">
                    <span v-if="v.label" class="text-muted-foreground">{{ v.label }}: </span>
                    <span>{{ formatPrice(v.price) }}</span>
                    <span v-if="v.weight_grams" class="text-muted-foreground"> / {{ v.weight_grams }}g</span>
                  </div>
                </div>
                <span v-else>{{ formatPrice(product.price) }}</span>
              </TableCell>
              <TableCell class="text-sm text-muted-foreground max-w-xs">
                <span v-if="product.composition" class="line-clamp-1">{{ product.composition }}</span>
                <span v-else>-</span>
              </TableCell>
              <TableCell class="text-center">
                <Badge :variant="product.active ? 'default' : 'secondary'">
                  {{ product.active ? 'Aktívny' : 'Neaktívny' }}
                </Badge>
              </TableCell>
              <TableCell class="text-right">
                <Button variant="ghost" size="sm" @click="openModal(product)">Upraviť</Button>
                <Button variant="ghost" size="sm" @click="duplicateProduct(product)" title="Duplikovať">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                </Button>
                <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="deleteProduct(product.id)">Vymazať</Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </main>

    <!-- Add/Edit Modal -->
    <Dialog :open="showModal" @update:open="showModal = $event">
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
                <p class="text-sm text-muted-foreground">Kliknite alebo pretiahnite obrázok</p>
              </div>
            </div>
          </div>

          <!-- Right column - Fields -->
          <div class="space-y-3">
            <div class="space-y-1">
              <Label>Názov *</Label>
              <Input v-model="form.name" />
            </div>
            <div class="space-y-1">
              <Label>Podnadpis</Label>
              <Input v-model="form.subtitle" placeholder="napr. 230g, bezlepkový..." />
            </div>
            <div class="space-y-1">
              <Label>Popis</Label>
              <textarea v-model="form.description" rows="2" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"></textarea>
            </div>
            <div class="space-y-1">
              <Label>Kategória</Label>
              <Select v-model="form.category">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="slané">Slané</SelectItem>
                  <SelectItem value="sladké">Sladké</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-2">
              <Label>Varianty</Label>
              <div v-for="(variant, index) in form.variants" :key="index" class="flex items-center gap-2">
                <Input v-model="variant.label" placeholder="napr. Malá" class="flex-1" />
                <Input v-model="variant.weight_grams" type="number" placeholder="g" class="w-20" />
                <Input v-model="variant.price" type="number" step="0.01" placeholder="EUR" class="w-24" />
                <button
                  v-if="form.variants.length > 1"
                  @click="removeVariant(index)"
                  class="text-destructive hover:text-destructive/80 p-1"
                  type="button"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <div v-else class="w-6"></div>
              </div>
              <button
                @click="addVariant"
                type="button"
                class="text-sm text-primary hover:text-primary/80 flex items-center gap-1"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
                Pridať variant
              </button>
            </div>
            <div class="space-y-1">
              <Label>Zloženie / alergény</Label>
              <textarea v-model="form.composition" rows="2" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" placeholder="napr. muka, maslo, vajcia..."></textarea>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="showModal = false">Zrušiť</Button>
          <Button @click="saveProduct" :disabled="!form.name.trim() || !form.variants.some(v => v.price)">Uložiť</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
