const sql = require('mssql');
const { ensureSchema } = require('./ensure-schema');
const { readSqlInstance } = require('./read-registry');
let schemaEnsuring = false;


async function createPool() {
  let serverName;

  if (process.env.DB_SERVER) {
    serverName = process.env.DB_SERVER;
  } else {
    serverName = await readSqlInstance();
  }

  if (serverName === '.' || serverName === '(local)') {
    serverName = 'localhost';
  } else if (serverName.startsWith('(local)\\')) {
    serverName = serverName.replace('(local)', 'localhost');
  }

  console.log('Connecting to SQL Server at:', serverName);

  // Default config using SQL Auth
  let config = {
    server: serverName,
    database: process.env.DB_NAME || 'ShortcutsPOS',
    user: process.env.DB_USER || 'scReceipt',
    password: process.env.DB_PASSWORD || 'Harris211*',
    options: {
      encrypt: false,
      trustServerCertificate: true
    },
    requestTimeout: 500000
  };

  let pool;
  let isSqlAuth = true; // flag to tell ensureSchema if using SQL Auth

  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();
    console.log('DB connected using SQL Authentication to', serverName);
  } catch (err) {
    console.warn('SQL Auth failed, trying Windows Authentication...', err.message);

    // Fallback to Windows Authentication
    config = {
      server: serverName,
      database: process.env.DB_NAME || 'ShortcutsPOS',
      options: {
        encrypt: false,
        trustServerCertificate: true,
        integratedSecurity: true // This enables Windows Authentication
      },
      requestTimeout: 500000
    };

    pool = new sql.ConnectionPool(config);
    await pool.connect();
    console.log('DB connected using Windows Authentication to', serverName);

    isSqlAuth = false; // mark that we are using Windows Auth
  }

  // Pass the flag to ensureSchema
  await ensureSchema(pool, isSqlAuth);
  console.log('Schema ensured');
  // 🔁 Periodic schema enforcement (watcher)
setInterval(async () => {
  if (schemaEnsuring) return;

  schemaEnsuring = true;
  try {
    await ensureSchema(pool, isSqlAuth);
    console.log('Schema re-checked');
  } catch (err) {
    console.error('Schema check failed:', err);
  } finally {
    schemaEnsuring = false;
  }
}, 5 * 60 * 1000); // every 5 minutes

  pool.on('error', err => {
    console.error('SQL Pool Error:', err);
  });

  return pool;
}

const poolPromise = createPool();
module.exports = { sql, poolPromise };
