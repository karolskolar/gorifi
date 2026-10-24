// 21 §UC-WA-011 — the `gorifi-wa` process's configuration: env, read ONCE at boot.
//
// PURE (no I/O): `readConfig(env, cwd)` ⇒ `{ config }` or `{ error }` — `index.js` prints
// the error as `[wa] <error>` and exits 1. Every malformed value REFUSES the boot rather
// than falling back to a default: a typo in a pacing knob must not silently send faster
// than the operator asked (the ban risk, 21 §Accepted risks), and a typo in `DB_PATH` must
// not open a second, empty database (the spec's own reason for `DB_PATH` being required).
//
// | var                   | default            | rule                                         |
// |-----------------------|--------------------|----------------------------------------------|
// | DB_PATH               | REQUIRED           | absolute path (the file must exist — db.js)  |
// | WA_SENDER             | whatsapp           | `whatsapp` | `stub`                          |
// | WA_SESSION_DIR        | <cwd>/../wa-session| whatsapp sender only (LocalAuth dataPath)    |
// | WA_HEALTH_PORT        | 3010               | 1–65535, bound to 127.0.0.1 ONLY             |
// | WA_POLL_MS            | 5000               | integer ≥ 50                                 |
// | WA_PACE_MIN_MS/_MAX_MS| 3000 / 10000       | integers ≥ 0, MIN ≤ MAX (0/0 = no gap: e2e)  |
// | WA_HOURLY_MAX         | 30                 | integer ≥ 1 (rolling-hour cap)               |
// | WA_STUB_FAIL_NUMBER   | +421900000000      | stub only: rows to it ⇒ failed/stub_fail     |
// | WA_STUB_SEND_MS       | 0                  | stub only, TEST SEAM: a send takes this long |
//
// ⚠ An EMPTY string counts as unset (a `.env` line `WA_POLL_MS=` means „default").

import path from 'node:path'

export const SENDERS = ['whatsapp', 'stub']
export const HEALTH_HOST = '127.0.0.1'

export const DEFAULTS = Object.freeze({
  sender: 'whatsapp',
  healthPort: 3010,
  pollMs: 5000,
  paceMinMs: 3000,
  paceMaxMs: 10000,
  hourlyMax: 30,
  stubFailNumber: '+421900000000',
  stubSendMs: 0,
})

function raw(env, key) {
  const v = env[key]
  return typeof v === 'string' ? v.trim() : ''
}

// A strict non-negative integer: digits only (no sign, no exponent, no decimal point).
function integer(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = raw(env, key)
  if (v === '') return { value: fallback }
  if (!/^\d+$/.test(v)) return { error: `${key} must be an integer (got a non-integer value)` }
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return { error: `${key} must be an integer between ${min} and ${max}` }
  }
  return { value: n }
}

export function readConfig(env = process.env, cwd = process.cwd()) {
  const dbPath = raw(env, 'DB_PATH')
  if (!dbPath) return { error: 'DB_PATH is required' }
  if (!path.isAbsolute(dbPath)) return { error: 'DB_PATH must be an absolute path' }

  const sender = raw(env, 'WA_SENDER') || DEFAULTS.sender
  if (!SENDERS.includes(sender)) return { error: `WA_SENDER must be one of: ${SENDERS.join(', ')}` }

  const fields = {
    healthPort: integer(env, 'WA_HEALTH_PORT', DEFAULTS.healthPort, { min: 1, max: 65535 }),
    pollMs: integer(env, 'WA_POLL_MS', DEFAULTS.pollMs, { min: 50, max: 3_600_000 }),
    paceMinMs: integer(env, 'WA_PACE_MIN_MS', DEFAULTS.paceMinMs, { max: 3_600_000 }),
    paceMaxMs: integer(env, 'WA_PACE_MAX_MS', DEFAULTS.paceMaxMs, { max: 3_600_000 }),
    hourlyMax: integer(env, 'WA_HOURLY_MAX', DEFAULTS.hourlyMax, { min: 1, max: 1_000_000 }),
    stubSendMs: integer(env, 'WA_STUB_SEND_MS', DEFAULTS.stubSendMs, { max: 600_000 }),
  }
  const values = {}
  for (const [name, r] of Object.entries(fields)) {
    if (r.error) return { error: r.error }
    values[name] = r.value
  }
  if (values.paceMinMs > values.paceMaxMs) return { error: 'WA_PACE_MIN_MS must not exceed WA_PACE_MAX_MS' }

  const sessionDir = raw(env, 'WA_SESSION_DIR') || path.resolve(cwd, '..', 'wa-session')

  return {
    config: Object.freeze({
      dbPath,
      sender,
      sessionDir,
      healthHost: HEALTH_HOST,
      ...values,
      stubFailNumber: raw(env, 'WA_STUB_FAIL_NUMBER') || DEFAULTS.stubFailNumber,
    }),
  }
}
