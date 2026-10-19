// server/migrate.js - Migration runner for Supabase Postgres
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool, closeDb } = require('./db');

async function runMigration() {
  if (!process.env.DATABASE_URL) {
    console.error('Migration error: DATABASE_URL is not set in .env.');
    console.error('Please add your Supabase Postgres connection string to .env and retry.');
    process.exit(1);
  }

  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error(`Migration error: Schema file not found at ${schemaPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');

  let client;
  try {
    const pool = getPool();
    client = await pool.connect();
  } catch (connErr) {
    console.error('Migration connection error:', connErr.message);
    process.exit(1);
  }

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(`
      INSERT INTO schema_migrations (version) 
      VALUES ('001_initial_schema') 
      ON CONFLICT (version) DO NOTHING;
    `);
    await client.query('COMMIT');

    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    const tableNames = res.rows.map(r => r.table_name);
    console.log(`Verified ${tableNames.length} tables in public schema: ${tableNames.join(', ')}`);
    console.log('migration complete');
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Migration query error:', err.message);
    process.exit(1);
  } finally {
    if (client) {
      client.release();
    }
    await closeDb();
  }
}

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration error:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigration };
