# 08 — Transactional e-mail: branded multipart layer + canonical domain

> Scope: The reusable branded-e-mail foundation on top of `helpers/mailer.js`: the
> `sendMail()` extension to an optional `html` part (multipart, **plain text always
> present**), the new `helpers/email-templates.js` template layer
> (`renderEmail({…}) → { text, html }` — deliberately NOT credentials-specific, module 09
> reuses it), the restyle of the credentials mail onto that layer without breaking the
> 07 §UC-IA-006/009 "mail and clipboard byte-identical by construction" contract, and the
> `PUBLIC_BASE_URL=https://podpultovka.biz` deployment pin that fixes the wrong-domain
> bug (`resolveLoginUrl()` today falls through to the admin browser's Origin, which on
> the legacy domain yields `https://gorifi.skolar.sk` in outbound mail — a **config gap,
> not a code bug**; confirmed 2026-08-14). ⚠ Like 07, this module INCLUDES backend +
> config changes (00-overview §Scope extension). Out of scope (handoffs): the
> **magic-link mail's content** and trigger (module 09 — this module only hands it the
> seam in §Seam for module 09); **any new mail trigger** (the credentials mail stays the
> only send); **SPF/DKIM/DNS** (already Mailgun-verified per 07 §UC-IA-009); **admin mail
> UI** (the approval dialog's outcome line from 07 §UC-IA-009 is unchanged — this module
> has **zero frontend changes**).
> Actors: **Admin** — triggers the only send (approval); sees the unchanged
> `email` outcome in the dialog. **Applicant/Friend** — the recipient; reads the mail in
> an arbitrary client (Gmail, Outlook, mobile), which is why deliverability constraints
> bind harder than the design canon. **Operator** — owns the `.env` pin (UC-EM-004).
> Sources: product-owner brief 2026-08-14 (screenshot of the current mail: sender
> "Podpultovka", subject "Tvoj účet v Podpultovke je pripravený", one unformatted
> plain-text paragraph linking to `https://gorifi.skolar.sk`); `00-overview.md` §Scope
> extension + file index row 08; `01-architecture.md` §Auth extensions → E-mail layer
> (the contract this file elaborates) + §Shared services (Mailgun bullet) + §Testing &
> gate; `07-invitation-approval.md` §UC-IA-006 (signed clipboard message) + §UC-IA-009
> (the existing send this module upgrades); repo code
> (`backend/src/helpers/mailer.js` — the three rules, `helpers/credentials-message.js` —
> `credentialsMessage()` + `resolveLoginUrl()`, `routes/invitations.js` approve mail
> block); `e2e/tests/invitation-approval.spec.js` (the Mailgun stub-server harness the
> acceptance criteria extend); repo `CLAUDE.md`. The most recent decision wins on conflict.
> **Design reference:** no prototype screen exists — e-mail has no design-canon page.
> The HTML part *approximates* Neobrutal PP from 02-design-system's tokens (ink
> `#0a0a0a`, accent `#ff2d87`, bg `#fff8f3`, 3px ink borders) within e-mail-client
> constraints; the halftone texture, self-hosted webfonts and offset-shadow chrome do
> NOT survive mail clients and are deliberately not attempted (UC-EM-002).

---

## Resolved conflicts (recency / canonicity)

1. **The wrong domain in the mail is a configuration gap, not a code bug** (confirmed
   2026-08-14). `resolveLoginUrl()` already prefers `PUBLIC_BASE_URL` and already falls
   back to `https://podpultovka.biz`; the middle branch (allowlisted request `Origin`)
   is what produced `gorifi.skolar.sk` — the admin approved from the legacy domain and
   that origin is allowlisted. Resolution: **pin, don't patch** — UC-EM-004 sets
   `PUBLIC_BASE_URL` in production; `resolveLoginUrl()`'s three-step logic is untouched
   (its Origin branch remains correct behaviour for deployments with no pin).
2. **07's "SMTP delivery" follow-up chain ends here.** 07 §UC-IA-009 shipped the send;
   this module ships its *formatting*. Nothing in 07 is reopened: the mailer's three
   rules, the result-shape vocabulary, the dialog's four outcome renderings and the
   "mail failure never fails the approval" rule all survive verbatim.
3. **The design canon does not extend into mail.** 02-design-system's fonts/halftone/
   shadow rules are browser rules built on self-hosted assets and `<style>` blocks; mail
   clients strip `<style>` and the CSP-equivalent decision for mail is "no remote
   subresources at all" (UC-EM-002). Where the canon and deliverability conflict,
   deliverability wins — the brand is *approximated*, never loaded.

---

## UC-EM-001 `sendMail()` — optional `html` part (system)

**Goal:** `helpers/mailer.js` grows the one capability the template layer needs, and
nothing else moves.

**Business rules:**

- Signature becomes `sendMail({ to, subject, text, html })`. `html` is **optional**;
  when it is a non-empty string, `form.set('html', String(html))` is added to the
  existing form. Mailgun assembles the MIME `multipart/alternative` from the `text` +
  `html` form fields itself — the mailer never builds MIME.
- ⚠ **The plain-text part is ALWAYS present — the deliverability baseline.** `text`
  stays a first-class field set on every send exactly as today. An `html` value with an
  empty/absent `text` is a programming error: the mailer **drops the `html` field** and
  sends text-only (i.e. exactly today's behaviour) — it must never send an html-only
  message, and per rule 3 below it must not throw over it.
- **Tracking is disabled per message:** `form.set('o:tracking-clicks', 'no')` and
  `form.set('o:tracking-opens', 'no')` on every send (text-only included). Derived from
  two confirmed decisions, not invented: open-tracking injects a **remote tracking
  pixel** into the html (violating "no remote images", UC-EM-002), and click-tracking
  **rewrites hrefs** through the sending domain (violating "the canonical
  `podpultovka.biz` URL in outbound mail", UC-EM-004). The per-message flags make the
  outcome deterministic regardless of the Mailgun account's domain-level settings.
- **All three mailer rules survive verbatim** (they are the file's stated reason to
  exist): (1) disabled by default — no-op with any of the three env vars missing, which
  is what keeps the e2e suite from ever sending real mail; (2) the API key never leaves
  the module — not in results, logs, or errors, `redact()` stays; (3) it never throws —
  every path returns a result object. The **result-shape vocabulary is unchanged**:
  `{sent:true,to}` / `skipped:'no_recipient'|'not_configured'` /
  `error:'invalid_recipient'|'timeout'|'network'|'HTTP <status>'`. The three-check
  ordering (recipient → config → validity) is load-bearing per the in-file comments and
  is untouched.
- No new dependency (the 01-architecture rule: no nodemailer, no Mailgun SDK, no
  templating engine — Node 20's `fetch`/`FormData` remain the whole transport).

**Acceptance criteria (Playwright, stub harness — see UC-EM-005):** a send with `html`
produces ONE stub request whose `multipart/form-data` body contains BOTH a `text` and an
`html` field plus `o:tracking-clicks=no` and `o:tracking-opens=no`; a send without
`html` contains a `text` field and **no** `html` field (existing text-only callers
byte-unchanged); `html` with empty `text` sends text-only; all pre-existing
`invitation-approval.spec.js` stub tests (no-op, 500-degrade, key-never-leaks) pass.

---

## UC-EM-002 `helpers/email-templates.js` — the reusable brand template (system)

**Goal:** ONE server-side renderer that turns structured content into `{ text, html }`,
usable by any transactional mail (module 09 is the second consumer).

**The seam:**

```js
renderEmail({ text, blocks }) → { text, html }
```

- **`text` (required, non-empty string):** the plain-text part, supplied by the caller
  and returned **unchanged — the same string, no trim, no normalisation, no appended
  footer**. ⚠ This pass-through is the mechanism that preserves 07's byte-identity
  contract (UC-EM-003): the renderer never generates or rewrites the text part, so a
  caller whose text is a signed sentence keeps it signed.
- **`blocks` (required, ordered array):** the HTML part's content, from a small closed
  vocabulary:
  - `{ type: 'paragraph', text }` — body paragraph.
  - `{ type: 'kv', rows: [{ label, value }] }` — label/value rows, values in the mono
    stack (credentials, references).
  - `{ type: 'button', url, label? }` — the CTA. `label` defaults to `url` itself —
    link text matching the href is both a deliverability signal and the way this module
    avoids inventing unsigned Slovak copy. The visible URL also renders as a plain-text
    line under the button so a client that mangles the button still shows a copyable
    address.
  - `{ type: 'small', text }` — de-emphasised footer-size line.
- The renderer is a **pure synchronous function** (plain template literals — the
  01-architecture no-templating-engine rule): no I/O, no env reads, no DB. Copy, URLs
  and register are entirely the caller's — the layer carries **no credentials-specific
  and no register-specific content**, which is what makes it module 09's foundation.
- An unknown `type` or an empty `text` argument may `throw` — this is the one layer
  where throwing is acceptable, because every call site MUST sit inside its route's
  existing mail `try/catch` (the approve route's second-layer catch degrades to
  `{sent:false,error:'network'}` — UC-EM-003 rule 4), so a render bug degrades to
  "send it by hand", never to a failed request.

**The HTML shell (wrapped around the blocks):**

- Full document: `<!DOCTYPE html>`, `<html lang="sk">`, `<meta charset="utf-8">`.
- **Table layout, inline CSS only.** No `<style>` element, no classes, no `<link>`, no
  `@import`, no `url(...)` — mail clients (Gmail clips, Outlook uses Word's engine)
  strip or ignore them; every style that matters is an inline `style=""` (plus the
  legacy `bgcolor`/`width` HTML attributes where Outlook needs them).
- ⚠ **ZERO remote subresources — no images at all in this phase** (there is no
  e-mail-safe brand asset; the wordmark is text), no webfonts, no remote CSS. This is
  the mail-side analogue of the RD-DS-6 self-hosted-CSP rule, and it also guarantees
  the mail is never "image-only" (a spam signal) — the text IS the content.
- **Brand approximation** (tokens from 02-design-system, carriers downgraded to what
  survives mail): page bg `#fff8f3`; content card white on a **3px solid `#0a0a0a`
  border** (the border is the guaranteed brand carrier — `box-shadow` is stripped by
  Outlook and may be added only as progressive enhancement, never as the sole signal);
  accent `#ff2d87` for the wordmark's PULT and the button bg; text ink `#0a0a0a`.
- **Wordmark as text:** `POD**PULT**OVKA` — bold uppercase, PULT in `#ff2d87` via an
  inline-styled `<span>`. System font stacks only: body
  `-apple-system, 'Segoe UI', Roboto, Arial, sans-serif`; mono (kv values)
  `'Courier New', Courier, monospace`.
- Single-column, content table `width="560"` max (fluid below), ≥16px base font —
  readable on phones without a viewport meta.
- Rendered `html` stays far under **100 KB** (Gmail clips at ~102 KB and clipping
  severs any content below the fold; trivially satisfied, asserted anyway).

**Security rule — HTML escaping:**

- ⚠ **Every interpolated value is HTML-escaped** (`& < > " '`), attribute positions
  included. Block content includes **applicant-supplied strings** (the invitation's
  `name`, a requested username) — unescaped, an applicant could inject markup into an
  e-mail sent *from our DKIM-verified domain*, the same class of phishing risk
  `resolveLoginUrl()`'s allowlist check exists to prevent. `button.url` values must be
  server-derived (`resolveLoginUrl()`, a server-minted token link) — never text from a
  request body.

**Acceptance criteria:** `renderEmail(...)` returns the input `text` **strictly
identical** (`===`-equivalent) and an `html` string containing the doctype,
`lang="sk"`, the wordmark with PULT in `#ff2d87`, and every block's content in order;
the html contains **no** `<img`, `<link`, `<style`, `@import`, `url(`, `src=`, or
`http(s)://` reference other than `button` URLs; a block value of
`"><script>alert(1)</script>` appears only escaped (no raw `<script` in the html);
output html < 100 KB. (Asserted through the stub's captured body in UC-EM-005 —
this repo has no unit runner and none is added.)

---

## UC-EM-003 The credentials mail on the template layer (Admin → Applicant)

**Goal:** the mail from `POST /api/invitations/:id/approve` gains the branded HTML part
— with the clipboard contract intact.

**Business rules:**

1. **The text part IS `credentialsMessage()`, untouched.** `credentials-message.js`
   keeps sole ownership of the product-owner-signed ty-form sentence (07 §UC-IA-006 —
   verbatim, plain hyphen, do not reword; ty-form is that string's signed exception to
   the vy-form register) and of `CREDENTIALS_EMAIL_SUBJECT`. The approve route still
   renders the sentence once, mails it as `text`, and returns it as
   `credentials_message` for the dialog's copy button.
2. **How HTML fits the byte-identity contract:** the contract binds the **clipboard and
   the mail's text part** — both remain the one `credentialsMessage()` output, identical
   by construction because `renderEmail()` passes `text` through unchanged (UC-EM-002)
   and the route hands both consumers the same string. The HTML part is a **third
   presentation of the same variables** (`loginUrl`, `username`, `tempPassword`) —
   composed from those variables, never parsed out of the sentence, and **never part of
   the clipboard** (the copy button copies plain text only; no frontend change).
3. **HTML composition — fragments of the signed sentence only, no new copy:**
   - `paragraph`: `Ahoj, tvoj účet je pripravený.` (verbatim opening fragment).
   - `kv`: `Užívateľské meno` → `{username}`, `Dočasné heslo` → `{tempPassword}` (the
     sentence's own noun phrases as labels, values in mono).
   - `paragraph`: `Prihlás sa na:` (the sentence's own verb phrase) followed by a
     `button` with `url = loginUrl` and the default URL-as-label (no unsigned button
     copy invented — see OPEN below).
   - `paragraph`: `Po prvom prihlásení si nastav vlastné heslo.` (verbatim closing).
4. ⚠ **Rendering happens inside the existing mail `try/catch`** in the approve route
   (the block at `invitations.js` ~440), so a template bug degrades to
   `email: {sent:false,error:'network'}` and the dialog's "send it by hand" warning —
   never a failed approval, never a lost plaintext (the 07 §UC-IA-009 product decision).
   The send stays **after the transaction commits** (the IA-T3 two-writes invariant).
5. Everything else in the approve contract is unchanged: recipient resolution,
   `no_recipient`/`not_configured` handling, the 201 shape
   (`friend`, `username`, `tempPassword`, `login_url`, `credentials_message`, `email`),
   and the dialog's four outcome renderings from 07 §UC-IA-009.

- `OPEN:` should the HTML part carry any copy beyond the signed sentence's fragments —
  a button label (e.g. "Prihlásiť sa"), a footer line explaining why the recipient got
  the mail, a preheader? Each would be **new user-facing Slovak copy requiring
  product-owner sign-off** (the 07 precedent: both credential strings were explicitly
  signed 2026-08-13). Until signed, the module ships with sentence fragments + the
  URL-as-label default only.

**Acceptance criteria (stub harness):** approving an invitation with an e-mail produces
ONE stub request whose `text` field is **byte-identical** to the 201's
`credentials_message`; the `html` field contains the escaped `username`, the
`tempPassword`, and the closing sentence verbatim; the login URL in the `text` field,
the `html` field's button `href`, and the 201's `login_url` are all the **same origin**
(the harness's `PUBLIC_BASE_URL`); an invitation whose name contains markup renders it
escaped in the html; `skipped`/`error` paths still return 201 with the friend created.

---

## UC-EM-004 `PUBLIC_BASE_URL` — the canonical-domain deployment pin (Operator)

**Goal:** outbound mail names `podpultovka.biz`, never the legacy domain, regardless of
which allowlisted origin the admin happens to approve from.

**Business rules:**

- **Production:** `/var/www/gorifi/.env` gains
  `PUBLIC_BASE_URL=https://podpultovka.biz`. This is a **deployment requirement and
  part of this module's acceptance** (01-architecture §E-mail layer). Mechanism:
  `resolveLoginUrl()` step 1 short-circuits before the Origin branch that today leaks
  `gorifi.skolar.sk`; no code change to the resolver.
- ⚠ The `.env` files live **outside** the directory `deploy.sh` rsyncs with
  `--delete` (07 §UC-IA-009's warning — a `backend/.env` would be deleted on every
  deploy) and are loaded via `node_args: --env-file-if-exists` in
  `deploy/ecosystem.config.cjs`; the pin is an **edit on the server**, not a repo file.
  Mode/ownership conventions as established there (600, `gorifi`).
- **One boot line** reports the resolution — following the mailer's own precedent
  ("one line at boot is the only signal the env plumbing worked", `mailer.js:59`):
  e.g. `[mail] PUBLIC_BASE_URL=https://podpultovka.biz` when set, or
  `[mail] PUBLIC_BASE_URL unset — login URLs fall back to request Origin / brand
  default`. Without it, a fresh container silently regresses to Origin-derived URLs and
  nothing surfaces until a recipient reports the wrong domain again — the exact failure
  mode that opened this module. (Value is public config; nothing sensitive is printed.)
- A backend **restart** after the edit is required for the pin to take effect (env is
  read at boot/request time in-process; the deploy runbook already restarts).
- **RESOLVED (product owner, 2026-08-15): staging pins the SAME value as production** —
  `PUBLIC_BASE_URL=https://podpultovka.biz` in `/var/www/gorifi-staging/.env`. Rationale:
  the Mailgun free tier permits one sending domain, so both environments share
  `MAILGUN_DOMAIN` and the operator chose not to differentiate the link target either.
  ⚠ Recorded consequence: a staging-sent approval e-mail links the recipient to
  PRODUCTION — acceptable because staging normally runs with no Mailgun env at all
  (mailer no-op); the pin only matters on the rare occasion staging mail is deliberately
  enabled for a test.

**Acceptance criteria:** the e2e harness (which sets `PUBLIC_BASE_URL` per throwaway
backend) proves the mechanism: `login_url` in the approve 201 and the URL inside both
stub-captured mail parts equal the configured value, ignoring the request's Origin.
The **literal production value cannot be e2e'd** — it is operator-verified per
§Verification procedure: `grep PUBLIC_BASE_URL /var/www/gorifi/.env` on the server, the
boot line in `/var/log/gorifi/out.log`, and one real approval whose received mail links
`https://podpultovka.biz` (the 07 deploy lesson applies: judge the deploy by the
artefact on the server, never by a filtered exit code).

---

## UC-EM-005 Verification (system)

**Goal:** how the implementing tasks prove this module. **This repo has no unit-test
runner and none is added** (01-architecture §Testing & gate) — acceptance is Playwright
e2e against the **Mailgun stub harness** already local to
`e2e/tests/invitation-approval.spec.js` (`startMailgunStub()` + `withMailHarness()`:
throwaway backend, `MAILGUN_BASE_URL` on 127.0.0.1, env blanked first so an ambient
real key can never be inherited).

**Obligations:**

1. **Extend the stub-harness describe** (in `invitation-approval.spec.js`, or a new
   `email-templates.spec.js` that reuses the harness — if extracted, extract the
   harness functions rather than forking them) with UC-EM-001/002/003's criteria. The
   stub captures the raw `multipart/form-data` body as one UTF-8 string
   (`setEncoding('utf8')` — the diacritics-across-chunk-boundary note in the harness
   stands); field extraction is boundary/`Content-Disposition: form-data;
   name="html"` parsing over that capture.
2. **Byte-identity end-to-end:** the stub-captured `text` field `===` the 201's
   `credentials_message` — this is the one assertion that pins the clipboard/mail
   contract across the whole stack (renderer pass-through + route single-render).
3. **Domain in both parts:** with the harness's `PUBLIC_BASE_URL`, assert the origin
   appears in the `text` field, in the `html` field's href, and as `login_url` — and
   that no other `http(s)://` host appears anywhere in the html (the no-remote-assets
   pin, which also catches a future CDN link the way `self-hosted-fonts.spec.js` does
   for the browser).
4. **No regression on the three mailer rules:** the existing stub tests (no-op with
   env absent = zero requests; Mailgun 500 ⇒ 201 + warning + copy button; API key in no
   response body and no log line) pass unchanged — the suite still **never sets real
   `MAILGUN_*` vars**.
5. **`node --check`** on every changed backend file (`mailer.js`,
   `email-templates.js`, `invitations.js`).
6. Fixtures per test, not a shared `beforeAll` (the GSO-T8 Playwright worker-restart
   lesson); all four rate-limit env vars raised for local runs; output piped to a file,
   never `| tail`.

**Manual procedure (operator, after deploy):** pin the prod `.env` (UC-EM-004) →
restart → boot line present → approve a real invitation to a real inbox → the mail
renders branded in Gmail *and* one non-Gmail client (Outlook or iOS Mail — table/inline
constraints are exactly the things a single-client check misses), links
`https://podpultovka.biz`, and the plain-text alternative (visible via "show original")
is the signed sentence.

---

## Seam for module 09 (magic-link recovery)

What this module **exposes** and what 09 must **supply** — stated here so both sides of
the seam can be verified when 09 lands:

- **Exposed:** `renderEmail({ text, blocks }) → { text, html }` with the four-block
  vocabulary (`paragraph`, `kv`, `button`, `small`), the escaping guarantee, and the
  text pass-through guarantee; `sendMail({ to, subject, text, html })` with the
  unchanged result vocabulary and the three rules; `resolveLoginUrl(req)` for deriving
  the portal origin (09's magic-link URL is built on the same base, so the UC-EM-004
  pin covers it automatically).
- **09 supplies:** its own subject, its own signed plain-text `text` (register is 09's
  copy decision — the layer carries none), and its own blocks (expected shape: a
  `paragraph`, a `button` whose `url` is the server-minted single-use link, a `small`
  TTL/ignore-if-not-you note). 09 calls the seam inside its own try/catch and maps the
  mailer result into its **enumeration-safe** response per 01-architecture (the mail
  outcome must not leak whether an account matched — that mapping is 09's rule, not the
  layer's).
- **The layer must not grow credentials-specific or link-specific logic** to serve 09 —
  a needed capability becomes a new block type, never a special case.

---

## Accepted risks / follow-ups (recorded, not silently implemented)

- **No visual-regression tooling for mail** (mirrors the repo's no-pixel-CI rule):
  client rendering is verified manually per UC-EM-005's procedure; the e2e pins
  structure and constraints, not pixels.
- **The temp password now exists in two branded formats in the recipient's inbox** —
  unchanged risk profile from 07 §UC-IA-009 (product decision: bounded by
  `must_change_password = 1` making it single-use).
- **Legacy-domain retirement** (`gorifi.skolar.sk` still serves the app and stays in
  the CORS allowlist) is NOT this module — this module only stops it appearing in
  outbound mail. Any future domain cutover revisits `allowedOrigins`, nginx and NPM,
  not this spec.
- **Phase 2, named so it is not silently implemented:** a brand image/logo in mail
  (requires a hosted asset strategy the no-remote-images rule currently forbids),
  `List-Unsubscribe` headers (irrelevant for one-to-one transactional mail today, due
  before any bulk/notification mail), and a preheader line (new copy — see the
  UC-EM-003 OPEN).
