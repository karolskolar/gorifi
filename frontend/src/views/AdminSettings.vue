<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
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
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const successMessage = ref('')

// Pickup locations
const pickupLocations = ref([])
const newLocationName = ref('')
const newLocationAddress = ref('')
const editingLocationId = ref(null)
const editingLocationName = ref('')
const editingLocationAddress = ref('')

onMounted(async () => {
  await loadSettings()
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
    successMessage.value = 'Nastavenia boli ulozene'
    setTimeout(() => { successMessage.value = '' }, 3000)
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
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
        Nacitavam...
      </div>

      <Card v-else>
        <CardHeader>
          <CardTitle>Heslo pre priatelov</CardTitle>
          <CardDescription>
            Toto heslo budu pouzivat vsetci priatelia na prihlasenie do objednavkoveho portalu.
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
              {{ saving ? 'Ukladam...' : 'Ulozit heslo' }}
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

      <!-- Pickup Locations -->
      <Card v-if="!loading" class="mt-6">
        <CardHeader>
          <CardTitle>Miesta vyzdvihnutia</CardTitle>
          <CardDescription>
            Miesta, kde si priatelia mozu vyzdvihnut objednanu kavu.
            Pri odoslani objednavky si vyberaju jedno z tychto miest.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- Existing locations -->
          <div v-if="pickupLocations.length > 0" class="space-y-2">
            <div
              v-for="loc in pickupLocations"
              :key="loc.id"
              :class="['flex items-center gap-2 p-3 rounded-lg border', !loc.active ? 'opacity-50 bg-muted' : '']"
            >
              <template v-if="editingLocationId === loc.id">
                <div class="flex-1 space-y-2">
                  <Input v-model="editingLocationName" placeholder="Nazov" />
                  <Input v-model="editingLocationAddress" placeholder="Adresa (volitelne)" />
                </div>
                <Button size="sm" @click="saveLocation(loc.id)">Ulozit</Button>
                <Button size="sm" variant="outline" @click="cancelEditLocation">Zrusit</Button>
              </template>
              <template v-else>
                <div class="flex-1">
                  <div class="font-medium">{{ loc.name }}</div>
                  <div v-if="loc.address" class="text-sm text-muted-foreground">{{ loc.address }}</div>
                </div>
                <Button size="sm" variant="ghost" @click="startEditLocation(loc)">Upravit</Button>
                <Button size="sm" variant="ghost" @click="toggleLocationActive(loc)">
                  {{ loc.active ? 'Deaktivovat' : 'Aktivovat' }}
                </Button>
                <Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" @click="deleteLocation(loc.id)">Vymazat</Button>
              </template>
            </div>
          </div>
          <div v-else class="text-sm text-muted-foreground py-2">
            Zatial ziadne miesta. Pridajte prve miesto vyzdvihnutia.
          </div>

          <!-- Add new location -->
          <div class="pt-4 border-t space-y-2">
            <Label>Pridat nove miesto</Label>
            <div class="flex gap-2">
              <Input v-model="newLocationName" placeholder="Nazov" class="flex-1" />
              <Input v-model="newLocationAddress" placeholder="Adresa (volitelne)" class="flex-1" />
              <Button @click="addLocation" :disabled="!newLocationName.trim()">Pridat</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  </div>
</template>
