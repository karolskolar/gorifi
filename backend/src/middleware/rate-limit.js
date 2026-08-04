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
//
// Limits are per client IP. Because the app runs behind nginx/PM2, index.js
// sets `trust proxy` so the real client IP (not the proxy's) is used.
//
// ⚠ Each exported limiter below is a SEPARATE bucket. That matters: the guest
// surface (/api/guest) is shared privately at office scale, so a whole team
// typically arrives behind ONE NAT'd IP. While it sat on `abuseLimiter` it
// competed with invite-code lookups and onboarding submits for the same 40
// attempts, so a busy order could lock colleagues out of registering — and vice
// versa. Guest reads and writes are also split, because a page load is cheap and
// gets repeated (every colleague opening the link, every refresh) while a submit
// is not. Do not collapse these back onto one limiter.
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const AUTH_MAX = parseInt(process.env.RATE_LIMIT_AUTH_MAX, 10) || 20;
const ABUSE_MAX = parseInt(process.env.RATE_LIMIT_ABUSE_MAX, 10) || 40;
const GUEST_READ_MAX = parseInt(process.env.RATE_LIMIT_GUEST_READ_MAX, 10) || 300;
const GUEST_WRITE_MAX = parseInt(process.env.RATE_LIMIT_GUEST_WRITE_MAX, 10) || 60;

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
