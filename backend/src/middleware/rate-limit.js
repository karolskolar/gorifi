import rateLimit from 'express-rate-limit';

// Rate limiters for brute-force / abuse-prone endpoints (SEC-F2, audit §H2).
//
// Tunable via env so tests (and ops) can adjust without code changes:
//   RATE_LIMIT_WINDOW_MS  — sliding window in ms (default 15 min)
//   RATE_LIMIT_AUTH_MAX   — max attempts/window for login & friend auth (default 20)
//   RATE_LIMIT_ABUSE_MAX  — max attempts/window for registration / invite-code
//                           lookup / onboarding submit (default 40)
//
// Limits are per client IP. Because the app runs behind nginx/PM2, index.js
// sets `trust proxy` so the real client IP (not the proxy's) is used.
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const AUTH_MAX = parseInt(process.env.RATE_LIMIT_AUTH_MAX, 10) || 20;
const ABUSE_MAX = parseInt(process.env.RATE_LIMIT_ABUSE_MAX, 10) || 40;

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
