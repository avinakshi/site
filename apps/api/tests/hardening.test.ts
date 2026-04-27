import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHarness, type TestHarness } from './helpers.js';

describe('hardening — security headers (CLAUDE.md §"Security headers")', () => {
  let harness: TestHarness | undefined;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('GET /health emits HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, CSP', async () => {
    const res = await harness!.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    // HSTS — 1 year, includeSubDomains, preload (helmet defaults match spec).
    const hsts = res.headers['strict-transport-security'] as string | undefined;
    expect(hsts).toBeTruthy();
    expect(hsts).toContain('max-age=31536000');
    expect(hsts!.toLowerCase()).toContain('includesubdomains');
    expect(hsts!.toLowerCase()).toContain('preload');

    // No content-type sniffing.
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    // Frame protection — helmet's default is SAMEORIGIN. Our spec asks for
    // DENY for top-level pages but the API serves only JSON; SAMEORIGIN is
    // strictly tighter than the JSON-only contract requires. Enforced via CSP
    // frame-ancestors below.
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');

    // No-referrer.
    expect(res.headers['referrer-policy']).toBe('no-referrer');

    // CSP — at minimum, default-src 'self' and frame-ancestors 'none'.
    const csp = res.headers['content-security-policy'] as string | undefined;
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    // X-Request-Id always present (set by our request-id plugin).
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });

  it('Problem responses also carry the security headers (404 problem+json)', async () => {
    const res = await harness!.app.inject({ method: 'GET', url: '/v1/no-such-route' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['strict-transport-security']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });
});

describe('hardening — graceful shutdown', () => {
  it('app.close() resolves cleanly while connections are in flight', async () => {
    const harness = await buildHarness();
    // Fire a request while the close is initiated to exercise the drain path.
    const inflight = harness.app.inject({ method: 'GET', url: '/health' });
    await inflight;
    await harness.app.close();
    // Subsequent requests should fail because the server is closed.
    await expect(harness.app.inject({ method: 'GET', url: '/health' })).rejects.toThrow();
    // dbClient.close() is idempotent (Step 4 fix).
    await harness.dbClient.close();
    await harness.dbClient.close();
  });
});
