// server/db.js - PostgreSQL connection pool for Supabase Postgres
require('dotenv').config();
const { Pool, types } = require('pg');

// Automatically parse Postgres INT8 (bigint/identity) as integer
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10));

let poolInstance = null;

function getPool() {
  if (!poolInstance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.warn('[DB] Warning: DATABASE_URL is not set. Set it in .env to connect to Supabase.');
    }

    const isLocal = connectionString && (
      connectionString.includes('localhost') || 
      connectionString.includes('127.0.0.1')
    );

    poolInstance = new Pool({
      connectionString: connectionString || undefined,
      ssl: isLocal ? false : { rejectUnauthorized: false }
    });

    poolInstance.on('error', (err) => {
      console.error('[DB Pool Error]', err.message);
    });
  }
  return poolInstance;
}

/**
 * Async query helper for Postgres parameterized queries ($1, $2, ...)
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = []) {
  const pool = getPool();
  return pool.query(text, params);
}

/**
 * Health check helper to test database connectivity
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function checkDbConnection() {
  if (!process.env.DATABASE_URL) {
    return { ok: false, error: 'DATABASE_URL not set in environment' };
  }
  try {
    const pool = getPool();
    await pool.query('SELECT 1 AS check');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const { createClient } = require('@supabase/supabase-js');

let supabaseInstance = null;

function getSupabase() {
  if (!supabaseInstance && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabaseInstance = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
  return supabaseInstance;
}

/**
 * Close the connection pool gracefully
 */
async function closeDb() {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}

module.exports = {
  getPool,
  query,
  checkDbConnection,
  getSupabase,
  closeDb
};
