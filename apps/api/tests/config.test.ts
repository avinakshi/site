import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config (loadConfig)', () => {
  it('applies development defaults when minimal env is provided', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(4000);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.JWT_ACCESS_SECRET).toContain('dev-only-');
    expect(cfg.DATABASE_URL).toMatch(/^file:/);
    expect(cfg.CORS_ORIGINS).toContain('http://localhost:3000');
  });

  it('rejects production env without secrets', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://x:y@h:5432/d',
      } as NodeJS.ProcessEnv),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('parses CORS_ORIGINS as a CSV → array', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      CORS_ORIGINS: 'https://a.example.com, https://b.example.com,https://c.example.com',
    } as NodeJS.ProcessEnv);
    expect(cfg.CORS_ORIGINS).toEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
  });

  it('coerces numeric env vars', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      PORT: '5050',
      DATABASE_POOL_MAX: '25',
    } as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(5050);
    expect(cfg.DATABASE_POOL_MAX).toBe(25);
  });
});
