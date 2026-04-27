import { afterEach, describe, expect, it } from 'vitest';
import { buildHarness, type TestHarness } from './helpers.js';

describe('health routes', () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('GET /health returns 200 with uptime + version', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^req_/);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.version).toBe('test');
  });

  it('GET /health/ready returns 200 when DB is up', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
  });

  it('GET /health/ready returns 503 when DB is down', async () => {
    harness = await buildHarness();
    // Simulate DB down by closing the underlying pglite connection.
    if (harness.dbClient.driver === 'pglite') {
      await harness.dbClient.pglite.close();
    }
    const res = await harness.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe('fail');
  });
});
