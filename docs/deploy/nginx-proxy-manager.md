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
# It renders product images as data: URIs and generates QR codes, so img-src and
# font-src allow data:. Start in REPORT-ONLY, watch the browser console for a day,
# then switch the header name to Content-Security-Policy once clean.
add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;

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
  → `Content-Security-Policy`.

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
