// e2e/mailgun-harness.js — the SHARED Mailgun stub harness (08 §UC-EM-005 item 1).
//
// EXTRACTED VERBATIM from `tests/invitation-approval.spec.js` by EM-T2 so that
// `email-templates.spec.js` (EM-T2) and module 09's magic-link specs (ML-T2) consume
// ONE harness instead of forking it. EM-T1 deliberately placed `multipartFields()` and
// `sendViaMailer()` beside `startMailgunStub()`/`withMailHarness()` so they lift as one
// block — this file is that block.
//
// ⚠ NO TEST USING THIS FILE EVER SENDS REAL MAIL. Every server started here gets a
// FAKE key and a `MAILGUN_BASE_URL` on 127.0.0.1, and the ambient `MAILGUN_*` env is
// BLANKED FIRST (see `startBackend`) — so even a bug that ignored the mailer's no-op
// rule could only reach the local stub.

import { expect, request as playwrightRequest } from '@playwright/test'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD, setMailSafeTarget } from './fixtures.js'

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_ENTRY = path.resolve(E2E_DIR, '../backend/src/index.js')
const SEED_SCRIPT = path.resolve(E2E_DIR, 'seed.mjs')
export const MAILER_ENTRY = path.resolve(E2E_DIR, '../backend/src/helpers/mailer.js')
export const TEMPLATES_ENTRY = path.resolve(E2E_DIR, '../backend/src/helpers/email-templates.js')

// The stub harness needs the backend SOURCE, so callers self-skip when the suite is
// pointed at a deployment (`BASE_URL=https://gorifi-dev.skolar.sk`) — the `DB_PATH`
// precedent.
export const CAN_SPAWN_BACKEND = fs.existsSync(BACKEND_ENTRY) && fs.existsSync(SEED_SCRIPT)
export const CAN_SPAWN_MAILER = fs.existsSync(MAILER_ENTRY)

// Obviously not a credential, and long enough that a substring search for it in a
// response body or a log file is meaningful.
export const FAKE_MAILGUN_KEY = 'key-e2e-fake-0000000000000000000000000000'
export const STUB_MAILGUN_DOMAIN = 'mg.stub.invalid'

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// A stand-in for `https://api.eu.mailgun.net` that records what it was sent and replies
// with whatever the test asks for.
export async function startMailgunStub() {
  const requests = []
  let reply = { status: 200, body: { id: '<stub.20260814@mg.stub.invalid>', message: 'Queued. Thank you.' } }
  // ⚠ ML-T2: a deliberately SLOW Mailgun. `magic-link.js` must respond before the send
  // settles (09 §UC-ML-003 rule 2 — awaiting it would make a matched identifier
  // measurably slower than an unmatched one, i.e. the enumeration oracle by stopwatch).
  // The request is RECORDED immediately and only the REPLY is delayed, so a test can
  // still see that the send was attempted.
  let replyDelayMs = 0
  const pendingTimers = new Set()

  const server = http.createServer((req, res) => {
    let raw = ''
    // ⚠ setEncoding, not string concatenation of raw Buffers: the multipart body carries
    // Slovak diacritics and a chunk boundary can fall inside a UTF-8 sequence.
    req.setEncoding('utf8')
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || '',
        contentType: req.headers['content-type'] || '',
        body: raw,
      })
      const send = () => {
        if (res.writableEnded) return
        res.writeHead(reply.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(reply.body))
      }
      if (replyDelayMs > 0) {
        const timer = setTimeout(() => { pendingTimers.delete(timer); send() }, replyDelayMs)
        pendingTimers.add(timer)
      } else {
        send()
      }
    })
  })

  const port = await freePort()
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setReply(next) { reply = next },
    // Delay every subsequent REPLY by `ms` (0 = immediate, the default).
    setReplyDelay(ms) { replyDelayMs = ms },
    async stop() {
      // ⚠ Clear any in-flight delayed reply first, or `server.close()` waits on a timer
      // the test has already finished with and the whole spec hangs.
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
      // undici keeps the connection alive, so close() alone would hang.
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// A second, throwaway backend process with its own DB and its own env overrides.
//
// ⚠ `extraEnv` was `mailEnv` until GA-T2: `google-auth-verifier.spec.js` needs the same
// throwaway-server trick for `GOOGLE_CLIENT_ID`, because the configured and unconfigured
// cases are two different servers and the gate server can only be one of them. Nothing
// about the Mailgun safety model changed — the parameter was always a plain env spread.
export async function startBackend(extraEnv) {
  const port = await freePort()
  const dbPath = path.join(os.tmpdir(), `gorifi-mailer-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`)
  const baseUrl = `http://127.0.0.1:${port}`

  const child = spawn(process.execPath, [BACKEND_ENTRY], {
    cwd: path.resolve(BACKEND_ENTRY, '../..'),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PORT: String(port),
      CORS_ORIGIN: baseUrl,
      PUBLIC_BASE_URL: baseUrl,
      RATE_LIMIT_AUTH_MAX: '100000',
      RATE_LIMIT_ABUSE_MAX: '100000',
      RATE_LIMIT_GUEST_READ_MAX: '100000',
      RATE_LIMIT_GUEST_WRITE_MAX: '100000',
      // ⚠ FIVE buckets since ML-T2 — `magicLinkLimiter` defaults to 10/window, which a
      // single enumeration test (7+ identifiers) would exhaust on its own.
      RATE_LIMIT_MAGIC_MAX: '100000',
      // ⚠ Blanked FIRST, so an operator's real key in the ambient environment cannot be
      // inherited by a harness server. Only `mailEnv` can turn sending on.
      MAILGUN_API_KEY: '',
      MAILGUN_DOMAIN: '',
      MAILGUN_BASE_URL: '',
      // ⚠ GA-T2: the SAME rule for the backend's second outbound dependency. An
      // operator's real `GOOGLE_CLIENT_ID` (or a stray `GOOGLE_AUTH_TEST_MODE`) in the
      // ambient environment must not decide what a harness server reports — the
      // unconfigured case is a first-class assertion (§UC-GA-002: `googleClientId: null`).
      GOOGLE_CLIENT_ID: '',
      GOOGLE_AUTH_TEST_MODE: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output = []
  child.stdout.on('data', (c) => output.push(String(c)))
  child.stderr.on('data', (c) => output.push(String(c)))

  const deadline = Date.now() + 30_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`harness backend exited early (${child.exitCode}): ${output.join('')}`)
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`harness backend never became healthy: ${output.join('')}`)
    }
    try {
      const health = await fetch(`${baseUrl}/api/health`)
      if (health.ok) break
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }

  // The same seeding the local recipe does — it is what sets the admin password.
  await new Promise((resolve) => {
    const seed = spawn(process.execPath, [SEED_SCRIPT], {
      cwd: E2E_DIR,
      env: { ...process.env, BASE_URL: baseUrl },
      stdio: 'ignore',
    })
    seed.on('exit', resolve)
    seed.on('error', resolve)
  })

  return {
    baseUrl,
    // ⚠ Exposed for ML-T2/T3: the magic-link raw token is never in any response, and
    // `login_tokens` has no read endpoint, so the only way to assert what was stored
    // (predecessor invalidation, the opportunistic GC, sha256(raw) === token_hash) is
    // to open this file directly. WAL mode makes a concurrent reader/writer safe.
    dbPath,
    logs: () => output.join(''),
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
          child.on('exit', () => { clearTimeout(timer); resolve() })
        })
      }
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`) } catch { /* best effort */ }
      }
    },
  }
}

// Run `fn` against a throwaway backend + stub Mailgun.
//
// `fn` receives `{ stub, backend, ctx, adminToken }`: a logged-in Playwright request
// context for the harness server plus its admin token. A spec whose fixture builders
// read module-level `ctx`/`adminToken` (invitation-approval.spec.js) wraps this and
// swaps its own state for the duration — the swap is the SPEC's concern, not the
// harness's, so a consumer with no such state (email-templates.spec.js, ML-T2) uses
// the handed-in context directly.
export async function withMailHarness(mailEnv, fn) {
  const stub = await startMailgunStub()
  let backend
  let savedMailSafe
  let harnessCtx
  try {
    // Inside a harness block the fixtures talk to a LOCAL throwaway backend whose
    // `MAILGUN_BASE_URL` is a 127.0.0.1 stub, so an address in a fixture cannot reach
    // Mailgun even when `BASE_URL` points at staging. Without this the transport tests
    // would register recipient-less invitations off-local and assert nothing.
    savedMailSafe = setMailSafeTarget(true)
    // MAILGUN_BASE_URL always points at the stub — including in the "not configured"
    // case, which is exactly how a stray send gets caught instead of leaving the host.
    backend = await startBackend({ MAILGUN_BASE_URL: stub.baseUrl, ...mailEnv })
    harnessCtx = await playwrightRequest.newContext({ baseURL: backend.baseUrl })
    const login = await harnessCtx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status(), 'harness admin login (did seed.mjs run?)').toBe(200)
    const adminToken = (await login.json()).token

    await fn({ stub, backend, ctx: harnessCtx, adminToken })
  } finally {
    if (savedMailSafe !== undefined) setMailSafeTarget(savedMailSafe)
    await harnessCtx?.dispose()
    await backend?.stop()
    await stub.stop()
  }
}

// Extract the multipart/form-data fields from a stub-captured request:
// boundary/`Content-Disposition: form-data; name="…"` parsing over the raw UTF-8
// capture, exactly as 08 §UC-EM-005 item 1 prescribes. Returns { name: value }.
export function multipartFields(call) {
  const boundaryMatch = call.contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)
  expect(boundaryMatch, `a multipart boundary in ${call.contentType}`).toBeTruthy()
  const boundary = boundaryMatch[1] || boundaryMatch[2]
  const fields = {}
  for (const part of call.body.split(`--${boundary}`)) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const name = part.slice(0, headerEnd).match(/Content-Disposition:[^\r\n]*\bname="([^"]*)"/i)?.[1]
    if (name === undefined) continue
    // The value runs to the CRLF that precedes the next boundary delimiter.
    fields[name] = part.slice(headerEnd + 4).replace(/\r\n$/, '')
  }
  return fields
}

// Drive `sendMail()` directly against a stub: a child process imports the mailer with
// MAILGUN_* pointing at 127.0.0.1 (the fake key, the stub base URL — same safety model
// as `withMailHarness`, so nothing here can ever reach real Mailgun) and prints the
// result object. `payload` travels as JSON in an env var, so Slovak diacritics and
// angle brackets never meet shell quoting.
export async function sendViaMailer(stub, payload) {
  const script = [
    "const { sendMail } = await import(process.env.MAILER_URL)",
    "const result = await sendMail(JSON.parse(process.env.MAIL_PAYLOAD))",
    "process.stdout.write('\\nSENDMAIL_RESULT:' + JSON.stringify(result) + '\\n')",
  ].join('\n')

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      MAILER_URL: pathToFileURL(MAILER_ENTRY).href,
      MAIL_PAYLOAD: JSON.stringify(payload),
      MAILGUN_API_KEY: FAKE_MAILGUN_KEY,
      MAILGUN_DOMAIN: STUB_MAILGUN_DOMAIN,
      MAILGUN_BASE_URL: stub.baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (c) => { output += c })
  child.stderr.on('data', (c) => { output += c })
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))

  const match = output.match(/SENDMAIL_RESULT:(.*)/)
  // Rule 3 of the mailer (it never throws) makes a non-zero exit or a missing result
  // line a failure in its own right, not just a broken harness.
  if (exitCode !== 0 || !match) {
    throw new Error(`sendMail child failed (exit ${exitCode}) — did sendMail throw?\n${output}`)
  }
  return JSON.parse(match[1])
}

// Render through `helpers/email-templates.js` in a child process and (optionally) send
// the result through the real `sendMail()` to the stub — so the html is asserted from
// the STUB-CAPTURED multipart body (08 §UC-EM-005 item 1's prescription), not from a
// unit runner this repo does not have. The one thing a captured body cannot prove is
// `===`-identity of the text pass-through (a string survives multipart byte-exact but
// identity is an in-process property), so the child checks `rendered.text ===
// input.text` itself and reports the boolean.
//
// Returns `{ ok: true, textIdentical, htmlLength, sendResult? }` or
// `{ ok: false, threw: <message> }` when `renderEmail` threw — throwing is the one
// acceptable failure mode at this layer (08 §UC-EM-002), so it is a first-class result
// here, never a harness error.
// `sparse` — an index (or array of indices) into `input.blocks` to turn into a GENUINE
// ARRAY HOLE. ⚠ It has to be done HERE, inside the child, because the payload crosses a
// JSON boundary: `JSON.stringify([,])` is `"[null]"`, so a hole written on the test side
// arrives as a `null` entry — a different value, caught by a different check, and the
// reason ML-T2's first attempt at pinning the sparse-array fix was vacuous. `delete
// arr[i]` leaves length intact and the slot genuinely absent, which is what `.map()`
// skips and `blocks[i]` reports as `undefined`.
export async function renderViaTemplates(stub, { input, send, sparse }) {
  const script = [
    "const { renderEmail } = await import(process.env.TEMPLATES_URL)",
    "const payload = JSON.parse(process.env.RENDER_PAYLOAD)",
    "if (payload.sparse !== undefined && payload.sparse !== null) {",
    "  const holes = Array.isArray(payload.sparse) ? payload.sparse : [payload.sparse]",
    "  for (const i of holes) delete payload.input.blocks[i]",
    "}",
    "let out",
    "try {",
    "  const rendered = renderEmail(payload.input)",
    "  out = { ok: true, textIdentical: rendered.text === payload.input.text, htmlLength: rendered.html.length }",
    "  if (payload.send) {",
    "    const { sendMail } = await import(process.env.MAILER_URL)",
    "    out.sendResult = await sendMail({ ...payload.send, text: rendered.text, html: rendered.html })",
    "  }",
    "} catch (e) {",
    "  out = { ok: false, threw: String((e && e.message) || e) }",
    "}",
    "process.stdout.write('\\nRENDER_RESULT:' + JSON.stringify(out) + '\\n')",
  ].join('\n')

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      TEMPLATES_URL: pathToFileURL(TEMPLATES_ENTRY).href,
      MAILER_URL: pathToFileURL(MAILER_ENTRY).href,
      RENDER_PAYLOAD: JSON.stringify({ input, send, sparse }),
      MAILGUN_API_KEY: FAKE_MAILGUN_KEY,
      MAILGUN_DOMAIN: STUB_MAILGUN_DOMAIN,
      MAILGUN_BASE_URL: stub.baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (c) => { output += c })
  child.stderr.on('data', (c) => { output += c })
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))

  const match = output.match(/RENDER_RESULT:(.*)/)
  if (exitCode !== 0 || !match) {
    throw new Error(`renderEmail child failed (exit ${exitCode})\n${output}`)
  }
  return JSON.parse(match[1])
}
