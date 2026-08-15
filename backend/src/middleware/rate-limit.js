import rateLimit from 'express-rate-limit';

// Rate limiters for brute-force / abuse-prone endpoints (SEC-F2, audit §H2).
//
// Tunable via env so tests (and ops) can adjust without code changes:
//   RATE_LIMIT_WINDOW_MS  — sliding window in ms (default 15 min)
//   RATE_LIMIT_AUTH_MAX   — max attempts/window for login & friend auth (default 20)
//   RATE_LIMIT_ABUSE_MAX  — max attempts/window for registration / invite-code
//                           lookup / onboarding submit (default 40)
//   RATE_LIMIT_GUEST_READ_MAX  — max guest page loads/window (default 300)
//   RATE_LIMIT_GUEST_WRITE_MAX — max guest submits/edits/window (default 60)
//   RATE_LIMIT_MAGIC_MAX  — max magic-link requests/window (default 10)
//
// Limits are per client IP. Because the app runs behind nginx/PM2, index.js
// sets `trust proxy` so the real client IP (not the proxy's) is used.
//
// ⚠ Each of the FIVE limiters exported below is a SEPARATE bucket, and each split
// was paid for by a real failure mode. Do not collapse them back onto one limiter.
//
//   • GUEST vs ABUSE. The guest surface (/api/guest) is shared privately at office
//     scale, so a whole team typically arrives behind ONE NAT'd IP. While it sat on
//     `abuseLimiter` it competed with invite-code lookups and onboarding submits for
//     the same 40 attempts, so a busy order could lock colleagues out of registering
//     — and vice versa. Guest reads and writes are split from each other too, because
//     a page load is cheap and gets repeated (every colleague opening the link, every
//     refresh) while a submit is not.
//   • MAGIC-LINK vs AUTH (09 §UC-ML-003, ML-T2). Two independent reasons:
//     (a) COST — an accepted magic-link request triggers an outbound Mailgun send.
//         No other bucket guards an endpoint that spends money and sender reputation
//         per hit, so its budget has to be settable on its own (and starts low: 10).
//     (b) THE SAME OFFICE-NAT COUPLING. On `authLimiter`, one colleague spamming
//         "Zabudli ste heslo?" from the shared IP would lock everyone else out of
//         PASSWORD LOGIN — exactly the moment they need it — and a busy login morning
//         would silently disable recovery. Pinned by
//         `e2e/tests/magic-link-rate-limit.spec.js` (self-skips unless started with a
//         low RATE_LIMIT_MAGIC_MAX).
//     Note the per-friend 60 s cooldown in the request handler is a SECOND, orthogonal
//     bound: the limiter caps requests per IP, the cooldown caps mails per friend.
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const AUTH_MAX = parseInt(process.env.RATE_LIMIT_AUTH_MAX, 10) || 20;
const ABUSE_MAX = parseInt(process.env.RATE_LIMIT_ABUSE_MAX, 10) || 40;
const GUEST_READ_MAX = parseInt(process.env.RATE_LIMIT_GUEST_READ_MAX, 10) || 300;
const GUEST_WRITE_MAX = parseInt(process.env.RATE_LIMIT_GUEST_WRITE_MAX, 10) || 60;
const MAGIC_MAX = parseInt(process.env.RATE_LIMIT_MAGIC_MAX, 10) || 10;

function makeLimiter(limit) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ error: 'Príliš veľa pokusov, skúste to neskôr' });
    },
  });
}

// Strict: password-guessing surfaces (admin login, friend auth).
export const authLimiter = makeLimiter(AUTH_MAX);

// Moderate: public write / lookup surfaces (registration, invite-code lookup,
// onboarding self-signup) — abuse/enumeration protection.
export const abuseLimiter = makeLimiter(ABUSE_MAX);

// Guest surface (/api/guest), on its own buckets — see the note above. Generous
// on reads (a whole office opens the same link from one IP), moderate on writes.
export const guestReadLimiter = makeLimiter(GUEST_READ_MAX);
export const guestWriteLimiter = makeLimiter(GUEST_WRITE_MAX);

// Magic-link recovery (POST /api/magic-link/request), on its own bucket — see the
// note above. Deliberately the tightest budget in the file: every accepted request
// can cost an outbound e-mail.
export const magicLinkLimiter = makeLimiter(MAGIC_MAX);
