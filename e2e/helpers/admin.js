// FUP-T27 — THE ONE HOME OF THE SUITE'S ADMIN REQUEST PATH.
//
// ⚠ WHY THIS FILE EXISTS, measured during PI-T3 (docs/learnings/10-portal-ia.md §10).
// The backend keeps exactly ONE `admin_token` row (`routes/admin.js` does an
// `INSERT OR REPLACE` on a single settings row), so **every** `POST /api/admin/login`
// anywhere in the suite REPLACES it. A login whose response lands after its own test
// already timed out still rotates that row — and every spec file holding a token minted
// earlier in its own `beforeAll` then fails its NEXT fixture with a 401 where 201 is
// expected (`POST /api/friends`, `POST /api/cycles`).
//
// ⚠ The first failure in that cascade is a 10 s TIMEOUT on the admin login redirect,
// not a 401. The 401s are downstream, which is why it reads as „a dozen unrelated admin
// files regressed" and invites blaming whatever diff happens to be in the tree. It did
// exactly that during PI-T3: the same tree ran red twice on a loaded box and green on an
// idle one. It is a LOAD-sensitive latent defect, not a regression.
//
// The suite used to mitigate it BY CONVENTION, per file („every fixture-building block
// re-logs-in first", `colleagues-panel.spec.js`). A convention has gaps, and under load
// the gaps open. `makeAdmin()` closes them in one place: the request path stops trusting
// a cached token and re-authenticates ONCE on a 401.
//
// ⚠⚠ EXACTLY ONE RETRY, NEVER A LOOP. A second 401 is a real authorization answer and
// must reach the test unchanged — a loop would hide a genuine auth failure behind a
// timeout, which is the same class of defect this file was written to remove.
//
// ⚠⚠ DO NOT ADOPT THIS IN A SPEC WHOSE SUBJECT IS AUTHENTICATION ITSELF.
// `api-security.spec.js` tests token STALENESS on purpose („a STALE token (rotated out
// by a later login) logs out nothing — the live session survives", and its non-vacuity
// gate „the stale token is genuinely dead" asserts 401). A helper that re-authenticates
// turns that 401 into a 200 and silently deletes the test's meaning. That is not a
// hypothetical: `admin-token-retry.spec.js` §4 DEMONSTRATES it — it runs api-security's
// own staleness assertion through this helper and shows it comes back 200 — and pins in
// source that `api-security.spec.js` never imports this module.
//
// ── Adoption shape (replaces each file's private `async function admin(...)`) ─────────
//
//   const admin = makeAdmin({
//     ctx: () => ctx,                      // the file's APIRequestContext, assigned in beforeAll
//     token: () => adminToken,             // the file's cached token
//     adopt: (t) => { adminToken = t },    // ⚠ keep the file's OWN variable fresh
//     timeout: TIMEOUT,                    // only where the file had one
//   })
//
// ⚠ `adopt` is not optional bookkeeping. Most adopting files use `adminToken` in more
// places than their `admin()` helper (seeding `localStorage` for a UI admin test, raw
// `ctx.*` calls with an explicit header). Publishing the refreshed token back into the
// file's variable is what stops the re-authentication from fixing one call and leaving
// the next eleven stale.

import { ADMIN_PASSWORD } from '../fixtures.js'

/**
 * Mint a fresh admin token. Throws (rather than `expect`ing) so the failure message
 * survives being called from a `beforeAll`, a fixture helper or a retry alike.
 */
export async function loginAdmin(ctx, { password = ADMIN_PASSWORD } = {}) {
  const res = await ctx.post('/api/admin/login', { data: { password } })
  if (res.status() !== 200) {
    throw new Error(
      `admin login failed with ${res.status()} — is the backend seeded (node e2e/seed.mjs) `
      + 'and is ADMIN_PASSWORD right? (a 429 here means the auth limiter budget is too small — see e2e/README.md)',
    )
  }
  const body = await res.json().catch(() => null)
  if (!body || !body.token) throw new Error('admin login returned 200 with no token')
  return body.token
}

/**
 * Build a file's `admin(path, opts)` request helper.
 *
 * `opts` keeps the shape the 42 private copies already used — `{ method, data }` — plus
 * `headers`, `multipart`, `params` and a per-call `timeout` for the variants that had
 * them. `data` is forwarded whenever it is not `undefined` (the strictest of the shapes
 * this replaces); no call site in the suite passes a falsy body, so that is a widening
 * nothing exercises rather than a behaviour change.
 *
 * `opts.reauth === false` opts a single call out of the retry — for a test that wants
 * the raw answer of a token it deliberately made stale.
 */
export function makeAdmin({ ctx, token, adopt, timeout, password = ADMIN_PASSWORD }) {
  const request = () => (typeof ctx === 'function' ? ctx() : ctx)
  const cached = () => (typeof token === 'function' ? token() : token)

  return async function admin(path, opts = {}) {
    const send = (t) => request()[opts.method || 'get'](path, {
      headers: { 'X-Admin-Token': t, ...(opts.headers || {}) },
      ...(opts.data !== undefined ? { data: opts.data } : {}),
      ...(opts.multipart !== undefined ? { multipart: opts.multipart } : {}),
      ...(opts.params !== undefined ? { params: opts.params } : {}),
      ...(opts.timeout !== undefined
        ? { timeout: opts.timeout }
        : timeout !== undefined ? { timeout } : {}),
    })

    const first = await send(cached())
    if (first.status() !== 401 || opts.reauth === false) return first

    // ⚠ ONE re-authentication, then the answer stands — whatever it is.
    const fresh = await loginAdmin(request(), { password })
    if (adopt) adopt(fresh)
    return send(fresh)
  }
}
