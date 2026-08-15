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
