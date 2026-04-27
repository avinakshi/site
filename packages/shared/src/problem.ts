import { z } from 'zod';
import { ERROR_CODES, ERROR_STATUS, ERROR_TITLE, type ErrorCode } from './error-codes.js';

/**
 * RFC 7807 Problem Details body. Served as `application/problem+json`
 * for every error response. See CLAUDE.md §"ERROR RESPONSE FORMAT".
 */
export const problemSchema = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  requestId: z.string(),
  timestamp: z.string().datetime(),
  errors: z
    .array(
      z.object({
        field: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export interface FieldError {
  field: string;
  message: string;
}

export interface CreateProblemOptions {
  /** ULID generated per request. */
  requestId: string;
  /** Request path, e.g. `/v1/chat/verify`. */
  instance?: string;
  /** Free-text explanation. Falls back to ERROR_TITLE[code]. */
  detail?: string;
  /** Field-level validation errors. */
  errors?: FieldError[];
  /** Override the default title. */
  title?: string;
  /** Override the default HTTP status. Rarely needed. */
  status?: number;
  /** Where Problem `type` URIs live. Defaults to relative URI by code. */
  baseUrl?: string;
  /** ISO timestamp. Defaults to `new Date().toISOString()`. */
  timestamp?: string;
}

/**
 * Helper class for constructing RFC 7807 problem responses. Throw an
 * instance from any service or route; the global error handler unwraps
 * it into the wire format.
 */
export class ProblemError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly requestId: string;
  readonly timestamp: string;
  readonly fieldErrors?: FieldError[];
  readonly baseUrl?: string;

  constructor(code: ErrorCode, opts: CreateProblemOptions) {
    const title = opts.title ?? ERROR_TITLE[code];
    super(opts.detail ?? title);
    this.name = 'ProblemError';
    this.code = code;
    this.status = opts.status ?? ERROR_STATUS[code];
    this.title = title;
    this.detail = opts.detail;
    this.instance = opts.instance;
    this.requestId = opts.requestId;
    this.timestamp = opts.timestamp ?? new Date().toISOString();
    this.fieldErrors = opts.errors;
    this.baseUrl = opts.baseUrl;
  }

  /**
   * Serialize to the on-the-wire RFC 7807 body. Pass `overrideBaseUrl`
   * to inject a deployment-specific base — used by the API's error
   * handler so service-thrown Problems get the right `type` URI without
   * services needing to know about config.
   */
  toJSON(overrideBaseUrl?: string): Problem {
    const base = overrideBaseUrl ?? this.baseUrl ?? 'https://api.example.com';
    const slug = this.code.toLowerCase().replace(/_/g, '-');
    return {
      type: `${base.replace(/\/+$/, '')}/errors/${slug}`,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.instance ? { instance: this.instance } : {}),
      code: this.code,
      requestId: this.requestId,
      timestamp: this.timestamp,
      ...(this.fieldErrors && this.fieldErrors.length > 0 ? { errors: this.fieldErrors } : {}),
    };
  }
}

/**
 * Factory that returns a `ProblemError`. Use this from services and
 * route handlers; the API's error plugin will catch and serialize it.
 */
export function createProblem(code: ErrorCode, opts: CreateProblemOptions): ProblemError {
  return new ProblemError(code, opts);
}

export { ERROR_CODES };
export type { ErrorCode };
