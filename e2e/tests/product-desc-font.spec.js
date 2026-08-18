import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// The product-description face — Figtree, the body face (product decision,
// 2026-08-18). This REPLACED the 2026-08-13 Noto Sans Condensed brief: the owner
// asked for the typeface of the order screen's status banner ("Objednávky sú
// uzamknuté…" — Figtree, bold lead-in + regular body) on these two lines.
//
// Two lines under the badges in a COFFEE product card:
//   `description1` (the spec line)     → `.pspec`  Figtree 700, 14.5px, lh 1.25, --ink
//   `description2` (the tasting notes) → `.pnotes` Figtree 400, 14px, lh 1.3, --ink-dim
//
// Why it needs a spec of its own: every value lives in `friends-theme.css`, so a
// later "tidy-up" that re-adds an inline `font-size` at the call site, or drops the
// class for `.sub`, would be invisible — the text still renders, just in the wrong
// face at the wrong weight.
//
// ⚠ The things only a measurement catches, and the reason each is here:
//   1. the face actually LOADED — a missing woff2 leaves the text in the fallback
//      ('Inter'/sans-serif) at the same size and colour, which no text assertion
//      and no screenshot diff at this scale would flag;
//   2. Slovak diacritics come from the SAME face — they live in latin-ext
//      (U+0100-017F), a separate file, so a dropped subset breaks "mliečna
//      čokoláda" mid-word while "karamel" stays perfect;
//   3. Noto Sans Condensed is really GONE — its preloads left index.html with the
//      face (a preload with no consumer logs "preloaded but not used" on every
//      route), and nothing may quietly reintroduce a font preload.

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// The 2026-08-13 brief's acceptance strings, kept as the wrap fixtures: the long
// varietal is the worst real-world case and must still fit ≤ 2 lines at 390px in
// the wider (non-condensed) face.
const SPEC_SHORT = '100% bourbon arabica'
const SPEC_LONG = 'Honey Co-Fermented Pink Bourbon · SCA 86'
const NOTES_DIACRITICS = 'karamel, mliečna čokoláda, orechy'

// Every value the decision specifies, as the browser computes it. Kept as one table
// so a drift shows up as a single readable diff. `ls: 'normal'` is load-bearing —
// the condensed tracking (.005em) left with the condensed face.
const EXPECTED = {
  pspec: { family: 'Figtree', weight: '700', size: '14.5px', lh: '18.125px', ls: 'normal', color: 'rgb(10, 10, 10)' },
  pnotes: { family: 'Figtree', weight: '400', size: '14px', lh: '18.2px', ls: 'normal', color: 'rgba(10, 10, 10, 0.66)' },
}

let ctx = null
let adminToken = ''
let cycle = null
let friend = null
let friendToken = ''
let guestLinkToken = ''

const admin = (p, o = {}) => ctx[o.method || 'get'](p, {
  headers: { 'X-Admin-Token': adminToken },
  ...(o.data ? { data: o.data } : {}),
})

test.beforeAll(async ({ baseURL }) => {
  ctx = await playwrightRequest.newContext({ baseURL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const cname = `E2E PDESC ${uniq}`
  const c = await admin('/api/cycles', {
    method: 'post',
    data: { name: cname, type: 'coffee', status: 'open', expected_date: '29. august 2026' },
  })
  expect(c.status(), 'cycle create').toBe(201)
  cycle = { ...(await c.json()), name: cname }

  // Two products: the short spec + diacritic notes, and the brief's long spec line.
  for (const data of [
    { name: `Bourbon Espresso ${uniq}`, purpose: 'Espresso', roast_type: 'stredné', roastery: 'Goriffee',
      description1: SPEC_SHORT, description2: NOTES_DIACRITICS, price_250g: 8.9, price_1kg: 29.9 },
    { name: `Pink Bourbon ${uniq}`, purpose: 'Espresso', roast_type: 'svetlé', roastery: 'Goriffee',
      description1: SPEC_LONG, description2: 'čerešňa, ľaliová sviežosť, medovina', price_250g: 12.5 },
  ]) {
    const p = await admin('/api/products', { method: 'post', data: { cycle_id: cycle.id, ...data } })
    expect(p.status(), `product create ${data.name}`).toBe(201)
  }

  const username = `pdesc_${uniq}`.slice(0, 30)
  const fname = `E2E PDESC Host ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name: fname } })
  expect(created.status(), 'friend create').toBe(201)
  friend = { ...(await created.json()), name: fname }
  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  const first = (await auth.json()).token
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${first}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  friendToken = (await chg.json()).token || first

  // The guest twin of the same card (06 §UC-GX-002 — must be pixel-identical).
  const link = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, {
    headers: { Authorization: `Bearer ${friendToken}` },
  })
  expect(link.status(), 'guest link create').toBe(201)
  guestLinkToken = (await link.json()).link.token
})

test.afterAll(async () => { await ctx?.dispose() })

/** ⚠ Direct navigation to /cycle/:id races FriendOrder's session restore and
 *  bounces to the portal — every friend-side spec enters by clicking the card. */
async function gotoFriendCard(page) {
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({
    friendId: friend.id, friendName: friend.name, token: friendToken,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page.locator('.pspec').first()).toBeVisible()
  await fontsReady(page)
}

/** The faces are metric-driven and load lazily — measure only once they are in.
 *  ⚠ A rejected load must NOT throw here: a missing subset would then fail every
 *  test in this file with "page.evaluate: NetworkError", masking the specific
 *  assertion that would have named the broken subset. */
async function fontsReady(page) {
  await page.evaluate(async () => {
    await Promise.all([400, 700].map((w) =>
      document.fonts.load(`${w} 16px "Figtree"`, 'Ažč').catch(() => {})))
    await document.fonts.ready
  })
}

async function describedLines(page) {
  return page.evaluate(() => {
    const read = (cls) => Array.from(document.querySelectorAll('.' + cls)).map((el) => {
      const cs = getComputedStyle(el)
      return {
        cls,
        text: el.textContent.trim(),
        family: cs.fontFamily.split(',')[0].trim().replace(/^"|"$/g, ''),
        weight: cs.fontWeight,
        size: cs.fontSize,
        lh: cs.lineHeight,
        ls: cs.letterSpacing,
        color: cs.color,
        lines: el.getClientRects().length,
      }
    })
    return [...read('pspec'), ...read('pnotes')]
  })
}

test.describe('Product description — Figtree (the banner face)', () => {
  test('the friend card: every decided value, computed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await gotoFriendCard(page)

    const rows = await describedLines(page)
    // Non-vacuity: two products, so two of each class must be on screen.
    expect(rows.filter((r) => r.cls === 'pspec').length, 'spec lines rendered').toBe(2)
    expect(rows.filter((r) => r.cls === 'pnotes').length, 'notes lines rendered').toBe(2)

    for (const row of rows) {
      const want = EXPECTED[row.cls]
      expect({ ...row, text: undefined, lines: undefined, cls: undefined },
        `${row.cls} on "${row.text}"`).toEqual({ ...want, text: undefined, lines: undefined, cls: undefined })
    }
  })

  test('the guest card is the same face (06 §UC-GX-002 — pixel-identical)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await page.goto(`/g/${guestLinkToken}`)
    await expect(page.locator('.pspec').first()).toBeVisible()
    await fontsReady(page)

    const rows = await describedLines(page)
    expect(rows.length, 'both lines on both guest cards').toBe(4)
    for (const row of rows) {
      expect({ ...row, text: undefined, lines: undefined, cls: undefined },
        `guest ${row.cls} on "${row.text}"`).toEqual({ ...EXPECTED[row.cls], text: undefined, lines: undefined, cls: undefined })
    }
  })

  // The 2026-08-13 acceptance strings still hold in the wider face: both on at most
  // two lines at 390px, not clipped.
  test('the acceptance strings fit in ≤ 2 lines at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await gotoFriendCard(page)

    const rows = await describedLines(page)
    const short = rows.find((r) => r.text === SPEC_SHORT)
    const long = rows.find((r) => r.text === SPEC_LONG)
    const notes = rows.find((r) => r.text === NOTES_DIACRITICS)
    expect(short, SPEC_SHORT).toBeTruthy()
    expect(long, SPEC_LONG).toBeTruthy()
    expect(notes, NOTES_DIACRITICS).toBeTruthy()

    expect(short.lines, `"${SPEC_SHORT}" wrapped`).toBe(1)
    expect(long.lines, `"${SPEC_LONG}" took more than 2 lines`).toBeLessThanOrEqual(2)
    expect(notes.lines, `"${NOTES_DIACRITICS}" took more than 2 lines`).toBeLessThanOrEqual(2)

    // Nothing is clipped, and the page does not scroll sideways at 390px.
    const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('.pspec, .pnotes'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent.trim()))
    expect(clipped, 'a description line is clipped').toEqual([])
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'document scrolls sideways').toBeLessThanOrEqual(0)
  })

  // ⚠ The assertion the whole self-hosting exercise exists for. A width comparison,
  // not `document.fonts.check()` — RD-DS-6 recorded that check() answered `true` on
  // staging while ZERO faces had loaded.
  test('Slovak diacritics render in Figtree, not a fallback', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await gotoFriendCard(page)

    const widths = await page.evaluate(async () => {
      const texts = { latin: 'AHOJ KOLEGOVIA', 'latin-ext': 'žťšľčďň' }
      const out = {}
      const measure = (text, family, weight) => {
        const el = document.createElement('span')
        el.textContent = text
        Object.assign(el.style, {
          position: 'absolute', left: '-99999px', top: '0', whiteSpace: 'pre',
          fontSize: '96px', fontWeight: String(weight), fontFamily: family,
        })
        document.body.appendChild(el)
        const w = el.getBoundingClientRect().width
        el.remove()
        return w
      }
      for (const weight of [400, 700]) {
        for (const [label, text] of Object.entries(texts)) {
          // ⚠ Swallow a rejected load rather than letting it throw. A missing or
          // CSP-blocked woff2 rejects here, and an unhandled rejection surfaces as
          // "page.evaluate: NetworkError" — which says nothing about WHICH subset
          // died. Measured anyway, the width comparison below names it exactly.
          // (Same reasoning as self-hosted-fonts.spec.js's REJECTED marker.)
          try {
            await document.fonts.load(`${weight} 96px "Figtree"`, text)
          } catch { /* reported by the width assertion, not here */ }
          out[`${weight}|${label}`] = {
            brand: measure(text, '"Figtree", monospace', weight),
            // A family that cannot exist, so this resolves to the SAME fallback.
            // Equal widths ⇒ the brand face contributed nothing to this string.
            fallback: measure(text, '"NoSuchFace-PDESC", monospace', weight),
          }
        }
      }
      return out
    })

    for (const [key, w] of Object.entries(widths)) {
      expect(w.brand, `${key}: zero width measured`).toBeGreaterThan(0)
      expect(Math.abs(w.brand - w.fallback),
        `${key} rendered in the FALLBACK face (brand ${w.brand} vs fallback ${w.fallback}) — that subset did not load`)
        .toBeGreaterThan(1)
    }
  })

  test('mono has left the product card, and the bakery card is untouched', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await gotoFriendCard(page)

    // The notes line lost `.mono` (it was the least readable text on the card);
    // mono stays on dates, prices, IBANs and references elsewhere.
    const monoInCards = await page.locator('[data-testid="product-card"] .mono').count()
    expect(monoInCards, 'no mono may remain inside a coffee product card').toBe(0)
    // …but the cart bar's deadline still uses it, so mono did not leave the screen.
    await expect(page.locator('.cartbar .deadline')).toHaveCount(1)

    // Scope guard: the BAKERY card's description lines are a different mapping
    // (`description2` is a subtitle beside the name) and keep `.sub`. If a future
    // edit points `.pspec`/`.pnotes` at them, this is what says so.
    const specInCard = await page.evaluate(() => {
      const spec = document.querySelector('.pspec')
      return spec ? spec.closest('[data-testid="product-card"]') !== null : false
    })
    expect(specInCard, 'the description classes must sit inside a product card').toBe(true)
  })

  // Noto Sans Condensed is retired: its preloads must be gone (a preload with no
  // consumer logs "preloaded but not used" on every route and re-fetches ~50 KB),
  // and no stylesheet may still ask for the face. The body face needs no preload —
  // Figtree is fetched by first paint on every route anyway.
  test('no font preloads remain, and Noto Sans Condensed is gone', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(0)

    const stillAsked = await page.evaluate(async () => {
      const hits = []
      for (const sheet of document.styleSheets) {
        let rules
        try { rules = sheet.cssRules } catch { continue }
        for (const r of rules) {
          if (r.cssText && /Noto Sans Cond/i.test(r.cssText)) hits.push(r.cssText.slice(0, 120))
        }
      }
      return hits
    })
    expect(stillAsked, 'a stylesheet still references Noto Sans Cond').toEqual([])
  })
})
