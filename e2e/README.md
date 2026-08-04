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
- `tests/item-packed.spec.js` — GSO-T1: per-item packing persistence
  (`order_items.packed`) and the whole-order "Zabaliť" gate (API-level, plus a
  UI-level pass on the Distribution page: checkbox persists across reload,
  button disabled until every item is checked).
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

Two gotchas in that recipe that look like app bugs when you skip them:

- **`CORS_ORIGIN=http://localhost:PORT` is required**, not optional. The built
  SPA uses `crossorigin` script tags, so serving it from `backend/public` on a
  bare `localhost:PORT` without that origin allow-listed makes the asset
  requests 500 — every UI spec then fails on a blank page.
- **Start a fresh server.** A backend left running from an earlier session keeps
  serving from a `backend/public` whose hashed asset files have since been
  replaced under it (`rm -rf` + rebuild), so `express.static` 500s and the UI
  specs fail for reasons that have nothing to do with your diff.

### Full-suite runs and the shared auth-limiter budget

`authLimiter` (`backend/src/middleware/rate-limit.js`) guards both
`/admin/login` and `/friends/auth` behind ONE shared per-IP bucket
(`RATE_LIMIT_AUTH_MAX`, default 20 per 15 min window). Every spec runs from
the same test-runner IP, and several specs each perform their own
login/friend-auth calls — run the **full** suite repeatedly against the same
long-lived server (e.g. iterating locally without restarting it) and the
shared bucket exhausts, producing real `429`s that look like unrelated
failures (wrong-password checks, invite-code lookups, `item-packed.spec.js`'s
`beforeAll` admin login, etc.) even though nothing is actually broken. This
is suite/environment fragility, not a spec bug — a single run against a
freshly-seeded server passes cleanly.

Mitigations:
- Prefer a **fresh** DB + freshly-started server per full-suite run (matches
  the recipe above) rather than re-running against a server that has already
  served many earlier runs.
- If you must re-run repeatedly against the same long-lived server, start it
  with a generous budget, e.g. `RATE_LIMIT_AUTH_MAX=1000`, to get a true
  pass/fail signal (`rate-limit.spec.js` still self-skips above 10, so this
  doesn't weaken that check).

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
