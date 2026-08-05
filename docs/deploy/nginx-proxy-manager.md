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

**Correct sequencing** (step 1 is the one that was skipped, not one to skip again):
1. Add the policy above as `Content-Security-Policy-Report-Only`.
2. **Prove it is actually being sent** with the `curl` above.
3. Collect a few days of real traffic, watching `/admin/analytics/*` for
   `unsafe-eval` and the guest routes once deployed.
4. Only then drop `-Report-Only`.

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
