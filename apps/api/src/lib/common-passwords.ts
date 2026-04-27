/**
 * Top-50 common passwords (lowercase) — rejected even if they otherwise
 * satisfy the policy. Sourced from the SecLists "10-million-password-
 * list-top-50" cross-referenced with NIST SP 800-63B guidance.
 *
 * The policy already requires upper+lower+digit+special, so canonical
 * weak forms like "password" don't pass — this list catches typical
 * variants like Password1!, Welcome123!, Iloveyou1!, etc.
 */
const TOP_PASSWORDS = new Set([
  '123456',
  '123456789',
  'qwerty',
  'password',
  'password1',
  'password123',
  'password1!',
  '12345678',
  '111111',
  '1234567890',
  '1234567',
  'qwerty123',
  'qwerty1',
  '000000',
  '1q2w3e',
  'aa12345678',
  'abc123',
  'password!',
  'iloveyou',
  'iloveyou1',
  'iloveyou1!',
  'admin',
  'admin123',
  'admin123!',
  'admin1234',
  'welcome',
  'welcome1',
  'welcome1!',
  'welcome123',
  'welcome123!',
  'monkey',
  'monkey123',
  'letmein',
  'letmein1',
  'letmein123',
  'letmein123!',
  'dragon',
  'master',
  'sunshine',
  'princess',
  'football',
  'football1',
  'baseball',
  'shadow',
  'qazwsx',
  'qazwsx123',
  'changeme',
  'changeme1',
  'changeme123',
  'changeme123!',
]);

/** Returns true if the password (case-insensitive, stripped) is on the blocklist. */
export function isCommonPassword(pw: string): boolean {
  return TOP_PASSWORDS.has(pw.toLowerCase().trim());
}
