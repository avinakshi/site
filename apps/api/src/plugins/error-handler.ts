import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { ProblemError, createProblem, ERROR_CODES } from '@csm-chat/shared';
import { getSentry } from '../lib/sentry.js';

interface ErrorHandlerOptions {
  baseUrl: string;
}

const PROBLEM_CONTENT_TYPE = 'application/problem+json';

interface FastifyValidationItem {
  instancePath?: string;
  schemaPath?: string;
  keyword?: string;
  params?: Record<string, unknown>;
  message?: string;
}

function isFastifyValidationError(
  err: unknown,
): err is { validation: FastifyValidationItem[]; validationContext?: string; message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'validation' in err &&
    Array.isArray((err as { validation: unknown }).validation)
  );
}

const errorHandler: FastifyPluginAsync<ErrorHandlerOptions> = async (app, opts) => {
  const baseUrl = opts.baseUrl;

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    const instance = req.url;

    // 1. Already a ProblemError — pass through.
    if (err instanceof ProblemError) {
      reply.status(err.status).header('content-type', PROBLEM_CONTENT_TYPE).send(err.toJSON());
      return;
    }

    // 2. Fastify validation error (raised by fastify-type-provider-zod).
    if (isFastifyValidationError(err)) {
      const problem = createProblem('VALIDATION_ERROR', {
        requestId,
        instance,
        baseUrl,
        detail: 'Request failed validation.',
        errors: err.validation.map((v) => ({
          field: v.instancePath || v.schemaPath || '(root)',
          message: v.message ?? 'Invalid value',
        })),
      });
      reply
        .status(problem.status)
        .header('content-type', PROBLEM_CONTENT_TYPE)
        .send(problem.toJSON());
      return;
    }

    // 3. Bare ZodError (from manual parsing in service code).
    if (err instanceof ZodError) {
      const problem = createProblem('VALIDATION_ERROR', {
        requestId,
        instance,
        baseUrl,
        detail: 'Request failed validation.',
        errors: err.errors.map((e) => ({
          field: e.path.join('.') || '(root)',
          message: e.message,
        })),
      });
      reply
        .status(problem.status)
        .header('content-type', PROBLEM_CONTENT_TYPE)
        .send(problem.toJSON());
      return;
    }

    // 4. Fastify-tagged errors with a statusCode (rate limit, etc.).
    const statusCode = err.statusCode ?? 500;

    if (statusCode === 429) {
      const problem = createProblem('RATE_LIMITED', {
        requestId,
        instance,
        baseUrl,
        detail: err.message || 'Too many requests.',
      });
      reply
        .status(429)
        .header('content-type', PROBLEM_CONTENT_TYPE)
        .header('retry-after', '60')
        .send(problem.toJSON());
      return;
    }

    if (statusCode === 404) {
      const problem = createProblem('NOT_FOUND', { requestId, instance, baseUrl });
      reply.status(404).header('content-type', PROBLEM_CONTENT_TYPE).send(problem.toJSON());
      return;
    }

    if (statusCode >= 400 && statusCode < 500) {
      const problem = createProblem(
        statusCode === 401 ? ERROR_CODES.UNAUTHENTICATED : ERROR_CODES.MALFORMED_REQUEST,
        {
          requestId,
          instance,
          baseUrl,
          detail: err.message,
          status: statusCode,
        },
      );
      reply.status(statusCode).header('content-type', PROBLEM_CONTENT_TYPE).send(problem.toJSON());
      return;
    }

    // 5. 5xx — log + Sentry capture, return generic shape.
    req.log.error({ err, requestId }, 'unhandled-error');
    getSentry()?.withScope((scope) => {
      scope.setTag('requestId', requestId);
      scope.setExtra('url', req.url);
      scope.setExtra('method', req.method);
      getSentry()?.captureException(err);
    });

    const problem = createProblem('INTERNAL_ERROR', {
      requestId,
      instance,
      baseUrl,
      detail: 'An internal error occurred.',
    });
    reply
      .status(problem.status)
      .header('content-type', PROBLEM_CONTENT_TYPE)
      .send(problem.toJSON());
  });

  // 404 handler — Fastify's default doesn't go through setErrorHandler.
  app.setNotFoundHandler((req, reply) => {
    const problem = createProblem('NOT_FOUND', {
      requestId: req.id,
      instance: req.url,
      baseUrl,
      detail: `Route ${req.method} ${req.url} not found.`,
    });
    reply
      .status(problem.status)
      .header('content-type', PROBLEM_CONTENT_TYPE)
      .send(problem.toJSON());
  });
};

export default fp(errorHandler, { name: 'error-handler' });
