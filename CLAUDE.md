# Gorifi

Coffee order management application for coordinating group coffee orders among friends.

## Tech Stack

- **Backend:** Node.js + Express + sql.js (SQLite in-memory with file persistence)
- **Frontend:** Vue 3 + Vite + Tailwind CSS
- **Language:** Slovak (UI text is in Slovak)

## Project Structure

```
backend/
  src/
    db/schema.js      # Database schema and helpers
    routes/           # Express route handlers
    index.js          # Server entry point
frontend/
  src/
    api.js            # API client with all endpoints
    router.js         # Vue Router config
    views/            # Vue page components
```

## Development

```bash
# Backend (port 3000)
cd backend && npm run dev

# Frontend (port 5173)
cd frontend && npm run dev
```

## Key Patterns

### Database
- Uses sql.js (SQLite compiled to WebAssembly)
- Schema defined in `backend/src/db/schema.js`
- Migrations handled via try/catch ALTER TABLE (column already exists = ignore)
- `dbHelpers` provides `all()`, `get()`, `run()`, `prepare()`, `transaction()` methods

### API Client
- Frontend API client in `frontend/src/api.js`
- Supports FormData for file uploads (auto-removes Content-Type header)
- Custom headers can be injected (e.g., `X-Friends-Password`)

### Authentication
- **Admin:** Password-based, stored in settings table
- **Friends:** Single global password (set in Admin > Settings) + friend selection from dropdown (honor system)
- Password sent via `X-Friends-Password` header for friend order endpoints

## Learnings

### Friend Ordering Flow (2026-01-24)
- URL format: `/` → Friend portal (login + cycle list), `/cycle/:cycleId` → Order page
- Friends authenticate with global password (same for everyone), select name from dropdown
- Auth state stored in localStorage key `gorifi_friend_auth` as `{ friendId, friendName, password }`
- FriendPortal.vue handles login, shows cycle list with order status
- FriendOrder.vue shows products/cart, redirects to portal if not authenticated
- Password validated via `POST /friends/auth`, stored in memory for `X-Friends-Password` header
- Admin sets global friends password in `/admin/settings`

### Database Migrations
- Add new columns with try/catch pattern after CREATE TABLE:
  ```javascript
  try {
    db.run('ALTER TABLE tablename ADD COLUMN newcol TYPE');
  } catch (e) {
    // Column already exists, ignore
  }
  ```

### Vue Patterns
- Use `computed()` for derived state from route params
- Reactivity trigger for objects: `cart.value = { ...cart.value }`

### Cycle Progress Feature (2026-01-31)
- Each cycle stores `total_friends` at creation time (snapshot of active friends count)
- This ensures progress display (e.g., "5/12 priateľov") remains fixed even if friends are added later
- `/friends/cycles` endpoint returns: `totalKilos`, `submittedOrders`, `totalFriends`
- Kilos calculated from order_items: 250g = 0.25kg, 1kg = 1.0kg

### Order Auto-Save & Status Notifications (2026-02-01, updated 2026-02-02)
- **Auto-save behavior differs based on order existence and status:**
  - No order exists yet: NO auto-save (items stay in cart but not saved to DB until submit)
  - Existing draft orders: Cart changes are auto-saved (debounced 500ms)
  - Submitted orders: Changes are NOT auto-saved; user must click "Aktualizovať objednávku"
- **Order creation:** Orders are only created when user explicitly submits (not by auto-save)
- **Status notifications in cart footer:**
  - Yellow: "Objednávka ešte nebola odoslaná" - when cart has items but not submitted
  - Orange: "Zmeny v objednávke neboli odoslané ani uložené" - when submitted order has unsaved changes
- **Change detection:** `lastSubmittedCart` ref stores snapshot of cart at submission time
- **Leave confirmation:** Modal shown when navigating away with:
  - Unsaved changes on submitted orders
  - Cart items but no order (new items not yet submitted)
- **Cancel order behavior:**
  - If order exists: Deletes the order record entirely
  - If no order: Just clears cart (no DB operation)
  - Shows as "Neobjednané" in admin dashboard
  - Redirects user to cycle list after canceling
- **Backend order updates:** PUT `/orders/cycle/:cycleId/friend/:friendId`
  - Creates order if doesn't exist (only when explicitly called)
  - Preserves order status when items change (doesn't reset to 'draft')
  - Deletes order entirely when cart is emptied (total = 0)
- **Backend order retrieval:** GET `/orders/cycle/:cycleId/friend/:friendId`
  - Does NOT auto-create orders; returns null if no order exists

## Deployment

### Architecture
```
Nginx Proxy Manager (SSL) → LXC Container (nginx) → PM2 apps
├── gorifi.skolar.sk     → port 80 → gorifi-backend:3000
└── gorifi-dev.skolar.sk → port 80 → gorifi-staging:3001
```

### Deploy Commands
```bash
./deploy/deploy.sh staging             # Deploy to dev
./deploy/deploy.sh production          # Deploy to production
./deploy/deploy.sh staging backend     # Backend only
./deploy/deploy.sh production frontend # Frontend only
```

### Deploy Files
- `deploy/ecosystem.config.cjs` - PM2 config (both apps)
- `deploy/nginx-gorifi.conf` - Production nginx
- `deploy/nginx-gorifi-staging.conf` - Dev/staging nginx
- `deploy/deploy.sh` - Deployment script

### Staging Indicator
- `VITE_STAGING=true` env var shows amber "STAGING" banner
- Set automatically by deploy script for staging builds

### Friend Portal Display (2026-02-03)
- Cycle list shows friend's own order kilos (not cycle total)
- Progress display (submitted/total friends) removed from friend view
- Kilos only shown when friend has an order
- Capsules counted as 100g (20 × 5g)

### Dismissable Notifications (2026-02-03)
- Orange "unsaved changes" notification can be closed to save screen space on mobile
- Notification reappears if user makes more cart changes after dismissing
- State tracked via `changesNotificationDismissed` ref, reset on cart change

### First-Time Deployment (2026-02-03)
- Deploy script must copy `ecosystem.config.cjs` BEFORE starting PM2 (not after)
- Script creates log directories (`/var/log/gorifi`, `/var/log/gorifi-staging`) if missing
- Both production and staging run in same LXC container on different ports (3000, 3001)
