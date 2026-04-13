# Voucher System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admin to create discount vouchers for selected friends based on extra supplier margin, with a friend-facing gate that requires accept/decline before ordering.

**Architecture:** New `vouchers` table tracks voucher lifecycle (pending → accepted/declined). Backend route handles generation, listing, and resolution. Friend portal checks for pending vouchers on load and shows blocking modal. Admin gets a new page for voucher creation with cycle/discount/friend selection flow.

**Tech Stack:** Express route (backend), sql.js (DB), Vue 3 + Tailwind (frontend), existing auth middleware

**Spec:** `docs/superpowers/specs/2026-04-12-voucher-system-design.md`

---

## File Structure

**Create:**
- `backend/src/routes/vouchers.js` — All voucher API endpoints (admin generate/list, friend pending/resolve)
- `frontend/src/views/AdminVouchers.vue` — Admin voucher creation page (3-step flow + voucher list)

**Modify:**
- `backend/src/db/schema.js` — Add `vouchers` table CREATE TABLE
- `backend/src/index.js` — Register vouchers router
- `frontend/src/api.js` — Add voucher API methods
- `frontend/src/router.js` — Add `/admin/vouchers` route
- `frontend/src/views/AdminDashboard.vue` — Add "Vouchery" nav button
- `frontend/src/views/FriendPortal.vue` — Add voucher gate (check pending + modal)

---

### Task 1: Database Schema — Create vouchers table

**Files:**
- Modify: `backend/src/db/schema.js`

- [ ] **Step 1: Add vouchers table to schema.js**

Find the last `CREATE TABLE IF NOT EXISTS` block in `backend/src/db/schema.js` and add the vouchers table after it (before any ALTER TABLE migrations):

```javascript
db.run(`
  CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    friend_id INTEGER NOT NULL,
    source_cycle_id INTEGER NOT NULL,
    supplier_discount REAL NOT NULL,
    applied_discount REAL NOT NULL,
    order_total REAL NOT NULL,
    retail_total REAL NOT NULL,
    voucher_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    transaction_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE,
    FOREIGN KEY (source_cycle_id) REFERENCES order_cycles(id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
  )
`);
```

- [ ] **Step 2: Verify backend starts without errors**

Run: `cd /Users/karolskolar/projects/gorifi/backend && npm run dev`

Expected: Server starts on port 3000, no schema errors. Stop the server after confirming.

- [ ] **Step 3: Commit**

```bash
git add backend/src/db/schema.js
git commit -m "feat(vouchers): add vouchers table to schema"
```

---

### Task 2: Backend Route — Voucher endpoints

**Files:**
- Create: `backend/src/routes/vouchers.js`
- Modify: `backend/src/index.js`

- [ ] **Step 1: Create vouchers route file with all endpoints**

Create `backend/src/routes/vouchers.js`:

```javascript
import { Router } from 'express';
import db from '../db/schema.js';
import { validateFriendAuth } from '../middleware/friend-auth.js';

const router = Router();

// ============================================================
// Admin endpoints (no server-side auth, per project convention)
// ============================================================

// POST /generate — Create vouchers for selected friends
router.post('/generate', (req, res) => {
  const { source_cycle_id, supplier_discount, applied_discount, friend_ids } = req.body;

  // Validate required fields
  if (!source_cycle_id || supplier_discount == null || applied_discount == null || !Array.isArray(friend_ids) || friend_ids.length === 0) {
    return res.status(400).json({ error: 'source_cycle_id, supplier_discount, applied_discount, and friend_ids are required' });
  }

  if (supplier_discount <= applied_discount) {
    return res.status(400).json({ error: 'supplier_discount must be greater than applied_discount' });
  }

  // Check cycle exists
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(source_cycle_id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cycle not found' });
  }

  const extraDiscount = (supplier_discount - applied_discount) / 100;
  const appliedDecimal = applied_discount / 100;
  const created = [];

  for (const friendId of friend_ids) {
    // Check for existing pending voucher
    const existing = db.prepare(
      'SELECT id FROM vouchers WHERE friend_id = ? AND source_cycle_id = ? AND status = ?'
    ).get(friendId, source_cycle_id, 'pending');
    if (existing) {
      continue; // Skip duplicates silently
    }

    // Get friend's submitted order total for this cycle
    const order = db.prepare(
      'SELECT total FROM orders WHERE friend_id = ? AND cycle_id = ? AND status = ?'
    ).get(friendId, source_cycle_id, 'submitted');
    if (!order || !order.total) {
      continue; // Skip friends without submitted orders
    }

    const orderTotal = order.total;
    const retailTotal = Math.round((orderTotal / (1 - appliedDecimal)) * 100) / 100;
    const voucherAmount = Math.round(retailTotal * extraDiscount * 100) / 100;

    const result = db.prepare(`
      INSERT INTO vouchers (friend_id, source_cycle_id, supplier_discount, applied_discount, order_total, retail_total, voucher_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(friendId, source_cycle_id, supplier_discount, applied_discount, orderTotal, retailTotal, voucherAmount);

    const voucher = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(result.lastInsertRowid);
    created.push(voucher);
  }

  res.status(201).json({ vouchers: created, count: created.length });
});

// GET / — List all vouchers with friend and cycle info
router.get('/', (req, res) => {
  const { status, source_cycle_id } = req.query;

  let sql = `
    SELECT v.*, f.name as friend_name, oc.name as cycle_name
    FROM vouchers v
    JOIN friends f ON f.id = v.friend_id
    JOIN order_cycles oc ON oc.id = v.source_cycle_id
  `;
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('v.status = ?');
    params.push(status);
  }
  if (source_cycle_id) {
    conditions.push('v.source_cycle_id = ?');
    params.push(source_cycle_id);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY v.created_at DESC';

  const vouchers = db.prepare(sql).all(...params);
  res.json(vouchers);
});

// GET /cycle/:cycleId/friends — Get friends with orders in a cycle (for admin picker)
router.get('/cycle/:cycleId/friends', (req, res) => {
  const { cycleId } = req.params;

  const friends = db.prepare(`
    SELECT f.id, f.name, o.total as order_total
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    WHERE o.cycle_id = ? AND o.status = 'submitted' AND o.total > 0
    ORDER BY f.name
  `).all(cycleId);

  res.json(friends);
});

// ============================================================
// Friend endpoints (authenticated via session token/password)
// ============================================================

// GET /pending — Get pending vouchers for authenticated friend
router.get('/pending', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const friendId = validation.friendId;

  // Token auth provides friendId directly
  // For shared password auth, friendId comes from query param
  const targetFriendId = friendId || req.query.friendId;
  if (!targetFriendId) {
    return res.status(400).json({ error: 'friendId is required' });
  }

  const vouchers = db.prepare(`
    SELECT v.*, oc.name as cycle_name
    FROM vouchers v
    JOIN order_cycles oc ON oc.id = v.source_cycle_id
    WHERE v.friend_id = ? AND v.status = 'pending'
    ORDER BY v.created_at ASC
  `).all(targetFriendId);

  res.json(vouchers);
});

// POST /:id/resolve — Accept or decline a voucher
router.post('/:id/resolve', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const { id } = req.params;
  const { action } = req.body;

  if (!action || !['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'action must be "accept" or "decline"' });
  }

  const voucher = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(id);
  if (!voucher) {
    return res.status(404).json({ error: 'Voucher not found' });
  }

  if (voucher.status !== 'pending') {
    return res.status(400).json({ error: 'Voucher already resolved' });
  }

  // Verify ownership: token auth has friendId, shared password needs query param
  const friendId = validation.friendId || req.query.friendId;
  if (String(voucher.friend_id) !== String(friendId)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const now = new Date().toISOString();

  if (action === 'accept') {
    // Get cycle name for transaction note
    const cycle = db.prepare('SELECT name FROM order_cycles WHERE id = ?').get(voucher.source_cycle_id);
    const cycleName = cycle ? cycle.name : `cyklus #${voucher.source_cycle_id}`;

    // Create adjustment transaction
    const txResult = db.prepare(`
      INSERT INTO transactions (friend_id, type, amount, note)
      VALUES (?, 'adjustment', ?, ?)
    `).run(voucher.friend_id, voucher.voucher_amount, `Voucher z cyklu ${cycleName}`);

    // Update voucher
    db.prepare(`
      UPDATE vouchers SET status = 'accepted', transaction_id = ?, resolved_at = ? WHERE id = ?
    `).run(txResult.lastInsertRowid, now, id);
  } else {
    // Decline
    db.prepare(`
      UPDATE vouchers SET status = 'declined', resolved_at = ? WHERE id = ?
    `).run(now, id);
  }

  const updated = db.prepare(`
    SELECT v.*, oc.name as cycle_name
    FROM vouchers v
    JOIN order_cycles oc ON oc.id = v.source_cycle_id
    WHERE v.id = ?
  `).get(id);

  res.json(updated);
});

export default router;
```

- [ ] **Step 2: Register the route in index.js**

In `backend/src/index.js`, add after the live-cycle import:

```javascript
import vouchersRouter from './routes/vouchers.js';
```

And add after the `app.use('/api/analytics/live-cycle', liveCycleRouter);` line:

```javascript
app.use('/api/vouchers', vouchersRouter);
```

- [ ] **Step 3: Verify backend starts**

Run: `cd /Users/karolskolar/projects/gorifi/backend && npm run dev`

Expected: Server starts on port 3000, no errors. Stop after confirming.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/vouchers.js backend/src/index.js
git commit -m "feat(vouchers): add voucher API endpoints"
```

---

### Task 3: Frontend API Methods

**Files:**
- Modify: `frontend/src/api.js`

- [ ] **Step 1: Add voucher API methods to api.js**

Add these methods inside the `export const api = {` object. Place them at the end, before the closing `}`:

```javascript
  // Vouchers
  generateVouchers: (data) => adminRequest('/vouchers/generate', { method: 'POST', body: data }),
  getVouchers: (params) => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.source_cycle_id) query.set('source_cycle_id', params.source_cycle_id)
    const qs = query.toString()
    return adminRequest(`/vouchers${qs ? `?${qs}` : ''}`)
  },
  getVoucherCycleFriends: (cycleId) => adminRequest(`/vouchers/cycle/${cycleId}/friends`),
  getPendingVouchers: (friendId) => request(`/vouchers/pending${friendId ? `?friendId=${friendId}` : ''}`),
  resolveVoucher: (id, action) => request(`/vouchers/${id}/resolve`, { method: 'POST', body: { action } }),
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/api.js
git commit -m "feat(vouchers): add voucher API methods to frontend"
```

---

### Task 4: Frontend — Friend Voucher Gate in FriendPortal.vue

**Files:**
- Modify: `frontend/src/views/FriendPortal.vue`

- [ ] **Step 1: Add voucher state refs**

In the `<script setup>` section of `FriendPortal.vue`, add these refs alongside the existing ones (near the other `ref()` declarations):

```javascript
const pendingVouchers = ref([])
const currentVoucher = ref(null)
const showVoucherModal = ref(false)
const voucherResolved = ref(null) // { action: 'accept'|'decline', amount, cycleName }
const resolvingVoucher = ref(false)
```

- [ ] **Step 2: Add voucher check function**

Add this function in the script section, after the `loadCycles` function:

```javascript
async function checkPendingVouchers() {
  try {
    const friendId = selectedFriendId.value || getFriendsAuthInfo()?.friendId
    if (!friendId) return
    const vouchers = await api.getPendingVouchers(friendId)
    pendingVouchers.value = vouchers
    if (vouchers.length > 0) {
      currentVoucher.value = vouchers[0]
      showVoucherModal.value = true
    }
  } catch (e) {
    // Non-blocking — if voucher check fails, let them proceed
    console.error('Voucher check failed:', e)
  }
}

async function resolveVoucher(action) {
  if (!currentVoucher.value || resolvingVoucher.value) return
  resolvingVoucher.value = true
  try {
    await api.resolveVoucher(currentVoucher.value.id, action)
    const amount = currentVoucher.value.voucher_amount
    const cycleName = currentVoucher.value.cycle_name
    voucherResolved.value = { action, amount, cycleName }

    // Check for more pending vouchers
    pendingVouchers.value = pendingVouchers.value.filter(v => v.id !== currentVoucher.value.id)
    if (pendingVouchers.value.length > 0) {
      currentVoucher.value = pendingVouchers.value[0]
      voucherResolved.value = null
    } else {
      showVoucherModal.value = false
      currentVoucher.value = null
      // Auto-dismiss banner after 5 seconds
      setTimeout(() => { voucherResolved.value = null }, 5000)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    resolvingVoucher.value = false
  }
}
```

- [ ] **Step 3: Call checkPendingVouchers after authentication**

Find every place where `authState.value = 'authenticated'` is set and add `await checkPendingVouchers()` immediately before it. There are multiple spots — after `loadCycles()` calls in:
1. Token restore path (localStorage restore)
2. Shared password auth path
3. Personal credentials auth path
4. Any other auth success path

The pattern to find: `await loadCycles()` followed by `authState.value = 'authenticated'`.

Add `await checkPendingVouchers()` between those two lines in each location:

```javascript
await loadCycles()
await checkPendingVouchers()  // ← add this line
authState.value = 'authenticated'
```

- [ ] **Step 4: Add voucher modal and banner to template**

In the `<template>` section, add the voucher modal overlay and resolution banner. Place the modal **inside** the authenticated section, right at the top (before the cycle list). The modal uses a fixed overlay to block all interaction:

```html
    <!-- Voucher resolution banner -->
    <div v-if="voucherResolved && !showVoucherModal" class="max-w-4xl mx-auto px-4 mt-4">
      <div v-if="voucherResolved.action === 'accept'" class="bg-green-900/30 border border-green-700/50 rounded-lg p-4 flex items-center gap-3">
        <span class="text-2xl">✅</span>
        <div>
          <div class="font-semibold text-green-400">Kredit {{ voucherResolved.amount.toFixed(2) }} € pridaný</div>
          <div class="text-sm text-muted-foreground">Bude odpočítaný z tvojej ďalšej objednávky</div>
        </div>
      </div>
      <div v-else class="bg-purple-900/20 border border-purple-700/30 rounded-lg p-4 flex items-center gap-3">
        <span class="text-2xl">💚</span>
        <div>
          <div class="font-semibold">Ďakujeme za podporu!</div>
          <div class="text-sm text-muted-foreground">Tvoj voucher {{ voucherResolved.amount.toFixed(2) }} € bol venovaný projektu</div>
        </div>
      </div>
    </div>

    <!-- Voucher gate modal -->
    <div v-if="showVoucherModal && currentVoucher" class="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div class="bg-card rounded-2xl p-7 max-w-sm w-full shadow-2xl">
        <div class="text-center mb-5">
          <div class="text-4xl mb-2">🎁</div>
          <div class="text-xl font-bold mb-1.5">Máš voucher!</div>
          <div class="text-sm text-muted-foreground">
            Za tvoju objednávku z cyklu <span class="font-semibold text-foreground">{{ currentVoucher.cycle_name }}</span> ti patrí zľavový voucher.
          </div>
        </div>
        <div class="bg-muted rounded-xl p-4 text-center mb-5">
          <div class="text-sm text-muted-foreground mb-1">
            Hodnota voucheru je {{ Math.round(currentVoucher.supplier_discount - currentVoucher.applied_discount) }}% z tvojej objednávky
          </div>
          <div class="text-3xl font-bold text-green-400">{{ currentVoucher.voucher_amount.toFixed(2) }} €</div>
        </div>
        <div class="flex flex-col gap-2.5">
          <button
            @click="resolveVoucher('accept')"
            :disabled="resolvingVoucher"
            class="w-full bg-green-500 hover:bg-green-600 text-green-950 font-semibold py-3.5 rounded-xl transition-colors disabled:opacity-50"
          >
            {{ resolvingVoucher ? 'Spracovávam...' : 'Použiť ako kredit na ďalšiu objednávku' }}
          </button>
          <button
            @click="resolveVoucher('decline')"
            :disabled="resolvingVoucher"
            class="w-full border border-border text-muted-foreground hover:text-foreground py-3.5 rounded-xl transition-colors disabled:opacity-50"
          >
            Nepotrebujem — podporím projekt 💚
          </button>
        </div>
        <div class="text-center mt-3.5 text-xs text-muted-foreground/50">
          Toto rozhodnutie je jednorazové a nedá sa zmeniť.
        </div>
      </div>
    </div>
```

Place the voucher gate modal at the end of the template, just before the closing `</template>` tag (since it's a fixed overlay, DOM position doesn't matter).

Place the voucher resolution banner right after the `<header>` closing tag, inside the authenticated section — before the cycle list content.

- [ ] **Step 5: Verify the friend portal loads without errors**

Run: `cd /Users/karolskolar/projects/gorifi/frontend && npm run dev`

Open http://localhost:5173 in browser. Log in as a friend. Should see normal cycle list (no pending vouchers yet). No console errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/views/FriendPortal.vue
git commit -m "feat(vouchers): add voucher gate modal to friend portal"
```

---

### Task 5: Frontend — Admin Voucher Page

**Files:**
- Create: `frontend/src/views/AdminVouchers.vue`
- Modify: `frontend/src/router.js`
- Modify: `frontend/src/views/AdminDashboard.vue`

- [ ] **Step 1: Create AdminVouchers.vue**

Create `frontend/src/views/AdminVouchers.vue`:

```vue
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
```

- [ ] **Step 2: Add route to router.js**

In `frontend/src/router.js`, add a new route after the `admin-settings` route:

```javascript
  {
    path: '/admin/vouchers',
    name: 'admin-vouchers',
    component: () => import('./views/AdminVouchers.vue')
  },
```

- [ ] **Step 3: Add nav button to AdminDashboard.vue**

In `frontend/src/views/AdminDashboard.vue`, find the nav buttons in the header. Add a "Vouchery" button after the "Pekáreň" button:

```html
          <Button variant="ghost" @click="router.push('/admin/vouchers')" class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10">
            Vouchery
          </Button>
```

- [ ] **Step 4: Verify admin page loads**

Run frontend dev server. Navigate to http://localhost:5173/admin/vouchers. Should show the voucher creation form with cycle dropdown and discount inputs. No console errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/AdminVouchers.vue frontend/src/router.js frontend/src/views/AdminDashboard.vue
git commit -m "feat(vouchers): add admin voucher management page"
```

---

### Task 6: End-to-End Verification

**Files:** None (testing only)

- [ ] **Step 1: Start both servers**

```bash
cd /Users/karolskolar/projects/gorifi/backend && npm run dev &
cd /Users/karolskolar/projects/gorifi/frontend && npm run dev &
```

- [ ] **Step 2: Test admin flow**

1. Log in to admin at http://localhost:5173/admin
2. Navigate to Vouchery page
3. Select a locked/completed cycle
4. Enter supplier discount (e.g., 35) and applied discount (e.g., 30)
5. Verify "Extra zľava na vrátenie: 5%" appears
6. Click "Pokračovať" — should see friends with orders
7. Select friends, verify voucher amounts are calculated
8. Click "Vytvoriť vouchery"
9. Should see confirmation with count

- [ ] **Step 3: Test friend flow**

1. Open http://localhost:5173/ (friend portal)
2. Log in as one of the friends who received a voucher
3. Should see the voucher modal blocking the cycle list
4. Test "Použiť ako kredit" — verify credit appears in banner
5. Or test "Nepotrebujem — podporím projekt" — verify thank-you banner

- [ ] **Step 4: Verify transaction created**

After accepting a voucher, check the friend's detail page in admin. Should see a new adjustment transaction with the voucher amount and note "Voucher z cyklu {name}".

- [ ] **Step 5: Final commit if any fixes needed**

If any fixes were made during testing, commit them:

```bash
git add -A
git commit -m "fix(vouchers): fixes from end-to-end testing"
```
