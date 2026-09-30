// 2026-09-30 prod incident: behind Nginx Proxy Manager → the LXC nginx, every
// request reaches Node with X-Forwarded-For: "<client>, <NPM ip>". With
// `trust proxy` = 1 the limiter keyed EVERY visitor on the NPM ip, so all
// friends shared one 20-per-15-min login bucket and got „Príliš veľa pokusov".
//
// The gate server is hit directly (the socket peer is 127.0.0.1, standing in
// for the LXC nginx), so sending the header NPM would forward reproduces the
// production chain exactly. Works at ANY limiter maximum: it reads the
// `RateLimit: remaining=` counter instead of waiting for a 429.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NPM_IP = '192.168.100.103'

// A fresh, unique TEST-NET-2 address per call, so each run starts on untouched buckets.
let seq = Math.floor(Math.random() * 200)
const clientIp = () => `198.51.100.${(seq++ % 250) + 1}`
const salt = Math.floor(Math.random() * 250) + 1

async function remaining(request, xff) {
  const res = await request.post('/api/friends/auth', {
    headers: { 'X-Forwarded-For': xff },
    data: {},
  })
  const header = res.headers()['ratelimit'] || ''
  const m = header.match(/remaining=(\d+)/)
  expect(m, `RateLimit header present (got "${header}", status ${res.status()})`).not.toBeNull()
  return Number(m[1])
}

test.describe('rate limiting keys on the REAL client behind two proxies', () => {
  test('two clients behind the same NPM hop get SEPARATE buckets', async ({ request }) => {
    const a = `203.0.113.${salt}`
    const b = clientIp()
    const first = await remaining(request, `${a}, ${NPM_IP}`)
    const again = await remaining(request, `${a}, ${NPM_IP}`)
    expect(again, 'the same client really is counted').toBe(first - 1)
    const other = await remaining(request, `${b}, ${NPM_IP}`)
    // With trust proxy = 1 both keyed on NPM_IP ⇒ other === again - 1.
    expect(other, 'a different client does not spend the first one\'s budget').toBeGreaterThan(again)
  })

  test('a forged leftmost X-Forwarded-For entry does not buy a fresh bucket', async ({ request }) => {
    const real = clientIp()
    const first = await remaining(request, `${real}, ${NPM_IP}`)
    // The client sends its own XFF; NPM appends the real address, nginx appends NPM's.
    const forged = await remaining(request, `10.9.8.${salt}, ${real}, ${NPM_IP}`)
    expect(forged, 'still the real client\'s bucket').toBe(first - 1)
  })

  test('index.js trusts two hops by default', () => {
    const src = readFileSync(join(REPO_ROOT, 'backend', 'src', 'index.js'), 'utf8')
    expect(src).toMatch(/app\.set\('trust proxy', parseInt\(process\.env\.TRUST_PROXY_HOPS, 10\) \|\| 2\)/)
  })
})
