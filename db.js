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
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      likes_count INTEGER NOT NULL DEFAULT 0,
      favorites_count INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'private',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(owner_id, slug)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS projects_visibility_idx ON projects(visibility);
  `);

  await pool.query(`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS slug TEXT;
  `);

  await pool.query(`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS likes_count INTEGER NOT NULL DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS favorites_count INTEGER NOT NULL DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
  `);

  await pool.query(`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  `);

  await pool.query(`
    UPDATE projects SET slug = 'legacy-project' || id::text WHERE slug IS NULL;
  `);

  await pool.query(`
    ALTER TABLE projects
      ALTER COLUMN slug SET NOT NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_likes (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_favorites (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, user_id)
    );
  `);
}

init().catch(err => console.error('DB init error', err));
module.exports = pool;
