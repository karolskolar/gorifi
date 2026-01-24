<script setup>
import { ref, computed, watch } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import BalanceBadge from './BalanceBadge.vue'

const props = defineProps({
  open: Boolean,
  transaction: Object,
  currentBalance: {
    type: Number,
    default: 0
  }
})

const emit = defineEmits(['update:open', 'submit', 'delete'])

const amount = ref('')
const note = ref('')
const selectedDate = ref(new Date())
const loading = ref(false)

const originalAmount = computed(() => props.transaction?.amount || 0)

const newBalance = computed(() => {
  const amountNum = parseFloat(amount.value) || 0
  // Balance change = new amount - original amount
  return props.currentBalance - originalAmount.value + amountNum
})

const formattedDate = computed(() => {
  const dateStr = selectedDate.value.toLocaleDateString('sk-SK', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric'
  })
  const dayOfWeek = selectedDate.value.toLocaleDateString('sk-SK', {
    weekday: 'long'
  })
  return `${dateStr} (${dayOfWeek})`
})

const transactionTypeLabel = computed(() => {
  switch (props.transaction?.type) {
    case 'payment': return 'Platba'
    case 'adjustment': return 'Kredit'
    default: return 'Transakcia'
  }
})

function changeDate(days) {
  const newDate = new Date(selectedDate.value)
  newDate.setDate(newDate.getDate() + days)
  selectedDate.value = newDate
}

watch(() => props.open, (isOpen) => {
  if (isOpen && props.transaction) {
    amount.value = Math.abs(props.transaction.amount).toString()
    note.value = props.transaction.note || ''
    selectedDate.value = new Date(props.transaction.created_at)
  }
})

async function handleSubmit() {
  const amountNum = parseFloat(amount.value)
  if (!amountNum || amountNum <= 0) return

  loading.value = true
  try {
    await emit('submit', {
      id: props.transaction.id,
      amount: amountNum,
      note: note.value.trim() || null,
      date: selectedDate.value.toISOString()
    })
    emit('update:open', false)
  } finally {
    loading.value = false
  }
}

async function handleDelete() {
  if (!confirm('Naozaj chcete vymazať túto transakciu?')) return

  loading.value = true
  try {
    await emit('delete', props.transaction.id)
    emit('update:open', false)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Upraviť {{ transactionTypeLabel.toLowerCase() }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-4 py-4">
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Aktuálny zostatok:</span>
          <BalanceBadge :balance="currentBalance" />
        </div>

        <div class="space-y-2">
          <Label>Dátum</Label>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              type="button"
              @click="changeDate(-1)"
              class="h-9 w-9"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
              </svg>
            </Button>
            <div class="flex-1 text-center font-medium py-2 px-3 border rounded-md bg-background">
              {{ formattedDate }}
            </div>
            <Button
              variant="outline"
              size="icon"
              type="button"
              @click="changeDate(1)"
              class="h-9 w-9"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
            </Button>
          </div>
        </div>

        <div class="space-y-2">
          <Label>Suma (EUR)</Label>
          <Input
            v-model="amount"
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            @keyup.enter="handleSubmit"
          />
        </div>

        <div class="space-y-2">
          <Label>Poznámka{{ transaction?.type === 'adjustment' ? ' (povinné)' : ' (voliteľné)' }}</Label>
          <Input
            v-model="note"
            placeholder="napr. Prevod"
            maxlength="160"
            @keyup.enter="handleSubmit"
          />
        </div>

        <div v-if="parseFloat(amount)" class="flex items-center gap-2 text-sm">
          <span>Nový zostatok:</span>
          <BalanceBadge :balance="newBalance" />
        </div>
      </div>
      <DialogFooter class="flex justify-between sm:justify-between">
        <Button variant="destructive" @click="handleDelete" :disabled="loading">
          Vymazať
        </Button>
        <div class="flex gap-2">
          <Button variant="outline" @click="$emit('update:open', false)" :disabled="loading">
            Zrušiť
          </Button>
          <Button @click="handleSubmit" :disabled="!parseFloat(amount) || parseFloat(amount) <= 0 || loading">
            {{ loading ? 'Ukladám...' : 'Uložiť' }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
