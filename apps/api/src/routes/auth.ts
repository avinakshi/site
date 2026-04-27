import type { FastifyPluginAsync } from 'fastify';
import {
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
  refreshResponseSchema,
  type LoginRequest,
} from '@csm-chat/shared';
import type { AuthService } from '../services/auth.service.js';
import type { Config } from '../config.js';

export const REFRESH_COOKIE = 'csm_refresh';

export interface AuthRoutesOptions {
  authService: AuthService;
  config: Config;
}

const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, opts) => {
  const { authService, config } = opts;
  const refreshTtlSec = config.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60;

  const cookieOptions = {
    path: '/v1/auth',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    maxAge: refreshTtlSec,
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
  } as const;

  // ── POST /v1/auth/login ────────────────────────────────────────────
  app.post(
    '/v1/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: {
        body: loginRequestSchema,
        response: { 200: loginResponseSchema },
      },
    },
    async (req, reply) => {
      const body = req.body as LoginRequest;
      const result = await authService.login(body, {
        requestId: req.id,
        instance: req.url,
        userAgent: req.headers['user-agent'] ?? undefined,
        ipAddress: req.ip,
      });
      reply.setCookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
      return {
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        user: result.user,
      };
    },
  );

  // ── POST /v1/auth/refresh ──────────────────────────────────────────
  app.post(
    '/v1/auth/refresh',
    {
      schema: { response: { 200: refreshResponseSchema } },
    },
    async (req, reply) => {
      const refreshToken = req.cookies[REFRESH_COOKIE] ?? '';
      const result = await authService.refresh(refreshToken, {
        requestId: req.id,
        instance: req.url,
        userAgent: req.headers['user-agent'] ?? undefined,
        ipAddress: req.ip,
      });
      reply.setCookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
      return { accessToken: result.accessToken, expiresIn: result.expiresIn };
    },
  );

  // ── POST /v1/auth/logout ───────────────────────────────────────────
  app.post('/v1/auth/logout', async (req, reply) => {
    const refreshToken = req.cookies[REFRESH_COOKIE] ?? '';
    await authService.logout(refreshToken, { requestId: req.id, instance: req.url });
    reply.clearCookie(REFRESH_COOKIE, cookieOptions);
    reply.status(204);
    return null;
  });

  // ── GET /v1/auth/me ────────────────────────────────────────────────
  app.get(
    '/v1/auth/me',
    {
      preHandler: app.verifyAuth,
      schema: { response: { 200: meResponseSchema } },
    },
    async (req) => {
      if (!req.user) throw new Error('preHandler did not set req.user');
      return authService.me(req.user.id, { requestId: req.id, instance: req.url });
    },
  );
};

export default authRoutes;
