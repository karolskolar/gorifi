# SEC-I1 — Nginx Proxy Manager configuration

Gorifi's TLS + reverse proxy is handled by **Nginx Proxy Manager (NPM)**. Apply
these settings to the proxy hosts `gorifi.skolar.sk` (prod → backend :3000) and
`gorifi-dev.skolar.sk` (staging → :3001). Audit refs: §H7 (TLS/HSTS), §M3 (CSP /
headers), §H3 (limits).

> The app already sets `X-Frame-Options` and `X-Content-Type-Options` itself and
> rate-limits auth endpoints (SEC-F2). The NPM layer adds TLS enforcement, HSTS,
> CSP, and defense-in-depth limits at the edge.

## 1. SSL tab (per proxy host)

Enable all of:
- **Force SSL** — redirect HTTP → HTTPS.
- **HTTP/2 Support**.
- **HSTS Enabled** — sends `Strict-Transport-Security`.
- **HSTS Subdomains** — only if every `*.skolar.sk` host is HTTPS (it forces the whole subtree to HTTPS; leave off if unsure).

That covers HSTS, so you do **not** add a `Strict-Transport-Security` header manually below.

## 2. Advanced tab → "Custom Nginx Configuration" (per proxy host)

This block is injected into the host's `server { }`. Paste:

```nginx
# --- Security headers (added at the edge; 'always' so they apply to errors too) ---
add_header X-Content-Type-Options   "nosniff" always;
add_header X-Frame-Options          "DENY" always;
add_header Referrer-Policy          "strict-origin-when-cross-origin" always;
add_header Permissions-Policy       "geolocation=(), microphone=(), camera=(), interest-cohort=()" always;

# Content-Security-Policy. Gorifi is a Vue SPA served same-origin by the backend.
# Policy below is derived from a live browser audit (2026-08-05), not a template —
# see "CSP: audited findings" after this block before changing it.
add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests" always;

# --- Request size cap (matches the backend's 10mb JSON limit; images ≤ 5 MB) ---
client_max_body_size 10m;

# --- Edge rate limit on auth/registration (needs the http-level zone in step 3) ---
location ~ ^/api/(admin/login|friends/auth|invitations/(register|code)|onboarding) {
    limit_req zone=gorifi_auth burst=10 nodelay;
    limit_req_status 429;
    proxy_pass http://$server:$port;   # NPM fills these; keep if it doesn't error, else omit this line
}
```

Notes:
- If the `location … { proxy_pass … }` block conflicts with NPM's generated
  location (some NPM versions error on a duplicate `/`), **drop the whole
  `location` block** and rely on the app-level limiter (SEC-F2) — the headers and
  `client_max_body_size` above are the important part.
- Once the CSP report-only log is clean, rename `Content-Security-Policy-Report-Only`
  → `Content-Security-Policy`. **Read the audited findings below first** — as of
  2026-08-05 the report-only stage had never actually been armed.

## 2b. CSP: audited findings (2026-08-05)

A live browser audit of production, plus header probes, found:

**⚠ No CSP header is being sent at all — there is nothing to rename.** The
report-only stage this doc describes as the safety net was never armed, so no
violation data was ever collected. A "clean console" was therefore guaranteed
regardless of the app's real compliance: a false all-clear, not a green light.

**Which headers ARE live tells you why.** Production sends
`Strict-Transport-Security`, `X-Frame-Options: SAMEORIGIN` and
`X-Content-Type-Options: nosniff`, but **neither `Content-Security-Policy` nor
`Referrer-Policy`**. HSTS is an NPM toggle and XFO + nosniff are what NPM's "Block
Common Exploits" checkbox adds — while CSP and Referrer-Policy exist *only* in the
custom Advanced block above. So the Advanced block was **never applied or never
saved**; the checkboxes were. Verify with:

```bash
curl -sI https://gorifi.skolar.sk | grep -iE 'content-security|referrer-policy'
```

Both lines must appear before you trust anything about CSP.

**What a naive `default-src 'self'` would have broken immediately:**
- **Every product image.** They are `data:` URIs, and `img-src 'self'` does not
  permit the `data:` scheme — hence `img-src 'self' data:`.
- **Inline styling on almost every route** — one `<style>` block plus 5–21 `style`
  attributes per page; on `/admin/analytics/coffee` those drive the progress bars
  and scenario sliders. Hence `'unsafe-inline'` in `style-src`. Worth stating
  plainly: `'unsafe-inline'` on *style* is a far smaller concession than on
  *script* — it permits styling tricks, not code execution.

Note the friend portal root `/` is completely clean (no inline anything, no
images), so **checking only the entry URL finds nothing** — the breakage is one
click deep.

**`script-src 'self'` with no exceptions is achievable.** Zero inline `<script>`
was found on any route, and the current build likewise contains exactly one
`<script>` (with `src`) and no inline bodies. That is where most of the XSS
protection lives, so don't weaken it.

**`unsafe-eval` is deliberately omitted.** Whether the bundled charting library
needs it is unknown, because `eval` is currently unrestricted so nothing
complains. Report-only mode on `/admin/analytics/*` will answer that.

**Routes still to walk through before enforcing:**
- **`/g/:token` and `/g/:token/o/:orderToken`** (guest ordering) — these were NOT
  auditable, because the guest feature is on `main` but **not yet deployed**
  (`routes/guest.js` absent from prod, no `guest*` tables in the live DB). Their
  QR codes and product images are `data:` URIs, so `img-src 'self' data:` should
  cover them, but confirm after that deploy.
- **`/onboard/:token`** — public, unauthenticated, and carries a
  credential-collecting form. This is exactly why `form-action 'self'` matters.
- Admin sub-pages not yet inspected: Priatelia, Pekáreň, Vouchery, Skupiny,
  Nastavenia. The pattern held across six routes (same-origin only, inline styles,
  no inline scripts), so surprises are unlikely — but check Nastavenia if it grows
  image upload, which could require `blob:`.

## 2c. CSP is ENFORCING (2026-08-06)

Report-only was armed on 2026-08-05, walked twice in a live browser, and produced
**zero app-generated violations**. The suffix was then dropped. What the walkthroughs
established:

- **`unsafe-eval` is NOT needed.** All four analytics tabs, five chart canvases and
  both scenario sliders (32→62 friends, 1.1→2.0 kg/person) produced no `script-src`
  violation of any kind. Do not add it "just in case" — that is where most of the
  XSS protection lives.
- **`img-src 'self' data:` and `style-src 'self' 'unsafe-inline'` are load-bearing.**
  41 `data:` images across three routes; up to **138 inline `style` attributes on a
  single page** (`/admin/friends`). Remove either and the app breaks.
- **The guest payment QR is fine** — generated client-side as `data:image/png;base64`
  and rendered three times (confirmation, re-open, status page) with zero violations.
- **The "Zaplatiť cez Revolut" control is safe**: it is an `<a href target="_blank">`,
  i.e. plain navigation. `form-action` does not apply to link navigation and the
  policy has no `navigate-to`. Recorded so nobody reopens the question.
- **The Google Sheets import carries no CSP exposure at all.** It is server-side
  (`POST /api/products/import-gsheet/:cycleId` in `routes/products.js` fetches
  `docs.google.com`), so the browser never contacts Google and `connect-src 'self'`
  cannot block it. The only frontend mention is a placeholder string in an input.

**Not observed before enforcing** — accepted risk, recorded deliberately:
- The **bakery grouped-variant card** on a guest page. A ready-made staging link
  exists for it if the question ever returns: an open bakery cycle whose "Makovník"
  has three variants (`1ks`, `1/2`, `1/4`) and real `data:` photos.
- **Real `data:` product images on a guest page** — the coffee staging cycle has no
  photos. Same mechanism already proven on friend and admin pages, so this is
  inference rather than observation.
- **Load-time violations on the two `/g/…` routes.** Browser-automation tooling can
  only attach a `securitypolicyviolation` listener *after* load, so a load-time
  violation there could have been missed. Everything after attachment, including
  the whole payment path, is covered.

### Rolling back, if enforcement ever breaks something

One command — no app restart, ~1 second:

```bash
# revert the two config files to Content-Security-Policy-Report-Only, then:
./deploy/deploy.sh production nginx
```

Or, straight on the box, restoring the automatic pre-change backup:

```bash
ssh root@gorifi 'cp /root/gorifi.bak.<timestamp> /etc/nginx/sites-available/gorifi && nginx -t && nginx -s reload'
```

`deploy.sh` writes a timestamped backup to `/root/<site>.bak.<ts>` before every
config install, and validates with `nginx -t` before reloading.

### Method notes for any future CSP audit

Three things that are easy to get wrong, learned the hard way here:

1. **Silence has two causes** — a broken capture *or* no header being sent. Do not
   treat "no violations" as a pass. Read `originalPolicy` and `disposition` off an
   actual `SecurityPolicyViolationEvent`; that proves the header exists *and* shows
   what is genuinely deployed rather than what is documented. Conflating the two is
   exactly what produced the original false all-clear.
2. **Chrome's native `[Report Only]` console warnings are not readable** by
   browser-automation tooling — only `console.*` output is. So load-time violations
   are invisible unless a listener is already attached.
3. **Attach the listener once, then navigate only via in-app clicks.** This is an
   SPA, so routing does not reload the document and the listener survives the whole
   walkthrough. A hard navigation to each route wipes it and silently loses that
   route's load-time violations.

Also: testing `eval()` from an automation console proves nothing — it runs in an
isolated world not governed by the page's CSP. Only the app's own bundle can answer
the `unsafe-eval` question.

Finally: a guest link is created by a **host from their own order page**
("Zdieľať objednávku s kolegami"), not from admin — `/admin/invitations` holds only
`/onboard/*` links, so looking there for a `/g/…` URL will always come up empty.

Optional hardening later: move the inline `<style>` block into a stylesheet and
convert `style` attributes to classes, which would let `'unsafe-inline'` be dropped
from `style-src` entirely.

## 3. http-level rate-limit zone (only if you kept the `limit_req` in step 2)

`limit_req_zone` must live in the `http { }` context, which the Advanced tab
can't reach. Add it via NPM's global custom config. On the NPM host/container:

```bash
# inside the NPM container (or its mapped volume): /data/nginx/custom/http_top.conf
mkdir -p /data/nginx/custom
cat >> /data/nginx/custom/http_top.conf <<'EOF'
# 10 req/s per client IP, 10 MB shared state (~160k IPs)
limit_req_zone $binary_remote_addr zone=gorifi_auth:10m rate=10r/s;
EOF
```

Then restart NPM (`docker restart <npm-container>` or via the Proxmox host).
`http_top.conf` is auto-included by NPM at the top of `http { }`.

## 4. Verify

```bash
curl -sI https://gorifi.skolar.sk | grep -iE 'strict-transport|content-security|x-content-type|referrer-policy|x-frame'
# HTTP → HTTPS redirect:
curl -sI http://gorifi.skolar.sk | grep -i location
```

You should see HSTS, CSP(-Report-Only), and the other headers, and the HTTP call
should 301 to HTTPS.
