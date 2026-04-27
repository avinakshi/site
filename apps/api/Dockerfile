# ──────────────────────────────────────────────────────────────────────
# Multi-stage build for the Fastify API in this pnpm workspace.
# Builds from the repo root so workspace deps (@csm-chat/db,
# @csm-chat/shared) resolve correctly.
#
# Build context: repo root
#   docker build -t csm-chat-api -f apps/api/Dockerfile .
#
# Railway: set the service's Dockerfile path to `apps/api/Dockerfile`
# and Build context to the repo root.
# ──────────────────────────────────────────────────────────────────────

FROM node:20.18.0-bookworm-slim AS base
# COREPACK_INTEGRITY_KEYS="" disables corepack's outdated signing-key
# verification (Node 20.18.0 ships with stale keys that reject pnpm 9.15
# signatures). Upgrading corepack to latest is the long-term fix; we do
# both so the install never blocks on signature mismatch.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    HUSKY=0 \
    COREPACK_INTEGRITY_KEYS=""
RUN npm install -g corepack@latest && \
    corepack enable && \
    corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── deps ─────────────────────────────────────────────────────────────
# Install with frozen lockfile so the deploy is byte-identical to the
# committed pnpm-lock.yaml. Allow bcrypt + esbuild postinstall scripts
# (already in pnpm.onlyBuiltDependencies).
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @csm-chat/api...

# ── runtime ──────────────────────────────────────────────────────────
FROM base AS runner
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

COPY tsconfig.base.json package.json pnpm-workspace.yaml turbo.json ./
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Run as non-root. --create-home ensures /home/nodeapp exists so
# corepack can write its cache there at runtime (it pulls package
# managers on first invocation under that path).
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --create-home --home-dir /home/nodeapp nodeapp && \
    chown -R nodeapp:nodejs /app /home/nodeapp
USER nodeapp

# Pre-warm corepack as nodeapp so the cache is populated before the
# pre-deploy/start commands run. Avoids first-run permission/IO issues.
ENV COREPACK_HOME=/home/nodeapp/.cache/node/corepack
RUN mkdir -p /home/nodeapp/.cache/node/corepack && \
    corepack prepare pnpm@9.15.0 --activate

EXPOSE 4000

# NODE_ENV is intentionally NOT set in earlier stages so pnpm installs
# devDependencies (tsx, drizzle-kit) — needed for db:migrate at predeploy
# and tsx-runtime for the API itself. The actual runtime config is
# production-mode via the env var injected by Railway.
ENV NODE_ENV=production

# Railway / Fly / etc. typically pass PORT — config.ts already coerces it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health/ready', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["pnpm", "--filter", "@csm-chat/api", "start"]
