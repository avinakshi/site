import { describe, expect, it } from 'vitest';
import {
  emailSchema,
  paginationQuerySchema,
  messagesPaginationQuerySchema,
  paginated,
  uuidSchema,
} from './primitives.js';
import { z } from 'zod';

describe('emailSchema', () => {
  it('lowercases and trims valid emails', () => {
    expect(emailSchema.parse('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });

  it('rejects malformed emails', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('accepts a v4 uuid', () => {
    expect(uuidSchema.parse('e3b0c442-98fc-4a55-8e3a-d2c5d1ad9af0')).toBeTruthy();
  });

  it('rejects non-uuid strings', () => {
    expect(uuidSchema.safeParse('hello').success).toBe(false);
  });
});

describe('paginationQuerySchema', () => {
  it('coerces strings → numbers and applies defaults', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(paginationQuerySchema.parse({ page: '3', limit: '50' })).toEqual({
      page: 3,
      limit: 50,
    });
  });

  it('rejects limit > 100', () => {
    expect(paginationQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('rejects page < 1', () => {
    expect(paginationQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});

describe('messagesPaginationQuerySchema', () => {
  it('allows up to 200', () => {
    expect(messagesPaginationQuerySchema.parse({ limit: '200' }).limit).toBe(200);
  });

  it('rejects > 200', () => {
    expect(messagesPaginationQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  });
});

describe('paginated', () => {
  it('accepts a well-formed paginated body', () => {
    const schema = paginated(z.object({ id: uuidSchema }));
    const ok = schema.safeParse({
      items: [{ id: 'e3b0c442-98fc-4a55-8e3a-d2c5d1ad9af0' }],
      page: 1,
      limit: 20,
      total: 1,
      hasMore: false,
    });
    expect(ok.success).toBe(true);
  });
});
