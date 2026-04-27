import bcrypt from 'bcrypt';
import { passwordSchema, createProblem, type FieldError } from '@csm-chat/shared';
import { isCommonPassword } from './common-passwords.js';

const BCRYPT_COST = 12;

/**
 * Validates against the password policy AND the top-N common-password
 * blocklist. Throws a ProblemError(VALIDATION_ERROR) on failure.
 *
 * @param requestId — for the Problem body. Pass req.id from the route.
 */
export function assertStrongPassword(password: string, requestId: string, instance?: string): void {
  const policy = passwordSchema.safeParse(password);
  if (!policy.success) {
    const errors: FieldError[] = policy.error.errors.map((e) => ({
      field: e.path.join('.') || 'password',
      message: e.message,
    }));
    throw createProblem('VALIDATION_ERROR', { requestId, instance, errors });
  }
  if (isCommonPassword(password)) {
    throw createProblem('VALIDATION_ERROR', {
      requestId,
      instance,
      errors: [{ field: 'password', message: 'Password is too common.' }],
    });
  }
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
