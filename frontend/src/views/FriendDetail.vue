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
import AddPaymentDialog from '@/components/AddPaymentDialog.vue'
import AddAdjustmentDialog from '@/components/AddAdjustmentDialog.vue'
import EditTransactionDialog from '@/components/EditTransactionDialog.vue'

const route = useRoute()
const router = useRouter()

const friend = ref(null)
const transactions = ref([])
const orders = ref([])
const loading = ref(true)
const error = ref('')

const showPaymentDialog = ref(false)
const showAdjustmentDialog = ref(false)
const showEditDialog = ref(false)
const editingTransaction = ref(null)

const friendId = route.params.id

onMounted(async () => {
  await loadData()
})

watchEffect(() => {
  document.title = friend.value ? `${friend.value.name} - Admin` : 'Admin'
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.getFriendDetail(friendId)
    friend.value = data.friend
    transactions.value = data.transactions
    orders.value = data.orders
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function handleAddPayment(data) {
  try {
    await api.addPayment(friendId, data.amount, data.note, data.date)
    await loadData()
  } catch (e) {
    error.value = e.message
  }
}

async function handleAddAdjustment(data) {
  try {
    await api.addAdjustment(friendId, data.order_id, data.amount, data.note)
    await loadData()
  } catch (e) {
    error.value = e.message
  }
}

function openEditDialog(tx) {
  editingTransaction.value = tx
  showEditDialog.value = true
}

async function handleEditTransaction(data) {
  try {
    await api.updateTransaction(data.id, {
      amount: data.amount,
      note: data.note,
      date: data.date
    })
    await loadData()
  } catch (e) {
    error.value = e.message
  }
}

async function handleDeleteTransaction(id) {
  try {
    await api.deleteTransaction(id)
    await loadData()
  } catch (e) {
    error.value = e.message
  }
}

function formatPrice(price) {
  return price != null ? `${price.toFixed(2)} EUR` : '-'
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString('sk-SK', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric'
  })
}

function getTransactionTypeLabel(type) {
  switch (type) {
    case 'payment': return 'Platba'
    case 'charge': return 'Účtovanie'
    case 'adjustment': return 'Kredit'
    default: return type
  }
}

function getTransactionTypeVariant(type) {
  switch (type) {
    case 'payment': return 'default'
    case 'charge': return 'secondary'
    case 'adjustment': return 'outline'
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
          <Button variant="ghost" size="icon" @click="router.push('/admin/friends')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <h1 class="text-xl font-bold">{{ friend?.name || 'Načítavam...' }}</h1>
        </div>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-7xl mx-auto px-4 py-6">
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <template v-else-if="friend">
        <!-- Balance and Actions -->
        <Card class="mb-6">
          <CardContent class="p-4">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div class="flex items-center gap-3">
                <span class="text-lg">Zostatok:</span>
                <BalanceBadge :balance="friend.balance" class="text-lg" />
              </div>
              <div class="flex gap-2">
                <Button @click="showPaymentDialog = true">
                  + Pridať platbu
                </Button>
                <Button variant="outline" @click="showAdjustmentDialog = true">
                  + Pridať kredit
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Transactions -->
        <h2 class="text-lg font-semibold mb-3">Transakcie</h2>
        <Card class="mb-6">
          <div v-if="transactions.length === 0" class="p-6 text-center text-muted-foreground">
            Žiadne transakcie
          </div>
          <Table v-else>
            <TableHeader>
              <TableRow>
                <TableHead>Dátum</TableHead>
                <TableHead>Typ</TableHead>
                <TableHead class="text-right">Suma</TableHead>
                <TableHead>Poznámka</TableHead>
                <TableHead>Objednávka</TableHead>
                <TableHead class="text-right">Akcie</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="tx in transactions" :key="tx.id">
                <TableCell class="text-sm">{{ formatDate(tx.created_at) }}</TableCell>
                <TableCell>
                  <Badge :variant="getTransactionTypeVariant(tx.type)">
                    {{ getTransactionTypeLabel(tx.type) }}
                  </Badge>
                </TableCell>
                <TableCell class="text-right">
                  <span :class="tx.amount > 0 ? 'text-green-600' : 'text-red-600'">
                    {{ tx.amount > 0 ? '+' : '' }}{{ tx.amount.toFixed(2) }} EUR
                  </span>
                </TableCell>
                <TableCell class="text-sm text-muted-foreground max-w-xs truncate">
                  {{ tx.note || '-' }}
                </TableCell>
                <TableCell class="text-sm">
                  <span v-if="tx.cycle_name" class="text-muted-foreground">{{ tx.cycle_name }}</span>
                  <span v-else>-</span>
                </TableCell>
                <TableCell class="text-right">
                  <Button
                    v-if="tx.type !== 'charge'"
                    variant="ghost"
                    size="sm"
                    @click="openEditDialog(tx)"
                  >
                    Upraviť
                  </Button>
                  <span v-else class="text-muted-foreground text-sm">-</span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>

        <!-- Orders -->
        <h2 class="text-lg font-semibold mb-3">Objednávky</h2>
        <Card>
          <div v-if="orders.length === 0" class="p-6 text-center text-muted-foreground">
            Žiadne objednávky
          </div>
          <Table v-else>
            <TableHeader>
              <TableRow>
                <TableHead>Cyklus</TableHead>
                <TableHead class="text-right">Suma</TableHead>
                <TableHead class="text-center">Zaplatené</TableHead>
                <TableHead class="text-center">Zabalené</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="order in orders" :key="order.id">
                <TableCell class="font-medium">{{ order.cycle_name }}</TableCell>
                <TableCell class="text-right">{{ formatPrice(order.total) }}</TableCell>
                <TableCell class="text-center">
                  <Badge v-if="order.paid" variant="default" class="bg-green-600">Áno</Badge>
                  <Badge v-else variant="secondary">Nie</Badge>
                </TableCell>
                <TableCell class="text-center">
                  <Badge v-if="order.packed" variant="default" class="bg-green-600">Áno</Badge>
                  <Badge v-else variant="secondary">Nie</Badge>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      </template>
    </main>

    <!-- Dialogs -->
    <AddPaymentDialog
      v-model:open="showPaymentDialog"
      :friend="friend"
      :current-balance="friend?.balance || 0"
      @submit="handleAddPayment"
    />

    <AddAdjustmentDialog
      v-model:open="showAdjustmentDialog"
      :friend="friend"
      :orders="orders"
      :current-balance="friend?.balance || 0"
      @submit="handleAddAdjustment"
    />

    <EditTransactionDialog
      v-model:open="showEditDialog"
      :transaction="editingTransaction"
      :current-balance="friend?.balance || 0"
      @submit="handleEditTransaction"
      @delete="handleDeleteTransaction"
    />
  </div>
</template>
