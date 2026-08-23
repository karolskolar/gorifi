// PC-T10 — 12 §UC-PC-014 (spec obligations enumerated in §UC-PC-011 item 6):
// product images leave the database. Uploads become content-hash files
// (sha256 hex, first 32 chars, extension from SNIFFED magic bytes) in an
// uploads dir next to the SQLite file, served by the PUBLIC
// GET /api/images/:filename with an immutable cache header; the `image`
// columns hold the URL path; legacy base64 is converted once by the admin's
// POST /api/coffee-products/convert-images.
//
// ⚠ GET /api/images is DELIBERATELY public (friend and guest pages render it;
// exposure equivalent to the already-public products listing that shipped the
// same bytes inline) — the anonymous-200 pin lives HERE, not in
// api-security.spec.js's ADMIN_ENDPOINTS.
//
// ⚠ After PC-T10 the write paths never store base64, so the conversion
// fixtures are direct DB seeds — that half self-skips without DB_PATH (house
// convention). Uploads land next to the test DB_PATH, so no fixture cleanup
// problem arises.

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'

let ctx
let adminToken
const admin = () => ({ 'X-Admin-Token': adminToken })

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login must succeed against a seeded target').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => {
  await ctx?.dispose()
})

// ── fixtures ──────────────────────────────────────────────────────────────────

const uniq = () => `PCT10 ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`

// Two REAL-magic-byte PNGs with different content, so content-hash dedupe and
// cache busting are both provable. (The sniff reads magic bytes; the API tests
// never need a decodable raster.)
const PNG_A = Buffer.from('iVBORw0KGgoAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xb1, 0xb2, 0xb3, 0xb4])
const dataUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`

const URL_RE = /^\/api\/images\/[a-f0-9]{32}\.png$/
const IMMUTABLE = 'public, max-age=31536000, immutable'

function openDb() {
  return new DatabaseSync(DB_PATH)
}

function csvFor(rows) {
  const header = 'Name,Description1,Popis2,Roast,Purpose,Price250g,Price1kg'
  const lines = rows.map((r) =>
    [r.name ?? '', r.desc1 ?? '', r.desc2 ?? '', r.roast ?? '', r.purpose ?? '', r.p250 ?? '', r.p1kg ?? '']
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(',')
  )
  return [header, ...lines].join('\n') + '\n'
}

async function importOne(name) {
  const res = await ctx.post('/api/coffee-products/import', {
    headers: admin(),
    multipart: { file: { name: 'catalog.csv', mimeType: 'text/csv', buffer: Buffer.from(csvFor([{ name, p250: '8,0' }]), 'utf8') } },
  })
  expect(res.status(), `import of ${name} must succeed`).toBe(201)
  const entry = (await res.json()).report.new.find((e) => e.name === name)
  expect(entry, `import must report ${name} as new`).toBeTruthy()
  return entry.catalog_id
}

function uploadCatalogImage(id, buffer) {
  return ctx.post(`/api/coffee-products/${id}/image`, {
    headers: admin(),
    multipart: { image: { name: 'kava.png', mimeType: 'image/png', buffer } },
  })
}

async function createCycle(data) {
  const res = await ctx.post('/api/cycles', { headers: admin(), data })
  expect(res.status(), 'cycle fixture must be creatable').toBe(201)
  return (await res.json()).id
}

function seedCycle(db, name, type = 'coffee', status = 'completed') {
  const r = db
    .prepare('INSERT INTO order_cycles (name, status, type, total_friends) VALUES (?, ?, ?, 0)')
    .run(name, status, type)
  return Number(r.lastInsertRowid)
}

function seedSnapshot(db, cycleId, f) {
  const r = db
    .prepare(
      `INSERT INTO products (cycle_id, name, price_250g, image, source_bakery_product_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(cycleId, f.name, f.price_250g ?? 8, f.image ?? null, f.source_bakery_product_id ?? null)
  return Number(r.lastInsertRowid)
}

function seedCatalog(db, f) {
  const r = db
    .prepare(
      `INSERT INTO coffee_products (name, normalized_name, roastery, price_250g, image, status)
       VALUES (?, ?, 'Goriffee', 8, ?, 'available')`
    )
    .run(f.name, f.name.toLowerCase(), f.image ?? null)
  return Number(r.lastInsertRowid)
}

let pct10Seq = 0
async function makeFriendSession(label) {
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  const suffix = `_${runId}${++pct10Seq}`
  const username = `pct10_${label}`.slice(0, 30 - suffix.length) + suffix
  const created = await ctx.post('/api/friends', { headers: admin(), data: { name: `PCT10 ${label} ${runId}` } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()
  expect((await ctx.put(`/api/friends/${friend.id}/admin-username`, { headers: admin(), data: { username } })).status()).toBe(200)
  expect((await ctx.put(`/api/friends/${friend.id}/reset-password`, { headers: admin(), data: { password: 'initPass1' } })).status()).toBe(200)
  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
  })
  expect(chg.status(), 'forced change cleared').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, auth: { Authorization: `Bearer ${token}` } }
}

// ── 1. upload → file → URL → served, with the caching contract ────────────────

test.describe('UC-PC-014 — upload/serve roundtrip', () => {
  test('multipart upload stores a content-hash URL; anonymous GET serves the exact bytes with the immutable cache header', async () => {
    const id = await importOne(`${uniq()} Fotka Multipart`)
    const up = await uploadCatalogImage(id, PNG_A)
    expect(up.status()).toBe(200)
    const url = (await up.json()).image
    expect(url, 'sha256-32 hex + sniffed extension').toMatch(URL_RE)

    // ⚠ Anonymous on purpose (no headers): friend and guest pages render this
    // URL — the deliberate-public pin, paired with the convert-images 401 below.
    const img = await ctx.get(url)
    expect(img.status(), 'anonymous GET must serve the image').toBe(200)
    expect(img.headers()['content-type']).toBe('image/png')
    expect(img.headers()['cache-control'], 'cache headers that actually cache').toBe(IMMUTABLE)
    expect((await img.body()).equals(PNG_A), 'the exact uploaded bytes').toBe(true)
  })

  test('body-base64 upload converts server-side (both catalog and snapshot writers); a plain URL body passes through', async () => {
    const id = await importOne(`${uniq()} Fotka Body`)
    const up = await ctx.post(`/api/coffee-products/${id}/image`, {
      headers: admin(), data: { image: dataUri(PNG_A) },
    })
    expect(up.status()).toBe(200)
    expect((await up.json()).image, 'base64 never enters the column again').toMatch(URL_RE)

    // The snapshot-level writer (products.js POST /:id/image), body-base64 form.
    const cycleId = await createCycle({ name: `${uniq()} body cyklus`, type: 'coffee' })
    const created = await ctx.post('/api/products', {
      headers: admin(), data: { cycle_id: cycleId, name: `${uniq()} Body Snap`, price_250g: '8' },
    })
    expect(created.status()).toBe(201)
    const snapId = (await created.json()).id
    const snapUp = await ctx.post(`/api/products/${snapId}/image`, {
      headers: admin(), data: { image: dataUri(PNG_B) },
    })
    expect(snapUp.status()).toBe(200)
    const snapUrl = (await snapUp.json()).image
    expect(snapUrl).toMatch(URL_RE)
    expect((await (await ctx.get(snapUrl)).body()).equals(PNG_B)).toBe(true)

    // A body value that is already a plain URL/path passes through verbatim
    // (a reference, not inline content — imageFromBody's contract survives).
    const ref = await ctx.post(`/api/products/${snapId}/image`, {
      headers: admin(), data: { image: 'https://example.com/x.png' },
    })
    expect(ref.status()).toBe(200)
    expect((await ref.json()).image).toBe('https://example.com/x.png')
  })

  test('the manual product POST (dual-store) stores the URL on the snapshot; identical bytes on the catalog dedupe to ONE file/URL', async () => {
    const cycleId = await createCycle({ name: `${uniq()} dual cyklus`, type: 'coffee' })
    const name = `${uniq()} Dual Foto`
    const created = await ctx.post('/api/products', {
      headers: admin(), data: { cycle_id: cycleId, name, price_250g: '8', image: dataUri(PNG_A) },
    })
    expect(created.status()).toBe(201)
    const snapUrl = (await created.json()).image
    expect(snapUrl, 'UC-PC-005 dual store now stores the URL').toMatch(URL_RE)

    // Same bytes uploaded anywhere else → the SAME url (content-hash dedupe).
    const otherId = await importOne(`${uniq()} Dedupe Ina`)
    const up = await uploadCatalogImage(otherId, PNG_A)
    expect((await up.json()).image, 'identical bytes dedupe to one file').toBe(snapUrl)

    // Different bytes → a DIFFERENT url (cache busting by construction).
    const up2 = await uploadCatalogImage(otherId, PNG_B)
    const url2 = (await up2.json()).image
    expect(url2).toMatch(URL_RE)
    expect(url2, 'a replaced photo gets a NEW filename ⇒ a new URL').not.toBe(snapUrl)
  })
})

// ── 2. the hostile-boundary filename validation ───────────────────────────────

test.describe('UC-PC-014 — GET /api/images filename validation', () => {
  for (const [label, path] of [
    ['encoded traversal', '/api/images/x%2F..%2Fdb.sqlite'],
    ['encoded dotdot to the DB file', '/api/images/..%2Fdatabase.sqlite'],
    ['dotdot without separator', '/api/images/..database.sqlite'],
    ['wrong extension (svg)', '/api/images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg'],
    ['uppercase hex', '/api/images/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.png'],
    ['hash too short', '/api/images/deadbeef.png'],
    ['hash too long', '/api/images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'],
    ['no extension', '/api/images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ]) {
    test(`${label} → 404`, async () => {
      const res = await ctx.get(path)
      expect(res.status(), 'anything not matching ^[a-f0-9]{32}\\.(png|jpg|gif|webp)$ is 404').toBe(404)
    })
  }

  test('a well-formed name whose file does not exist is 404 too', async () => {
    const res = await ctx.get('/api/images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png')
    expect(res.status()).toBe(404)
  })

  test('encoded traversal to the REAL DB file is 404 (the regex, not a lucky existsSync miss)', async () => {
    // ⚠ The uploads dir is a SIBLING of the SQLite file, so `../<db basename>`
    // resolves to a file that genuinely EXISTS — without the filename regex,
    // this request would serve the database. The generic traversal probes
    // above target names that happen not to exist; this one is the real pin.
    test.skip(!DB_PATH, NEEDS_DB)
    const basename = DB_PATH.split('/').pop()
    const res = await ctx.get(`/api/images/..%2F${encodeURIComponent(basename)}`)
    expect(res.status(), 'the strict regex forecloses traversal by construction').toBe(404)
  })
})

// ── 3. the one-time conversion ────────────────────────────────────────────────

test.describe('UC-PC-014 — POST /convert-images', () => {
  test('anonymous POST /convert-images is 401 while anonymous image GET is 200 (the deliberate-public pin)', async () => {
    const anon = await ctx.post('/api/coffee-products/convert-images')
    expect(anon.status(), 'the conversion is admin-only (whole-mount requireAdmin)').toBe(401)
    // The 200 half of the pin lives in the roundtrip test above (no auth headers).
  })

  test('converts seeded base64 in catalog AND historical coffee snapshots; idempotent; bakery untouched; listings carry no data:image', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = uniq()
    const db = openDb()
    let catId, coffeeCycleId, coffeeSnapId, bakeryCycleId, bakerySnapId
    const catBase64 = dataUri(PNG_A)
    const snapBase64 = dataUri(PNG_B)
    try {
      // Legacy rows can only be manufactured directly — the write paths never
      // store base64 any more (which is itself the property under test).
      catId = seedCatalog(db, { name: `${stem} legacy katalog`, image: catBase64 })
      coffeeCycleId = seedCycle(db, `${stem} legacy coffee`, 'coffee', 'open')
      coffeeSnapId = seedSnapshot(db, coffeeCycleId, { name: `${stem} legacy snap`, image: snapBase64 })
      bakeryCycleId = seedCycle(db, `${stem} legacy bakery`, 'bakery', 'open')
      bakerySnapId = seedSnapshot(db, bakeryCycleId, { name: `${stem} makovnik`, image: snapBase64 })
    } finally {
      db.close()
    }

    const run = await ctx.post('/api/coffee-products/convert-images', { headers: admin() })
    expect(run.status()).toBe(200)
    const report = await run.json()
    expect(report.converted_catalog, 'the seeded catalog row converts').toBeGreaterThanOrEqual(1)
    expect(report.converted_snapshots, 'the seeded coffee snapshot converts').toBeGreaterThanOrEqual(1)
    expect(report.bytes_freed, 'bytes_freed sums the removed base64 lengths')
      .toBeGreaterThanOrEqual(catBase64.length + snapBase64.length)
    expect(Array.isArray(report.skipped)).toBe(true)

    // Column state: URL values in the converted rows, bakery base64 UNTOUCHED.
    const db2 = openDb()
    let catRow, snapRow, bakeryRow
    try {
      catRow = db2.prepare('SELECT image FROM coffee_products WHERE id = ?').get(catId)
      snapRow = db2.prepare('SELECT image FROM products WHERE id = ?').get(coffeeSnapId)
      bakeryRow = db2.prepare('SELECT image FROM products WHERE id = ?').get(bakerySnapId)
    } finally {
      db2.close()
    }
    expect(catRow.image).toMatch(URL_RE)
    expect(snapRow.image).toMatch(URL_RE)
    expect(bakeryRow.image, 'bakery is out of scope — its base64 stays').toBe(snapBase64)

    // File-on-disk proof: the converted URLs serve the ORIGINAL bytes.
    expect((await (await ctx.get(catRow.image)).body()).equals(PNG_A)).toBe(true)
    expect((await (await ctx.get(snapRow.image)).body()).equals(PNG_B)).toBe(true)

    // The payload pin: the friend listing carries NO data:image substring and
    // still serves the image (URL values flow through the UC-PC-012 COALESCE
    // read path unchanged).
    const listing = await ctx.get(`/api/products/cycle/${coffeeCycleId}`)
    expect(listing.status()).toBe(200)
    const listingText = await listing.text()
    expect(listingText, 'the 13 MB payload pin').not.toContain('data:image')
    const listed = JSON.parse(listingText).find((p) => p.id === coffeeSnapId)
    expect(listed.image).toBe(snapRow.image)

    // The GUEST listing too (the hostile read surface).
    const host = await makeFriendSession('img')
    const link = await ctx.post(`/api/guest-links/cycle/${coffeeCycleId}`, { headers: host.auth })
    expect(link.status(), 'guest link create').toBe(201)
    const guestToken = (await link.json()).link.token
    const pub = await ctx.get(`/api/guest/${guestToken}`)
    expect(pub.status()).toBe(200)
    const pubText = await pub.text()
    expect(pubText, 'no base64 on the guest payload either').not.toContain('data:image')
    const guestProduct = JSON.parse(pubText).products.find((p) => p.id === coffeeSnapId)
    expect(guestProduct.image, 'the guest listing serves the URL').toBe(snapRow.image)

    // Idempotency: the second run converts NOTHING (URL rows don't match the
    // LIKE; permanently-skipped junk rows report as skipped, never converted).
    const again = await ctx.post('/api/coffee-products/convert-images', { headers: admin() })
    expect(again.status()).toBe(200)
    const second = await again.json()
    expect(second.converted_catalog, 'second run converts 0 catalog rows').toBe(0)
    expect(second.converted_snapshots, 'second run converts 0 snapshots').toBe(0)
    expect(second.bytes_freed).toBe(0)
  })

  test('an unparseable legacy value is SKIPPED and reported, never dropped', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = uniq()
    const junk = 'data:image/png;base64,THISISNOTANIMAGE'
    const db = openDb()
    let id
    try {
      id = seedCatalog(db, { name: `${stem} junk legacy`, image: junk })
    } finally {
      db.close()
    }

    const run = await ctx.post('/api/coffee-products/convert-images', { headers: admin() })
    expect(run.status()).toBe(200)
    const report = await run.json()
    const entry = report.skipped.find((s) => s.table === 'coffee_products' && s.id === id)
    expect(entry, 'the junk row is reported in skipped').toBeTruthy()

    const db2 = openDb()
    try {
      expect(
        db2.prepare('SELECT image FROM coffee_products WHERE id = ?').get(id).image,
        'skipped means the column keeps its old value — never dropped'
      ).toBe(junk)
    } finally {
      db2.close()
    }
  })

  // ⚠ LAST in the file on purpose: there is exactly ONE admin token app-wide
  // (admin.js INSERT OR REPLACE), so this UI login invalidates the API token
  // the earlier tests minted in beforeAll. The test adopts the browser's token
  // for its own API calls (the house rule from module 07's harness notes).
  test('the AdminCatalog action runs the conversion and renders the report counts', async ({ page }) => {
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-tab-migrate').click()
    const button = page.getByTestId('convert-images-button')
    await expect(button).toBeVisible()
    await expect(button).toHaveText(/Konvertovať obrázky na súbory/)
    await button.click()
    const result = page.getByTestId('convert-images-result')
    await expect(result).toBeVisible()
    await expect(result, 'the report counts render').toContainText('Skonvertované:')
    await expect(result).toContainText('preskočené:')
  })
})
