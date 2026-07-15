import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// SEC-H3 (audit §M2): voucher generation must reject out-of-range discounts.
// applied_discount = 100 would divide by zero in the retail-total calc.
test.describe('Voucher discount bounds (SEC-H3)', () => {
  let ctx, adminToken

  test.beforeAll(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
  })
  test.afterAll(async () => { await ctx?.dispose() })

  const bad = [
    { label: 'applied_discount = 100 (div-by-zero)', supplier_discount: 100, applied_discount: 100 },
    { label: 'supplier_discount > 100', supplier_discount: 120, applied_discount: 30 },
    { label: 'negative applied_discount', supplier_discount: 40, applied_discount: -5 },
    { label: 'non-numeric discount', supplier_discount: '40', applied_discount: 30 },
  ]

  for (const c of bad) {
    test(`rejects ${c.label}`, async () => {
      const res = await ctx.post('/api/vouchers/generate', {
        headers: { 'X-Admin-Token': adminToken },
        data: { source_cycle_id: 1, friend_ids: [1], supplier_discount: c.supplier_discount, applied_discount: c.applied_discount },
      })
      expect(res.status(), `${c.label} must be rejected`).toBe(400)
    })
  }
})
