import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, CYCLE_NAME } from '../fixtures.js'
import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
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
//
// ⚠ "change it here too" is no longer a HONOUR-SYSTEM instruction: the
// `CSP copy is not a copy — it is checked against the real conf` describe below
// reads both nginx files off disk and string-equals every `add_header` value
// against this constant. Drift in EITHER direction reddens the gate.
//
// ⚠ THE POLICY LIVES IN THREE PLACES, not two: the two container confs (six
// lines) AND the Nginx Proxy Manager block in docs/deploy/nginx-proxy-manager.md,
// which is pasted into the EDGE proxy in front of both prod and staging. All
// three files are checked below. What is NOT checkable is what an operator
// actually pasted into NPM's web UI — see the NPM_DOC note.
//
// ⚠ GA-T3 / 10 §UC-GA-012 — the ONE sanctioned CSP exception (01 §Integrations).
// Four scoped additions for Google Identity Services, verified 2026-08-16 against
// Google's current published guidance at
// https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
// ("Content Security Policy"). Nothing else is relaxed — `font-src 'self' data:`
// and `img-src 'self' data:` are byte-identical to the RD-DS-6 policy.
//
// ⚠ `frame-src` is a NEW directive. Until GA-T3 the policy had none, so frames
// fell back to `default-src 'self'` — i.e. same-origin frames were allowed and
// cross-origin ones blocked, which is exactly why the GIS button iframe would
// have been blocked. Declaring `frame-src` REPLACES that fallback: it is now the
// only frame rule, and it deliberately omits `'self'` because this app renders no
// iframe at all (the sole `'iframe'` string in the frontend is a focus-trap
// selector in NeoModal.vue). If a same-origin iframe is ever added, `'self'` must
// join this directive in BOTH confs — and the consequence test below will say so.
const PROD_CSP = "default-src 'self'; " +
  "script-src 'self' https://accounts.google.com/gsi/client; " +
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; " +
  "img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self' https://accounts.google.com/gsi/; " +
  "frame-src https://accounts.google.com/gsi/; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; " +
  "upgrade-insecure-requests"

// The GIS host. Allowed as a subresource origin on the two public routes that will
// render a Google control (UC-GA-005 friend login, UC-GA-008 invite registration)
// and NOWHERE else — `/g/:token` in particular stays at ZERO external requests,
// because guests never see Google (UC-GA-012's loader rule).
const GIS_HOST = 'accounts.google.com'

const NGINX_CONFS = [
  resolve(HERE, '../../deploy/nginx-gorifi.conf'),
  resolve(HERE, '../../deploy/nginx-gorifi-staging.conf'),
]

// ⚠ THERE IS A THIRD COPY, and it is the one that can kill production.
// `docs/deploy/nginx-proxy-manager.md` §2 holds a `Content-Security-Policy-Report-Only`
// block the operator PASTES into Nginx Proxy Manager's "Advanced" tab, and the Notes
// tell them to promote it to enforcing once the report log is clean. NPM is a real hop
// in front of BOTH prod and staging, so if that copy lacks the GIS sources, promoting
// it kills Google Sign-In at the edge while all six container-conf lines are perfectly
// correct — invisible to every gate, because the e2e target is Express and Express
// sends no security headers.
//
// The FILE is checked below, byte-for-byte (modulo the -Report-Only suffix).
//
// ⚠ What CANNOT be checked, and is the residual risk: whether what is actually
// pasted into NPM's web UI matches this file. That lives in a database on the proxy
// host, not in the repo. §2b of that doc records the probe
// (`curl -sI https://gorifi.skolar.sk | grep -i content-security`) — it is a manual
// step in GA-T4's staging walkthrough, not something this suite can assert.
const NPM_DOC = resolve(HERE, '../../docs/deploy/nginx-proxy-manager.md')

// The raw loader source is served by the CSP fixture at /__src/gis.js so the REAL
// file can be exercised same-origin under the REAL policy. Nothing imports it yet
// (GA-T4 onward own the button surfaces), so it is absent from the built bundle —
// which is itself asserted, so wiring it up is a visible change.
const GIS_LIB = resolve(HERE, '../../frontend/src/lib/gis.js')
const FRONTEND_SRC = resolve(HERE, '../../frontend/src')

function cspValuesIn(confPath) {
  const text = readFileSync(confPath, 'utf8')
  return [...text.matchAll(/add_header\s+Content-Security-Policy\s+"([^"]*)"\s+always;/g)]
    .map((m) => m[1])
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else out.push(full)
  }
  return out
}

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
// 0. the CSP copy is not a copy — it is CHECKED against the real conf
//
// GA-T3 / 10 §UC-GA-012. Every earlier version of this file carried `PROD_CSP` as
// a hand-maintained transcription with a comment asking the next editor to keep it
// in sync. That is the same honour system that let a `<link>` to fonts.googleapis
// ship in the first place: nothing in the gate could see the real header, because
// the e2e target is Express on :3997 and Express sends no security headers AT ALL.
//
// These tests close the last gap in that story. They read `deploy/nginx-*.conf`
// off disk and string-equal what nginx would actually send against the constant
// the browser fixture below serves. Drift in EITHER direction — an operator
// editing the conf, or an editor "improving" the constant — reddens the gate, and
// the failure message names the file and the differing value.
// --------------------------------------------------------------------------

test.describe('The CSP copy matches the deployed nginx confs', () => {
  test('every add_header line in BOTH confs string-equals PROD_CSP', () => {
    const seen = []
    for (const conf of NGINX_CONFS) {
      const values = cspValuesIn(conf)
      // Per-file count, verified rather than assumed: the prod conf has three
      // server blocks (two `location` blocks plus the server-level default) and
      // staging mirrors it. A block added without its CSP line is a real hole —
      // one unprotected route is all it takes — so the count is pinned, not just
      // the values.
      expect(values.length, `${conf}: expected 3 add_header Content-Security-Policy lines`).toBe(3)
      for (const value of values) {
        expect(value, `CSP in ${conf} differs from the copy in this spec file`).toBe(PROD_CSP)
      }
      seen.push(...values)
    }
    // Six lines, ONE policy string — the UC-GA-012 requirement stated directly.
    expect(seen.length, 'six add_header Content-Security-Policy lines in total').toBe(6)
    expect(new Set(seen).size, 'all six lines must carry one identical policy string').toBe(1)
  })

  test('the THIRD copy — the Nginx Proxy Manager block — carries the same policy', () => {
    // See the NPM_DOC comment above for why this one is the dangerous copy: it is
    // pasted into the edge proxy in front of BOTH environments, and the doc tells
    // the operator to promote it from report-only to enforcing.
    const text = readFileSync(NPM_DOC, 'utf8')
    const values = [...text.matchAll(
      /add_header\s+Content-Security-Policy(?:-Report-Only)?\s+"([^"]*)"\s+always;/g,
    )].map((m) => m[1])

    expect(values.length, `${NPM_DOC}: expected exactly one CSP block to keep in sync`).toBe(1)
    expect(
      values[0],
      'The Nginx Proxy Manager block has drifted from deploy/nginx-gorifi.conf.\n' +
      'It is report-only TODAY, so nothing is broken right now — but the doc instructs\n' +
      'promoting it to enforcing, and without the GIS sources that kills Google Sign-In\n' +
      'at the edge on prod AND staging, with every container conf still correct.',
    ).toBe(PROD_CSP)

    // The promote-step warning is the half that survives someone rewriting the
    // block, so its presence is asserted too rather than trusted to review.
    expect(text, 'the promote-to-enforcing step must carry the GIS warning')
      .toMatch(/Do NOT promote this to enforcing/)
  })

  test('the four documented GIS allowances are present, each scoped to its directive', () => {
    // Verified 2026-08-16 against Google's current guidance:
    // https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
    //   script-src  += https://accounts.google.com/gsi/client   (the JS library)
    //   frame-src   += https://accounts.google.com/gsi/         (button/One Tap iframes)
    //   connect-src += https://accounts.google.com/gsi/         (GIS server endpoints)
    //   style-src   += https://accounts.google.com/gsi/style    (GIS stylesheets)
    // Google explicitly advises the PARENT url for connect-src rather than
    // individual endpoints ("This helps minimize failures when GIS is updated"),
    // which is also what covers the FedCM `/gsi/fedcm.json` fetch.
    const directives = Object.fromEntries(
      PROD_CSP.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
        const [name, ...sources] = d.split(/\s+/)
        return [name, sources]
      }),
    )
    expect(directives['script-src']).toContain('https://accounts.google.com/gsi/client')
    expect(directives['frame-src']).toContain('https://accounts.google.com/gsi/')
    expect(directives['connect-src']).toContain('https://accounts.google.com/gsi/')
    expect(directives['style-src']).toContain('https://accounts.google.com/gsi/style')

    // ⚠ Scoped additions ONLY. A bare host (`https://accounts.google.com` with no
    // path) would allow every script, frame and endpoint Google serves on it —
    // that is the "relaxation" 01 §Integrations forbids, and it is a one-character
    // slip away from the correct value.
    for (const [name, sources] of Object.entries(directives)) {
      for (const src of sources) {
        if (!src.includes(GIS_HOST)) continue
        expect(src, `${name}: a bare ${GIS_HOST} host source is a blanket allow, not a scoped addition`)
          .toMatch(/^https:\/\/accounts\.google\.com\/gsi\/(client|style)?$/)
      }
    }
  })

  test('the self-hosted-fonts rule is NOT relaxed by the GIS exception', () => {
    // RD-DS-6's whole discipline: a CSP problem is fixed by self-hosting, never by
    // loosening. Module 10 is the one sanctioned exception and it must stay in its
    // lane — these three directives are byte-identical to the pre-GA-T3 policy.
    expect(PROD_CSP).toContain("font-src 'self' data:;")
    expect(PROD_CSP).toContain("img-src 'self' data:;")
    expect(PROD_CSP).toContain("default-src 'self';")
    // No font/image host may ride in on the exception.
    expect(PROD_CSP).not.toMatch(/font-src[^;]*accounts\.google\.com/)
    expect(PROD_CSP).not.toMatch(/img-src[^;]*accounts\.google\.com/)
    expect(PROD_CSP).not.toContain('fonts.googleapis.com')
    expect(PROD_CSP).not.toContain('fonts.gstatic.com')
  })
})

// --------------------------------------------------------------------------
// 1. against whatever BASE_URL points at (local prod-like build, or staging)
// --------------------------------------------------------------------------

test.describe('Brand fonts are self-hosted (BASE_URL target)', () => {
  test('every brand family and BOTH subsets load, and no external host is contacted', async ({ page, baseURL }) => {
    const external = watchExternal(page, new URL(baseURL).origin)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await assertBrandFontsLoaded(page)
    // ⚠ GA-T4 WILL RED THIS TOO. `/` is the friend login screen, which is exactly
    // where UC-GA-005's Google button goes — so the first real button turns this
    // into "page requested non-same-origin URLs: …/gsi/client [script]". That is
    // expected, not a regression: allow the GIS host here the way the route sweep
    // below does (`EXTERNAL_ALLOWLIST`), and leave every other route at zero.
    const disallowed = external.filter((entry) => new URL(entry.split('  [')[0]).hostname !== GIS_HOST)
    expect(
      disallowed,
      `page requested non-same-origin URLs:\n${disallowed.join('\n')}`,
    ).toEqual([])
    // The allowance above is NOT a hole: that nothing loads GIS today is asserted
    // on its own, for every route, by "no public route contacts Google TODAY".
    // Keeping the zero-claim in exactly one place means GA-T4 has one test to
    // update, with a message that tells it what to do.
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

  // ⚠ GA-T3 / 10 §UC-GA-012 — the ONLY external host this sweep may ever allow, and
  // only on the two routes that will render a Google control. `/g/:token` and
  // `/magic/:token` stay at ZERO external requests: guests never see Google, and the
  // loader (`frontend/src/lib/gis.js`) is what keeps that true — it is imported only
  // by button surfaces, never by `index.html` and never by a guest route. THIS map is
  // the assertion that stops a future row quietly loading GIS on the guest surface.
  const EXTERNAL_ALLOWLIST = {
    '/': [GIS_HOST],
    '/invite/:code': [GIS_HOST],
    '/g/:token': [],
    '/magic/:token': [],
  }

  test('/ , /invite/:code, /g/:token and /magic/:token each fetch only same-origin subresources', async ({ page, baseURL }) => {
    const origin = new URL(baseURL).origin
    const offenders = {}

    // `/invite/:code` renders its logo OUTSIDE the loading/invalid/valid branch,
    // so an unknown code still exercises the chrome this test exists for.
    //
    // `/magic/:token` (ML-T3, 09 §UC-ML-005) is a NEW public unauthenticated route
    // that renders its own chrome (`BrandChrome`, per the RD-DS-6 rule: "any new
    // public route must be added to that list"). A garbage 64-hex token is enough —
    // the redemption POST 401s (neutral failure, any auth mode) and the failure card
    // renders the same chrome the happy path would, which is what this sweep exists
    // to exercise.
    const routes = [
      { label: '/', url: '/' },
      { label: '/invite/:code', url: `/invite/RDDS6-${uniq}` },
      { label: '/g/:token', url: `/g/${guestToken}` },
      { label: '/magic/:token', url: `/magic/${'f'.repeat(64)}` },
    ]

    for (const { label, url } of routes) {
      const external = watchExternal(page, origin)
      await page.goto(url)
      await page.waitForLoadState('networkidle')
      const allowed = EXTERNAL_ALLOWLIST[label]
      // The allowlist is per-route and per-HOST: an allowed host on `/` is still an
      // offender on `/g/:token`. Matched on the parsed hostname, never a substring
      // of the URL — `https://evil.example/?x=accounts.google.com` must not pass.
      const disallowed = external.filter((entry) => {
        const host = new URL(entry.split('  [')[0]).hostname
        return !allowed.includes(host)
      })
      if (disallowed.length) offenders[label] = disallowed
      page.removeAllListeners('request')
    }

    expect(offenders, `third-party subresources by route:\n${JSON.stringify(offenders, null, 2)}`).toEqual({})
  })

  // ⚠ GA-T4 UPDATE (10 §UC-GA-005), an e2e-immutability case (a) edit.
  //
  // This test used to read "no public route contacts Google TODAY — the allowlist is
  // not yet exercised", and its own failure message asked whoever landed a real GIS
  // button to come here and say so. GA-T4 landed one, on the MODERN friend login card
  // (`FriendPortal.vue`), so this is that update.
  //
  // ⚠ AND YET IT DID NOT RED. `e2e/seed.mjs` pins the shared gate to
  // `auth_mode = 'legacy'`, the Google button is modern-mode only (resolved decision
  // #2), so `/` on this target still renders the legacy card and still makes zero
  // requests to Google. The old assertion stayed green for a reason that has nothing
  // to do with what it claimed to be protecting — which is exactly the silent state it
  // existed to prevent. Left alone it would have gone on passing while covering
  // nothing.
  //
  // So it is retargeted rather than deleted, and NOTHING IS WEAKENED:
  //   · `/g/:token` and `/magic/:token` keep an UNCONDITIONAL zero. Guests and
  //     magic-link recipients never see Google — that was the load-bearing half all
  //     along, and it is now stated as its own expectation instead of being one entry
  //     in a map that a legacy-mode target satisfies by accident.
  //   · `/` and `/invite/:code` are asserted against what this target's CONFIG says
  //     should happen: a Google request is permitted on `/` only when the target is
  //     both modern and configured (the two conditions §UC-GA-005 names), and is an
  //     offence otherwise. On the legacy gate that is still "zero", but now because
  //     the config says zero — not because nobody wired anything up.
  //   · `/invite/:code` stays at zero until GA-T8 gives it a control of its own.
  // The presence half — the button DOES render and DOES load GIS when modern +
  // configured — is pinned in `google-auth.spec.js`, which can stub the auth-mode
  // response and therefore reach a state this file's real-target sweep cannot.
  //
  // ⚠ GA-T6 UPDATE (10 §UC-GA-006), a case (a) edit. `views/FriendPortalSession.vue`
  // is now a SECOND sanctioned GIS importer (see the list below), so state the
  // expectations again rather than leave them inferred:
  //
  //   · `/` — UNCHANGED, and the reason is structural, not incidental. The session
  //     view calls `loadGis()` from ONE place: the `@click` handler behind the link
  //     prompt's "Áno, teraz". Nothing in its `setup()`/`onMounted` touches Google, so
  //     an authenticated `/` contacts Google only after a deliberate user gesture. The
  //     route's allowance here is still the LOGIN CARD's, exactly as GA-T4 left it.
  //   · The genuinely new shape this row introduces is an arrival at `/` where the
  //     login card NEVER RENDERS — a token restore, or `/magic/:token` succeeding and
  //     `router.replace('/')`-ing into an authenticated session. If the session view
  //     ever loaded GIS on mount, that path would contact Google with no card and no
  //     gesture, and `/magic/:token`'s zero below would hold only for the FAILURE
  //     token this sweep happens to use. ⚠ This sweep cannot see it (the gate is
  //     legacy, and these visits are anonymous) — it is pinned in `google-auth.spec.js`
  //     under §UC-GA-006, on a modern throwaway backend, by loading `/` with a stored
  //     session and asserting ZERO requests to Google while the prompt is on screen.
  //   · `/g/:token` and `/magic/:token` — UNCONDITIONAL zero, unchanged by this row.
  //     ⚠ Be precise about WHY, because the obvious phrasing is false: it is NOT that
  //     these routes can never mount `FriendPortal*`. `MagicLogin.vue` does
  //     `router.replace('/')` on a SUCCESSFUL redemption and mounts both — which is
  //     exactly the no-login-card arrival the bullet above is about. What holds here is
  //     narrower: AS THIS SWEEP VISITS THEM — a garbage 64-hex token, so the redemption
  //     401s and the failure card renders — neither route ever leaves its own view, and
  //     `/g/:token` never can. The success path's zero is the bullet above's business,
  //     pinned in `google-auth.spec.js`, not this line's.
  //     The independent mechanism is bundle containment (below): the GIS host must not
  //     appear in a `Guest*`/`MagicLogin*` chunk or an entry chunk.
  //     `FriendPortalSession.vue` is a STATIC import of `FriendPortal.vue`, so Vite
  //     inlines it into the existing `FriendPortal-*` route chunk — no new chunk, and
  //     nothing new reaches an entry chunk.
  test('a public route contacts Google only where its config says a Google control renders', async ({ page, baseURL, request }) => {
    const origin = new URL(baseURL).origin
    const mode = await (await request.get('/api/friends/auth-mode')).json()
    const googleOnLoginCard = mode.authMode === 'modern' && mode.googleClientId !== null

    const routes = [
      ['/', '/', googleOnLoginCard],
      // GA-T8 owns the invite screen's Google control; until it lands, zero.
      ['/invite/:code', `/invite/RDDS6-${uniq}`, false],
      // ⚠ UNCONDITIONAL, on every target and in every auth mode.
      ['/g/:token', `/g/${guestToken}`, false],
      ['/magic/:token', `/magic/${'f'.repeat(64)}`, false],
    ]

    const offenders = {}
    const missing = []
    for (const [label, url, allowed] of routes) {
      const external = watchExternal(page, origin)
      await page.goto(url)
      await page.waitForLoadState('networkidle')
      const google = external.filter((e) => new URL(e.split('  [')[0]).hostname.endsWith('google.com'))
      if (!allowed && google.length) offenders[label] = google
      if (allowed && google.length === 0) missing.push(label)
      page.removeAllListeners('request')
    }

    expect(
      offenders,
      'A route contacted Google where its configuration says no Google control renders.\n' +
      'On /g/:token or /magic/:token this is a BUG — guests never see Google (UC-GA-012).\n' +
      `auth-mode: ${JSON.stringify(mode)}\n${JSON.stringify(offenders, null, 2)}`,
    ).toEqual({})

    expect(
      missing,
      `This target is modern + configured, so ${JSON.stringify(mode)} says the login card\n` +
      'should render the GIS button — but nothing was requested from Google. Either the\n' +
      'button regressed or the loader stopped being reached.',
    ).toEqual([])
  })

  // The structural half of the same claim: the loader exists and is the ONE home for
  // GIS script loading. A grep-level assertion is the only thing that can see this —
  // the runtime one above is satisfied by a loader that is imported but never called.
  //
  // ⚠ GA-T4 UPDATE: this test used to end "…and nothing imports it yet", which is the
  // assertion that DID red on this row (`views/FriendPortal.vue` now imports it, by
  // design, per §UC-GA-005). It is retargeted to an EXACT SANCTIONED IMPORTER LIST,
  // which is strictly stronger than the empty list it replaces was ever going to be:
  // the empty list could only be satisfied once, whereas this one keeps failing every
  // time a surface starts loading GIS without anyone recording it — which is the
  // property that actually protects the guest sweep above. Add a row here ONLY
  // together with the sweep's expectation for the route it serves.
  test('lib/gis.js is the ONE home for GIS loading, and only sanctioned surfaces import it', () => {
    expect(existsSync(GIS_LIB), 'frontend/src/lib/gis.js must exist (UC-GA-012)').toBe(true)

    const src = readFileSync(GIS_LIB, 'utf8')
    expect(src, 'the loader must inject the documented GIS client URL')
      .toContain('https://accounts.google.com/gsi/client')

    // ⚠ Never in index.html — the script must load only on surfaces that render a
    // Google control, which is what keeps the guest sweep at zero.
    const indexHtml = readFileSync(resolve(HERE, '../../frontend/index.html'), 'utf8')
    expect(indexHtml, 'GIS must never be loaded from index.html').not.toContain(GIS_HOST)

    // Exactly one file in frontend/src may name the GIS script URL: the loader.
    const owners = walkFiles(FRONTEND_SRC)
      .filter((f) => /\.(js|ts|vue)$/.test(f))
      .filter((f) => readFileSync(f, 'utf8').includes('accounts.google.com/gsi/client'))
    expect(owners.map((f) => f.replace(`${FRONTEND_SRC}/`, '')),
      'GIS script loading belongs in lib/gis.js and nowhere else').toEqual(['lib/gis.js'])

    // ⚠ THE SANCTIONED IMPORTER LIST (10 §UC-GA-012's "only on surfaces that render a
    // Google control"). One row per surface, each named by the UC that put it there:
    //   · views/FriendPortal.vue — GA-T4, §UC-GA-005, the modern login card.
    //   · views/FriendPortalSession.vue — GA-T6, §UC-GA-006, the post-login link
    //     prompt's "Áno, teraz" button. ⚠ Same ROUTE as the row above (`/`): this
    //     component is only ever rendered by `FriendPortal.vue`, so it adds a
    //     surface, not a route, and the sweep's per-route map is unchanged. What it
    //     DOES add is a way to reach `/` with no login card in sight (restore /
    //     magic-link redirect) — see the sweep's note above for why that is still
    //     zero and where that is pinned.
    // Still to come, each on its own row when it lands: AdminLogin (§UC-GA-011),
    // InviteRegister (§UC-GA-008), the profile modal (§UC-GA-007, which will be a
    // THIRD importer inside this same view), AdminSettings (§UC-GA-010). ⚠ A guest
    // view (`GuestOrder`, `GuestOrderStatus`, `GuestProductGrid`) or `MagicLogin`
    // appearing here is a BUG, not an update — those routes are pinned at zero
    // external requests by the sweep above.
    const SANCTIONED_GIS_IMPORTERS = [
      'views/FriendPortal.vue',
      'views/FriendPortalSession.vue',
    ]
    const importers = walkFiles(FRONTEND_SRC)
      .filter((f) => /\.(js|ts|vue)$/.test(f) && f !== GIS_LIB)
      .filter((f) => /from\s+['"][^'"]*lib\/gis(\.js)?['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(`${FRONTEND_SRC}/`, ''))
      .sort()
    expect(importers,
      'A surface started loading GIS. If that is a Google-control row landing, add it to\n' +
      'SANCTIONED_GIS_IMPORTERS *and* state the route\'s expectation in the sweep above.\n' +
      'If it is a guest or magic-link surface, it is a bug (UC-GA-012).')
      .toEqual([...SANCTIONED_GIS_IMPORTERS].sort())

    // ⚠ GA-T4 UPDATE, and the honest version of what this build-level check can claim.
    // It used to assert the shipped bundle names `accounts.google.com` ZERO times,
    // which was true only while nothing imported the loader. Now that a surface does,
    // the host legitimately appears in the chunk that surface is in — so the assertion
    // becomes CONTAINMENT rather than absence: the host may appear only in chunks the
    // sanctioned importers pull it into, and must never reach the entry chunk (which
    // every route loads, including `/g/:token`). That is the property the original
    // zero was standing in for.
    const assets = join(DIST, 'assets')
    test.skip(!existsSync(assets), 'frontend/dist not built')
    const hits = walkFiles(assets)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => readFileSync(f, 'utf8').includes(GIS_HOST))
      .map((f) => f.replace(`${DIST}/assets/`, ''))
    expect(hits.length, 'GIS must be in the bundle somewhere — a surface imports it').toBeGreaterThan(0)
    // Vite names a route chunk after its component; the entry chunks are `index-*.js`.
    // ⚠ If GIS ever lands in an `index-*` chunk, EVERY route downloads it and the
    // guest sweep's zero survives only by luck (nothing calls it) rather than by
    // construction.
    const inEntry = hits.filter((f) => /^index-/.test(f))
    expect(inEntry,
      'GIS reached an entry chunk — every route, including /g/:token, now ships it.\n' +
      'Keep the loader behind a lazily-imported view.').toEqual([])
    expect(hits.filter((f) => /^(Guest|MagicLogin)/.test(f)),
      'GIS reached a guest / magic-link chunk (UC-GA-012)').toEqual([])
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

      // GA-T3: the REAL `frontend/src/lib/gis.js`, served same-origin so it can be
      // dynamically imported and exercised UNDER THE PRODUCTION CSP. It cannot be
      // reached through the bundle — nothing imports it yet, by design — and a
      // data:/blob: module import would be blocked by `script-src 'self'`, which is
      // the correct behaviour and not something to work around. So the fixture
      // publishes the source file itself.
      if (pathname === '/__src/gis.js') {
        setHeaders()
        res.writeHead(200, { 'Content-Type': MIME['.js'] })
        return res.end(readFileSync(GIS_LIB))
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

  // ------------------------------------------------------------------------
  // GA-T3 / 10 §UC-GA-012 — the GIS exception, exercised against the real policy
  //
  // ⚠ These never reach Google. Every accounts.google.com request is intercepted
  // and failed at the NETWORK layer, because a CSP decision is made BEFORE the
  // request is issued: a blocked URL never reaches the route handler at all, and
  // an allowed one produces a network error rather than a violation. So the tests
  // read identically online and offline — which matters, since the gate host has
  // no egress and a connectivity-dependent CSP test would be flaky theatre.
  // ------------------------------------------------------------------------

  const RECORD_VIOLATIONS = () => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI })
    })
  }

  test('script-src admits the GIS client and NOTHING else on that host', async ({ page }) => {
    await page.addInitScript(RECORD_VIOLATIONS)
    await page.route('https://accounts.google.com/**', (r) => r.abort())
    await page.goto(`${origin}/`)

    await page.evaluate(async () => {
      const inject = (src) => new Promise((resolve) => {
        const el = document.createElement('script')
        el.src = src
        el.onload = el.onerror = () => setTimeout(resolve, 100)
        document.head.appendChild(el)
        setTimeout(resolve, 3000)
      })
      await inject('https://accounts.google.com/gsi/client')
      // Same host, different path. The GIS allowance is an EXACT path source, so
      // this must still be blocked — that is the difference between "scoped
      // addition" and the blanket `https://accounts.google.com` a slip would give.
      await inject('https://accounts.google.com/o/oauth2/iframe')
    })

    const violations = await page.evaluate(() => window.__cspViolations)
    expect(
      violations.filter((v) => v.blocked.includes('/gsi/client')),
      `the GIS library URL must be permitted by script-src; got ${JSON.stringify(violations)}`,
    ).toEqual([])
    expect(
      violations.some((v) => v.blocked.includes('/o/oauth2/')),
      `a non-GIS path on accounts.google.com must STILL be blocked; got ${JSON.stringify(violations)}`,
    ).toBe(true)
  })

  test('frame-src admits the GIS iframe — and, deliberately, no other frame', async ({ page }) => {
    await page.addInitScript(RECORD_VIOLATIONS)
    await page.route('https://accounts.google.com/**', (r) => r.abort())
    await page.goto(`${origin}/`)

    const frame = (src) => page.evaluate((s) => new Promise((resolve) => {
      const el = document.createElement('iframe')
      el.src = s
      el.onload = el.onerror = () => setTimeout(resolve, 100)
      document.body.appendChild(el)
      setTimeout(resolve, 2000)
    }), src)

    await frame('https://accounts.google.com/gsi/button')
    await frame('https://example.com/')
    await frame(`${origin}/`)

    const violations = await page.evaluate(() => window.__cspViolations)
    const framed = violations.filter((v) => v.directive === 'frame-src')

    expect(
      framed.filter((v) => v.blocked.includes('accounts.google.com')),
      `the GIS button iframe must be permitted; got ${JSON.stringify(violations)}`,
    ).toEqual([])
    expect(
      framed.some((v) => v.blocked.includes('example.com')),
      `an arbitrary third-party frame must be blocked; got ${JSON.stringify(violations)}`,
    ).toBe(true)

    // ⚠ THE NON-OBVIOUS CONSEQUENCE OF ADDING A NEW DIRECTIVE, pinned on purpose.
    // Before GA-T3 there was no `frame-src`, so frames fell back to `default-src
    // 'self'` and a SAME-ORIGIN iframe was allowed. Declaring `frame-src` replaces
    // that fallback wholesale, and it omits `'self'` because this app renders no
    // iframe anywhere (the only `'iframe'` token in frontend/src is a focus-trap
    // selector in NeoModal.vue). That keeps the addition minimal.
    //
    // If a same-origin iframe is ever legitimately needed, the fix is to add
    // `'self'` to `frame-src` in BOTH nginx confs and in PROD_CSP, and to delete
    // this assertion — deliberately, with that reasoning written down. It is here
    // so the choice is discovered by a red test rather than by a blank frame in
    // production.
    expect(
      framed.some((v) => v.blocked === 'self' || v.blocked.startsWith(origin)),
      'same-origin frames are blocked by the new frame-src (see comment) — ' +
      `got ${JSON.stringify(violations)}`,
    ).toBe(true)
  })

  test('lib/gis.js no-ops on a null client id, dedupes, and cleans up after a failure', async ({ page }) => {
    await page.addInitScript(RECORD_VIOLATIONS)
    // The script tag is permitted by CSP; the network is what fails here. That is
    // precisely the "blocked or offline Google" case the loader must survive.
    await page.route('https://accounts.google.com/**', (r) => r.abort())
    await page.goto(`${origin}/`)

    const out = await page.evaluate(async () => {
      const mod = await import('/__src/gis.js')
      const tags = () => document.querySelectorAll('script[src*="accounts.google.com"]').length
      const r = {}

      // 1. Unconfigured deployment: resolves null and injects NOTHING, so call
      //    sites need no separate guard and no route can contact Google.
      r.nullResolves = await mod.loadGis(null)
      r.tagsAfterNull = tags()
      r.emptyStringResolves = await mod.loadGis('')
      r.tagsAfterEmpty = tags()

      // 2. Configured: one tag, and concurrent callers share ONE promise.
      const a = mod.loadGis('test.apps.googleusercontent.com', { timeoutMs: 4000 })
      const b = mod.loadGis('test.apps.googleusercontent.com', { timeoutMs: 4000 })
      r.sharedPromise = a === b
      r.tagsWhileLoading = tags()

      r.rejection = await a.then(() => null, (e) => String((e && e.message) || e))

      // 3. After a failure the loader must be retryable — a friend who lost their
      //    connection for one second must not be locked out of Google for the life
      //    of the page. The failed tag is removed and a fresh attempt is made.
      r.tagsAfterFailure = tags()
      const c = mod.loadGis('test.apps.googleusercontent.com', { timeoutMs: 4000 })
      r.retryIsFreshPromise = c !== a
      await c.catch(() => {})
      return r
    })

    expect(out.nullResolves, 'null client id must resolve null, not reject').toBe(null)
    expect(out.tagsAfterNull, 'a null client id must inject no script').toBe(0)
    expect(out.emptyStringResolves, 'an empty client id is also unconfigured').toBe(null)
    expect(out.tagsAfterEmpty, 'an empty client id must inject no script').toBe(0)
    expect(out.sharedPromise, 'concurrent callers must share one in-flight promise').toBe(true)
    expect(out.tagsWhileLoading, 'exactly one GIS script tag, however many callers').toBe(1)
    expect(out.rejection, 'an unreachable Google must REJECT, never hang').toBeTruthy()
    expect(out.tagsAfterFailure, 'the failed tag must be cleaned up').toBe(0)
    expect(out.retryIsFreshPromise, 'a failure must not be cached forever').toBe(true)

    // The loader itself must raise no CSP violation — it is same-origin code
    // injecting a URL the policy now permits.
    const violations = await page.evaluate(() => window.__cspViolations)
    expect(violations, `loader raised CSP violations:\n${JSON.stringify(violations, null, 2)}`).toEqual([])
  })

  // ⚠ THE SUCCESS PATH — the contract GA-T4/T6/T7/T8/T10 all consume. The two
  // tests below it cover only failure (reject) and timeout (reject); without this
  // one, a loader that resolved `undefined`, or the <script> element, or that
  // never short-circuited on a second call, would ship green and break every
  // button surface at once.
  //
  // Google is still never contacted: the route is fulfilled with a stub that
  // defines the namespace the real client would define.
  test('lib/gis.js resolves the GIS namespace, short-circuits, and reports ready', async ({ page }) => {
    await page.route('https://accounts.google.com/**', (r) => r.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: 'window.google = { accounts: { id: { initialize() {}, renderButton() {}, __stub: true } } }',
    }))
    await page.goto(`${origin}/`)

    const out = await page.evaluate(async () => {
      const mod = await import('/__src/gis.js')
      const tags = () => document.querySelectorAll('script[src*="accounts.google.com"]').length
      const r = {}

      r.readyBefore = mod.isGisReady()

      const ns = await mod.loadGis('test.apps.googleusercontent.com', { timeoutMs: 5000 })
      // Identity, not shape: the resolved value must BE window.google.accounts.id,
      // so a call site can hand it straight to `initialize()`/`renderButton()`.
      r.isNamespace = ns === window.google.accounts.id
      r.isStub = ns && ns.__stub === true
      r.hasInitialize = typeof (ns && ns.initialize) === 'function'
      r.notAnElement = !(ns instanceof HTMLElement)
      r.readyAfter = mod.isGisReady()
      r.tagsAfterLoad = tags()

      // A later, entirely separate call must short-circuit: same object, no second
      // <script>. This is the path every surface after the first one takes.
      const again = await mod.loadGis('test.apps.googleusercontent.com')
      r.secondCallSameObject = again === ns
      r.tagsAfterSecondCall = tags()

      // ...and the no-op rule still wins over an already-loaded namespace: an
      // unconfigured deployment must get null even here.
      r.nullStillNoOps = await mod.loadGis(null)
      return r
    })

    expect(out.readyBefore, 'isGisReady() must be false before any load').toBe(false)
    expect(out.isNamespace, 'must resolve window.google.accounts.id itself').toBe(true)
    expect(out.isStub, 'must resolve the object the script defined').toBe(true)
    expect(out.hasInitialize, 'the resolved namespace must be callable by GA-T4').toBe(true)
    expect(out.notAnElement, 'must not resolve the <script> element').toBe(true)
    expect(out.readyAfter, 'isGisReady() must be true after a successful load').toBe(true)
    expect(out.tagsAfterLoad, 'exactly one GIS script tag').toBe(1)
    expect(out.secondCallSameObject, 'a later call must short-circuit to the same namespace').toBe(true)
    expect(out.tagsAfterSecondCall, 'a second call must not inject a second tag').toBe(1)
    expect(out.nullStillNoOps, 'a null client id must resolve null even once GIS is loaded').toBe(null)
  })

  test('lib/gis.js recovers a namespace that appears AFTER the load event', async ({ page }) => {
    // The poll in `startPolling()` exists for a script that loads and then finishes
    // defining itself a tick later. Without it the loader would either resolve an
    // undefined namespace or wait out the full timeout on a load that actually
    // succeeded. Stubbed with a deliberate delay so the load event fires first.
    await page.route('https://accounts.google.com/**', (r) => r.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: 'setTimeout(() => { window.google = { accounts: { id: { late: true } } } }, 300)',
    }))
    await page.goto(`${origin}/`)

    const out = await page.evaluate(async () => {
      const mod = await import('/__src/gis.js')
      const ns = await mod.loadGis('test.apps.googleusercontent.com', { timeoutMs: 5000 })
      return { late: ns && ns.late === true, ready: mod.isGisReady() }
    })

    expect(out.late, 'a namespace defined after onload must still resolve').toBe(true)
    expect(out.ready, 'isGisReady() must be true afterwards').toBe(true)
  })

  test('lib/gis.js times out rather than hanging when the script never initialises', async ({ page }) => {
    // The nastier failure: Google answers 200 with something that never defines
    // `window.google.accounts.id` (a captive portal, a corporate proxy serving an
    // interstitial, a half-rolled-out GIS build). `onload` fires and a naive loader
    // waits forever, freezing the login screen behind a spinner. UC-GA-012 requires
    // it to degrade to the password form instead.
    await page.route('https://accounts.google.com/**', (r) => r.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: '/* 200 OK, but no window.google */',
    }))
    await page.goto(`${origin}/`)

    const out = await page.evaluate(async () => {
      const mod = await import('/__src/gis.js')
      const started = performance.now()
      const rejection = await mod
        .loadGis('test.apps.googleusercontent.com', { timeoutMs: 600 })
        .then(() => null, (e) => String((e && e.message) || e))
      return { rejection, elapsed: performance.now() - started }
    })

    expect(out.rejection, 'a script that never initialises must reject, not hang').toBeTruthy()
    expect(out.rejection.toLowerCase()).toContain('timeout')
    // Bounded by the timeout it was given — i.e. the timer really is what fired.
    expect(out.elapsed, `took ${out.elapsed}ms for a 600ms timeout`).toBeLessThan(5000)
  })
})
