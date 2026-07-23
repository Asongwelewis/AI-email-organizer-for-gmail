import { randomBytes } from 'node:crypto';

export function generateSecureToken(bytes = 32): string {
  if (bytes < 32) throw new Error('Secure tokens require at least 32 random bytes');
  return randomBytes(bytes).toString('base64url');
}
