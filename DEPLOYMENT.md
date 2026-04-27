# Deployment

Phase 1 ships to two platforms:

- **Railway** — runs the Fastify API + Postgres add-on
- **Vercel** — runs the Next.js web app (CSM dashboard + client chat)

The same Drizzle code in `packages/db` powers both PGlite (local) and real Postgres (prod) — see [README.md → Database](./README.md#database).

---

## Railway (API)

Railway is already connected to this GitHub repo. To bring up the API:

### 1. Create the Postgres plugin

In your Railway project → **+ New** → **Database** → **Add PostgreSQL**.
Railway provisions a managed instance and exposes `DATABASE_URL` as an environment variable on every service in the project (via shared variables / `${{Postgres.DATABASE_URL}}`).

### 2. Create the API service

**+ New** → **GitHub Repo** → pick this repo. Railway will detect `railway.json` at the root, which points at `apps/api/Dockerfile` for the build. The `Dockerfile` is multi-stage (Node 20.18 + pnpm 9.15) and runs as non-root.

### 3. Set environment variables

In the API service → **Variables**. Reference Railway's shared Postgres var with `${{Postgres.DATABASE_URL}}`:

| Variable                        | Value                                        | Notes                                                |
| ------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `NODE_ENV`                      | `production`                                 | Strict secret validation kicks in here               |
| `PORT`                          | _(auto)_                                     | Railway injects this — Fastify already reads it      |
| `LOG_LEVEL`                     | `info`                                       |                                                      |
| `APP_BASE_URL`                  | `https://your-vercel-domain.vercel.app`      | Used for `chatUrl` generation in `POST /v1/sessions` |
| `API_BASE_URL`                  | `https://your-railway-domain.up.railway.app` | Used in RFC 7807 `type` URIs                         |
| `DATABASE_URL`                  | `${{Postgres.DATABASE_URL}}`                 | Reference Railway's Postgres                         |
| `DATABASE_POOL_MAX`             | `10`                                         |                                                      |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | `30000`                                      |                                                      |
| `JWT_ACCESS_SECRET`             | _32+ char random_                            | Generate with `openssl rand -base64 32`              |
| `JWT_ACCESS_TTL_SEC`            | `900`                                        |                                                      |
| `JWT_REFRESH_TTL_DAYS`          | `30`                                         |                                                      |
| `SESSION_TOKEN_SECRET`          | _32+ char random_                            | Used for `chat URL` JWTs (sub=sessionId)             |
| `SESSION_JWT_SECRET`            | _32+ char random_                            | Used for short-lived chat session JWTs               |
| `SESSION_JWT_TTL_SEC`           | `3600`                                       |                                                      |
| `COOKIE_SECURE`                 | `true`                                       |                                                      |
| `COOKIE_SAMESITE`               | `lax`                                        |                                                      |
| `COOKIE_DOMAIN`                 | _(empty unless you have a shared apex)_      |                                                      |
| `CORS_ORIGINS`                  | `https://your-vercel-domain.vercel.app`      | Comma-separated if multiple                          |
| `WS_PING_INTERVAL_MS`           | `25000`                                      |                                                      |
| `WS_PING_TIMEOUT_MS`            | `60000`                                      |                                                      |
| `SENTRY_DSN_API`                | _(optional)_                                 | If set, errors are captured                          |
| `SENTRY_ENVIRONMENT`            | `production`                                 |                                                      |

> **Three secrets, three values.** `JWT_ACCESS_SECRET`, `SESSION_TOKEN_SECRET`, and `SESSION_JWT_SECRET` are intentionally distinct so a token leak in one domain (CSM access) doesn't compromise the others (chat URL / chat session).

### 4. Apply migrations on first deploy

Open the Railway service shell (or `railway run`):

```bash
pnpm --filter @csm-chat/db db:migrate
pnpm --filter @csm-chat/db db:seed   # creates admin@example.com — see banner
```

> **The seed prints credentials. Change the password through `PATCH /v1/users/:id` immediately after seeding, before opening the dashboard.**

### 5. Health checks

`railway.json` already configures `healthcheckPath: /health/ready`. Railway will roll back automatically if it starts failing.

---

## Vercel (web)

### 1. Import the repo on Vercel

**+ Add New → Project →** select this repo. In the import wizard:

- **Root Directory** → `apps/web`
- Vercel will detect Next.js + the workspace `vercel.json` → `buildCommand` is wired to `pnpm install --frozen-lockfile && pnpm --filter @csm-chat/web build` from the repo root.

### 2. Set environment variables

| Variable                 | Value                                        |
| ------------------------ | -------------------------------------------- |
| `NEXT_PUBLIC_API_URL`    | `https://your-railway-domain.up.railway.app` |
| `NEXT_PUBLIC_WS_URL`     | `wss://your-railway-domain.up.railway.app`   |
| `NEXT_PUBLIC_SENTRY_DSN` | _(optional)_                                 |

> `NEXT_PUBLIC_*` vars are baked into the JS bundle at build time — change them and trigger a redeploy.

### 3. Update CORS on Railway

Once Vercel gives you a domain, set `CORS_ORIGINS` on Railway to it (and any preview / staging domains, comma-separated). The cookie path scope (`/v1/auth`) and SameSite=Lax means the browser will only attach `csm_refresh` to API requests under `/v1/auth/*`, which is what we want.

---

## Smoke test after deploy

Once both services are live:

```bash
API_URL=https://your-railway-domain.up.railway.app \
ADMIN_EMAIL=admin@example.com \
SEED_PASSWORD='Admin123!@#456' \
  ./scripts/smoke.sh
```

The script asserts: `/health` 200, `/health/ready` 200, `/v1/auth/login` returns an access token, `/v1/auth/me` works with that token, `/v1/sessions` creates a session and returns a `chatUrl`, `/v1/chat/verify` accepts the URL token. Exits non-zero on any failure.

---

## Rotation: cookies, secrets, and the seed admin

- **JWT secrets**: rotate by setting a new `*_SECRET` value on Railway and redeploying. All in-flight access tokens become invalid; CSMs need to log in again. Refresh tokens are unaffected (they're opaque random + sha256 hashed, not JWTs).
- **Refresh tokens** are revoked individually via `POST /v1/auth/logout` or by setting `revoked_at` on the row. There's no "revoke all for user" endpoint yet — add one if you need it.
- **Seed admin password** must be changed immediately after first deploy (`PATCH /v1/users/:id`).

---

## Phase 2

`PHASE2_AI_DESIGN.md` is locked. When you're ready to start it (after Phase 1 has run real conversations for at least 2 weeks), set the Phase-2 secrets on Railway:

- `GEMINI_API_KEY`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`

These are intentionally absent from `apps/api/src/config.ts`'s Zod schema today — adding them is part of Phase 2's first migration.
