// 21 §UC-WA-011 — `gorifi-wa`: the ONLY component that talks to WhatsApp, a SEPARATE
// process (its own package.json, PM2 app `gorifi-wa`, WA-T11) that drains the outbox
// the API fills. It has no admin token and no HTTP write surface: the API never calls
// it except `GET /health`, and it never calls the API. They meet in ONE place — the
// SQLite file named by `DB_PATH` — where this process writes only
// `notifications.status / sent_at / sent_via / error` (db.js).
//
// ⚠ `backend/` imports nothing from `wa/` and `wa/` nothing from `backend/` (pinned by
// `e2e/tests/whatsapp-process.spec.js`); `grep -rn "whatsapp-web" backend/` stays EMPTY.
//
// Boot order: config (exit 1 on any malformed value — `[wa] DB_PATH is required`) → DB
// (exit 1 unless it is the API's migrated file) → health server (exit 1 if the port is
// taken) → the send loop → the sender. SIGTERM/SIGINT: stop the loop (an in-flight send
// finishes and is written), close health, stop the sender, close the DB, exit 0.

import { readFileSync } from 'node:fs'
import { readConfig } from './config.js'
import { openOutbox, OutboxOpenError } from './db.js'
import { createPacer } from './pacer.js'
import { createSender } from './sender.js'
import { startLoop } from './loop.js'
import { startHealthServer } from './health.js'
import { qrDataUrl } from './qr.js'
import { log, logError } from './log.js'

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || null
  } catch {
    return null
  }
})()

const { config, error } = readConfig(process.env, process.cwd())
if (error) {
  logError(error)
  process.exit(1)
}

log(`boot sender=${config.sender} db=${config.dbPath} session=${config.sessionDir} health=${config.healthHost}:${config.healthPort} version=${VERSION}`)
log(`pace poll_ms=${config.pollMs} gap_ms=${config.paceMinMs}-${config.paceMaxMs} hourly_max=${config.hourlyMax}`)
if (config.sender === 'stub') {
  log(`stub number=+421000000000 fail_number=${config.stubFailNumber}${config.stubSendMs ? ` send_ms=${config.stubSendMs}` : ''}`)
}

let store
try {
  store = openOutbox(config.dbPath)
} catch (e) {
  logError(e instanceof OutboxOpenError ? e.message : `cannot open DB_PATH (${e?.code || e?.name || 'Error'})`)
  process.exit(1)
}

const startedAt = Date.now()
const status = {
  senderState: 'starting',
  number: null,
  qr: null,
  paused: false,
  lastError: null,
  lastSentMs: store.lastBotSendMs(),
  nextSendMs: null,
  inFlight: null,
}
try {
  status.paused = store.isPaused()
  if (status.paused) log('paused (settings.whatsapp_paused)')
} catch { /* the loop re-reads it every poll */ }

const pacer = createPacer({
  minMs: config.paceMinMs,
  maxMs: config.paceMaxMs,
  hourlyMax: config.hourlyMax,
  seed: store.recentBotSends(),
  lastAttemptMs: status.lastSentMs,
})

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

function effectiveState() {
  return status.senderState === 'connected' && status.paused ? 'paused' : status.senderState
}

function snapshot() {
  let queue = null
  try {
    queue = store.queueCounts()
  } catch (e) {
    status.lastError = `db: ${e?.code || e?.name || 'Error'}`
  }
  const state = effectiveState()
  return {
    state,
    sender: config.sender,
    number: status.number,
    qr: state === 'qr' ? status.qr : null,
    queue,
    hourly_sent: pacer.hourlySent(),
    hourly_max: config.hourlyMax,
    pace: { min_ms: config.paceMinMs, max_ms: config.paceMaxMs },
    next_send_at: iso(status.nextSendMs),
    last_sent_at: iso(status.lastSentMs),
    last_error: status.lastError,
    db_path: config.dbPath,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    version: VERSION,
  }
}

let health
try {
  health = await startHealthServer({ host: config.healthHost, port: config.healthPort, snapshot })
} catch (e) {
  logError(`health server cannot listen on ${config.healthHost}:${config.healthPort} (${e?.code || e?.name || 'Error'})`)
  store.close()
  process.exit(1)
}

const sender = createSender(config)
const loop = startLoop({ store, sender, pacer, status, config })

let qrSeq = 0
async function onState({ state, number, qrText, error: senderError }) {
  if (state === 'qr') {
    const mine = ++qrSeq
    const url = await qrDataUrl(qrText)
    if (mine !== qrSeq) return
    status.qr = url
  } else {
    qrSeq++
    status.qr = null
  }
  if (typeof number === 'string' && number) status.number = number
  if (typeof senderError === 'string' && senderError) status.lastError = senderError
  const changed = status.senderState !== state
  status.senderState = state
  if (!changed) return
  if (state === 'connected') log(`state=connected number=${status.number}`)
  else if (state === 'qr') log('state=qr (scan in Nastavenia → WhatsApp)')
  else if (state === 'auth_failure') log('auth_failure — sender stopped; re-pair via Nastavenia → WhatsApp')
  else log(`state=${state}`)
}

sender.start({ onState }).catch((e) => {
  logError(`sender start failed (${e?.name || 'Error'})`)
  status.senderState = 'disconnected'
  status.lastError = `${e?.name || 'Error'}: ${String(e?.message ?? '')}`.slice(0, 300)
})

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`shutdown (${signal})`)
  const force = setTimeout(() => {
    logError('shutdown timed out — exiting')
    process.exit(1)
  }, 15_000)
  force.unref()
  try {
    await loop.stop()
    health.closeAllConnections?.()
    await new Promise((resolve) => health.close(resolve))
    await sender.stop()
  } catch (e) {
    logError(`shutdown error (${e?.name || 'Error'})`)
  }
  try { store.close() } catch { /* already closed */ }
  log('stopped')
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (e) => {
  logError(`unhandled rejection (${e?.name || 'Error'})`)
})
