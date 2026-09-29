<script setup>
import { ref, onMounted, onBeforeUnmount, watchEffect } from 'vue'
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
  // Non-blocking and AFTER the detail: the standing row is a tool on this page, never
  // a precondition for it (its own error line, below).
  await loadStanding()
})

// ── 19 PO block 2026-09-19 (GL-T6) — the friend's STANDING guest link ────────────
//
// The admin's read + „Vygenerovať nový" over `GET/POST /api/friends/:id/guest-link/
// standing[/regenerate]` — one helper, two guards (GL-T1). The PO's case: a host who
// cannot reach their own share dialog and asks the admin for their link.
//
// ⚠ THE TOKEN NEVER REACHES THE DOM — not as text, not as an attribute, not in a
// bound value. `standingPath` holds it in JS only; the URL is composed at CLICK time
// and handed to the clipboard (CycleDetail's §UC-GR-007 admin rule: a rendered token
// is a credential in every screenshot and screen-share).
//
// ⚠ PO-VISIBLE FACT: the admin GET MINTS LAZILY (19 D1, GL-T1 §8), so merely OPENING
// this page gives the friend a standing token — a gradual back-fill of every friend the
// admin opens (module 19 has no bulk back-fill). Kept deliberately (orchestrator,
// GL-T6): a read that answered „none yet" would leave the admin nothing to forward.
// An INACTIVE friend with NO token is never minted one — the route answers 409
// `inactive_host`, rendered as the stated refusal with no control; one WITH a token
// keeps it copyable and rotatable (revocation matters most for a deactivated host).
const standingPath = ref('')      // `url_path` — JS only, never rendered
const standingLoaded = ref(false)
const standingRefusal = ref('')   // the 409 `inactive_host` message
const standingError = ref('')     // any other failure of the READ
const standingRegenError = ref('') // a failed ROTATION — its own sentence (GL-T6a review)
const standingCopied = ref(false)
const standingConfirm = ref(false)
const standingPending = ref(false)
const standingRegenerated = ref(false)
let standingCopiedTimer = null
// `loadSeq` convention: a regenerate supersedes an in-flight read, never the reverse.
let standingSeq = 0

async function loadStanding() {
  const seq = ++standingSeq
  try {
    const data = await api.adminGetFriendStandingLink(friendId)
    if (seq !== standingSeq) return
    standingPath.value = data?.standing?.url_path || ''
    standingLoaded.value = !!standingPath.value
    standingRefusal.value = ''
    standingError.value = ''
  } catch (e) {
    if (seq !== standingSeq) return
    standingLoaded.value = false
    if (e.reason === 'inactive_host') standingRefusal.value = e.message
    else standingError.value = e.message
  }
}

function copyStanding() {
  if (!standingPath.value) return
  const url = `${window.location.origin}${standingPath.value}`
  // Same semantics as the view's other copy controls: the flip happens whether or not
  // the clipboard write succeeded (a non-secure origin has no clipboard at all).
  try {
    const written = navigator.clipboard?.writeText(url)
    if (written && typeof written.catch === 'function') written.catch(() => {})
  } catch (e) {
    // Clipboard API missing — fall through to the flip.
  }
  if (standingCopiedTimer) clearTimeout(standingCopiedTimer)
  standingCopied.value = true
  standingCopiedTimer = setTimeout(() => {
    standingCopied.value = false
    standingCopiedTimer = null
  }, 2000)
}

async function regenerateStanding() {
  // ⚠ The JS guard, not only `:disabled` — a dispatched click reaches the handler.
  if (standingPending.value) return
  const seq = ++standingSeq
  standingPending.value = true
  standingRegenError.value = ''
  standingRegenerated.value = false
  try {
    const data = await api.adminRegenerateFriendStandingLink(friendId)
    if (seq !== standingSeq) return
    standingPath.value = data?.standing?.url_path || standingPath.value
    standingLoaded.value = !!standingPath.value
    standingConfirm.value = false
    standingRegenerated.value = true
  } catch (e) {
    if (seq !== standingSeq) return
    standingRegenError.value = e.message
  } finally {
    standingPending.value = false
  }
}

onBeforeUnmount(() => {
  if (standingCopiedTimer) clearTimeout(standingCopiedTimer)
  standingCopiedTimer = null
})

watchEffect(() => {
  document.title = friend.value ? `${friend.value.name} - Gorifi Admin` : 'Gorifi Admin'
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
    await api.addPayment(friendId, data.order_id, data.amount, data.note, data.date)
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

        <!-- Stály odkaz pre hostí (19 PO block, GL-T6). ⚠ No token in the DOM — see
             the script. Admin shadcn skin only. Copy is DRAFT pending the PO's staging
             sign-off; the confirm's two sentences are the host dialog's (§UC-GL-008
             item 2) — the same fact about the same rotation. -->
        <Card class="mb-6" data-testid="standing-link-admin">
          <CardContent class="p-4 space-y-2">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span class="font-medium">Stály odkaz pre hostí</span>
              <template v-if="standingLoaded">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="standing-link-admin-copy"
                  @click="copyStanding"
                >{{ standingCopied ? 'Skopírované!' : 'Kopírovať odkaz' }}</Button>
                <Button
                  v-if="!standingConfirm"
                  size="sm"
                  variant="ghost"
                  data-testid="standing-link-admin-regen"
                  @click="standingConfirm = true; standingRegenerated = false"
                >Vygenerovať nový</Button>
              </template>
            </div>
            <p class="text-xs text-muted-foreground max-w-3xl">
              Jeden odkaz, cez ktorý si kolegovia priateľa objednávajú v každej objednávke,
              alebo sa zapíšu, keď je zatvorená.
            </p>
            <p
              v-if="standingLoaded && !friend.active"
              class="text-xs text-amber-700"
              data-testid="standing-link-admin-dead"
            >Priateľ je deaktivovaný - odkaz teraz nefunguje.</p>
            <div
              v-if="standingLoaded && standingConfirm"
              class="text-sm flex flex-wrap items-center gap-2"
              data-testid="standing-link-admin-confirm"
            >
              <span class="text-muted-foreground">Starý stály odkaz prestane fungovať. Objednávky, ktoré kolegovia už vytvorili, zostanú funkčné.</span>
              <Button
                size="sm"
                variant="destructive"
                :disabled="standingPending"
                @click="regenerateStanding"
              >{{ standingPending ? 'Generujem...' : 'Áno, vygenerovať' }}</Button>
              <Button size="sm" variant="ghost" @click="standingConfirm = false">Nie</Button>
            </div>
            <p
              v-if="standingRegenerated"
              class="text-xs text-green-700"
              data-testid="standing-link-admin-regenerated"
            >Nový odkaz je vygenerovaný - skopírujte ho a pošlite priateľovi.</p>
            <p
              v-if="standingRefusal"
              class="text-sm text-muted-foreground"
              data-testid="standing-link-admin-refused"
            >{{ standingRefusal }}</p>
            <p
              v-if="standingError"
              class="text-sm text-destructive"
              data-testid="standing-link-admin-error"
            >Stály odkaz sa nepodarilo načítať: {{ standingError }}</p>
            <p
              v-if="standingRegenError"
              class="text-sm text-destructive"
              data-testid="standing-link-admin-regen-error"
            >Nový odkaz sa nepodarilo vygenerovať: {{ standingRegenError }}</p>
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
      :orders="orders"
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
