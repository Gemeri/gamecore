// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  // base users table (create if missing)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      nickname TEXT,
      google_id TEXT,
      verified BOOLEAN NOT NULL DEFAULT true
    );
  `);

  // Eesure columns / defaults exist on older DBs
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT true;
  `);

  // make sure default is true (for existing installations that had DEFAULT false)
  await pool.query(`ALTER TABLE users ALTER COLUMN verified SET DEFAULT true;`);

  // backfill any existing rows to verified=true
  await pool.query(`UPDATE users SET verified = true WHERE verified IS NOT TRUE;`);

  // password reset tokens
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  // failed login audit
  await pool.query(`
    CREATE TABLE IF NOT EXISTS failed_logins (
      id SERIAL PRIMARY KEY,
      email TEXT,
      ip INET,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

init().catch(err => console.error('DB init error', err));
module.exports = pool;
