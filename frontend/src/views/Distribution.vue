<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'

const route = useRoute()
const router = useRouter()

const cycle = ref(null)
const distribution = ref([])
const loading = ref(true)
const error = ref('')
const packedFriends = ref(new Set())

const cycleId = route.params.id

onMounted(async () => {
  try {
    const data = await api.getCycleDistribution(cycleId)
    cycle.value = data.cycle
    distribution.value = data.distribution

    // Load packed status from localStorage
    const stored = localStorage.getItem(`packed-${cycleId}`)
    if (stored) {
      packedFriends.value = new Set(JSON.parse(stored))
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

function togglePacked(friendId) {
  if (packedFriends.value.has(friendId)) {
    packedFriends.value.delete(friendId)
  } else {
    packedFriends.value.add(friendId)
  }
  // Save to localStorage
  localStorage.setItem(`packed-${cycleId}`, JSON.stringify([...packedFriends.value]))
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

function printDistribution() {
  window.print()
}
</script>

<template>
  <div class="min-h-screen bg-amber-50">
    <!-- Header (hidden when printing) -->
    <header class="bg-amber-800 text-white shadow print:hidden">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <button @click="router.push(`/admin/cycle/${cycleId}`)" class="text-amber-200 hover:text-white">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 class="text-xl font-bold">Distribucia - {{ cycle?.name || 'Nacitavam...' }}</h1>
        </div>
        <button
          @click="printDistribution"
          class="px-4 py-2 bg-amber-700 rounded-lg hover:bg-amber-600 transition-colors"
        >
          Tlacit
        </button>
      </div>
    </header>

    <!-- Print header -->
    <div class="hidden print:block p-4 border-b">
      <h1 class="text-2xl font-bold">Distribucia - {{ cycle?.name }}</h1>
    </div>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-6 print:max-w-none print:p-4">
      <div v-if="error" class="mb-4 p-4 bg-red-50 text-red-700 rounded-lg">{{ error }}</div>

      <div v-if="loading" class="text-center py-12 text-gray-500">Nacitavam...</div>

      <div v-else class="space-y-4">
        <div
          v-for="friend in distribution"
          :key="friend.id"
          :class="[
            'bg-white rounded-lg shadow p-4 print:shadow-none print:border print:break-inside-avoid',
            packedFriends.has(friend.id) ? 'opacity-50' : ''
          ]"
        >
          <div class="flex justify-between items-start mb-3">
            <div>
              <h3 class="text-lg font-semibold">{{ friend.name }}</h3>
              <div class="text-sm text-gray-500">
                <span v-if="friend.paid" class="text-green-600 font-medium">Zaplatene</span>
                <span v-else class="text-red-600 font-medium">Nezaplatene</span>
                <span class="mx-2">|</span>
                <span>Suma: {{ formatPrice(friend.total) }}</span>
              </div>
            </div>
            <button
              @click="togglePacked(friend.id)"
              :class="[
                'px-4 py-2 rounded-lg font-medium print:hidden',
                packedFriends.has(friend.id)
                  ? 'bg-green-100 text-green-800'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              ]"
            >
              {{ packedFriends.has(friend.id) ? 'Zabalene' : 'Oznacit ako zabalene' }}
            </button>
          </div>

          <div v-if="friend.items.length === 0" class="text-gray-500 italic">
            Ziadne polozky
          </div>
          <table v-else class="w-full">
            <thead>
              <tr class="border-b text-sm text-gray-600">
                <th class="py-2 text-left">Produkt</th>
                <th class="py-2 text-center">Varianta</th>
                <th class="py-2 text-center">Pocet</th>
                <th class="py-2 text-right">Cena</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, i) in friend.items" :key="i" class="border-b border-gray-100">
                <td class="py-2">{{ item.product_name }}</td>
                <td class="py-2 text-center">{{ item.variant }}</td>
                <td class="py-2 text-center font-medium">{{ item.quantity }}x</td>
                <td class="py-2 text-right">{{ formatPrice(item.price * item.quantity) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </main>
  </div>
</template>

<style>
@media print {
  body {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
}
</style>
