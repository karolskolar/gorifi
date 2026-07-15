import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, CYCLE_NAME } from '../fixtures.js'

// SEC-H1 (audit §H6): the product image-from-url endpoint fetches a client URL
// server-side. It must refuse internal / non-public / non-http targets so it
// can't be used for SSRF (e.g. the cloud metadata endpoint).
test.describe('SSRF guard on image-from-url', () => {
  let ctx, adminToken, productId

  test.beforeAll(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
    const cycles = await (await ctx.get('/api/cycles', { headers: { 'X-Admin-Token': adminToken } })).json()
    const cycle = cycles.find((c) => c.name === CYCLE_NAME) || cycles[0]
    // POST /products binds every optional column, so send explicit nulls
    // (omitting them makes sql.js throw on an undefined bind — unrelated to SSRF).
    const product = await (await ctx.post('/api/products', {
      headers: { 'X-Admin-Token': adminToken },
      data: {
        cycle_id: cycle.id, name: 'SSRF probe',
        description1: null, description2: null, roast_type: null, purpose: null,
        price_150g: null, price_200g: null, price_250g: null, price_500g: null,
        price_1kg: null, price_20pc5g: null, roastery: null, stock_limit_g: null,
      },
    })).json()
    productId = product.id
    expect(productId, 'product created for SSRF probe').toBeTruthy()
  })

  test.afterAll(async () => { await ctx?.dispose() })

  const blocked = [
    { label: 'cloud metadata (link-local)', url: 'http://169.254.169.254/latest/meta-data/' },
    { label: 'loopback', url: 'http://127.0.0.1:80/' },
    { label: 'private range', url: 'http://10.0.0.1/' },
    { label: 'non-http scheme', url: 'file:///etc/passwd' },
  ]

  for (const c of blocked) {
    test(`rejects ${c.label}`, async () => {
      const res = await ctx.post(`/api/products/${productId}/image-from-url`, {
        headers: { 'X-Admin-Token': adminToken },
        data: { url: c.url },
      })
      expect(res.status(), `${c.url} must be rejected`).toBe(400)
    })
  }
})
