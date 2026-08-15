import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import db from './db/schema.js';
import { allowedOrigins } from './config/origins.js';
import { requireAdmin } from './middleware/admin-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import cyclesRouter from './routes/cycles.js';
import productsRouter from './routes/products.js';
import friendsRouter from './routes/friends.js';
import ordersRouter from './routes/orders.js';
import orderItemsRouter from './routes/order-items.js';
import guestOrderItemsRouter from './routes/guest-order-items.js';
import adminRouter from './routes/admin.js';
import transactionsRouter from './routes/transactions.js';
import pickupLocationsRouter from './routes/pickup-locations.js';
import bakeryProductsRouter from './routes/bakery-products.js';
import subscriptionsRouter from './routes/subscriptions.js';
import analyticsRouter from './routes/analytics.js';
import liveCycleRouter from './routes/live-cycle.js';
import vouchersRouter from './routes/vouchers.js';
import friendGroupsRouter from './routes/friend-groups.js';
import rewardsRouter from './routes/rewards.js';
import invitationsRouter from './routes/invitations.js';
import roasteriesRouter from './routes/roasteries.js';
import onboardingRouter from './routes/onboarding.js';
import guestLinksRouter from './routes/guest-links.js';
import guestOrdersRouter from './routes/guest-orders.js';
import guestRouter from './routes/guest.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Behind nginx/PM2: trust the first proxy hop so express-rate-limit and any
// IP-based logic see the real client IP, not the proxy's. Use a specific hop
// count (not `true`) to avoid the permissive trust-proxy validation warning.
app.set('trust proxy', 1);

// Middleware
// Lock CORS to an explicit allowlist. In production the SPA is served
// same-origin by this same Express process (express.static below), so CORS is
// only really needed for the local dev flow (Vite on :5173 → API on :3000) and
// the staging domain. Override with CORS_ORIGIN (comma-separated) if needed.
//
// ⚠ The list itself now lives in `config/origins.js` — unchanged semantics, but
// `helpers/credentials-message.js` needs the SAME list to decide which `Origin`
// may be echoed into an outbound e-mail (07 §UC-IA-009). Two copies could drift.
app.use(cors({
  origin(origin, callback) {
    // Allow same-origin / non-browser requests (curl, health checks) that send no Origin header
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Routes
// Routers with a mix of public/friend/admin routes gate admin routes
// individually with requireAdmin (applied inside each route file).
app.use('/api/cycles', cyclesRouter);
app.use('/api/products', productsRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/pickup-locations', pickupLocationsRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/vouchers', vouchersRouter);
app.use('/api/invitations', invitationsRouter);
app.use('/api', onboardingRouter);
// Friend-authenticated (host) surface — NOT admin. Auth is enforced per route
// inside the router, which requires a resolved per-friend identity.
app.use('/api/guest-links', guestLinksRouter);
// Guest sub-order mutations. MIXED host + admin router, so the mount stays bare
// and each route states its own guard: the host owns `delivered` and the removal
// (GSO-T5), while GSO-T6 adds the admin's `paid` toggle and unpaid overview here
// with requireAdmin. Wrapping this mount in either guard would break the other.
app.use('/api/guest-orders', guestOrdersRouter);
// Public guest ordering — the URL token is the whole credential, so this mount
// stays bare (no admin, no friend auth). Every route inside is abuse-rate-limited.
app.use('/api/guest', guestRouter);

// Fully-admin routers: every route is privileged, so gate the whole mount.
app.use('/api/bakery-products', requireAdmin, bakeryProductsRouter);
app.use('/api/analytics', requireAdmin, analyticsRouter);
app.use('/api/analytics/live-cycle', requireAdmin, liveCycleRouter);
app.use('/api/friend-groups', requireAdmin, friendGroupsRouter);
app.use('/api/analytics/rewards', requireAdmin, rewardsRouter);
app.use('/api/roasteries', requireAdmin, roasteriesRouter);
app.use('/api/order-items', requireAdmin, orderItemsRouter);
// GSO-T7: the guest half of the per-item Distribution checkbox. Admin-only, unlike
// the MIXED-auth /api/guest-orders router next door — nothing a host or a guest
// does touches this flag.
app.use('/api/guest-order-items', requireAdmin, guestOrderItemsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve the built frontend, when one is present.
//
// `backend/public` is BUILD OUTPUT and is git-ignored — production does not use
// it at all (nginx serves /var/www/gorifi/frontend/dist and only proxies /api
// here, see deploy/nginx-gorifi.conf). It exists for running the app as a single
// prod-like process locally, which is what the e2e recipe does:
//   cd frontend && npm run build && rm -rf ../backend/public && cp -r dist ../backend/public
// It used to be committed, which meant a fresh clone silently served a months-old
// frontend against current API code. Absent is better than stale — but say so
// clearly rather than throwing an opaque 500 from sendFile.
const publicPath = join(__dirname, '..', 'public');
const indexHtml = join(publicPath, 'index.html');
app.use(express.static(publicPath));
app.get(/^\/(?!api).*/, (req, res) => {
  if (!existsSync(indexHtml)) {
    return res.status(503).type('text/plain').send(
      'No frontend build found in backend/public.\n\n'
      + 'The API is running — this only affects serving the UI from this process.\n'
      + 'Build it with:\n'
      + '  cd frontend && npm run build && rm -rf ../backend/public && cp -r dist ../backend/public\n'
    );
  }
  res.sendFile(indexHtml);
});

// Error handler
//
// ⚠ The 4-arg signature is what makes Express treat this as an ERROR handler —
// `next` is unused on purpose, do not "clean it up".
//
// `express.json` is mounted above every router, so a body it refuses never reaches
// a route: unparsable JSON, a scalar body (`null`, `"hi"` — its default `strict`
// mode accepts only an object or an array), an oversized payload, an unsupported
// charset. All of those are CLIENT mistakes, and this handler used to report them
// as 500 on every JSON endpoint in the app (07 §Follow-ups item 1 / FUP-T3).
//
// Translation rule: PRESERVE a 4xx the error already carries, rather than forcing
// every client error to 400. body-parser has already classified the failure and
// picked the right status — 400 `entity.parse.failed`, 413 `entity.too.large`,
// 415 `encoding.unsupported` / `charset.unsupported` — and 413/415 are strictly
// more actionable for the caller than a blanket "bad request". Keying on the
// status range rather than on a `type` allowlist is also the safer generalisation
// here: `err.status` is only ever set by middleware that has decided the fault is
// the caller's, and no route or helper in this codebase throws with a status (every
// `throw` is a bare `Error`), so nothing that is genuinely a server fault can
// reach the 4xx branch. Anything without a 4xx status keeps its 500 — including
// the CORS rejection above, which rejects with a bare `Error`.
const CLIENT_ERROR_MESSAGES = {
  413: 'Poziadavka je prilis velka',
  415: 'Nepodporovany format poziadavky',
};

// FUP-T6: multer's `MulterError` is a client-error source the rule above cannot see.
//
// ⚠ It is not the LAST one. multer also raises PLAIN `Error`s for malformed or
// aborted multipart ("Multipart: Boundary not found", "Unexpected end of form",
// "Request aborted"), which carry no `code` either and so still take the 500
// branch WITH a stack log — including the ordinary case of an admin's upload
// dropping mid-flight. Deliberately not fixed here: matching on busboy message
// strings is exactly the brittle coupling this status-based rule avoids, and all
// five upload routes are admin-guarded, so it is authenticated-only. Recorded as
// its own backlog row (FUP-T7) rather than widened into this one.
//
// A `MulterError` carries `code` and `field` but NO `status`, so an upload past
// the 5 MB cap in `routes/products.js` / `routes/bakery-products.js` fell through
// to the 500 branch — a pure client mistake answered as a server fault, and (worse)
// a remotely triggerable full stack in the log on every hit, which is exactly what
// the 4xx branch below exists to avoid.
//
// The translation lives HERE rather than per-route on purpose: multer is per-route
// middleware but its errors are delivered with `next(err)`, and neither upload router
// installs an error handler of its own, so every one of the five `upload.single(...)`
// routes across the two routers already arrives at this handler (verified live — the
// pre-fix 500s were logged from this branch). One mapping therefore covers all of
// them, and future upload routes inherit it; five per-route copies would drift, and
// each would have to re-state the two decisions documented above.
//
// Giving the error a status here — rather than answering it separately — is what
// makes it flow through the 4xx branch, so it inherits BOTH of those decisions for
// free: no stack log, and `err.message` never echoed (multer's text is terse, but
// `LIMIT_UNEXPECTED_FILE`'s quotes the client-supplied field name back at it).
//
// LIMIT_FILE_SIZE is the only "too large" code; every other code (LIMIT_UNEXPECTED_FILE,
// LIMIT_FILE_COUNT, LIMIT_PART_COUNT, LIMIT_FIELD_KEY/VALUE/COUNT) describes a
// malformed multipart request, which is a plain 400.
const MULTER_STATUS_BY_CODE = { LIMIT_FILE_SIZE: 413 };

function multerStatus(err) {
  if (!(err instanceof multer.MulterError)) return null;
  return MULTER_STATUS_BY_CODE[err.code] || 400;
}

app.use((err, req, res, next) => {
  const carried = err && (err.status != null ? err.status : err.statusCode);
  const status = Number(carried != null ? carried : multerStatus(err));
  const isClientError = Number.isInteger(status) && status >= 400 && status < 500;

  if (isClientError) {
    // ⚠ Deliberately NOT `console.error(err.stack)`. This branch is reachable by
    // any unauthenticated client with one malformed request, so a full stack per
    // hit is a free remote log-flood on a box whose logs are not rotated per
    // request volume. One compact line keeps what is actually diagnostic (which
    // endpoint, which kind of bad body) at a bounded cost.
    // `err.code` is the multer branch's diagnostic (LIMIT_FILE_SIZE, …) — a fixed
    // enum from the library, never client text. `err.field` is client-supplied and
    // deliberately not logged.
    console.warn(`Chybna poziadavka: ${req.method} ${req.originalUrl} (${err.type || err.code || 'client-error'}, ${status})`);
    // Never echo `err.message`: body-parser's text quotes the offending input and
    // names a byte offset. Slovak and unaccented, matching the 500 below.
    return res.status(status).json({ error: CLIENT_ERROR_MESSAGES[status] || 'Neplatna poziadavka' });
  }

  console.error(err.stack);
  res.status(500).json({ error: 'Nieco sa pokazilo' });
});

// Bind to loopback by default so the app is only reachable via the in-container
// nginx (which proxies to 127.0.0.1) and never directly on the LAN. Override
// with HOST=0.0.0.0 if a deployment genuinely needs external binding. Keep this
// in sync with the hardened server (SEC-I2).
app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`Server bezi na porte ${PORT} (${process.env.HOST || '127.0.0.1'})`);
});
