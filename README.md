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

- Node.js **20.18.0** — pin via `nvm use` (uses `.nvmrc`)
- pnpm **9.15.0** — `corepack enable && corepack prepare pnpm@9.15.0 --activate`
- Docker (for local PostgreSQL via `docker-compose`, set up in Step 2)

## Setup

```bash
# Install dependencies (root + all workspaces)
pnpm install

# Copy env template
cp .env.example .env
# Then fill in secrets — see CLAUDE.md §"ENVIRONMENT VARIABLES"

# Run all dev servers (Turborepo)
pnpm dev
```

## Scripts

| Command             | What it does                              |
| ------------------- | ----------------------------------------- |
| `pnpm dev`          | Run all apps in dev mode                  |
| `pnpm build`        | Build all apps and packages               |
| `pnpm lint`         | Lint all workspaces                       |
| `pnpm typecheck`    | TypeScript strict check across workspaces |
| `pnpm test`         | Run all tests                             |
| `pnpm format`       | Auto-format with Prettier                 |
| `pnpm format:check` | Check formatting (used in CI)             |

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
