const express = require('express');
const cors = require('cors');

const products = require('./routes/products');
const searchRoutes = require('./routes/search');
const analyticsRoutes = require('./routes/analytics');
const commissionRoutes = require('./routes/commission');
const commissionCalculateRoutes = require('./routes/commission/calculate');

const { pool } = require('./db/sql');

const app = express();

// ===== Middleware =====
app.use(cors());
app.use(express.json());

// ===== Routes =====
app.use('/api/search', searchRoutes);
app.use('/api/products', products);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/commission', commissionRoutes);
app.use('/api/commission/calculate', commissionCalculateRoutes);

app.get('/api/test', (req, res) => {
  res.json({ message: 'test works' });
});

// ===== Port =====
const PORT = process.env.PORT || 47832;

// ===== Start server =====
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on port ${PORT}`);
});

// ===== Graceful shutdown handler =====
async function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  // Stop accepting new connections
  server.close(async () => {
    console.log('HTTP server closed.');

    try {
      // Close SQL connection pool
      await pool.close();
      console.log('SQL connection pool closed.');
    } catch (err) {
      console.error('Error closing SQL pool:', err);
    }

    process.exit(0);
  });

  // Force exit if shutdown takes too long
  setTimeout(() => {
    console.error('Force shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

// Windows service / Docker / PM2
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Catch unexpected crashes
process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', err => {
  console.error('Unhandled Rejection:', err);
  shutdown('unhandledRejection');
});
