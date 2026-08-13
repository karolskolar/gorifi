import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, CYCLE_NAME } from '../fixtures.js'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// RD-DS-6 — the brand webfonts must be SELF-HOSTED.
//
// The Podpultovka restyle shipped with `<link href="fonts.googleapis.com/css2…">`
// in frontend/index.html. Production and staging nginx both send
//
//   style-src 'self' 'unsafe-inline'; font-src 'self' data:
//
// so the Google stylesheet AND the gstatic .woff2 files were BOTH blocked:
// measured on https://gorifi-dev.skolar.sk/, `document.fonts.size === 0` and the
// entire UI rendered in the `Inter, sans-serif` fallback. Nothing caught it
// because every gate in the effort ran against Express on localhost with no
// nginx and therefore NO CSP HEADER AT ALL. This file closes both halves of
// that hole.
//
// ⚠ `document.fonts.check()` is NOT a valid probe here — it returned `true` on
// staging while zero faces were loaded (it answers "would this family be used",
// not "did the bytes arrive"). Every assertion below goes through either
// `FontFace.status === 'loaded'` or a real rendered-width measurement.
//
// ⚠ latin-ext is not optional. This is a Slovak UI: á é í ó ú ý ô are in the
// `latin` subset (U+0000-00FF), but č š ž ľ ť ď ň ĺ ŕ are U+0100-017F, i.e.
// `latin-ext`. Ship only `latin` and every one of those letters falls back to a
// different typeface MID-WORD ("Zrušiť", "Späť", "Objednávky kolegov"). Each
// family is therefore asserted per subset, not per family.

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '../../frontend/dist')

// Copied verbatim from deploy/nginx-gorifi.conf (and identical in
// deploy/nginx-gorifi-staging.conf). If that header ever changes, change it here
// too — the whole point of this file is that the gate sees what the browser sees.
const PROD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
  "base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests"

// ⚠ 'Noto Sans Cond' joined this list on 2026-08-13 (the product-description face,
// `.pspec`/`.pnotes`). The exact-set assertion below is what forced this edit, which
// is exactly its purpose — a face may not arrive without a ledger note.
const FAMILIES = ['Darker Grotesque', 'Figtree', 'Courier Prime', 'Noto Sans Cond']

// Every shipped weight, and the fallback each is measured against. The fallback
// must be metrically FAR from the brand face, or a "did it render?" width diff is
// noise — and a monospace brand face compared against the GENERIC `monospace` is
// exactly that risk, since how close the two sit depends on whatever the host
// resolves `monospace` to. So Courier Prime is measured against `sans-serif`,
// and the two sans faces against `monospace`.
// Courier Prime is listed TWICE, at both shipped weights. One probe per family
// left `courier-prime-700-{latin,latin-ext}.woff2` — 2 of the 9 files, 7 of the
// 17 rules — never fetched: they reported `status: 'unloaded'` after a green run,
// and deleting them kept the suite passing. Those two back `.neg`
// (FriendBalanceCard.vue) and `.tabbadge` (FriendOrder.vue,
// FriendPortalSession.vue), i.e. the balance figure and the colleagues badge.
// Every weight that ships must appear here.
const PROBES = [
  { family: 'Darker Grotesque', weight: 800, fallback: 'monospace' },
  { family: 'Figtree', weight: 400, fallback: 'monospace' },
  { family: 'Courier Prime', weight: 400, fallback: 'sans-serif' },
  { family: 'Courier Prime', weight: 700, fallback: 'sans-serif' },
  // Both shipped cuts of the product-description face. `monospace` is the far
  // fallback for the same reason the other sans faces use it — and a CONDENSED face
  // against a monospace one is the widest metric gap in this table.
  { family: 'Noto Sans Cond', weight: 500, fallback: 'monospace' },
  { family: 'Noto Sans Cond', weight: 700, fallback: 'monospace' },
]

const LATIN = 'AHOJ KOLEGOVIA'
const LATIN_EXT = 'žťšľčďň' // every char here is U+0100-017F — latin-ext only

// --------------------------------------------------------------------------
// in-page probes
// --------------------------------------------------------------------------

async function fontReport(page, probes) {
  return page.evaluate(async ({ probes, LATIN_EXT }) => {
    await document.fonts.ready

    const faces = []
    document.fonts.forEach((f) => {
      faces.push({ family: f.family, weight: f.weight, status: f.status, range: f.unicodeRange })
    })

    // `FontFaceSet.load()` resolves with the faces that actually match the given
    // text — i.e. whose unicode-range covers it — after fetching them. A face
    // blocked by CSP ends up `status: 'error'`, and a page with no @font-face at
    // all resolves with an EMPTY array. Both are failures; the empty-array case
    // is exactly what staging did.
    const subsets = { latin: 'A', 'latin-ext': LATIN_EXT[0] }
    const loaded = {}
    for (const { family, weight } of probes) {
      for (const [subset, ch] of Object.entries(subsets)) {
        // The weight is part of the key: Courier Prime is probed at 400 AND 700,
        // and a family-only key would let the second silently overwrite the first.
        const key = `${family}|${weight}|${subset}`
        try {
          const list = await document.fonts.load(`${weight} 24px "${family}"`, ch)
          loaded[key] = list.map((f) => f.status)
        } catch (e) {
          loaded[key] = [`REJECTED: ${e && e.message}`]
        }
      }
    }
    return { size: document.fonts.size, faces, loaded }
  }, { probes, LATIN_EXT })
}

async function renderedWidths(page, probes, texts) {
  return page.evaluate(async ({ probes, texts }) => {
    // A face is only fetched when something actually needs it, and `font-display:
    // swap` means an un-fetched face measures at its FALLBACK metrics. The portal
    // screen renders no `.mono` text, so Courier Prime would otherwise be
    // measured before its bytes exist and look identical to the fallback — a
    // false failure. Resolve every probed face for every probed string first.
    for (const { family, weight } of probes) {
      for (const text of Object.values(texts)) {
        try {
          await document.fonts.load(`${weight} 96px "${family}"`, text)
        } catch { /* surfaced by the status assertions, not here */ }
      }
    }

    const measure = (text, fontFamily, weight) => {
      const el = document.createElement('span')
      el.textContent = text
      el.style.position = 'absolute'
      el.style.left = '-99999px'
      el.style.top = '0'
      el.style.whiteSpace = 'pre'
      el.style.fontSize = '96px'
      el.style.fontWeight = String(weight)
      el.style.fontFamily = fontFamily
      document.body.appendChild(el)
      const w = el.getBoundingClientRect().width
      el.remove()
      return w
    }
    const out = {}
    for (const { family, weight, fallback } of probes) {
      for (const [label, text] of Object.entries(texts)) {
        out[`${family}|${weight}|${label}`] = {
          brand: measure(text, `"${family}", ${fallback}`, weight),
          // A family that certainly does not exist, so this resolves to the SAME
          // fallback. Equal widths therefore mean the brand face contributed
          // nothing to this string.
          fallback: measure(text, `"NoSuchFace-RDDS6", ${fallback}`, weight),
        }
      }
    }
    return out
  }, { probes, texts })
}

// --------------------------------------------------------------------------
// shared assertions
// --------------------------------------------------------------------------

async function assertBrandFontsLoaded(page) {
  const report = await fontReport(page, PROBES)

  expect(report.size, `document.fonts is empty — no @font-face reached the page.\n${JSON.stringify(report, null, 2)}`)
    .toBeGreaterThan(0)

  // Exact-set equality is DELIBERATE, not laziness: self-hosting a further face
  // later (`friends-theme.css:207` still asks for 'Anton', which nothing loads)
  // must fail here until `FAMILIES` and the ledger entries are updated together.
  // The whole point of this row is that a font arriving without a ledger note is
  // how the CSP break shipped in the first place.
  const families = [...new Set(report.faces.map((f) => f.family.replace(/['"]/g, '')))].sort()
  expect(families, 'the three brand families must all be registered').toEqual([...FAMILIES].sort())

  // No face may be in an error state, whatever its subset.
  const broken = report.faces.filter((f) => f.status === 'error')
  expect(broken, `@font-face entries failed to load: ${JSON.stringify(broken)}`).toEqual([])

  // Per family AND per weight AND per subset: the bytes actually arrived.
  for (const { family, weight } of PROBES) {
    for (const subset of ['latin', 'latin-ext']) {
      const statuses = report.loaded[`${family}|${weight}|${subset}`]
      expect(statuses, `no @font-face matched "${family}" ${weight} for the ${subset} subset — that subset was not shipped`)
        .not.toEqual([])
      expect(statuses, `"${family}" ${weight} ${subset} did not load: ${JSON.stringify(statuses)}`)
        .toEqual(statuses.map(() => 'loaded'))
    }
  }
  return report
}

async function assertSlovakRendersInBrandFace(page) {
  const widths = await renderedWidths(page, PROBES, { latin: LATIN, latinExt: LATIN_EXT })

  for (const { family, weight } of PROBES) {
    for (const label of ['latin', 'latinExt']) {
      const { brand, fallback } = widths[`${family}|${weight}|${label}`]
      expect(brand, `${family} ${weight}/${label}: nothing rendered`).toBeGreaterThan(0)
      // If the face covering these characters were missing, the browser would
      // fall back per character and both spans would measure identically.
      expect(
        Math.abs(brand - fallback),
        `"${label === 'latin' ? LATIN : LATIN_EXT}" rendered at the SAME width in ` +
        `"${family}" as in the bare fallback (${brand} vs ${fallback}) — the ` +
        `${label === 'latin' ? 'latin' : 'latin-ext'} face is not being used`,
      ).toBeGreaterThan(1)
    }
  }
  return widths
}

// --------------------------------------------------------------------------
// 1. against whatever BASE_URL points at (local prod-like build, or staging)
// --------------------------------------------------------------------------

test.describe('Brand fonts are self-hosted (BASE_URL target)', () => {
  test('every brand family and BOTH subsets load, and no external host is contacted', async ({ page, baseURL }) => {
    const external = watchExternal(page, new URL(baseURL).origin)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await assertBrandFontsLoaded(page)
    expect(external, `page requested non-same-origin URLs:\n${external.join('\n')}`).toEqual([])
  })

  test('a Slovak diacritic renders in the brand face, not a fallback', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await assertSlovakRendersInBrandFace(page)
  })

  test('index.html links no external stylesheet', async ({ request }) => {
    const html = await (await request.get('/')).text()
    expect(html).not.toMatch(/<link[^>]+href=["']https?:\/\//i)
  })
})

// --------------------------------------------------------------------------
// 1b. the ROUTE SWEEP — the assertion that actually generalises
//
// ⚠ Visiting `/` alone does NOT justify the claim "this catches the next CDN
// link somebody adds". It demonstrably did not: `InviteRegister.vue` was loading
// the Goriffee logo from `https://www.goriffee.com/...png`, which the production
// `img-src 'self' data:` blocks — a broken logo on the PUBLIC registration page,
// sitting on a route this file never opened. (That URL also 404s upstream now,
// so it was broken twice over.) Every public, unauthenticated route that renders
// its own chrome is swept here, so the claim is true rather than merely softened.
//
// Not swept, deliberately: authenticated routes (`/cycle/:id`, `/admin/*`) need
// a session and are covered for chrome by their own specs. `revolut.me` links in
// `FriendOrder.vue` / `PaymentModal.vue` are `<a href>` NAVIGATIONS, not
// subresource fetches — CSP's `form-action`/`navigate-to` do not apply to plain
// link targets and nothing is fetched until the user clicks, so they are out of
// scope by nature and never appear in a `request` event on these loads.
// --------------------------------------------------------------------------

function watchExternal(page, origin) {
  const external = []
  page.on('request', (req) => {
    const url = req.url()
    if (!/^https?:/i.test(url)) return // data:/blob: are same-document
    if (new URL(url).origin !== origin) external.push(`${url}  [${req.resourceType()}]`)
  })
  return external
}

test.describe('No public route fetches a third-party subresource', () => {
  let ctx = null
  let guestToken = ''
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

  test.beforeAll(async ({ baseURL }) => {
    ctx = await playwrightRequest.newContext({ baseURL })
    const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status(), 'admin login').toBe(200)
    const adminToken = (await login.json()).token
    const admin = (p, o = {}) => ctx[o.method || 'get'](p, {
      headers: { 'X-Admin-Token': adminToken },
      ...(o.data ? { data: o.data } : {}),
    })

    const cycles = await admin('/api/cycles')
    const cycleId = (await cycles.json()).find((c) => c.name === CYCLE_NAME).id

    // A real guest link, so `/g/:token` renders the LIVE ordering page (product
    // cards, images, the cart bar) rather than the dead-link placeholder — the
    // dead-link page shares almost none of that markup, so sweeping it would
    // prove very little. Same provisioning idiom as guest-link.spec.js.
    const username = `rdds6_${uniq}`.slice(0, 30)
    const created = await admin('/api/friends', { method: 'post', data: { name: `E2E RDDS6 Host ${uniq}` } })
    expect(created.status(), 'friend create').toBe(201)
    const friend = await created.json()
    expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
    expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

    const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
    expect(auth.status(), 'friend login').toBe(200)
    const first = (await auth.json()).token
    const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
      headers: { Authorization: `Bearer ${first}` },
      data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
    })
    expect(chg.status(), 'forced change').toBe(200)
    const hostToken = (await chg.json()).token || first

    const link = await ctx.post(`/api/guest-links/cycle/${cycleId}`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    })
    expect(link.status(), 'guest link create').toBe(201)
    guestToken = (await link.json()).link.token
    expect(guestToken, 'guest token').toBeTruthy()
  })

  test.afterAll(async () => { await ctx?.dispose() })

  test('/ , /invite/:code and /g/:token each fetch only same-origin subresources', async ({ page, baseURL }) => {
    const origin = new URL(baseURL).origin
    const offenders = {}

    // `/invite/:code` renders its logo OUTSIDE the loading/invalid/valid branch,
    // so an unknown code still exercises the chrome this test exists for.
    const routes = ['/', `/invite/RDDS6-${uniq}`, `/g/${guestToken}`]

    for (const route of routes) {
      const external = watchExternal(page, origin)
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      if (external.length) offenders[route] = external
      page.removeAllListeners('request')
    }

    expect(offenders, `third-party subresources by route:\n${JSON.stringify(offenders, null, 2)}`).toEqual({})
  })

  // ⚠ This test used to assert the Goriffee logo decoded at `h-12` on this route.
  // The logo is GONE (product decision, 2026-08-12: the invite screen was restyled
  // onto the Podpultovka skin, which carries the wordmark chrome like every other
  // public screen, and `goriffee-logo.svg` is deleted). Retargeted rather than
  // deleted, because the VALUE was never "a logo exists" — it was "an image this
  // route renders actually decodes", which a bare `toBeVisible()` misses since a
  // CSP-blocked or 404 image is `complete` with `naturalWidth === 0`.
  //
  // So it now (a) pins the chrome that replaced it — the route must still say what
  // it is to someone who mistyped a code — and (b) applies the decode check to
  // EVERY image the route renders, whatever they turn out to be. Part (b) is
  // vacuous while the count is zero, which is why (a) is asserted alongside it and
  // why the count itself is reported.
  test('the invite page renders its own chrome, and any image it renders decodes', async ({ page }) => {
    await page.goto(`/invite/RDDS6-${uniq}`)

    // The wordmark lives in `BrandChrome`'s `.titles` block and is split across
    // spans ("Pod" + accent "pult" + "ovka"), so match the block's text content.
    const titles = page.locator('.appbar .titles')
    await expect(titles).toContainText('Podpultovka')
    await expect(titles).toContainText('Registrácia')
    // The Goriffee mark must not come back on this route by any path.
    await expect(page.getByAltText('Goriffee')).toHaveCount(0)
    await expect(page.locator('img[src*="goriffee"]')).toHaveCount(0)

    const images = await page.locator('img').evaluateAll((els) => els.map((el) => ({
      src: el.currentSrc || el.src,
      alt: el.alt,
      complete: el.complete,
      naturalWidth: el.naturalWidth,
    })))
    for (const img of images) {
      expect(new URL(img.src).origin, `image must be same-origin: ${img.src}`).toBe(new URL(page.url()).origin)
      expect(img.complete && img.naturalWidth > 0, `image did not decode: ${JSON.stringify(img)}`).toBe(true)
    }
    console.log(`[invite chrome] images on /invite/:code: ${images.length}`)
  })
})

// --------------------------------------------------------------------------
// 2. the built app served WITH the production CSP header
//
// This is the half that was missing: a tiny static server over frontend/dist
// that sets the one header nginx sets. No nginx, no backend — the API 404s
// same-origin, which is not a CSP concern and does not stop the shell rendering.
// --------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

test.describe('Brand fonts under the PRODUCTION CSP', () => {
  let server = null
  let origin = ''

  test.beforeAll(async () => {
    test.skip(!existsSync(join(DIST, 'index.html')),
      'frontend/dist not built — run `cd frontend && npx vite build` first')

    server = createServer((req, res) => {
      const setHeaders = () => {
        res.setHeader('Content-Security-Policy', PROD_CSP)
        res.setHeader('X-Content-Type-Options', 'nosniff')
      }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)

      if (pathname.startsWith('/api')) {
        setHeaders()
        res.writeHead(404, { 'Content-Type': MIME['.json'] })
        return res.end('{"error":"no backend in this fixture"}')
      }

      // Resolve inside DIST only, then SPA-fallback like nginx's try_files.
      //
      // ⚠ The fallback applies to EXTENSIONLESS paths only. nginx would happily
      // answer a missing /fonts/x.woff2 with index.html at status 200, and so did
      // this fixture — which made the "every woff2 came back 200" assertion
      // vacuous: deleting a font file still produced a 200 (of HTML). Caught by
      // mutation-testing the Courier Prime 700 file. A missing asset now 404s.
      const target = normalize(join(DIST, pathname))
      const inDist = target.startsWith(DIST) && !target.endsWith('/')
      const looksLikeAsset = /\.[a-z0-9]+$/i.test(pathname)
      let file
      if (inDist && existsSync(target)) file = target
      else if (looksLikeAsset) {
        setHeaders()
        res.writeHead(404, { 'Content-Type': MIME['.json'] })
        return res.end('{"error":"missing asset"}')
      } else file = join(DIST, 'index.html')

      let body
      try {
        body = readFileSync(file)
      } catch {
        setHeaders()
        res.writeHead(404)
        return res.end()
      }
      const ext = file.slice(file.lastIndexOf('.'))
      setHeaders()
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      res.end(body)
    })

    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  test.afterAll(async () => {
    if (server) await new Promise((r) => server.close(r))
    server = null
  })

  test('zero CSP violations, zero external requests, all faces loaded', async ({ page }) => {
    const external = []
    page.on('request', (req) => {
      const url = req.url()
      if (!/^https?:/i.test(url)) return
      if (new URL(url).origin !== origin) external.push(url)
    })

    await page.addInitScript(() => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
          directive: e.effectiveDirective,
          blocked: e.blockedURI,
        })
      })
    })

    await page.goto(`${origin}/`)
    await page.waitForLoadState('networkidle')

    // (That this fixture's CSP is genuinely ENFORCING — and not silently absent,
    // which would make everything below vacuous — is pinned by the last test in
    // this describe, which reproduces the original bug against it.)
    const violations = await page.evaluate(() => window.__cspViolations)
    expect(violations, `CSP violations:\n${JSON.stringify(violations, null, 2)}`).toEqual([])

    expect(external, `non-same-origin requests:\n${external.join('\n')}`).toEqual([])

    await assertBrandFontsLoaded(page)
    await assertSlovakRendersInBrandFace(page)
  })

  test('the invite route raises no img-src violation under the production CSP', async ({ page }) => {
    // The route that was actually broken in production. It is swept here rather
    // than only in the BASE_URL describe because Express sends no CSP at all —
    // the external logo loaded fine there, which is precisely why nobody noticed.
    await page.addInitScript(() => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI })
      })
    })
    await page.goto(`${origin}/invite/RDDS6-CSP`)
    await page.waitForLoadState('networkidle')

    const violations = await page.evaluate(() => window.__cspViolations)
    expect(violations, `CSP violations on /invite/:code:\n${JSON.stringify(violations, null, 2)}`).toEqual([])

    // ⚠ The route's own render must be asserted here too, or a page that failed to
    // mount at all would pass this test trivially — no markup, no violations. The
    // Goriffee logo this used to check is gone (2026-08-12 restyle); the chrome that
    // replaced it is the load-bearing thing on the route now, and it is styled by
    // `friends-theme.css`, i.e. it also proves `style-src` did not eat the theme.
    await expect(page.locator('.appbar .titles')).toContainText('Podpultovka')
    await expect(page.getByTestId('invite-invalid')).toBeVisible()
    const themed = await page.locator('.app').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(themed, 'the theme background must survive the CSP').toBe('rgb(255, 248, 243)')
  })

  test('the .woff2 files are served from the app origin with the CSP applied', async ({ page }) => {
    const fontResponses = []
    page.on('response', (res) => {
      if (res.url().endsWith('.woff2')) fontResponses.push({ url: res.url(), status: res.status() })
    })

    await page.goto(`${origin}/`)
    await page.waitForLoadState('networkidle')
    // Force every probed subset to be fetched, latin-ext included.
    await fontReport(page, PROBES)

    expect(fontResponses.length, 'no .woff2 was fetched at all').toBeGreaterThan(0)
    for (const r of fontResponses) {
      expect(r.url.startsWith(`${origin}/fonts/`), `woff2 not served from /fonts/: ${r.url}`).toBe(true)
      expect(r.status, `woff2 ${r.url}`).toBe(200)
    }

    // An EXPLICIT expected set, not a per-family "some file matched": that
    // weaker form is what let courier-prime-700-* ship unfetched. Every shipped
    // file except the vietnamese subset (deliberately never fetched by a Slovak
    // UI — `unicode-range` sees to that) must appear here.
    const names = new Set(fontResponses.map((r) => r.url.split('/').pop()))
    const expected = [
      'darker-grotesque-800-latin.woff2', 'darker-grotesque-800-latin-ext.woff2',
      'figtree-variable-latin.woff2', 'figtree-variable-latin-ext.woff2',
      'courier-prime-400-latin.woff2', 'courier-prime-400-latin-ext.woff2',
      'courier-prime-700-latin.woff2', 'courier-prime-700-latin-ext.woff2',
    ]
    const missing = expected.filter((n) => !names.has(n))
    expect(missing, `shipped but never fetched — unvalidated files: ${missing.join(', ')}`).toEqual([])
  })

  test('a Google Fonts <link> would be blocked by this CSP (the bug, reproduced)', async ({ page }) => {
    // Non-vacuity: proves the fixture's CSP really is enforcing, so a green run
    // above means "self-hosting works", not "the header never arrived".
    await page.addInitScript(() => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI })
      })
    })
    await page.goto(`${origin}/`)
    await page.evaluate(() => new Promise((resolve) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'https://fonts.googleapis.com/css2?family=Figtree&display=swap'
      link.onload = link.onerror = () => setTimeout(resolve, 200)
      document.head.appendChild(link)
      setTimeout(resolve, 3000)
    }))
    const violations = await page.evaluate(() => window.__cspViolations)
    expect(
      violations.some((v) => v.directive === 'style-src-elem' || v.directive === 'style-src'),
      `expected the fixture CSP to block a Google Fonts <link>; got ${JSON.stringify(violations)}`,
    ).toBe(true)
  })
})
