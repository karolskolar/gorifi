<script setup>
import { ref, onMounted, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import BalanceBadge from '@/components/BalanceBadge.vue'

const route = useRoute()
const router = useRouter()

const cycle = ref(null)
const distribution = ref([])
const loading = ref(true)
const error = ref('')
const packingOrderId = ref(null)
const checkedItems = ref({}) // { `${friendId}-${itemIndex}`: true }

const cycleId = route.params.id

onMounted(async () => {
  await loadData()
})

async function loadData() {
  try {
    const data = await api.getCycleDistribution(cycleId)
    cycle.value = data.cycle
    distribution.value = data.distribution
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Set page title
watchEffect(() => {
  document.title = 'Distribúcia - Gorifi Admin'
})

async function togglePacked(friend) {
  if (packingOrderId.value) return

  packingOrderId.value = friend.order_id
  error.value = ''
  try {
    await api.togglePacked(friend.order_id)
    await loadData()
  } catch (e) {
    error.value = e.message
  } finally {
    packingOrderId.value = null
  }
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

function toggleItem(friendId, index) {
  const key = `${friendId}-${index}`
  checkedItems.value = { ...checkedItems.value, [key]: !checkedItems.value[key] }
}

function isItemChecked(friendId, index) {
  return !!checkedItems.value[`${friendId}-${index}`]
}

function checkedCount(friend) {
  return friend.items.reduce((sum, _, i) => sum + (isItemChecked(friend.id, i) ? 1 : 0), 0)
}

function printDistribution() {
  window.print()
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Header (hidden when printing) -->
    <header class="bg-primary text-primary-foreground shadow print:hidden">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div class="flex items-center gap-4">
          <Button variant="ghost" size="icon" @click="router.push(`/admin/cycle/${cycleId}`)" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <h1 class="text-xl font-bold">Distribúcia - {{ cycle?.name || 'Načítavam...' }}</h1>
        </div>
        <Button variant="secondary" @click="printDistribution">
          Tlačiť
        </Button>
      </div>
    </header>

    <!-- Print header -->
    <div class="hidden print:block p-4 border-b">
      <h1 class="text-2xl font-bold">Distribúcia - {{ cycle?.name }}</h1>
    </div>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-6 print:max-w-none print:p-4">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <div v-else class="space-y-4">
        <Card
          v-for="friend in distribution"
          :key="friend.id"
          :class="[
            'print:shadow-none print:border print:break-inside-avoid',
            friend.packed ? 'opacity-50' : ''
          ]"
        >
          <CardContent class="p-4">
            <div class="flex justify-between items-start mb-3">
              <div>
                <h3 class="text-lg font-semibold">{{ friend.name }}</h3>
                <div class="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                  <BalanceBadge :balance="friend.balance || 0" />
                  <Badge v-if="friend.paid" variant="default" class="bg-green-600">Zaplatené</Badge>
                  <Badge v-else variant="destructive">Nezaplatené</Badge>
                  <span>{{ formatPrice(friend.total) }}</span>
                  <Badge
                    v-if="friend.pickup_location_name || friend.pickup_location_note"
                    variant="outline"
                    class="border-blue-400 text-blue-600 bg-blue-50"
                  >
                    {{ friend.pickup_location_name || friend.pickup_location_note }}
                  </Badge>
                  <Badge
                    v-if="friend.packeta_address"
                    variant="outline"
                    class="border-red-400 text-red-600 bg-red-50"
                  >
                    Packeta
                  </Badge>
                  <span v-if="!friend.packed && friend.items.length > 0" class="text-xs">· {{ checkedCount(friend) }}/{{ friend.items.length }} ✓</span>
                </div>
                <div v-if="friend.packeta_address" class="text-sm text-muted-foreground mt-1">
                  📦 {{ friend.packeta_address }}
                </div>
              </div>
              <Button
                @click="togglePacked(friend)"
                :variant="friend.packed ? 'default' : 'outline'"
                :disabled="packingOrderId === friend.order_id"
                size="sm"
                :class="[
                  'print:hidden shrink-0',
                  friend.packed ? 'bg-green-600 hover:bg-green-700' : ''
                ]"
              >
                {{ packingOrderId === friend.order_id ? '...' : (friend.packed ? 'Zabalené' : 'Zabaliť') }}
              </Button>
            </div>

            <template v-if="!friend.packed">
              <div v-if="friend.items.length === 0" class="text-muted-foreground italic">
                Žiadne položky
              </div>
              <div v-else class="flex flex-col gap-1.5">
                <div
                  v-for="(item, i) in friend.items"
                  :key="i"
                  @click="toggleItem(friend.id, i)"
                  class="flex items-center gap-2.5 border rounded-lg px-3 py-2.5 cursor-pointer transition-all select-none print:border-gray-300"
                  :class="isItemChecked(friend.id, i)
                    ? 'bg-green-50 border-green-200 opacity-50 dark:bg-green-950/20 dark:border-green-800'
                    : 'bg-card border-border hover:border-muted-foreground/30'"
                >
                  <input
                    type="checkbox"
                    :checked="isItemChecked(friend.id, i)"
                    class="w-5 h-5 accent-green-500 shrink-0 pointer-events-none print:hidden"
                  />
                  <div class="flex-1 min-w-0" :class="isItemChecked(friend.id, i) ? 'line-through' : ''">
                    <div class="font-semibold text-sm">{{ item.product_name }}<span v-if="item.variant_label" class="font-normal text-muted-foreground"> — {{ item.variant_label }}</span></div>
                    <div class="flex gap-1 mt-1 flex-wrap">
                      <Badge
                        v-if="item.purpose"
                        variant="outline"
                        class="text-[11px] px-1.5 py-0"
                        :class="{
                          'border-stone-400 text-stone-600 bg-stone-50': item.purpose === 'Espresso',
                          'border-sky-400 text-sky-600 bg-sky-50': item.purpose === 'Filter',
                          'border-amber-400 text-amber-600 bg-amber-50': item.purpose === 'Kapsule' || item.purpose === 'Slané',
                          'border-pink-400 text-pink-600 bg-pink-50': item.purpose === 'Sladké'
                        }"
                      >
                        {{ item.purpose }}
                      </Badge>
                      <Badge
                        v-if="item.roast_type"
                        variant="outline"
                        class="text-[11px] px-1.5 py-0 border-amber-300 text-amber-700 bg-amber-50"
                      >
                        {{ item.roast_type }}
                      </Badge>
                      <Badge variant="outline" class="text-[11px] px-1.5 py-0 border-green-400 text-green-700 bg-green-50 font-semibold">
                        {{ item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant) }} × {{ item.quantity }}
                      </Badge>
                    </div>
                  </div>
                </div>
              </div>
            </template>

            <!-- Print-only table fallback -->
            <template v-if="!friend.packed && friend.items.length > 0">
              <table class="hidden print:table w-full text-sm mt-2">
                <thead>
                  <tr class="border-b">
                    <th class="text-left py-1">Produkt</th>
                    <th class="text-left py-1">Praženie</th>
                    <th class="text-center py-1">Varianta</th>
                    <th class="text-center py-1">Počet</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(item, i) in friend.items" :key="'print-'+i" class="border-b border-gray-200">
                    <td class="py-1">{{ item.product_name }}<span v-if="item.variant_label"> — {{ item.variant_label }}</span></td>
                    <td class="py-1">{{ item.roast_type || '-' }}</td>
                    <td class="text-center py-1">{{ item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant) }}</td>
                    <td class="text-center py-1">{{ item.quantity }}×</td>
                  </tr>
                </tbody>
              </table>
            </template>
          </CardContent>
        </Card>
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
