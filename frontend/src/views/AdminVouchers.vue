<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'

const router = useRouter()

// Step management
const step = ref(1) // 1: cycle+discounts, 2: select friends, 3: confirmation

// Step 1 state
const cycles = ref([])
const selectedCycleId = ref('')
const supplierDiscount = ref('')
const appliedDiscount = ref('')
const loading = ref(true)
const error = ref('')

// Step 2 state
const cycleFriends = ref([])
const selectedFriendIds = ref(new Set())
const loadingFriends = ref(false)

// Step 3 state
const createdVouchers = ref([])
const generating = ref(false)

// Voucher list
const allVouchers = ref([])
const showList = ref(false)

const extraDiscount = computed(() => {
  const s = parseFloat(supplierDiscount.value)
  const a = parseFloat(appliedDiscount.value)
  if (isNaN(s) || isNaN(a) || s <= a) return null
  return s - a
})

const canProceedToStep2 = computed(() => {
  return selectedCycleId.value && extraDiscount.value && extraDiscount.value > 0
})

const selectedFriendsWithAmounts = computed(() => {
  if (!extraDiscount.value) return []
  const extra = extraDiscount.value / 100
  const applied = parseFloat(appliedDiscount.value) / 100
  return cycleFriends.value
    .filter(f => selectedFriendIds.value.has(f.id))
    .map(f => {
      const retailTotal = Math.round((f.order_total / (1 - applied)) * 100) / 100
      const voucherAmount = Math.round(retailTotal * extra * 100) / 100
      return { ...f, retailTotal, voucherAmount }
    })
})

const totalVoucherAmount = computed(() => {
  return selectedFriendsWithAmounts.value.reduce((sum, f) => sum + f.voucherAmount, 0)
})

watchEffect(() => {
  document.title = 'Vouchery - Gorifi Admin'
})

onMounted(async () => {
  await loadData()
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [cycleList, vouchers] = await Promise.all([
      api.getCycles(),
      api.getVouchers()
    ])
    // Only show locked/completed cycles
    cycles.value = cycleList.filter(c => c.status === 'locked' || c.status === 'completed')
    allVouchers.value = vouchers
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function goToStep2() {
  if (!canProceedToStep2.value) return
  loadingFriends.value = true
  error.value = ''
  try {
    cycleFriends.value = await api.getVoucherCycleFriends(selectedCycleId.value)
    selectedFriendIds.value = new Set()
    step.value = 2
  } catch (e) {
    error.value = e.message
  } finally {
    loadingFriends.value = false
  }
}

function toggleFriend(friendId) {
  const newSet = new Set(selectedFriendIds.value)
  if (newSet.has(friendId)) {
    newSet.delete(friendId)
  } else {
    newSet.add(friendId)
  }
  selectedFriendIds.value = newSet
}

function toggleAll() {
  if (selectedFriendIds.value.size === cycleFriends.value.length) {
    selectedFriendIds.value = new Set()
  } else {
    selectedFriendIds.value = new Set(cycleFriends.value.map(f => f.id))
  }
}

async function generateVouchers() {
  if (selectedFriendIds.value.size === 0 || generating.value) return
  generating.value = true
  error.value = ''
  try {
    const result = await api.generateVouchers({
      source_cycle_id: parseInt(selectedCycleId.value),
      supplier_discount: parseFloat(supplierDiscount.value),
      applied_discount: parseFloat(appliedDiscount.value),
      friend_ids: Array.from(selectedFriendIds.value)
    })
    createdVouchers.value = result.vouchers
    step.value = 3
    // Refresh voucher list
    allVouchers.value = await api.getVouchers()
  } catch (e) {
    error.value = e.message
  } finally {
    generating.value = false
  }
}

function resetForm() {
  step.value = 1
  selectedCycleId.value = ''
  supplierDiscount.value = ''
  appliedDiscount.value = ''
  cycleFriends.value = []
  selectedFriendIds.value = new Set()
  createdVouchers.value = []
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow">
      <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <h1 class="text-xl font-bold cursor-pointer" @click="router.push('/admin/dashboard')">Gorifi - Admin</h1>
        <div class="flex items-center gap-2">
          <button @click="router.push('/admin/dashboard')" class="px-3 py-1.5 rounded text-sm text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10 transition-colors">
            Dashboard
          </button>
        </div>
      </div>
    </header>

    <div class="max-w-3xl mx-auto px-4 py-8">
      <!-- Error -->
      <div v-if="error" class="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-3 mb-6">
        {{ error }}
      </div>

      <!-- Loading -->
      <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

      <template v-else>
        <!-- Create Voucher Flow -->
        <div class="mb-8">
          <div class="flex items-center justify-between mb-6">
            <h2 class="text-2xl font-bold">Vytvoriť vouchery</h2>
            <button v-if="step !== 1" @click="resetForm" class="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Začať odznova
            </button>
          </div>

          <!-- Step 1: Cycle & Discounts -->
          <div v-if="step === 1" class="space-y-4">
            <div>
              <label class="block text-sm text-muted-foreground mb-1.5">Zdrojový cyklus</label>
              <select v-model="selectedCycleId" class="w-full bg-muted border border-border rounded-lg px-3 py-2.5 text-foreground">
                <option value="" disabled>Vyber cyklus...</option>
                <option v-for="c in cycles" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm text-muted-foreground mb-1.5">Zľava od dodávateľa (%)</label>
                <input v-model="supplierDiscount" type="number" min="0" max="100" step="1" placeholder="35" class="w-full bg-muted border border-border rounded-lg px-3 py-2.5 text-foreground" />
              </div>
              <div>
                <label class="block text-sm text-muted-foreground mb-1.5">Zľava aplikovaná priateľom (%)</label>
                <input v-model="appliedDiscount" type="number" min="0" max="100" step="1" placeholder="30" class="w-full bg-muted border border-border rounded-lg px-3 py-2.5 text-foreground" />
              </div>
            </div>
            <div v-if="extraDiscount" class="bg-green-900/20 border border-green-700/30 rounded-lg px-4 py-3 text-green-400 text-sm">
              Extra zľava na vrátenie: <strong>{{ extraDiscount }}%</strong> z maloobchodnej ceny
            </div>
            <div v-if="extraDiscount !== null && extraDiscount <= 0" class="bg-destructive/10 border border-destructive/30 rounded-lg px-4 py-3 text-destructive text-sm">
              Zľava od dodávateľa musí byť väčšia ako aplikovaná zľava
            </div>
            <button @click="goToStep2" :disabled="!canProceedToStep2 || loadingFriends" class="w-full bg-primary text-primary-foreground font-semibold py-3 rounded-lg transition-colors disabled:opacity-50 hover:bg-primary/90">
              {{ loadingFriends ? 'Načítavam...' : 'Pokračovať — vybrať priateľov' }}
            </button>
          </div>

          <!-- Step 2: Select Friends -->
          <div v-if="step === 2" class="space-y-4">
            <div class="flex justify-between items-center">
              <span class="text-sm text-muted-foreground">Priateľia s objednávkou v tomto cykle</span>
              <button @click="toggleAll" class="text-sm text-primary hover:underline">
                {{ selectedFriendIds.size === cycleFriends.length ? 'Zrušiť výber' : 'Vybrať všetkých' }}
              </button>
            </div>

            <div v-if="cycleFriends.length === 0" class="text-center py-8 text-muted-foreground">
              Žiadni priateľia nemajú objednávku v tomto cykle.
            </div>

            <div v-else class="space-y-2">
              <div
                v-for="friend in cycleFriends"
                :key="friend.id"
                @click="toggleFriend(friend.id)"
                class="flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors"
                :class="selectedFriendIds.has(friend.id) ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30'"
              >
                <div class="flex items-center gap-3">
                  <div class="w-5 h-5 rounded border-2 flex items-center justify-center text-xs transition-colors"
                    :class="selectedFriendIds.has(friend.id) ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30'">
                    <span v-if="selectedFriendIds.has(friend.id)">✓</span>
                  </div>
                  <div>
                    <div class="font-medium">{{ friend.name }}</div>
                    <div class="text-xs text-muted-foreground">Objednávka: {{ friend.order_total.toFixed(2) }} €</div>
                  </div>
                </div>
                <div class="text-right">
                  <div class="font-semibold" :class="selectedFriendIds.has(friend.id) ? 'text-green-400' : 'text-muted-foreground'">
                    {{ (Math.round((friend.order_total / (1 - parseFloat(appliedDiscount) / 100)) * (extraDiscount / 100) * 100) / 100).toFixed(2) }} €
                  </div>
                  <div class="text-xs text-muted-foreground">voucher</div>
                </div>
              </div>
            </div>

            <div v-if="cycleFriends.length > 0" class="flex items-center justify-between pt-4 border-t border-border">
              <div class="text-sm">
                <span class="text-muted-foreground">Vybraných:</span> <strong>{{ selectedFriendIds.size }}</strong> priateľov
                <span class="text-muted-foreground ml-4">Celkom:</span> <strong class="text-green-400">{{ totalVoucherAmount.toFixed(2) }} €</strong>
              </div>
              <button @click="generateVouchers" :disabled="selectedFriendIds.size === 0 || generating" class="bg-primary text-primary-foreground font-semibold px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50 hover:bg-primary/90">
                {{ generating ? 'Vytváram...' : 'Vytvoriť vouchery' }}
              </button>
            </div>
          </div>

          <!-- Step 3: Confirmation -->
          <div v-if="step === 3" class="text-center py-12">
            <div class="text-5xl mb-3">✅</div>
            <div class="text-xl font-bold mb-2">{{ createdVouchers.length }} {{ createdVouchers.length === 1 ? 'voucher vytvorený' : 'vouchery vytvorené' }}</div>
            <div class="text-muted-foreground mb-6">Priateľia uvidia výzvu pri ďalšom otvorení aplikácie</div>
            <button @click="resetForm" class="bg-primary text-primary-foreground font-semibold px-6 py-2.5 rounded-lg hover:bg-primary/90 transition-colors">
              Vytvoriť ďalšie
            </button>
          </div>
        </div>

        <!-- Voucher List -->
        <div class="border-t border-border pt-8">
          <button @click="showList = !showList" class="flex items-center gap-2 text-lg font-semibold mb-4 hover:text-primary transition-colors">
            <span>{{ showList ? '▾' : '▸' }}</span>
            Prehľad voucherov ({{ allVouchers.length }})
          </button>

          <div v-if="showList && allVouchers.length > 0" class="space-y-2">
            <div v-for="v in allVouchers" :key="v.id" class="flex items-center justify-between p-3 rounded-lg border border-border">
              <div>
                <div class="font-medium">{{ v.friend_name }}</div>
                <div class="text-xs text-muted-foreground">{{ v.cycle_name }}</div>
              </div>
              <div class="flex items-center gap-3">
                <div class="font-semibold">{{ v.voucher_amount.toFixed(2) }} €</div>
                <span class="text-xs px-2 py-0.5 rounded-full"
                  :class="{
                    'bg-yellow-500/20 text-yellow-400': v.status === 'pending',
                    'bg-green-500/20 text-green-400': v.status === 'accepted',
                    'bg-muted text-muted-foreground': v.status === 'declined'
                  }">
                  {{ v.status === 'pending' ? 'Čaká' : v.status === 'accepted' ? 'Prijatý' : 'Odmietnutý' }}
                </span>
              </div>
            </div>
          </div>
          <div v-if="showList && allVouchers.length === 0" class="text-center py-6 text-muted-foreground">
            Zatiaľ neboli vytvorené žiadne vouchery.
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
