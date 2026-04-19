# Preliminary Cycle Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "plánovaný" (planned) cycle status with a free-text plan note, visible to friends as a non-clickable announcement card.

**Architecture:** New `plan_note` column on `order_cycles`, new `'planned'` status value. Backend accepts planned status on create/update and returns `plan_note` in cycle data. Frontend shows planned cycles as non-interactive cards with the plan text, and admin can create/edit planned cycles.

**Tech Stack:** Node.js/Express backend, Vue 3 frontend, sql.js (SQLite), Tailwind CSS

---

### Task 1: Backend — Add `plan_note` column and allow `planned` status

**Files:**
- Modify: `backend/src/db/schema.js:71-76` (add migration)
- Modify: `backend/src/routes/cycles.js:74-128` (create cycle)
- Modify: `backend/src/routes/cycles.js:130-174` (update cycle)
- Modify: `backend/src/routes/cycles.js:28-42` (public cycle endpoint)
- Modify: `backend/src/routes/friends.js:179-183` (friends cycles query)

- [ ] **Step 1: Add `plan_note` column migration in schema.js**

After the existing `expected_date` migration (line ~76), add:

```javascript
  // Migration: Add plan_note column for preliminary cycle schedule text
  try {
    db.run('ALTER TABLE order_cycles ADD COLUMN plan_note TEXT');
  } catch (e) {
    // Column already exists, ignore
  }
```

- [ ] **Step 2: Update cycle creation to accept `plan_note` and `status`**

In `backend/src/routes/cycles.js`, update the POST `/` handler:

Change line 76:
```javascript
  const { name, expected_date, type, bakery_product_ids, plan_note, status } = req.body;
```

Change line 87 (the INSERT statement):
```javascript
  const cycleStatus = status === 'planned' ? 'planned' : 'open';
  const result = db.prepare('INSERT INTO order_cycles (name, status, total_friends, expected_date, type, plan_note) VALUES (?, ?, ?, ?, ?, ?)').run(name, cycleStatus, totalFriends, expected_date || null, cycleType, plan_note || null);
```

- [ ] **Step 3: Update cycle PATCH to accept `plan_note` and `planned` status**

In `backend/src/routes/cycles.js`, update the PATCH handler:

Change line 132:
```javascript
  const { status, name, shared_password, markup_ratio, expected_date, plan_note } = req.body;
```

Change line 139 (status validation):
```javascript
  if (status && !['planned', 'open', 'locked', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Neplatny status' });
  }
```

After the `expected_date` block (after line 165), add:
```javascript
  if (plan_note !== undefined) {
    updates.push('plan_note = ?');
    values.push(plan_note || null);
  }
```

- [ ] **Step 4: Return `plan_note` in friends cycles endpoint**

In `backend/src/routes/friends.js`, update the SELECT query at line 180:

```javascript
    SELECT c.id, c.name, c.status, c.created_at, c.total_friends, c.expected_date, c.type, c.plan_note
    FROM order_cycles c
```

- [ ] **Step 5: Return `plan_note` in public cycle endpoint**

In `backend/src/routes/cycles.js`, update line 30:

```javascript
  const cycle = db.prepare('SELECT id, name, status, markup_ratio, expected_date, type, plan_note FROM order_cycles WHERE id = ?').get(req.params.id);
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/schema.js backend/src/routes/cycles.js backend/src/routes/friends.js
git commit -m "feat(backend): add plan_note column and planned status for cycles"
```

---

### Task 2: Frontend — Admin create cycle with planned status and plan note

**Files:**
- Modify: `frontend/src/views/AdminDashboard.vue`

- [ ] **Step 1: Add refs for new fields**

After `const bakeryProductSearch = ref('')` (line ~23), add:

```javascript
const newCycleStatus = ref('open')
const newCyclePlanNote = ref('')
```

- [ ] **Step 2: Reset new fields when opening modal**

In `openNewCycleModal()` function, after `bakeryProductSearch.value = ''`, add:

```javascript
  newCycleStatus.value = 'open'
  newCyclePlanNote.value = ''
```

- [ ] **Step 3: Send new fields in createCycle**

In `createCycle()`, update the data object:

```javascript
    const data = {
      name: newCycleName.value,
      type: newCycleType.value,
      status: newCycleStatus.value,
      plan_note: newCyclePlanNote.value || null
    }
```

- [ ] **Step 4: Reset new fields after creation**

After `newCycleName.value = ''`, add:

```javascript
    newCycleStatus.value = 'open'
    newCyclePlanNote.value = ''
```

- [ ] **Step 5: Add status selector and plan note textarea to the modal**

After the type selector `</div>` (after line 269), before the bakery product picker, add:

```html
          <div class="space-y-2">
            <Label>Stav</Label>
            <div class="flex gap-4">
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" v-model="newCycleStatus" value="open" />
                <span class="text-sm">Otvorený</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" v-model="newCycleStatus" value="planned" />
                <span class="text-sm">Plánovaný</span>
              </label>
            </div>
          </div>
          <div v-if="newCycleStatus === 'planned'" class="space-y-2">
            <Label>Plán objednávky</Label>
            <textarea
              v-model="newCyclePlanNote"
              placeholder="napr. 1. - 3. máj objednávanie&#10;4. - 5. máj dodávka&#10;od 6. mája distribúcia"
              rows="4"
              class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            ></textarea>
          </div>
```

- [ ] **Step 6: Add `planned` to admin status helpers**

Update `getStatusVariant`:
```javascript
function getStatusVariant(status) {
  switch (status) {
    case 'planned': return 'outline'
    case 'open': return 'default'
    case 'locked': return 'secondary'
    case 'completed': return 'outline'
    default: return 'outline'
  }
}
```

Update `getStatusText`:
```javascript
function getStatusText(status) {
  switch (status) {
    case 'planned': return 'Plánovaný'
    case 'open': return 'Otvorený'
    case 'locked': return 'Uzamknutý'
    case 'completed': return 'Dokončený'
    default: return status
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/views/AdminDashboard.vue
git commit -m "feat(admin): add planned status and plan note to cycle creation"
```

---

### Task 3: Frontend — Admin edit plan note in CycleDetail

**Files:**
- Modify: `frontend/src/views/CycleDetail.vue`

- [ ] **Step 1: Add plan_note ref and initialize from cycle data**

Find where `expectedDate` is declared and add nearby:

```javascript
const planNote = ref('')
const planNoteSaving = ref(false)
```

In `loadAll()`, after `expectedDate.value = cycleData.expected_date || ''`, add:

```javascript
    planNote.value = cycleData.plan_note || ''
```

- [ ] **Step 2: Add savePlanNote function**

After the `saveExpectedDate` function, add:

```javascript
async function savePlanNote() {
  planNoteSaving.value = true
  error.value = ''
  try {
    await api.updateCycle(cycleId.value, { plan_note: planNote.value || null })
    await loadAll()
  } catch (e) {
    error.value = e.message
  } finally {
    planNoteSaving.value = false
  }
}
```

- [ ] **Step 3: Add plan note editing UI in the settings/config area**

Find the expected date input area in the template and add after it a plan note textarea:

```html
          <div class="space-y-2">
            <Label>Plán objednávky</Label>
            <textarea
              v-model="planNote"
              placeholder="napr. 1. - 3. máj objednávanie&#10;4. - 5. máj dodávka"
              rows="4"
              class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            ></textarea>
            <Button size="sm" @click="savePlanNote" :disabled="planNoteSaving">
              {{ planNoteSaving ? 'Ukladám...' : 'Uložiť plán' }}
            </Button>
          </div>
```

- [ ] **Step 4: Update status badge and controls for planned status**

Update the inline status text (line ~558):
```javascript
              {{ cycle.status === 'planned' ? 'Plánovaný' : cycle.status === 'open' ? 'Otvorený' : cycle.status === 'locked' ? 'Uzamknutý' : 'Dokončený' }}
```

Update `getStatusVariant` to include `'planned'`:
```javascript
function getStatusVariant(status) {
  switch (status) {
    case 'planned': return 'outline'
    case 'open': return 'default'
    case 'locked': return 'secondary'
    case 'completed': return 'outline'
    default: return 'outline'
  }
}
```

- [ ] **Step 5: Add "Otvoriť objednávanie" button for planned cycles**

In the action buttons area (around line 562), add before the existing lock/complete buttons:

```html
          <Button
            v-if="cycle?.status === 'planned'"
            variant="secondary"
            size="sm"
            @click="openPlannedCycle"
            class="bg-green-600 hover:bg-green-700 text-white"
          >
            Otvoriť objednávanie
          </Button>
```

Add the function:
```javascript
async function openPlannedCycle() {
  await api.updateCycle(cycleId.value, { status: 'open' })
  await loadAll()
}
```

- [ ] **Step 6: Hide lock/complete buttons when cycle is planned**

Update the existing v-if conditions:
- Lock button: change `v-if="cycle?.status !== 'completed'"` to `v-if="cycle?.status === 'open' || cycle?.status === 'locked'"`
- Complete button stays: `v-if="cycle?.status === 'locked'"` (already correct)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/views/CycleDetail.vue
git commit -m "feat(admin): edit plan note and manage planned status in cycle detail"
```

---

### Task 4: Frontend — Friend portal shows planned cycles as non-clickable cards

**Files:**
- Modify: `frontend/src/views/FriendPortal.vue`

- [ ] **Step 1: Update status helpers**

Update `getStatusVariant`:
```javascript
function getStatusVariant(status) {
  switch (status) {
    case 'planned': return 'outline'
    case 'open': return 'default'
    case 'locked': return 'secondary'
    case 'completed': return 'outline'
    default: return 'outline'
  }
}
```

Update `getStatusText`:
```javascript
function getStatusText(status) {
  switch (status) {
    case 'planned': return 'Plánovaný'
    case 'open': return 'Otvorený'
    case 'locked': return 'Uzamknutý'
    case 'completed': return 'Dokončený'
    default: return status
  }
}
```

- [ ] **Step 2: Make planned cycle cards non-clickable in the active cycles list**

Replace the active cycles `<Card>` element (line ~851-856) to conditionally disable click and cursor:

```html
          <Card
            v-for="cycle in activeCycles"
            :key="cycle.id"
            :class="[
              cycle.type === 'bakery' ? 'bg-orange-50/70 border-orange-200' : 'bg-gray-50 border-gray-200',
              cycle.status !== 'planned' ? 'cursor-pointer hover:shadow-md' : 'opacity-90'
            ]"
            class="transition-shadow"
            @click="cycle.status !== 'planned' && goToCycle(cycle.id)"
          >
```

- [ ] **Step 3: Show plan_note text and hide order-specific UI for planned cycles**

Inside the active cycle card content, after the expected_date div (line ~864), add the plan note display:

```html
                  <div v-if="cycle.status === 'planned' && cycle.plan_note" class="text-sm text-muted-foreground mt-2 whitespace-pre-line">
                    {{ cycle.plan_note }}
                  </div>
```

Update the "Neobjednané" badge to not show for planned cycles (line ~878):
```html
                    <Badge v-else-if="cycle.status === 'open'" variant="outline" class="border-yellow-500 text-yellow-700">
```
This already only shows for `'open'` status, so no change needed.

Hide the order info and chevron arrow for planned cycles. Wrap the right-side div (line ~887-894) with a condition:

```html
                <div v-if="cycle.status !== 'planned'" class="text-right">
                  <span v-if="cycle.hasOrder" class="text-sm font-medium text-foreground">
                    {{ formatPrice(cycle.orderTotal) }}
                  </span>
                  <svg class="w-5 h-5 text-muted-foreground mt-2 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
```

- [ ] **Step 4: Style the planned badge with blue/indigo color**

Update the Badge for planned status. Change the status badge rendering to use a special style for planned:

After the type badge (Pekáreň/Káva), replace the generic status badge line with:

```html
                    <Badge v-if="cycle.status === 'planned'" variant="outline" class="border-blue-400 text-blue-700 bg-blue-50">
                      Plánovaný
                    </Badge>
                    <Badge v-else :variant="getStatusVariant(cycle.status)">
                      {{ getStatusText(cycle.status) }}
                    </Badge>
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/FriendPortal.vue
git commit -m "feat(friends): show planned cycles as non-clickable announcement cards"
```

---

### Task 5: Guard planned cycles from ordering

**Files:**
- Modify: `frontend/src/views/FriendOrder.vue:68`

- [ ] **Step 1: Add planned to the locked check in FriendOrder**

Update line 68:
```javascript
const isLocked = computed(() => cycle.value?.status === 'planned' || cycle.value?.status === 'locked' || cycle.value?.status === 'completed')
```

This ensures that if someone navigates directly to `/cycle/:id` for a planned cycle, they can't order.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/views/FriendOrder.vue
git commit -m "feat: guard planned cycles from direct URL ordering"
```

---

### Task 6: Deploy to staging and verify

- [ ] **Step 1: Build frontend and deploy to staging**

```bash
./deploy/deploy.sh staging
```

- [ ] **Step 2: Verify in staging**

1. Admin: Create a planned cycle with a plan note
2. Friend portal: See the planned cycle as non-clickable with plan text
3. Admin: Change status to open — cycle becomes orderable
4. Direct URL to planned cycle: should show as locked/non-orderable
