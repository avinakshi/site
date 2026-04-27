import * as Sentry from '@sentry/node';

let initialized = false;

export interface SentryInitOptions {
  dsn?: string;
  environment: string;
  release?: string;
}

export function initSentry(opts: SentryInitOptions): typeof Sentry | null {
  if (initialized || !opts.dsn) return initialized ? Sentry : null;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    release: opts.release,
    // Phase 1: errors only — no traces, no profiling.
    tracesSampleRate: 0,
  });
  initialized = true;
  return Sentry;
}

export function getSentry(): typeof Sentry | null {
  return initialized ? Sentry : null;
}
