<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'

const router = useRouter()
const cycles = ref([])
const loading = ref(true)
const error = ref('')
const showNewCycleModal = ref(false)
const newCycleName = ref('')

onMounted(async () => {
  await loadCycles()
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

async function createCycle() {
  if (!newCycleName.value.trim()) return

  try {
    await api.createCycle(newCycleName.value)
    newCycleName.value = ''
    showNewCycleModal.value = false
    await loadCycles()
  } catch (e) {
    error.value = e.message
  }
}

async function deleteCycle(id) {
  if (!confirm('Naozaj chcete vymazat tento cyklus? Vsetky data budu stratene.')) return

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

function getStatusBadge(status) {
  switch (status) {
    case 'open': return { class: 'bg-green-100 text-green-800', text: 'Otvoreny' }
    case 'locked': return { class: 'bg-yellow-100 text-yellow-800', text: 'Uzamknuty' }
    case 'completed': return { class: 'bg-gray-100 text-gray-800', text: 'Dokonceny' }
    default: return { class: 'bg-gray-100 text-gray-800', text: status }
  }
}
</script>

<template>
  <div class="min-h-screen bg-amber-50">
    <!-- Header -->
    <header class="bg-amber-800 text-white shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <h1 class="text-xl font-bold">Gorifi - Admin</h1>
        <button @click="logout" class="text-amber-200 hover:text-white transition-colors">
          Odhlasit sa
        </button>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-2xl font-bold text-gray-800">Objednavkove cykly</h2>
        <button
          @click="showNewCycleModal = true"
          class="bg-amber-600 text-white px-4 py-2 rounded-lg hover:bg-amber-700 transition-colors"
        >
          + Novy cyklus
        </button>
      </div>

      <div v-if="error" class="mb-4 p-4 bg-red-50 text-red-700 rounded-lg">
        {{ error }}
      </div>

      <div v-if="loading" class="text-center py-12 text-gray-500">
        Nacitavam...
      </div>

      <div v-else-if="cycles.length === 0" class="text-center py-12">
        <p class="text-gray-500 mb-4">Zatial ziadne objednavkove cykly</p>
        <button
          @click="showNewCycleModal = true"
          class="bg-amber-600 text-white px-4 py-2 rounded-lg hover:bg-amber-700 transition-colors"
        >
          Vytvorit prvy cyklus
        </button>
      </div>

      <div v-else class="grid gap-4">
        <div
          v-for="cycle in cycles"
          :key="cycle.id"
          class="bg-white rounded-lg shadow p-6 hover:shadow-md transition-shadow cursor-pointer"
          @click="router.push(`/admin/cycle/${cycle.id}`)"
        >
          <div class="flex justify-between items-start">
            <div>
              <h3 class="text-lg font-semibold text-gray-800">{{ cycle.name }}</h3>
              <p class="text-sm text-gray-500 mt-1">
                {{ cycle.friends_count }} priatelov · {{ cycle.orders_count }} objednavok
              </p>
            </div>
            <div class="flex items-center gap-2">
              <span :class="['px-3 py-1 rounded-full text-sm font-medium', getStatusBadge(cycle.status).class]">
                {{ getStatusBadge(cycle.status).text }}
              </span>
              <button
                @click.stop="deleteCycle(cycle.id)"
                class="text-red-500 hover:text-red-700 p-1"
                title="Vymazat"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- New Cycle Modal -->
    <div v-if="showNewCycleModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-md" @click.stop>
        <h3 class="text-lg font-semibold mb-4">Novy objednavkovy cyklus</h3>
        <input
          v-model="newCycleName"
          type="text"
          placeholder="Nazov (napr. Januar 2026)"
          class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent mb-4"
          @keyup.enter="createCycle"
        />
        <div class="flex gap-3 justify-end">
          <button
            @click="showNewCycleModal = false"
            class="px-4 py-2 text-gray-600 hover:text-gray-800"
          >
            Zrusit
          </button>
          <button
            @click="createCycle"
            class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700"
          >
            Vytvorit
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
