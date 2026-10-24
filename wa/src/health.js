// 21 §UC-WA-011 „GET /health" — the process's ONLY HTTP surface, bound to 127.0.0.1
// (loopback; the API proxies it as `GET /api/admin/whatsapp/health`, WA-T7). No auth —
// loopback only. `GET /health` ⇒ 200 JSON (`Cache-Control: no-store`); ANYTHING else —
// another path, another method, a query-less `/health/` — ⇒ 404. No POST routes in v1 (D7).
//
// Shape (the spec's list PLUS WA-T7's Tempo-card contract, learnings 15 §WA-T7 decision 6):
//   { state, sender, number, qr, queue: { released, sent_today, failed }, hourly_sent,
//     hourly_max, pace: { min_ms, max_ms }, next_send_at, last_sent_at, last_error,
//     db_path, uptime_s, version }
// ⚠ `qr` is non-null ONLY while `state = 'qr'` (a pairing credential — never logged).

import http from 'node:http'

export function startHealthServer({ host, port, snapshot }) {
  const server = http.createServer((req, res) => {
    let pathname = null
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname
    } catch { /* unparsable ⇒ 404 */ }
    if (req.method !== 'GET' || pathname !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ error: 'not_found' }))
      return
    }
    let body
    try {
      body = JSON.stringify(snapshot())
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ error: 'health_failed' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
