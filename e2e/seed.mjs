// Seed a Gorifi backend with the minimum data the e2e suite needs:
//   - an admin password (idempotent — ignores "already set up")
//   - auth_mode = legacy + a shared friends password
//   - one open cycle
//   - one active friend
// Safe to run against a fresh local backend. NOT for production.
//
// Usage: BASE_URL=http://localhost:3997 node seed.mjs

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

  console.log('Seed complete.')
}

main().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1) })
