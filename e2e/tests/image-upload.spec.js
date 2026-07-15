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
