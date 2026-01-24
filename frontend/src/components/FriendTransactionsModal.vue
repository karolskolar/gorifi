<script setup>
import { ref, watch } from 'vue'
import api from '../api'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import BalanceBadge from './BalanceBadge.vue'

const props = defineProps({
  open: Boolean,
  friendId: {
    type: [Number, String],
    required: true
  },
  balance: {
    type: Number,
    default: 0
  }
})

defineEmits(['update:open'])

const transactions = ref([])
const loading = ref(false)
const error = ref('')

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    await loadAllTransactions()
  }
})

async function loadAllTransactions() {
  if (!props.friendId) return

  loading.value = true
  error.value = ''
  try {
    transactions.value = await api.getTransactions(props.friendId)
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
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="max-w-lg max-h-[80vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Všetky transakcie</DialogTitle>
      </DialogHeader>

      <div class="flex items-center gap-2 py-2 border-b">
        <span class="text-sm text-muted-foreground">Zostatok:</span>
        <BalanceBadge :balance="balance" />
      </div>

      <div v-if="error" class="text-red-500 text-sm py-4">{{ error }}</div>

      <div v-else-if="loading" class="text-center py-8 text-muted-foreground">Načítavam...</div>

      <div v-else-if="transactions.length === 0" class="text-center py-8 text-muted-foreground">
        Žiadne transakcie
      </div>

      <div v-else class="divide-y">
        <div
          v-for="tx in transactions"
          :key="tx.id"
          class="py-3 flex items-center gap-2"
        >
          <span class="text-sm text-muted-foreground w-24 shrink-0">{{ formatDate(tx.created_at) }}</span>
          <span class="text-sm font-medium w-20 shrink-0">{{ getTransactionTypeLabel(tx.type) }}</span>
          <span class="flex-1 text-xs text-muted-foreground truncate">{{ tx.cycle_name || tx.note || '' }}</span>
          <span
            :class="[
              'text-sm font-medium whitespace-nowrap text-right shrink-0',
              tx.amount > 0 ? 'text-green-600' : 'text-red-600'
            ]"
          >
            {{ formatAmount(tx.amount) }}
          </span>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
