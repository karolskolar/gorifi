// 21 §UC-WA-011 — the WA process's ONLY door to the SQLite file the API owns.
//
// ⚠⚠ THE SECOND WRITER. Everything this process writes is in the two statements
// `markSent` / `markFailed` below, and they write ONLY `notifications.status`,
// `sent_at`, `sent_via` and `error` — never `body`, never `phone_e164`, never another
// table (21 §UC-WA-001 business rules, §UC-WA-011 step 6). `settings` is READ
// (`whatsapp_paused`), never written. The schema is the API's: this file runs no DDL and
// no migration, and refuses to start on a file the API has not migrated yet.
//
// ⚠ Both writes are CONDITIONAL (`… WHERE id = ? AND status = 'released' AND channel =
// 'whatsapp'`): the wa.me hand tick (`PATCH /api/notifications/:id/manual-sent`) and the
// admin's retry/rerender may have moved the row while a send was in flight. 0 rows
// changed ⇒ the caller logs „finalised elsewhere" and never overwrites.
//
// ⚠ One short transaction per row (`BEGIN IMMEDIATE` — the write lock is taken up front,
// where `busy_timeout` applies), WAL (the API set it on the file; it is persistent),
// `busy_timeout = 5000`. The API's own read-then-write outbox transactions are
// `.immediate()` too (WA-T9), so neither side can lose a snapshot to the other.

import Database from 'better-sqlite3'

export const BUSY_TIMEOUT_MS = 5000
export const ERROR_MAX = 300
const REQUIRED_COLUMNS = ['id', 'channel', 'status', 'phone_e164', 'body', 'released_at', 'sent_at', 'sent_via', 'error']

export class OutboxOpenError extends Error {}

// A SQLite UTC stamp (`YYYY-MM-DD HH:MM:SS`) ⇒ epoch ms (NaN when unparsable).
export function stampToMs(stamp) {
  if (typeof stamp !== 'string') return NaN
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp) ? `${stamp.replace(' ', 'T')}Z` : stamp
  return Date.parse(iso)
}

// Epoch ms ⇒ a SQLite UTC stamp, the format `CURRENT_TIMESTAMP` writes.
export function msToStamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

// The UTC instant at which TODAY (Europe/Bratislava) began — the `sent_today` boundary.
export function bratislavaDayStart(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]))
  const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  const offset = wallAsUtc - Math.floor(now / 1000) * 1000
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset
}

export function openOutbox(dbPath) {
  let db
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS })
  } catch (e) {
    throw new OutboxOpenError(`cannot open DB_PATH (${e.code || e.name}) — it must be the API's existing database file`)
  }
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  const columns = db.prepare("SELECT name FROM pragma_table_info('notifications')").all().map((r) => r.name)
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c))
  if (missing.length) {
    db.close()
    throw new OutboxOpenError(columns.length === 0
      ? 'DB_PATH has no notifications table — start (migrate) the backend first'
      : `notifications lacks ${missing.join(', ')} — start (migrate) the backend first`)
  }
  const hasSettings = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()
  if (!hasSettings) {
    db.close()
    throw new OutboxOpenError('DB_PATH has no settings table — start (migrate) the backend first')
  }

  const stmt = {
    next: db.prepare(`
      SELECT id, phone_e164, body FROM notifications
       WHERE status = 'released' AND channel = 'whatsapp'
       ORDER BY released_at, id LIMIT 1
    `),
    sent: db.prepare(`
      UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP, sent_via = 'bot', error = NULL
       WHERE id = ? AND status = 'released' AND channel = 'whatsapp'
    `),
    failed: db.prepare(`
      UPDATE notifications SET status = 'failed', error = ?
       WHERE id = ? AND status = 'released' AND channel = 'whatsapp'
    `),
    paused: db.prepare("SELECT value FROM settings WHERE key = 'whatsapp_paused'"),
    recentBot: db.prepare(`
      SELECT sent_at FROM notifications
       WHERE sent_via = 'bot' AND sent_at > datetime('now', '-1 hour')
    `),
    lastBot: db.prepare("SELECT MAX(sent_at) AS at FROM notifications WHERE sent_via = 'bot'"),
    counts: db.prepare(`
      SELECT COALESCE(SUM(status = 'released'), 0) AS released,
             COALESCE(SUM(status = 'failed'), 0) AS failed,
             COALESCE(SUM(status = 'sent' AND sent_via = 'bot' AND sent_at >= ?), 0) AS sent_today
        FROM notifications WHERE channel = 'whatsapp'
    `),
  }
  const writeSent = db.transaction((id) => stmt.sent.run(id).changes)
  const writeFailed = db.transaction((id, error) => stmt.failed.run(error, id).changes)

  return {
    // The oldest released WhatsApp row (`ORDER BY released_at, id` — step 1).
    nextReleased() {
      return stmt.next.get()
    },
    // ⇒ rows changed (1, or 0 when the row was finalised elsewhere).
    markSent(id) {
      return writeSent.immediate(id)
    },
    markFailed(id, error) {
      return writeFailed.immediate(id, String(error ?? 'unknown').slice(0, ERROR_MAX))
    },
    isPaused() {
      return stmt.paused.get()?.value === '1'
    },
    // Epoch-ms stamps of the bot's sends in the last hour — the pacing ring's boot seed.
    recentBotSends() {
      return stmt.recentBot.all().map((r) => stampToMs(r.sent_at)).filter(Number.isFinite)
    },
    lastBotSendMs() {
      const ms = stampToMs(stmt.lastBot.get()?.at)
      return Number.isFinite(ms) ? ms : null
    },
    queueCounts(now = Date.now()) {
      const row = stmt.counts.get(msToStamp(bratislavaDayStart(now)))
      return { released: row.released, sent_today: row.sent_today, failed: row.failed }
    },
    close() {
      db.close()
    },
  }
}
