import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, CYCLE_NAME } from '../fixtures.js'

// SEC-H2 (audit §M1): image uploads are validated by magic bytes, not the
// client-supplied mimetype, so an SVG/HTML payload can't be stored as an image.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

test.describe('Image upload validation', () => {
  let ctx, adminToken, productId

  test.beforeAll(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
    const cycles = await (await ctx.get('/api/cycles', { headers: { 'X-Admin-Token': adminToken } })).json()
    const cycle = cycles.find((c) => c.name === CYCLE_NAME) || cycles[0]
    const product = await (await ctx.post('/api/products', {
      headers: { 'X-Admin-Token': adminToken },
      data: {
        cycle_id: cycle.id, name: 'Img probe',
        description1: null, description2: null, roast_type: null, purpose: null,
        price_150g: null, price_200g: null, price_250g: null, price_500g: null,
        price_1kg: null, price_20pc5g: null, roastery: null, stock_limit_g: null,
      },
    })).json()
    productId = product.id
  })

  test.afterAll(async () => { await ctx?.dispose() })

  test('rejects an SVG/HTML payload labelled image/png', async () => {
    const res = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { image: { name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload=alert(1)></svg>') } },
    })
    expect(res.status(), 'a non-image labelled image/png must be rejected').toBe(400)
  })

  test('rejects a data:text/html value in the body', async () => {
    const res = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      data: { image: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' },
    })
    expect(res.status()).toBe(400)
  })

  test('accepts a real PNG', async () => {
    const res = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { image: { name: 'ok.png', mimeType: 'image/png', buffer: PNG_BYTES } },
    })
    expect(res.status()).toBe(200)
    const updated = await res.json()
    expect(updated.image).toMatch(/^data:image\/png;base64,/)
  })
})

// FUP-T6 — an oversized upload is a CLIENT mistake, so it must not be a 500.
//
// multer's MulterError carries `code`/`field` but no `status`, so FUP-T3's
// "preserve a 4xx the error already carries" rule in the global handler could not
// see it: every upload past the 5 MB cap answered 500 and logged a full stack.
// The translation lives in the global handler (backend/src/index.js) alongside
// that rule, so BOTH multer routers are covered by one fix — which is why this
// block exercises /api/products AND /api/bakery-products.
const OVERSIZED_PNG = Buffer.concat([PNG_BYTES, Buffer.alloc(6 * 1024 * 1024)]) // > the 5 MB cap
const NEAR_LIMIT_PNG = Buffer.concat([PNG_BYTES, Buffer.alloc(1024 * 1024)]) // comfortably under it

// The client must never see multer's own text, nor any hint of the internals.
function expectNoLeak(body) {
  expect(Object.keys(body).sort(), 'the error body carries nothing but `error`').toEqual(['error'])
  expect(body.error).not.toMatch(/File too large|Unexpected field|LIMIT_|multer|Multer|\.js/)
  expect(body.error, 'Slovak, unaccented, from CLIENT_ERROR_MESSAGES').toMatch(/^[\x20-\x7E]+$/)
}

test.describe('Upload size limit (FUP-T6)', () => {
  let ctx, adminToken, cycleId, productId, bakeryProductId

  test.beforeAll(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
    const cycles = await (await ctx.get('/api/cycles', { headers: { 'X-Admin-Token': adminToken } })).json()
    const cycle = cycles.find((c) => c.name === CYCLE_NAME) || cycles[0]
    cycleId = cycle.id
    const product = await (await ctx.post('/api/products', {
      headers: { 'X-Admin-Token': adminToken },
      data: {
        cycle_id: cycleId, name: 'Size probe',
        description1: null, description2: null, roast_type: null, purpose: null,
        price_150g: null, price_200g: null, price_250g: null, price_500g: null,
        price_1kg: null, price_20pc5g: null, roastery: null, stock_limit_g: null,
      },
    })).json()
    productId = product.id
    const bakery = await (await ctx.post('/api/bakery-products', {
      headers: { 'X-Admin-Token': adminToken },
      data: { name: 'Size probe bakery', price: 5 },
    })).json()
    bakeryProductId = bakery.id
  })

  test.afterAll(async () => { await ctx?.dispose() })

  test('an oversized image on an existing product is 413, not 500', async () => {
    const res = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { image: { name: 'huge.png', mimeType: 'image/png', buffer: OVERSIZED_PNG } },
    })
    expect(res.status(), 'LIMIT_FILE_SIZE is a payload-too-large, not a server fault').toBe(413)
    expectNoLeak(await res.json())
  })

  test('an oversized image on product creation is 413, not 500', async () => {
    const res = await ctx.post('/api/products', {
      headers: { 'X-Admin-Token': adminToken },
      multipart: {
        cycle_id: String(cycleId),
        name: 'Oversized create',
        image: { name: 'huge.png', mimeType: 'image/png', buffer: OVERSIZED_PNG },
      },
    })
    expect(res.status()).toBe(413)
    expectNoLeak(await res.json())
  })

  test('an oversized CSV import is 413, not 500', async () => {
    const res = await ctx.post(`/api/products/import/${cycleId}`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { file: { name: 'huge.csv', mimeType: 'text/csv', buffer: Buffer.alloc(6 * 1024 * 1024, 'a') } },
    })
    expect(res.status(), 'the cap is on upload.single, whatever the field is called').toBe(413)
    expectNoLeak(await res.json())
  })

  test('an oversized bakery-product image is 413 too (the second multer router)', async () => {
    const res = await ctx.post(`/api/bakery-products/${bakeryProductId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { image: { name: 'huge.png', mimeType: 'image/png', buffer: OVERSIZED_PNG } },
    })
    expect(res.status()).toBe(413)
    expectNoLeak(await res.json())
  })

  test('an unexpected file field is 400, not 500', async () => {
    const res = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { notTheImageField: { name: 'ok.png', mimeType: 'image/png', buffer: PNG_BYTES } },
    })
    expect(res.status(), 'LIMIT_UNEXPECTED_FILE is a plain bad request').toBe(400)
    expectNoLeak(await res.json())
  })

  test('the refused upload leaves the stored image untouched', async () => {
    const ok = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { image: { name: 'ok.png', mimeType: 'image/png', buffer: PNG_BYTES } },
    })
    expect(ok.status()).toBe(200)
    const before = (await ok.json()).image

    const refused = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { image: { name: 'huge.png', mimeType: 'image/png', buffer: OVERSIZED_PNG } },
    })
    expect(refused.status()).toBe(413)

    const after = await (await ctx.get(`/api/products/${productId}`)).json()
    expect(after.image, 'a rejected upload must not clear the existing image').toBe(before)
  })

  // Counter-assertions: the fix must not pass by breaking uploads or by turning
  // an auth boundary into a size verdict.
  test('a within-limit upload of a real file still succeeds', async () => {
    const res = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { image: { name: 'big-enough.png', mimeType: 'image/png', buffer: NEAR_LIMIT_PNG } },
    })
    expect(res.status(), '1 MB is well inside the 5 MB cap').toBe(200)
    expect((await res.json()).image).toMatch(/^data:image\/png;base64,/)
  })

  // ⚠ Every upload route, not just one. "The guard runs before multer" is a
  // property of each ROUTE DEFINITION, so one sampled route cannot protect it:
  // a new route that put `upload.single` first would leak a size verdict to an
  // anonymous caller with the suite still green. The two bakery routes are the
  // fragile case — they carry no inline `requireAdmin` at all and are protected
  // only by the `requireAdmin` on their MOUNT (`index.js`), so a router mounted
  // bare would silently lose it. (FUP-T6 review, minor 2.)
  for (const [label, path, field] of [
    ['products :id/image', () => `/api/products/${productId}/image`, 'image'],
    ['products create', () => '/api/products', 'image'],
    ['products CSV import', () => `/api/products/import/${cycleId}`, 'file'],
    ['bakery create', () => '/api/bakery-products', 'image'],
    ['bakery :id/image', () => `/api/bakery-products/${bakeryProductId}/image`, 'image'],
  ]) {
    test(`an anonymous oversized upload is still 401, not 413 — ${label}`, async () => {
      const res = await ctx.post(path(), {
        multipart: {
          [field]: { name: 'huge.png', mimeType: 'image/png', buffer: OVERSIZED_PNG },
        },
      })
      expect(res.status(), 'the admin guard runs before multer — the boundary is unmoved').toBe(401)
    })
  }
})

// FUP-T7 — malformed or ABORTED multipart is a client fault too.
//
// multer raises PLAIN `Error`s (not `MulterError`) for a body busboy cannot
// parse — a `multipart/form-data` Content-Type with no boundary, a truncated
// form, and the ordinary case of the client hanging up mid-upload. They carry
// neither `status` nor `code`, so FUP-T3's "preserve a 4xx" rule and FUP-T6's
// `MulterError` mapping were both blind to them: every one answered 500 and
// logged a full stack.
//
// ⚠ The fix is deliberately NOT a match on busboy's message strings (a library
// copy-edit would silently restore the 500s). `helpers/multipart.js` wraps the
// multer middleware and tags the error by STRUCTURE — which middleware failed,
// and what kind of Error object it is — so these assertions hold across any
// reword upstream.
const RAW_BOUNDARY = '----fupT7Boundary'

// A complete, well-formed HTTP request whose multipart BODY stops in the middle
// of a part: busboy reaches end-of-stream still waiting for the closing
// boundary ("Unexpected end of form" today).
const TRUNCATED_FORM = Buffer.from(
  `--${RAW_BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="image"; filename="a.png"\r\n' +
  'Content-Type: image/png\r\n\r\n' +
  'PNGPNGPNG\r\n',
  'latin1'
)

test.describe('Malformed or aborted multipart (FUP-T7)', () => {
  let ctx, adminToken, cycleId, productId, bakeryProductId

  test.beforeAll(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
    const cycles = await (await ctx.get('/api/cycles', { headers: { 'X-Admin-Token': adminToken } })).json()
    const cycle = cycles.find((c) => c.name === CYCLE_NAME) || cycles[0]
    cycleId = cycle.id
    const product = await (await ctx.post('/api/products', {
      headers: { 'X-Admin-Token': adminToken },
      data: {
        cycle_id: cycleId, name: 'Multipart probe',
        description1: null, description2: null, roast_type: null, purpose: null,
        price_150g: null, price_200g: null, price_250g: null, price_500g: null,
        price_1kg: null, price_20pc5g: null, roastery: null, stock_limit_g: null,
      },
    })).json()
    productId = product.id
    const bakery = await (await ctx.post('/api/bakery-products', {
      headers: { 'X-Admin-Token': adminToken },
      data: { name: 'Multipart probe bakery', price: 5 },
    })).json()
    bakeryProductId = bakery.id
  })

  test.afterAll(async () => { await ctx?.dispose() })

  test('a multipart Content-Type with no boundary is 400, not 500', async () => {
    const res = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'multipart/form-data' },
      data: Buffer.from('there is no boundary in the content type'),
    })
    expect(res.status(), 'busboy cannot even start — a malformed request, not a server fault').toBe(400)
    expectNoLeak(await res.json())
  })

  test('a truncated multipart body is 400, not 500', async () => {
    const res = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken, 'Content-Type': `multipart/form-data; boundary=${RAW_BOUNDARY}` },
      data: TRUNCATED_FORM,
    })
    expect(res.status(), 'the form never closed — the client sent a bad body').toBe(400)
    expectNoLeak(await res.json())
  })

  test('the second multer router answers a malformed multipart the same way', async () => {
    const res = await ctx.post(`/api/bakery-products/${bakeryProductId}/image`, {
      headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'multipart/form-data' },
      data: Buffer.from('no boundary here either'),
    })
    expect(res.status(), 'the translation is on the shared upload helper, not one router').toBe(400)
    expectNoLeak(await res.json())
  })

  test('a malformed multipart leaves the stored image untouched', async () => {
    const ok = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { image: { name: 'ok.png', mimeType: 'image/png', buffer: PNG_BYTES } },
    })
    expect(ok.status()).toBe(200)
    const before = (await ok.json()).image

    const refused = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken, 'Content-Type': `multipart/form-data; boundary=${RAW_BOUNDARY}` },
      data: TRUNCATED_FORM,
    })
    expect(refused.status()).toBe(400)

    const after = await (await ctx.get(`/api/products/${productId}`)).json()
    expect(after.image, 'a refused parse must not clear the existing image').toBe(before)
  })

  // ── Counter-assertions ────────────────────────────────────────────────────
  // The wrapper must not buy its 400s by blanket-tagging everything that comes
  // out of an upload route.

  test('a genuine server fault BEHIND the parser is still 500', async () => {
    // The multipart parse succeeds; the INSERT then violates a foreign key.
    //
    // ⚠ Read this for what it proves, not for what it looks like it proves. The
    // manufactured fault is a `SqliteError` — an Error SUBCLASS — so gate 4
    // would leave it at 500 even under a mis-scoped wrapper that tagged every
    // downstream error. This test pins "the FK path is still 500"; it does NOT
    // constrain the scoping. The scoping is sound STRUCTURALLY rather than by
    // test: the wrapper's callback is multer's `next`, a different closure from
    // the route's own `next`, so a handler fault cannot re-enter it (confirmed
    // from the fault's stack: products.js ← Layer.handle ← next(route.js) ←
    // multipart.js). No e2e can reach that distinction. (FUP-T7 review, minor 2.)
    const res = await ctx.post('/api/products', {
      headers: { 'X-Admin-Token': adminToken },
      multipart: {
        cycle_id: '999999',
        name: 'FK fault probe',
        image: { name: 'ok.png', mimeType: 'image/png', buffer: PNG_BYTES },
      },
    })
    expect(res.status(), 'only the PARSE is client-attributable, never the handler').toBe(500)
  })

  test('a well-formed multipart upload still succeeds', async () => {
    const res = await ctx.post(`/api/products/${productId}/image`, {
      headers: { 'X-Admin-Token': adminToken },
      multipart: { image: { name: 'ok.png', mimeType: 'image/png', buffer: PNG_BYTES } },
    })
    expect(res.status(), 'the wrapper is transparent on the happy path').toBe(200)
    expect((await res.json()).image).toMatch(/^data:image\/png;base64,/)
  })

  // ⚠ Same reasoning as FUP-T6's loop: "the admin guard runs before multer" is a
  // property of each ROUTE DEFINITION, so every upload route has to say it. The
  // two bakery routes carry no inline `requireAdmin` and rely on their mount.
  for (const [label, path] of [
    ['products :id/image', () => `/api/products/${productId}/image`],
    ['products create', () => '/api/products'],
    ['products CSV import', () => `/api/products/import/${cycleId}`],
    ['bakery create', () => '/api/bakery-products'],
    ['bakery :id/image', () => `/api/bakery-products/${bakeryProductId}/image`],
  ]) {
    test(`an anonymous malformed multipart is still 401, not 400 — ${label}`, async () => {
      const res = await ctx.post(path(), {
        headers: { 'Content-Type': 'multipart/form-data' },
        data: Buffer.from('no boundary'),
      })
      expect(res.status(), 'the guard runs before the parser — the boundary is unmoved').toBe(401)
    })
  }
})

// ── The log half of FUP-T3/T6/T7, and the only way to see the ABORT case ──────
//
// Two of the three decisions this chain rests on are invisible over HTTP:
//   • a client-triggerable branch must NOT log a stack (FUP-T3) — a remotely
//     triggerable stack per hit is a free log-flood; and
//   • a request the client ABORTS mid-upload has no reader left, so its verdict
//     exists only in the log. (The 400 the transport returns on a half-close is
//     Node's own connection-error response, not ours — asserting it would prove
//     nothing about this fix.)
//
// So this block reads the server's stdout. It self-skips unless started with
// `SERVER_LOG=<path to the backend's log>`, exactly as the DB_PATH-gated specs
// do; a normal run reports it as skipped. Run the gate with SERVER_LOG set to
// exercise it. ⚠ Requires --workers=1 (it reads a shared, appended file) and a
// local HTTP target (it opens a raw socket).
const SERVER_LOG = process.env.SERVER_LOG
const STACK_FRAME = /^\s+at\s/m

test.describe('Error-handler logging (FUP-T7)', () => {
  test.skip(!SERVER_LOG, 'set SERVER_LOG=<backend log path> to exercise the log assertions')

  // ⚠ --workers=1 is a REQUIREMENT here, not a preference, and it used to be only
  // a comment. `fullyParallel: false` still lets Playwright run FILES in parallel
  // at the default ceil(cpus/2), so on any box with >2 cores another file's
  // genuine 500 can land inside `appended()`'s before/after window and redden the
  // stack assertions — or, worse, mask a real one. Assert it so the requirement
  // fails loudly instead of flaking. (FUP-T7 review, minor 3.)
  test.beforeAll(() => {
    expect(
      test.info().config.workers,
      'the log assertions read a shared appended file — run this spec with --workers=1',
    ).toBe(1)
  })

  let ctx, adminToken, productId, fs, net, target

  async function appended(run) {
    const before = (await fs.promises.stat(SERVER_LOG)).size
    await run()
    // The warn/error line is written on the tick after the response; give the
    // aborted case room for its 'close' event too.
    await new Promise((r) => setTimeout(r, 400))
    const fh = await fs.promises.open(SERVER_LOG, 'r')
    const size = (await fh.stat()).size
    const buf = Buffer.alloc(Math.max(0, size - before))
    if (buf.length) await fh.read(buf, 0, buf.length, before)
    await fh.close()
    return buf.toString('utf8')
  }

  test.beforeAll(async () => {
    fs = await import('node:fs')
    net = await import('node:net')
    target = new URL(process.env.BASE_URL || 'http://localhost:3997')
    ctx = await playwrightRequest.newContext({ baseURL: target.origin })
    adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
    const cycles = await (await ctx.get('/api/cycles', { headers: { 'X-Admin-Token': adminToken } })).json()
    const cycle = cycles.find((c) => c.name === CYCLE_NAME) || cycles[0]
    productId = (await (await ctx.post('/api/products', {
      headers: { 'X-Admin-Token': adminToken },
      data: { cycle_id: cycle.id, name: 'Log probe' },
    })).json()).id
  })

  test.afterAll(async () => { await ctx?.dispose() })

  test('a malformed multipart logs one compact line and NO stack', async () => {
    const log = await appended(async () => {
      const res = await ctx.post(`/api/products/${productId}/image`, {
        headers: { 'X-Admin-Token': adminToken, 'Content-Type': `multipart/form-data; boundary=${RAW_BOUNDARY}` },
        data: TRUNCATED_FORM,
      })
      expect(res.status()).toBe(400)
    })
    expect(log, 'the compact FUP-T3 warn line — this is what makes the check below non-vacuous')
      .toContain(`Chybna poziadavka: POST /api/products/${productId}/image`)
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from inside the parser').not.toMatch(/node_modules\/(multer|busboy)/)
  })

  test('an upload the client aborts mid-flight logs no stack either', async () => {
    // The ordinary failure this row is really about: an admin's photo upload
    // drops on a flaky connection. Nobody is left to receive a status, so the
    // whole fix is the log line.
    const log = await appended(async () => {
      await new Promise((resolve) => {
        const sock = net.connect(Number(target.port || 80), target.hostname, () => {
          sock.write(
            `POST /api/products/${productId}/image HTTP/1.1\r\n` +
            `Host: ${target.host}\r\n` +
            `X-Admin-Token: ${adminToken}\r\n` +
            `Content-Type: multipart/form-data; boundary=${RAW_BOUNDARY}\r\n` +
            'Content-Length: 200000\r\n\r\n' +
            `--${RAW_BOUNDARY}\r\n` +
            'Content-Disposition: form-data; name="image"; filename="a.png"\r\n' +
            'Content-Type: image/png\r\n\r\n' +
            'A'.repeat(1000)
          )
          setTimeout(() => { sock.destroy(); resolve() }, 250)
        })
        sock.on('error', () => resolve())
      })
    })
    expect(log, 'the abort is reported as a bad request, not a server fault')
      .toContain(`Chybna poziadavka: POST /api/products/${productId}/image`)
    expect(log, 'a dropped connection must not cost a stack per hit').not.toMatch(STACK_FRAME)

    // …and the server is unharmed by having answered a socket that is gone.
    const health = await ctx.get('/api/cycles', { headers: { 'X-Admin-Token': adminToken } })
    expect(health.status()).toBe(200)
  })

  // ⚠ Counter-assertion. Without it the whole block could be satisfied by
  // deleting `console.error(err.stack)` from the 500 branch, which would trade a
  // log-flood for blindness to real faults.
  test('a genuine server fault still logs its full stack', async () => {
    const log = await appended(async () => {
      // A disallowed Origin is rejected with a bare Error and no status — the
      // 500 branch, reachable without touching the upload routes at all.
      const res = await ctx.get('/api/cycles', { headers: { Origin: 'http://not-an-allowed-origin.example' } })
      expect(res.status()).toBe(500)
    })
    expect(log, 'the 500 branch keeps its stack').toMatch(STACK_FRAME)
  })
})
