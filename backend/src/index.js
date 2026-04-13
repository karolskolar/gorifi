import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import cyclesRouter from './routes/cycles.js';
import productsRouter from './routes/products.js';
import friendsRouter from './routes/friends.js';
import ordersRouter from './routes/orders.js';
import adminRouter from './routes/admin.js';
import transactionsRouter from './routes/transactions.js';
import pickupLocationsRouter from './routes/pickup-locations.js';
import bakeryProductsRouter from './routes/bakery-products.js';
import subscriptionsRouter from './routes/subscriptions.js';
import analyticsRouter from './routes/analytics.js';
import liveCycleRouter from './routes/live-cycle.js';
import vouchersRouter from './routes/vouchers.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/cycles', cyclesRouter);
app.use('/api/products', productsRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/pickup-locations', pickupLocationsRouter);
app.use('/api/bakery-products', bakeryProductsRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/analytics/live-cycle', liveCycleRouter);
app.use('/api/vouchers', vouchersRouter);

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

app.listen(PORT, () => {
  console.log(`Server bezi na porte ${PORT}`);
});
