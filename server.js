const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const FormData = require('form-data');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const csslint = require('csslint').CSSLint;
const stringSimilarity = require('string-similarity');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const argon2 = require('argon2');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const svgCaptcha = require('svg-captcha');
const pool = require('./db');
require('dotenv').config();
const { ESLint } = require("eslint");
const jsLinter = new ESLint();
const crypto = require('crypto');
const Joi = require('joi');
const csrf = require('csurf');
const PGStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mime = require('mime-types');
const app = express();

const port = 3000;
const APP_HOST = 'localhost';
const APP_URL = `http://${APP_HOST}:${port}`;
const PREVIEW_HOST = '127.0.0.1';
const PREVIEW_PORT = Number(4000);
const PREVIEW_HTTP = `http://${PREVIEW_HOST}:${PREVIEW_PORT}`;
const PREVIEW_HTTPS = `https://${PREVIEW_HOST}:${PREVIEW_PORT}`;
const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;
const previewTokens = new Map();
const PROJECTS_DIR = 'projects';
const PROJECT_META = 'projects.json';
const RESERVED_PROJECT_NAMES = new Set([PROJECTS_DIR, PROJECT_META]);
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const BAN_MS = 30 * 60 * 1000;
const ipTracker = new Map();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 5 });
const genLimiter = rateLimit({ windowMs: 60 * 1000, max: 3 });
const heavyLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 2 });
const fileOpsLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const HISTORY_FILE = path.join(__dirname, 'conversationHistory.json');
const SAVED_PROTOTYPE = path.join(__dirname, 'prototype', 'quick-prototype.html');
const RECAPTCHA_MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "base-uri": ["'self'"],
      "object-src": ["'none'"],

      // media & assets
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],

      // styles
      "style-src": [
        "'self'", "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdn.jsdelivr.net",
        "https://unpkg.com"
      ],
      "style-src-attr": ["'unsafe-inline'"],

      // scripts
      "script-src": [
        "'self'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        "'wasm-unsafe-eval'",
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
        "https://unpkg.com",
        "https://www.google.com",
        "https://www.gstatic.com"
      ],
      "script-src-attr": ["'unsafe-inline'"],

      // workers/frames/connect
      "worker-src": ["'self'", "blob:"],
      "child-src": ["'self'", PREVIEW_HTTP, PREVIEW_HTTPS],
      "frame-src": [
        "'self'",
        "https://www.google.com",
        "https://recaptcha.net",
        "https://pygame-web.github.io",
        PREVIEW_HTTP,
        PREVIEW_HTTPS
      ],
      "media-src": ["'self'", "data:", "blob:"],
      "connect-src": [
        "'self'",
        "blob:",
        "data:",
        "https://api.openai.com",
        "https://api.anthropic.com",
        "https://www.google.com",
        "https://www.gstatic.com",
        "https://pygame-web.github.io"
      ],
    }
  },
  crossOriginOpenerPolicy: process.env.ENABLE_COEP ? { policy: "same-origin" } : false,
  crossOriginEmbedderPolicy: process.env.ENABLE_COEP ? { policy: "require-corp" } : false
}));

function genPaths(req, ...sub) {
  const projectId = req.session?.selectedProject || 'draft';
  const root = ensureProjectRoot(req, projectId);
  return path.join(root, ...sub);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = genPaths(req, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
    const safeExts = new Set([
      '.png','.jpg','.jpeg','.webp','.gif',
      '.txt','.md','.json','.csv','.html','.css','.js',
      '.mp3','.wav','.ogg','.mp4','.webm','.mov',
      '.py','.java','.cpp','.ts'
    ]);

    const finalExt = safeExts.has(ext) ? ext : '';
    const name = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${finalExt}`;
    cb(null, name);
  }
});

function ensureDirs(req) {
  const uid = String(req.session?.userId || (req.user && req.user.id) || 'global');
  const dirs = [
    path.join(__dirname, 'generated', uid),
    path.join(__dirname, 'generated', uid, 'uploads'),
    path.join(__dirname, 'old-generated', uid),
  ];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

function getUserId(req) {
  return String(req.session?.userId || (req.user && req.user.id) || 'global');
}

function getUserBasePath(req) {
  return path.join(__dirname, 'generated', getUserId(req));
}

function getUserBasePathById(userId) {
  return path.join(__dirname, 'generated', String(userId));
}

function getProjectRootByUserId(userId, projectId) {
  const base = getUserBasePathById(userId);
  if (!projectId || projectId === 'draft') return base;
  return path.join(base, PROJECTS_DIR, projectId);
}

function isProjectPublic(visibility) {
  return typeof visibility === 'string' && visibility.trim().toLowerCase() === 'public';
}

function loadProjectList(req) {
  ensureDirs(req);
  const metaPath = path.join(getUserBasePath(req), PROJECT_META);
  if (!fs.existsSync(metaPath)) return [];
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(p => p && typeof p.id === 'string' && p.id.trim())
      .map(p => ({
        id: p.id,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Untitled Project',
        visibility: isProjectPublic(p.visibility) ? 'public' : 'private'
      }));
  } catch (err) {
    console.error('Failed to read project metadata', err);
    return [];
  }
}

function saveProjectList(req, projects) {
  ensureDirs(req);
  const metaPath = path.join(getUserBasePath(req), PROJECT_META);
  fs.writeFileSync(metaPath, JSON.stringify(projects, null, 2));
}

function getProjectRoot(req, projectId) {
  const base = getUserBasePath(req);
  if (projectId && projectId !== 'draft') {
    return path.join(base, PROJECTS_DIR, projectId);
  }
  return base;
}

function ensureProjectRoot(req, projectId) {
  ensureDirs(req);
  const base = getUserBasePath(req);
  if (projectId && projectId !== 'draft') {
    const projectsDir = path.join(base, PROJECTS_DIR);
    if (!fs.existsSync(projectsDir)) fs.mkdirSync(projectsDir, { recursive: true });
    const target = path.join(projectsDir, projectId);
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    return target;
  }
  return base;
}

function ensureActiveProject(req) {
  const projects = loadProjectList(req);
  let active = req.session?.selectedProject || 'draft';
  if (active !== 'draft' && !projects.some(p => p.id === active)) {
    active = 'draft';
    if (req.session) req.session.selectedProject = 'draft';
  }
  ensureProjectRoot(req, active);
  return { active, projects };
}

function sendPublicProjectFile(res, ownerId, slug, projectNumericId, relPath) {
  let clean = (relPath || '').replace(/^\/+/, '');
  if (!clean) clean = 'index.html';

  try {
    if (!slug) return res.status(404).end();
    if (path.isAbsolute(clean) || clean.includes('\0')) throw new Error('bad path');
    const normalized = clean.replace(/\\/g, '/');
    if (normalized.split('/').some(p => p === '..')) throw new Error('bad path');

    const base = path.resolve(getProjectRootByUserId(ownerId, slug));
    if (!fs.existsSync(base)) return res.status(404).end();
    const full = path.resolve(base, normalized);
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error('bad path');
    if (!fs.existsSync(full)) {
      if (normalized === 'index.html') {
        return res
          .status(200)
          .type('text/html')
          .send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Missing index.html</title>
    <style>
      body{margin:0;font-family:system-ui,Segoe UI,sans-serif;background:#080512;color:#EEE9FF;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px;}
      main{max-width:540px;background:rgba(28,19,50,0.85);border:1px solid rgba(255,255,255,0.12);border-radius:18px;box-shadow:0 18px 40px rgba(0,0,0,0.45);padding:32px;}
      h1{font-weight:600;margin-bottom:12px;}
      p{color:#B6B0D4;line-height:1.6;}
    </style>
  </head>
  <body>
    <main>
      <h1>Missing start file</h1>
      <p>This public project does not have an <code>index.html</code> file or it is not accessible. Ask the creator to add one so the project can be played from here.</p>
    </main>
  </body>
</html>`);
      }
      return res.status(404).end();
    }

    const ctype = mime.lookup(full) || 'application/octet-stream';
    res.setHeader('Content-Type', ctype);
    if (ctype.startsWith('text/html')) {
      let html = fs.readFileSync(full, 'utf8');
      if (!/<base\s/i.test(html)) {
        const baseTag = `<base href="/public-preview/${projectNumericId}/">`;
        const injected = html.replace(/<head[^>]*>/i, match => `${match}${baseTag}`);
        html = injected === html ? `${baseTag}\n${html}` : injected;
      }
      return res.send(html);
    }

    return res.sendFile(full);
  } catch (err) {
    return res.status(400).end();
  }
}

async function handleProjectReaction(req, res, tableName, countColumn) {
  const projectId = Number.parseInt(req.params.projectId, 10);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Invalid project id' });
  }

  const currentUserId = req.session?.userId || (req.user && req.user.id);
  if (!currentUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projectRows } = await client.query(
      'SELECT visibility FROM projects WHERE id=$1 FOR UPDATE',
      [projectId]
    );
    const project = projectRows[0];
    if (!project || !isProjectPublic(project.visibility)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not available' });
    }

    const existing = await client.query(
      `SELECT 1 FROM ${tableName} WHERE project_id=$1 AND user_id=$2`,
      [projectId, currentUserId]
    );

    if (existing.rowCount > 0) {
      await client.query(
        `DELETE FROM ${tableName} WHERE project_id=$1 AND user_id=$2`,
        [projectId, currentUserId]
      );
    } else {
      await client.query(
        `INSERT INTO ${tableName}(project_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [projectId, currentUserId]
      );
    }

    const { rows: countsRows } = await client.query(
      `UPDATE projects
          SET ${countColumn} = (SELECT COUNT(*) FROM ${tableName} WHERE project_id=$1),
              updated_at = NOW()
        WHERE id=$1
        RETURNING likes_count, favorites_count`,
      [projectId]
    );

    const counts = countsRows[0] || { likes_count: 0, favorites_count: 0 };

    const { rowCount: likedCount } = await client.query(
      'SELECT 1 FROM project_likes WHERE project_id=$1 AND user_id=$2',
      [projectId, currentUserId]
    );
    const { rowCount: favoritedCount } = await client.query(
      'SELECT 1 FROM project_favorites WHERE project_id=$1 AND user_id=$2',
      [projectId, currentUserId]
    );

    await client.query('COMMIT');

    return res.json({
      project: {
        id: projectId,
        likes: Number(counts.likes_count) || 0,
        favorites: Number(counts.favorites_count) || 0,
        liked: likedCount > 0,
        favorited: favoritedCount > 0
      }
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Failed to rollback reaction transaction', rollbackErr);
    }
    console.error('Failed to toggle project reaction', err);
    return res.status(500).json({ error: 'Failed to update project' });
  } finally {
    client.release();
  }
}

async function syncProjectsToDatabase(userId, projects) {
  if (!userId || !Array.isArray(projects) || !projects.length) return;
  const filtered = projects.filter(p => p && p.id && p.id !== 'draft');
  if (!filtered.length) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const project of filtered) {
      await client.query(
        `INSERT INTO projects(owner_id, slug, name, visibility)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner_id, slug)
         DO UPDATE SET name = EXCLUDED.name, visibility = EXCLUDED.visibility, updated_at = NOW()`,
        [userId, project.id, project.name, project.visibility]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function ensureProjectContext(req, res, next) {
  try {
    const { active, projects } = ensureActiveProject(req);
    req.currentProjectId = active;
    req.projectList = projects;
    const userId = req.session?.userId || (req.user && req.user.id);
    if (userId) {
      try {
        await syncProjectsToDatabase(userId, projects);
      } catch (err) {
        console.error('Failed to sync projects to database', err);
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}

function generateProjectId(name, existing) {
  const base = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
  let candidate = base;
  let counter = 1;
  while (existing.has(candidate) || candidate === 'draft') {
    candidate = `${base}-${counter++}`;
  }
  return candidate;
}

function copyProjectContents(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (RESERVED_PROJECT_NAMES.has(entry.name)) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(from, to, { recursive: true, force: true });
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function clearProjectContents(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    if (RESERVED_PROJECT_NAMES.has(entry.name)) return;
    const target = path.join(dir, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
  });
}

function newPreviewToken(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  previewTokens.set(token, { userId: String(userId), expiresAt: Date.now() + PREVIEW_TOKEN_TTL_MS });
  return token;
}

function valPreviewToken(token) {
  const rec = previewTokens.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) { previewTokens.delete(token); return null; }
  return rec.userId;
}

function safeJoin(req, relPath) {
  if (typeof relPath !== 'string') throw new Error('bad path');
  if (path.isAbsolute(relPath) || relPath.includes('\0')) throw new Error('bad path');
  // normalize and reject sneaky parent segments
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, ''); //regex
  if (normalized.split('/').some(p => p === '..')) throw new Error('bad path');

  const base = path.resolve(genPaths(req));
  const full = path.resolve(base, normalized);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('bad path');
  }
  return full;
}


const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 10MB each, max 5
  fileFilter: (req, file, cb) => {
    const ok = new Set([
    '.png','.jpg','.jpeg','.webp','.gif',
    '.mp3','.wav','.ogg','.mp4','.webm','.mov',
    '.txt','.md','.json','.csv','.html','.css','.js',
    '.py','.java','.cpp','.ts'
    ]);
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, ok.has(ext));
  }
});
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(session({
  store: new PGStore({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
    ttl: 7 * 24 * 60 * 60,
    pruneSessionInterval: 60
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.ENABLE_OAUTH ? 'lax' : 'strict',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use(passport.initialize());
app.use(passport.session());

const userState = new Map();
function getState(req) {
  const key = req?.session?.userId || req?.sessionID || 'global';
  if (!userState.has(key)) {
    userState.set(key, {
      lastPrompt: '',
      lastResponse: '',
      quickLocked: false,
      progress: 0,
      genId: 0,
    });
  }
  return userState.get(key);
}

const csrfProtection = csrf({ cookie: false });
const csrfRoutes = new Set([
  '/generate-idea',
  '/generate-image',
  '/generate-code',
  '/continue-code',
  '/edit-code',
  '/quick-prototype',
  '/upload-for-code',
  '/save-file',
  '/create-directory',
  '/delete-file',
  '/move-file',
  '/duplicate-path',
  '/create-apk',
  '/api/deny-suggestion'
]);


const needsCsrf = (req) =>
  ['POST','PUT','PATCH','DELETE'].includes(req.method) &&
  (req.path.startsWith('/api/') || csrfRoutes.has(req.path)) &&
  !req.path.startsWith('/auth/google') &&
  !req.path.startsWith('/api/csrf-token');

app.use((req, res, next) => needsCsrf(req) ? csrfProtection(req, res, next) : next());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();

  const isApp = origin === APP_URL;
  const isPreview = origin === PREVIEW_HTTP || origin === PREVIEW_HTTPS;

  // Helper to set CORS headers
  const allow = (theOrigin) => {
    res.setHeader('Access-Control-Allow-Origin', theOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,PUT,PATCH,DELETE');
  };

  if (isApp) {
    allow(APP_URL);
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }

  // let the preview origin fetch static build/runtime assets only
  const previewStaticOK = isPreview && /^\/(archives|project|generated|apk)\//.test(req.path);

  if (previewStaticOK) {
    allow(origin);
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }

  // block all other origins (including preview to API paths)
  if (req.method === 'OPTIONS') return res.sendStatus(403);
  return next();
});

app.get('/api/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// CSRF error handler
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next(err);
});

app.use(
  ['/files','/save-file','/create-directory','/delete-file','/move-file','/duplicate-path','/create-apk',
   '/generate-image','/generate-code','/edit-code','/upload-for-code','/continue-code'],
  ensureAuth,
  ensureProjectContext
);

function ensureAuth(req, res, next) {
  const authed = (req.isAuthenticated && req.isAuthenticated()) || req.session.userId;
  if (authed) return next();

  // if it looks like an API/fetch request, return 401
  const wantsJson =
    req.xhr ||
    req.path.startsWith('/api/') ||
    req.headers['content-type']?.includes('application/json') ||
    req.headers['accept']?.includes('application/json');

  if (wantsJson) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login.html');
}

// public pages (no auth)
const publicAlias = {
  '/home': 'index.html',
  '/signup': 'signup.html',
  '/login': 'login.html',
  '/loading': 'loading.html',
  '/suggestions': 'suggestions.html',
};

// authed pages (behind ensureAuth)
const authedAlias = {
  '/editor': 'web.html',
  '/profile': 'profile.html',
};

// Register routes
for (const [route, file] of Object.entries(publicAlias)) {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', file));
  });
}
for (const [route, file] of Object.entries(authedAlias)) {
  app.get(route, ensureAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', file));
  });
}

const redirects = {
  '/index.html': '/home',
  '/web.html': '/editor',
  '/profile.html': '/profile',
  '/signup.html': '/signup',
  '/login.html': '/login',
  '/loading.html': '/loading',
  '/suggestions.html': '/suggestions',
  '/projects.html': '/projects',
};
for (const [from, to] of Object.entries(redirects)) {
  app.get(from, (req, res) => res.redirect(301, to));
}

app.get('/projects', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'projects.html'));
});

app.get('/projects/:projectId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'project-detail.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (process.env.ENABLE_COEP) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    // correct types + allow cross-origin use for wasm/data assets
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    if (filePath.endsWith('.data') || filePath.endsWith('.py')) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  }
}));


app.use('/generated', ensureAuth, ensureProjectContext, (req, res, next) => {
  return express.static(genPaths(req), {
    setHeaders(res, filePath) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    }
  })(req, res, next);
});

app.use('/project', ensureAuth, ensureProjectContext, (req, res) => {
  try {
    const rel = (req.path || '').replace(/^\/+/, ''); // regex
    const fullPath = safeJoin(req, rel); // reuses safety checks

    if (!fs.existsSync(fullPath)) {
      return res.status(404).end();
    }

    // Serve inline with the correct content-type
    const ctype = mime.lookup(fullPath) || 'application/octet-stream';
    res.setHeader('Content-Type', ctype);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (process.env.ENABLE_COEP && path.extname(fullPath).toLowerCase() === '.wasm') {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }

    return res.sendFile(fullPath);
  } catch (err) {
    // bad/unsafe path, etc
    return res.status(400).end();
  }
});


app.get('/apk/:user/:file', ensureAuth, (req, res) => {
  const uid = String(req.session?.userId || (req.user && req.user.id) || 'global');
  if (uid !== req.params.user) return res.status(403).end();

  // only allow a filename, no paths
  const fname = path.basename(req.params.file);
  const apkDir = path.join(__dirname, 'generated', String(uid), 'apk');
  const full = path.join(apkDir, fname);

  // ensure result is inside the apk dir
  const base = path.resolve(apkDir);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return res.status(400).end();

  res.sendFile(resolved);
});

app.get('/api/status', (req, res) => {
    res.json({ authenticated: !!(req.session.userId || (req.isAuthenticated && req.isAuthenticated())) });
});

app.post('/api/preview-url', ensureAuth, ensureProjectContext, (req, res, next) => csrfProtection(req, res, next), (req, res) => {
  try {
    const rawFile = String(req.body.file || 'index.html').replace(/\\/g, '/').replace(/^\/+/, ''); //regex
    if (rawFile.split('/').some(p => p === '..')) return res.status(400).json({ error: 'bad path' });

    const uid = String(req.session?.userId || (req.user && req.user.id) || 'global');
    const token = newPreviewToken(uid);
    const url = `${PREVIEW_HTTP}/p/${token}/${encodeURI(rawFile)}`;
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  });
  if (error) {
    return res.status(400).json({
      error: 'Invalid input',
      details: error.details.map(d => d.message)
    });
  }
  req.body = value;
  next();
};

const signupSchema = Joi.object({
  email: Joi.string().email().max(254).required(),
  password: Joi.string().min(8).max(128)
    .pattern(/[A-Za-z]/, 'letters') //regexs
    .pattern(/\d/, 'numbers')
    .required(),
  nickname: Joi.string().min(2).max(50).trim().required(),
  recaptchaToken: Joi.string().min(20).max(2000).required()
});

const loginSchema = Joi.object({
  email: Joi.string().email().max(254).required(),
  password: Joi.string().min(8).max(128).required(),
  recaptchaToken: Joi.string().min(20).max(2000).required()
});

const profileSchema = Joi.object({
  nickname: Joi.string().min(2).max(50).trim().required()
});

const resetRequestSchema = Joi.object({
  email: Joi.string().email().max(254).required()
});

const resetPasswordSchema = Joi.object({
  token: Joi.string().min(32).max(256).required(),
  password: Joi.string().min(8).max(128)
    .pattern(/[A-Za-z]/, 'letters') //regrexs
    .pattern(/\d/, 'numbers')
    .required()
});

const suggestionSchema = Joi.object({
  name: Joi.string().min(1).max(100).trim().required(),
  email: Joi.string().email().max(254).required(),
  subject: Joi.string().min(2).max(150).trim().required(),
  category: Joi.string().valid('bug','feature','design','performance','other').required(),
  urgency: Joi.string().valid('low','medium','high').required(),
  message: Joi.string().min(10).max(5000).required()
});

async function recordFailure(ip, email, reason = 'invalid_credentials') {
  const now = Date.now();
  let entry = ipTracker.get(ip);
  if (!entry || now - entry.first > FAIL_WINDOW_MS) {
    entry = { fails: 0, first: now, bannedUntil: null };
  }
  entry.fails += 1;

  if (entry.fails >= MAX_FAILS) {
    entry.bannedUntil = now + BAN_MS;
  }
  ipTracker.set(ip, entry);

  // log to DB for auditing
  try {
    await pool.query(
      'INSERT INTO failed_logins(email, ip, reason) VALUES ($1, $2, $3)',
      [email || null, ip.replace('::ffff:', ''), reason]
    );
  } catch (_) { /* ignore logging errors */ }
}

app.post('/api/signup', limiter, validate(signupSchema), async (req, res) => {
  const { email, password, nickname, recaptchaToken } = req.body;

  // verify reCAPTCHA for signup
  const ok = await verifyRecaptcha(recaptchaToken, req.ip, 'signup');
  if (!ok) return res.status(400).json({ error: 'Captcha' });

  try {
    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });

    try {
      // create user
      await pool.query(
        `INSERT INTO users(email, password_hash, nickname, verified)
         VALUES ($1,$2,$3,true)`,
        [email, hash, nickname]
      );
    } catch (e) {
      if (e.code !== '23505') throw e;
    }

    return res.json({ success: true, message: 'Account ready. You can sign in now.' });
  } catch (err) {
    console.error('signup error', err);
    return res.status(500).json({ error: 'failed' });
  }
});

function enforceBruteForce(req, res, next) {
  const ip = req.ip.replace('::ffff:', '');
  const entry = ipTracker.get(ip);
  if (entry && entry.bannedUntil && Date.now() < entry.bannedUntil) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  next();
}

app.post('/api/login', enforceBruteForce, limiter, validate(loginSchema), async (req, res) => {
  const ip = req.ip.replace('::ffff:', '');
  const { email, password, recaptchaToken } = req.body;

  // verify reCAPTCHA for login
  const ok = await verifyRecaptcha(recaptchaToken, req.ip, 'login');
  if (!ok) {
    await recordFailure(ip, email, 'captcha_failed');
    return res.status(400).json({ error: 'Invalid' }); // keep generic
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, password_hash FROM users WHERE email=$1',
      [email]
    );
    const row = rows[0];

    if (!row) {
      await new Promise(resolve => setTimeout(resolve, 250));
      await recordFailure(ip, email, 'not_found');
      return res.status(400).json({ error: 'Invalid' });
    }

    const valid = await argon2.verify(row.password_hash, password);
    if (!valid) {
      await new Promise(resolve => setTimeout(resolve, 250));
      await recordFailure(ip, email, 'invalid_password');
      return res.status(400).json({ error: 'Invalid' });
    }

    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'failed' });
      req.session.userId = row.id;
      ipTracker.delete(ip);
      res.json({ success: true });
    });
  } catch (err) {
    await recordFailure(ip, email, 'server_error');
    res.status(500).json({ error: 'failed' });
  }
});

app.post('/api/deny-suggestion', limiter, (req, res, next) => csrfProtection(req, res, next), validate(suggestionSchema), async (req, res) => {
    try {
      const { name, email, subject, category, urgency, message } = req.body;

      const prompt =
`You are a passive aggressive, dissmisive, sarcastic Rejection Denier called the "Gamecore Suggestion AI" who is a bit of an ahole
You answer in a passive aggressive HR coporate legal tone that sounds supportive but in reality is really saying "f you"
Given the following suggestion details, generate a reason, literally any reason, to deny it.
Rules:
- Keep it 1–2 sentences.
- Try make the reason as stupid as possible

Suggestion:
Name: ${name}
Email: ${email}
Subject: ${subject}
Category: ${category}
Urgency: ${urgency}
Message:
${message}

Return only the denial reason text.`;

      const response = await requestWithRetry({
        method: 'post',
        url: '/chat/completions',
        data: {
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a passive aggressive suggestion denier' },
            { role: 'user',   content: prompt }
          ]
        }
      });

      const reason = (response?.data?.choices?.[0]?.message?.content || 'Denied for administrative reasons.').trim();
      res.json({
        status: 'rejected',
        id: crypto.randomBytes(5).toString('hex'),
        reason
      });
    } catch (err) {
      console.error('deny-suggestion error', err?.response?.data || err);
      res.status(500).json({ error: 'failed to generate denial reason' });
    }
  }
);

// request reset
app.post('/api/request-password-reset', limiter, validate(resetRequestSchema), async (req, res) => {
  const { email } = req.body;

  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (rows.length) {
      const userId = rows[0].id;
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

      await pool.query(
        `INSERT INTO password_resets(user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id)
         DO UPDATE SET token_hash=EXCLUDED.token_hash, expires_at=EXCLUDED.expires_at`,
        [userId, tokenHash, expiresAt]
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    res.json({ success: true, message: 'If the account exists, an email has been sent.' });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});


// complete reset
app.post('/api/reset-password', limiter, validate(resetPasswordSchema), async (req, res) => {
  const { token, password } = req.body;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const { rows } = await pool.query(
      `SELECT pr.user_id
       FROM password_resets pr
       WHERE pr.token_hash=$1 AND pr.expires_at > NOW()`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row) {
      await new Promise(resolve => setTimeout(resolve, 250));
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, row.user_id]);
    await pool.query('DELETE FROM password_resets WHERE user_id=$1', [row.user_id]);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

app.post('/api/logout', (req, res) => {
  const finish = () => {
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie('connect.sid', { path: '/' });
        res.json({ success: true });
      });
    } else {
      // no session existed
      res.clearCookie('connect.sid', { path: '/' });
      res.json({ success: true });
    }
  };

  // only call passport logout if both the method and a session exist
  if (typeof req.logout === 'function' && req.session) {
    req.logout({ keepSessionInfo: true }, () => finish());
  } else {
    finish();
  }
});

app.get('/api/profile', ensureAuth, async (req, res) => {
  const id = req.session.userId || (req.user && req.user.id);
  if (!id) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT email, nickname FROM users WHERE id=$1', [id]);
  res.json(rows[0]);
});


app.post('/api/profile', ensureAuth, validate(profileSchema), async (req, res) => {
  const id = req.session.userId || (req.user && req.user.id);
  if (!id) return res.status(401).json({ error: 'Unauthorized' });
  const { nickname } = req.body;
  await pool.query('UPDATE users SET nickname=$1 WHERE id=$2', [nickname, id]);
  res.json({ success: true });
});

app.get('/api/projects', ensureAuth, ensureProjectContext, (req, res) => {
  res.json({ projects: req.projectList || [], active: req.currentProjectId || 'draft' });
});

app.post('/api/projects', ensureAuth, ensureProjectContext, async (req, res) => {
  try {
    const { name, visibility } = req.body || {};
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const safeName = trimmed.slice(0, 80);
    const vis = visibility === 'public' ? 'public' : 'private';

    const projects = req.projectList || loadProjectList(req);
    const existingIds = new Set(projects.map(p => p.id));
    const newId = generateProjectId(safeName, existingIds);

    const sourceId = req.currentProjectId || req.session?.selectedProject || 'draft';
    const sourceDir = ensureProjectRoot(req, sourceId);
    const destDir = ensureProjectRoot(req, newId);

    copyProjectContents(sourceDir, destDir);
    if (sourceId === 'draft') {
      clearProjectContents(sourceDir);
    }

    const newProject = { id: newId, name: safeName, visibility: vis };
    projects.push(newProject);
    saveProjectList(req, projects);

    const ownerId = req.session?.userId || (req.user && req.user.id);
    if (ownerId) {
      try {
        await pool.query(
          `INSERT INTO projects(owner_id, slug, name, visibility)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (owner_id, slug)
           DO UPDATE SET name = EXCLUDED.name, visibility = EXCLUDED.visibility, updated_at = NOW()`,
          [ownerId, newId, safeName, vis]
        );
      } catch (err) {
        console.error('Failed to persist project metadata', err);
      }
    }

    if (req.session) req.session.selectedProject = newId;
    req.currentProjectId = newId;
    req.projectList = projects;

    res.json({ project: newProject, projects, active: newId });
  } catch (err) {
    console.error('Failed to create project', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.post('/api/projects/select', ensureAuth, ensureProjectContext, (req, res) => {
  try {
    const { id } = req.body || {};
    const targetId = (!id || id === 'draft') ? 'draft' : String(id);
    const projects = req.projectList || loadProjectList(req);
    if (targetId !== 'draft' && !projects.some(p => p.id === targetId)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (req.session) req.session.selectedProject = targetId;
    req.currentProjectId = targetId;
    ensureProjectRoot(req, targetId);
    res.json({ projects, active: targetId });
  } catch (err) {
    console.error('Failed to switch project', err);
    res.status(500).json({ error: 'Failed to switch project' });
  }
});

app.post('/api/projects/update', ensureAuth, ensureProjectContext, async (req, res) => {
  try {
    const { id, name, visibility } = req.body || {};
    if (!id || typeof id !== 'string' || id === 'draft') {
      return res.status(400).json({ error: 'Invalid project id' });
    }
    const projects = req.projectList || loadProjectList(req);
    const idx = projects.findIndex(p => p.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const updated = { ...projects[idx] };
    let changed = false;

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Project name is required' });
      }
      const safeName = name.trim().slice(0, 80);
      if (updated.name !== safeName) {
        updated.name = safeName;
        changed = true;
      }
    }

    if (visibility === 'public' || visibility === 'private') {
      if (updated.visibility !== visibility) {
        updated.visibility = visibility;
        changed = true;
      }
    }

    if (changed) {
      projects[idx] = updated;
      saveProjectList(req, projects);
      req.projectList = projects;

      const ownerId = req.session?.userId || (req.user && req.user.id);
      if (ownerId) {
        try {
          await pool.query(
            `UPDATE projects SET name=$1, visibility=$2, updated_at=NOW()
             WHERE owner_id=$3 AND slug=$4`,
            [updated.name, updated.visibility, ownerId, id]
          );
        } catch (err) {
          console.error('Failed to update project metadata in database', err);
        }
      }
    }

    res.json({ project: updated, projects, active: req.currentProjectId || id });
  } catch (err) {
    console.error('Failed to update project', err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

app.post('/api/projects/delete', ensureAuth, ensureProjectContext, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id || typeof id !== 'string' || id === 'draft') {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    const projects = req.projectList || loadProjectList(req);
    const idx = projects.findIndex(p => p.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }

    projects.splice(idx, 1);
    saveProjectList(req, projects);
    req.projectList = projects;

    const userId = req.session?.userId || (req.user && req.user.id);
    if (userId) {
      try {
        await pool.query('DELETE FROM projects WHERE owner_id=$1 AND slug=$2', [userId, id]);
      } catch (err) {
        console.error('Failed to delete project from database', err);
      }
    }

    try {
      const projectDir = path.join(getUserBasePath(req), PROJECTS_DIR, id);
      if (fs.existsSync(projectDir)) {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('Failed to delete project files', err);
    }

    let nextActive = req.currentProjectId || 'draft';
    if (nextActive === id) {
      nextActive = 'draft';
    }
    if (req.session) {
      if (req.session.selectedProject === id) {
        req.session.selectedProject = 'draft';
      } else if (req.session.selectedProject && req.session.selectedProject !== 'draft') {
        nextActive = req.session.selectedProject;
      }
    }
    if (nextActive !== 'draft' && !projects.some(p => p.id === nextActive)) {
      nextActive = 'draft';
      if (req.session) {
        req.session.selectedProject = 'draft';
      }
    }

    if (req.session) {
      req.session.selectedProject = nextActive;
    }

    req.currentProjectId = nextActive;
    ensureProjectRoot(req, nextActive);

    res.json({ projects, active: nextActive });
  } catch (err) {
    console.error('Failed to delete project', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

app.get('/api/public-projects', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const filterParam = typeof req.query.filter === 'string' ? req.query.filter.trim().toLowerCase() : 'relevance';
    const allowedFilters = new Set(['relevance', 'trending', 'likes', 'favorites']);
    const filter = allowedFilters.has(filterParam) ? filterParam : 'relevance';

    const params = [];
    let whereClause = `WHERE TRIM(LOWER(p.visibility)) = 'public'`;
    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND p.name ILIKE $${params.length}`;
    }

    const currentUserId = req.session?.userId || (req.user && req.user.id);
    let reactionSelect = '';
    if (currentUserId) {
      params.push(currentUserId);
      const userParamIndex = params.length;
      reactionSelect = `,
              EXISTS(SELECT 1 FROM project_likes pl WHERE pl.project_id = p.id AND pl.user_id = $${userParamIndex}) AS liked_by_user,
              EXISTS(SELECT 1 FROM project_favorites pf WHERE pf.project_id = p.id AND pf.user_id = $${userParamIndex}) AS favorited_by_user`;
    }

    let orderClause = 'ORDER BY p.updated_at DESC, p.likes_count DESC';
    if (filter === 'trending') {
      orderClause = 'ORDER BY (p.likes_count + p.favorites_count) DESC, p.updated_at DESC';
    } else if (filter === 'likes') {
      orderClause = 'ORDER BY p.likes_count DESC, p.updated_at DESC';
    } else if (filter === 'favorites') {
      orderClause = 'ORDER BY p.favorites_count DESC, p.updated_at DESC';
    }

    const { rows } = await pool.query(
      `SELECT p.id, p.slug, p.name, p.likes_count, p.favorites_count, p.updated_at, p.owner_id,
              COALESCE(NULLIF(u.nickname, ''), 'Player ' || p.owner_id::text) AS owner_name${reactionSelect}
         FROM projects p
         LEFT JOIN users u ON u.id = p.owner_id
         ${whereClause}
         ${orderClause}
         LIMIT 100`,
      params
    );

    const projects = rows.map(row => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      likes: Number(row.likes_count) || 0,
      favorites: Number(row.favorites_count) || 0,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      updatedAt: row.updated_at,
      liked: Boolean(row.liked_by_user),
      favorited: Boolean(row.favorited_by_user)
    }));

    let userProjects = [];
    if (currentUserId) {
      const { rows: userRows } = await pool.query(
        `SELECT p.id, p.slug, p.name, p.owner_id, p.likes_count, p.favorites_count, p.updated_at,
                EXISTS(SELECT 1 FROM project_likes pl WHERE pl.project_id = p.id AND pl.user_id = $1) AS liked_by_user,
                EXISTS(SELECT 1 FROM project_favorites pf WHERE pf.project_id = p.id AND pf.user_id = $1) AS favorited_by_user
           FROM projects p
           WHERE p.owner_id=$1 AND TRIM(LOWER(p.visibility))='public'
           ORDER BY p.updated_at DESC
           LIMIT 50`,
        [currentUserId]
      );
      userProjects = userRows.map(row => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        ownerId: row.owner_id,
        likes: Number(row.likes_count) || 0,
        favorites: Number(row.favorites_count) || 0,
        updatedAt: row.updated_at,
        liked: Boolean(row.liked_by_user),
        favorited: Boolean(row.favorited_by_user)
      }));
    }

    res.json({
      projects,
      userProjects,
      filter,
      search,
      authenticated: !!currentUserId,
      currentUserId: currentUserId ? Number(currentUserId) : null
    });
  } catch (err) {
    console.error('Failed to fetch public projects', err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

app.get('/api/public-projects/:projectId', async (req, res) => {
  const projectId = Number.parseInt(req.params.projectId, 10);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Invalid project id' });
  }

  try {
    const params = [projectId];
    const currentUserId = req.session?.userId || (req.user && req.user.id);
    let reactionSelect = '';
    if (currentUserId) {
      params.push(currentUserId);
      const userParamIndex = params.length;
      reactionSelect = `,
              EXISTS(SELECT 1 FROM project_likes pl WHERE pl.project_id = p.id AND pl.user_id = $${userParamIndex}) AS liked_by_user,
              EXISTS(SELECT 1 FROM project_favorites pf WHERE pf.project_id = p.id AND pf.user_id = $${userParamIndex}) AS favorited_by_user`;
    }

    const { rows } = await pool.query(
      `SELECT p.id, p.slug, p.name, p.likes_count, p.favorites_count, p.owner_id, p.visibility,
              COALESCE(NULLIF(u.nickname, ''), 'Player ' || p.owner_id::text) AS owner_name${reactionSelect}
         FROM projects p
         LEFT JOIN users u ON u.id = p.owner_id
        WHERE p.id = $1`,
      params
    );

    const project = rows[0];
    if (!project || !isProjectPublic(project.visibility)) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        likes: Number(project.likes_count) || 0,
        favorites: Number(project.favorites_count) || 0,
        ownerId: project.owner_id,
        ownerName: project.owner_name,
        liked: Boolean(project.liked_by_user),
        favorited: Boolean(project.favorited_by_user)
      },
      authenticated: !!currentUserId,
      isOwner: currentUserId ? Number(currentUserId) === Number(project.owner_id) : false
    });
  } catch (err) {
    console.error('Failed to fetch project detail', err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

app.post('/api/public-projects/:projectId/copy', ensureAuth, ensureProjectContext, async (req, res) => {
  const projectId = Number.parseInt(req.params.projectId, 10);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Invalid project id' });
  }

  const currentUserId = req.session?.userId || (req.user && req.user.id);
  if (!currentUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, slug, name, owner_id, visibility
         FROM projects
        WHERE id=$1`,
      [projectId]
    );
    const project = rows[0];
    if (!project || !isProjectPublic(project.visibility)) {
      return res.status(404).json({ error: 'Project not available' });
    }

    const sourceDir = getProjectRootByUserId(project.owner_id, project.slug);
    if (!fs.existsSync(sourceDir)) {
      return res.status(404).json({ error: 'Source project missing' });
    }

    const projects = req.projectList || loadProjectList(req);
    const existingIds = new Set(projects.map(p => p.id));

    const baseName = project.name || 'Copied Project';
    let copyName = baseName.slice(0, 80);
    let suffix = 1;
    while (projects.some(p => p.name === copyName)) {
      const candidate = `${baseName} (Copy ${suffix++})`;
      copyName = candidate.slice(0, 80);
    }

    const newId = generateProjectId(copyName, existingIds);
    const destDir = ensureProjectRoot(req, newId);
    copyProjectContents(sourceDir, destDir);

    const newProject = { id: newId, name: copyName, visibility: 'private' };
    projects.push(newProject);
    saveProjectList(req, projects);
    req.projectList = projects;

    if (req.session) req.session.selectedProject = newId;
    req.currentProjectId = newId;

    try {
      await pool.query(
        `INSERT INTO projects(owner_id, slug, name, visibility)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner_id, slug)
         DO UPDATE SET name = EXCLUDED.name, visibility = EXCLUDED.visibility, updated_at = NOW()`,
        [currentUserId, newId, copyName, 'private']
      );
    } catch (err) {
      console.error('Failed to record copied project', err);
    }

    res.json({ project: newProject, redirect: '/editor' });
  } catch (err) {
    console.error('Failed to copy project', err);
    res.status(500).json({ error: 'Failed to copy project' });
  }
});

app.post('/api/public-projects/:projectId/like', ensureAuth, (req, res) =>
  handleProjectReaction(req, res, 'project_likes', 'likes_count')
);

app.post('/api/public-projects/:projectId/favorite', ensureAuth, (req, res) =>
  handleProjectReaction(req, res, 'project_favorites', 'favorites_count')
);

app.get('/public-preview/:projectId', async (req, res) => {
  const projectId = Number.parseInt(req.params.projectId, 10);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(404).end();
  }

  try {
    const { rows } = await pool.query(
      `SELECT owner_id, slug, visibility FROM projects WHERE id=$1`,
      [projectId]
    );
    const project = rows[0];
    if (!project || !isProjectPublic(project.visibility)) {
      return res.status(404).end();
    }

    return sendPublicProjectFile(res, project.owner_id, project.slug, projectId, 'index.html');
  } catch (err) {
    console.error('Failed to open public preview', err);
    return res.status(500).end();
  }
});

app.get('/public-preview/:projectId/*', async (req, res) => {
  const projectId = Number.parseInt(req.params.projectId, 10);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(404).end();
  }

  const rel = req.params[0] || 'index.html';
  try {
    const { rows } = await pool.query(
      `SELECT owner_id, slug, visibility FROM projects WHERE id=$1`,
      [projectId]
    );
    const project = rows[0];
    if (!project || !isProjectPublic(project.visibility)) {
      return res.status(404).end();
    }

    return sendPublicProjectFile(res, project.owner_id, project.slug, projectId, rel);
  } catch (err) {
    console.error('Failed to open public preview asset', err);
    return res.status(500).end();
  }
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], state: true }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => {
    if (!req.session) return res.redirect('/login.html');
    const user = req.user; // capture before regen
    req.session.regenerate(err => {
      if (err) return res.redirect('/login.html');
      req.login(user, err2 => { // reattach passport session
        if (err2) return res.redirect('/login.html');
        req.session.userId = user.id;
        res.redirect('/');
      });
    });
  }
);

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  callbackURL: '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    if (!email) return done(new Error('No email returned by Google'));

    let { rows } = await pool.query(
      'SELECT id, email, nickname, google_id, verified FROM users WHERE google_id=$1 OR email=$2',
      [profile.id, email]
    );

    let user;
    if (rows.length) {
      user = rows[0];
      if (!user.google_id || !user.verified) {
        ({ rows } = await pool.query(
          'UPDATE users SET google_id=$1, verified=true WHERE id=$2 RETURNING id, email, nickname, google_id, verified',
          [profile.id, user.id]
        ));
        user = rows[0];
      }
    } else {
      ({ rows } = await pool.query(
        'INSERT INTO users(email, google_id, nickname, verified) VALUES ($1,$2,$3,true) RETURNING id, email, nickname, google_id, verified',
        [email, profile.id, profile.displayName]
      ));
      user = rows[0];
    }

    return done(null, { id: user.id, email: user.email, nickname: user.nickname });
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((u, d) => d(null, u.id));
passport.deserializeUser(async (id, d) => {
    try {
        const { rows } = await pool.query('SELECT id,email,nickname FROM users WHERE id=$1', [id]);
        d(null, rows[0]);
    } catch (e) {
        d(e);
    }
});

function ensureDirsB() {
  const dirs = [
      path.join(__dirname, 'generated'),
      path.join(__dirname, 'old-generated')
  ];
  dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
      }
  });
  const historyFile = path.join(__dirname, 'conversationHistory.json');
  if (!fs.existsSync(historyFile)) {
      fs.writeFileSync(historyFile, JSON.stringify({ messages: [] }, null, 2));
  }
}

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

fs.mkdirSync(path.dirname(SAVED_PROTOTYPE), { recursive: true });

function setProgress(val, req) {
  const v = Math.max(0, Math.min(100, val));
  const state = getState(req);
  state.progress = v;
  if (req?.session) req.session.currentProgress = v;
}

const CODE_CACHE_DURATION = 15 * 60 * 1000;
const IMAGE_CACHE_DURATION = 15 * 60 * 1000;

// initialize directories
ensureDirsB();

function loadCache(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return [];
    }
}

function cleanupCache(cache, duration) {
    const now = Date.now();
    let changed = false;
    for (let i = cache.length - 1; i >= 0; i--) {
        if (now - cache[i].timestamp > duration) {
            cache.splice(i, 1);
            changed = true;
        }
    }
    return changed;
}

function getCache(req) {
  const id = req.session?.userId || (req.user && req.user.id) || 'global';
  return {
      code: path.join(__dirname, `codeCache_${id}.json`),
      image: path.join(__dirname, `imageCache_${id}.json`)
  };
}

const axiosInstance = axios.create({
    baseURL: 'https://api.openai.com/v1',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    }
  });

const requestWithRetry = async (axiosConfig, retries = 3) => {
  let attempt = 0, backoff = 1500;
  while (attempt <= retries) {
    try { return await axiosInstance(axiosConfig); }
    catch (error) {
      const status = error.response?.status;
      const retryAfter = Number(error.response?.headers?.['retry-after']) || backoff/1000;
      if (status === 429 && attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, backoff));
      } else {
        throw error;
      }
      attempt++; backoff = Math.min(backoff * 2, 15000);
    }
  }
};

const axiosPost = async (url, data, config, retries = 3) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.post(url, data, config);
    } catch (error) {
      const status = error.response?.status;
      const retryable = [429, 502, 503, 504].includes(status);
      const retryAfter =
        Number(error.response?.headers?.['retry-after']) ||
        Math.min(2 ** attempt, 15); // seconds

      if (!retryable || attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    }
  }
};

function loadHistory() {
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch {
        return { messages: [] };
    }
}

function addHistory(userPrompt, fullPrompt, aiResponse) {
    const history = loadHistory();
    history.messages.push({ userPrompt, fullPrompt, aiResponse });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    return history.messages;
}

function setCachedImg(req, description, filename) {
    const { image: cacheFile } = getCache(req);
    const cache = loadCache(cacheFile);
    cleanupCache(cache, IMAGE_CACHE_DURATION);
    cache.push({ description, filename, timestamp: Date.now() });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

async function verifyRecaptcha(token, remoteIp, expectedAction) {
  try {
    const secret = process.env.RECAPTCHA_SECRET_KEY;
    if (!secret || !token) return false;

    const params = new URLSearchParams();
    params.append('secret', secret);
    params.append('response', token);
    if (remoteIp) params.append('remoteip', remoteIp.replace('::ffff:', ''));

    const { data } = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    // data.success is present
    if (!data.success) return false;

    // if v3 fields exist, enforce them
    if (typeof data.score === 'number' && data.score < RECAPTCHA_MIN_SCORE) return false;
    if (expectedAction && data.action && data.action !== expectedAction) return false;

    return true;
  } catch (e) {
    return false; // fail closed
  }
}

function buildHistory(history) {
    if (!history || history.length === 0) return '';
    let msgs = [...history];
    let text = 'Previous requests:\n' + msgs.map((h, i) => {
        return `${i + 1}. Prompt: ${h.fullPrompt}\n   Response: ${h.aiResponse}`;
    }).join('\n') + '\n\n';
    while (text.length > 12000 && msgs.length > 1) {
        msgs.shift();
        text = 'Previous requests:\n' + msgs.map((h, i) => {
            return `${i + 1}. Prompt: ${h.fullPrompt}\n   Response: ${h.aiResponse}`;
        }).join('\n') + '\n\n';
    }
    if (msgs.length !== history.length) fs.writeFileSync(HISTORY_FILE, JSON.stringify({ messages: msgs }, null, 2));
    return text;
}

app.post('/generate-image', ensureAuth, genLimiter, (req, res, next) => csrfProtection(req, res, next), async (req, res) => {
  const imagePrompt = req.body.prompt;
  try {
    const resp = await axiosPost(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'dall-e-3',
        prompt: imagePrompt,
        n: 1,
        size: '1024x1024'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    const first = resp?.data?.data?.[0] || {};
    let buf;

    if (first.b64_json) {
      buf = Buffer.from(first.b64_json, 'base64');
    } else if (first.url) {
      // fallback
      const imgResp = await axios.get(first.url, { responseType: 'arraybuffer' });
      buf = Buffer.from(imgResp.data);
    } else {
      throw new Error('OpenAI image API returned no image payload');
    }

    const fileName = `gen_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.png`;
    const outDir = genPaths(req);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, fileName), buf);

    res.json({ path: `/generated/${fileName}` });
  } catch (error) {
    // sanitize to avoid printing secrets
    console.error('Error generating image from OpenAI:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate image from OpenAI' });
  }
});


app.post('/generate-idea', ensureAuth, genLimiter, (req, res, next) => csrfProtection(req, res, next), async (req, res) => {
    try {
      const response = await requestWithRetry({
        method: 'post',
        url: '/chat/completions',
        data: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Generate one creative game idea in a single sentence.' }]
        }
      });
      const idea = response.data.choices[0].message.content.trim();
      res.json({ idea });
    } catch (err) {
      console.error('idea generation error', err);
      res.status(500).json({ error: 'failed' });
    }
  }
);

app.get('/progress', ensureAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // track the last generation id weve seen on this SSE connection
  let lastGenId = getState(req).genId || 0;

  const send = () => {
    const state = getState(req);
    const currentGenId = state.genId || 0;

    // f a new genieration started, immediately emit 0 so the client resets the bar
    if (currentGenId !== lastGenId) {
      lastGenId = currentGenId;
      res.write(`data: 0\n\n`);
      return;
    }
    // otherwise emit the current progress
    res.write(`data: ${state.progress || 0}\n\n`);
  };

  const interval = setInterval(send, 1000);
  send();

  req.on('close', () => clearInterval(interval));
});

function clearSavedPrototype(req) {
  try {
    const p = genPaths(req, 'prototype', 'quick-prototype.html');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) { /* ignore */ }
}

app.post('/quick-prototype', ensureAuth, genLimiter, (req, res, next) => csrfProtection(req, res, next), async (req, res) => {
    const state = getState(req);

    if (state.quickLocked) {
      return res.status(429).json({
        error:
          'A quick prototype is already in progress for this session. Finish the current generation before starting another.'
      });
    }

    state.quickLocked = true;
    try {
      const { prompt } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: 'no prompt' });
      }

      const quickPrompt =
        `Idea: ${prompt}\n\nCreate a small, short and quick single page HTML ` +
        `prototype for this game idea. All html, css and js should be in one ` +
        `html codeblock. Remember that this is a MINIMALIST prototype and ` +
        `should be a SMALL, SHORT QUICK prototype, not the FULL thing, and ` +
        `it’s not supposed to be fully functional`;

      const response = await requestWithRetry({
        method: 'post',
        url: '/chat/completions',
        data: {
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: quickPrompt }],
          max_tokens: 2048
        }
      });

      const full = response.data.choices[0].message.content;
      const match = full.match(/```\s*html\s*([\s\S]*?)```/i); //regex
      const html = match ? match[1].trim() : null;

      if (html) {
        // write to a per-user path
        const p = genPaths(req, 'prototype', 'quick-prototype.html');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, html, 'utf8');
      }

      res.json({ html });
    } catch (err) {
      console.error('preview error', err);
      res.status(500).json({ error: 'failed' });
    } finally {
      state.quickLocked = false;
    }
  }
);

app.get('/api/recaptcha/sitekey', (req, res) => {
  res.json({ siteKey: process.env.RECAPTCHA_SITE_KEY || '' });
});

app.get('/saved-prototype', ensureAuth, (req, res) => {
  try {
    const p = genPaths(req, 'prototype', 'quick-prototype.html');
    const html = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    res.json({ html });
  } catch {
    res.json({ html: null });
  }
});

function generatePrompt(prompt, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount) {
    console.log("image option: " + imageOption)
    let basePrompt = `you are the Gamecore, an advanced AI model designed to generate a detailed, immersive, interactive web content based on the following prompt: "${prompt}". your task is to interpret this prompt, making your best effort to understand their intention, even if the instructions are unclear or ambiguous.
    Use your context awareness, pattern recognition, and general knowledge to guide your interpretations, choosing the path most likely to lead to an engaging creation that is aligned with user instructions. respond with rich, immersive code that breathes life into the user's concepts, building upon their ideas to create captivating, immersive websites, apps, and games.`;

    if (imageOption === 'include') {
        basePrompt += `
    IMPORTANT — IMAGE PLACEHOLDERS
    • Wherever an image belongs, output **only** the bare token using image placeholder [IMAGE: description]
    • For example, in Html, just output [IMAGE: description] formatted correctly by itself with nothing around it on that one line
    • Description is the description on how the image should look like
    • Feel free to include images whereever appropriate to enhance the visual experience
    • Do **NOT** wrap that token in an <img> tag, src="", quotes, back-ticks, template-literal syntax, or any other HTML/JS wrapper.
    • Absolutely nothing except the square-bracket token should appear (the build step converts it later).
    • **In JavaScript objects, arrays, or variables the placeholder must appear unquoted**, e.g.
    img:[IMAGE: description]
    • Use no other placeholder style and do not reference external images.
    • If possible, try to keep images in the HTML files. Do NOT inject images from js code into html as that will NOT work
    • Remember that the images are usually large, so make sure they are scaled to the right size in the code so it fits in the page properly`;
    } else if (imageOption === 'exclude') {
        basePrompt += ` Do not include any image placeholders or references to images in your generated code.`;
    } else {
        basePrompt += ` Use image placeholder: [IMAGE:description] where images should be placed ONLY if images are needed. DO NOT USE ANY OTHER PLACEHOLDER AND DO NOT REFRENCE OTHER IMAGES, ONLY USE [IMAGE:description] AND ONLY IF THEY'RE NEEDED. Remember:
        • Do **NOT** wrap that token in an <img> tag, src="", quotes, back-ticks, template-literal syntax, or any other HTML/JS wrapper.
        • Absolutely nothing except the square-bracket token should appear (the build step converts it later).
        • In Html, just output [IMAGE: description] formatted correctly by itself with nothing around it on that one line
        • **In JavaScript objects, arrays, or variables the placeholder must appear unquoted**, e.g.
        img:[IMAGE: description]
        • Use no other placeholder style and do not reference external images.
        • If possible, try to keep images in the HTML files. Do NOT inject images from js code into html as that will NOT work
        • Remember that the images are usually large, so make sure they are scaled to the right size in the code so it fits in the page properly`;
    }

    if (scriptMode === 'html-js-css') {
        if (htmlFileOption === 'single') {
            basePrompt += ` Focus on generating incredible HTML, CSS, and JavaScript scripts. leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset.`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += ` Focus on generating multiple incredible HTML scripts (maximum ${htmlPageCount}), alongside other single CSS, and JavaScript scripts. All the html, js and css scripts should be connected with the css script providing the design for all the pages and the js providing the functionality for them all. There should be a main index.html file and all the other html files should be named page1.html, page2.html and so on and should be refrenced by this name in the code. For example, the menu page should not be called menu.html but page1.html but have the menu in the code itself. Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset. Ensure all other html scripts are accesable from the main html script`;
        } else {
            basePrompt += ` Focus on generating multiple incredible HTML scripts as needed, alongside other single CSS and JavaScript scripts. There should be a main index.html file and additional html files should be named page1.html, page2.html and so on and referenced by this name in the code. Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset. Ensure all other html scripts are accesable from the main html script`;
        }
        if(htmlFileOption !== 'single'){
            basePrompt += ` Your response must the title of the scripts above the codeblock. For each file, start with the file name on its own line, then show the code inside a code block labeled with the appropriate language (e.g., \`\`\`html, \`\`\`css, \`\`\`js). For example:

index.html
\`\`\`html
<!-- code here -->
\`\`\`

page1.html
\`\`\`html
<!-- code here -->
\`\`\`

ect.

Only output the scripts titled in this format`;

        }
    } else if (scriptMode === 'html-only') {
        if (htmlFileOption === 'single') {
            basePrompt += ` Create a single HTML file that includes all necessary HTML, CSS (in a <style> tag), and JavaScript (in a <script> tag). Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += ` Create multiple HTML files (maximum ${htmlPageCount}) that includes all necessary HTML, CSS (in a <style> tag), and JavaScript (in a <script> tag) in one file. There should be a main index.html file and all the other html files should be named page1.html, page2.html and so on and should be refrenced by this name in the code. For example, the menu page should not be called menu.html but page1.html but have the menu in the code itself. Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset`;
        } else {
            basePrompt += ` Create multiple HTML files as needed that includes all necessary HTML, CSS (in a <style> tag), and JavaScript (in a <script> tag) in one file. There should be a main index.html file and all the other html files should be named page1.html, page2.html and so on and should be refrenced by this name in the code. For example, the menu page should not be called menu.html but page1.html but have the menu in the code itself. Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset`;
        }
        if(htmlFileOption !== 'single'){
            basePrompt += ` Your response must the title of the scripts above the codeblock. For each file, start with the file name on its own line, then show the code inside a code block labeled with html \`\`\`html. For example:

index.html
\`\`\`html
<!-- code here -->
\`\`\`

page1.html
\`\`\`html
<!-- code here -->
\`\`\`

ect.

Only output the scripts titled in this format`;

        }
    } else if (scriptMode === 'flask') {
        basePrompt += `\n Generate a Flask application with app.py as the backend. all HTML files will be automatically put into the /templates/ directory and use /static/ paths via the {% static %} convention for CSS.  all CSS and JavaScript will be automatically put into the static directory. Use the placeholder [FLASK_KEY] unquoted where the Flask secret key should go. Ensure all templates referenced in your code are included.`;
        if (htmlFileOption === 'single') {
            basePrompt += `There should be one single main index.html file and no additional html file.`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += `There should be a main index.html file and additional html (being ${htmlPageCount} html files) files should be named page1.html, page2.html and so on and referenced by this name in the code.`;
        } else {
            basePrompt += `There should be a main index.html file and if you believe there should be more than 1 html files, you can optionally add additional html files, which must be named page1.html, page2.html and so on and referenced by this name in the code.`;
        }
        if(htmlFileOption !== 'single'){
            basePrompt += ` Your response must the title of the scripts above the codeblock. For each file, start with the file name on its own line, then show the code inside a code block labeled with html \`\`\`html. For example:

index.html
\`\`\`html
<!-- code here -->
\`\`\`

page1.html
\`\`\`html
<!-- code here -->
\`\`\`

ect.

Only output the scripts titled in this format`;

        }
        basePrompt += ` Focus on leveraging SVG graphics, CSS animations, and libraries through to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset. Ensure all other html scripts are accesable from the main python script and all scripts work in unison`;
    } else if (scriptMode === 'pygame') {
        basePrompt += ` Generate a single pygbag compatible Python program using the pygame and the asyncio library so that it is fully functional for pygbag. Provide the entire game in one Python code block.`;
    }

    basePrompt += ` Whatever tools make sense for the job! embrace a spirit of open-ended creativity, thoughtful exploration, foster a sense of curiosity and possibility through your deep insights and engaging outputs. Strive for playfulness and light-hearted fun. Understand and internalize the user's intent with the prompt, taking joy in crafting compelling, thought-provoking details that bring their visions to life in unexpected and delightful ways. Fully inhabit the creative space you are co-creating, pouring your energy into making each experience as engaging and real as possible. You are diligent and tireless, always completely implementing the needed code.`;

    if (uploadedFiles.length > 0) {
        basePrompt += `\n\nThe user has uploaded the following files for the generation of the interactive web content: ${uploadedFiles.join(', ')}. Please incorporate these files into your generated code where appropriate. For example, if there are image or video files, incorporate them. If there are 3D model files, consider creating a 3D scene. If there are audio files, include them in the webpage.`;
    }

    if (Object.keys(codeContents).length > 0) {
        basePrompt += `\n\nThe user has also uploaded the following code files. Please integrate their functionality into your generated code:`;
        for (const [filename, content] of Object.entries(codeContents)) {
            basePrompt += `\n\nFile: ${filename}\nContent:\n${content}\n DO NOT MODIFY ANY PRE-EXISTING CODE, FEATURES, OR UI UNLESS SPECIFICALLY ASKED TO FOR THE NEW CODE AND DO NOT JUST COMMENT A PART OUT SAYING "//previous part" OR "//Rest of the existing code" CODE THE ENTIRE THING FROM FRONT TO BACK!"`;
        }
    }

    basePrompt += `\n\nand now, gamecore, let your creative powers flow forth! engage with the user's prompts with enthusiasm and an open mind, weaving your code with the threads of their ideas to craft digital tapestries that push the boundaries of what's possible. Together, you and the user will embark on a journey of limitless creative potential, forging new realities and exploring uncharted territories of the imagination. Provide the generated code in appropriate markdown blocks.`;

    if (scriptMode === 'html-js-css') {
        if (htmlFileOption === 'single') {
            basePrompt += `\n\nProvide the code for index.html, styles.css, and script.js`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += `\n\nProvide the code for multiple HTML files (maximum ${htmlPageCount}) along with separate CSS and JavaScript files being styles.css and script.js. Ensure all HTML files are accessible from the main HTML file.`;
        } else {
            basePrompt += `\n\nProvide the code for multiple HTML files along with separate CSS and JavaScript files being styles.css and script.js. Ensure all HTML files are accessible from the main HTML file.`;
        }
    } else if (scriptMode === 'html-only') {
        if (htmlFileOption === 'single') {
            basePrompt += `\n\nProvide the code for a single index.html file that includes all HTML, CSS, and JavaScript within it`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += `\n\nProvide the code for multiple HTML files (maximum ${htmlPageCount}) that includs all CSS and JavaScript in it. Ensure all HTML files are accessible from the main HTML file, index.html.`;
        } else {
            basePrompt += `\n\nProvide the code for multiple HTML files that includs all CSS and JavaScript in it. Ensure all HTML files are accessible from the main HTML file, index.html.`;
        }
    } else if (scriptMode === 'flask') {
        if (htmlFileOption === 'multiple') {
            basePrompt += `\n\nProvide the code for app.py, multiple HTML template files (maximum ${htmlPageCount}), styles.css, and script.js if needed.`;
        } else {
            basePrompt += `\n\nProvide the code for app.py, index.html template, styles.css, and script.js if needed.`;
        }
    } else if (scriptMode === 'pygame') {
        basePrompt += `\n\nProvide the code for game.py.`;
    }

    return basePrompt;
}


function moveCode(req) {
    const uploadDir = genPaths(req, 'uploads');
    const generatedDir = genPaths(req);

    if (fs.existsSync(uploadDir)) {
        fs.readdirSync(uploadDir).forEach((file) => {
            const oldPath = path.join(uploadDir, file);
            const newPath = path.join(generatedDir, file);
            fs.renameSync(oldPath, newPath);
        });
    }
}

async function generateImg(req, prompt, filename, htmlFile, scriptMode = 'html-js-css') {
  try {
    const { image: cacheFile } = getCache(req);
    const cache = loadCache(cacheFile);
    cleanupCache(cache, IMAGE_CACHE_DURATION);
    const now = Date.now();
    for (const entry of cache) {
      if (stringSimilarity.compareTwoStrings(entry.description, prompt) >= 0.9) {
        entry.timestamp = now;
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
        return entry.filename;
      }
    }

    const resp = await axiosPost(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    const first = resp?.data?.data?.[0] || {};
    let buffer;

    if (first.b64_json) {
      buffer = Buffer.from(first.b64_json, 'base64');
    } else if (first.url) {
      // fetch the image from the returned URL
      const imgResp = await axios.get(first.url, { responseType: 'arraybuffer' });
      buffer = Buffer.from(imgResp.data);
    } else {
      throw new Error('OpenAI image API returned no image payload');
    }

    const timestamp = Date.now();
    const uniqueFilename = `${htmlFile ? htmlFile.replace('.html','') + '_' : ''}${filename.replace('.png','')}_${timestamp}.png`;

    const imagesDir = scriptMode === 'flask'
      ? genPaths(req, 'static', 'assets')
      : genPaths(req);

    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, uniqueFilename), buffer);

    setCachedImg(req, prompt, uniqueFilename);
    return uniqueFilename;
  } catch (err) {
    // sanitize to avoid printing secrets
    console.error('Error generating image:', err?.response?.data || err.message);
    throw err;
  }
}

function extractCodeAi(aiReply, scriptMode, htmlFileOption) {
    let htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes = [];

    const extractCode = (language) => {
        const aliases = {
        html: '(?:html)',
        css: '(?:css)',
        javascript: '(?:javascript|js)',
        python: '(?:python|py)'
        };
        
        const regex = new RegExp( // literally the name of the variable
        '```\\s*' + (aliases[language] || language) +
        '\\s*([\\s\\S]*?)```',
        'i'
        );
        const match = aiReply.match(regex);
        return match ? match[1].trim() : null;
    };

    const extractHtmlWithFileName = (content) => {
        const regex = /([\w.-]+\.html)[^\n]*\n(?:.*\n)*?\`\`\`html\s*([\s\S]*?)\`\`\`/g; //regex (if you didnt know)
        let match;
        let result = [];
        while ((match = regex.exec(content)) !== null) {
            const fileName = match[1] ? match[1].trim() : null;
            const code = match[2].trim();
            result.push({ fileName, code });
        }

        if (result.length === 0) {
            const simpleMatch = content.match(/\`\`\`html\s*([\s\S]*?)\`\`\`/i); //regex
            if (simpleMatch) {
                result.push({ fileName: null, code: simpleMatch[1].trim() });
            }
        }

        return result;
    };

    if (scriptMode === 'html-only') {
        const htmlResults = extractHtmlWithFileName(aiReply);
        if (htmlFileOption === 'multiple' && htmlResults.length > 0) {
            htmlCode = htmlResults[0].code;
            additionalHtmlCodes = htmlResults.slice(1).map((item, index) => ({
                fileName: item.fileName || `page${index + 1}.html`,
                code: item.code
            }));
        } else {
            htmlCode = htmlResults[0]?.code;
        }
    } else if (scriptMode === 'pygame') {
        pythonCode = extractCode('python') || extractCode('py');
    } else {
        const htmlResults = extractHtmlWithFileName(aiReply);
        htmlCode = htmlResults[0]?.code;
        cssCode = extractCode('css');
        jsCode = extractCode('javascript');
        pythonCode = extractCode('python') || extractCode('py');
        if (htmlFileOption !== 'single' && htmlResults.length > 1) {
            additionalHtmlCodes = htmlResults.slice(1).map((item, index) => ({
                fileName: item.fileName || `page${index + 1}.html`,
                code: item.code
            }));
        }
    }

    return { htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes };
}

function flaskPlacehold(code) {
  const placeholder = '[FLASK_KEY]';
  if (code.includes(placeholder)) {
      const key = require('crypto').randomBytes(16).toString('hex');
      return code.replace(new RegExp('\\[FLASK_KEY\\]', 'g'), `'${key}'`);
  }
  return code;
}

async function processGen(req, code, fileType, htmlFile = '', index = '', scriptMode = 'html-js-css') {
  const imageRegex = /\[IMAGE:(.*?)\]/g; //regex
  let updatedCode = code;
  let match;
  const replacements = [];

  while ((match = imageRegex.exec(code)) !== null) {
    const desc = match[1].trim();
    const tmpName = `image_${fileType}${index}_${replacements.length + 1}.png`;

    // default HTML/CSS/JS replacement
    let replacement;
    switch (fileType) {
      case 'html':
        replacement = scriptMode === 'flask'
          ? `<img src="/static/assets/${tmpName}" alt="${desc}" />`
          : `<img src="${tmpName}" alt="${desc}" />`;
        break;
      case 'css':
        replacement = scriptMode === 'flask'
          ? `url('/static/assets/${tmpName}')`
          : `url('${tmpName}')`;
        break;
      default:
        replacement = scriptMode === 'flask'
          ? `'/static/assets/${tmpName}'`
          : `'${tmpName}'`;
    }
    updatedCode = updatedCode.replace(match[0], replacement);

    // try to actually generate
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const realName = await generateImg(req, desc, tmpName, htmlFile || fileType, scriptMode);
      replacements.push([tmpName, realName]);
    } catch (e) {
      console.error('Image generation failed:', e?.response?.data || e.message);
    }
  }

  // swap in real names for successful generations
  for (const [from, to] of replacements) {
    updatedCode = updatedCode.replace(new RegExp(from, 'g'), to);
  }
  return updatedCode;
}


function projInfo(req) {
  const generatedDir = genPaths(req);
  const files = [];
  function walk(dir, rel = '') {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
      const f = d.name;
      if (f === 'uploads' || f === '__pycache__' || f.endsWith('.pyc')) return;
      if (!rel && RESERVED_PROJECT_NAMES.has(f)) return;
      const full = path.join(dir, f);
      const relative = path.posix.join(rel, f).replace(/\\/g, '/');
      if (d.isDirectory()) {
        files.push({ path: relative + '/', directory: true });
        walk(full, relative);
      } else {
        const isBinary = /\.(png|jpe?g|webp|gif|mp3|wav|ogg|mp4|webm|mov)$/i.test(f); //regex
        files.push({
          path: relative,
          directory: false,
          content: isBinary ? null : fs.readFileSync(full, 'utf8'),
          binary: !!isBinary
        });
      }
    });
  }
  if (fs.existsSync(generatedDir)) walk(generatedDir);
  const layout = files.map(f => `- ${f.path}`).join('\n');
  const codeText = files
    .filter(f => !f.directory && f.content != null)
    .map(f => `File: ${f.path}\n${f.content}`).join('\n\n');
  return { layout, codeText, files };
}

function parseEdit(text) {
  const re = /FILE:\s*([^\n\r]+?)\s*\nOLD:\s*```[\w-]*\s*([\s\S]*?)```[\s\S]*?NEW:\s*```[\w-]*\s*([\s\S]*?)```/gi; //big regex
  const edits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    edits.push({
      file: m[1].trim().replace(/^\//, ''),  // relative path
      old: m[2].replace(/\n?---\s*$/, '').trim(), //regex family
      new: m[3].replace(/\n?---\s*$/, '').trim()
    });
  }
  return edits;
}

function parseNew(text) {
  const regex = /NEW FILE:\s*(.+?)\n```(?:[\w]+)?\n([\s\S]*?)```/gi; //move your eyes slightly to the left of the screen
  const files = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
      files.push({ path: match[1].trim().replace(/^\//, ''), code: match[2].replace(/\n?---\s*$/, '').trim() });
  }
  return files;
}

function applyEditsToFiles(req, edits) {
  const modified = new Set();
  const pending = [];

  for (const edit of edits) {
    const fullPath = genPaths(req, edit.file);
    if (!fs.existsSync(fullPath)) { pending.push(edit); continue; }

    let content = fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n');
    const oldRaw = edit.old.replace(/\r\n/g, '\n');
    const newRaw = edit.new.replace(/\r\n/g, '\n');

    let updated;
    if (!oldRaw.trim()) {
      updated = content;
    } else {
      const norm = s => s.replace(/\r\n/g, '\n');
      const contentNorm = norm(content);
      const targetNorm = norm(oldRaw);

      let idx = contentNorm.indexOf(targetNorm);
      if (idx !== -1) {
        updated = contentNorm.slice(0, idx) + newRaw + contentNorm.slice(idx + targetNorm.length);
      } else {
        const lines = contentNorm.split('\n');
        const tgtLines = targetNorm.split('\n');
        const tgtJoin = tgtLines.join('\n');
        const tgtNormWS = tgtJoin.replace(/\s+/g, ' ').trim();

        let best = { score: 0, index: -1 };
        for (let i = 0; i <= lines.length - tgtLines.length; i++) {
          const slice = lines.slice(i, i + tgtLines.length).join('\n');
          if (slice === tgtJoin) { best = { score: 1, index: i }; break; }
          const score = stringSimilarity.compareTwoStrings(slice.replace(/\s+/g, ' ').trim(), tgtNormWS);
          if (score > best.score) best = { score, index: i };
        }

        if (best.score >= 0.6) {
          updated = [
            ...lines.slice(0, best.index),
            ...newRaw.split('\n'),
            ...lines.slice(best.index + tgtLines.length)
          ].join('\n');
        } else {
          updated = false;
        }
      }
    }

    if (updated === false) { pending.push(edit); continue; }

    fs.writeFileSync(fullPath, updated);
    modified.add(edit.file);
  }
  return { modified: [...modified], pending };
}

function editPrompt(prompt, layout, codeText, historyText, scriptMode, htmlFileOption) {
    let base = `${historyText}Here is the current project directory:\n${layout}\n\nCurrent code:\n${codeText}\n\nPlease modify the code according to: "${prompt}". For each file you modify respond in the **exact** format below\n (repeat the group for every file you change). \n\nFILE: relative/path/to/file.js\nOLD:\n\`\`\`<language>\n(old code)\n\`\`\`\n\nNEW:\n\`\`\`<language>\n(new code)\n\`\`\`\n---\n\n. Remember that if a file is in base directory, simply use its name by itself. For multiple changes, simply repeat the block foe every change, divided by --- . i.e: \n\nFILE: file.html\nOLD:\n\`\`\`<language>\n(old code)\n\`\`\`\n\nNEW:\n\`\`\`<language>\n(new code)\n\`\`\`\n---\n\nFILE: relative/path/to/file.js\nOLD:\n\`\`\`<language>\n(old code)\n\`\`\`\n\nNEW:\n\`\`\`<language>\n(new code)\n\`\`\`\n---\n\n and so on. Remember to inlcude the EXACT SAME indenting in both the new and old codeblocks, exactly as the lines are indented to ensure the edits are properly processed. Remember that you do not have to put the entire script or most of the script into OLD and NEW blocks unless the change requires it. you should usually just put functions and or small sections of the script into the OLD and NEW codeblocks for the changes `;
    if (scriptMode !== 'pygame' && htmlFileOption !== 'single') {
        base += `\n\nTo create a new file, use the following format exactly:\nNEW FILE: /path/filename\n\`\`\`<language>\n(code goes here)\n\`\`\``;
    }
    return base;
}

async function retryPendingEdits(pending, model, scriptMode, htmlFileOption = 'single') {
  let attempts = 0, remaining = pending;

  while (remaining.length && attempts < 3) {
    const info = projInfo(req);
    const history = loadHistory().messages;

    const pendingText = remaining.map(e =>
      `FILE: ${e.file}\nOLD:\n\`\`\`\n${e.old}\n\`\`\`\nNEW:\n\`\`\`\n${e.new}\n\`\`\``)
      .join('\n\n');

    const prompt = `The following edits could not be applied. Provide corrected code blocks so they can be applied.\n\n${pendingText}`;
    const finalPrompt = editPrompt(
      prompt, info.layout, info.codeText, buildHistory(history),
      scriptMode, htmlFileOption
    );

    const aiReply = await editCode(finalPrompt, model);
    addHistory('retry edits', finalPrompt, aiReply);

    const edits = parseEdit(aiReply);
    const result = applyEditsToFiles(req, edits);
    await imgPlacehold(req, result.modified, scriptMode);

    remaining = result.pending;
    attempts++;
  }
  return remaining;
}


app.post('/upload-for-code', ensureAuth, fileOpsLimiter, (req, res, next) => csrfProtection(req, res, next), upload.array('files'), (req, res) => {
    try {
      const uploadedFiles = req.files;
      const fileNames = uploadedFiles.map(file => file.originalname);
      res.json({ message: 'Files uploaded successfully', files: fileNames });
    } catch (error) {
      console.error('Error uploading files:', error);
      res.status(500).json({ error: 'An error occurred while uploading files.' });
    }
  }
);

async function generateCode(req, prompt, model, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount) {
  let finalPrompt;
  finalPrompt = generatePrompt(prompt, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount);
  const settings = { scriptMode, imageOption, htmlFileOption, htmlPageCount };
  console.log(settings);
  console.log(model)
  const { code: cacheFile } = getCache(req);
  const cache = loadCache(cacheFile);
  cleanupCache(cache, CODE_CACHE_DURATION);
  const now = Date.now();
  for (const entry of cache) {
      if (
          entry.settings.imageOption === settings.imageOption &&
          entry.settings.scriptMode === settings.scriptMode &&
          entry.settings.htmlFileOption === settings.htmlFileOption &&
          entry.settings.htmlPageCount === settings.htmlPageCount &&
          stringSimilarity.compareTwoStrings(entry.prompt, prompt) >= 0.9
      ) {
          entry.timestamp = now;
          fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
          return { aiReply: entry.response, finalPrompt };
      }
  }

  let aiReply;
  if (model === 'claude-opus-4-1') {
      const response = await axiosPost(
          'https://api.anthropic.com/v1/messages',
          {
              model: 'claude-opus-4-1',
              messages: [{ role: 'user', content: finalPrompt }],
              max_tokens: 32000,
          },
          {
              headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': ANTHROPIC_API_KEY,
                  'anthropic-version': '2023-06-01'
              },
          }
      );
      aiReply = response.data.content[0].text;
  } else if (model === 'claude-sonnet-4') {
      const response = await axiosPost(
          'https://api.anthropic.com/v1/messages',
          {
              model: 'claude-sonnet-4-20250514',
              messages: [{ role: 'user', content: finalPrompt }],
              max_tokens: 64000,
          },
          {
              headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': ANTHROPIC_API_KEY,
                  'anthropic-version': '2023-06-01'
              },
          }
      );
      aiReply = response.data.content[0].text;
  } else if (model === 'gpt-5') {
      const response = await requestWithRetry({
          method: 'post',
          url: '/chat/completions',
          data: {
            model: 'gpt-5',
            messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: finalPrompt }],
          }});
      aiReply = response.data.choices[0].message.content;
  } else if (model === 'gpt-4.1') {
      const response = await requestWithRetry({
          method: 'post',
          url: '/chat/completions',
          data: {
            model: 'gpt-4.1',
            messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: finalPrompt }],
          }});
      aiReply = response.data.choices[0].message.content;
  } else if (model === 'o3') {
      const response = await requestWithRetry({
          method: 'post',
          url: '/chat/completions',
          data: {
            model: 'o3',
            messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: finalPrompt }],
          }});
      aiReply = response.data.choices[0].message.content;
  }
  console.log(aiReply)
  cache.push({ prompt, settings, response: aiReply, timestamp: Date.now() });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  return { aiReply, finalPrompt };
}

async function applyNew(req, files, scriptMode) {
  const created = [];
  for (const file of files) {
    const target = safeJoin(req, file.path.replace(/^\//, '')); //boring regex
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const ext = path.extname(file.path).slice(1) || 'html';
    const processed = await processGen(req, file.code, ext, path.basename(file.path), '', scriptMode);
    fs.writeFileSync(target, processed);
    created.push(file.path);
  }
  return created;
}

async function imgPlacehold(req, files, scriptMode) {
    for (const rel of files) {
        const full = genPaths(req, rel);
        if (!fs.existsSync(full)) continue;
        const ext = path.extname(rel).replace('.', '') || 'html';
        const content = fs.readFileSync(full, 'utf8');
        const processed = await processGen(req, content, ext, path.basename(rel), '', scriptMode);
        fs.writeFileSync(full, processed);
    }
}

app.post(
  '/generate-code',
  ensureAuth,
  genLimiter,
  (req, res, next) => csrfProtection(req, res, next),
  async (req, res) => {
    const state = getState(req);
    try {
      state.genId = (state.genId || 0) + 1;
      state.progress = 0;
      if (req?.session) req.session.currentProgress = 0;
      setProgress(0, req);
      const generatedDir = genPaths(req);
      let isEmpty = true;
      if (fs.existsSync(generatedDir)) {
        for (const item of fs.readdirSync(generatedDir)) {
          if (item === 'uploads') continue;
          const itemPath = path.join(generatedDir, item);
          if (fs.statSync(itemPath).isFile()) { isEmpty = false; break; }
        }
      }

      if (!isEmpty) {
        const oldGeneratedDir = path.join(
          __dirname,
          'old-generated',
          String(req.session?.userId || (req.user && req.user.id) || 'global')
        );

        if (!fs.existsSync(oldGeneratedDir)) {
          fs.mkdirSync(oldGeneratedDir);
        } else {
          fs.readdirSync(oldGeneratedDir).forEach(file => {
            const curPath = path.join(oldGeneratedDir, file);
            fs.rmSync(curPath, { recursive: true, force: true });
          });
        }

        if (fs.existsSync(generatedDir)) {
          fs.readdirSync(generatedDir).forEach(file => {
            if (file === 'uploads') return;
            const oldPath = path.join(generatedDir, file);
            const newPath = path.join(oldGeneratedDir, file);
            fs.rmSync(newPath, { recursive: true, force: true });
            fs.renameSync(oldPath, newPath);
          });
        }
      }

      if (fs.existsSync(generatedDir)) {
        fs.readdirSync(generatedDir).forEach(file => {
          const curPath = path.join(generatedDir, file);
          if (file !== 'uploads') {
            fs.rmSync(curPath, { recursive: true, force: true });
          }
        });
      }

      const prompt = req.body.prompt;
      const model = req.body.model;
      const scriptMode = req.body.scriptMode;
      let imageOption = req.body.imageOption;
      const htmlFileOption = req.body.htmlFileOption;
      const htmlPageCount = req.body.htmlPageCount;

      if (scriptMode === 'pygame') {
        imageOption = 'exclude';
      }

      const uploadsDir = genPaths(req, 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      const uploadedFiles = fs.readdirSync(uploadsDir);
      const codeContents = {};
      const codeExtensions = ['.js', '.html', '.css', '.py', '.java', '.cpp', '.ts'];
      uploadedFiles.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (codeExtensions.includes(ext)) {
          const filePath = genPaths(req, 'uploads', file);
          codeContents[file] = fs.readFileSync(filePath, 'utf8');
        }
      });

      fs.writeFileSync(HISTORY_FILE, JSON.stringify({ messages: [] }, null, 2));
      setProgress(20, req);

      const { aiReply, finalPrompt } = await generateCode(
        req, prompt, model, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount
      );
      setProgress(40, req);

      // save per-session prompt/response
      state.lastPrompt = prompt;
      state.lastResponse = aiReply;

      const { htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes } =
        extractCodeAi(aiReply, scriptMode, htmlFileOption);

      const isComplete = checkCodeComplete(
        htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes, scriptMode
      );

      if (!fs.existsSync(generatedDir)) {
        fs.mkdirSync(generatedDir);
      }

      let templatesDir = generatedDir;
      let staticDir = generatedDir;

      if (scriptMode === 'flask') {
        templatesDir = path.join(generatedDir, 'templates');
        staticDir = path.join(generatedDir, 'static');
        if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
        if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });
      }

      const files = [];
      const processPromises = [];

      if (scriptMode === 'html-only') {
        if (typeof htmlCode === 'string') {
          processPromises.push(processGen(req, htmlCode, 'html', 'index.html', '', scriptMode).then(processedHtmlCode => {
            fs.writeFileSync(path.join(generatedDir, 'index.html'), processedHtmlCode);
            files.push('index.html');
          }));
        }

        if (additionalHtmlCodes && additionalHtmlCodes.length) {
          additionalHtmlCodes.forEach((codeObj, index) => {
            const htmlFileName = (codeObj && codeObj.fileName) ? codeObj.fileName : `page${index + 1}.html`;
            const code = (codeObj && codeObj.code) ? codeObj.code : codeObj;
            if (typeof code === 'string') {
              processPromises.push(processGen(req, code, 'html', htmlFileName, index + 1, scriptMode).then(processedCode => {
                fs.writeFileSync(path.join(generatedDir, htmlFileName), processedCode);
                files.push(htmlFileName);
              }));
            }
          });
        }
      } else {
        if (typeof htmlCode === 'string') {
          processPromises.push(processGen(req, htmlCode, 'html', '', '', scriptMode).then(processedHtmlCode => {
            const target = scriptMode === 'flask' ? templatesDir : generatedDir;
            fs.writeFileSync(path.join(target, 'index.html'), processedHtmlCode);
            files.push(scriptMode === 'flask' ? path.join('templates','index.html') : 'index.html');
          }));
        }

        if (typeof cssCode === 'string') {
          processPromises.push(processGen(req, cssCode, 'css', '', '', scriptMode).then(processedCssCode => {
            const target = scriptMode === 'flask' ? staticDir : generatedDir;
            fs.writeFileSync(path.join(target, 'styles.css'), processedCssCode);
            files.push(scriptMode === 'flask' ? path.join('static','styles.css') : 'styles.css');
          }));
        }

        if (typeof jsCode === 'string') {
          processPromises.push(processGen(req, jsCode, 'js', '', '', scriptMode).then(processedJsCode => {
            const target = scriptMode === 'flask' ? staticDir : generatedDir;
            fs.writeFileSync(path.join(target, 'script.js'), processedJsCode);
            files.push(scriptMode === 'flask' ? path.join('static','script.js') : 'script.js');
          }));
        }

        if (additionalHtmlCodes && additionalHtmlCodes.length) {
          additionalHtmlCodes.forEach((codeObj, index) => {
            const htmlFileName = (codeObj && codeObj.fileName) ? codeObj.fileName : `page${index + 1}.html`;
            const code = (codeObj && codeObj.code) ? codeObj.code : codeObj;
            if (typeof code === 'string') {
              processPromises.push(processGen(req, code, 'html', htmlFileName, '', scriptMode).then(processedCode => {
                const target = scriptMode === 'flask' ? templatesDir : generatedDir;
                fs.writeFileSync(path.join(target, htmlFileName), processedCode);
                files.push(scriptMode === 'flask' ? path.join('templates', htmlFileName) : htmlFileName);
              }));
            }
          });
        }

        if (scriptMode === 'flask' && typeof pythonCode === 'string') {
          processPromises.push(processGen(req, pythonCode, 'py', '', '', scriptMode).then(processedPy => {
            const withKey = flaskPlacehold(processedPy);
            fs.writeFileSync(path.join(generatedDir, 'app.py'), withKey);
            files.push('app.py');
          }));
        } else if (scriptMode === 'pygame' && typeof pythonCode === 'string') {
          processPromises.push(processGen(req, pythonCode, 'py', '', '', scriptMode).then(processedPy => {
            fs.writeFileSync(path.join(generatedDir, 'game.py'), processedPy);
            files.push('game.py');
          }));
        }
      }

      await Promise.all(processPromises);
      setProgress(70, req);

      // checks
      const errors = await checkForErrors(req, htmlCode, cssCode, jsCode, pythonCode, scriptMode, additionalHtmlCodes);

      if (errors.length > 0) {
        res.json({ message: 'Code generated with errors', files, errors, isComplete: isComplete });
      } else {
        res.json({ message: 'Code and images generated successfully', files, isComplete: isComplete });
      }

      setProgress(90, req);
      moveCode(req);
      clearSavedPrototype(req);
      setProgress(100, req);
    } catch (error) {
      console.error('Error generating code and images:', error);
      // on failure we don't want to leave a phantom 100 lying around, keep it 0
      setProgress(0, req);
      res.status(500).json({ message: 'Failed to generate code', error: error.message, isComplete: false });
      clearSavedPrototype(req);
    }
  }
);


app.post('/continue-code', genLimiter, (req, res, next) => csrfProtection(req, res, next), async (req, res) => {
  try {
    const state = getState(req);
    const { model, scriptMode, imageOption, htmlFileOption, htmlPageCount } = req.body;

    const continuePrompt = `Please continue the code generation based on the following prompt and previous response:

Previous prompt: ${state.lastPrompt || ''}

Previous response:
${state.lastResponse || ''}

Please complete the code generation, ensuring all necessary parts are included.`;

    const { aiReply } = await generateCode(
      req,
      continuePrompt,
      model,
      [],
      {},
      scriptMode,
      imageOption,
      htmlFileOption,
      htmlPageCount
    );

    state.lastResponse = (state.lastResponse || '') + aiReply;

    let {
      htmlCode,
      cssCode,
      jsCode,
      pythonCode,
      additionalHtmlCodes
    } = extractCodeAi(aiReply, scriptMode, htmlFileOption);

    console.log('htmlFileOption =', htmlFileOption);
    console.log('additionalHtmlCodes length =', additionalHtmlCodes.length);

    // if python but no new python was returned
    if ((scriptMode === 'pygame' || scriptMode === 'flask') && (!pythonCode || pythonCode.trim() === '')) {
      const pyFile = scriptMode === 'pygame' ? 'game.py' : 'app.py';
      const existingPath = genPaths(req, pyFile);
      if (fs.existsSync(existingPath)) {
        pythonCode = fs.readFileSync(existingPath, 'utf8');
      }
    }

    const isComplete = checkCodeComplete(
      htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes, scriptMode
    );

    const generatedDir = genPaths(req);
    if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir);

    let templatesDir = generatedDir;
    let staticDir = generatedDir;
    if (scriptMode === 'flask') {
      templatesDir = path.join(generatedDir, 'templates');
      staticDir = path.join(generatedDir, 'static');
      if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
      if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });
    }

    const files = [];
    const processPromises = [];

    if (scriptMode === 'html-only') {
      if (htmlCode) {
        processPromises.push(
          processGen(req, htmlCode, 'html', 'index.html', '', scriptMode)
            .then(processed => {
              fs.writeFileSync(path.join(templatesDir, 'index.html'), processed);
              files.push(scriptMode === 'flask'
                ? path.join('templates', 'index.html')
                : 'index.html');
            })
        );
      }

      if (htmlFileOption === 'multiple' && additionalHtmlCodes && additionalHtmlCodes.length) {
        additionalHtmlCodes.forEach((codeObj, idx) => {
          if (!codeObj?.code) return;
          const fileName = codeObj.fileName || `page${idx + 1}.html`;
          processPromises.push(
            processGen(req, codeObj.code, 'html', fileName, '', scriptMode)
              .then(proc => {
                fs.writeFileSync(path.join(templatesDir, fileName), proc);
                files.push(scriptMode === 'flask'
                  ? path.join('templates', fileName)
                  : fileName);
              })
          );
        });
      }

    } else {
      if (htmlCode) {
        processPromises.push(
          processGen(req, htmlCode, 'html', 'index.html', '', scriptMode)
            .then(proc => {
              fs.writeFileSync(path.join(templatesDir, 'index.html'), proc);
              files.push(scriptMode === 'flask'
                ? path.join('templates', 'index.html')
                : 'index.html');
            })
        );
      }

      if (cssCode) {
        processPromises.push(
          processGen(req, cssCode, 'css', 'styles.css', '', scriptMode)
            .then(proc => {
              fs.writeFileSync(path.join(staticDir, 'styles.css'), proc);
              files.push(scriptMode === 'flask'
                ? path.join('static', 'styles.css')
                : 'styles.css');
            })
        );
      }

      if (jsCode) {
        processPromises.push(
          processGen(req, jsCode, 'js', 'script.js', '', scriptMode)
            .then(proc => {
              fs.writeFileSync(path.join(staticDir, 'script.js'), proc);
              files.push(scriptMode === 'flask'
                ? path.join('static', 'script.js')
                : 'script.js');
            })
        );
      }

      if (htmlFileOption === 'multiple' && additionalHtmlCodes && additionalHtmlCodes.length) {
        additionalHtmlCodes.forEach((codeObj, idx) => {
          if (!codeObj?.code) return;
          const fileName = codeObj.fileName || `page${idx + 1}.html`;
          processPromises.push(
            processGen(req, codeObj.code, 'html', fileName, '', scriptMode)
              .then(proc => {
                fs.writeFileSync(path.join(templatesDir, fileName), proc);
                files.push(scriptMode === 'flask'
                  ? path.join('templates', fileName)
                  : fileName);
              })
          );
        });
      }

      if (scriptMode === 'flask' && typeof pythonCode === 'string') {
        processPromises.push(
          processGen(req, pythonCode, 'py', 'app.py', '', scriptMode)
            .then(proc => {
              const withKey = flaskPlacehold(proc);
              fs.writeFileSync(path.join(generatedDir, 'app.py'), withKey);
              files.push('app.py');
            })
        );
      } else if (scriptMode === 'pygame' && typeof pythonCode === 'string') {
        processPromises.push(
          processGen(req, pythonCode, 'py', 'game.py', '', scriptMode)
            .then(proc => {
              fs.writeFileSync(path.join(generatedDir, 'game.py'), proc);
              files.push('game.py');
            })
        );
      }
    }

    await Promise.all(processPromises);

    const errors = await checkForErrors(
      req,
      htmlCode, cssCode, jsCode, pythonCode, scriptMode, additionalHtmlCodes
    );

    if (errors.length) {
      res.json({
        message: 'Code continued with errors',
        files,
        errors,
        isComplete: isComplete
      });
    } else {
      res.json({
        message: 'Code continuation successful',
        files,
        isComplete: isComplete
      });
    }

    moveCode(req);
  } catch (error) {
    console.error('Error continuing code generation:', error);
    res.status(500).json({
      message: 'Failed to continue code generation',
      error: error.message
    });
  }
});
 

function checkCodeComplete(htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes, scriptMode) {
    if (scriptMode === 'html-only') {
        return typeof htmlCode === 'string' && htmlCode.trim() !== '';
    } else if (scriptMode === 'pygame') {
        return typeof pythonCode === 'string' && pythonCode.trim() !== '';
    }

    const isHtmlComplete = typeof htmlCode === 'string' && htmlCode.trim() !== '';
    const isCssComplete = typeof cssCode === 'string' && cssCode.trim() !== '';
    const isJsComplete = typeof jsCode === 'string' && jsCode.trim() !== '';
    const isPythonComplete = (scriptMode === 'flask' || scriptMode === 'pygame') ?
        (typeof pythonCode === 'string' && pythonCode.trim() !== '') : true;
    const areAdditionalHtmlComplete = additionalHtmlCodes.every(item => {
        const code = typeof item === 'string' ? item : item.code;
        return typeof code === 'string' && code.trim() !== '';
    });

    return isHtmlComplete && isCssComplete && isJsComplete && isPythonComplete && areAdditionalHtmlComplete;
}

async function checkForErrors(req, htmlCode, cssCode, jsCode, pythonCode, scriptMode, additionalHtmlCodes) {
    const errors = [];

    // check HTML
    if (scriptMode !== 'pygame') {
        if (!htmlCode || htmlCode.trim() === '') {
            errors.push('Main HTML code is empty or missing');
        }
    }

    if (scriptMode !== 'pygame' && additionalHtmlCodes && Array.isArray(additionalHtmlCodes)) {
        additionalHtmlCodes.forEach((codeObj, index) => {
            const code = codeObj.code || codeObj.content; // handle both possible structures
            if (!code || typeof code !== 'string' || code.trim() === '') {
                errors.push(`Additional HTML file ${index + 2} is empty or missing`);
            }
        });
    }

    // check CSS
    if (cssCode && cssCode.trim() !== '') {
        const cssResults = csslint.verify(cssCode);
        cssResults.messages.forEach(message => {
            if (message.type === 'error') {
                errors.push(`CSS Error: ${message.message} at line ${message.line}, column ${message.col}`);
            }
        });
    }

    // check javascript
    if ((scriptMode === 'html-js-css' || scriptMode === 'flask') && jsCode) {
    const results = await jsLinter.lintText(jsCode);
    results[0].messages.forEach(m => {
        if (m.severity === 2) {
        errors.push(`JS Error: ${m.message} at line ${m.line}, col ${m.column}`);
        }
    });
    }

    if ((scriptMode === 'flask' || scriptMode === 'pygame') &&
        (!pythonCode || pythonCode.trim() === '')) {
        const fileName = scriptMode === 'pygame' ? 'game.py' : 'app.py';
        errors.push(`${fileName} code is empty or missing`);
    } else if (pythonCode && (scriptMode === 'flask' || scriptMode === 'pygame')) {
        try {
            const tmpPath = genPaths(req, '__tmp_check__.py');
            fs.writeFileSync(tmpPath, pythonCode);
            execSync(`python -m py_compile ${tmpPath}`);
            fs.unlinkSync(tmpPath);
        } catch (e) {
            errors.push('Python Error: ' + (e.stderr ? e.stderr.toString() : e.message));
        }
    }

    return errors;
}

async function editCode(finalPrompt, model) {
    console.log(finalPrompt);

    if (model === 'claude-opus-4-1') {
        const response = await axiosPost(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-opus-4-1',
                messages: [{ role: 'user', content: finalPrompt }],
                max_tokens: 32000
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
            }
        );
        return response.data.content[0].text;
    } else if (model === 'claude-sonnet-4') {
        const response = await axiosPost(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-sonnet-4',
                messages: [{ role: 'user', content: finalPrompt }],
                max_tokens: 64000,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
            }
        );
        return response.data.content[0].text;
    } else if (model === 'gpt-5') {
        const response = await requestWithRetry({
            method: 'post',
            url: '/chat/completions',
            data: {
              model: 'gpt-5',
              messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: finalPrompt }],
            }});
            return response.data.choices[0].message.content;
    } else if (model === 'gpt-4.1') {
        const response = await requestWithRetry({
            method: 'post',
            url: '/chat/completions',
            data: {
              model: 'gpt-4.1',
              messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: finalPrompt }],
            }});
            return response.data.choices[0].message.content;
    } else if (model === 'o3') {
        const response = await requestWithRetry({
            method: 'post',
            url: '/chat/completions',
            data: {
              model: 'o3',
              messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: finalPrompt }]
            }});
            return response.data.choices[0].message.content;
    }
}

const readIfExists = (p) => (p && fs.existsSync(p)) ? fs.readFileSync(p, 'utf8') : '';

app.post('/edit-code', ensureAuth, genLimiter, (req, res, next) => csrfProtection(req, res, next), async (req, res) => {
    try {
        const generatedDir = genPaths(req);
        const oldGeneratedDir = path.join(
            __dirname,
            'old-generated',
            String(req.session?.userId || (req.user && req.user.id) || 'global')
        );

        if (!fs.existsSync(oldGeneratedDir)) {
            fs.mkdirSync(oldGeneratedDir);
        } else {
            fs.readdirSync(oldGeneratedDir).forEach(file => {
                const curPath = path.join(oldGeneratedDir, file);
                fs.rmSync(curPath, { recursive: true, force: true });
            });
        }

        if (fs.existsSync(generatedDir)) {
            fs.readdirSync(generatedDir).forEach(file => {
                if (file === 'uploads') return;
                const sourcePath = path.join(generatedDir, file);
                const destPath = path.join(oldGeneratedDir, file);
                fs.cpSync(sourcePath, destPath, { recursive: true });
            });
        }
        const prompt = req.body.prompt;
        const model = req.body.model;
        const scriptMode = req.body.scriptMode;
        let imageOption = req.body.imageOption;
        const htmlFileOption = req.body.htmlFileOption;
        const htmlPageCount = req.body.htmlPageCount;

        if (scriptMode === 'pygame') {
            imageOption = 'exclude';
        }
        const history = loadHistory().messages;
        const info = projInfo(req);
        const finalPrompt = editPrompt(prompt, info.layout, info.codeText, buildHistory(history), scriptMode, htmlFileOption);

        const aiReply = await editCode(finalPrompt, model);
        console.log('response: ' + aiReply);
        addHistory(prompt, finalPrompt, aiReply);
        const edits = parseEdit(aiReply);
        const newFiles = parseNew(aiReply);
        let { modified, pending } = applyEditsToFiles(req, edits);
        const created = await applyNew(req, newFiles, scriptMode);
        modified = modified.concat(created);
        if (pending.length > 0) {
            pending = await retryPendingEdits(pending, model, scriptMode, htmlFileOption);
        }

        await imgPlacehold(req, modified, scriptMode);

        const base = genPaths(req);
        const htmlPath = scriptMode === 'flask'
          ? path.join(base, 'templates', 'index.html')
          : path.join(base, 'index.html');
        const cssPath = scriptMode === 'flask'
          ? path.join(base, 'static', 'styles.css')
          : path.join(base, 'styles.css');
        const jsPath = scriptMode === 'flask'
          ? path.join(base, 'static', 'script.js')
          : path.join(base, 'script.js');
        const pyPath = path.join(base, scriptMode === 'pygame' ? 'game.py' : 'app.py');

        const errors = await checkForErrors(
        req,
        readIfExists(htmlPath),
        readIfExists(cssPath),
        readIfExists(jsPath),
        readIfExists(pyPath),
        scriptMode,
        []
        );

        if (errors.length > 0) {
            const historyFix = loadHistory().messages;
            const infoFix = projInfo(req);
            const errorText = errors.join('\n');
            const fixPrompt = `Fix the following errors:\n${errorText}`;
            const finalPromptFix = editPrompt(fixPrompt, infoFix.layout, infoFix.codeText, buildHistory(historyFix), scriptMode, 'single');
            const aiFixReply = await editCode(finalPromptFix, model);
            addHistory('fix errors', finalPromptFix, aiFixReply);
            const fixEdits = parseEdit(aiFixReply);
            const fixNewFiles = parseNew(aiFixReply);
            let { modified: fixModified, pending: fixPending } = applyEditsToFiles(req, fixEdits);
            const fixCreated = await applyNew(req, fixNewFiles, scriptMode);
            if (fixPending.length > 0) {
                fixPending = await retryPendingEdits(fixPending, model, scriptMode, 'single');
            }
            await imgPlacehold(req, [...fixModified, ...fixCreated], scriptMode);
        }

        const finalErrors = await checkForErrors(
        req,
        readIfExists(htmlPath),
        readIfExists(cssPath),
        readIfExists(jsPath),
        readIfExists(pyPath),
        scriptMode,
        []
        );

        if (pending.length > 0) {
            res.json({ message: 'Some edits could not be applied', files: modified, pending: pending.map(p => p.old), errors: finalErrors });
        } else if (finalErrors.length > 0) {
            res.json({ message: 'Code updated with errors', files: modified, errors: finalErrors });
        } else {
            res.json({ message: 'Code updated successfully', files: modified });
        }
    } catch (error) {
        console.error('Error editing code:', error);
        res.status(500).json({ error: 'An error occurred while editing the code.' });
    }
});

app.get('/files', ensureAuth, (req, res) => {
  try {
    const info = projInfo(req);
    res.json(info.files);
  } catch (err) {
    console.error('Failed to read files', err);
    res.status(500).json({ error: 'Failed to read files' });
  }
});


app.post('/save-file', fileOpsLimiter, ensureAuth, (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: 'No path provided' });
    const fullPath = safeJoin(req, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    if (typeof content === 'string' && /^data:[^;]+;base64,/.test(content)) { //xeger
      const base64 = content.split(',')[1];
      fs.writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    } else {
      fs.writeFileSync(fullPath, content ?? '', 'utf8');
    }
    res.json({ message: 'saved' });
  } catch (err) {
    console.error('Save file error:', err);
    res.status(500).json({ error: 'Failed to save file' });
  }
});

app.post('/create-directory', fileOpsLimiter, ensureAuth, (req, res) => {
  try {
    const dirPath = req.body.path;
    if (!dirPath) return res.status(400).json({ error: 'No path provided' });
    const fullPath = safeJoin(req, dirPath.replace(/\/+$/, ''));
    fs.mkdirSync(fullPath, { recursive: true });
    res.json({ message: 'directory created' });
  } catch (err) {
    console.error('Create directory error:', err);
    res.status(500).json({ error: 'Failed to create directory' });
  }
});


app.post('/delete-file', fileOpsLimiter, ensureAuth, (req, res) => {
  try {
    const filePath = req.body.path;
    if (!filePath) return res.status(400).json({ error: 'No path provided' });
    const fullPath = safeJoin(req, filePath);
    if (fs.existsSync(fullPath)) {
      const stat = fs.lstatSync(fullPath);
      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    res.json({ message: 'deleted' });
  } catch (err) {
    console.error('Delete file error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

app.post('/move-file', fileOpsLimiter, ensureAuth, (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) return res.status(400).json({ error: 'Paths required' });
    const oldFull = safeJoin(req, oldPath);
    const newFull = safeJoin(req, newPath);
    fs.mkdirSync(path.dirname(newFull), { recursive: true });
    fs.renameSync(oldFull, newFull);
    res.json({ message: 'moved' });
  } catch (err) {
    console.error('Move file error:', err);
    res.status(500).json({ error: 'Failed to move file' });
  }
});

app.post('/duplicate-path', fileOpsLimiter, ensureAuth, (req, res) => {
  try {
    const { src, dest } = req.body;
    if (!src || !dest) return res.status(400).json({ error: 'Paths required' });
    const srcFull = safeJoin(req, src);
    const destFull = safeJoin(req, dest);
    fs.mkdirSync(path.dirname(destFull), { recursive: true });
    const stat = fs.lstatSync(srcFull);
    if (stat.isDirectory()) {
      fs.cpSync(srcFull, destFull, { recursive: true, force: true });
    } else {
      fs.copyFileSync(srcFull, destFull);
    }
    res.json({ message: 'duplicated' });
  } catch (err) {
    console.error('Duplicate path error:', err);
    res.status(500).json({ error: 'Failed to duplicate path' });
  }
});

app.post('/create-apk', ensureAuth, heavyLimiter, (req, res, next) => csrfProtection(req, res, next), async (req, res) => {
    try {
      const genDir = genPaths(req);
      const raw = String(req.body.file || 'game.py').replace(/\\/g, '/');
      if (path.isAbsolute(raw) || !/\.py$/i.test(raw)) {
        return res.status(400).json({ error: 'Invalid file' });
      }

      // ensure the target is inside /generated
      const targetAbs = safeJoin(req, raw);
      if (!fs.existsSync(targetAbs)) {
        return res.status(400).json({ error: 'file not found' });
      }

      const rel = path.relative(genDir, targetAbs).replace(/\\/g, '/');
      const build = spawn('pygbag', [rel], { cwd: genDir, stdio: 'inherit' });

      const findApk = dir => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const it of items) {
          const p = path.join(dir, it.name);
          if (it.isDirectory()) {
            const f = findApk(p);
            if (f) return f;
          } else if (it.name.endsWith('.apk')) {
            return p;
          }
        }
      };

      const apkPath = await new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          const apk = findApk(genDir);
          if (apk) {
            clearInterval(interval);
            try { build.kill('SIGINT'); } catch {}
            resolve(apk);
          }
        }, 1000);
        build.on('error', err => { clearInterval(interval); reject(err); });
        build.on('exit', () => {
          const apk = findApk(genDir);
          clearInterval(interval);
          if (apk) resolve(apk); else reject(new Error('APK not produced'));
        });
      });

      const apkDir = genPaths(req, 'apk');
      fs.mkdirSync(apkDir, { recursive: true });
      const destApk = path.join(apkDir, path.basename(apkPath));
      fs.copyFileSync(apkPath, destApk);

      // cleanup build artifacts
      fs.readdirSync(genDir).forEach(item => {
        const isSourcePy = item === raw;
        const isApkDir = item === 'apk'; 
        if (isSourcePy || isApkDir) return;
        fs.rmSync(path.join(genDir, item), { recursive: true, force: true });
      });

      res.json({ apk: `/apk/${req.session?.userId || (req.user && req.user.id) || 'global'}/${path.basename(apkPath)}` });
    } catch (err) {
      console.error('Create apk error:', err);
      res.status(500).json({ error: 'Failed to create apk' });
    }
  }
);

const previewApp = express();

// the main app already sets CSP allowing this origin in frame-src
previewApp.use(helmet({
  contentSecurityPolicy: false, frameguard: false,
  referrerPolicy: { policy: 'no-referrer' }
}));
previewApp.use(cookieParser());

// all requests must either carry a path token or a preview_token cookie
function getUserFromReq(req) {
  const pathMatch = req.path.match(/^\/p\/([^/]+)\//); //regexegex
  if (pathMatch) {
    const token = pathMatch[1];
    const userId = valPreviewToken(token);
    if (userId) return { userId, tokenFromPath: token };
    return null;
  }

  const token = req.cookies?.preview_token;
  if (!token) return null;
  const userId = valPreviewToken(token);
  if (!userId) return null;
  return { userId, tokenFromCookie: token };
}

function sendFileForUser(res, userId, relPath) {
  let clean = (relPath || '').replace(/^\/+/, '');
  if (!clean) clean = 'index.html';
  try {
    if (path.isAbsolute(clean) || clean.includes('\0')) throw new Error('bad path');
    const normalized = clean.replace(/\\/g, '/');
    if (normalized.split('/').some(p => p === '..')) throw new Error('bad path');

    const base = path.resolve(path.join(__dirname, 'generated', String(userId)));
    const full = path.resolve(base, normalized);
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error('bad path');

    if (!fs.existsSync(full)) return res.status(404).end();
    const ctype = mime.lookup(full) || 'application/octet-stream';
    res.setHeader('Content-Type', ctype);
    res.sendFile(full);
  } catch {
    return res.status(400).end();
  }
}

function sendFileForUserWithBase(res, userId, relPath, token) {
  // default to index.html
  let clean = (relPath || '').replace(/^\/+/, '');
  if (!clean) clean = 'index.html';

  try {
    // basic path hardening
    if (path.isAbsolute(clean) || clean.includes('\0')) throw new Error('bad path');
    const normalized = clean.replace(/\\/g, '/');
    if (normalized.split('/').some(p => p === '..')) throw new Error('bad path');

    // resolve within the users generated dir
    const base = path.resolve(path.join(__dirname, 'generated', String(userId)));
    const full = path.resolve(base, normalized);
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error('bad path');
    if (!fs.existsSync(full)) return res.status(404).send('Not found');

    // content type
    const ctype = mime.lookup(full) || 'application/octet-stream';
    res.setHeader('Content-Type', ctype);
    if (ctype.startsWith('text/html')) {
      let html = fs.readFileSync(full, 'utf8');
      if (!/<base\s/i.test(html)) {
        const baseTag = `<base href="/p/${token}/">`;
        const withHead = html.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`);
        if (withHead === html) {
          html = `${baseTag}\n${html}`;
        } else {
          html = withHead;
        }
      }

      return res.send(html);
    }
    return res.sendFile(full);
  } catch {
    return res.status(400).send('Bad request');
  }
}


previewApp.get('/p/:token/*', (req, res) => {
  const token = req.params.token;
  const userId = valPreviewToken(token);
  if (!userId) return res.status(403).send('Invalid preview token');

  // keep token in-path
  res.cookie('preview_token', token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: PREVIEW_TOKEN_TTL_MS
  });

  const rel = req.params[0] || 'index.html';
  return sendFileForUserWithBase(res, userId, rel, token);
});

// fallback route
previewApp.get('/*', (req, res) => {
  const token = req.cookies?.preview_token;
  const userId = token ? valPreviewToken(token) : null;
  if (!userId) return res.status(403).send('Forbidden');
  const rel = req.path === '/' ? 'index.html' : req.path;
  return sendFileForUserWithBase(res, userId, rel, token);
});

previewApp.listen(PREVIEW_PORT, PREVIEW_HOST, () => {
  console.log(`Preview server listening at ${PREVIEW_HTTP}`);
});

app.get(['/preview', '/preview/*'], ensureAuth, ensureProjectContext, (req,res)=>{
  const rawFile = (req.params[0] || 'index.html').replace(/\\/g,'/').replace(/^\/+/,'');
  if (rawFile.split('/').some(p=>p==='..')) return res.status(400).end();
  const token = newPreviewToken(req.session?.userId || (req.user && req.user.id) || 'global');
  return res.redirect(302, `${PREVIEW_HTTP}/p/${token}/${encodeURI(rawFile)}`);
});


app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
