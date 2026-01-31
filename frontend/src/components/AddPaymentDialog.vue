<script setup>
import { ref, computed, watch } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import BalanceBadge from './BalanceBadge.vue'

const props = defineProps({
  open: Boolean,
  friend: Object,
  orders: {
    type: Array,
    default: () => []
  },
  currentBalance: {
    type: Number,
    default: 0
  }
})

const emit = defineEmits(['update:open', 'submit'])

const selectedOrderId = ref('')
const amount = ref('')
const note = ref('')
const selectedDate = ref(new Date())
const loading = ref(false)

const newBalance = computed(() => {
  const amountNum = parseFloat(amount.value) || 0
  return props.currentBalance + amountNum
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

function changeDate(days) {
  const newDate = new Date(selectedDate.value)
  newDate.setDate(newDate.getDate() + days)
  selectedDate.value = newDate
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    selectedOrderId.value = ''
    amount.value = ''
    note.value = ''
    selectedDate.value = new Date()
  }
})

async function handleSubmit() {
  const amountNum = parseFloat(amount.value)
  if (!amountNum || amountNum <= 0) return

  loading.value = true
  try {
    await emit('submit', {
      order_id: selectedOrderId.value && selectedOrderId.value !== 'none' ? selectedOrderId.value : null,
      amount: amountNum,
      note: note.value.trim() || null,
      date: selectedDate.value.toISOString()
    })
    emit('update:open', false)
  } finally {
    loading.value = false
  }
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}
</script>

<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Pridať platbu pre {{ friend?.name }}</DialogTitle>
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
          <Label>Objednávka (voliteľné)</Label>
          <Select v-model="selectedOrderId">
            <SelectTrigger>
              <SelectValue placeholder="Vyberte objednávku..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Žiadna</SelectItem>
              <SelectItem v-for="order in orders" :key="order.id" :value="String(order.id)">
                {{ order.cycle_name }} - {{ formatPrice(order.total) }}
              </SelectItem>
            </SelectContent>
          </Select>
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
          <Label>Poznámka (voliteľné)</Label>
          <Input
            v-model="note"
            placeholder="napr. Prevod"
            maxlength="160"
            @keyup.enter="handleSubmit"
          />
        </div>

        <div v-if="parseFloat(amount) > 0" class="flex items-center gap-2 text-sm">
          <span>Nový zostatok:</span>
          <BalanceBadge :balance="newBalance" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="$emit('update:open', false)" :disabled="loading">
          Zrušiť
        </Button>
        <Button @click="handleSubmit" :disabled="!parseFloat(amount) || parseFloat(amount) <= 0 || loading">
          {{ loading ? 'Ukladám...' : 'Potvrdiť' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
