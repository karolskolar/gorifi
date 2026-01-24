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
const loading = ref(false)

const newBalance = computed(() => {
  const amountNum = parseFloat(amount.value) || 0
  return props.currentBalance + amountNum
})

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    selectedOrderId.value = ''
    amount.value = ''
    note.value = ''
  }
})

async function handleSubmit() {
  const amountNum = parseFloat(amount.value)
  if (!amountNum || amountNum === 0) return
  if (!note.value.trim()) return

  loading.value = true
  try {
    await emit('submit', {
      order_id: selectedOrderId.value || null,
      amount: amountNum,
      note: note.value.trim()
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
        <DialogTitle>Pridať kredit pre {{ friend?.name }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-4 py-4">
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Aktuálny zostatok:</span>
          <BalanceBadge :balance="currentBalance" />
        </div>

        <div class="space-y-2">
          <Label>Objednávka (voliteľné)</Label>
          <Select v-model="selectedOrderId">
            <SelectTrigger>
              <SelectValue placeholder="Vyberte objednávku..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Žiadna</SelectItem>
              <SelectItem v-for="order in orders" :key="order.id" :value="String(order.id)">
                {{ order.cycle_name }} - {{ formatPrice(order.total) }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="space-y-2">
          <Label>Suma kreditu (EUR)</Label>
          <Input
            v-model="amount"
            type="number"
            step="0.01"
            placeholder="0.00"
            @keyup.enter="handleSubmit"
          />
          <p class="text-xs text-muted-foreground">Kladná hodnota = kredit, záporná = odpočet</p>
        </div>

        <div class="space-y-2">
          <Label>Dôvod (povinné)</Label>
          <Input
            v-model="note"
            placeholder="napr. Ethiopia chýba"
            maxlength="160"
            @keyup.enter="handleSubmit"
          />
        </div>

        <div v-if="parseFloat(amount)" class="flex items-center gap-2 text-sm">
          <span>Nový zostatok:</span>
          <BalanceBadge :balance="newBalance" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="$emit('update:open', false)" :disabled="loading">
          Zrušiť
        </Button>
        <Button @click="handleSubmit" :disabled="!parseFloat(amount) || !note.trim() || loading">
          {{ loading ? 'Ukladám...' : 'Potvrdiť' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
