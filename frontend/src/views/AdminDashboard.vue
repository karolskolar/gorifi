<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

const router = useRouter()
const mobileMenuOpen = ref(false)
const cycles = ref([])
const loading = ref(true)
const error = ref('')
const showNewCycleModal = ref(false)
const newCycleName = ref('')
const newCycleType = ref('coffee')
const bakeryProducts = ref([])
const selectedBakeryProductIds = ref([])
const bakeryProductSearch = ref('')
const newCycleStatus = ref('open')
const newCyclePlanNote = ref('')

onMounted(async () => {
  await loadCycles()
})

// Set page title
watchEffect(() => {
  document.title = 'Gorifi Admin'
})

async function loadCycles() {
  loading.value = true
  try {
    cycles.value = await api.getCycles()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function openNewCycleModal() {
  showNewCycleModal.value = true
  newCycleType.value = 'coffee'
  selectedBakeryProductIds.value = []
  bakeryProductSearch.value = ''
  newCycleStatus.value = 'open'
  newCyclePlanNote.value = ''
  // Load bakery products for picker
  try {
    bakeryProducts.value = await api.getBakeryProducts()
  } catch (e) {
    // Non-critical
  }
}

function toggleBakeryProduct(id) {
  const idx = selectedBakeryProductIds.value.indexOf(id)
  if (idx >= 0) {
    selectedBakeryProductIds.value.splice(idx, 1)
  } else {
    selectedBakeryProductIds.value.push(id)
  }
}

const filteredBakeryProducts = computed(() => {
  if (!bakeryProductSearch.value.trim()) return bakeryProducts.value
  const q = bakeryProductSearch.value.toLowerCase()
  return bakeryProducts.value.filter(p => p.name.toLowerCase().includes(q))
})

async function createCycle() {
  if (!newCycleName.value.trim()) return

  try {
    const data = {
      name: newCycleName.value,
      type: newCycleType.value,
      status: newCycleStatus.value,
      plan_note: newCyclePlanNote.value || null
    }
    if (newCycleType.value === 'bakery') {
      data.bakery_product_ids = selectedBakeryProductIds.value
    }
    await api.createCycle(data)
    newCycleName.value = ''
    newCycleStatus.value = 'open'
    newCyclePlanNote.value = ''
    showNewCycleModal.value = false
    await loadCycles()
  } catch (e) {
    error.value = e.message
  }
}

async function deleteCycle(id) {
  if (!confirm('Naozaj chcete vymazať tento cyklus? Všetky dáta budú stratené.')) return

  try {
    await api.deleteCycle(id)
    await loadCycles()
  } catch (e) {
    error.value = e.message
  }
}

async function logout() {
  await api.logout()
  localStorage.removeItem('adminToken')
  router.push('/admin')
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

function getStatusText(status) {
  switch (status) {
    case 'planned': return 'Plánovaný'
    case 'open': return 'Otvorený'
    case 'locked': return 'Uzamknutý'
    case 'completed': return 'Dokončený'
    default: return status
  }
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <h1 class="text-xl font-bold">Gorifi - Admin</h1>
        <!-- Desktop nav -->
        <div class="hidden md:flex items-center gap-2">
          <Button variant="ghost" @click="router.push('/admin/analytics/coffee')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            Štatistiky
          </Button>
          <Button variant="ghost" @click="router.push('/admin/friends')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            Priatelia
          </Button>
          <Button variant="ghost" @click="router.push('/admin/bakery-products')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            Pekáreň
          </Button>
          <Button variant="ghost" @click="router.push('/admin/vouchers')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            Vouchery
          </Button>
          <Button variant="ghost" @click="router.push('/admin/friend-groups')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            Skupiny
          </Button>
          <Button variant="ghost" @click="router.push('/admin/settings')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            Nastavenia
          </Button>
          <Button variant="ghost" @click="logout" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            Odhlásiť sa
          </Button>
        </div>
        <!-- Mobile hamburger -->
        <button @click="mobileMenuOpen = !mobileMenuOpen" class="md:hidden p-2 rounded hover:bg-primary-foreground/10 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path v-if="!mobileMenuOpen" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <!-- Mobile menu dropdown -->
      <div v-if="mobileMenuOpen" class="md:hidden border-t border-primary-foreground/10 px-4 py-2 space-y-1">
        <button @click="router.push('/admin/analytics/coffee'); mobileMenuOpen = false" class="block w-full text-left px-3 py-2 rounded text-sm text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10 transition-colors">Štatistiky</button>
        <button @click="router.push('/admin/friends'); mobileMenuOpen = false" class="block w-full text-left px-3 py-2 rounded text-sm text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10 transition-colors">Priatelia</button>
        <button @click="router.push('/admin/bakery-products'); mobileMenuOpen = false" class="block w-full text-left px-3 py-2 rounded text-sm text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10 transition-colors">Pekáreň</button>
        <button @click="router.push('/admin/vouchers'); mobileMenuOpen = false" class="block w-full text-left px-3 py-2 rounded text-sm text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10 transition-colors">Vouchery</button>
        <button @click="router.push('/admin/friend-groups'); mobileMenuOpen = false" class="block w-full text-left px-3 py-2 rounded text-sm text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10 transition-colors">Skupiny</button>
        <button @click="router.push('/admin/settings'); mobileMenuOpen = false" class="block w-full text-left px-3 py-2 rounded text-sm text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10 transition-colors">Nastavenia</button>
        <button @click="logout(); mobileMenuOpen = false" class="block w-full text-left px-3 py-2 rounded text-sm text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10 transition-colors">Odhlásiť sa</button>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-2xl font-bold text-foreground">Objednávkové cykly</h2>
        <Button @click="openNewCycleModal()">
          + Nový cyklus
        </Button>
      </div>

      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">
        Načítavam...
      </div>

      <div v-else-if="cycles.length === 0" class="text-center py-12">
        <p class="text-muted-foreground mb-4">Zatiaľ žiadne objednávkové cykly</p>
        <Button @click="openNewCycleModal()">
          Vytvoriť prvý cyklus
        </Button>
      </div>

      <div v-else class="grid gap-4">
        <Card
          v-for="cycle in cycles"
          :key="cycle.id"
          class="hover:shadow-md transition-shadow cursor-pointer"
          @click="router.push(`/admin/cycle/${cycle.id}`)"
        >
          <CardContent class="p-6">
            <div class="flex justify-between items-start">
              <div>
                <h3 class="text-lg font-semibold text-foreground">{{ cycle.name }}</h3>
                <p class="text-sm text-muted-foreground mt-1">
                  {{ cycle.orders_count }} objednávok
                </p>
              </div>
              <div class="flex items-center gap-2">
                <Badge v-if="cycle.type === 'bakery'" variant="outline" class="border-orange-400 text-orange-600 bg-orange-50">
                  Pekáreň
                </Badge>
                <Badge :variant="getStatusVariant(cycle.status)">
                  {{ getStatusText(cycle.status) }}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  @click.stop="deleteCycle(cycle.id)"
                  class="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>

    <!-- New Cycle Modal -->
    <Dialog :open="showNewCycleModal" @update:open="showNewCycleModal = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nový objednávkový cyklus</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <div class="space-y-2">
            <Label for="cycleName">Názov</Label>
            <Input
              id="cycleName"
              v-model="newCycleName"
              placeholder="napr. Január 2026"
              @keyup.enter="createCycle"
            />
          </div>
          <div class="space-y-2">
            <Label>Typ</Label>
            <div class="flex gap-4">
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" v-model="newCycleType" value="coffee" />
                <span class="text-sm">Káva</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" v-model="newCycleType" value="bakery" />
                <span class="text-sm">Pekáreň</span>
              </label>
            </div>
          </div>
          <div class="space-y-2">
            <Label>Stav</Label>
            <div class="flex gap-4">
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" v-model="newCycleStatus" value="open" />
                <span class="text-sm">Otvorený</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" v-model="newCycleStatus" value="planned" />
                <span class="text-sm">Plánovaný</span>
              </label>
            </div>
          </div>
          <div v-if="newCycleStatus === 'planned'" class="space-y-2">
            <Label>Plán objednávky</Label>
            <textarea
              v-model="newCyclePlanNote"
              placeholder="napr. 1. - 3. máj objednávanie&#10;4. - 5. máj dodávka&#10;od 6. mája distribúcia"
              rows="4"
              class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            ></textarea>
          </div>
          <!-- Bakery product picker -->
          <div v-if="newCycleType === 'bakery'" class="space-y-2">
            <Label>Produkty z katalógu ({{ selectedBakeryProductIds.length }} vybraných)</Label>
            <Input
              v-model="bakeryProductSearch"
              placeholder="Hľadať produkt..."
              class="mb-2"
            />
            <div class="max-h-48 overflow-y-auto border rounded-md p-2 space-y-1">
              <label
                v-for="bp in filteredBakeryProducts"
                :key="bp.id"
                class="flex items-center gap-2 p-1.5 rounded hover:bg-muted cursor-pointer"
              >
                <input
                  type="checkbox"
                  :checked="selectedBakeryProductIds.includes(bp.id)"
                  @change="toggleBakeryProduct(bp.id)"
                  class="rounded"
                />
                <span class="text-sm flex-1">{{ bp.name }}</span>
                <Badge variant="outline" class="text-xs" :class="bp.category === 'sladké' ? 'border-pink-400 text-pink-600' : 'border-amber-400 text-amber-600'">
                  {{ bp.category === 'sladké' ? 'Sladké' : 'Slané' }}
                </Badge>
                <span class="text-xs text-muted-foreground">{{ bp.price.toFixed(2) }} EUR</span>
              </label>
              <div v-if="filteredBakeryProducts.length === 0" class="text-sm text-muted-foreground text-center py-2">
                Žiadne produkty v katalógu
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showNewCycleModal = false">
            Zrušiť
          </Button>
          <Button @click="createCycle">
            Vytvoriť
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
