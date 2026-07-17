# Gorifi E2E Tests (Playwright)

Target-agnostic end-to-end tests. They validate the Phase 1 security fixes
(server-side admin authorization, no credential leakage, CORS lockdown) plus
public-flow smoke tests and the admin login/guard/logout UI flow.

## Layout

- `tests/api-security.spec.js` — API-level: admin endpoints 401 without a token,
  public endpoints stay 200, valid token unlocks, no `access_token` /
  `password_hash` / `invite_code` in responses, CORS lockdown.
- `tests/admin-auth.spec.js` — UI: router guard redirect, login success/failure,
  data loads through the admin token, logout re-protects.
- `tests/public-flow.spec.js` — UI: friend portal + admin login load, SPA fallback.
- `seed.mjs` — seeds a backend with an admin password, legacy friends password,
  one cycle, one friend (idempotent; NOT for production).
- `fixtures.js` — credentials/constants, overridable via env.

## Run against a local prod-like backend

```bash
# from repo root: build the frontend into backend/public, run backend on one port
cd frontend && npm run build && rm -rf ../backend/public && cp -r dist ../backend/public && cd ..
DB_PATH=/tmp/gorifi-e2e.sqlite PORT=3997 CORS_ORIGIN=http://localhost:3997 node backend/src/index.js &

cd e2e
npm install && npx playwright install --with-deps chromium
BASE_URL=http://localhost:3997 node seed.mjs
BASE_URL=http://localhost:3997 npm test
```

## Run against staging

```bash
cd e2e
# staging must already be seeded; pass the real credentials so auth'd tests work
BASE_URL=https://gorifi-dev.skolar.sk \
  ADMIN_PASSWORD='<staging admin pw>' \
  FRIENDS_PASSWORD='<staging friends pw>' \
  FRIEND_NAME='<an existing friend>' \
  CYCLE_NAME='<an existing cycle>' \
  npm test
```

Without staging credentials you can still run the anonymous checks, which must
all pass once Phase 1 is deployed:

```bash
BASE_URL=https://gorifi-dev.skolar.sk npx playwright test api-security \
  --grep "without an admin token|stays public"
```
