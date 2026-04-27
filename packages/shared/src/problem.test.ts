import { describe, expect, it } from 'vitest';
import { createProblem, problemSchema } from './problem.js';

describe('createProblem', () => {
  it('produces a valid RFC 7807 body for a known code', () => {
    const err = createProblem('TOKEN_EXPIRED', {
      requestId: 'req_01HX2K3M4N5P6Q7R8S9T',
      instance: '/v1/chat/verify',
      detail: 'The session token has expired.',
    });
    const body = err.toJSON();
    expect(body).toMatchObject({
      title: 'Token expired',
      status: 401,
      detail: 'The session token has expired.',
      instance: '/v1/chat/verify',
      code: 'TOKEN_EXPIRED',
      requestId: 'req_01HX2K3M4N5P6Q7R8S9T',
    });
    expect(body.type).toMatch(/\/errors\/token-expired$/);
    expect(problemSchema.safeParse(body).success).toBe(true);
  });

  it('omits optional fields cleanly', () => {
    const err = createProblem('INTERNAL_ERROR', { requestId: 'req_x' });
    const body = err.toJSON();
    expect(body).not.toHaveProperty('detail');
    expect(body).not.toHaveProperty('instance');
    expect(body).not.toHaveProperty('errors');
    expect(body.status).toBe(500);
    expect(problemSchema.safeParse(body).success).toBe(true);
  });

  it('serializes field-level validation errors when present', () => {
    const err = createProblem('VALIDATION_ERROR', {
      requestId: 'req_y',
      errors: [
        { field: 'email', message: 'Invalid email' },
        { field: 'password', message: 'Too short' },
      ],
    });
    const body = err.toJSON();
    expect(body.errors).toEqual([
      { field: 'email', message: 'Invalid email' },
      { field: 'password', message: 'Too short' },
    ]);
    expect(body.status).toBe(400);
    expect(problemSchema.safeParse(body).success).toBe(true);
  });

  it('honours an explicit baseUrl', () => {
    const err = createProblem('NOT_FOUND', {
      requestId: 'req_z',
      baseUrl: 'https://api.csm.example.com/',
    });
    const body = err.toJSON();
    expect(body.type).toBe('https://api.csm.example.com/errors/not-found');
  });

  it('throws and catches as a normal Error', () => {
    expect(() => {
      throw createProblem('FORBIDDEN', { requestId: 'req_q' });
    }).toThrow('Forbidden');
  });
});
