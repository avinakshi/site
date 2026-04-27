import { afterEach, describe, expect, it } from 'vitest';
import { createProblem } from '@csm-chat/shared';
import { buildHarness, type TestHarness } from './helpers.js';

describe('error handler (RFC 7807)', () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('returns problem+json with all fields for unknown routes (404)', async () => {
    harness = await buildHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body).toMatchObject({
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(body.requestId).toMatch(/^req_/);
    expect(body.timestamp).toBeTypeOf('string');
    expect(body.instance).toBe('/v1/does-not-exist');
    expect(body.type).toMatch(/\/errors\/not-found$/);
  });

  it('renders thrown ProblemError to RFC 7807', async () => {
    harness = await buildHarness();
    harness.app.get('/_test/throw-problem', async (req) => {
      throw createProblem('SESSION_CLOSED', {
        requestId: req.id,
        instance: req.url,
        detail: 'session has been closed',
      });
    });
    const res = await harness.app.inject({ method: 'GET', url: '/_test/throw-problem' });
    expect(res.statusCode).toBe(410);
    const body = res.json();
    expect(body.code).toBe('SESSION_CLOSED');
    expect(body.detail).toBe('session has been closed');
    expect(body.title).toBe('Session closed');
  });

  it('returns INTERNAL_ERROR on unexpected throws', async () => {
    harness = await buildHarness();
    harness.app.get('/_test/boom', async () => {
      throw new Error('kaboom');
    });
    const res = await harness.app.inject({ method: 'GET', url: '/_test/boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.detail).toBe('An internal error occurred.');
    expect(body.requestId).toMatch(/^req_/);
  });
});
