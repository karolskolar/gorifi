# Packeta Parcel Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional Packeta parcel delivery to the friend ordering flow, with per-cycle configuration and admin visibility.

**Architecture:** Extends the existing pickup location modal into a unified delivery choice modal. Parcel delivery data lives as new columns on `friends` (default address), `order_cycles` (enabled + fee), and `orders` (delivery fee + address per order). The delivery fee is stored separately from the product total.

**Tech Stack:** Node.js/Express backend, Vue 3 + Tailwind frontend, sql.js (SQLite) database with try/catch migration pattern.

**Spec:** `docs/superpowers/specs/2026-05-01-packeta-parcel-delivery-design.md`

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `backend/src/db/schema.js` | Add 4 migration columns across 3 tables |
| Modify | `backend/src/routes/friends.js:462-490` | Accept `packeta_address` in profile update |
| Modify | `backend/src/routes/cycles.js:30,133` | Include parcel fields in public endpoint + accept in PATCH |
| Modify | `backend/src/routes/cycles.js:264-273` | Include `delivery_fee`, `packeta_address` in distribution query |
| Modify | `backend/src/routes/orders.js:337-357` | Handle parcel delivery in submit endpoint |
| Modify | `backend/src/routes/orders.js:76-81` | Include `packeta_address` in friend data response |
| Modify | `frontend/src/api.js:179` | Extend `submitOrderByFriend` (already generic — no change needed) |
| Modify | `frontend/src/views/FriendPortal.vue:427-465,1060-1139` | Add Packeta address field to profile modal |
| Modify | `frontend/src/views/FriendOrder.vue:54-58,570-662,1589-1652` | Replace pickup modal with unified delivery modal |
| Modify | `frontend/src/views/CycleDetail.vue:56-58,175-185,718-743,1065-1086` | Add parcel cycle config + red Packeta badge |
| Modify | `frontend/src/views/Distribution.vue:131-137` | Add red Packeta badge + address row |

---

### Task 1: Database Migrations

**Files:**
- Modify: `backend/src/db/schema.js`

- [ ] **Step 1: Add `packeta_address` column to `friends` table**

In `backend/src/db/schema.js`, find the block of friends table migrations (after the existing `ALTER TABLE friends` blocks, around where other friend column migrations are). Add:

```javascript
// Migration: Add packeta_address for default Packeta pickup point
try {
  db.run('ALTER TABLE friends ADD COLUMN packeta_address TEXT');
} catch (e) {
  // Column already exists, ignore
}
```

- [ ] **Step 2: Add `parcel_enabled` and `parcel_fee` columns to `order_cycles` table**

After the existing `order_cycles` migration blocks (after the `plan_note` migration around line 93), add:

```javascript
// Migration: Add parcel delivery columns to order_cycles
try {
  db.run('ALTER TABLE order_cycles ADD COLUMN parcel_enabled INTEGER DEFAULT 0');
} catch (e) {}
try {
  db.run('ALTER TABLE order_cycles ADD COLUMN parcel_fee REAL DEFAULT 0');
} catch (e) {}
```

- [ ] **Step 3: Add `delivery_fee` and `packeta_address` columns to `orders` table**

After the existing `orders` migration blocks (after the `pickup_location_note` migration around line 335), add:

```javascript
// Migration: Add parcel delivery columns to orders
try {
  db.run('ALTER TABLE orders ADD COLUMN delivery_fee REAL DEFAULT 0');
} catch (e) {}
try {
  db.run('ALTER TABLE orders ADD COLUMN packeta_address TEXT');
} catch (e) {}
```

- [ ] **Step 4: Verify migrations run cleanly**

Start the backend and confirm no errors:

```bash
cd backend && npm run dev
```

Expected: Server starts without migration errors. Check console for any issues.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.js
git commit -m "feat(db): add parcel delivery columns to friends, order_cycles, and orders tables"
```

---

### Task 2: Backend — Friend Profile Endpoint

**Files:**
- Modify: `backend/src/routes/friends.js:462-490`

- [ ] **Step 1: Extend PATCH /:id/profile to accept `packeta_address`**

In `backend/src/routes/friends.js`, in the `PATCH /:id/profile` handler (line 462), change the destructuring on line 468 from:

```javascript
const { name } = req.body;
```

to:

```javascript
const { name, packeta_address } = req.body;
```

- [ ] **Step 2: Add packeta_address update logic**

After the existing `name` update block (after line 486 `db.prepare('UPDATE friends SET name = ? WHERE id = ?').run(name.trim(), friendId);`), add:

```javascript
if (packeta_address !== undefined) {
  db.prepare('UPDATE friends SET packeta_address = ? WHERE id = ?')
    .run(packeta_address?.trim() || null, friendId);
}
```

- [ ] **Step 3: Include `packeta_address` in the response**

Change the SELECT on line 488 from:

```javascript
const updated = db.prepare('SELECT id, name, uid FROM friends WHERE id = ?').get(friendId);
```

to:

```javascript
const updated = db.prepare('SELECT id, name, uid, packeta_address FROM friends WHERE id = ?').get(friendId);
```

- [ ] **Step 4: Include `packeta_address` in the order data friend response**

In `backend/src/routes/orders.js`, the GET `/cycle/:cycleId/friend/:friendId` endpoint (around line 79) returns:

```javascript
friend: { id: friend.id, name: friend.name },
```

Change to:

```javascript
friend: { id: friend.id, name: friend.name, packeta_address: friend.packeta_address || null },
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/friends.js backend/src/routes/orders.js
git commit -m "feat(api): extend friend profile endpoint to accept packeta_address"
```

---

### Task 3: Backend — Cycle Endpoints for Parcel Config

**Files:**
- Modify: `backend/src/routes/cycles.js:30,133-170`

- [ ] **Step 1: Add parcel fields to the public cycle endpoint**

In `backend/src/routes/cycles.js`, line 30, the public endpoint selects specific columns:

```javascript
const cycle = db.prepare('SELECT id, name, status, markup_ratio, expected_date, type, plan_note FROM order_cycles WHERE id = ?').get(req.params.id);
```

Change to:

```javascript
const cycle = db.prepare('SELECT id, name, status, markup_ratio, expected_date, type, plan_note, parcel_enabled, parcel_fee FROM order_cycles WHERE id = ?').get(req.params.id);
```

- [ ] **Step 2: Accept parcel fields in PATCH /:id**

In the PATCH handler (line 133), extend the destructuring:

```javascript
const { status, name, shared_password, markup_ratio, expected_date, plan_note } = req.body;
```

Change to:

```javascript
const { status, name, shared_password, markup_ratio, expected_date, plan_note, parcel_enabled, parcel_fee } = req.body;
```

- [ ] **Step 3: Add parcel update logic**

After the `plan_note` block (after line 170), add:

```javascript
if (parcel_enabled !== undefined) {
  updates.push('parcel_enabled = ?');
  values.push(parcel_enabled ? 1 : 0);
}
if (parcel_fee !== undefined) {
  updates.push('parcel_fee = ?');
  values.push(parcel_fee || 0);
}
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/cycles.js
git commit -m "feat(api): add parcel_enabled and parcel_fee to cycle endpoints"
```

---

### Task 4: Backend — Order Submit with Parcel Delivery

**Files:**
- Modify: `backend/src/routes/orders.js:337-357`

- [ ] **Step 1: Extend the submit endpoint to handle parcel delivery**

In `backend/src/routes/orders.js`, replace the pickup location handling block (lines 337-357) with:

```javascript
// Handle pickup location / parcel delivery
const { pickup_location_id, pickup_location_note, use_parcel_delivery, packeta_address } = req.body || {};

if (use_parcel_delivery) {
  // Validate parcel is enabled for this cycle
  if (!cycle.parcel_enabled) {
    return res.status(400).json({ error: 'Doručenie Packetou nie je pre tento cyklus dostupné' });
  }
  if (!packeta_address?.trim()) {
    return res.status(400).json({ error: 'Adresa výdajného miesta je povinná' });
  }
  // Submit with parcel delivery — clear pickup fields
  db.prepare(`
    UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
      delivery_fee = ?, packeta_address = ?,
      pickup_location_id = NULL, pickup_location_note = NULL
    WHERE id = ?
  `).run(cycle.parcel_fee || 0, packeta_address.trim(), order.id);
} else {
  // Standard pickup — clear parcel fields
  if (pickup_location_id !== undefined && pickup_location_id !== null) {
    const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ? AND active = 1').get(pickup_location_id);
    if (!location) {
      return res.status(400).json({ error: 'Vybrané miesto vyzdvihnutia neexistuje alebo nie je aktívne' });
    }
  }

  db.prepare(`
    UPDATE orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
      pickup_location_id = ?, pickup_location_note = ?,
      delivery_fee = 0, packeta_address = NULL
    WHERE id = ?
  `).run(
    pickup_location_id || null,
    pickup_location_id ? null : (pickup_location_note || null),
    order.id
  );
}
```

- [ ] **Step 2: Include delivery fields in distribution query**

In `backend/src/routes/cycles.js`, the distribution endpoint (line 264-266) selects order data. Change the SELECT to include delivery fields:

Find:
```javascript
SELECT f.id, f.name, o.id as order_id, o.status, o.paid, o.total, o.packed, o.packed_at,
       o.pickup_location_id, o.pickup_location_note, pl.name as pickup_location_name,
```

Replace with:
```javascript
SELECT f.id, f.name, o.id as order_id, o.status, o.paid, o.total, o.packed, o.packed_at,
       o.pickup_location_id, o.pickup_location_note, pl.name as pickup_location_name,
       o.delivery_fee, o.packeta_address,
```

- [ ] **Step 3: Include delivery fields in admin orders query**

In `backend/src/routes/orders.js`, find the admin endpoint that lists orders for a cycle (the SELECT that joins `pickup_locations`). It should be in the GET `/cycle/:cycleId` handler. Ensure `o.delivery_fee` and `o.packeta_address` are included in the SELECT. Since the endpoint likely uses `SELECT o.*`, these new columns are automatically included. Verify this by checking the query.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/orders.js backend/src/routes/cycles.js
git commit -m "feat(api): handle parcel delivery in order submit and distribution endpoints"
```

---

### Task 5: Frontend — Profile Modal Packeta Address

**Files:**
- Modify: `frontend/src/views/FriendPortal.vue:427-465,1060-1139`

- [ ] **Step 1: Add packeta address ref**

In `FriendPortal.vue`, near the existing `profileName` ref (find `const profileName = ref('')`), add:

```javascript
const profilePacketaAddress = ref('')
```

- [ ] **Step 2: Populate the ref when opening the modal**

In the `openProfileModal()` function (line 427), add after line 428:

```javascript
profilePacketaAddress.value = currentFriend.value?.packeta_address || ''
```

- [ ] **Step 3: Send packeta_address when saving profile**

In the `saveProfile()` function (line 438), change the API call from:

```javascript
const updated = await api.updateFriendProfile(friendId, {
  name: profileName.value.trim()
})
```

to:

```javascript
const updated = await api.updateFriendProfile(friendId, {
  name: profileName.value.trim(),
  packeta_address: profilePacketaAddress.value.trim() || null
})
```

- [ ] **Step 4: Add the address input field to the profile modal template**

In the template, after the "Prihlasovacie meno" section (after the `<p class="text-xs text-muted-foreground">Toto meno sa zobrazuje pri prihlasovaní</p>` closing `</div>` around line 1084), add:

```vue
<div class="space-y-2">
  <Label>Adresa Packeta výdajného miesta</Label>
  <Input
    v-model="profilePacketaAddress"
    placeholder="napr. Z-BOX Hlavná 15, Bratislava"
    :disabled="profileSaving"
  />
  <p class="text-xs text-muted-foreground">Adresa výdajného miesta pre doručenie Packetou (voliteľné)</p>
</div>
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/FriendPortal.vue
git commit -m "feat(ui): add Packeta address field to friend profile modal"
```

---

### Task 6: Frontend — Unified Delivery Modal in FriendOrder

**Files:**
- Modify: `frontend/src/views/FriendOrder.vue:54-58,570-662,1589-1652`

- [ ] **Step 1: Add parcel delivery refs**

In `FriendOrder.vue`, after the existing pickup location refs (after line 58), add:

```javascript
// Parcel delivery state
const deliveryMethod = ref('pickup') // 'pickup' or 'packeta'
const packetaAddress = ref('')
const savePacketaAsDefault = ref(false)
```

- [ ] **Step 2: Update the `submitOrder` function**

Replace the existing `submitOrder` function (lines 570-596) with:

```javascript
async function submitOrder() {
  if (isLocked.value) return
  if (cartItems.value.length === 0) {
    error.value = 'Košík je prázdny'
    return
  }

  const hasPickupLocations = pickupLocations.value.length > 0
  const hasParcel = cycle.value?.parcel_enabled

  if (!hasPickupLocations && !hasParcel) {
    // No modal needed, submit directly
    await doSubmitOrder()
    return
  }

  // Pre-select based on existing order state
  if (order.value?.packeta_address) {
    deliveryMethod.value = 'packeta'
    packetaAddress.value = order.value.packeta_address
    savePacketaAsDefault.value = false
  } else if (order.value?.pickup_location_id) {
    deliveryMethod.value = 'pickup'
    selectedPickupLocationId.value = order.value.pickup_location_id
    pickupLocationNote.value = ''
  } else if (order.value?.pickup_location_note) {
    deliveryMethod.value = 'pickup'
    selectedPickupLocationId.value = null
    pickupLocationNote.value = order.value.pickup_location_note
  } else {
    // Default: pickup if locations exist, otherwise packeta
    deliveryMethod.value = hasPickupLocations ? 'pickup' : 'packeta'
    selectedPickupLocationId.value = null
    pickupLocationNote.value = ''
    // Pre-fill Packeta address from friend profile
    packetaAddress.value = friend.value?.packeta_address || ''
    savePacketaAsDefault.value = false
  }

  showPickupModal.value = true
}
```

- [ ] **Step 3: Update the `doSubmitOrder` function**

Replace the `pickupData` construction in `doSubmitOrder` (lines 609-611) with:

```javascript
const pickupData = deliveryMethod.value === 'packeta'
  ? {
      use_parcel_delivery: true,
      packeta_address: packetaAddress.value.trim(),
      pickup_location_id: null,
      pickup_location_note: null
    }
  : {
      use_parcel_delivery: false,
      pickup_location_id: selectedPickupLocationId.value || null,
      pickup_location_note: selectedPickupLocationId.value ? null : (pickupLocationNote.value || null)
    }
```

- [ ] **Step 4: Update `confirmPickupAndSubmit` to save Packeta address**

Replace the existing `confirmPickupAndSubmit` function (lines 659-662) with:

```javascript
async function confirmPickupAndSubmit() {
  // Optionally save Packeta address to profile
  if (deliveryMethod.value === 'packeta' && savePacketaAsDefault.value && packetaAddress.value.trim()) {
    try {
      await api.updateFriendProfile(friend.value.id, {
        packeta_address: packetaAddress.value.trim()
      })
    } catch (e) {
      // Non-critical, proceed with order
    }
  }
  showPickupModal.value = false
  doSubmitOrder()
}
```

- [ ] **Step 5: Replace the pickup modal template with unified delivery modal**

Replace the entire `<!-- Pickup Location Modal -->` block (lines 1589-1652) with:

```vue
<!-- Delivery Method Modal -->
<Dialog :open="showPickupModal" @update:open="showPickupModal = $event">
  <DialogContent class="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>Spôsob prevzatia</DialogTitle>
      <DialogDescription class="text-base">
        Vyberte, ako chcete dostať objednávku.
      </DialogDescription>
    </DialogHeader>
    <div class="space-y-3 py-2">
      <!-- Top-level choice: pickup vs packeta -->
      <div v-if="pickupLocations.length > 0 && cycle?.parcel_enabled" class="space-y-2">
        <label
          :class="[
            'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            deliveryMethod === 'pickup' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
          ]"
        >
          <input type="radio" value="pickup" v-model="deliveryMethod" />
          <div class="font-medium">Osobný odber</div>
        </label>
        <label
          :class="[
            'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            deliveryMethod === 'packeta' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
          ]"
        >
          <input type="radio" value="packeta" v-model="deliveryMethod" />
          <div>
            <span class="font-medium">Doručenie Packetou</span>
            <span v-if="cycle?.parcel_fee" class="text-sm text-muted-foreground ml-1">(+{{ formatPrice(cycle.parcel_fee) }})</span>
          </div>
        </label>
      </div>

      <!-- Packeta-only header (no pickup locations configured) -->
      <div v-else-if="cycle?.parcel_enabled && pickupLocations.length === 0" class="space-y-2">
        <label
          :class="[
            'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            deliveryMethod === 'packeta' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
          ]"
        >
          <input type="radio" value="packeta" v-model="deliveryMethod" />
          <div>
            <span class="font-medium">Doručenie Packetou</span>
            <span v-if="cycle?.parcel_fee" class="text-sm text-muted-foreground ml-1">(+{{ formatPrice(cycle.parcel_fee) }})</span>
          </div>
        </label>
        <label
          :class="[
            'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            deliveryMethod === 'pickup' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
          ]"
        >
          <input type="radio" value="pickup" v-model="deliveryMethod" />
          <div class="font-medium">Bez doručenia (vyzdvihnem osobne)</div>
        </label>
      </div>

      <!-- Pickup locations section -->
      <div v-if="deliveryMethod === 'pickup' && pickupLocations.length > 0" class="space-y-2 border-t pt-3">
        <label
          v-for="loc in pickupLocations"
          :key="loc.id"
          :class="[
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            selectedPickupLocationId === loc.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
          ]"
        >
          <input type="radio" :value="loc.id" v-model="selectedPickupLocationId" class="mt-0.5" />
          <div>
            <div class="font-medium">{{ loc.name }}</div>
            <div v-if="loc.address" class="text-sm text-muted-foreground">{{ loc.address }}</div>
          </div>
        </label>
        <!-- "Iné" option -->
        <label
          :class="[
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            selectedPickupLocationId === null ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
          ]"
        >
          <input type="radio" :value="null" v-model="selectedPickupLocationId" class="mt-0.5" />
          <div class="flex-1">
            <div class="font-medium">Iné</div>
            <input
              v-if="selectedPickupLocationId === null"
              v-model="pickupLocationNote"
              type="text"
              placeholder="Poznámka (voliteľné)"
              class="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
        </label>
      </div>

      <!-- Packeta section -->
      <div v-if="deliveryMethod === 'packeta'" class="space-y-3 border-t pt-3">
        <div class="space-y-1">
          <label class="text-sm font-medium">Adresa výdajného miesta *</label>
          <input
            v-model="packetaAddress"
            type="text"
            placeholder="napr. Z-BOX Hlavná 15, Bratislava"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" v-model="savePacketaAsDefault" class="rounded" />
          Uložiť ako predvolenú adresu
        </label>
      </div>
    </div>
    <DialogFooter class="flex gap-2">
      <Button variant="outline" @click="showPickupModal = false" class="flex-1">
        Zrušiť
      </Button>
      <Button
        @click="confirmPickupAndSubmit"
        class="flex-1"
        :disabled="deliveryMethod === 'packeta' && !packetaAddress.trim()"
      >
        Potvrdiť a odoslať
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 6: Verify the modal renders correctly**

Start the frontend dev server and test:
```bash
cd frontend && npm run dev
```

Navigate to a friend order page for a cycle. The modal should appear when clicking submit (if pickup locations exist or parcel is enabled). Verify:
- Both radio buttons show when both options are available
- Packeta address pre-fills from friend profile
- Pickup locations still work as before

- [ ] **Step 7: Commit**

```bash
git add frontend/src/views/FriendOrder.vue
git commit -m "feat(ui): replace pickup modal with unified delivery method modal supporting Packeta"
```

---

### Task 7: Frontend — Admin Cycle Parcel Config

**Files:**
- Modify: `frontend/src/views/CycleDetail.vue:56-58,175-185,718-743`

- [ ] **Step 1: Add parcel config refs**

In `CycleDetail.vue`, after the existing `markupSaving` ref (around line 58), add:

```javascript
// Parcel delivery
const parcelEnabled = ref(false)
const parcelFee = ref(0)
const parcelSaving = ref(false)
```

- [ ] **Step 2: Initialize parcel state from cycle data**

In the `loadAll()` function, after line 185 (`planNote.value = cycleData.plan_note || ''`), add:

```javascript
parcelEnabled.value = !!cycleData.parcel_enabled
parcelFee.value = cycleData.parcel_fee || 0
```

- [ ] **Step 3: Add save function**

After the `saveMarkup()` function (after line 238), add:

```javascript
async function saveParcel() {
  parcelSaving.value = true
  error.value = ''
  try {
    await api.updateCycle(cycleId.value, {
      parcel_enabled: parcelEnabled.value,
      parcel_fee: parcelEnabled.value ? parcelFee.value : 0
    })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    parcelSaving.value = false
  }
}
```

- [ ] **Step 4: Add parcel config UI to the template**

In the template, after the markup ratio `</div>` (after line 742, inside the same `<CardContent>`), add:

```vue
<!-- Parcel delivery -->
<div class="space-y-1">
  <Label class="text-sm font-medium">Doručenie Packetou:</Label>
  <div class="flex items-center gap-2">
    <label class="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" v-model="parcelEnabled" class="rounded" :disabled="parcelSaving" />
      <span class="text-sm">Povoliť</span>
    </label>
    <template v-if="parcelEnabled">
      <Input
        v-model.number="parcelFee"
        type="number"
        step="0.5"
        min="0"
        class="w-24 text-center"
        :disabled="parcelSaving"
        placeholder="Cena"
      />
      <span class="text-muted-foreground">EUR</span>
    </template>
    <Button
      @click="saveParcel"
      :disabled="parcelSaving"
      size="sm"
    >
      {{ parcelSaving ? 'Ukladám...' : 'Uložiť' }}
    </Button>
  </div>
</div>
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/CycleDetail.vue
git commit -m "feat(ui): add parcel delivery config controls to cycle detail admin page"
```

---

### Task 8: Frontend — Red Packeta Badge in Admin Views

**Files:**
- Modify: `frontend/src/views/CycleDetail.vue:1065-1086`
- Modify: `frontend/src/views/Distribution.vue:131-137`

- [ ] **Step 1: Add Packeta badge to CycleDetail orders table**

In `CycleDetail.vue`, after the existing pickup location badge block (after line 1085 `</Badge>`), add:

```vue
<Badge
  v-if="order.packeta_address"
  variant="outline"
  class="border-red-400 text-red-600 bg-red-50"
>
  Packeta
</Badge>
```

- [ ] **Step 2: Show delivery fee in order total**

On line 1088, the total is shown as:

```vue
<TableCell class="text-right">{{ formatPrice(order.total) }}</TableCell>
```

Change to:

```vue
<TableCell class="text-right">
  {{ formatPrice((order.total || 0) + (order.delivery_fee || 0)) }}
  <div v-if="order.delivery_fee" class="text-xs text-muted-foreground">
    ({{ formatPrice(order.total) }} + {{ formatPrice(order.delivery_fee) }} doručenie)
  </div>
</TableCell>
```

- [ ] **Step 3: Add Packeta badge to Distribution view**

In `Distribution.vue`, find the existing pickup location badge (lines 131-137). After it, add the Packeta badge:

```vue
<Badge
  v-if="friend.packeta_address"
  variant="outline"
  class="border-red-400 text-red-600 bg-red-50"
>
  Packeta
</Badge>
```

- [ ] **Step 4: Add Packeta address row in Distribution view**

After the existing header row div (the `<div>` containing the badges, balance, and status — after line 139), add:

```vue
<div v-if="friend.packeta_address" class="text-sm text-muted-foreground mt-1">
  📦 {{ friend.packeta_address }}
</div>
```

- [ ] **Step 5: Verify the badges render correctly**

Start the dev servers and check:
1. Create a test order with Packeta delivery
2. In CycleDetail orders tab: verify red "Packeta" badge appears
3. In Distribution view: verify red badge + address line below

- [ ] **Step 6: Commit**

```bash
git add frontend/src/views/CycleDetail.vue frontend/src/views/Distribution.vue
git commit -m "feat(ui): show red Packeta badge and delivery fee in admin orders and distribution views"
```

---

### Task 9: End-to-End Testing

- [ ] **Step 1: Configure a cycle with parcel delivery**

In admin, edit a cycle → toggle Packeta on → set fee to 3.50 EUR → save.

- [ ] **Step 2: Test friend profile — set default Packeta address**

Log in as a friend → open profile modal → enter a Packeta address → save → reopen modal to verify it persisted.

- [ ] **Step 3: Test friend order — select Packeta delivery**

Open the cycle as a friend → add items to cart → submit → verify the unified modal appears → select "Doručenie Packetou" → verify address is pre-filled → check "Uložiť ako predvolenú adresu" → confirm and submit.

- [ ] **Step 4: Test friend order — select standard pickup**

Submit another friend's order → verify pickup locations still work → select a standard location → confirm the Packeta fields are cleared on the order.

- [ ] **Step 5: Test admin views**

Check CycleDetail orders tab → verify red "Packeta" badge on the parcel order and blue badge on the pickup order. Check the total includes delivery fee. Check Distribution view → verify red badge + address row.

- [ ] **Step 6: Test edge cases**

- Submit with Packeta, then update order switching to pickup → verify delivery fee clears
- Disable parcel on cycle after an order was submitted with Packeta → verify existing order keeps its data, new submits can't choose Packeta
- Submit without Packeta address → verify button is disabled

- [ ] **Step 7: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during parcel delivery testing"
```
