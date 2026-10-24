// e2e/wa-harness.js — the `gorifi-wa` STUB-SENDER harness (21 §UC-WA-014 item 3, WA-T9).
//
// MODELLED ON `mailgun-harness.js`: the spec spawns the REAL process (`node wa/src/index.js`)
// as a child, waits for its health, runs, and ALWAYS stops it — by the child's own PID
// (`child.kill`), never `pkill -f` (CLAUDE.md: it self-matches). A module-level registry
// also SIGKILLs any child still alive when the Playwright worker exits, so a test that
// times out cannot leave a sender draining the gate database behind it.
//
// ⚠ NO TEST USING THIS FILE CAN REACH WHATSAPP. Every child is started with
// `WA_SENDER=stub` FORCED (the ambient env's `WA_*` keys are blanked first — the Mailgun
// harness's „blank, then override" rule): the stub has no network and no library, and the
// whatsapp branch is never constructed.
//
// The harness env (21 §UC-WA-014 item 3): `WA_SENDER=stub WA_POLL_MS=200 WA_PACE_MIN_MS=0
// WA_PACE_MAX_MS=0`, plus `WA_HOURLY_MAX=100000` so rows sent earlier in the run (they
// SEED the rolling-hour ring at boot) cannot cap a later test — a test that is ABOUT the
// cap passes its own value.
//
// TWO DATABASES, TWO PORT RULES:
//   • a PRIVATE database (`makeOutboxDb()` — a throwaway boot of `backend/src/db/schema.js`
//     into a temp file) + a FREE port: the process-level acceptance (§UC-WA-011). Needs
//     only the source tree (`CAN_SPAWN_WA`), never the gate server.
//   • the GATE database (`DB_PATH`) + the port named by `WA_HEALTH_URL`: the end-to-end
//     clauses through the API/UI (§UC-WA-012, §UC-WA-009). The gate server's health reader
//     must find THIS child, so the child listens on the port the gate server was started
//     with (`e2e/README.md`: `WA_HEALTH_URL=http://127.0.0.1:3996`). ⚠ That is the SAME
//     port the fake health servers of `whatsapp-outbox` §4, `whatsapp-settings` §2/§3 and
//     `whatsapp-composer` §2 bind for one test each. They never collide because the suite
//     runs `--workers=1` and every owner (those fakes and this harness) releases the port
//     in a `finally` before its test ends. If the port is still held, the child exits 1
//     (`[wa] health server cannot listen …`) and the harness throws with its log — loud.
//   ⚠ While a gate-DB child runs it drains EVERY released WhatsApp row in the gate DB —
//   other specs' leftovers included. That is what the real process would do; a spec that
//   needs a row to STAY `released` must not run inside `withWaStub` (or pauses first).

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freePort } from './mailgun-harness.js'

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url))
export const WA_DIR = path.resolve(E2E_DIR, '../wa')
export const WA_ENTRY = path.join(WA_DIR, 'src/index.js')
export const SCHEMA_ENTRY = path.resolve(E2E_DIR, '../backend/src/db/schema.js')
// Gated on the SOURCE (a run against a deployment skips); the installed deps are NOT a
// skip condition — a checkout without `cd wa && npm ci` throws loudly in `startWa()`.
export const CAN_SPAWN_WA = fs.existsSync(WA_ENTRY) && fs.existsSync(SCHEMA_ENTRY)
export const NEEDS_WA_SRC = 'needs wa/ and backend/ source beside e2e/ (skipped against a deployment)'
export const WA_DEPS_INSTALLED = fs.existsSync(path.join(WA_DIR, 'node_modules/better-sqlite3'))

export const STUB_NUMBER = '+421000000000'
export const STUB_FAIL_NUMBER = '+421900000000'
export const HARNESS_ENV = Object.freeze({
  WA_SENDER: 'stub',
  WA_POLL_MS: '200',
  WA_PACE_MIN_MS: '0',
  WA_PACE_MAX_MS: '0',
  WA_HOURLY_MAX: '100000',
})

// The port the GATE server's health reader calls (`WA_HEALTH_URL`), or null.
export function gateHealthPort() {
  const raw = process.env.WA_HEALTH_URL || ''
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
    const port = Number(url.port || 80)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

const live = new Set()
process.on('exit', () => {
  for (const child of live) {
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
})

function childEnv(overrides) {
  const env = { ...process.env }
  // Blank every inherited WA_* knob first — only the harness and the test decide.
  for (const key of Object.keys(env)) if (key.startsWith('WA_')) delete env[key]
  delete env.DB_PATH
  return { ...env, ...HARNESS_ENV, ...overrides }
}

/**
 * Spawn `wa/src/index.js` and wait until `/health` answers `state === waitForState`
 * (pass `null` to wait only for any 200). ⇒ a handle:
 *   { port, healthUrl, pid, logs(), health(), waitForLog(re, ms), waitForExit(ms), stop() }
 */
export async function startWa({ dbPath, port, env = {}, waitForState = 'connected', nodeArgs = [], timeoutMs = 15_000 } = {}) {
  if (!WA_DEPS_INSTALLED) {
    throw new Error('wa/node_modules is missing — run `cd wa && npm ci` (e2e/README.md, WA-T9)')
  }
  if (!dbPath) throw new Error('startWa needs a dbPath')
  const healthPort = port ?? await freePort()
  const child = spawn(process.execPath, [...nodeArgs, WA_ENTRY], {
    cwd: WA_DIR,
    env: childEnv({ DB_PATH: dbPath, WA_HEALTH_PORT: String(healthPort), ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  live.add(child)
  const output = []
  child.stdout.on('data', (c) => output.push(String(c)))
  child.stderr.on('data', (c) => output.push(String(c)))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => { live.delete(child); resolve({ code, signal }) }))
  const healthUrl = `http://127.0.0.1:${healthPort}/health`
  const logs = () => output.join('')

  const handle = {
    port: healthPort,
    healthUrl,
    pid: child.pid,
    logs,
    async health() {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) })
      return { status: res.status, body: await res.json() }
    },
    async waitForLog(re, ms = 5000) {
      const deadline = Date.now() + ms
      for (;;) {
        const m = logs().match(re)
        if (m) return m
        if (Date.now() > deadline) throw new Error(`[wa-harness] no log line ${re} within ${ms} ms:\n${logs()}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    },
    async waitForExit(ms = 10_000) {
      return Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error(`[wa-harness] child did not exit within ${ms} ms:\n${logs()}`)), ms))])
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
        await exited
        clearTimeout(timer)
      }
      return exited
    },
  }

  // ⚠ Readiness must prove the answer is from THIS child (review, WA-T9): on the SHARED
  // gate port a leftover fake health server (or a stray process) answering `connected`
  // would otherwise pass for it while the child itself died of EADDRINUSE. So the body
  // must name the sender this harness started and the database it passed, and the child
  // must still be alive after the match.
  const expectedSender = env.WA_SENDER || HARNESS_ENV.WA_SENDER
  let foreign = null
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`[wa-harness] gorifi-wa exited early (${child.exitCode})${foreign ? ` — and something ELSE answered on :${healthPort}: ${foreign}` : ''}:\n${logs()}`)
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`[wa-harness] gorifi-wa never reported state=${waitForState} on :${healthPort}${foreign ? ` (a FOREIGN answer: ${foreign})` : ''}:\n${logs()}`)
    }
    try {
      const { status, body } = await handle.health()
      if (status === 200) {
        const ours = body && body.sender === expectedSender && body.db_path === dbPath
        if (!ours) foreign = JSON.stringify(body).slice(0, 200)
        else if (waitForState === null || body.state === waitForState) break
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (child.exitCode !== null) throw new Error(`[wa-harness] gorifi-wa exited right after readiness (${child.exitCode}):\n${logs()}`)
  return handle
}

/** Run `fn(wa)` against a started stub and ALWAYS stop it afterwards. */
export async function withWaStub(options, fn) {
  const wa = await startWa(options)
  try {
    return await fn(wa)
  } finally {
    await wa.stop()
  }
}

/** Spawn the process expecting it to EXIT (a refused boot). ⇒ { code, output }. */
export function runWaToExit(env, { timeoutMs = 15_000 } = {}) {
  const r = spawnSync(process.execPath, [WA_ENTRY], {
    cwd: WA_DIR,
    env: childEnv(env),
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  return { code: r.status, signal: r.signal, output: `${r.stdout || ''}${r.stderr || ''}` }
}

/**
 * A PRIVATE, fully migrated database: a throwaway boot of the API's own `schema.js` into a
 * temp file (the `whatsapp-outbox` §1 technique) — the WA process refuses an unmigrated
 * file. ⇒ { dbPath, cleanup() }.
 */
export function makeOutboxDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-t9-db-'))
  const dbPath = path.join(dir, 'outbox.sqlite')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SCHEMA_ENTRY).href)})`], {
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (r.status !== 0 || !fs.existsSync(dbPath)) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(`[wa-harness] schema boot failed (${r.status}):\n${r.stdout}${r.stderr}`)
  }
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
