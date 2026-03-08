<script setup>
import { ref, computed, onMounted, onUnmounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'

const baseUrl = computed(() => window.location.origin)
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const router = useRouter()

const friendsPassword = ref('')
const paymentIban = ref('')
const paymentRevolutUsername = ref('')
const loading = ref(true)
const saving = ref(false)
const savingPayment = ref(false)
const error = ref('')
const successMessage = ref('')

// Pickup locations
const pickupLocations = ref([])
const newLocationName = ref('')
const newLocationAddress = ref('')
const editingLocationId = ref(null)
const editingLocationName = ref('')
const editingLocationAddress = ref('')
const openMenuId = ref(null)

function closeMenuOnOutsideClick(e) {
  if (openMenuId.value && !e.target.closest('.relative')) {
    openMenuId.value = null
  }
}

onMounted(async () => {
  document.addEventListener('click', closeMenuOnOutsideClick)
  await loadSettings()
})

onUnmounted(() => {
  document.removeEventListener('click', closeMenuOnOutsideClick)
})

// Set page title
watchEffect(() => {
  document.title = 'Nastavenia - Gorifi Admin'
})

async function loadSettings() {
  loading.value = true
  error.value = ''

  try {
    const [settings, locations] = await Promise.all([
      api.getAdminSettings(),
      api.getAllPickupLocations()
    ])
    friendsPassword.value = settings.friendsPassword || ''
    paymentIban.value = settings.paymentIban || ''
    paymentRevolutUsername.value = settings.paymentRevolutUsername || ''
    pickupLocations.value = locations
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function addLocation() {
  if (!newLocationName.value.trim()) return
  error.value = ''
  try {
    await api.createPickupLocation({ name: newLocationName.value.trim(), address: newLocationAddress.value.trim() })
    newLocationName.value = ''
    newLocationAddress.value = ''
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

function startEditLocation(loc) {
  editingLocationId.value = loc.id
  editingLocationName.value = loc.name
  editingLocationAddress.value = loc.address || ''
}

async function saveLocation(id) {
  if (!editingLocationName.value.trim()) return
  error.value = ''
  try {
    await api.updatePickupLocation(id, { name: editingLocationName.value.trim(), address: editingLocationAddress.value.trim() })
    editingLocationId.value = null
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

function cancelEditLocation() {
  editingLocationId.value = null
}

async function toggleLocationActive(loc) {
  error.value = ''
  try {
    await api.updatePickupLocation(loc.id, { active: !loc.active })
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

async function toggleLocationType(loc, field, value) {
  error.value = ''
  try {
    await api.updatePickupLocation(loc.id, { [field]: value })
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

async function deleteLocation(id) {
  error.value = ''
  try {
    await api.deletePickupLocation(id)
    pickupLocations.value = await api.getAllPickupLocations()
  } catch (e) {
    error.value = e.message
  }
}

async function saveSettings() {
  saving.value = true
  error.value = ''
  successMessage.value = ''

  try {
    await api.updateAdminSettings({ friendsPassword: friendsPassword.value })
    successMessage.value = 'Nastavenia boli uložené'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function savePaymentSettings() {
  savingPayment.value = true
  error.value = ''
  successMessage.value = ''

  try {
    await api.updateAdminSettings({
      paymentIban: paymentIban.value,
      paymentRevolutUsername: paymentRevolutUsername.value
    })
    successMessage.value = 'Platobné údaje boli uložené'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e) {
    error.value = e.message
  } finally {
    savingPayment.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            @click="router.push('/admin/dashboard')"
            class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <h1 class="text-xl font-bold">Nastavenia</h1>
        </div>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-2xl mx-auto px-4 py-8">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <Alert v-if="successMessage" class="mb-4 border-green-500 bg-green-50 text-green-800">
        <AlertDescription>{{ successMessage }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">
        Načítavam...
      </div>

      <Card v-else>
        <CardHeader>
          <CardTitle>Heslo pre priatelov</CardTitle>
          <CardDescription>
            Toto heslo budú používať všetci priatelia na prihlásenie do objednávkového portálu.
            Kazdy si vyberie svoje meno zo zoznamu a zada toto spolocne heslo.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-2">
            <Label for="friendsPassword">Heslo</Label>
            <Input
              id="friendsPassword"
              v-model="friendsPassword"
              type="text"
              placeholder="Zadajte heslo pre priatelov"
            />
            <p class="text-xs text-muted-foreground">
              Heslo je zobrazene ako text pre jednoduchsie zdielanie.
            </p>
          </div>

          <div class="pt-4">
            <Button @click="saveSettings" :disabled="saving">
              {{ saving ? 'Ukladám...' : 'Uložiť heslo' }}
            </Button>
          </div>

          <div class="pt-4 border-t">
            <p class="text-sm text-muted-foreground">
              <strong>Odkaz pre priatelov:</strong> {{ baseUrl }}/
            </p>
            <p class="text-xs text-muted-foreground mt-1">
              Priatelia pristupia na hlavnu stranku, kde sa prihlasia pomocou tohto hesla.
            </p>
          </div>
        </CardContent>
      </Card>

      <!-- Payment Settings -->
      <Card v-if="!loading" class="mt-6">
        <CardHeader>
          <CardTitle>Platobne udaje</CardTitle>
          <CardDescription>
            Tieto udaje sa zobrazia priatelom po odoslani objednavky, aby mohli zaplatit.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-2">
            <Label for="paymentIban">IBAN</Label>
            <Input
              id="paymentIban"
              v-model="paymentIban"
              type="text"
              placeholder="SK..."
            />
            <p class="text-xs text-muted-foreground">
              Pre generovanie Pay by Square QR kodu (skenovatelny slovenskymi bankovymi appkami).
            </p>
          </div>

          <div class="space-y-2">
            <Label for="paymentRevolutUsername">Revolut username</Label>
            <Input
              id="paymentRevolutUsername"
              v-model="paymentRevolutUsername"
              type="text"
              placeholder="napr. karolskolar"
            />
            <p class="text-xs text-muted-foreground">
              Pre tlacidlo na platbu cez Revolut (revolut.me odkaz).
            </p>
          </div>

          <div class="pt-4">
            <Button @click="savePaymentSettings" :disabled="savingPayment">
              {{ savingPayment ? 'Ukladám...' : 'Uložiť platobné údaje' }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <!-- Pickup Locations -->
      <Card v-if="!loading" class="mt-6">
        <CardHeader>
          <CardTitle>Miesta vyzdvihnutia</CardTitle>
          <CardDescription>
            Miesta, kde si priatelia môžu vyzdvihnúť objednanú kávu alebo pečivo.
            Pri odoslaní objednávky si vyberajú jedno z týchto miest.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- Existing locations -->
          <div v-if="pickupLocations.length > 0" class="space-y-2">
            <div
              v-for="loc in pickupLocations"
              :key="loc.id"
              :class="['flex items-center gap-3 px-3 py-2 rounded-lg border', !loc.active ? 'opacity-50 bg-muted' : '']"
            >
              <template v-if="editingLocationId === loc.id">
                <div class="flex-1 flex gap-2 items-center">
                  <Input v-model="editingLocationName" placeholder="Názov" class="flex-1" />
                  <Input v-model="editingLocationAddress" placeholder="Adresa" class="flex-1" />
                  <Button size="sm" @click="saveLocation(loc.id)">Uložiť</Button>
                  <Button size="sm" variant="outline" @click="cancelEditLocation">Zrušiť</Button>
                </div>
              </template>
              <template v-else>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-1">
                    <span class="font-medium">{{ loc.name }}</span>
                    <span v-if="loc.address" class="text-sm text-muted-foreground">· {{ loc.address }}</span>
                  </div>
                </div>
                <label class="flex items-center gap-1 text-xs cursor-pointer flex-shrink-0" :class="loc.for_coffee ? 'text-foreground' : 'text-muted-foreground'">
                  <input type="checkbox" :checked="loc.for_coffee" @change="toggleLocationType(loc, 'for_coffee', $event.target.checked)" class="rounded" />
                  Káva
                </label>
                <label class="flex items-center gap-1 text-xs cursor-pointer flex-shrink-0" :class="loc.for_bakery ? 'text-foreground' : 'text-muted-foreground'">
                  <input type="checkbox" :checked="loc.for_bakery" @change="toggleLocationType(loc, 'for_bakery', $event.target.checked)" class="rounded" />
                  Pekáreň
                </label>
                <div class="relative flex-shrink-0">
                  <button
                    @click="openMenuId = openMenuId === loc.id ? null : loc.id"
                    class="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  >
                    <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                    </svg>
                  </button>
                  <div
                    v-if="openMenuId === loc.id"
                    class="absolute right-0 top-full mt-1 z-10 bg-popover border rounded-md shadow-md py-1 min-w-[140px]"
                  >
                    <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-muted" @click="startEditLocation(loc); openMenuId = null">Upraviť</button>
                    <button class="w-full text-left px-3 py-1.5 text-sm hover:bg-muted" @click="toggleLocationActive(loc); openMenuId = null">
                      {{ loc.active ? 'Deaktivovať' : 'Aktivovať' }}
                    </button>
                    <button class="w-full text-left px-3 py-1.5 text-sm text-destructive hover:bg-muted" @click="deleteLocation(loc.id); openMenuId = null">Vymazať</button>
                  </div>
                </div>
              </template>
            </div>
          </div>
          <div v-else class="text-sm text-muted-foreground py-2">
            Zatiaľ žiadne miesta. Pridajte prvé miesto vyzdvihnutia.
          </div>

          <!-- Add new location -->
          <div class="pt-4 border-t space-y-2">
            <Label>Pridať nové miesto</Label>
            <div class="flex gap-2">
              <Input v-model="newLocationName" placeholder="Názov" class="flex-1" />
              <Input v-model="newLocationAddress" placeholder="Adresa (voliteľné)" class="flex-1" />
              <Button @click="addLocation" :disabled="!newLocationName.trim()">Pridať</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  </div>
</template>
