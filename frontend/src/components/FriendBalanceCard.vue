<script setup>
import { ref, onMounted, watch } from 'vue'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import BalanceBadge from './BalanceBadge.vue'
import FriendTransactionsModal from './FriendTransactionsModal.vue'

const props = defineProps({
  friendId: {
    type: [Number, String],
    required: true
  }
})

const balance = ref(0)
const transactions = ref([])
const loading = ref(true)
const error = ref('')
const showModal = ref(false)

onMounted(async () => {
  await loadBalance()
})

watch(() => props.friendId, async () => {
  await loadBalance()
})

async function loadBalance() {
  if (!props.friendId) return

  loading.value = true
  error.value = ''
  try {
    const data = await api.getFriendBalance(props.friendId)
    balance.value = data.balance
    transactions.value = data.transactions
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleDateString('sk-SK', {
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

function formatAmount(amount) {
  const sign = amount > 0 ? '+' : ''
  return `${sign}${amount.toFixed(2)} EUR`
}
</script>

<template>
  <Card class="mb-4">
    <CardContent class="p-4">
      <div class="flex items-center justify-between mb-3">
        <span class="text-sm font-medium text-muted-foreground uppercase tracking-wide">Môj účet</span>
        <BalanceBadge v-if="!loading" :balance="balance" class="text-base" />
        <span v-else class="text-muted-foreground text-sm">Načítavam...</span>
      </div>

      <div v-if="error" class="text-red-500 text-sm mb-2">{{ error }}</div>

      <div v-else-if="!loading">
        <Button
          variant="outline"
          size="sm"
          class="w-full mt-1"
          @click="showModal = true"
        >
          Zobraziť transakcie
        </Button>
      </div>
    </CardContent>
  </Card>

  <FriendTransactionsModal
    v-model:open="showModal"
    :friend-id="friendId"
    :balance="balance"
  />
</template>
