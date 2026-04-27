# csm-chat

AI-Assisted Customer Success Chat — Phase 1 MVP.

CSMs send unique chat links to clients via email. Clients click the link, land on a real-time web chat with their CSM. All conversations are persisted. CSMs manage active chats from a dashboard.

Phase 2 (AI fallback via Gemini, WhatsApp escalation) is locked in [`PHASE2_AI_DESIGN.md`](./PHASE2_AI_DESIGN.md) and is **out of scope during Phase 1**.

## Stack

| Layer      | Choice                                                      |
| ---------- | ----------------------------------------------------------- |
| Frontend   | Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui |
| Backend    | Fastify 4 + TypeScript + Node.js 20 LTS                     |
| Real-time  | Socket.IO 4 (single instance)                               |
| Database   | PostgreSQL 15 (Supabase, India region)                      |
| ORM        | Drizzle + drizzle-kit                                       |
| Validation | Zod                                                         |
| Auth       | bcrypt + JWT (jose)                                         |
| Logging    | Pino (JSON)                                                 |
| Errors     | Sentry                                                      |
| Hosting    | Railway (API), Vercel (web)                                 |
| Monorepo   | pnpm workspace + Turborepo                                  |

## Layout

```
apps/
  web/        Next.js frontend (initialized in Step 10)
  api/        Fastify backend (initialized in Step 4)
packages/
  db/         Drizzle schema + migrations (Step 2)
  shared/     Zod schemas, types, error codes (Step 3)
```

## Prerequisites

- Node.js **20.18.0** — `nvm use` (uses `.nvmrc`)
- pnpm **9.15.0** — `corepack enable && corepack prepare pnpm@9.15.0 --activate`

> **No Docker required.** Local development uses [PGlite](https://github.com/electric-sql/pglite) — an embedded Postgres in WASM that runs in-process. Data persists to `.local-data/` (gitignored). Production uses real Postgres (Supabase/Railway) via the same Drizzle code path; the driver is auto-selected from `DATABASE_URL` (`file:` → PGlite, `postgres:` → node-postgres).
>
> A `docker-compose.yml` is included for anyone who prefers a real local Postgres — it's optional.

## Setup

```bash
pnpm install            # workspaces + native bcrypt build
pnpm db:migrate         # creates .local-data/dev-db, applies migrations
pnpm db:seed            # admin@example.com + csm1/csm2 (password printed)
pnpm dev                # runs all apps in dev mode
```

## Scripts

| Command             | What it does                                               |
| ------------------- | ---------------------------------------------------------- |
| `pnpm dev`          | Run all apps in dev mode (Turborepo)                       |
| `pnpm build`        | Build all apps and packages                                |
| `pnpm lint`         | Lint all workspaces                                        |
| `pnpm typecheck`    | TypeScript strict check across workspaces                  |
| `pnpm test`         | Run all tests                                              |
| `pnpm format`       | Auto-format with Prettier                                  |
| `pnpm format:check` | Check formatting (used in CI)                              |
| `pnpm db:generate`  | Diff schema → emit a new migration                         |
| `pnpm db:migrate`   | Apply migrations (PGlite locally, postgres:// in prod)     |
| `pnpm db:seed`      | Insert seed admin + CSMs (idempotent)                      |
| `pnpm db:verify`    | End-to-end schema check in a throwaway PGlite (used in CI) |
| `pnpm db:studio`    | Open Drizzle Studio against `DATABASE_URL`                 |

## Database

The same code path serves both local and production:

| Environment  | `DATABASE_URL`                                      | Driver        |
| ------------ | --------------------------------------------------- | ------------- |
| Local dev    | _(unset — defaults to)_ `file:./.local-data/dev-db` | PGlite (WASM) |
| Local dev    | `file:./path/to/dir`                                | PGlite        |
| Tests / CI   | `pglite:memory` _or any temp dir_                   | PGlite        |
| Staging/Prod | `postgres://user:pass@host:5432/db`                 | node-postgres |

## Build instructions

The Phase 1 build plan lives in [`CLAUDE.md`](./CLAUDE.md). It is broken into 14 sequential steps, each with a stop point. Do not run them in one shot.

`PHASE2_AI_DESIGN.md` is the locked Phase 2 design. **Do not implement during Phase 1.**

## Conventions

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(api): add session creation endpoint`
- `fix(web): handle expired token on chat verify`
- `chore(db): add session_devices table`
- `test(api): add auth integration tests`

## License

Private / All rights reserved.
