# Bakery Self-Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public, campaign-tagged onboarding URL flow that lets new bakery customers self-register and land on the friend portal already authenticated and subscribed to bakery cycles.

**Architecture:** New `onboarding_links` table holds shareable tokens, each with a free-text note ("May onboarding") and an active flag. A new `backend/src/routes/onboarding.js` exposes public endpoints (`GET /api/onboarding/:token`, `POST /api/onboarding/:token`) that create a friend, subscribe them to bakery, and mint a session token; admin endpoints (`/api/onboarding-links`) manage the link list. Friends carry three new columns (`phone`, `email`, `onboarding_source`) so admin can trace each signup's origin.

**Tech Stack:** Node.js + Express + sql.js (`db.prepare(...).run/get/all`), Vue 3 + Vue Router, shadcn-vue components, Tailwind CSS. All UI text in Slovak. Reuses existing `validateUsername`, `isUsernameTaken`, `hashPassword`, `createFriendSession` helpers from `backend/src/middleware/friend-auth.js`. Project has no automated tests — verification per task is manual smoke testing.

**Spec:** `docs/superpowers/specs/2026-05-03-bakery-self-onboarding-design.md`

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `backend/src/db/schema.js` | Modify | Three `ALTER TABLE friends` migrations + `CREATE TABLE onboarding_links` |
| `backend/src/routes/onboarding.js` | Create | All public + admin onboarding/onboarding-links endpoints |
| `backend/src/index.js` | Modify | Mount the new router at `/api/onboarding` and `/api/onboarding-links` |
| `backend/src/routes/friends.js` | Modify | Extend admin `PATCH /:id` handler to accept `phone` and `email` |
| `frontend/src/api.js` | Modify | New API client methods for the public + admin endpoints |
| `frontend/src/views/OnboardingPage.vue` | Create | Public onboarding form rendered at `/onboard/:token` |
| `frontend/src/router.js` | Modify | New unauthenticated route `/onboard/:token` |
| `frontend/src/views/AdminInvitations.vue` | Modify | Add "Onboarding linky (pekáreň)" section + auth-mode warning banner |
| `frontend/src/views/AdminFriends.vue` | Modify | Origin badge on each row; phone/email/origin in edit modal |

---

## Task 1: Database migrations

**Files:**
- Modify: `backend/src/db/schema.js`

- [ ] **Step 1: Locate the `friends` migration block**

The `friends` table is created at `schema.js:172`. Existing `try/catch ALTER TABLE` migrations follow it (e.g. `active`, `display_name`, `uid`, `username`, `packeta_address`). Find the last `ALTER TABLE friends ADD COLUMN packeta_address TEXT` block — the new migrations go immediately after it, before any unrelated tables.

- [ ] **Step 2: Add `phone`, `email`, `onboarding_source` migrations**

Insert these three blocks immediately after the `packeta_address` migration:

```js
  // Migration: Add phone column for onboarding-captured contact info
  try {
    db.run('ALTER TABLE friends ADD COLUMN phone TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add email column for onboarding-captured contact info
  try {
    db.run('ALTER TABLE friends ADD COLUMN email TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add onboarding_source column to tag friends with the onboarding link's note
  try {
    db.run('ALTER TABLE friends ADD COLUMN onboarding_source TEXT');
  } catch (e) {
    // Column already exists, ignore
  }
```

- [ ] **Step 3: Add `onboarding_links` table**

Find the `CREATE TABLE IF NOT EXISTS roasteries` block (near the end of `initSchema`). Add the new table immediately before it:

```js
  // Onboarding links table — shareable, campaign-tagged URLs that let new
  // bakery customers self-register. Each successful submit creates a friend
  // with onboarding_source = link.note.
  db.run(`
    CREATE TABLE IF NOT EXISTS onboarding_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      note TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
```

- [ ] **Step 4: Restart backend and verify the schema**

Run from project root:

```bash
cd backend && pkill -f "node src/index.js" 2>/dev/null ; npm run dev &
sleep 2
sqlite3 src/db/database.sqlite "PRAGMA table_info(friends);" | grep -E "phone|email|onboarding_source"
sqlite3 src/db/database.sqlite ".schema onboarding_links"
```

Expected output: three rows for `phone`, `email`, `onboarding_source` from the first query, and the full `CREATE TABLE onboarding_links` definition from the second.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.js
git commit -m "feat(db): add onboarding_links table and friends.phone/email/onboarding_source columns

Schema changes for the bakery self-onboarding feature. friends gains three
nullable columns (phone, email, onboarding_source); the new onboarding_links
table holds shareable campaign-tagged tokens with an active flag.
"
```

---

## Task 2: Backend route file scaffolding + admin list endpoints

**Files:**
- Create: `backend/src/routes/onboarding.js`
- Modify: `backend/src/index.js`

- [ ] **Step 1: Create `backend/src/routes/onboarding.js` with the imports and helpers**

```js
import { Router } from 'express';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import db, { generateUid, generateInviteCode } from '../db/schema.js';
import {
  createFriendSession,
  validateUsername,
  isUsernameTaken,
  hashPassword,
} from '../middleware/friend-auth.js';

const router = Router();

// Generate a 16-character base64url token for an onboarding link.
function generateLinkToken() {
  return crypto.randomBytes(12).toString('base64url');
}

// Resolve a placeholder cycle_id for new friends, matching the existing
// global friend creation pattern in routes/friends.js.
function getPlaceholderCycleId() {
  let cycle = db.prepare('SELECT id FROM order_cycles ORDER BY id LIMIT 1').get();
  if (!cycle) {
    const result = db.prepare(
      `INSERT INTO order_cycles (name, status) VALUES ('_placeholder', 'completed')`
    ).run();
    return result.lastInsertRowid;
  }
  return cycle.id;
}

// Count of friends created via a given link's note. Free-text snapshot
// (not an FK) so the count is computed on demand.
function getRegistrationCount(note) {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM friends WHERE onboarding_source = ?'
  ).get(note);
  return row ? row.c : 0;
}

export default router;
```

- [ ] **Step 2: Add admin `GET /onboarding-links` (list) endpoint**

Insert before `export default router;`:

```js
// =====================================================================
// ADMIN ROUTES — mounted at /api/onboarding-links
// (admin auth is client-side only, per project convention)
// =====================================================================

// List all onboarding links with registration counts.
router.get('/onboarding-links', (req, res) => {
  const links = db.prepare(
    'SELECT id, token, note, active, created_at FROM onboarding_links ORDER BY created_at DESC'
  ).all();
  const withCounts = links.map(l => ({
    ...l,
    registration_count: getRegistrationCount(l.note),
  }));
  res.json(withCounts);
});
```

- [ ] **Step 3: Add admin `POST /onboarding-links` (create) endpoint**

Append before `export default router;`:

```js
// Create a new onboarding link. Body: { note }.
router.post('/onboarding-links', (req, res) => {
  const note = (req.body?.note || '').trim();
  if (!note) {
    return res.status(400).json({ error: 'Popis je povinný' });
  }

  // Generate a unique token (collision-retry, just in case).
  let token = generateLinkToken();
  while (db.prepare('SELECT id FROM onboarding_links WHERE token = ?').get(token)) {
    token = generateLinkToken();
  }

  const result = db.prepare(
    'INSERT INTO onboarding_links (token, note, active) VALUES (?, ?, 1)'
  ).run(token, note);

  const link = db.prepare(
    'SELECT id, token, note, active, created_at FROM onboarding_links WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ ...link, registration_count: 0 });
});
```

- [ ] **Step 4: Add admin `PATCH /onboarding-links/:id` and `POST /onboarding-links/:id/regenerate`**

Append before `export default router;`:

```js
// Update an onboarding link's active flag and/or note. Body: { active?, note? }.
router.patch('/onboarding-links/:id', (req, res) => {
  const link = db.prepare('SELECT * FROM onboarding_links WHERE id = ?').get(req.params.id);
  if (!link) {
    return res.status(404).json({ error: 'Link nenájdený' });
  }

  const updates = [];
  const params = [];

  if (req.body.active !== undefined) {
    updates.push('active = ?');
    params.push(req.body.active ? 1 : 0);
  }
  if (req.body.note !== undefined) {
    const note = String(req.body.note).trim();
    if (!note) {
      return res.status(400).json({ error: 'Popis nemôže byť prázdny' });
    }
    updates.push('note = ?');
    params.push(note);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Žiadne zmeny' });
  }

  params.push(req.params.id);
  db.prepare(`UPDATE onboarding_links SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare(
    'SELECT id, token, note, active, created_at FROM onboarding_links WHERE id = ?'
  ).get(req.params.id);
  res.json({ ...updated, registration_count: getRegistrationCount(updated.note) });
});

// Regenerate the token (kills the old URL immediately).
router.post('/onboarding-links/:id/regenerate', (req, res) => {
  const link = db.prepare('SELECT * FROM onboarding_links WHERE id = ?').get(req.params.id);
  if (!link) {
    return res.status(404).json({ error: 'Link nenájdený' });
  }

  let token = generateLinkToken();
  while (db.prepare('SELECT id FROM onboarding_links WHERE token = ?').get(token)) {
    token = generateLinkToken();
  }
  db.prepare('UPDATE onboarding_links SET token = ? WHERE id = ?').run(token, req.params.id);

  const updated = db.prepare(
    'SELECT id, token, note, active, created_at FROM onboarding_links WHERE id = ?'
  ).get(req.params.id);
  res.json({ ...updated, registration_count: getRegistrationCount(updated.note) });
});
```

- [ ] **Step 5: Add admin `DELETE /onboarding-links/:id`**

Append before `export default router;`:

```js
// Delete a link. Blocked if it has any registrations — admin should
// deactivate instead so the audit trail (onboarding_source on friends) stays
// understandable.
router.delete('/onboarding-links/:id', (req, res) => {
  const link = db.prepare('SELECT * FROM onboarding_links WHERE id = ?').get(req.params.id);
  if (!link) {
    return res.status(404).json({ error: 'Link nenájdený' });
  }

  const count = getRegistrationCount(link.note);
  if (count > 0) {
    return res.status(400).json({
      error: `Link už má ${count} registrácií, nemôže byť vymazaný — deaktivuj ho namiesto toho.`,
    });
  }

  db.prepare('DELETE FROM onboarding_links WHERE id = ?').run(req.params.id);
  res.status(204).send();
});
```

- [ ] **Step 6: Mount the router in `backend/src/index.js`**

Find the existing import block (lines ~9-24) and add:

```js
import onboardingRouter from './routes/onboarding.js';
```

Find the existing `app.use('/api/...', ...)` mount block and add a single mount at `/api`:

```js
app.use('/api', onboardingRouter);
```

The handler paths inside `onboarding.js` already include the full sub-prefix (`/onboarding-links`, `/onboarding/:token`), so this single mount routes both groups correctly. Confirm the handlers added so far use these exact paths:
- `GET  /onboarding-links`
- `POST /onboarding-links`
- `PATCH /onboarding-links/:id`
- `POST /onboarding-links/:id/regenerate`
- `DELETE /onboarding-links/:id`

Public routes added in Task 3 follow the same pattern: `/onboarding/:token`, `/onboarding/:token/check-username`.

- [ ] **Step 7: Restart backend and smoke-test admin endpoints**

```bash
cd backend && pkill -f "node src/index.js" 2>/dev/null ; npm run dev &
sleep 2

# Create a link
curl -sX POST http://localhost:3000/api/onboarding-links \
  -H 'Content-Type: application/json' \
  -d '{"note":"Smoke test"}' | tee /tmp/link.json

# List
curl -s http://localhost:3000/api/onboarding-links

# Toggle to inactive
LINK_ID=$(grep -o '"id":[0-9]*' /tmp/link.json | head -1 | cut -d: -f2)
curl -sX PATCH http://localhost:3000/api/onboarding-links/$LINK_ID \
  -H 'Content-Type: application/json' \
  -d '{"active":false}'

# Regenerate
curl -sX POST http://localhost:3000/api/onboarding-links/$LINK_ID/regenerate

# Delete (should succeed since 0 registrations)
curl -sX DELETE http://localhost:3000/api/onboarding-links/$LINK_ID -w "%{http_code}\n"
```

Expected: each curl returns a JSON object (or `204` for the DELETE). `created_at`, `token`, `note`, `active`, `registration_count` fields present.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/onboarding.js backend/src/index.js
git commit -m "feat(api): add admin CRUD for onboarding-links

New /api/onboarding-links endpoints (list, create, patch, regenerate,
delete) for managing shareable bakery onboarding URLs. Token is a 16-char
base64url slug; deletion is blocked when the link has registrations.
"
```

---

## Task 3: Backend public onboarding endpoints

**Files:**
- Modify: `backend/src/routes/onboarding.js`

- [ ] **Step 1: Add `GET /onboarding/:token` (public link info)**

Append before `export default router;` in `onboarding.js`:

```js
// =====================================================================
// PUBLIC ROUTES — mounted at /api/onboarding
// =====================================================================

// Get info about an onboarding link (used by the public page on mount).
router.get('/onboarding/:token', (req, res) => {
  const link = db.prepare(
    'SELECT note, active FROM onboarding_links WHERE token = ?'
  ).get(req.params.token);

  if (!link) {
    return res.status(404).json({ error: 'Odkaz neexistuje' });
  }
  res.json({ active: !!link.active, note: link.note });
});
```

- [ ] **Step 2: Add `GET /onboarding/:token/check-username` (availability check)**

Append:

```js
// Username availability check, gated by an active onboarding token so it
// can't be used as a general user enumeration endpoint.
router.get('/onboarding/:token/check-username', (req, res) => {
  const link = db.prepare('SELECT active FROM onboarding_links WHERE token = ?').get(req.params.token);
  if (!link) {
    return res.status(404).json({ error: 'Odkaz neexistuje' });
  }
  if (!link.active) {
    return res.status(403).json({ error: 'Tento odkaz už nie je aktívny' });
  }

  const username = (req.query.u || '').toString().toLowerCase();
  const formatError = validateUsername(username);
  if (formatError) {
    return res.json({ available: false, reason: formatError });
  }

  return res.json({ available: !isUsernameTaken(username) });
});
```

- [ ] **Step 3: Add `POST /onboarding/:token` (create friend + auto-login)**

Append:

```js
// Submit the onboarding form. Creates a friend, subscribes them to bakery,
// mints a session token, and returns it for auto-login.
router.post('/onboarding/:token', (req, res) => {
  const link = db.prepare(
    'SELECT id, note, active FROM onboarding_links WHERE token = ?'
  ).get(req.params.token);
  if (!link) {
    return res.status(404).json({ error: 'Neplatný odkaz' });
  }
  if (!link.active) {
    return res.status(403).json({ error: 'Tento odkaz už nie je aktívny' });
  }

  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();
  const usernameRaw = (req.body.username || '').toLowerCase().trim();
  const password = req.body.password || '';

  if (!name) return res.status(400).json({ error: 'Meno je povinné', field: 'name' });
  if (!phone) return res.status(400).json({ error: 'Mobil je povinný', field: 'phone' });
  if (email && !email.includes('@')) {
    return res.status(400).json({ error: 'Neplatný email', field: 'email' });
  }

  const usernameError = validateUsername(usernameRaw);
  if (usernameError) {
    return res.status(400).json({ error: usernameError, field: 'username' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Heslo musí mať aspoň 4 znaky', field: 'password' });
  }
  if (isUsernameTaken(usernameRaw)) {
    return res.status(409).json({ error: 'Užívateľské meno je už obsadené', field: 'username' });
  }

  // Generate unique uid + invite_code (collision-retry, mirrors friends.js).
  let uid = generateUid();
  while (db.prepare('SELECT id FROM friends WHERE uid = ?').get(uid)) {
    uid = generateUid();
  }
  let inviteCode = generateInviteCode();
  while (db.prepare('SELECT id FROM friends WHERE invite_code = ?').get(inviteCode)) {
    inviteCode = generateInviteCode();
  }
  const accessToken = nanoid(12);
  const cycleId = getPlaceholderCycleId();

  const result = db.prepare(`
    INSERT INTO friends
      (cycle_id, name, uid, access_token, invite_code, active,
       phone, email, onboarding_source, username, password_hash)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(
    cycleId, name, uid, accessToken, inviteCode,
    phone, email || null, link.note, usernameRaw, hashPassword(password)
  );
  const friendId = result.lastInsertRowid;

  // Subscribe to bakery only.
  db.prepare(
    "INSERT INTO friend_subscriptions (friend_id, type) VALUES (?, 'bakery')"
  ).run(friendId);

  // Mint session for auto-login.
  const session = createFriendSession(friendId);

  res.status(201).json({
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    friendId,
    friendName: name,
  });
});
```

- [ ] **Step 4: Restart backend and smoke-test the public flow**

```bash
cd backend && pkill -f "node src/index.js" 2>/dev/null ; npm run dev &
sleep 2

# Create a link to use
curl -sX POST http://localhost:3000/api/onboarding-links \
  -H 'Content-Type: application/json' \
  -d '{"note":"Plan smoke test"}' | tee /tmp/link.json
TOKEN=$(grep -o '"token":"[^"]*"' /tmp/link.json | cut -d'"' -f4)

# GET the link info
curl -s http://localhost:3000/api/onboarding/$TOKEN

# Username availability for a fresh username
curl -s "http://localhost:3000/api/onboarding/$TOKEN/check-username?u=plan_test"

# Submit
curl -sX POST http://localhost:3000/api/onboarding/$TOKEN \
  -H 'Content-Type: application/json' \
  -d '{"name":"Plan Test","phone":"+421900000000","email":"plan@test.sk","username":"plan_test","password":"abcd1234"}' \
  | tee /tmp/submit.json

# Verify friend was created with the right tag and bakery sub
sqlite3 src/db/database.sqlite \
  "SELECT id, name, phone, email, onboarding_source, username FROM friends WHERE username='plan_test';"
sqlite3 src/db/database.sqlite \
  "SELECT * FROM friend_subscriptions WHERE friend_id=(SELECT id FROM friends WHERE username='plan_test');"

# Verify the session token works as Bearer auth
SESSION=$(grep -o '"sessionToken":"[^"]*"' /tmp/submit.json | cut -d'"' -f4)
curl -s -H "Authorization: Bearer $SESSION" http://localhost:3000/api/friends/cycles | head -c 200

# Cleanup
sqlite3 src/db/database.sqlite "DELETE FROM friends WHERE username='plan_test';"
sqlite3 src/db/database.sqlite "DELETE FROM onboarding_links WHERE note='Plan smoke test';"
```

Expected: friend row has `onboarding_source = "Plan smoke test"`, one `bakery` row in `friend_subscriptions`, and the Bearer token successfully fetches `/friends/cycles` (returning a JSON array, not a 401).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/onboarding.js
git commit -m "feat(api): add public onboarding endpoints

GET /api/onboarding/:token returns the link's active state and note.
POST /api/onboarding/:token validates the form, creates a friend
(reusing the existing global-friend creation pattern), subscribes them
to bakery, and mints a session token for auto-login.
"
```

---

## Task 4: Frontend API client methods

**Files:**
- Modify: `frontend/src/api.js`

- [ ] **Step 1: Add public onboarding methods**

Find the `validateInviteCode` / `submitInvitation` methods (around line ~262). Add immediately after them:

```js
  // Public onboarding (bakery self-signup)
  getOnboardingLink: (token) => request(`/onboarding/${token}`),
  checkOnboardingUsername: (token, username) =>
    request(`/onboarding/${token}/check-username?u=${encodeURIComponent(username)}`),
  submitOnboarding: (token, data) =>
    request(`/onboarding/${token}`, { method: 'POST', body: data }),
```

- [ ] **Step 2: Add admin onboarding-link methods**

Find the admin `getInvitations` / `updateInvitation` / `deleteInvitation` block (around line ~269). Add immediately after:

```js
  // Admin onboarding links
  getOnboardingLinks: () => adminRequest('/onboarding-links'),
  createOnboardingLink: (note) =>
    adminRequest('/onboarding-links', { method: 'POST', body: { note } }),
  updateOnboardingLink: (id, data) =>
    adminRequest(`/onboarding-links/${id}`, { method: 'PATCH', body: data }),
  regenerateOnboardingLink: (id) =>
    adminRequest(`/onboarding-links/${id}/regenerate`, { method: 'POST' }),
  deleteOnboardingLink: (id) =>
    adminRequest(`/onboarding-links/${id}`, { method: 'DELETE' }),
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.js
git commit -m "feat(api-client): add onboarding link methods

Public methods for fetching link info, checking username availability,
and submitting the onboarding form. Admin methods for the onboarding-link
CRUD.
"
```

---

## Task 5: Public onboarding page

**Files:**
- Create: `frontend/src/views/OnboardingPage.vue`
- Modify: `frontend/src/router.js`

- [ ] **Step 1: Add the route to `router.js`**

Find the existing routes array. Add a new route before any catch-all:

```js
{
  path: '/onboard/:token',
  name: 'onboarding',
  component: () => import('./views/OnboardingPage.vue'),
  meta: { requiresAuth: false },
},
```

If the existing routes use a different lazy-import or layout pattern (e.g. `{ component: OnboardingPage }` with a direct import at the top), match that pattern instead.

- [ ] **Step 2: Create `frontend/src/views/OnboardingPage.vue`**

```vue
<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const route = useRoute()
const router = useRouter()

const loading = ref(true)
const linkInfo = ref(null)        // { active, note } when link is found
const linkError = ref('')         // 404 / network error message
const inactive = ref(false)       // link exists but is inactive

const form = ref({ name: '', phone: '', email: '', username: '', password: '' })
const fieldErrors = ref({})       // { username: 'taken', ... }
const usernameStatus = ref('')    // '', 'checking', 'available', 'taken', 'invalid'
const submitting = ref(false)
const submitError = ref('')

const token = computed(() => route.params.token)

onMounted(async () => {
  try {
    linkInfo.value = await api.getOnboardingLink(token.value)
    if (!linkInfo.value.active) inactive.value = true
  } catch (e) {
    linkError.value = e.message || 'Odkaz neexistuje'
  } finally {
    loading.value = false
  }
})

let usernameTimer = null
watch(() => form.value.username, (val) => {
  fieldErrors.value.username = ''
  if (!val) { usernameStatus.value = ''; return }
  usernameStatus.value = 'checking'
  clearTimeout(usernameTimer)
  usernameTimer = setTimeout(async () => {
    try {
      const r = await api.checkOnboardingUsername(token.value, val.toLowerCase().trim())
      if (r.available) usernameStatus.value = 'available'
      else if (r.reason) { usernameStatus.value = 'invalid'; fieldErrors.value.username = r.reason }
      else { usernameStatus.value = 'taken'; fieldErrors.value.username = 'Užívateľské meno je už obsadené' }
    } catch (e) {
      usernameStatus.value = ''
    }
  }, 350)
})

async function submit() {
  submitError.value = ''
  fieldErrors.value = {}

  if (!form.value.name.trim()) { fieldErrors.value.name = 'Meno je povinné'; return }
  if (!form.value.phone.trim()) { fieldErrors.value.phone = 'Mobil je povinný'; return }
  if (!form.value.username.trim()) { fieldErrors.value.username = 'Užívateľské meno je povinné'; return }
  if (form.value.password.length < 4) { fieldErrors.value.password = 'Heslo musí mať aspoň 4 znaky'; return }

  submitting.value = true
  try {
    const result = await api.submitOnboarding(token.value, {
      name: form.value.name.trim(),
      phone: form.value.phone.trim(),
      email: form.value.email.trim(),
      username: form.value.username.toLowerCase().trim(),
      password: form.value.password,
    })

    // Persist the session in the same shape FriendPortal expects from modern login.
    localStorage.setItem('gorifi_friend_auth', JSON.stringify({
      friendId: result.friendId,
      friendName: result.friendName,
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt,
    }))

    router.push('/')
  } catch (e) {
    if (e.field) fieldErrors.value[e.field] = e.message
    else submitError.value = e.message || 'Nepodarilo sa odoslať formulár'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-background flex items-center justify-center p-4">
    <div class="w-full max-w-md">
      <div v-if="loading" class="text-center text-muted-foreground py-12">Načítavam…</div>

      <Card v-else-if="linkError">
        <CardHeader><CardTitle>Odkaz neexistuje</CardTitle></CardHeader>
        <CardContent>
          <p class="text-muted-foreground">{{ linkError }}</p>
        </CardContent>
      </Card>

      <Card v-else-if="inactive">
        <CardHeader><CardTitle>Tento odkaz už nie je aktívny</CardTitle></CardHeader>
        <CardContent>
          <p class="text-muted-foreground">Skús sa obrátiť na osobu, ktorá ti odkaz poslala.</p>
        </CardContent>
      </Card>

      <Card v-else>
        <CardHeader>
          <CardTitle>Registrácia — Pekáreň</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <Alert v-if="submitError" variant="destructive">
            <AlertDescription>{{ submitError }}</AlertDescription>
          </Alert>

          <div class="space-y-2">
            <Label for="ob-name">Meno</Label>
            <Input id="ob-name" v-model="form.name" />
            <p v-if="fieldErrors.name" class="text-sm text-destructive">{{ fieldErrors.name }}</p>
          </div>

          <div class="space-y-2">
            <Label for="ob-phone">Mobil</Label>
            <Input id="ob-phone" v-model="form.phone" type="tel" autocomplete="tel" />
            <p v-if="fieldErrors.phone" class="text-sm text-destructive">{{ fieldErrors.phone }}</p>
          </div>

          <div class="space-y-2">
            <Label for="ob-email">Email <span class="text-muted-foreground text-xs">(nepovinné)</span></Label>
            <Input id="ob-email" v-model="form.email" type="email" autocomplete="email" />
            <p v-if="fieldErrors.email" class="text-sm text-destructive">{{ fieldErrors.email }}</p>
          </div>

          <div class="space-y-2">
            <Label for="ob-username">Užívateľské meno</Label>
            <Input id="ob-username" v-model="form.username" autocomplete="username" />
            <p v-if="usernameStatus === 'available'" class="text-sm text-emerald-600">Voľné</p>
            <p v-else-if="fieldErrors.username" class="text-sm text-destructive">{{ fieldErrors.username }}</p>
            <p v-else-if="usernameStatus === 'checking'" class="text-sm text-muted-foreground">Kontrolujem…</p>
          </div>

          <div class="space-y-2">
            <Label for="ob-password">Heslo</Label>
            <Input id="ob-password" v-model="form.password" type="password" autocomplete="new-password" />
            <p v-if="fieldErrors.password" class="text-sm text-destructive">{{ fieldErrors.password }}</p>
          </div>

          <Button class="w-full" :disabled="submitting" @click="submit">
            {{ submitting ? 'Posielam…' : 'Vytvoriť účet' }}
          </Button>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
```

**Note on the `request()` helper:** verify in `frontend/src/api.js` that thrown errors carry `e.field` when the backend returns one. If the helper currently only carries `e.message`, extend it: when the response body has a `field` property, attach it to the thrown error. (Look for `throw new Error(...)` inside `request()` — replace with `const err = new Error(body.error); err.field = body.field; throw err;`.)

- [ ] **Step 3: Verify `localStorage` shape matches `FriendPortal`**

Open `frontend/src/views/FriendPortal.vue` and search for `gorifi_friend_auth`. Confirm the keys this plan writes (`friendId`, `friendName`, `sessionToken`, `expiresAt`) match what FriendPortal reads. If FriendPortal expects different keys (e.g. `token` instead of `sessionToken`), update the `localStorage.setItem` call in the new `OnboardingPage.vue` to match.

- [ ] **Step 4: Smoke-test in browser**

```bash
cd backend && npm run dev &
cd frontend && npm run dev &
```

Then in a browser:
1. Create a link via curl (or wait for Task 6's UI). Token is in the response.
2. Navigate to `http://localhost:5173/onboard/<token>`. The form should render with the title "Registrácia — Pekáreň".
3. Type a username — within ~350ms a "Voľné" or "obsadené" message should appear below.
4. Fill all fields and submit. The browser should redirect to `/` (FriendPortal) and show only bakery cycles (or "no cycles" if none are open).
5. In the friends DB, confirm the new friend has `phone`, `email`, `onboarding_source`, and a `bakery` row in `friend_subscriptions`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/OnboardingPage.vue frontend/src/router.js
# also api.js if you had to extend the request helper to carry .field
git add frontend/src/api.js 2>/dev/null
git commit -m "feat(frontend): add public onboarding page

Public /onboard/:token route renders a Slovak signup form (name, phone,
email, username, password) with debounced username availability check.
On submit, stores the session token in localStorage and redirects to the
friend portal already authenticated.
"
```

---

## Task 6: Admin onboarding-links section in Pozvánky

**Files:**
- Modify: `frontend/src/views/AdminInvitations.vue`

- [ ] **Step 1: Read the existing file structure**

Open `AdminInvitations.vue`. Identify:
- The `<script setup>` block — note where `onMounted`, `loadInvitations`, etc. live.
- The first major section in `<template>` after the page header (you'll insert the new section just inside the main container, *above* the existing invitations list).

- [ ] **Step 2: Add state and lifecycle hooks for onboarding links**

In the `<script setup>` block, add near the top after existing imports:

```js
import { computed } from 'vue'
```

(if not already imported), and below the existing refs add:

```js
const onboardingLinks = ref([])
const onboardingLoading = ref(true)
const onboardingError = ref('')
const newLinkNote = ref('')
const showNewLinkInput = ref(false)
const authMode = ref('legacy')

const baseUrl = computed(() => window.location.origin)

async function loadOnboardingLinks() {
  onboardingLoading.value = true
  try {
    onboardingLinks.value = await api.getOnboardingLinks()
  } catch (e) {
    onboardingError.value = e.message || 'Nepodarilo sa načítať linky'
  } finally {
    onboardingLoading.value = false
  }
}

async function loadAuthMode() {
  try {
    const settings = await api.getAdminSettings()
    authMode.value = settings.authMode || 'legacy'
  } catch (e) {
    // Non-fatal
  }
}

async function createOnboardingLink() {
  if (!newLinkNote.value.trim()) return
  try {
    await api.createOnboardingLink(newLinkNote.value.trim())
    newLinkNote.value = ''
    showNewLinkInput.value = false
    await loadOnboardingLinks()
  } catch (e) {
    alert(e.message || 'Nepodarilo sa vytvoriť link')
  }
}

async function toggleOnboardingLink(link) {
  try {
    await api.updateOnboardingLink(link.id, { active: !link.active })
    await loadOnboardingLinks()
  } catch (e) {
    alert(e.message)
  }
}

async function regenerateOnboardingLink(link) {
  if (!confirm(`Vygenerovať nový token pre "${link.note}"? Pôvodná URL prestane fungovať.`)) return
  try {
    await api.regenerateOnboardingLink(link.id)
    await loadOnboardingLinks()
  } catch (e) {
    alert(e.message)
  }
}

async function deleteOnboardingLink(link) {
  if (link.registration_count > 0) return
  if (!confirm(`Vymazať link "${link.note}"?`)) return
  try {
    await api.deleteOnboardingLink(link.id)
    await loadOnboardingLinks()
  } catch (e) {
    alert(e.message)
  }
}

function copyLink(token) {
  const url = `${baseUrl.value}/onboard/${token}`
  navigator.clipboard.writeText(url).then(() => {
    // Optional: show a toast
  })
}

function formatDate(s) {
  if (!s) return ''
  const d = new Date(s)
  return d.toLocaleDateString('sk-SK')
}
```

Find the existing `onMounted` call — extend it (or chain a new one) so both loaders run:

```js
onMounted(async () => {
  await Promise.all([loadInvitations(), loadOnboardingLinks(), loadAuthMode()])
})
```

(If the existing `onMounted` already does work, merge the new calls into the same block rather than registering a second `onMounted`.)

- [ ] **Step 3: Insert the new section in `<template>`**

Find the main content container (typically a `<main>` or top-level `<div class="container">`). Just inside it, before the existing invitations section, add:

```vue
<!-- Auth-mode warning -->
<Alert v-if="authMode === 'legacy'" class="mb-4 border-amber-300 bg-amber-50">
  <AlertDescription class="text-amber-800">
    Auth mode je <strong>'legacy'</strong> — používatelia z onboardingu sa po
    vypršaní úvodnej session nebudú môcť znovu prihlásiť, kým neprepneš na
    <strong>'modern'</strong> v Nastaveniach.
  </AlertDescription>
</Alert>

<!-- Onboarding links section -->
<section class="mb-8">
  <div class="flex justify-between items-center mb-3">
    <h2 class="text-lg font-semibold">Onboarding linky (pekáreň)</h2>
    <Button v-if="!showNewLinkInput" size="sm" @click="showNewLinkInput = true">+ Nový link</Button>
  </div>

  <div v-if="showNewLinkInput" class="flex gap-2 mb-3">
    <Input
      v-model="newLinkNote"
      placeholder="napr. Máj onboarding"
      @keyup.enter="createOnboardingLink"
      class="flex-1"
    />
    <Button @click="createOnboardingLink" :disabled="!newLinkNote.trim()">Vytvoriť</Button>
    <Button variant="ghost" @click="showNewLinkInput = false; newLinkNote = ''">Zrušiť</Button>
  </div>

  <div v-if="onboardingLoading" class="text-muted-foreground py-4">Načítavam…</div>
  <div v-else-if="onboardingLinks.length === 0" class="text-muted-foreground py-4">
    Zatiaľ žiadne onboarding linky.
  </div>
  <div v-else class="space-y-3">
    <Card v-for="link in onboardingLinks" :key="link.id">
      <CardContent class="p-4">
        <div class="flex items-start justify-between gap-3 mb-2">
          <div class="font-semibold">{{ link.note }}</div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              @click="toggleOnboardingLink(link)"
              :class="['text-xs px-2 py-1 rounded-full border',
                link.active ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-muted border-border text-muted-foreground']"
            >
              {{ link.active ? 'Aktívny' : 'Neaktívny' }}
            </button>
            <button
              @click="regenerateOnboardingLink(link)"
              title="Vygenerovať nový token"
              class="text-muted-foreground hover:text-foreground"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              @click="deleteOnboardingLink(link)"
              :disabled="link.registration_count > 0"
              :title="link.registration_count > 0 ? 'Link má registrácie — najprv ho deaktivuj' : 'Vymazať'"
              class="text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
        <div class="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <code class="font-mono text-xs bg-muted px-2 py-1 rounded truncate flex-1">
            {{ baseUrl }}/onboard/{{ link.token }}
          </code>
          <Button size="sm" variant="outline" @click="copyLink(link.token)">Kopírovať</Button>
        </div>
        <div class="text-xs text-muted-foreground">
          {{ link.registration_count }} registrácií · Vytvorené {{ formatDate(link.created_at) }}
        </div>
      </CardContent>
    </Card>
  </div>
</section>
```

- [ ] **Step 4: Make sure imports cover the new components**

At the top of the `<script setup>` block, ensure these are imported (some likely are already):

```js
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
```

- [ ] **Step 5: Smoke-test in browser**

1. Open `/admin/invitations` (or wherever the existing Pozvánky tab routes to).
2. Verify the new "Onboarding linky (pekáreň)" section appears above the existing invitations list.
3. Click "+ Nový link", type "Test", click "Vytvoriť" — a new card appears with `0 registrácií`.
4. Click "Kopírovať" — paste somewhere to confirm the URL has the right shape `<host>/onboard/<token>`.
5. Click the active/inactive toggle — the badge text and color flip.
6. Click 🔄 — confirm prompt; on accept the token in the URL changes.
7. Open the URL in a private window — the form renders.
8. Click 🗑 — link is deleted (since `0 registrácií`).
9. Submit one onboarding via a different link, then return to admin: the registration count for that link increments to 1, and the trash icon becomes disabled with tooltip "Link má registrácie — najprv ho deaktivuj".
10. If `auth_mode` is currently `legacy`, the yellow warning banner appears at the top of the section.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/views/AdminInvitations.vue
git commit -m "feat(admin): add onboarding-links section to Pozvánky

New section above the existing referral invitations list. Admin can create
campaign-tagged links (e.g. 'May onboarding'), copy the URL, toggle
active/inactive, regenerate the token, and delete unused links. A yellow
banner warns when auth_mode is 'legacy' since onboarded users won't be
able to re-login after their initial session expires.
"
```

---

## Task 7: Origin badge + phone/email/origin in AdminFriends

**Files:**
- Modify: `frontend/src/views/AdminFriends.vue`

- [ ] **Step 1: Locate the friend row template and the edit modal**

Search for the friend row that renders `friend.name` (likely in a table or card). Search for the `editingFriend` ref and the `<Dialog>` containing `Upraviť priateľa`.

- [ ] **Step 2: Add the origin badge to the friend row**

Wherever the row renders the friend's name, append:

```vue
<Badge
  v-if="friend.onboarding_source"
  variant="outline"
  class="border-gray-400 text-gray-600 bg-gray-50 ml-2 text-xs"
>
  {{ friend.onboarding_source }}
</Badge>
```

If `Badge` is not yet imported, add:

```js
import { Badge } from '@/components/ui/badge'
```

- [ ] **Step 3: Add phone, email, origin to the edit modal**

Inside the edit dialog's content (under the existing `name` / `display_name` inputs), add:

```vue
<div class="space-y-2">
  <Label for="friend-phone">Telefón</Label>
  <Input id="friend-phone" v-model="friendPhone" />
</div>

<div class="space-y-2">
  <Label for="friend-email">Email</Label>
  <Input id="friend-email" v-model="friendEmail" type="email" />
</div>

<div v-if="editingFriend?.onboarding_source" class="space-y-1">
  <Label class="text-muted-foreground">Pôvod onboardingu</Label>
  <div class="text-sm font-medium">{{ editingFriend.onboarding_source }}</div>
</div>
```

In `<script setup>`, add the new refs alongside the existing form refs:

```js
const friendPhone = ref('')
const friendEmail = ref('')
```

- [ ] **Step 4: Extend the admin `PATCH /friends/:id` handler to accept phone + email**

`api.updateFriend(id, data)` is defined in `frontend/src/api.js:167` as `request('/friends/${id}', { method: 'PATCH', body: data })` — it hits the admin handler at `backend/src/routes/friends.js:431`, which currently accepts only `name`, `display_name`, and `active`. Extend it.

In `friends.js`, change the destructuring at line 432 from:

```js
const { name, display_name, active } = req.body;
```

to:

```js
const { name, display_name, active, phone, email } = req.body;
```

Then, after the `if (active !== undefined)` block (just before `if (updates.length > 0)`), add:

```js
  if (phone !== undefined) {
    updates.push('phone = ?');
    values.push(phone || null);
  }
  if (email !== undefined) {
    const trimmed = email ? email.trim() : null;
    if (trimmed && !trimmed.includes('@')) {
      return res.status(400).json({ error: 'Neplatný email' });
    }
    updates.push('email = ?');
    values.push(trimmed);
  }
```

- [ ] **Step 5: Wire up modal open + save in `AdminFriends.vue`**

Find the function that opens the edit modal (search for `editingFriend.value =`, around line ~83). After the existing assignments, add:

```js
friendPhone.value = friend.phone || ''
friendEmail.value = friend.email || ''
```

Find the function (or branch) that resets state for a new-friend modal (search for `editingFriend.value = null`). Reset the new refs there too:

```js
friendPhone.value = ''
friendEmail.value = ''
```

In `saveFriend()` (around line 89), find the existing `api.updateFriend(editingFriend.value.id, ...)` call. Add `phone` and `email` to its body payload:

```js
await api.updateFriend(editingFriend.value.id, {
  name: friendName.value.trim(),
  display_name: friendDisplayName.value.trim() || null,
  phone: friendPhone.value.trim() || null,
  email: friendEmail.value.trim() || null,
})
```

(If the existing call uses different field names — `display_name` vs `displayName`, etc. — match those exactly. Don't blindly replace; merge.)

- [ ] **Step 6: Smoke-test in browser**

1. Open `/admin/friends`.
2. Find a friend that was created via an onboarding link (the one created during Task 5/6 testing) — confirm the grey badge with the link's note appears next to their name.
3. Click "Upraviť" on that friend. The modal should show their phone, email, and a read-only "Pôvod onboardingu: …" line.
4. Edit the phone, save, reopen — phone is persisted.
5. For a friend NOT created via onboarding, the badge is absent and the "Pôvod onboardingu" field is hidden.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/views/AdminFriends.vue
# also backend/src/routes/friends.js if you extended the admin update endpoint
git add backend/src/routes/friends.js 2>/dev/null
git commit -m "feat(admin): show onboarding origin badge and edit phone/email on friends

Friend rows now display a small grey badge with the onboarding link's note
when present. The Upraviť priateľa modal gains editable phone and email
fields plus a read-only 'Pôvod onboardingu' display.
"
```

---

## Task 8: End-to-end manual verification

**Files:** None.

- [ ] **Step 1: Reset to a clean slate**

```bash
cd backend && pkill -f "node src/index.js" 2>/dev/null ; npm run dev &
cd frontend && pkill -f "vite" 2>/dev/null ; npm run dev &
sleep 3
```

- [ ] **Step 2: Run through the full onboarding flow**

1. Log in as admin, open the Pozvánky tab.
2. Confirm the "Onboarding linky (pekáreň)" section is at the top.
3. If `auth_mode = legacy`, confirm the yellow warning banner appears.
4. Create a link "Plan E2E test".
5. Copy the URL, open it in a private/incognito window.
6. Submit the form with: Meno = "E2E Test", Mobil = "+421900111222", Email = "e2e@test.sk", username = "e2e_test", password = "abcd".
7. Confirm the page redirects to `/` (FriendPortal) and shows the friend authenticated.
8. Confirm only bakery cycles are visible (no coffee cycles in the list — assuming a coffee cycle exists; if not, just confirm the page renders for the new friend).

- [ ] **Step 3: Verify admin-side traceability**

1. Back in the admin window, refresh `/admin/friends`. Find "E2E Test".
2. Confirm a grey "Plan E2E test" badge sits next to the name.
3. Open Upraviť — phone, email, and "Pôvod onboardingu: Plan E2E test" all show the right values.
4. Refresh the Pozvánky tab — the link's registration count is now `1`. The trash icon is disabled.

- [ ] **Step 4: Verify guards work**

1. In the admin window, toggle the link to inactive.
2. In the private window, open the original URL again — confirm the "Tento odkaz už nie je aktívny" page renders.
3. In the admin window, regenerate the token. Open the previous URL — confirm 404 page.
4. Try a new submission via the new URL with username = "e2e_test" — confirm it returns the inline "Užívateľské meno je už obsadené" error.

- [ ] **Step 5: Cleanup test data and commit any final fixes**

```bash
sqlite3 backend/src/db/database.sqlite "DELETE FROM friend_subscriptions WHERE friend_id IN (SELECT id FROM friends WHERE username='e2e_test');"
sqlite3 backend/src/db/database.sqlite "DELETE FROM friends WHERE username='e2e_test';"
sqlite3 backend/src/db/database.sqlite "DELETE FROM onboarding_links WHERE note='Plan E2E test';"
```

If any UI issues emerged during E2E testing, commit fixes with a short `fix(...)` message before declaring done.

---

## Notes for the implementer

- **Slovak strings everywhere.** Match the diacritic style of the rest of the codebase. Don't transliterate to ASCII unless an existing file does so (e.g. some helpers in `friend-auth.js` use ASCII).
- **`adminRequest` doesn't validate server-side.** Per CLAUDE.md, admin routes don't check the token on the backend — frontend gates the UI. Don't add a server-side admin auth guard to the new routes.
- **`request()` error helper.** If thrown errors don't carry `field`, extending it (Task 5, Step 2 note) is the only place where this matters. Do it once, reuse across the form.
- **No automated tests.** Project doesn't have any for similar features. Manual smoke testing per task is the pattern.
- **Worktree.** This plan can be executed in a worktree; nothing in the migrations is destructive (all `try/catch ALTER TABLE`, all `CREATE TABLE IF NOT EXISTS`).
