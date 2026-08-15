// The ONE home for outbound mail (07 §UC-IA-009). Currently one caller — the
// credential hand-off in `POST /api/invitations/:id/approve` — but every future
// outbound message goes through `sendMail()`, never through its own fetch.
//
// Transport: Mailgun's HTTP API over Node's global `fetch`. ⚠ NO NEW DEPENDENCY —
// the server runs Node 20.20.2, so `fetch`, `FormData` and `AbortSignal.timeout` are
// all built in. Do not add nodemailer or the Mailgun SDK.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE:
//
//   1. DISABLED BY DEFAULT. With any of the three env vars missing this is a no-op that
//      makes NO network call at all. That is what keeps local dev and the entire e2e
//      suite from ever sending real mail — the suite must never set those vars, and
//      `e2e/tests/invitation-approval.spec.js` proves the no-op by pointing
//      `MAILGUN_BASE_URL` at a stub server and asserting it receives zero requests.
//   2. THE API KEY NEVER LEAVES THIS MODULE. It is not in any return value, any log
//      line or any error message: it travels only in the `Authorization` header. On
//      failure we log the HTTP status and Mailgun's own `message` field and nothing
//      else, and every logged string additionally goes through `redact()` — belt and
//      braces, so a future `console.error(e)` cannot leak it either. Failure codes
//      returned to the caller (and thence to the admin's browser) are a FIXED
//      vocabulary, never server text.
//   3. IT NEVER THROWS. The caller has already created a friend and is holding a
//      one-time plaintext password; a mail problem must be reportable, not fatal.
//      Every path returns a result object.
//
// Result shape (also the `email` field of the approve 201):
//   { sent: true,  to }                          — Mailgun accepted the message
//   { sent: false, skipped: 'no_recipient' }     — nothing to send to
//   { sent: false, skipped: 'not_configured' }   — no Mailgun env (dev/staging default)
//   { sent: false, error: <code> }               — it was attempted and failed;
//                                                  code ∈ 'invalid_recipient' |
//                                                  'timeout' | 'network' | 'HTTP <status>'

const MAILGUN_TIMEOUT_MS = 10_000;

// Deliberately loose — the authority on deliverability is Mailgun, not a regex. This
// only catches "obviously not an address" so a typo does not burn a send.
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// Present only if ALL THREE are set; a partial configuration is treated as unconfigured
// rather than half-attempted (an approval must not fail because a deploy forgot one var).
function mailConfig() {
  const apiKey = String(process.env.MAILGUN_API_KEY || '').trim();
  const domain = String(process.env.MAILGUN_DOMAIN || '').trim();
  const baseUrl = String(process.env.MAILGUN_BASE_URL || '').trim();
  if (!apiKey || !domain || !baseUrl) return null;
  return { apiKey, domain, baseUrl: baseUrl.replace(/\/+$/, '') };
}

// The From address. Mailgun accepts any local part on the verified sending domain, so
// the three documented env vars are enough; `MAILGUN_FROM` is an optional override for
// when a real reply-to mailbox exists.
function fromAddress(domain) {
  const override = String(process.env.MAILGUN_FROM || '').trim();
  return override || `Podpultovka <no-reply@${domain}>`;
}

// ⚠ ONE LINE AT BOOT, and it is the only signal that the env plumbing worked.
//
// `not_configured` is the ONE outcome the dialog renders as NOTHING (§UC-IA-009), which
// is right for a dev machine and wrong as the way you discover that production's
// `--env-file-if-exists` never fired: the feature would then be silently dead — every
// approval reporting an outcome nobody sees, no error anywhere. Printed at import time,
// so it lands in `/var/log/gorifi/out.log` right under the "Server bezi na porte" line
// and `pm2 logs` answers "is mail on?" without an approval.
//
// The DOMAIN and BASE URL are printed (they are public, and the wrong region is a
// realistic misconfiguration); the KEY never is, not even its length or a prefix.
{
  const bootConfig = mailConfig();
  if (bootConfig) {
    console.log(`[mailer] Mailgun enabled for ${bootConfig.domain} via ${bootConfig.baseUrl}`);
  } else {
    console.log('[mailer] disabled (no MAILGUN_API_KEY/MAILGUN_DOMAIN/MAILGUN_BASE_URL) — outbound mail is a no-op');
  }
}

// Remove the API key from anything about to be logged. Nothing we log should contain
// it (it only ever lives in a header), so this is the second layer, not the first.
function redact(text, apiKey) {
  const str = String(text ?? '');
  if (!apiKey) return str;
  return str.split(apiKey).join('***');
}

export async function sendMail({ to, subject, text, html }) {
  // ⚠ THE ORDER OF THESE THREE CHECKS IS THREE SEPARATE RULES.
  //
  // 1. RECIPIENT PRESENCE FIRST, ahead of the config check. §UC-IA-009's acceptance
  //    criteria require an invitation with no e-mail to report `no_recipient` — and the
  //    e2e suite runs with no Mailgun env at all, so a config check first would report
  //    `not_configured` for that case and the distinction the dialog draws (a neutral
  //    "there was no address" vs. saying nothing at all) could never be tested.
  const recipient = typeof to === 'string' ? to.trim() : '';
  if (!recipient) return { sent: false, skipped: 'no_recipient' };

  // 2. CONFIG BEFORE VALIDITY. `invalid_recipient` is an `error`, which the dialog
  //    renders as a RED warning — and on a deployment that does not send mail at all
  //    (local dev, the e2e recipe, staging before its .env exists) nothing was
  //    attempted, so a warning there would contradict §UC-IA-009's "`not_configured` ⇒
  //    nothing user-facing". Silence has to win over a complaint about an address this
  //    deployment was never going to use.
  const config = mailConfig();
  if (!config) return { sent: false, skipped: 'not_configured' };

  // 3. Only now is a malformed address a real, actionable failure. `to` is carried back
  //    so the dialog can NAME the address that has to be fixed — "sending failed" alone
  //    would send the admin looking for a Mailgun problem that does not exist.
  if (!EMAIL_SHAPE.test(recipient)) return { sent: false, error: 'invalid_recipient', to: recipient };

  const form = new FormData();
  form.set('from', fromAddress(config.domain));
  form.set('to', recipient);
  form.set('subject', String(subject ?? ''));
  const textPart = String(text ?? '');
  form.set('text', textPart);

  // Optional html part (08 §UC-EM-001). Mailgun assembles the MIME
  // multipart/alternative from the `text` + `html` FORM FIELDS itself — this module
  // never builds MIME.
  //
  // ⚠ THE PLAIN-TEXT PART IS ALWAYS PRESENT — the deliverability baseline. `html`
  // with an empty/absent `text` is a programming error: the html field is DROPPED
  // and the send degrades to text-only (today's behaviour), because per rule 3 an
  // html-only message must neither go out nor throw — the caller (a template layer
  // rendering inside try/catch) leans on exactly this contract.
  if (typeof html === 'string' && html !== '' && textPart !== '') {
    form.set('html', html);
  }

  // Tracking is disabled PER MESSAGE, on every send, text-only included
  // (08 §UC-EM-001): open-tracking injects a remote pixel into the html (violating
  // the no-remote-images rule) and click-tracking rewrites hrefs through the sending
  // domain (violating the canonical podpultovka.biz URL in outbound mail). The
  // per-message flags make the outcome deterministic regardless of the Mailgun
  // account's domain-level settings.
  form.set('o:tracking-clicks', 'no');
  form.set('o:tracking-opens', 'no');

  try {
    const res = await fetch(`${config.baseUrl}/v3/${config.domain}/messages`, {
      method: 'POST',
      headers: {
        // The ONLY place the key appears. `api:<key>` is Mailgun's basic-auth shape.
        Authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString('base64')}`,
      },
      body: form,
      // A hanging Mailgun must not hold the admin's approval request open.
      signal: AbortSignal.timeout(MAILGUN_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Mailgun's own explanation, and nothing else. Bounded because it is server text
      // going into our log file.
      let detail = '';
      try {
        const payload = await res.json();
        if (payload && typeof payload.message === 'string') detail = payload.message.slice(0, 300);
      } catch {
        // A non-JSON body (an HTML error page from a proxy) tells us nothing we can
        // safely log — the status is the whole signal.
      }
      console.error(`[mailer] Mailgun refused the message: HTTP ${res.status}${detail ? ` — ${redact(detail, config.apiKey)}` : ''}`);
      return { sent: false, error: `HTTP ${res.status}` };
    }

    return { sent: true, to: recipient };
  } catch (e) {
    // `AbortSignal.timeout` aborts with a TimeoutError; everything else (DNS, TLS,
    // connection reset) is a network fault. Neither carries the key — it is in a
    // header, not the URL — but the log line is redacted anyway.
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    console.error(`[mailer] Mailgun request failed: ${timedOut ? 'timeout' : redact(e?.message || e?.name || 'unknown error', config.apiKey)}`);
    return { sent: false, error: timedOut ? 'timeout' : 'network' };
  }
}
