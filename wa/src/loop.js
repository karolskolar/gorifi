// 21 §UC-WA-011 „Send loop" — drains `released` WhatsApp rows, one at a time.
//
//   every tick (WA_POLL_MS, or sooner while a pacing gap runs out):
//     0. an outcome whose WRITE failed (lock held past busy_timeout) is retried FIRST, and
//        nothing new is sent until it lands — a delivered row must never be re-sent
//        because its `sent` write was lost;
//     1. `settings.whatsapp_paused` is RE-READ ⇒ paused: nothing is selected (the state
//        overlay `paused` is index.js's), rows stay `released`;
//     2. only while the sender is `connected`: the oldest released row
//        (`ORDER BY released_at, id LIMIT 1`); pacing (pacer.js) may hold it — then
//        `next_send_at` is published and the tick re-runs when the hold expires;
//     3–4. the send ⇒ the CONDITIONAL UPDATE (db.js); 0 rows changed ⇒
//        `[wa] row id=… was finalised elsewhere — possible duplicate`, never an overwrite;
//     5. a known refusal ⇒ `failed`/<code>; anything thrown ⇒ `failed`/`<name>: <message>`
//        (≤ 300) — and the loop continues with the next row.
//
// ⚠ Logs carry ids and codes only — a thrown error's MESSAGE goes to the DB column (the
// admin's composer tooltip), its NAME to the log (a library message may quote a number).

import { log, logError, clockOf } from './log.js'
import { ERROR_MAX } from './db.js'

const E164 = /^\+[1-9]\d{6,14}$/

export function startLoop({ store, sender, pacer, status, config }) {
  const unwritten = new Map() // id → outcome whose conditional UPDATE threw
  let stopped = false
  let timer = null
  let running = null
  let capLogged = false

  function dbTrouble(e, what) {
    const code = e?.code || e?.name || 'Error'
    status.lastError = `db: ${code}`
    logError(`db ${what} failed (${code}) — retrying on the next poll`)
  }

  function writeOutcome(id, outcome) {
    const changed = outcome.sent ? store.markSent(id) : store.markFailed(id, outcome.error)
    if (changed === 0) {
      log(`row id=${id} was finalised elsewhere — possible duplicate`)
    } else if (outcome.sent) {
      log(`sent id=${id}`)
    } else {
      log(`failed id=${id} error=${outcome.logCode}`)
    }
  }

  async function deliver(row) {
    if (typeof row.phone_e164 !== 'string' || !E164.test(row.phone_e164)) {
      return { sent: false, contacted: false, error: 'invalid_number', logCode: 'invalid_number' }
    }
    if (typeof row.body !== 'string' || !row.body.trim()) {
      return { sent: false, contacted: false, error: 'empty_body', logCode: 'empty_body' }
    }
    status.inFlight = row.id
    try {
      const result = await sender.send({ id: row.id, phoneE164: row.phone_e164, body: row.body })
      if (result && result.ok === true) return { sent: true, contacted: true }
      const code = typeof result?.error === 'string' && /^[a-z_]{1,40}$/.test(result.error) ? result.error : 'unknown'
      return { sent: false, contacted: true, error: code, logCode: code }
    } catch (e) {
      const name = typeof e?.name === 'string' && /^[A-Za-z_]{1,40}$/.test(e.name) ? e.name : 'Error'
      const message = String(e?.message ?? e ?? '')
      return { sent: false, contacted: true, error: `${name}: ${message}`.slice(0, ERROR_MAX), logCode: name }
    } finally {
      status.inFlight = null
    }
  }

  async function tick() {
    for (const [id, outcome] of unwritten) {
      try {
        writeOutcome(id, outcome)
        unwritten.delete(id)
      } catch (e) {
        dbTrouble(e, `write id=${id}`)
        return config.pollMs
      }
    }

    let paused
    try {
      paused = store.isPaused()
    } catch (e) {
      dbTrouble(e, 'read of settings')
      return config.pollMs
    }
    if (paused !== status.paused) {
      status.paused = paused
      log(paused ? 'paused (settings.whatsapp_paused)' : 'resumed (settings.whatsapp_paused)')
    }
    if (paused || status.senderState !== 'connected') {
      status.nextSendMs = null
      return config.pollMs
    }

    let row
    try {
      row = store.nextReleased()
    } catch (e) {
      dbTrouble(e, 'read of the outbox')
      return config.pollMs
    }
    const now = Date.now()
    if (!row) {
      status.nextSendMs = null
      capLogged = false
      return config.pollMs
    }
    const { at, capped } = pacer.nextAllowed(now)
    if (at > now) {
      status.nextSendMs = at
      if (capped && !capLogged) {
        capLogged = true
        log(`hourly cap reached (${config.hourlyMax}) — next send at ${clockOf(at)}`)
      }
      return Math.max(1, Math.min(config.pollMs, at - now))
    }
    capLogged = false
    status.nextSendMs = null

    const outcome = await deliver(row)
    const done = Date.now()
    // Pacing counts only attempts that reached the sender (review, WA-T9): a row refused
    // before `sender.send` (`invalid_number` / `empty_body`) talked to nobody, so it draws
    // no gap and cannot delay the next, good row.
    if (outcome.contacted) pacer.recordAttempt(done, { sent: outcome.sent })
    if (outcome.sent) status.lastSentMs = done
    else status.lastError = outcome.error
    try {
      writeOutcome(row.id, outcome)
    } catch (e) {
      unwritten.set(row.id, outcome)
      dbTrouble(e, `write id=${row.id}`)
      return config.pollMs
    }
    return 0
  }

  async function run() {
    timer = null
    if (stopped) return
    let delay = config.pollMs
    running = tick().then((d) => { delay = d }, (e) => {
      logError(`loop error (${e?.name || 'Error'})`)
    })
    await running
    running = null
    if (!stopped) timer = setTimeout(run, delay)
  }

  timer = setTimeout(run, 0)

  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (running) await running
    },
  }
}
