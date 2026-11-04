// Module 21 — WA-T9: the `gorifi-wa` process (21 §UC-WA-011, the STUB sender + the loop +
// `/health`), §UC-WA-014 item 3 (`e2e/wa-harness.js` + this „stub sender" describe), the
// stub-dependent acceptance clauses WA-T7/WA-T8 deferred here (§UC-WA-012 settings card,
// §UC-WA-009 composer „Odoslané"), and the API half of „a second writer exists"
// (`.immediate()` + the `db_busy` 503).
//
// EVIDENCE KINDS — each where only it can work:
//   §0 SOURCE PINS (the source tree): `whatsapp-web` nowhere in backend/; no import across
//      backend/ ↔ wa/; the ONE dynamic `import('whatsapp-web.js')`; the process's SQL writes
//      ONLY `notifications.status/sent_at/sent_via/error`; the API's outbox and hand-over
//      transactions are `.immediate()`.
//   §1 THE PROCESS on a PRIVATE database (`makeOutboxDb()` — a throwaway boot of the API's
//      schema.js) + a free port: every §UC-WA-011 acceptance criterion, the boot refusals,
//      pacing, the hourly cap (+ its boot seed), the duplicate guard, SIGTERM, and that the
//      stub runs with whatsapp-web.js / puppeteer UNLOADABLE. Needs no gate server.
//   §2 END TO END on the GATE database (`DB_PATH`) with the child listening on the port the
//      gate server's `WA_HEALTH_URL` names (e2e/README.md): the settings card, the pause, the
//      test message, `bot_active` against the REAL process, the composer's „Odoslané"
//      without a reload. Self-skips without DB_PATH + WA_HEALTH_URL + the source tree.
//   §3 THE API SIDE: a probe proves each outbox helper takes the write lock UP FRONT
//      (`BEGIN IMMEDIATE`), and a DB_PATH-gated HTTP test that a lock held past
//      `busy_timeout` answers 503 `db_busy`, never a 500.
//
// ⚠ A §1/§2 describe that SKIPS ENTIRELY IS NOT A PASS (the WA-T9 brief): read the skip
// list. §1 needs only `wa/` + `backend/` source beside e2e/ AND `cd wa && npm ci` (a
// checkout without it THROWS — it is not a skip condition).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD, TARGET_IS_LOCAL } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'
import { stripComments } from '../helpers/source-pins.js'
import {
  CAN_SPAWN_WA, NEEDS_WA_SRC, STUB_FAIL_NUMBER, STUB_NUMBER, gateHealthPort, makeOutboxDb, runWaToExit,
  startWa, withWaStub,
} from '../wa-harness.js'
import { freePort } from '../mailgun-harness.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DB_PATH = process.env.DB_PATH || ''
const TIMEOUT = 20_000
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_DIR = join(REPO_ROOT, 'backend')
const WA_SRC = join(REPO_ROOT, 'wa', 'src')
const HAS_SRC = existsSync(join(BACKEND_DIR, 'src', 'db', 'schema.js')) && existsSync(WA_SRC)
const NEEDS_SRC = 'needs backend/ and wa/ source beside e2e/ (skipped against a deployment)'
const GATE_PORT = gateHealthPort()
const NEEDS_GATE = 'needs DB_PATH + WA_HEALTH_URL (the SAME values the gate server was started with) + a local target + the source tree (e2e/README.md)'
const CAN_GATE = Boolean(DB_PATH && GATE_PORT && CAN_SPAWN_WA && TARGET_IS_LOCAL)
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HEALTH_KEYS = [
  'db_path', 'hourly_max', 'hourly_sent', 'last_error', 'last_sent_at', 'next_send_at', 'number', 'pace', 'qr',
  'queue', 'sender', 'state', 'uptime_s', 'version',
]

// ── direct DB access (node:sqlite — a THIRD connection, like the operator's sqlite3) ──
function openDb(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}
function withDb(file, fn) {
  const db = openDb(file)
  try { return fn(db) } finally { db.close() }
}
// One outbox row as the API would leave it (a `'test'`-shaped admin row: no cycle, no party).
function insertRow(file, { channel = 'whatsapp', status = 'released', phone = '+421905900001', email = null, body = `WA9 ${uniq}`, releasedAt = null, segment = `wa9:${uniq}` } = {}) {
  return withDb(file, (db) => Number(db.prepare(`
    INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, phone_e164, email, body,
                               status, released_at, unresolved)
    VALUES (?, 'test', ?, 'admin', NULL, ?, ?, ?, ?, ${releasedAt ? '?' : 'CURRENT_TIMESTAMP'}, '[]')
  `).run(channel, segment, phone, email, body, status, ...(releasedAt ? [releasedAt] : [])).lastInsertRowid))
}
const rowOf = (file, id) => withDb(file, (db) => db.prepare('SELECT * FROM notifications WHERE id = ?').get(id))
const setPaused = (file, value) => withDb(file, (db) => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('whatsapp_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value)
})
async function waitForStatus(file, id, status, ms = 1000) {
  const started = Date.now()
  for (;;) {
    const row = rowOf(file, id)
    if (row?.status === status) return { row, elapsed: Date.now() - started }
    if (Date.now() - started > ms) throw new Error(`row ${id} not ${status} within ${ms} ms (is ${row?.status})`)
    await sleep(25)
  }
}
// The columns the WA process may write — everything else must be byte-identical.
const PROCESS_COLUMNS = ['status', 'sent_at', 'sent_via', 'error']
const untouchable = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !PROCESS_COLUMNS.includes(k)))

// Europe/Bratislava HH:MM — an independent copy of the log line's clock.
const clockOf = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))

function withPrivateDb(fn) {
  return async () => {
    const { dbPath, cleanup } = makeOutboxDb()
    try { await fn(dbPath) } finally { cleanup() }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// §0 SOURCE PINS
// ═════════════════════════════════════════════════════════════════════════════
function walk(dir, skip = new Set()) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full, skip))
    else out.push(full)
  }
  return out
}

test.describe('WA-T9 · §0 source pins', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)

  test('`whatsapp-web` appears nowhere in backend/ (source + package files; node_modules and the git-ignored built `public/` aside), and neither tree imports the other', () => {
    // ⚠ `backend/public` is the BUILT FRONTEND (git-ignored, e2e only) — its settings-page
    // runbook legitimately says „npm update whatsapp-web.js" (WA-T7 copy). The rule is
    // about what the API can LOAD: `git grep whatsapp-web -- backend/` is empty.
    const backendFiles = walk(BACKEND_DIR, new Set(['node_modules', 'public']))
    expect(backendFiles.length, 'non-vacuity: the backend tree was read').toBeGreaterThan(30)
    const hits = backendFiles.filter((f) => /\.(js|mjs|cjs|json)$/.test(f) && readFileSync(f, 'utf8').includes('whatsapp-web'))
    expect(hits.map((f) => relative(REPO_ROOT, f))).toEqual([])

    for (const f of walk(join(BACKEND_DIR, 'src')).filter((x) => x.endsWith('.js'))) {
      const src = stripComments(readFileSync(f, 'utf8'))
      expect(src, `${relative(REPO_ROOT, f)} imports nothing from wa/`).not.toMatch(/(from\s+|import\s*\()\s*['"][^'"]*\/wa\//)
    }
    const waFiles = walk(WA_SRC)
    expect(waFiles.length).toBeGreaterThanOrEqual(8)
    for (const f of waFiles) {
      const src = stripComments(readFileSync(f, 'utf8'))
      expect(src, `${relative(REPO_ROOT, f)} imports nothing from backend/`).not.toMatch(/(from\s+|import\s*\()\s*['"][^'"]*backend\//)
      // Static imports: node builtins, siblings, and the two declared runtime deps ONLY.
      for (const [, spec] of src.matchAll(/^\s*import\s[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
        expect(spec, `${relative(REPO_ROOT, f)}: static import ${spec}`).toMatch(/^(node:|\.\/|better-sqlite3$|qrcode$)/)
      }
    }
    // The ONE dynamic import of the library, inside the whatsapp sender.
    const dynamic = waFiles.flatMap((f) => [...stripComments(readFileSync(f, 'utf8')).matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((m) => `${relative(WA_SRC, f)}:${m[1]}`))
    expect(dynamic).toEqual(['whatsapp-sender.js:whatsapp-web.js'])
    expect(waFiles.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n'), 'no puppeteer reference in code').not.toMatch(/puppeteer/)
  })

  test('the process WRITES only `notifications.status / sent_at / sent_via / error`: exactly two UPDATEs, no INSERT/DELETE/DDL, `settings` only read', () => {
    const code = walk(WA_SRC).map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n')
    expect(code, 'non-vacuity: the SELECT survived the strip').toContain("WHERE status = 'released' AND channel = 'whatsapp'")
    expect(code).not.toMatch(/\b(INSERT\s+(OR\s+\w+\s+)?INTO|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|TRIGGER)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX)|REPLACE\s+INTO)\b/)
    const updates = [...code.matchAll(/UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)\s+WHERE\s+([^`]*)`/g)]
    expect(updates.length).toBe(2)
    for (const [, table, set, where] of updates) {
      expect(table).toBe('notifications')
      const columns = set.split(',').map((part) => part.trim().split(/\s*=/)[0])
      for (const c of columns) expect(PROCESS_COLUMNS, `SET ${c}`).toContain(c)
      expect(where.replace(/\s+/g, ' '), 'conditional: the duplicate guard').toContain("id = ? AND status = 'released' AND channel = 'whatsapp'")
    }
  })

  test('the API side: every outbox transaction and the hand-over / soft-cancel route transactions run `.immediate()`', () => {
    const outbox = stripComments(readFileSync(join(BACKEND_DIR, 'src/helpers/outbox.js'), 'utf8'))
    const txCount = (outbox.match(/db\.transaction\(/g) || []).length
    expect(txCount, 'non-vacuity: the transactions survived the strip').toBeGreaterThanOrEqual(9)
    expect((outbox.match(/\)\.immediate\(\)/g) || []).length, 'one `.immediate()` per `db.transaction(` in helpers/outbox.js').toBe(txCount)
    for (const [file, n] of [['orders.js', 1], ['guest-orders.js', 3], ['cycles.js', 1], ['guest.js', 1]]) {
      const src = stripComments(readFileSync(join(BACKEND_DIR, 'src/routes', file), 'utf8'))
      expect((src.match(/apply\.immediate\(\)/g) || []).length, `routes/${file}`).toBe(n)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §1 THE PROCESS — stub sender, private database
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T9 · §1 the stub sender (private database)', () => {
  test.skip(!CAN_SPAWN_WA, NEEDS_WA_SRC)

  test('boot refusals: DB_PATH missing / relative / absent / unmigrated, a bad WA_SENDER or pacing knob, a taken health port ⇒ exit 1 with ONE `[wa]` line', async () => {
    const tmp = mkdtempSync(join(os.tmpdir(), 'wa-t9-boot-'))
    try {
      let r = runWaToExit({})
      expect(r.code, r.output).toBe(1)
      expect(r.output).toContain('[wa] DB_PATH is required')
      r = runWaToExit({ DB_PATH: 'database.sqlite' })
      expect(r.code).toBe(1)
      expect(r.output).toContain('[wa] DB_PATH must be an absolute path')
      const absent = join(tmp, 'nope.sqlite')
      r = runWaToExit({ DB_PATH: absent })
      expect(r.code).toBe(1)
      expect(r.output).toMatch(/\[wa\] cannot open DB_PATH/)
      expect(existsSync(absent), 'a typo never CREATES a second, empty database').toBe(false)
      const empty = join(tmp, 'empty.sqlite')
      new DatabaseSync(empty).close()
      r = runWaToExit({ DB_PATH: empty })
      expect(r.code).toBe(1)
      expect(r.output).toContain('[wa] DB_PATH has no notifications table — start (migrate) the backend first')

      const { dbPath, cleanup } = makeOutboxDb()
      try {
        for (const [env, line] of [
          [{ WA_SENDER: 'baileys' }, '[wa] WA_SENDER must be one of: whatsapp, stub'],
          [{ WA_PACE_MIN_MS: '5000', WA_PACE_MAX_MS: '1000' }, '[wa] WA_PACE_MIN_MS must not exceed WA_PACE_MAX_MS'],
          [{ WA_HOURLY_MAX: '0' }, '[wa] WA_HOURLY_MAX must be an integer between 1 and 1000000'],
          [{ WA_POLL_MS: '2e3' }, '[wa] WA_POLL_MS must be an integer'],
        ]) {
          r = runWaToExit({ DB_PATH: dbPath, ...env })
          expect(r.code, JSON.stringify(env)).toBe(1)
          expect(r.output).toContain(line)
        }
        // A taken health port: the child dies loudly instead of serving nothing.
        const blocker = createServer(() => {})
        const port = await freePort()
        await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve))
        try {
          r = runWaToExit({ DB_PATH: dbPath, WA_HEALTH_PORT: String(port) })
          expect(r.code).toBe(1)
          expect(r.output).toContain(`[wa] health server cannot listen on 127.0.0.1:${port} (EADDRINUSE)`)
        } finally {
          await new Promise((resolve) => blocker.close(resolve))
        }
      } finally { cleanup() }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('§UC-WA-011 acceptance: released ⇒ sent/`bot` within 1 s; queued and e-mail rows never touched; the fail number ⇒ failed/`stub_fail`; body + phone_e164 byte-unchanged; `ORDER BY released_at, id`; PII-free logs; SIGTERM exits 0', withPrivateDb(async (dbPath) => {
    test.setTimeout(60_000)
    // Rows present at boot: drained in `released_at, id` order (C is released EARLIEST).
    const A = insertRow(dbPath, { phone: '+421905900011', body: `A ${uniq}`, releasedAt: '2026-01-01 10:00:02' })
    const B = insertRow(dbPath, { phone: '+421905900012', body: `B ${uniq}`, releasedAt: '2026-01-01 10:00:02' })
    const C = insertRow(dbPath, { phone: '+421905900013', body: `C ${uniq}`, releasedAt: '2026-01-01 10:00:01' })
    const queued = insertRow(dbPath, { status: 'queued', phone: '+421905900014', body: `Q ${uniq}` })
    const mail = insertRow(dbPath, { channel: 'email', phone: null, email: `wa9.${uniq}@example.test`, body: `E ${uniq}` })
    const queuedBefore = rowOf(dbPath, queued)
    const mailBefore = rowOf(dbPath, mail)

    const wa = await startWa({ dbPath })
    let stopped = false
    try {
      expect(wa.logs()).toContain(`[wa] boot sender=stub db=${dbPath} `)
      expect(wa.logs()).toContain(`health=127.0.0.1:${wa.port}`)
      expect(wa.logs()).toContain(`[wa] state=connected number=${STUB_NUMBER}`)
      for (const id of [A, B, C]) await waitForStatus(dbPath, id, 'sent', 3000)
      const order = [...wa.logs().matchAll(/\[wa\] sent id=(\d+)/g)].map((m) => Number(m[1]))
      expect(order, 'released_at first, then id').toEqual([C, A, B])

      // A row released while the bot runs ⇒ sent/bot within 1 s; nothing but the four
      // process columns moved — body (diacritics, emoji, newline, a brace) and number included.
      const body = `Ahoj Žofia 👋\nVaša káva „${uniq}“ je pripravená {nie_placeholder} — ďakujeme.`
      const live = insertRow(dbPath, { phone: '+421905900015', body })
      const before = rowOf(dbPath, live)
      const { row: after, elapsed } = await waitForStatus(dbPath, live, 'sent', 1000)
      expect(elapsed, 'within 1 s').toBeLessThan(1000)
      expect(after).toMatchObject({ status: 'sent', sent_via: 'bot', error: null })
      expect(after.sent_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(untouchable(after)).toEqual(untouchable(before))
      expect(after.body).toBe(body)
      expect(after.phone_e164).toBe('+421905900015')

      // The stub's deterministic failure.
      const bad = insertRow(dbPath, { phone: STUB_FAIL_NUMBER, body: `F ${uniq}` })
      const failBefore = rowOf(dbPath, bad)
      const { row: failed } = await waitForStatus(dbPath, bad, 'failed', 1000)
      expect(failed).toMatchObject({ status: 'failed', error: 'stub_fail', sent_via: null, sent_at: null })
      expect(untouchable(failed)).toEqual(untouchable(failBefore))
      await wa.waitForLog(new RegExp(`\\[wa\\] failed id=${bad} error=stub_fail`))

      // Several polls later: the queued row and the released E-MAIL row are untouched.
      await sleep(1200)
      expect(rowOf(dbPath, queued), 'a queued row is never touched').toEqual(queuedBefore)
      expect(rowOf(dbPath, mail), 'an e-mail row is never drained by the WA process').toEqual(mailBefore)

      const { body: h } = await wa.health()
      expect(h).toMatchObject({ state: 'connected', sender: 'stub', number: STUB_NUMBER, last_error: 'stub_fail' })
      expect(h.queue, 'WhatsApp rows only: the released e-mail row is not the bot’s queue').toEqual({ released: 0, sent_today: 4, failed: 1 })

      // PII-free: no recipient number, no body text in the process's output.
      const logs = wa.logs()
      for (const phone of ['421905900011', '421905900012', '421905900013', '421905900014', '421905900015']) expect(logs).not.toContain(phone)
      for (const text of [`A ${uniq}`, `Q ${uniq}`, `E ${uniq}`, 'Žofia', 'wa9.']) expect(logs).not.toContain(text)

      const exit = await wa.stop()
      stopped = true
      expect(exit, 'graceful SIGTERM').toEqual({ code: 0, signal: null })
      expect(wa.logs()).toContain('[wa] shutdown (SIGTERM)')
      expect(wa.logs()).toContain('[wa] stopped')
    } finally {
      if (!stopped) await wa.stop()
    }
  }))

  test('`GET /health` answers the spec shape + `pace` / `hourly_max` (WA-T7) on 127.0.0.1 only; anything else ⇒ 404', withPrivateDb(async (dbPath) => {
    await withWaStub({ dbPath, env: { WA_PACE_MIN_MS: '0', WA_PACE_MAX_MS: '0', WA_HOURLY_MAX: '77' } }, async (wa) => {
      const sent = insertRow(dbPath, { phone: '+421905900021' })
      await waitForStatus(dbPath, sent, 'sent', 2000)
      const res = await fetch(wa.healthUrl)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^application\/json/)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const h = await res.json()
      expect(Object.keys(h).sort()).toEqual(HEALTH_KEYS)
      expect(h).toMatchObject({
        state: 'connected', sender: 'stub', number: STUB_NUMBER, qr: null,
        queue: { released: 0, sent_today: 1, failed: 0 },
        hourly_sent: 1, hourly_max: 77, pace: { min_ms: 0, max_ms: 0 },
        next_send_at: null, last_error: null, db_path: dbPath, version: '1.0.0',
      })
      expect(Number.isInteger(h.uptime_s) && h.uptime_s >= 0).toBe(true)
      expect(Math.abs(Date.parse(h.last_sent_at) - Date.now()), 'last_sent_at = the send just now (ISO)').toBeLessThan(10_000)

      for (const [method, path] of [['GET', '/'], ['GET', '/health/x'], ['GET', '/api/health'], ['POST', '/health'], ['PUT', '/health'], ['DELETE', '/health'], ['HEAD', '/health']]) {
        const r = await fetch(`http://127.0.0.1:${wa.port}${path}`, { method })
        expect(r.status, `${method} ${path}`).toBe(404)
      }
      // Loopback ONLY: a non-internal IPv4 of this box (when it has one) is refused.
      const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
      if (lan) {
        const refused = await new Promise((resolve) => {
          const s = net.connect({ host: lan.address, port: wa.port })
          s.once('connect', () => { s.destroy(); resolve(false) })
          s.once('error', () => resolve(true))
        })
        expect(refused, `not reachable on ${lan.address}`).toBe(true)
      }
    })
  }))

  test('`whatsapp_paused = 1` (re-read every poll): health says `paused`, a released row STAYS released; un-pausing drains it', withPrivateDb(async (dbPath) => {
    await withWaStub({ dbPath }, async (wa) => {
      setPaused(dbPath, '1')
      await expect.poll(async () => (await wa.health()).body.state, { timeout: 2000 }).toBe('paused')
      await wa.waitForLog(/\[wa\] paused \(settings\.whatsapp_paused\)/)
      const row = insertRow(dbPath, { phone: '+421905900031' })
      await sleep(1500) // 7 polls
      expect(rowOf(dbPath, row).status, 'paused ⇒ untouched').toBe('released')
      expect((await wa.health()).body.queue.released).toBe(1)
      setPaused(dbPath, '0')
      await waitForStatus(dbPath, row, 'sent', 1500)
      expect((await wa.health()).body.state).toBe('connected')
      await wa.waitForLog(/\[wa\] resumed \(settings\.whatsapp_paused\)/)
      expect(withDb(dbPath, (db) => db.prepare("SELECT value FROM settings WHERE key = 'whatsapp_paused'").get().value), 'the process reads settings, never writes them').toBe('0')
    })
  }))

  test('the rolling-hour cap (`WA_HOURLY_MAX=2`): the third row WAITS, health publishes `hourly_sent` + `next_send_at`, the log names the time — and a RESTART is still capped (the ring is seeded from `sent_via = bot` rows)', withPrivateDb(async (dbPath) => {
    test.setTimeout(60_000)
    const ids = [1, 2, 3].map((n) => insertRow(dbPath, { phone: `+42190590004${n}`, releasedAt: `2026-01-01 10:00:0${n}` }))
    await withWaStub({ dbPath, env: { WA_HOURLY_MAX: '2' } }, async (wa) => {
      await waitForStatus(dbPath, ids[0], 'sent', 2000)
      await waitForStatus(dbPath, ids[1], 'sent', 2000)
      await sleep(1000)
      expect(rowOf(dbPath, ids[2]).status, 'third waits').toBe('released')
      const { body: h } = await wa.health()
      expect(h.hourly_sent).toBe(2)
      expect(h.hourly_max).toBe(2)
      const next = Date.parse(h.next_send_at)
      expect(next - Date.now(), 'next send ≈ the oldest send + 1 h').toBeGreaterThan(58 * 60_000)
      expect(next - Date.now()).toBeLessThanOrEqual(60 * 60_000)
      await wa.waitForLog(new RegExp(`\\[wa\\] hourly cap reached \\(2\\) — next send at ${clockOf(next)}`))
      expect(wa.logs().match(/hourly cap reached/g).length, 'logged once per cap episode, not per poll').toBe(1)
    })
    await withWaStub({ dbPath, env: { WA_HOURLY_MAX: '2' } }, async (wa) => {
      await sleep(1200)
      expect(rowOf(dbPath, ids[2]).status, 'the boot seed keeps the cap across a restart').toBe('released')
      expect((await wa.health()).body.hourly_sent).toBe(2)
    })
    await withWaStub({ dbPath, env: { WA_HOURLY_MAX: '3' } }, async () => {
      await waitForStatus(dbPath, ids[2], 'sent', 2000)
    })
  }))

  test('the random gap (`WA_PACE_MIN_MS = MAX = 1500`): the second row waits ~1.5 s after the first, with `next_send_at` published meanwhile', withPrivateDb(async (dbPath) => {
    const first = insertRow(dbPath, { phone: '+421905900051', releasedAt: '2026-01-01 10:00:01' })
    const second = insertRow(dbPath, { phone: '+421905900052', releasedAt: '2026-01-01 10:00:02' })
    await withWaStub({ dbPath, env: { WA_PACE_MIN_MS: '1500', WA_PACE_MAX_MS: '1500' } }, async (wa) => {
      await waitForStatus(dbPath, first, 'sent', 2000)
      const t0 = Date.now()
      await sleep(600)
      expect(rowOf(dbPath, second).status, 'held by the gap').toBe('released')
      const { body: h } = await wa.health()
      expect(h.pace).toEqual({ min_ms: 1500, max_ms: 1500 })
      expect(h.next_send_at, 'the held send is published').not.toBeNull()
      await waitForStatus(dbPath, second, 'sent', 3000)
      expect(Date.now() - t0, 'not before the gap').toBeGreaterThan(700)
    })
  }))

  test('pacing counts only rows that REACHED the sender: two malformed rows (`invalid_number`, `empty_body`) ahead of a good one draw no gap (`WA_PACE_MIN_MS = MAX = 1500`)', withPrivateDb(async (dbPath) => {
    const badNumber = insertRow(dbPath, { phone: '0905 garbage', releasedAt: '2026-01-01 10:00:01' })
    const badBody = insertRow(dbPath, { phone: '+421905900056', body: '   ', releasedAt: '2026-01-01 10:00:02' })
    const good = insertRow(dbPath, { phone: '+421905900057', releasedAt: '2026-01-01 10:00:03' })
    await withWaStub({ dbPath, env: { WA_PACE_MIN_MS: '1500', WA_PACE_MAX_MS: '1500' } }, async (wa) => {
      const { elapsed } = await waitForStatus(dbPath, good, 'sent', 1200)
      expect(elapsed, 'the good row is not held by gaps the malformed rows never earned').toBeLessThan(1200)
      expect(rowOf(dbPath, badNumber)).toMatchObject({ status: 'failed', error: 'invalid_number' })
      expect(rowOf(dbPath, badBody)).toMatchObject({ status: 'failed', error: 'empty_body' })
      expect(wa.logs()).not.toContain('0905 garbage')
    })
  }))

  test('the harness proves it talks to ITS child: a FOREIGN `connected` health server already on the port ⇒ `startWa` throws loudly (the child dies of EADDRINUSE), never a false ready', withPrivateDb(async (dbPath) => {
    const port = await freePort()
    const fake = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ state: 'connected', sender: 'stub', number: STUB_NUMBER, db_path: '/somewhere/else.sqlite' }))
    })
    await new Promise((resolve) => fake.listen(port, '127.0.0.1', resolve))
    try {
      let error = null
      try {
        const wa = await startWa({ dbPath, port, timeoutMs: 8000 })
        await wa.stop()
      } catch (e) { error = e }
      expect(error, 'startWa must not accept the foreign answer').not.toBeNull()
      expect(error.message).toMatch(/\[wa-harness\] gorifi-wa exited early \(1\)/)
      expect(error.message).toContain(`[wa] health server cannot listen on 127.0.0.1:${port} (EADDRINUSE)`)
    } finally {
      fake.closeAllConnections?.()
      await new Promise((resolve) => fake.close(resolve))
    }
  }))

  test('the duplicate guard: a row finalised ELSEWHERE while its send is in flight ⇒ the „finalised elsewhere" line and NO overwrite', withPrivateDb(async (dbPath) => {
    await withWaStub({ dbPath, env: { WA_STUB_SEND_MS: '1500' } }, async (wa) => {
      const id = insertRow(dbPath, { phone: '+421905900061' })
      await wa.waitForLog(new RegExp(`\\[wa\\] stub sending id=${id}\\b`), 3000)
      // What the wa.me hand tick writes (PATCH …/manual-sent), done behind the process's back.
      const changed = withDb(dbPath, (db) => db.prepare(
        "UPDATE notifications SET status = 'sent', sent_via = 'wa_me', sent_at = '2026-01-01 08:00:00' WHERE id = ? AND status = 'released'"
      ).run(id).changes)
      expect(changed, 'non-vacuity: the row was still released mid-send').toBe(1)
      await wa.waitForLog(new RegExp(`\\[wa\\] row id=${id} was finalised elsewhere — possible duplicate`), 4000)
      expect(rowOf(dbPath, id)).toMatchObject({ status: 'sent', sent_via: 'wa_me', sent_at: '2026-01-01 08:00:00', error: null })
      expect(wa.logs()).not.toMatch(new RegExp(`\\[wa\\] sent id=${id}\\b`))
    })
  }))

  test('the stub runs with whatsapp-web.js and puppeteer UNLOADABLE (a resolve hook throws on them) — and the hook is live: the whatsapp branch does try the library', withPrivateDb(async (dbPath) => {
    const dir = mkdtempSync(join(os.tmpdir(), 'wa-t9-hook-'))
    try {
      const marker = join(dir, 'blocked.log')
      writeFileSync(join(dir, 'hooks.mjs'), [
        "import { appendFileSync } from 'node:fs'",
        'export async function resolve(specifier, context, next) {',
        "  if (/^(whatsapp-web\\.js|puppeteer(-core)?)(\\/|$)/.test(specifier)) {",
        "    appendFileSync(process.env.WA_T9_BLOCK_LOG, specifier + '\\n')",
        "    throw new Error('blocked by the WA-T9 no-Chromium probe: ' + specifier)",
        '  }',
        '  return next(specifier, context)',
        '}',
      ].join('\n'))
      writeFileSync(join(dir, 'register.mjs'), "import { register } from 'node:module'\nregister('./hooks.mjs', import.meta.url)\n")
      const nodeArgs = ['--import', pathToFileURL(join(dir, 'register.mjs')).href]
      const env = { WA_T9_BLOCK_LOG: marker }

      await withWaStub({ dbPath, nodeArgs, env }, async () => {
        const id = insertRow(dbPath, { phone: '+421905900071' })
        await waitForStatus(dbPath, id, 'sent', 1500)
      })
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '', 'the stub never asked for the library').toBe('')

      // Non-vacuity: the SAME hook sees the whatsapp branch's dynamic import (WA-T10's door).
      await withWaStub({ dbPath, nodeArgs, env: { ...env, WA_SENDER: 'whatsapp' }, waitForState: 'disconnected' }, async (wa) => {
        const { body } = await wa.health()
        expect(body).toMatchObject({ state: 'disconnected', sender: 'whatsapp', last_error: 'whatsapp_web_js_missing', qr: null })
      })
      expect(readFileSync(marker, 'utf8')).toBe('whatsapp-web.js\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }))
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 END TO END — the gate database, the gate server's WA_HEALTH_URL port
// ═════════════════════════════════════════════════════════════════════════════
let ctx = null
let adminToken = ''
const admin = makeAdmin({ ctx: () => ctx, token: () => adminToken, adopt: (t) => { adminToken = t }, timeout: TIMEOUT })
async function ensureAdmin() {
  if (ctx) return
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
}
test.afterAll(async () => { await ctx?.dispose(); ctx = null })

async function adminLogin(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  // ⚠ Adopt the browser's token: the form login just ROTATED the one admin_token row.
  adminToken = await page.evaluate(() => localStorage.getItem('adminToken'))
}
const settings = async () => (await admin('/api/admin/settings')).json()
const putSettings = (data) => admin('/api/admin/settings', { method: 'put', data })

let friendSeq = 0
async function makeFriend(label, phone) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `wa9_${label.toLowerCase()}`.slice(0, 30 - suffix.length) + suffix
  const name = `W9${label}${uniq}${friendSeq} Test`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()
  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  return { id: row.id, name, auth: { Authorization: `Bearer ${token}` } }
}
async function ownOrder(friend, cycleId, items, submitBody) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, { headers: friend.auth, data: { items }, timeout: TIMEOUT })
  expect(put.status(), 'cart PUT').toBe(200)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, { headers: friend.auth, data: submitBody, timeout: TIMEOUT })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}
async function packFriend(cycleId, friend, orderId) {
  const res = await admin(`/api/cycles/${cycleId}/distribution`)
  expect(res.status()).toBe(200)
  const party = (await res.json()).distribution.find((p) => p.id === friend.id && p.kind === 'friend')
  for (const item of party.items) if (!item.packed) expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  expect((await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })).status(), 'order packed').toBe(200)
}
async function groupRows(cycleId, segmentKey) {
  const res = await admin('/api/notifications', { params: { cycle_id: String(cycleId), segment_key: segmentKey } })
  expect(res.status(), `GET /notifications ${segmentKey}`).toBe(200)
  return (await res.json()).rows
}
function bratislavaDate(stamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(`${String(stamp).replace(' ', 'T')}Z`))
}

test.describe('WA-T9 · §2 end to end with the stub on the gate (DB_PATH + WA_HEALTH_URL)', () => {
  test.skip(!CAN_GATE, NEEDS_GATE)
  test.describe.configure({ mode: 'serial' })
  const fx = {}

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    await ensureAdmin()
    const cycle = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA9 ${uniq}`, type: 'coffee', status: 'open', closes_at: '2026-11-06' } })
    expect(cycle.status(), 'cycle create').toBe(201)
    fx.cycle = await cycle.json()
    const product = await admin('/api/products', {
      method: 'post', data: { cycle_id: fx.cycle.id, name: `WA9 Káva ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30 },
    })
    expect(product.status()).toBe(201)
    fx.product = await product.json()
    const loc = await admin('/api/pickup-locations', { method: 'post', data: { name: `WA9 Lipa ${uniq}`, address: 'Ulica 9', for_coffee: true, for_bakery: true } })
    expect(loc.status()).toBe(201)
    fx.L = await loc.json()
    fx.A = await makeFriend('Adam', '0905 909 001')
    fx.B = await makeFriend('Beata', '0905 909 002')
    let stamp = null
    for (const f of [fx.A, fx.B]) {
      const o = await ownOrder(f, fx.cycle.id, [{ product_id: fx.product.id, variant: '250g', quantity: 1 }], { pickup_location_id: fx.L.id })
      await packFriend(fx.cycle.id, f, o.id)
      const res = await admin(`/api/orders/${o.id}/handed-over`, { method: 'patch', data: { handed_over: true } })
      expect(res.status(), 'hand-over').toBe(200)
      stamp = (await res.json()).order.handed_over_at
    }
    fx.key = `handed_over:pickup:${fx.L.id}:${bratislavaDate(stamp)}`
    const rows = await groupRows(fx.cycle.id, fx.key)
    expect(rows.map((r) => r.status), 'two queued WhatsApp rows').toEqual(['queued', 'queued'])
    fx.rows = rows
  })

  test.afterAll(async () => {
    if (fx.L && ctx) {
      const res = await admin(`/api/pickup-locations/${fx.L.id}`, { method: 'delete' })
      expect([200, 204, 404]).toContain(res.status())
    }
  })

  test('§UC-WA-012 with the stub: `Pripojené`, `+421 000 000 000`, the process-reported pace/cap; the test button inserts a released admin row the stub flips to `sent`/`bot` and the counts MOVE; the pause toggle stops the draining, resuming drains', async ({ page }) => {
    test.setTimeout(120_000)
    const before = await settings()
    expect((await putSettings({ whatsappTestPhone: '0905 123 456', whatsappPaused: false })).status()).toBe(200)
    try {
      await withWaStub({ dbPath: DB_PATH, port: GATE_PORT }, async (wa) => {
        // Steady state first: the stub drains whatever the run left released.
        await expect.poll(async () => (await wa.health()).body.queue.released, { timeout: 10_000 }).toBe(0)
        await adminLogin(page)
        await page.goto('/admin/whatsapp/settings')
        await expect(page.getByTestId('wa-status-badge')).toHaveText('Pripojené')
        await expect(page.getByTestId('wa-number')).toHaveText('+421 000 000 000')
        await expect(page.getByTestId('wa-state-word')).toHaveCount(0)
        await expect(page.getByTestId('wa-pace-gap'), 'the harness pace, reported by the process').toHaveText('0–0 s')
        await expect(page.getByTestId('wa-pace-hourly')).toHaveText('100000')
        const q0 = (await wa.health()).body.queue
        await expect(page.getByTestId('wa-queue')).toHaveText(`0 / ${q0.sent_today} / ${q0.failed}`)

        // The test message: one released admin row, drained by the stub.
        const posted = page.waitForResponse((r) => r.url().endsWith('/api/admin/whatsapp/test') && r.request().method() === 'POST')
        await page.getByTestId('wa-test-send').click()
        const res = await posted
        expect(res.status()).toBe(201)
        const created = await res.json()
        expect(created).toMatchObject({ status: 'released', recipient_kind: 'admin', template_key: 'test', phone_e164: '+421905123456' })
        const { row: sent } = await waitForStatus(DB_PATH, created.id, 'sent', 2000)
        expect(sent).toMatchObject({ sent_via: 'bot', body: created.body, phone_e164: '+421905123456' })
        await expect(page.getByTestId('wa-queue'), 'the counts move after a release').toHaveText(`0 / ${q0.sent_today + 1} / ${q0.failed}`, { timeout: 12_000 })
        await expect(page.getByTestId('wa-last-sent')).not.toHaveText('—')

        // Pause from the page ⇒ the setting ⇒ the process stops draining.
        await page.getByTestId('wa-pause-toggle').click()
        await expect.poll(async () => (await settings()).whatsappPaused).toBe(true)
        await expect.poll(async () => (await wa.health()).body.state, { timeout: 3000 }).toBe('paused')
        await expect(page.getByTestId('wa-state-word')).toHaveText('pozastavené', { timeout: 12_000 })
        const held = await admin('/api/admin/whatsapp/test', { method: 'post' })
        expect(held.status()).toBe(201)
        const heldId = (await held.json()).id
        await sleep(1500)
        expect(rowOf(DB_PATH, heldId).status, 'paused ⇒ the stub leaves it released').toBe('released')
        await expect(page.getByTestId('wa-queue')).toHaveText(`1 / ${q0.sent_today + 1} / ${q0.failed}`, { timeout: 12_000 })
        await page.getByTestId('wa-pause-toggle').click()
        await expect.poll(async () => (await settings()).whatsappPaused).toBe(false)
        await waitForStatus(DB_PATH, heldId, 'sent', 3000)
        await expect(page.getByTestId('wa-status-badge')).toHaveText('Pripojené', { timeout: 12_000 })
      })
    } finally {
      await putSettings({ whatsappTestPhone: before.whatsappTestPhone, whatsappPaused: before.whatsappPaused })
    }
  })

  test('§UC-WA-008 against the REAL process: the wa.me tick on a released row 409s `bot_active` while the stub is connected, and the stub then sends it', async () => {
    test.setTimeout(60_000)
    await ensureAdmin()
    const before = await settings()
    expect((await putSettings({ whatsappTestPhone: '0905 123 457', whatsappPaused: false })).status()).toBe(200)
    try {
      await withWaStub({ dbPath: DB_PATH, port: GATE_PORT, env: { WA_STUB_SEND_MS: '2500' } }, async (wa) => {
        // A pending `'test'` row left by the run would 409 `test_pending` — let the stub drain it.
        await expect.poll(async () => (await wa.health()).body.queue.released, { timeout: 30_000 }).toBe(0)
        const res = await admin('/api/admin/whatsapp/test', { method: 'post' })
        expect(res.status(), await res.text()).toBe(201)
        const id = (await res.json()).id
        await wa.waitForLog(new RegExp(`\\[wa\\] stub sending id=${id}\\b`), 8000)
        const tick = await admin(`/api/notifications/${id}/manual-sent`, { method: 'patch', data: { sent: true } })
        expect(tick.status()).toBe(409)
        expect((await tick.json()).reason).toBe('bot_active')
        expect(rowOf(DB_PATH, id).status, 'the refusal wrote nothing').toBe('released')
        await wa.waitForLog(new RegExp(`\\[wa\\] sent id=${id}\\b`), 6000)
        expect(rowOf(DB_PATH, id)).toMatchObject({ status: 'sent', sent_via: 'bot' })
      })
    } finally {
      await putSettings({ whatsappTestPhone: before.whatsappTestPhone, whatsappPaused: before.whatsappPaused })
    }
  })

  test('§UC-WA-009 with the stub: „Poslať skupine (2)" ⇒ both rows `Odoslané` WITHOUT a reload (the 5 s health tick re-reads them), sent by the bot, bodies unchanged', async ({ page }) => {
    test.setTimeout(90_000)
    await adminLogin(page)
    await withWaStub({ dbPath: DB_PATH, port: GATE_PORT }, async () => {
      await page.goto(`/admin/whatsapp?cycle=${fx.cycle.id}&segment=${encodeURIComponent(fx.key)}`)
      for (const r of fx.rows) await expect(page.getByTestId(`wa-row-${r.id}`).getByTestId('wa-row-badge')).toHaveText('Vo fronte')
      await expect(page.getByTestId('wa-offline-banner'), 'the stub is connected').toHaveCount(0)
      let navigations = 0
      page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1 })
      await page.getByTestId('wa-release').click()
      await expect(page.getByTestId('wa-toast')).toHaveText('2 správy uvoľnené — bot ich odošle s odstupom 3–10 s')
      for (const r of fx.rows) {
        await expect(page.getByTestId(`wa-row-${r.id}`).getByTestId('wa-row-badge')).toHaveText('Odoslané', { timeout: 12_000 })
      }
      expect(navigations, 'no reload').toBe(0)
      for (const r of fx.rows) {
        expect(rowOf(DB_PATH, r.id)).toMatchObject({ status: 'sent', sent_via: 'bot', body: r.body, phone_e164: r.phone_e164 })
      }
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §3 THE API SIDE of a second writer — `.immediate()` + `db_busy`
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T9 · §3 the API takes the write lock up front; a held lock is a 503, never a 500', () => {
  test('each outbox helper begins `BEGIN IMMEDIATE`: with ANOTHER connection holding the write lock (busy_timeout 0) even a read-only call throws SQLITE_BUSY — and succeeds once the lock is gone', () => {
    test.skip(!HAS_SRC, NEEDS_SRC)
    const dir = mkdtempSync(join(os.tmpdir(), 'wa-t9-imm-'))
    try {
      const dbFile = join(dir, 'imm.sqlite')
      const src = (rel) => pathToFileURL(join(BACKEND_DIR, rel)).href
      const probe = join(dir, 'probe.mjs')
      writeFileSync(probe, `
        import db from '${src('src/db/schema.js')}';
        import * as outbox from '${src('src/helpers/outbox.js')}';
        import Database from '${src('node_modules/better-sqlite3/lib/index.js')}';
        db.exec('PRAGMA busy_timeout = 0');
        const other = new Database(process.env.DB_PATH, { timeout: 0 });
        const key = 'handed_over:pickup:987654:2026-10-24';
        const calls = {
          releaseGroup: () => outbox.releaseGroup({ cycleId: 987654, segmentKey: key }),
          retryGroup: () => outbox.retryGroup({ cycleId: 987654, segmentKey: key }),
          rerenderGroup: () => outbox.rerenderGroup({ cycleId: 987654, segmentKey: key, baseUrl: 'http://x' }),
          editRowBody: () => outbox.editRowBody(987654, 'x'),
          markManualSent: () => outbox.markManualSent(987654, ['queued']),
          deleteRow: () => outbox.deleteRow(987654),
          insertTestMessage: () => outbox.insertTestMessage({ phoneE164: '+421905000000' }),
        };
        const run = () => Object.fromEntries(Object.entries(calls).map(([k, fn]) => {
          try { fn(); return [k, 'ok']; } catch (e) { return [k, e.code || e.name]; }
        }));
        other.exec('BEGIN IMMEDIATE');
        const locked = run();
        other.exec('ROLLBACK');
        const free = run();
        console.log('@@PROBE@@' + JSON.stringify({ locked, free }));
      `)
      const r = spawnSync(process.execPath, [probe], { env: { ...process.env, DB_PATH: dbFile, WA_HEALTH_URL: '' }, encoding: 'utf8', timeout: 60_000 })
      const m = (r.stdout || '').match(/@@PROBE@@(.*)/)
      expect(m, `${r.stdout}\n${r.stderr}`).toBeTruthy()
      const { locked, free } = JSON.parse(m[1])
      const names = ['releaseGroup', 'retryGroup', 'rerenderGroup', 'editRowBody', 'markManualSent', 'deleteRow', 'insertTestMessage']
      expect(locked).toEqual(Object.fromEntries(names.map((n) => [n, 'SQLITE_BUSY'])))
      expect(free, 'non-vacuity: nothing else made them throw').toEqual(Object.fromEntries(names.map((n) => [n, 'ok'])))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a write lock held past `busy_timeout` (5 s) ⇒ 503 `db_busy` + Retry-After, nothing written; the same call answers normally once the lock is gone', async () => {
    test.skip(!DB_PATH, 'needs DB_PATH — the database the gate server runs on')
    test.setTimeout(60_000)
    await ensureAdmin()
    const lock = openDb(DB_PATH)
    let res
    try {
      lock.exec('BEGIN IMMEDIATE')
      res = await admin('/api/notifications/987654321/body', { method: 'patch', data: { body: 'x' }, timeout: 30_000 })
    } finally {
      try { lock.exec('ROLLBACK') } catch { /* not in a transaction */ }
      lock.close()
    }
    expect(res.status()).toBe(503)
    expect(res.headers()['retry-after']).toBe('1')
    expect(await res.json()).toEqual({ error: 'Databaza je prave zaneprazdnena, skuste to znova', reason: 'db_busy' })
    const after = await admin('/api/notifications/987654321/body', { method: 'patch', data: { body: 'x' } })
    expect(after.status(), 'no lock ⇒ the route’s own answer').toBe(404)
    if (process.env.SERVER_LOG) {
      const log = readFileSync(process.env.SERVER_LOG, 'utf8')
      expect(log).toContain('Databaza zaneprazdnena: PATCH /api/notifications/987654321/body (SQLITE_BUSY)')
    }
  })
})
