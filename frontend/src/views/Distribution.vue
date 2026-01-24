<script setup>
import { ref, onMounted, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import BalanceBadge from '@/components/BalanceBadge.vue'

const route = useRoute()
const router = useRouter()

const cycle = ref(null)
const distribution = ref([])
const loading = ref(true)
const error = ref('')
const packingOrderId = ref(null)

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
  document.title = 'Admin'
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
                  <span class="mx-1">|</span>
                  <Badge v-if="friend.paid" variant="default" class="bg-green-600">Zaplatené</Badge>
                  <Badge v-else variant="destructive">Nezaplatené</Badge>
                  <span class="mx-1">|</span>
                  <span>Suma: {{ formatPrice(friend.total) }}</span>
                </div>
              </div>
              <Button
                @click="togglePacked(friend)"
                :variant="friend.packed ? 'default' : 'outline'"
                :disabled="packingOrderId === friend.order_id"
                :class="[
                  'print:hidden',
                  friend.packed ? 'bg-green-600 hover:bg-green-700' : ''
                ]"
              >
                {{ packingOrderId === friend.order_id ? 'Spracovávam...' : (friend.packed ? 'Zabalené' : 'Označiť ako zabalené') }}
              </Button>
            </div>

            <div v-if="friend.items.length === 0" class="text-muted-foreground italic">
              Žiadne položky
            </div>
            <Table v-else>
              <TableHeader>
                <TableRow>
                  <TableHead>Produkt</TableHead>
                  <TableHead class="text-center">Varianta</TableHead>
                  <TableHead class="text-center">Pocet</TableHead>
                  <TableHead class="text-right">Cena</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="(item, i) in friend.items" :key="i">
                  <TableCell>{{ item.product_name }}</TableCell>
                  <TableCell class="text-center">{{ item.variant }}</TableCell>
                  <TableCell class="text-center font-medium">{{ item.quantity }}x</TableCell>
                  <TableCell class="text-right">{{ formatPrice(item.price * item.quantity) }}</TableCell>
                </TableRow>
              </TableBody>
              <tfoot>
                <TableRow class="bg-muted font-semibold">
                  <TableCell colspan="2">Celkom balickov</TableCell>
                  <TableCell class="text-center">{{ friend.items.reduce((sum, item) => sum + item.quantity, 0) }}</TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </tfoot>
            </Table>
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
