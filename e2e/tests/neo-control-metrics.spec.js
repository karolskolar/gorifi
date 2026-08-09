import { test, expect } from '@playwright/test'

// RD-DS-5 — the two module-02 amendments, pinned in a browser.
//
// (A) 02 §UC-DS-001 adaptation **A9**: `.inp` and `.btn` must render at the
//     CANON's heights. Tailwind preflight ships
//     `button,input,optgroup,select,textarea{line-height:inherit}` on top of
//     `html{line-height:1.5}`; the prototype has neither, so its controls compute
//     the UA default `normal` (~1.2). Measured in the live prototype over HTTP:
//     `.inp` 48px, `.btn` 44px, `.btn.sm` 38px, all at `line-height: normal`.
//     Inherited 1.5 inflated them to 52.5 and 47 — a silent 4.5px / 3px fidelity
//     drift that no other assertion in the suite would have caught. If a future
//     Tailwind bump, a `@layer` change or an import-order edit re-inflates them,
//     this file fails instead of the next screenshot comparison.
//
//     `line-height: normal` is asserted EXACTLY (that is the mechanism, and it is
//     font-independent); the pixel heights carry a 1px tolerance so a webfont
//     metric wobble cannot make the suite flaky. The inflation this guards
//     against is 3–4.5px, well outside it.
//
// (B) 02 §UC-DS-006 amendment: `BrandChrome`'s new `titlesAction` affordance is
//     strictly OPT-IN. No consumer opts in yet (RD-FL-3 does), so what this file
//     pins is the negative: the shipped appbar must carry no `role`, no
//     `tabindex` and no `cursor:pointer` on `.titles`. The positive path — slot
//     order and keyboard activation — belongs to the first consuming screen.
//
// ⚠ Like `modern-login.spec.js`, this file NEVER WRITES `auth_mode`. The shared
// seed is legacy and other specs assert that. It stubs `GET /friends/auth-mode`
// per `page` so the modern login card (the only shipped surface with `.inp`)
// renders, and touches no server state at all.

// The canon, measured in `docs/design/friends-portal-redesign/Podpultovka
// Friends.html` served over HTTP (file:// breaks it — Babel XHRs the .jsx).
const CANON = {
  inp: 48,
  btn: 44,
  btnSm: 38,
}

// UC-DS-005 hit-target minima. Shrinking to the canon must not cross these.
const MIN = {
  btn: 44,
  btnSm: 38,
  btnGhost: 38,
  inp: 46,
}

const near = (actual, expected, what) =>
  expect(Math.abs(actual - expected), `${what}: got ${actual}, canon ${expected}`).toBeLessThanOrEqual(1)

test.beforeEach(async ({ page }) => {
  await page.route('**/friends/auth-mode', (route) =>
    route.fulfill({ json: { authMode: 'modern' } })
  )
  await page.addInitScript(() => localStorage.clear())
})

test.describe('A9 — .inp / .btn render at the canon heights (UC-DS-001)', () => {
  test('the shipped login card: .inp is 48px and .btn 44px, both at line-height normal', async ({ page }) => {
    await page.goto('/')
    const username = page.getByLabel(/^užívateľské meno$/i)
    await expect(username).toBeVisible()
    // Webfonts change the line box; wait for them before measuring.
    await page.evaluate(() => document.fonts.ready)

    for (const field of [username, page.getByLabel(/^heslo$/i)]) {
      await expect(field).toHaveCSS('line-height', 'normal')
      const box = await field.boundingBox()
      near(box.height, CANON.inp, '.inp height')
      expect(box.height, 'UC-DS-005: inputs ≥46px').toBeGreaterThanOrEqual(MIN.inp)
    }

    const submit = page.getByRole('button', { name: 'Prihlásiť sa' })
    await expect(submit).toHaveCSS('line-height', 'normal')
    const btnBox = await submit.boundingBox()
    near(btnBox.height, CANON.btn, '.btn.accent.block height')
    expect(btnBox.height, 'UC-DS-005: .btn ≥44px').toBeGreaterThanOrEqual(MIN.btn)
  })

  test('every .btn variant + .inp, in both scopes, matches the canon and clears the minima', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByLabel(/^užívateľské meno$/i)).toBeVisible()
    await page.evaluate(() => document.fonts.ready)

    // Probes are injected into a REAL `.app` and a REAL `.modal-layer` inside the
    // shipped page, so the cascade measured is exactly the shipped one (preflight
    // + style.css + friends-theme.css, in the shipped order). `.modal-layer` is
    // measured too because it is a SEPARATE scope root — it is portaled outside
    // `.app`, so a fix that only reached `.app` would leave every modal inflated.
    const rows = await page.evaluate(() => {
      const variants = [
        ['input', 'inp'],
        ['input', 'inp mono'],
        ['button', 'btn'],
        ['button', 'btn sm'],
        ['button', 'btn ghost'],
        ['button', 'btn ghost sm'],
        ['button', 'btn accent'],
        ['button', 'btn ok'],
        ['button', 'btn dark'],
        ['button', 'btn danger'],
        ['button', 'btn block'],
        ['button', 'btn accent block'],
      ]
      const out = []
      for (const scope of ['app', 'modal-layer']) {
        const host = document.createElement('div')
        host.className = scope
        host.setAttribute('data-rdds5-probe', '1')
        host.style.cssText = 'position:absolute;left:-3000px;top:0;width:400px'
        document.body.appendChild(host)
        for (const [tag, cls] of variants) {
          const el = document.createElement(tag)
          el.className = cls
          if (tag === 'button') el.textContent = 'Text'
          else el.value = 'Text'
          host.appendChild(el)
          out.push({
            scope,
            cls,
            height: el.getBoundingClientRect().height,
            lineHeight: getComputedStyle(el).lineHeight,
          })
        }
      }
      for (const n of document.querySelectorAll('[data-rdds5-probe]')) n.remove()
      return out
    })

    expect(rows.length).toBe(24)
    for (const r of rows) {
      const at = `${r.scope} .${r.cls.split(' ').join('.')}`
      expect(r.lineHeight, `${at}: A9 must reach this rule`).toBe('normal')

      if (r.cls === 'inp' || r.cls === 'inp mono') {
        expect(r.height, `${at}: UC-DS-005 inputs ≥46px`).toBeGreaterThanOrEqual(MIN.inp)
      }
      if (r.cls === 'inp') near(r.height, CANON.inp, `${at} height`)

      if (r.cls.startsWith('btn')) {
        const small = r.cls.includes('sm') || r.cls.includes('ghost')
        expect(
          r.height,
          `${at}: UC-DS-005 hit target ≥${small ? MIN.btnSm : MIN.btn}px`
        ).toBeGreaterThanOrEqual(small ? MIN.btnSm : MIN.btn)
      }
      if (r.cls === 'btn') near(r.height, CANON.btn, `${at} height`)
      if (r.cls === 'btn sm') near(r.height, CANON.btnSm, `${at} height`)
    }
  })
})

test.describe('UC-DS-006 — the titles affordance is opt-in', () => {
  test('an appbar that does not opt in gains no role, tabindex or pointer cursor', async ({ page }) => {
    await page.goto('/')
    const titles = page.locator('.appbar .titles')
    await expect(titles).toBeVisible()

    await expect(titles).not.toHaveAttribute('role', /.*/)
    await expect(titles).not.toHaveAttribute('tabindex', /.*/)
    await expect(titles).not.toHaveAttribute('aria-label', /.*/)
    await expect(titles).toHaveCSS('cursor', 'auto')

    // …and it is genuinely not in the tab order: focus stays on the first real
    // control of the page rather than landing on the titles block.
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => {
      const a = document.activeElement
      return { inTitles: !!a && !!a.closest('.appbar .titles'), tag: a ? a.tagName : 'NONE' }
    })
    expect(focused.inTitles, `Tab landed inside .titles (${focused.tag})`).toBe(false)
  })
})
