'use strict';
const { Pool, types } = require('pg');
const config = require('./config');

// BIGINT (20) and NUMERIC (1700) come back as strings by default; ids and counts here are well inside Number range.
types.setTypeParser(20, (v) => parseInt(v, 10));
types.setTypeParser(1700, (v) => parseFloat(v));

function sslOption() {
  const mode = config.databaseSsl;
  if (mode === 'disable') return false;
  let host = '';
  try { host = new URL(config.databaseUrl).hostname; } catch (_) { /* ignore */ }
  const isLocal = ['localhost', '127.0.0.1', '::1', ''].includes(host);
  if (mode === 'verify') return { rejectUnauthorized: true };
  if (mode === 'require') return { rejectUnauthorized: false };
  return isLocal ? false : { rejectUnauthorized: false };
}

let pool = null;
function getPool() {
  if (!pool) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set. Copy .env.example to .env and set it (see README).');
    }
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: sslOption(),
      max: parseInt(process.env.DB_POOL_MAX || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => console.error('[db] idle client error', err.message));
  }
  return pool;
}

const query = (text, params) => getPool().query(text, params);

/** Run fn(client) inside a transaction. Rolls back on any error. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, tx, getPool, close };
