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
- Custom headers can be injected (e.g., `X-Cycle-Password`)

### Authentication
- **Admin:** Password-based, stored in settings table
- **Friends:** Shared password per cycle + friend selection from dropdown
- Password sent via `X-Cycle-Password` header for friend order endpoints

## Learnings

### Friend Ordering Flow (2026-01-17)
- URL format: `/order/:cycleId` (single shared URL per cycle)
- Friends authenticate by selecting name + entering shared password
- Auth state stored in localStorage key `gorifi_auth` as `{ cycleId, friendId, friendName }`
- Three UI states in FriendOrder.vue: `login` → `welcome-back` → `authenticated`
- Password validated via `POST /cycles/:id/auth`, then stored in memory for `X-Cycle-Password` header

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
