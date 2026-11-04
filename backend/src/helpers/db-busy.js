// WA-T9 (21 §UC-WA-011) — ONE home for „the database is busy" since the `gorifi-wa`
// process became the SECOND writer to the SQLite file.
//
// The API's outbox / hand-over transactions run `BEGIN IMMEDIATE` (they take the write
// lock up front and wait up to better-sqlite3's default `busy_timeout`, 5 s, for the WA
// process's one-row UPDATE). Two residual cases still throw a `SQLITE_BUSY*` code: a lock
// held PAST the timeout, and a DEFERRED read-then-write transaction elsewhere in the API
// whose snapshot went stale (`SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` never retries).
// Both are transient — the throw rolled the transaction back, nothing was written — so the
// answer is 503 + `Retry-After: 1` with `reason: 'db_busy'`, never a 500 with a stack.
//
// Used by `index.js`'s error handler (every route that lets a throw escape) and by the
// one outbox handler that catches its own errors (`PATCH /api/notifications/:id/manual-sent`).

export const DB_BUSY_REASON = 'db_busy';

export function isDbBusy(err) {
  return Boolean(err) && typeof err.code === 'string' && err.code.startsWith('SQLITE_BUSY');
}

export function sendDbBusy(req, res, err) {
  console.warn(`Databaza zaneprazdnena: ${req.method} ${req.originalUrl} (${err.code})`);
  res.set('Retry-After', '1');
  return res.status(503).json({ error: 'Databaza je prave zaneprazdnena, skuste to znova', reason: DB_BUSY_REASON });
}
