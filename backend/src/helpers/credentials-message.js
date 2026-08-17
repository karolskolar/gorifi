// The credential hand-off message — ONE home, on the server (07 §UC-IA-006 + §UC-IA-009).
//
// ⚠ WHY THE SERVER OWNS THIS STRING. §UC-IA-009 says the e-mail body is "the same
// ty-form message §UC-IA-006 pins for the clipboard". There are two consumers of that
// one sentence — the Mailgun body and the dialog's copy button — and the frontend
// cannot import from the backend, so leaving the sentence in `AdminInvitations.vue`
// would mean two literals that only a human diff keeps in sync. Instead the approve
// endpoint renders it HERE, mails that exact string, and returns it as
// `credentials_message`; the dialog's copy button writes back what the server sent.
// The mail and the clipboard are therefore byte-identical by construction, and the
// admin pastes exactly what the friend received.
//
// The sentence itself is product-owner-signed (2026-08-13) and deliberately TY-FORM —
// it is the admin's personal message to someone they invited, not app copy addressing
// an anonymous reader, so it overrides the module's vy-form register for this ONE
// string. Plain hyphen, exact punctuation. Do not re-word or "fix" the register.

import { allowedOrigins } from '../config/origins.js';

// The e-mail's subject. Ty-form to match the body, impersonal enough to carry no
// gendered participle. (The clipboard has no subject — the admin pastes into whatever
// channel they use, which is why the message stands alone without one.)
export const CREDENTIALS_EMAIL_SUBJECT = 'Tvoj účet v Podpultovke je pripravený';

// Where the friend logs in when nothing better can be determined (see below).
const FALLBACK_LOGIN_URL = 'https://podpultovka.biz';

// The origin of `value`, or '' when it is not an http(s) URL. `URL.origin` drops any
// path/query, so a sloppily configured `https://host/admin` still yields `https://host`.
function httpOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

// ⚠ ONE LINE AT BOOT reporting how `PUBLIC_BASE_URL` resolved (08 §UC-EM-004) — the
// `mailer.js` boot-line precedent: env plumbed through `--env-file-if-exists` has no
// other signal, so without this a fresh container silently regresses to Origin-derived
// login URLs and nothing surfaces until a recipient reports the wrong domain again —
// the exact failure mode that opened module 08. Printed at import time so it lands in
// `/var/log/gorifi/out.log` next to the mailer's own line. The value is public config
// (the same URL every outbound mail prints); nothing sensitive is logged.
//
// Three cases, not two: a SET-BUT-INVALID value (e.g. `podpultovka.biz` without the
// scheme) silently falls through to the Origin branch in `resolveLoginUrl()`, which is
// precisely the regression the boot line exists to surface — reporting it as "set"
// would claim a pin that is not in effect.
{
  const raw = String(process.env.PUBLIC_BASE_URL || '').trim();
  const pinned = httpOrigin(raw);
  if (pinned) {
    console.log(`[mail] PUBLIC_BASE_URL=${pinned}`);
  } else if (raw) {
    console.log(`[mail] PUBLIC_BASE_URL invalid (${raw}) — not an http(s) URL; login URLs fall back to request Origin / brand default`);
  } else {
    console.log('[mail] PUBLIC_BASE_URL unset — login URLs fall back to request Origin / brand default');
  }
}

// The login URL that goes into the message. The dialog used to build this from
// `window.location.origin`; now that the server renders the sentence it has to derive
// the same value:
//
//   1. `PUBLIC_BASE_URL` — an explicit override, so the canonical domain can be pinned
//      without touching code (and so a non-browser caller still gets a sane URL). Not
//      allowlist-checked: it is set by the operator in the same `.env` as the Mailgun
//      key, i.e. it is already as trusted as the credentials themselves.
//   2. The request's `Origin` header — the admin SPA's own origin, which is what
//      `window.location.origin` was. Per the Fetch standard `Origin` is always sent for
//      a non-GET/HEAD request, and this route is a POST, so a browser caller always
//      supplies it.
//      ⚠ IT MUST BE IN THE ALLOWLIST, not merely a well-formed origin. This value is
//      interpolated into an e-mail we send to a THIRD PARTY (the applicant), so an
//      attacker-chosen origin would be a phishing link sent from our own verified
//      sending domain. `index.js`'s `cors()` does already reject a non-allowlisted
//      Origin on the ACTUAL request (not just the preflight — the callback calls
//      `next(err)`, which is a 500 before any route runs), and this route additionally
//      needs an admin token. But that leaves the safety of outbound mail resting on a
//      middleware ordering nothing asserts, and a curl caller is not covered by the
//      preflight argument at all. So the check is repeated here, against the same
//      `allowedOrigins` list, as an independent layer.
//   3. The brand domain, so a curl/cron caller never produces "Prihlás sa na  -".
export function resolveLoginUrl(req) {
  const fromEnv = httpOrigin(process.env.PUBLIC_BASE_URL);
  if (fromEnv) return fromEnv;

  const fromRequest = httpOrigin(req?.headers?.origin);
  if (fromRequest && allowedOrigins.includes(fromRequest)) return fromRequest;

  return FALLBACK_LOGIN_URL;
}

export function credentialsMessage({ loginUrl, username, tempPassword }) {
  return `Ahoj, tvoj účet je pripravený. Prihlás sa na ${loginUrl} - užívateľské meno: ${username}, dočasné heslo: ${tempPassword}. Po prvom prihlásení si nastav vlastné heslo.`;
}
