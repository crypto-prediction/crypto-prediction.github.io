import { createPool, migrate } from './db.js';

const pool = createPool();
migrate(pool)
  .then(() => { console.log('Database schema is up to date.'); return pool.end(); })
  .catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
