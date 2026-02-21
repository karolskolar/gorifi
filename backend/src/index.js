import express from 'express';
import cors from 'cors';
import db from './db/schema.js';
import cyclesRouter from './routes/cycles.js';
import productsRouter from './routes/products.js';
import friendsRouter from './routes/friends.js';
import ordersRouter from './routes/orders.js';
import adminRouter from './routes/admin.js';
import transactionsRouter from './routes/transactions.js';
import pickupLocationsRouter from './routes/pickup-locations.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/cycles', cyclesRouter);
app.use('/api/products', productsRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/pickup-locations', pickupLocationsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Nieco sa pokazilo' });
});

app.listen(PORT, () => {
  console.log(`Server bezi na porte ${PORT}`);
});
