import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

// Order: monorepo root .env, then apps/api/.env override.
loadDotenv({ path: resolve(repoRoot, '.env') });
loadDotenv({ path: resolve(here, '..', '.env'), override: true });

/**
 * Build the env schema with production/development gating. Built per
 * call (not at module load) so tests can pass different NODE_ENV values
 * to `loadConfig`.
 */
function makeConfigSchema(isProd: boolean) {
  const secret = (label: string) => {
    if (isProd) {
      return z.string().min(32, `${label} must be ≥32 chars in production`);
    }
    const devValue =
      `dev-only-${label.toLowerCase().replace(/_/g, '-')}-DO-NOT-USE-IN-PROD-${'x'.repeat(20)}`.slice(
        0,
        64,
      );
    return z.string().min(32).default(devValue);
  };

  const csv = z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

  return z.object({
    // ── Core ────────────────────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    APP_BASE_URL: z.string().url().default('http://localhost:3000'),
    API_BASE_URL: z.string().url().default('http://localhost:4000'),

    // ── Database ────────────────────────────────────────────────────
    DATABASE_URL: isProd
      ? z.string().min(1)
      : z
          .string()
          .min(1)
          .default(`file:${resolve(repoRoot, '.local-data', 'dev-db')}`),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    DATABASE_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),

    // ── JWT secrets ─────────────────────────────────────────────────
    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
    SESSION_TOKEN_SECRET: secret('SESSION_TOKEN_SECRET'),
    SESSION_JWT_SECRET: secret('SESSION_JWT_SECRET'),
    SESSION_JWT_TTL_SEC: z.coerce.number().int().positive().default(3600),

    // ── Cookies ─────────────────────────────────────────────────────
    COOKIE_SECURE: z.coerce.boolean().default(isProd),
    COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('lax'),
    COOKIE_DOMAIN: z.string().optional(),

    // ── CORS ────────────────────────────────────────────────────────
    CORS_ORIGINS: csv.default(isProd ? '' : 'http://localhost:3000,http://localhost:4000'),

    // ── Observability ───────────────────────────────────────────────
    SENTRY_DSN_API: z
      .string()
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    SENTRY_ENVIRONMENT: z.string().default(isProd ? 'production' : 'development'),

    // ── WebSocket ───────────────────────────────────────────────────
    WS_PING_INTERVAL_MS: z.coerce.number().int().positive().default(25_000),
    WS_PING_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  });
}

export type Config = z.infer<ReturnType<typeof makeConfigSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProd = (env.NODE_ENV ?? 'development') === 'production';
  const schema = makeConfigSchema(isProd);
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const formatted = parsed.error.errors
      .map((e) => `  • ${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  return parsed.data;
}
