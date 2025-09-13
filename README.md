# Gamecore

GameCore is an AI-powered, browser-based web creation platform built with Node.js and Express. It helps you go from a plain-English idea to a playable multi-file prototype, complete with an editor, file manager, preview server, and optional pygame builder, all in one app. Under the hood, GameCore orchestrates trusted LLMs (OpenAI and Anthropic), enforces strong security defaults (argon2, CSRF, strict path handling, rate limits), and smooths the last mile with utilities like CSS/JS/Python linting, image placeholder replacement, and shareable preview URLs

---

## What’s in this repository

```
server.js      # main Express app, APIs, preview server, auth, security, file I/O, AI orchestration
db.js          # postgreSQL connection and schema setup (sessions, users, resets, login audit)
public/
  index.html   # landing/“home” page for quick idea, prototype and generation options
  web.html     # full multi-file editor UI, file explorer, live preview panel, console
  ...          # auth pages (login/signup), profile, loading, suggestions, etc
generated/     # per-user working directory (created on demand)
```

### `server.js`

* **Express app + security hardening:** Helmet with CSP, optional COEP/COEP for WASM, strict CORS, and careful MIME handling for project assets. All mutating routes use CSRF tokens (`/api/csrf-token`) and several rate limiters tuned by route class
* **Auth & accounts:** Email/password with argon2id hashing, optional Google OAuth (Passport), and sessions stored in PostgreSQL via `connect-pg-simple`. We log failed logins and enforce a small brute-force ban window
* **Captcha & abuse controls:** reCAPTCHA verification (score-based) on signup/login, IP tracking with temporary bans, cautious error messaging to avoid info leaks
* **AI orchestration:** Endpoints like `/generate-idea`, `/generate-code`, `/continue-code`, `/edit-code` drive conversations with models (GPT-4.1/5, o3, Claude Sonnet/Opus). We cache short-lived image/code generations to cut latency and cost
* **Image placeholder pipeline:** We encourage models to emit `[IMAGE: description]` placeholders. The server finds those placeholders and generates images via OpenAI Images API, wiring the correct `src`/`url()` into HTML/CSS/JS. This keeps prompts clean and avoids brittle `<img>` markup from the model
* **Multiple build modes:** `html-only`, `html-js-css`, Flask (templates + static wiring and secret key placeholder), and Pygame (pygbag-compatible) are supported. The APK builder wraps pygbag output for distribution
* **File system safety:** A `safeJoin` helper rejects absolute paths, NUL bytes, sneaky `..`, and escapes user input before touching disk. Uploads are constrained (type/size/count) and written under each user’s isolated `generated/<userId>` tree
* **Linting & checks:** CSS is validated via csslint, JS uses ESLint, Python files are byte-compiled (`py_compile`) to catch syntax issues. We return error arrays so the UI can surface actionable feedback
* **Live progress:** `/progress` is an SSE stream that updates the UI progress bar while generation or edits are in flight
* **Preview server:** A separate, locked-down Express instance listens on `127.0.0.1:4000`. We mint short-lived tokens (10-minute TTL) and serve project files under a tokenised path (`/p/<token>/...`) with an injected `<base>` tag so relative links work. The main API remains off-limits from the preview origin

### Frontend

#### `public/index.html` – Quick start hub

A polished landing page where you can:

* Draft or auto-generate a **game idea**
* Pick a **model**, **script mode**, **image strategy**, and **HTML layout** (single or multiple pages)
* Upload reference files to steer generation
* See an **estimated wait time** and a **live summary** of your options
* Click **Generate** to start a full build, or **Play** for a one-page quick prototype

It uses Choices.js for elegant selects, a responsive split layout, and a sleek preview card. We’ve invested in usability, inputs feel snappy, and the UI leans on a clean Inter + normalize baseline with “glass” surfaces and subtle depth

#### `public/web.html` – The multi-file editor

Your production-ready workspace:

* **File explorer** (create/move/duplicate/delete) bound to safe server endpoints
* **Code editor area** with a bottom control bar that is always visible so essential actions never scroll away.
* **Live preview panel** that isolates user code and supports fullscreen
* A **console** area for info/warn/error logs
* A compact **mode menu** and **settings popups** for editor theme, fonts, and performance toggles (e.g., disabling heavy backdrop filters on low-power devices)

Other public pages (`login.html`, `signup.html`, `profile.html`, `loading.html`, `suggestions.html`) back the auth/profile flows

---

## How the AI pipeline works

1. **Prompt shaping**: Based on your selections, the server builds a deterministic, guard-railed prompt (e.g., file naming rules for multi-page HTML, Flask template layout, or Pygame requirements)
2. **Generation**: The model returns code blocks. We parse out HTML/CSS/JS/Python and any additional HTML files (e.g., `page1.html`, `page2.html`), respecting your chosen mode
3. **Post-processing**: We scan for the `[IMAGE: ...]` placeholder and resolve them to real assets, rewrite references, and write files to your per-user project directory
4. **Validation**: Linting/compile checks run, any issues are surfaced in the response. You can edit with precise, structured edit prompts (we use file-scoped OLD/NEW blocks to ensure surgical diffs)
5. **Preview & share**: Generate a short-lived preview URL from the editor to share your build, the preview server enforces token and origin rules

---

## Security choices (and why we chose them)

* **Separate preview origin**: We opted for a second Express server and tokenised paths so user-generated code never gets API cookies or CSRF context. It’s more work than a single app, but it sharply reduces risk
* **CSP with limited `unsafe-inline`**: We keep inline allowances narrow and only where necessary for third-party widgets and the editor. For projects using WASM (e.g., pygbag), we made COEP/COEP togglable via env so you can enable cross-origin isolation when needed
* **Strict path handling**: Instead of trusting user paths, `safeJoin` and `multer` sanitisation block traversal and unexpected binaries. We also force explicit MIME types for downloads to prevent content sniffing
* **Short-lived previews**: Ten-minute TTLs and in-memory token maps keep previews ephemeral by default, you can regenerate at will.
* **Brute-force guardrails**: IP fail tracking and reCAPTCHA gate the auth routes. Errors are intentionally generic to avoid account enumeration

---

## Requirements & setup

* **Node.js** 22+
* **PostgreSQL**
* API keys: **OpenAI** and/or **Anthropic**
* **Google reCAPTCHA** site & secret keys
* **Google OAuth** client ID/secret

Install and run:


**Install Dependancies:**
```bash
npm install
```

**Run App:**
```bash
npm start
# app on http://localhost:3000, preview on http://127.0.0.1:4000
```


Environment variables (selected):

| Name                                                       | Purpose                               |
| ---------------------------------------------------------- | ------------------------------------- |
| `DATABASE_URL`                                             | Postgres connection string            |
| `SESSION_SECRET`                                           | Session cookie signing                |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`                     | Model access                          |
| `RECAPTCHA_SITE_KEY` / `RECAPTCHA_SECRET_KEY`              | Abuse prevention                      |
| `ENABLE_OAUTH`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google login                          |
| `ENABLE_COEP`                                              | Enable cross-origin isolation headers |
| `NODE_ENV=production`                                      | Secure cookies & stricter defaults    |

---

## API overview (high level)

* **Auth**: `POST /api/signup`, `/api/login`, `/api/logout`, `/api/request-password-reset`, `/api/reset-password`, OAuth at `/auth/google`.
* **Profile**: `GET/POST /api/profile`
* **Generation**: `POST /generate-idea`, `/generate-code`, `/continue-code`, `/edit-code`
* **Files**: `GET /files`, `POST /save-file`, `/create-directory`, `/delete-file`, `/move-file`, `/duplicate-path`
* **Previews/APK**: `POST /api/preview-url`, `GET /preview`, `POST /create-apk`
* **Utilities**: `GET /api/csrf-token`, `GET /progress`

---

## what’s next

GameCore aims to be delightfully practical, it lets you stay in the browser, iterate quickly, and still ship something you can share or even sideload to a device. The guardrails are there so creativity doesn’t compromise safety. Next steps we’re excited about: deeper test scaffolding, pluggable renderers (Phaser/Three.js templates), richer diffs, and multi-user co-editing.

Build boldly, and have fun.
