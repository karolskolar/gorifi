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
// Per-item in-flight map ("own:12" / "guest:12" -> true). Keyed per item on
// purpose: tapping item B while item A's PATCH is still in flight must work — an
// admin ticking off a 30-friend list on a phone taps faster than the round trips
// complete. The `own:` / `guest:` prefix is not decoration: `order_items.id` and
// `guest_order_items.id` are independent sequences, so a bare id would let an own
// item and a guest bag on the same card share one pending flag (and one v-for key).
const pendingItems = ref({})

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
  // A host with no own order has no `orders` row, so there is no whole-order flag to
  // write (§Edge Cases) — the template offers no button for them, and this is the
  // second line of defence against PATCHing /api/orders/null/packed.
  if (!friend.order_id) return
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

function itemKey(kind, item) {
  return `${kind}:${item.id}`
}

function isItemPending(kind, item) {
  return !!pendingItems.value[itemKey(kind, item)]
}

function setItemPending(key, value) {
  const next = { ...pendingItems.value }
  if (value) next[key] = true
  else delete next[key]
  pendingItems.value = next
}

// A host's packing list, in the order the bags are assembled: their own items first,
// then ONE GROUP PER GUEST so the bags can be pre-separated (§Frontend / UC-GSO-011).
// Cancelled sub-orders never arrive here — the server drops them, because a
// called-off bag is neither handed over nor a blocker for the gate.
function itemGroups(friend) {
  const groups = []
  if (friend.items && friend.items.length > 0) {
    groups.push({ key: 'own', kind: 'own', guest: null, items: friend.items })
  }
  for (const guest of friend.guest_orders || []) {
    groups.push({ key: `guest-${guest.id}`, kind: 'guest', guest, items: guest.items || [] })
  }
  return groups
}

// Flattened { group, item } pairs — for the counters and the print table, which need
// one list but must still name the guest each line belongs to.
function allItemEntries(friend) {
  return itemGroups(friend).flatMap(group => group.items.map(item => ({ group, item })))
}

function hasGuestBags(friend) {
  return (friend.guest_orders || []).length > 0
}

// Persisted per-item packing state: toggle on the server
// (`order_items.packed` / `guest_order_items.packed`) so the "X/Y ✓" counter, the
// un-pack-on-uncheck behaviour and the "Zabaliť" gating all reflect durable state
// (survives refresh / other device).
// The response carries the updated item plus the HOST order's packed flag, so we
// patch just those two values locally instead of re-fetching the whole distribution
// (1 + N queries and a full re-render) on every tap.
async function toggleItem(friend, group, item) {
  const key = itemKey(group.kind, item)
  // `friend.order_id` is null for a host with no own order, and `packingOrderId` is
  // null while idle — without the first check, `null === null` would freeze every
  // checkbox on such a card.
  if (pendingItems.value[key]) return
  if (friend.order_id && packingOrderId.value === friend.order_id) return

  setItemPending(key, true)
  error.value = ''
  try {
    const updated = group.kind === 'guest'
      ? await api.toggleGuestItemPacked(item.id)
      : await api.toggleItemPacked(item.id)
    item.packed = updated.packed ? 1 : 0
    // Unchecking either kind of item un-packs the host's order server-side; both
    // endpoints answer with the resulting flag.
    friend.packed = updated.order_packed ? 1 : 0
  } catch (e) {
    error.value = e.message
    // Never leave the UI claiming a state that was not persisted.
    await loadData()
  } finally {
    setItemPending(key, false)
  }
}

function isItemChecked(item) {
  return !!item.packed
}

function totalItemCount(friend) {
  return allItemEntries(friend).length
}

function checkedCount(friend) {
  return allItemEntries(friend).reduce((sum, entry) => sum + (entry.item.packed ? 1 : 0), 0)
}

// The "Zabaliť" gate, mirroring the server's 409: every own item AND every item of
// every (non-cancelled) guest bag under this host must be checked, and there has to
// be at least one item.
function allItemsChecked(friend) {
  const entries = allItemEntries(friend)
  return entries.length > 0 && entries.every(entry => entry.item.packed)
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
                  <!-- A host with no own order (§Edge Cases) is still the pickup
                       party, but has nothing of their own to pay for — a red
                       "Nezaplatené" badge on a 0 EUR non-order would be a lie. -->
                  <template v-if="friend.has_own_order !== false">
                    <Badge v-if="friend.paid" variant="default" class="bg-green-600">Zaplatené</Badge>
                    <Badge v-else variant="destructive">Nezaplatené</Badge>
                    <span>{{ formatPrice(friend.total) }}</span>
                  </template>
                  <Badge
                    v-else
                    variant="outline"
                    class="border-violet-400 text-violet-700 bg-violet-50"
                  >
                    Bez vlastnej objednávky
                  </Badge>
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
                  <span v-if="!friend.packed && totalItemCount(friend) > 0" class="text-xs">· {{ checkedCount(friend) }}/{{ totalItemCount(friend) }} ✓</span>
                </div>
                <div v-if="friend.packeta_address" class="text-sm text-muted-foreground mt-1">
                  📦 {{ friend.packeta_address }}
                </div>
              </div>
              <!-- No `orders` row ⇒ nowhere to store a whole-order packed flag, so
                   no button. Such a host's packing record is the per-bag
                   checkboxes below. -->
              <Button
                v-if="friend.has_own_order !== false"
                @click="togglePacked(friend)"
                :variant="friend.packed ? 'default' : 'outline'"
                :disabled="packingOrderId === friend.order_id || (!friend.packed && !allItemsChecked(friend))"
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
              <div v-if="totalItemCount(friend) === 0" class="text-muted-foreground italic">
                Žiadne položky
              </div>
              <!-- One block per group: the host's own items, then one per guest, so
                   the bags can be pre-separated during packing (§UC-GSO-011). -->
              <div v-else class="flex flex-col gap-3">
                <div v-for="group in itemGroups(friend)" :key="group.key" class="flex flex-col gap-1.5">
                  <div
                    v-if="group.kind === 'guest'"
                    class="flex items-center gap-2 flex-wrap text-sm text-muted-foreground"
                  >
                    <Badge variant="outline" class="text-xs border-violet-400 text-violet-700 bg-violet-50">
                      Hosť • {{ group.guest.guest_name }}
                    </Badge>
                    <span class="text-xs">{{ formatPrice(group.guest.total) }}</span>
                    <Badge
                      v-if="group.guest.paid"
                      variant="outline"
                      class="text-xs border-green-400 text-green-700 bg-green-50"
                    >
                      Zaplatené
                    </Badge>
                    <Badge
                      v-else
                      variant="outline"
                      class="text-xs border-amber-400 text-amber-700 bg-amber-50"
                    >
                      Nezaplatené
                    </Badge>
                  </div>
                  <!-- Only worth labelling the host's own bag when there are guest
                       bags next to it. -->
                  <div v-else-if="hasGuestBags(friend)" class="text-xs text-muted-foreground">
                    Vlastná objednávka
                  </div>
                  <div
                    v-for="item in group.items"
                    :key="group.key + '-' + item.id"
                    :data-owner="group.kind"
                    @click="toggleItem(friend, group, item)"
                    :aria-busy="isItemPending(group.kind, item)"
                    class="flex items-center gap-2.5 border rounded-lg px-3 py-2.5 cursor-pointer transition-all select-none print:border-gray-300"
                    :class="[
                      isItemChecked(item)
                        ? 'bg-green-50 border-green-200 opacity-50 dark:bg-green-950/20 dark:border-green-800'
                        : 'bg-card border-border hover:border-muted-foreground/30',
                      isItemPending(group.kind, item) ? 'animate-pulse ring-2 ring-primary/40 print:ring-0 print:animate-none' : ''
                    ]"
                  >
                    <input
                      type="checkbox"
                      :checked="isItemChecked(item)"
                      class="w-5 h-5 accent-green-500 shrink-0 pointer-events-none print:hidden"
                    />
                    <div class="flex-1 min-w-0" :class="isItemChecked(item) ? 'line-through' : ''">
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
                    <!-- Immediate feedback that this tap is being saved -->
                    <svg
                      v-if="isItemPending(group.kind, item)"
                      class="w-4 h-4 shrink-0 animate-spin text-muted-foreground print:hidden"
                      fill="none"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                  </div>
                </div>
              </div>
            </template>

            <!-- Print-only table fallback. The "Pre" column names whose bag each
                 line goes into — a printed sheet is what the bags are separated
                 against, so the per-guest grouping has to survive the print. -->
            <template v-if="!friend.packed && totalItemCount(friend) > 0">
              <table class="hidden print:table w-full text-sm mt-2">
                <thead>
                  <tr class="border-b">
                    <th class="text-left py-1">Pre</th>
                    <th class="text-left py-1">Produkt</th>
                    <th class="text-left py-1">Praženie</th>
                    <th class="text-center py-1">Varianta</th>
                    <th class="text-center py-1">Počet</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(entry, i) in allItemEntries(friend)" :key="'print-'+i" class="border-b border-gray-200">
                    <td class="py-1">{{ entry.group.kind === 'guest' ? entry.group.guest.guest_name : 'Vlastné' }}</td>
                    <td class="py-1">{{ entry.item.product_name }}<span v-if="entry.item.variant_label"> — {{ entry.item.variant_label }}</span></td>
                    <td class="py-1">{{ entry.item.roast_type || '-' }}</td>
                    <td class="text-center py-1">{{ entry.item.variant_label ? entry.item.variant_label : (entry.item.variant === 'unit' ? 'ks' : entry.item.variant) }}</td>
                    <td class="text-center py-1">{{ entry.item.quantity }}×</td>
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
