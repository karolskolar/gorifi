// Shared test credentials / seed constants. Defaults match seed.mjs so the
// suite is self-contained against a freshly seeded local backend. Override via
// env when running against an environment seeded differently (e.g. staging).
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'e2e-admin-pass-9271'
export const FRIENDS_PASSWORD = process.env.FRIENDS_PASSWORD || 'e2e-friends-pass'
export const FRIEND_NAME = process.env.FRIEND_NAME || 'E2ETester'
export const CYCLE_NAME = process.env.CYCLE_NAME || 'E2E Test Cycle'

// ── ⚠ NEVER LET A TEST SEND REAL MAIL (07 §UC-IA-009) ────────────────────────
// `POST /api/invitations/:id/approve` MAILS the credentials to the invitation's
// address, so any successful approval is a potential outbound send. Harmless against
// the local recipe (started with no `MAILGUN_*`, so the mailer is a documented no-op
// and says so in one boot line), but the suite is target-agnostic and the DOCUMENTED
// staging target (`BASE_URL=https://gorifi-dev.skolar.sk`) holds the real secrets in
// its `.env`: there, every approving test would fire a genuine Mailgun send to an
// `@example.*` address, which HARD-BOUNCES on the brand's only sending domain — and
// the next person running the suite gets bounce notifications they cannot explain.
//
// This lives in `fixtures.js` because more than one spec file has to answer the same
// question. Two ways to use it:
//   • `fixtureEmail(phone)` for a fixture whose address is incidental — it yields an
//     address only on a mail-safe target, so approval reports `no_recipient` off-local
//     and the transport is never reached.
//   • `test.skip(!TARGET_IS_LOCAL, NEEDS_LOCAL_TARGET)` when an assertion genuinely
//     depends on the address (a carry-over or a send outcome). A skipped test against
//     staging is fine; a surprise e-mail is not — and weakening the assertion to fit
//     the helper would be worse than either.
// ⚠ Derived from the SAME `BASE_URL` (and the same default) `playwright.config.js` uses,
// and decided on the parsed HOSTNAME — never a substring of the URL. A substring test
// would read `https://localhost.evil.example` or `https://real.host/localhost` as local
// and hand a live deployment the "safe to send" verdict. An unparseable `BASE_URL` is
// treated as NOT local: this constant gates outbound mail, so every uncertain answer has
// to fail towards "do not send".
//
// ⚠ NEVER hardcode this. A literal `false` skips the mail tests on EVERY target (the
// send path stops being covered, with a green suite); a literal `true` lets a configured
// deployment mail real people from a test run. If you force it while debugging, restore
// it in the same session.
export const TARGET_IS_LOCAL = (() => {
  const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  try {
    const url = new URL(process.env.BASE_URL || 'http://localhost:3997')
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
})()

export const NEEDS_LOCAL_TARGET = 'needs a real send outcome or an e-mail carry-through from the target — would make a configured deployment send REAL mail (§UC-IA-009). Run against the local recipe.'

// True while it is safe for a fixture to carry an address. A spec that stands up its
// OWN local backend with a stubbed Mailgun (see invitation-approval.spec.js's harness)
// flips this for the duration, because that server cannot reach Mailgun at all.
let mailSafe = TARGET_IS_LOCAL

// `localPart` is anything unique per fixture (the callers pass the invitation's phone).
export function fixtureEmail(localPart) {
  return mailSafe ? `ia3.${localPart}@example.test` : undefined
}

// Returns the PREVIOUS value, so the caller can restore it in a `finally`.
export function setMailSafeTarget(next) {
  const previous = mailSafe
  mailSafe = next
  return previous
}
