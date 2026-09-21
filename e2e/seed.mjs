// Seed a Gorifi backend with the minimum data the e2e suite needs:
//   - an admin password (idempotent — ignores "already set up")
//   - auth_mode = legacy + a shared friends password
//   - one open cycle
//   - one active friend
//   - PI-T9: `friends.explainer_seen_at` pre-stamped for everyone EXCEPT one named
//     fixture (see step 7 — it is a suite-wide guard, not a feature)
// Safe to run against a fresh local backend. NOT for production.
//
// Usage: BASE_URL=http://localhost:3997 node seed.mjs
//        (DB_PATH=<the same file the backend opened> enables step 7)

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'e2e-admin-pass-9271'
const FRIENDS_PASSWORD = process.env.FRIENDS_PASSWORD || 'e2e-friends-pass'
const FRIEND_NAME = process.env.FRIEND_NAME || 'E2ETester'
const CYCLE_NAME = process.env.CYCLE_NAME || 'E2E Test Cycle'

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-Admin-Token'] = token
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-json */ }
  return { status: res.status, json, text }
}

async function main() {
  console.log(`Seeding ${BASE_URL} ...`)

  // 1. Admin setup (idempotent)
  const setup = await api('/api/admin/setup', { method: 'POST', body: { password: ADMIN_PASSWORD } })
  if (setup.status === 200) console.log('  admin: created')
  else console.log(`  admin: already set up (${setup.status})`)

  // 2. Login
  const login = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
  if (login.status !== 200 || !login.json?.token) {
    throw new Error(`admin login failed (${login.status}) — is ADMIN_PASSWORD correct for this env? ${login.text}`)
  }
  const token = login.json.token
  console.log('  admin: logged in')

  // 3. Settings: legacy auth mode + shared friends password
  const settings = await api('/api/admin/settings', {
    method: 'PUT', token,
    body: { authMode: 'legacy', friendsPassword: FRIENDS_PASSWORD },
  })
  if (settings.status !== 200) throw new Error(`settings update failed (${settings.status}) ${settings.text}`)
  console.log('  settings: legacy mode + friends password set')

  // 3b. Payment settings — guests pay the admin directly (GSO-T3), so the
  // confirmation screen needs an IBAN / Revolut username. Only filled in when
  // BOTH are empty, so a real environment's values are never overwritten.
  const payment = await api('/api/admin/payment-settings')
  if (!payment.json?.paymentIban && !payment.json?.paymentRevolutUsername) {
    const set = await api('/api/admin/settings', {
      method: 'PUT', token,
      body: { paymentIban: 'SK3112000000198742637541', paymentRevolutUsername: 'e2egorifi' },
    })
    if (set.status !== 200) throw new Error(`payment settings update failed (${set.status}) ${set.text}`)
    console.log('  settings: payment IBAN + Revolut username set')
  } else {
    console.log('  settings: payment details already present, left untouched')
  }

  // 3b(ii). The creditor name (15 §UC-PL-002) — the account holder's name the payer's
  // bank shows. ⚠ GUARDED SEPARATELY, not folded into the check above: the IBAN and the
  // Revolut handle are often already present (a real environment, or a template rebuilt
  // before this key existed), and a single combined guard would then skip the creditor
  // name forever — leaving every PayMe/QR-beneficiary test to pass VACUOUSLY on a blank
  // setting. Same rule as above though: written ONLY when empty, so a real environment's
  // value is never overwritten.
  if (!payment.json?.paymentCreditorName) {
    const setName = await api('/api/admin/settings', {
      method: 'PUT', token,
      body: { paymentCreditorName: 'Karol Skolar' },
    })
    if (setName.status !== 200) throw new Error(`creditor name update failed (${setName.status}) ${setName.text}`)
    console.log('  settings: payment creditor name set')
  } else {
    console.log('  settings: payment creditor name already present, left untouched')
  }

  // 4. Ensure a cycle exists
  const cycles = await api('/api/cycles', { token })
  let cycle = (cycles.json || []).find((c) => c.name === CYCLE_NAME)
  if (!cycle) {
    const created = await api('/api/cycles', { method: 'POST', token, body: { name: CYCLE_NAME, type: 'coffee', status: 'open' } })
    if (created.status !== 201) throw new Error(`cycle create failed (${created.status}) ${created.text}`)
    cycle = created.json
    console.log(`  cycle: created "${CYCLE_NAME}" (id ${cycle.id})`)
  } else {
    console.log(`  cycle: exists "${CYCLE_NAME}" (id ${cycle.id})`)
  }

  // 5. Ensure a friend exists
  const friends = await api('/api/friends', { token })
  let friend = (friends.json || []).find((f) => f.name === FRIEND_NAME)
  if (!friend) {
    const created = await api('/api/friends', { method: 'POST', token, body: { name: FRIEND_NAME } })
    if (created.status !== 201) throw new Error(`friend create failed (${created.status}) ${created.text}`)
    friend = created.json
    console.log(`  friend: created "${FRIEND_NAME}" (id ${friend.id})`)
  } else {
    console.log(`  friend: exists "${FRIEND_NAME}" (id ${friend.id})`)
  }

  // 6. The dedicated first-login-gate fixture (18 §UC-PI-013, PI-T9).
  //
  // ⚠⚠ READ STEP 7 BEFORE TOUCHING THIS ONE. This friend exists to be the ONE seeded
  // row whose `explainer_seen_at` stays NULL after step 7 stamps everybody else. It
  // is DELIBERATELY UNSTAMPED. "Tidying" it by folding it into the bulk UPDATE below
  // leaves the seed with no unacknowledged friend at all, and the non-vacuity pin in
  // `portal-explainer.spec.js` §9 — which asserts one stamped and one NULL — is what
  // turns that edit into a red run instead of a silent loss.
  const explainerFriendName = process.env.EXPLAINER_FRIEND_NAME || 'E2EExplainerGate'
  let gateFriend = (friends.json || []).find((f) => f.name === explainerFriendName)
  if (!gateFriend) {
    const created = await api('/api/friends', { method: 'POST', token, body: { name: explainerFriendName } })
    if (created.status !== 201) throw new Error(`gate friend create failed (${created.status}) ${created.text}`)
    gateFriend = created.json
    console.log(`  friend: created gate fixture "${explainerFriendName}" (id ${gateFriend.id})`)
  } else {
    console.log(`  friend: gate fixture exists "${explainerFriendName}" (id ${gateFriend.id})`)
  }

  // 7. ⚠⚠ PRE-STAMP `friends.explainer_seen_at` FOR EVERY OTHER SEEDED FRIEND.
  //
  // WHY THIS EXISTS, because it is not about the feature at all. 18 §UC-PI-013 sends a
  // friend whose column is NULL to `/ako-to-funguje` on their next LOGIN. The template
  // database is a scrubbed production snapshot — 76 friends, every one of them NULL,
  // because §UC-PI-013's product decision is explicitly NO BACK-FILL. Any spec that
  // logs one of them in through the UI would land on the explainer instead of the
  // screen it came to measure. So the gate DATABASE, which is an INPUT to the suite,
  // is put in the state a live deployment reaches after everyone has logged in once.
  //
  // ⚠ IT IS A DB WRITE, NOT AN API CALL, and there is no API that could do it. The
  // route is `requireFriendOwner`-guarded on purpose (a shared-password caller is a
  // 401, never a stamp — the GA-T5 rule), so stamping 76 friends through it would
  // mean minting 76 friend sessions, i.e. 76 `authLimiter` slots and 152 requests, on
  // a bucket whose production default is 20/window. Adding an admin endpoint was the
  // other option and is worse: §UC-PI-019 item 16 says nothing in this module joins
  // `ADMIN_ENDPOINTS`, and a server-side back door for a per-friend acknowledgement is
  // exactly the boundary the route's guard exists to hold.
  //
  // ⚠ GUARDED ON `DB_PATH`, so this script stays target-agnostic (it is documented as
  // usable against a deployed environment through `BASE_URL` alone). No `DB_PATH` ⇒ no
  // local file to write ⇒ the step announces itself as skipped rather than failing.
  // The run recipe in `e2e/README.md` exports `DB_PATH`, so the gate always takes it.
  //
  // ⚠ RUN AFTER THE SERVER IS UP, which the recipe guarantees: the column is created
  // by the backend's own boot migration (`db/schema.js`), so a write here before the
  // first boot would fail on a missing column. That is why the step is LAST and why a
  // missing column is reported rather than swallowed.
  const dbPath = process.env.DB_PATH
  if (!dbPath) {
    console.log('  explainer: DB_PATH not set — skipping the pre-stamp (remote target)')
  } else if (!existsSync(dbPath)) {
    console.log(`  explainer: DB_PATH ${dbPath} does not exist — skipping the pre-stamp`)
  } else {
    const db = new DatabaseSync(dbPath)
    try {
      // ⚠⚠ THE PAIRING CHECK, AND IT IS NOT DEFENSIVE PROGRAMMING — IT IS A MEASURED
      // BUG. `DB_PATH` must name the database that `BASE_URL` is SERVING, and nothing
      // enforced that while this script was a pure HTTP client: the ambient `DB_PATH`
      // was inherited and ignored. `mailgun-harness.js startBackend()` spawns this
      // script against a THROWAWAY backend with only `BASE_URL` overridden, so on the
      // first run of PI-T9 every one of those spawns pre-stamped the SHARED gate
      // database instead — including `E2EExplainerGate`, the one row this step must
      // leave NULL. The harness now passes its own `DB_PATH`; this check is the other
      // end of the same fix, so the next helper that forgets fails LOUDLY — ⚠ and
      // „loudly" has to mean something a SPAWNER can see. A `console.log` is not it:
      // `mailgun-harness.js` spawns this script with `stdio: 'ignore'`, i.e. the exact
      // caller this check exists for is the one caller that cannot read the message.
      // So the mismatch also sets `process.exitCode = 1` (below), and the harness
      // reports a non-zero seed exit on its own stderr. Message for a human reading
      // the log, exit code for everything else.
      //
      // The correlation is the gate friend's own id: the API just told us which id it
      // has on the TARGET, so a database in which that id holds a different name (or
      // no row at all) is somebody else's.
      const local = db.prepare('SELECT name FROM friends WHERE id = ?').get(gateFriend.id)
      if (!local || local.name !== explainerFriendName) {
        console.log(
          `  !! explainer: DB_PATH ${dbPath} is NOT the database ${BASE_URL} is serving `
          + `(id ${gateFriend.id} is ${local ? `"${local.name}"` : 'absent'} there) — pre-stamp SKIPPED`
        )
        // Non-zero, because the only caller that can trip this check redirects stdout
        // to /dev/null. Everything else about the seed already succeeded, so this is a
        // warning code, not a crash — nothing is thrown and the run continues.
        process.exitCode = 1
        // ⚠ NO `db.close()` here — the `finally` below owns it, and `node:sqlite`
        // throws on a double close.
        console.log('Seed complete.')
        return
      }
      const before = db.prepare('SELECT COUNT(*) AS n FROM friends WHERE explainer_seen_at IS NULL').get()
      db.prepare(
        "UPDATE friends SET explainer_seen_at = datetime('now') WHERE explainer_seen_at IS NULL AND id <> ?"
      ).run(gateFriend.id)
      const after = db.prepare('SELECT COUNT(*) AS n FROM friends WHERE explainer_seen_at IS NULL').get()
      console.log(`  explainer: pre-stamped ${before.n - after.n} friend(s); ${after.n} left unacknowledged (the gate fixture)`)
      if (after.n !== 1) {
        // Loud, not fatal: a run can legitimately add friends between boot and seed,
        // but "0 left" means the fixture was stamped and §9's pin is about to red.
        console.log(`  !! explainer: expected exactly 1 unacknowledged friend, found ${after.n}`)
      }
    } finally {
      db.close()
    }
  }

  console.log('Seed complete.')
}

main().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1) })
