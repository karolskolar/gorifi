import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db/schema.js';
import { requireAdmin } from './middleware/admin-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import cyclesRouter from './routes/cycles.js';
import productsRouter from './routes/products.js';
import friendsRouter from './routes/friends.js';
import ordersRouter from './routes/orders.js';
import orderItemsRouter from './routes/order-items.js';
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
const allowedOrigins = (process.env.CORS_ORIGIN
  || 'https://gorifi.skolar.sk,https://gorifi-dev.skolar.sk,http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend static files in production
const publicPath = join(__dirname, '..', 'public');
app.use(express.static(publicPath));
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(join(publicPath, 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
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
