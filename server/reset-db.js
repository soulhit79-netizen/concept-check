// server/reset-db.js - Safely drop and recreate all tables in Postgres
require('dotenv').config();
const readline = require('readline');
const { getPool, closeDb } = require('./db');
const { runMigration } = require('./migrate');

async function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function resetDatabase() {
  if (!process.env.DATABASE_URL) {
    console.error('\x1b[31m[Reset Error]\x1b[0m DATABASE_URL is not set in .env.');
    process.exit(1);
  }

  const isConfirmedArg = process.argv.includes('--yes') || process.argv.includes('-y');
  if (!isConfirmedArg) {
    const answer = await askConfirmation('WARNING: This will DROP all tables and delete all learner data in Concept Check. Continue? (y/N): ');
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Database reset aborted.');
      process.exit(0);
    }
  }

  console.log('Dropping existing tables in Supabase Postgres...');
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`
      DROP TABLE IF EXISTS attempt_points CASCADE;
      DROP TABLE IF EXISTS attempts CASCADE;
      DROP TABLE IF EXISTS gaps CASCADE;
      DROP TABLE IF EXISTS explanations CASCADE;
      DROP TABLE IF EXISTS learners CASCADE;
      DROP TABLE IF EXISTS key_points CASCADE;
      DROP TABLE IF EXISTS cases CASCADE;
      DROP TABLE IF EXISTS ideas CASCADE;
      DROP TABLE IF EXISTS schema_migrations CASCADE;
    `);
    await client.query('COMMIT');
    console.log('\x1b[32m[Success]\x1b[0m All tables dropped successfully.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\x1b[31m[Reset Error]\x1b[0m Failed to drop tables:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  // Re-run migration to recreate tables and RLS
  console.log('Recreating schema from db/schema.sql...');
  await runMigration();
  console.log('\x1b[32m[Success]\x1b[0m Database reset complete.');
}

if (require.main === module) {
  resetDatabase().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { resetDatabase };
