// The ONE home for Google ID-token verification and for the `GOOGLE_CLIENT_ID`
// plumbing (10 §UC-GA-002). Module 10's login / link / register-attach / admin-login
// rows (GA-T4/T5/T8/T10) all consume `verifyGoogleIdToken()` from here; none of them
// re-derives the guards, the bounds or the status mapping.
//
// This is the backend's SECOND outbound call, after the mailer, and it follows the
// mailer's rules (01 §Integrations):
//
//   1. DISABLED BY DEFAULT. With `GOOGLE_CLIENT_ID` absent the whole feature is off:
//      every entry point here answers the 503 not-configured guard and makes NO network
//      call at all. That is what keeps local dev and any e2e run without the var
//      Google-free, and it is why `auth-mode` reports `googleClientId: null`.
//   2. IT NEVER THROWS INTO A REQUEST HANDLER. Every path returns a result object.
//   3. ONE BOOT LINE names the resolved mode, so `pm2 logs` answers "is Google sign-in
//      on, and is the test seam off?" without a login attempt.
//
// ⚠ STRUCTURAL RULE (the IA-T3 class — NO TEST CAN HOLD IT, so it lives here and as a
// comment at every call site): `verifyGoogleIdToken()` IS NETWORK I/O. It must run
// OUTSIDE any `db.transaction(...)` callback. better-sqlite3 transactions are
// synchronous and hold the write lock for their whole body; awaiting a JWKS fetch
// inside one would hold that lock for up to the full timeout below — and an `await`
// inside a synchronous transaction callback does not even do what it looks like. Verify
// first, then open the transaction with the resolved `sub` already in hand.
//
// ⚠ NEVER HAND-ROLL JWT VERIFICATION (01 §Dependencies). `google-auth-library`'s
// `verifyIdToken` checks the signature against Google's JWKS (with key caching), `aud`,
// `iss` (both the bare `accounts.google.com` and the `https://` form) and `exp`. The
// only thing this module adds ahead of it is a cheap LOCAL SHAPE GATE — see
// `looksLikeCompactJws` — which is a bounds check, not verification.

import { OAuth2Client } from 'google-auth-library';

// ID tokens are ~1–2 KB. The bound is the GSO-T3 bounded-inputs convention: a public
// endpoint must not carry an unbounded string into a crypto library.
export const GOOGLE_ID_TOKEN_MAX_LENGTH = 4096;

// ~10 s, per §UC-GA-002. Applied TWICE (see `verifyGoogleIdToken`): as the transport's
// per-request timeout AND as a hard outer deadline, because gaxios re-arms its timeout
// for each retry — a per-request timeout alone bounds one attempt, not the call.
export const GOOGLE_VERIFY_TIMEOUT_MS = 10_000;

// The three literals. Exported so a call site quotes them rather than retyping them,
// and so a test can pin them as exact bytes: an outage reading as "wrong credentials"
// is the specific failure this contract exists to prevent.
export const GOOGLE_NOT_CONFIGURED_ERROR = 'Prihlásenie cez Google nie je nakonfigurované';
export const GOOGLE_UNAVAILABLE_ERROR = 'Overenie Google účtu momentálne nie je dostupné, skúste to neskôr';
export const GOOGLE_INVALID_TOKEN_ERROR = 'Prihlásenie cez Google zlyhalo';
export const GOOGLE_BAD_TOKEN_ERROR = 'Neplatný Google token';

function envString(name) {
  return String(process.env[name] || '').trim();
}

// Read per call, not captured at import — the mailer's `mailConfig()` precedent, so a
// process that is handed its environment late still resolves correctly.
export function getGoogleClientId() {
  const value = envString('GOOGLE_CLIENT_ID');
  return value || null;
}

export function isGoogleAuthConfigured() {
  return getGoogleClientId() !== null;
}

// ⚠ THE UNIFORM FEATURE-OFF GUARD. Every module-10 route calls this FIRST and returns
// its 503 verbatim, so "the feature is off" is one decision in one place instead of an
// env check per route that a later row can forget. Returns `null` when configured.
export function requireGoogleAuthConfigured() {
  if (isGoogleAuthConfigured()) return null;
  return { error: GOOGLE_NOT_CONFIGURED_ERROR, status: 503, reason: 'not_configured' };
}

// ⚠ THE TEST SEAM, AND WHY IT CANNOT BE ON SILENTLY IN PRODUCTION.
//
// With `GOOGLE_AUTH_TEST_MODE=1` a token of the literal form `TEST:<sub>:<email>`
// verifies with no network call. It is honoured ONLY when the var is set; any other
// input still takes the real path. Production and staging `.env` files must never
// contain it — and the boot line below NAMES the resolved mode, so a misconfigured
// deployment is visible in `/var/log/gorifi/out.log` from the first restart rather than
// only after someone forges a login.
//
// ⚠ STRICT ALLOW-LIST, AND IT MUST STAY ONE. This function is the ONLY barrier between
// a deployment and a total authentication bypass — with the seam on, anyone can post
// `TEST:<any sub>:x@y` and be whoever that `sub` is linked to. The boot line is an
// AUDIT signal, not a gate.
//
// The first version of this was a DENY-list (`!== '' && !== '0' && !== 'false'`), which
// turned `GOOGLE_AUTH_TEST_MODE=off`, `=no`, `=disabled`, `=n` — the most natural things
// an operator writes when they think they are switching something OFF — into ON. Never
// enumerate the "off" values here; enumerate the "on" ones.
function isTestMode() {
  const value = envString('GOOGLE_AUTH_TEST_MODE');
  return value === '1' || value.toLowerCase() === 'true';
}

// Two overrides that exist ONLY so the e2e suite can prove the timeout actually bounds
// and that a malformed token costs no outbound request (there is no unit runner in this
// repo, so a local stand-in for Google's JWKS endpoint is the only way to observe
// either). ⚠ BOTH ARE GATED ON `GOOGLE_AUTH_TEST_MODE` — the same var the boot line
// already shouts about — so they cannot redirect or shorten verification on a
// deployment that has not already announced itself as a test rig.
//
// ⚠ LOOPBACK ONLY, and that restriction is the point. Test mode on its own is a LOUD
// bypass — `TEST:` tokens are unmistakable in a log. A redirectable JWKS URL would make
// it a SILENT one: an attacker hosting their own key set could sign a token carrying our
// `aud` and `iss: accounts.google.com` for any `sub` at all, and it would verify as a
// genuine Google login. Restricting the host to loopback means the seam can only ever be
// pointed at a stub running on the same machine as the server.
function testCertsUrl() {
  if (!isTestMode()) return null;
  const raw = envString('GOOGLE_AUTH_TEST_CERTS_URL');
  if (!raw) return null;
  let hostname;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    return null;
  }
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  if (!loopback) {
    console.error(`[google-auth] ignoring GOOGLE_AUTH_TEST_CERTS_URL: host ${hostname} is not loopback`);
    return null;
  }
  return raw;
}

function verifyTimeoutMs() {
  if (!isTestMode()) return GOOGLE_VERIFY_TIMEOUT_MS;
  const raw = Number(envString('GOOGLE_AUTH_TEST_TIMEOUT_MS'));
  return Number.isFinite(raw) && raw > 0 ? raw : GOOGLE_VERIFY_TIMEOUT_MS;
}

// ⚠ ONE LINE AT BOOT (the mailer convention), printed at import time so it lands right
// beside `[mailer]` under "Server bezi na porte". It always contains `mode=` with one
// of `off` / `google` / `TEST`, which is what a production audit greps for.
{
  const clientId = getGoogleClientId();
  const testMode = isTestMode();
  if (!clientId) {
    const note = testMode
      ? ' ⚠ GOOGLE_AUTH_TEST_MODE is set but inert (no client id) — remove it from this environment'
      : '';
    console.log(`[google-auth] mode=off — disabled (no GOOGLE_CLIENT_ID), Google sign-in is a no-op${note}`);
  } else if (testMode) {
    console.log(
      `[google-auth] mode=TEST for client ${clientId} — ⚠ GOOGLE_AUTH_TEST_MODE is set: ` +
        'TEST:<sub>:<email> tokens are accepted WITHOUT verification. This must NEVER be set in production.'
    );
  } else {
    console.log(`[google-auth] mode=google for client ${clientId} — real Google ID-token verification`);
  }
}

// One client per (clientId, certs URL, timeout) so the library's JWKS cache is actually
// reused across requests. A new client per verification would re-fetch Google's keys on
// every login.
let cachedClient = null;
let cachedClientKey = '';

function getClient(clientId) {
  const certsUrl = testCertsUrl();
  const timeout = verifyTimeoutMs();
  const key = `${clientId}|${certsUrl || ''}|${timeout}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;

  cachedClient = new OAuth2Client({
    clientId,
    // Per-HTTP-attempt bound: gaxios turns this into an `AbortSignal.timeout`, so a
    // hung socket is actually torn down rather than left dangling. It is NOT the whole
    // bound — `getFederatedSignonCertsAsync` passes `AuthClient.RETRY_CONFIG`, and
    // gaxios re-arms the timeout for EACH RETRY (gaxios.js `#appendTimeoutToSignal`,
    // called again on the retry path). ⚠ MEASURED: against a JWKS endpoint answering
    // HTTP 500 (a retryable status) with this timeout at 400 ms, removing the outer
    // deadline below let one call run 2137 ms over 4 attempts — 5.3× the configured
    // bound, i.e. ~53 s at the shipped 10 s. Both layers are load-bearing; neither
    // alone is the bound.
    transporterOptions: { timeout },
    ...(certsUrl
      ? {
          endpoints: {
            oauth2FederatedSignonPemCertsUrl: certsUrl,
            oauth2FederatedSignonJwkCertsUrl: certsUrl,
          },
        }
      : {}),
  });
  cachedClientKey = key;
  return cachedClient;
}

class GoogleVerifyDeadline extends Error {
  constructor(ms) {
    super(`google verification exceeded ${ms} ms`);
    this.name = 'GoogleVerifyDeadline';
  }
}

// The hard outer bound. `Promise.race` attaches a handler to both sides, so a late
// rejection from the losing promise is never an unhandled rejection; the timer is
// unref'd so it can never hold the process open on its own.
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new GoogleVerifyDeadline(ms)), ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Transport faults, so that NONE of them can be reported as "wrong credentials".
// The first two clauses are the deterministic ones (our own deadline; the library's own
// wrapper around a failed certs fetch); the rest are the belt-and-braces layer for the
// case where the cert cache expires between our explicit fetch and the verify call.
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

function isTransportFailure(e) {
  if (e instanceof GoogleVerifyDeadline) return true;
  const message = String(e?.message || '');
  if (message.startsWith('Failed to retrieve verification certificates')) return true;
  const name = String(e?.name || '');
  if (name === 'GaxiosError' || name === 'TimeoutError' || name === 'AbortError') return true;
  if (NETWORK_CODES.has(String(e?.code || ''))) return true;
  if (NETWORK_CODES.has(String(e?.cause?.code || ''))) return true;
  return false;
}

// A JWS compact serialization: three base64url segments. This is a BOUNDS CHECK, NOT
// VERIFICATION — nothing is decoded and nothing is trusted.
//
// ⚠ It is load-bearing, and 10 §UC-GA-013 asserts its effect as if it were free:
// `verifyIdTokenAsync` fetches the certs BEFORE it looks at the token (oauth2client.js —
// `getFederatedSignonCertsAsync()` then `verifySignedJwtWithCertsAsync()`), so the spec's
// claim that malformed tokens "fail locally at decode, no network" is not a property of
// the library.
//
// ⚠ Precisely: WITHOUT this gate a junk string costs an outbound request only in the
// COLD-START / POST-EXPIRY window — `getFederatedSignonCertsAsync` short-circuits on a
// live `certificateExpiry`, so on a warm process it would usually cost nothing. What the
// gate actually buys is (a) making the spec's "no network" claim UNCONDITIONAL rather
// than dependent on cache state, (b) not handing arbitrary public input to a JWS decoder,
// and (c) a hermetic test suite. Do not read it as "the library would otherwise call
// Google on every junk request".
function looksLikeCompactJws(token) {
  return /^[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/.test(token);
}

// ⚠ A 200 IS NOT THE SAME AS "GOOGLE ANSWERED". A captive portal or a proxy error page
// that happens to be JSON produces a SUCCESSFUL fetch whose payload contains no keys —
// and then `verifySignedJwtWithCertsAsync` throws an ordinary verification error ("No pem
// found for envelope"), which classifies as 401. That is precisely the "an outage must
// not read as wrong credentials" failure this module's contract exists to prevent, in the
// one path where it would otherwise survive. So the fetched map is sanity-checked and a
// useless one is an OUTAGE.
//
// Format-aware because `getFederatedSignonCertsAsync` returns both shapes: PEM (Node —
// kid → certificate text) and JWK (browser crypto — kid → key object).
function certsLookUsable(certs, format) {
  if (!certs || typeof certs !== 'object') return false;
  const values = Object.values(certs);
  if (values.length === 0) return false;
  if (format === 'JWK') {
    return values.some((v) => v && typeof v === 'object' && typeof v.kid === 'string');
  }
  return values.some((v) => typeof v === 'string' && v.includes('-----BEGIN'));
}

function invalid() {
  return { error: GOOGLE_INVALID_TOKEN_ERROR, status: 401, reason: 'invalid' };
}

function unavailable() {
  return { error: GOOGLE_UNAVAILABLE_ERROR, status: 503, reason: 'unavailable' };
}

// `TEST:<sub>:<email>` — the email half may be empty (⇒ `email: null`), the sub half may
// not. Anything else that starts with `TEST:` is rejected HERE rather than falling
// through to the real path: a half-written seam token is a test bug, and letting it out
// to Google would make the seam's "no network" property conditional on spelling.
function parseTestToken(token) {
  const rest = token.slice('TEST:'.length);
  const split = rest.indexOf(':');
  if (split <= 0) return null;
  const sub = rest.slice(0, split);
  const email = rest.slice(split + 1);
  return { sub, email: email || null, emailVerified: true };
}

/**
 * Verify a Google ID token.
 *
 * ⚠ THE 401-vs-503 CONTRACT IS DEFINED HERE, ONCE, AND CALL SITES MUST NOT
 * RE-DERIVE IT. The result is the repo's standard guard shape (`requireHost`,
 * `requireFriendOwner`): either `{ identity }` or `{ error, status, reason }`, so the
 * call site is one line —
 *
 *     // ⚠ network I/O — MUST stay outside any db.transaction (helpers/google-auth.js)
 *     const v = await verifyGoogleIdToken(req.body.id_token);
 *     if (v.error) return res.status(v.status).json({ error: v.error, ...(v.field && { field: v.field }) });
 *     // v.identity.sub is the identity key. NEVER match on email.
 *
 * — and getting the mapping wrong requires actively ignoring `status`.
 *
 * ⚠ THE RESULT IS ALWAYS TRUTHY — branch on `.error`, NEVER on falsiness. 10
 * §UC-GA-002's prose still described an older `… | null` shape; `if (!v) return 401` is
 * now never true and would let an unverified request through.
 *
 * `reason` is the stable discriminator for the call sites whose copy differs from the
 * default (§UC-GA-008's register attach answers its own 400 for `reason === 'invalid'`):
 *
 *   'not_configured' → 503, the feature is off on this deployment
 *   'bad_request'    → 400, `field` names the offending body field
 *   'invalid'        → 401, the token did not verify (bad signature / aud / iss / exp)
 *   'unavailable'    → 503, Google could not be reached — NEVER a 401
 *
 * @param {unknown} idToken raw body value, deliberately untyped — the guard is here
 * @param {{ field?: string }} [options] body field name for the 400 (`id_token` default)
 */
export async function verifyGoogleIdToken(idToken, options = {}) {
  const field = typeof options?.field === 'string' && options.field ? options.field : 'id_token';

  // 1. CONFIG FIRST (the §UC-GA-003 order). An unconfigured deployment must answer "this
  //    feature is off", never a complaint about the shape of a token it was never going
  //    to check — and it must reach no further, so nothing below can make a network call.
  const notConfigured = requireGoogleAuthConfigured();
  if (notConfigured) return notConfigured;

  // 2. TYPE + BOUNDS. `{ id_token: 123 }` is a 400, never a 500 (the FUP-T13/T15
  //    bind-guard family's lesson). Living HERE rather than at each call site is the
  //    whole point: a future route cannot forget a guard it does not have to write.
  if (typeof idToken !== 'string') {
    return { error: GOOGLE_BAD_TOKEN_ERROR, status: 400, reason: 'bad_request', field };
  }
  const token = idToken.trim();
  if (!token || token.length > GOOGLE_ID_TOKEN_MAX_LENGTH) {
    return { error: GOOGLE_BAD_TOKEN_ERROR, status: 400, reason: 'bad_request', field };
  }

  // 3. THE TEST SEAM, only when the env says so.
  if (isTestMode() && token.startsWith('TEST:')) {
    const parsed = parseTestToken(token);
    return parsed ? { identity: parsed } : invalid();
  }

  // 4. Local shape gate — see `looksLikeCompactJws`. No network for junk.
  if (!looksLikeCompactJws(token)) return invalid();

  const clientId = getGoogleClientId();
  const timeout = verifyTimeoutMs();

  // ⚠ ONE BUDGET FOR THE WHOLE CALL, not one per await. There are two awaited steps
  // below, and giving each its own `timeout` would make the composed worst case 2 ×
  // timeout — 20 s at the shipped value, where §UC-GA-002 says ~10 s. `remaining()` is
  // what keeps the number the spec states true of the FUNCTION and not merely of each
  // step in it. (The second step normally reads the library's cert cache and costs
  // nothing, but see the note there — the cache is not guaranteed.)
  const deadlineAt = Date.now() + timeout;
  const remaining = () => Math.max(1, deadlineAt - Date.now());

  // 5. THE CERTS FETCH, SEPARATELY. This is the ONLY network step in the normal case,
  //    and doing it explicitly is what makes "outage" observable without sniffing error
  //    strings: anything that fails here is a 503, full stop. When Google's
  //    `cache-control` is honoured this also warms the cache the verify below reads, so
  //    it costs no second request — but that is Google's behaviour, not ours (see the
  //    catch).
  //
  //    ⚠ `getClient()` is INSIDE the try on purpose. Rule 2 of this module is that it
  //    never throws into a request handler, and that has to hold for a construction
  //    failure too (a future library version rejecting an option, say) — not only for
  //    the network. 503 is the honest answer: the verifier is not usable right now.
  let client;
  try {
    client = getClient(clientId);
    const fetched = await withDeadline(client.getFederatedSignonCertsAsync(), remaining());
    if (!certsLookUsable(fetched?.certs, fetched?.format)) {
      console.error('[google-auth] certificate fetch returned no usable keys — treating as an outage');
      return unavailable();
    }
  } catch (e) {
    // The token is never logged. Google's own message is bounded — it is server text
    // going into our log file.
    console.error(`[google-auth] certificate fetch failed: ${String(e?.message || e?.name || 'unknown error').slice(0, 300)}`);
    return unavailable();
  }

  try {
    const ticket = await withDeadline(client.verifyIdToken({ idToken: token, audience: clientId }), remaining());
    const payload = ticket?.getPayload?.();
    // No `sub` means no identity key, and email is never a fallback (01 §Auth
    // extensions: `sub` is the ONLY identity key).
    if (!payload || typeof payload.sub !== 'string' || !payload.sub) return invalid();

    // ⚠ `email` is used ONLY when `email_verified` is true; otherwise it is NULL. The
    // column it feeds (`friends.google_email`) is display-only, and an unverified
    // address on a screen would still look like a fact about the account.
    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
    const email = emailVerified && typeof payload.email === 'string' && payload.email ? payload.email : null;
    return { identity: { sub: payload.sub, email, emailVerified } };
  } catch (e) {
    // Second layer of the same rule as step 5. ⚠ `verifyIdToken` re-entering the network
    // is NOT a rare accident: the library only caches when the response carried a
    // `cache-control: max-age` (otherwise `certificateExpiry` stays null and the cache is
    // never consulted at all). That holds against Google today; it is not a property of
    // the code, and a proxy that strips the header makes every verification fetch twice.
    // So a transport fault can surface here, and it is still a 503.
    if (isTransportFailure(e)) {
      console.error(`[google-auth] verification transport failure: ${String(e?.message || e?.name || 'unknown error').slice(0, 300)}`);
      return unavailable();
    }
    return invalid();
  }
}
