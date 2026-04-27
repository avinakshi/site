import { z } from 'zod';

// GET /health
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptime: z.number().nonnegative(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// GET /health/ready  (200 → ok, 503 → degraded)
export const readyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.enum(['ok', 'fail'])),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
