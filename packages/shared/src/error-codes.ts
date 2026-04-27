/**
 * Error code taxonomy. Mirrors CLAUDE.md §"Error codes".
 *
 * Every Problem response (RFC 7807) carries one of these as `code`.
 */
export const ERROR_CODES = {
  // 400
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  // 403
  FORBIDDEN: 'FORBIDDEN',
  DEVICE_MISMATCH: 'DEVICE_MISMATCH',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  // 409
  CONFLICT: 'CONFLICT',
  // 410
  SESSION_CLOSED: 'SESSION_CLOSED',
  // 422
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  // 500
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // 503
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** HTTP status that goes with each error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  MALFORMED_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  DEVICE_MISMATCH: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SESSION_CLOSED: 410,
  BUSINESS_RULE_VIOLATION: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/** Default human-readable title for each code. */
export const ERROR_TITLE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Validation failed',
  MALFORMED_REQUEST: 'Malformed request',
  UNAUTHENTICATED: 'Authentication required',
  INVALID_CREDENTIALS: 'Invalid credentials',
  INVALID_TOKEN: 'Invalid token',
  TOKEN_EXPIRED: 'Token expired',
  FORBIDDEN: 'Forbidden',
  DEVICE_MISMATCH: 'Device mismatch',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  SESSION_CLOSED: 'Session closed',
  BUSINESS_RULE_VIOLATION: 'Business rule violation',
  RATE_LIMITED: 'Rate limited',
  INTERNAL_ERROR: 'Internal error',
  SERVICE_UNAVAILABLE: 'Service unavailable',
};
