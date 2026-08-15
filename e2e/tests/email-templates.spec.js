import { test, expect } from '@playwright/test'
import {
  CAN_SPAWN_MAILER,
  startMailgunStub,
  multipartFields,
  renderViaTemplates,
} from '../mailgun-harness.js'

// EM-T2 / 08 §UC-EM-002 — `helpers/email-templates.js`, the reusable branded template
// layer (`renderEmail({ text, blocks }) → { text, html }`). Module 09 is the second
// consumer, so what is pinned here is the SEAM, not the credentials mail (that lives
// with its caller in invitation-approval.spec.js):
//
//   1. TEXT PASS-THROUGH `===`. The renderer returns the given `text` strictly
//      identical — no trim, no normalisation, no appended footer. This is the
//      mechanism behind 07 §UC-IA-006/009's clipboard/mail byte-identity, so it is
//      checked as REFERENCE IDENTITY inside the rendering process (a multipart capture
//      can prove byte equality but not `===`) AND as byte equality on the stub.
//   2. THE FOUR-BLOCK VOCABULARY (`paragraph`, `kv`, `button`, `small`) renders in the
//      caller's order, inside the shell (doctype, lang="sk", text wordmark with PULT
//      in #ff2d87, inline CSS only).
//   3. ESCAPING IS MANDATORY, attribute positions included. Block content includes
//      applicant-supplied strings; unescaped, an applicant could inject markup into an
//      e-mail sent from our DKIM-verified domain.
//   4. THROWING IS THE ONE ACCEPTABLE FAILURE MODE at this layer — a whitespace-only
//      `text` is the renderer's OWN error (the mailer would count it as "present" and
//      mail an html-only-in-spirit message), as are an unknown block type and a
//      missing/empty `blocks`. Every call site sits inside its route's mail try/catch,
//      so a throw degrades to `email:{sent:false}`, never a failed request — the
//      degrade itself is pinned on the real caller in invitation-approval.spec.js.
//
// HOW THESE RUN: no unit runner exists and none is added (01-architecture §Testing &
// gate). `renderViaTemplates` (shared harness) renders in a child process and sends
// the result through the REAL `sendMail()` to the stub, so the html assertions read
// the STUB-CAPTURED multipart body — the same interception model as EM-T1's mailer
// tests. Fixtures are per test (own stub each), per §UC-EM-005 item 6. Nothing here
// can send real mail: the child gets a fake key and a 127.0.0.1 MAILGUN_BASE_URL.

const SKIP_REASON = 'needs the backend source beside e2e/ (skipped against a deployment)'

test.describe('EM-T2 / 08 §UC-EM-002 — renderEmail: the seam module 09 builds on', () => {
  test('renders all four block types in order inside the branded shell, and passes the text through ===-identical', async () => {
    test.skip(!CAN_SPAWN_MAILER, SKIP_REASON)
    const stub = await startMailgunStub()
    try {
      const text = 'Ahoj — čšžľťďň v plain texte, s medzerou na konci. '
      const input = {
        text,
        blocks: [
          { type: 'paragraph', text: 'Prvý odsek — čšžľťďň.' },
          {
            type: 'kv',
            rows: [
              { label: 'Užívateľské meno', value: 'jan.kovac' },
              { label: 'Dočasné heslo', value: 'ABCDEF234567' },
            ],
          },
          { type: 'button', url: 'https://ok.test/prihlasenie' },
          { type: 'small', text: 'Drobný závěrečný riadok.' },
        ],
      }
      const result = await renderViaTemplates(stub, {
        input,
        send: { to: 'render@stub.invalid', subject: 'Šablóna' },
      })

      expect(result.ok, `renderEmail must not throw here: ${result.threw || ''}`).toBe(true)
      // ⚠ THE pass-through pin: the SAME string, checked in-process. A trailing-space
      // trim or an appended footer fails this even though the multipart capture below
      // would still "contain" the text.
      expect(result.textIdentical, 'renderEmail returns the given text ===-identical').toBe(true)
      expect(result.sendResult).toEqual({ sent: true, to: 'render@stub.invalid' })

      expect(stub.requests, 'one multipart message').toHaveLength(1)
      const fields = multipartFields(stub.requests[0])
      expect(fields.text, 'the text part, byte-exact incl. diacritics and the trailing space').toBe(text)

      const html = fields.html
      expect(html, 'the html part exists').toBeTruthy()

      // ── the shell ──
      expect(html.startsWith('<!DOCTYPE html>'), 'full document, doctype first').toBe(true)
      expect(html).toContain('<html lang="sk">')
      expect(html).toContain('<meta charset="utf-8">')
      expect(html, 'wordmark as TEXT, PULT in the accent').toMatch(/POD<span style="[^"]*#ff2d87[^"]*">PULT<\/span>OVKA/)
      expect(html, 'page bg — brand token').toContain('#fff8f3')
      expect(html, 'the 3px ink border is the guaranteed brand carrier').toMatch(/border:\s*3px solid #0a0a0a/)

      // ── every block's content, in the caller's order ──
      const positions = [
        'Prvý odsek — čšžľťďň.',
        'Užívateľské meno',
        'jan.kovac',
        'Dočasné heslo',
        'ABCDEF234567',
        'https://ok.test/prihlasenie',
        'Drobný závěrečný riadok.',
      ].map((needle) => {
        const at = html.indexOf(needle)
        expect(at, `"${needle}" is in the html`).toBeGreaterThan(-1)
        return at
      })
      expect([...positions].sort((a, b) => a - b), 'blocks render in the given order').toEqual(positions)

      // ── the button: href in an attribute, URL-as-label (the unsigned-copy OPEN),
      //    and the plain-text URL line under it for clients that mangle buttons ──
      expect(html).toContain('href="https://ok.test/prihlasenie"')
      const urlMentions = html.split('https://ok.test/prihlasenie').length - 1
      expect(urlMentions, 'href + visible label + plain-text line').toBeGreaterThanOrEqual(3)

      // ── kv values ride the mono stack ──
      expect(html, 'mono stack on kv values').toContain("'Courier New', Courier, monospace")

      // ── §UC-EM-002's closed carrier list: zero remote subresources ──
      for (const marker of ['<img', '<link', '<style', '@import', 'url(', 'src=']) {
        expect(html, `no ${marker} in mail html`).not.toContain(marker)
      }
      const foreign = (html.match(/https?:\/\/[^\s"'<>&]+/g) || [])
        .filter((u) => !u.startsWith('https://ok.test/prihlasenie'))
      expect(foreign, 'no http(s) reference other than the button URL').toEqual([])

      expect(result.htmlLength, 'far under the ~102 KB Gmail clip').toBeLessThan(100_000)
    } finally {
      await stub.stop()
    }
  })

  test('⚠ escaping is mandatory for EVERY interpolation, attribute positions included', async () => {
    test.skip(!CAN_SPAWN_MAILER, SKIP_REASON)
    const stub = await startMailgunStub()
    try {
      // The spec's own hostile value in a body position, an attribute-breaking URL in
      // the href position, and quote/entity torture in kv + button label + small.
      const input = {
        text: 'plain',
        blocks: [
          { type: 'paragraph', text: '"><script>alert(1)</script>' },
          {
            type: 'kv',
            rows: [{ label: 'Meno & "titul"', value: `<b>tučné</b> & 'apostrof'` }],
          },
          {
            type: 'button',
            url: 'https://ok.test/x?q="onmouseover="alert(1)',
            label: '"><script>alert(2)</script>',
          },
          { type: 'small', text: '<img src=x onerror=alert(3)>' },
        ],
      }
      const result = await renderViaTemplates(stub, {
        input,
        send: { to: 'hostile@stub.invalid', subject: 'Escaping' },
      })
      expect(result.ok, `renderEmail must not throw on hostile CONTENT: ${result.threw || ''}`).toBe(true)

      const html = multipartFields(stub.requests[0]).html

      // Raw markup never survives — the §UC-EM-002 acceptance literal.
      expect(html, 'no raw <script').not.toContain('<script')
      expect(html, 'no raw <img').not.toContain('<img')
      expect(html, 'no raw <b> from the kv value').not.toContain('<b>')
      // …and the escaped forms are what arrived (non-vacuity for the three above).
      expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(html).toContain('&lt;b&gt;tučné&lt;/b&gt; &amp; &#39;apostrof&#39;')
      expect(html).toContain('Meno &amp; &quot;titul&quot;')
      expect(html).toContain('&lt;img src=x onerror=alert(3)&gt;')

      // ⚠ THE ATTRIBUTE POSITION: the href's quotes are escaped, so the hostile URL
      // cannot break out of the attribute and mint an onmouseover of its own. Exactly
      // one href exists and its raw value is the fully escaped URL.
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
      expect(hrefs, 'exactly one href in the document').toHaveLength(1)
      expect(hrefs[0]).toBe('https://ok.test/x?q=&quot;onmouseover=&quot;alert(1)')
      expect(html, 'no attribute breakout anywhere').not.toContain('"onmouseover=')
    } finally {
      await stub.stop()
    }
  })

  test('⚠ the throw cases: whitespace-only text, missing text, unknown block type, missing blocks', async () => {
    test.skip(!CAN_SPAWN_MAILER, SKIP_REASON)
    const stub = await startMailgunStub()
    try {
      const goodBlocks = [{ type: 'paragraph', text: 'ok' }]
      const cases = [
        // ⚠ Whitespace-only is the renderer's OWN error (EM-T1 review note): the
        // mailer counts '   ' as a PRESENT text part, so only the renderer stands
        // between a template bug and mailing a blank-text multipart.
        ['whitespace-only text', { text: '   \n\t ', blocks: goodBlocks }],
        ['empty text', { text: '', blocks: goodBlocks }],
        ['missing text', { blocks: goodBlocks }],
        ['non-string text', { text: 42, blocks: goodBlocks }],
        ['unknown block type', { text: 'ok', blocks: [{ type: 'hero', text: 'x' }] }],
        ['missing blocks', { text: 'ok' }],
        ['empty blocks', { text: 'ok', blocks: [] }],
        ['non-array blocks', { text: 'ok', blocks: 'paragraph' }],
        ['button without url', { text: 'ok', blocks: [{ type: 'button' }] }],
        ['kv without rows', { text: 'ok', blocks: [{ type: 'kv' }] }],
      ]
      for (const [label, input] of cases) {
        const result = await renderViaTemplates(stub, { input })
        expect(result.ok, `${label} ⇒ renderEmail throws`).toBe(false)
        expect(result.threw, `${label} ⇒ a named error, not a crash`).toBeTruthy()
      }
      // Throwing means no send was ever attempted — every call site's try/catch sees
      // the throw before sendMail runs.
      expect(stub.requests, 'a refused render mails nothing').toHaveLength(0)
    } finally {
      await stub.stop()
    }
  })
})
