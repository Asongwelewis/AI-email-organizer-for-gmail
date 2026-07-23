import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { EncryptionService } from '../src/security/encryption.service.js';
import { sha256 } from '../src/security/hashing.service.js';
import { generateSecureToken } from '../src/security/random.service.js';
import { CALLBACK_STATUSES, safeRedirectPath } from '../src/security/safe-redirect.js';

describe('security primitives', () => {
  it('generates high-entropy URL-safe tokens and stores deterministic hashes', () => {
    const first = generateSecureToken();
    const second = generateSecureToken();
    expect(first).not.toBe(second);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(sha256(first)).toBe(sha256(first));
    expect(sha256(first)).not.toBe(first);
  });

  it('encrypts with AES-256-GCM using a fresh IV', () => {
    const service = new EncryptionService(Buffer.alloc(32, 1), 3);
    const first = service.encrypt('sensitive-token');
    const second = service.encrypt('sensitive-token');
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
    expect(service.decrypt(first)).toBe('sensitive-token');
  });

  it('rejects tampering and wrong keys without exposing token data', () => {
    const service = new EncryptionService(Buffer.alloc(32, 1), 1);
    const encrypted = service.encrypt('never-leak-this-token');
    const tampered = { ...encrypted, authTag: Buffer.alloc(16).toString('base64') };
    expect(() => service.decrypt(tampered)).toThrow('Unable to process protected credentials.');
    expect(() => new EncryptionService(Buffer.alloc(32, 2), 1).decrypt(encrypted)).toThrow(
      'Unable to process protected credentials.',
    );
    try {
      service.decrypt(tampered);
    } catch (error) {
      expect(String(error)).not.toContain('never-leak-this-token');
    }
  });

  it('rejects invalid encryption key lengths', () => {
    expect(() => new EncryptionService(Buffer.alloc(31), 1)).toThrow(
      'Encryption key must be exactly 32 bytes',
    );
  });

  it('allows only predefined internal redirects', () => {
    expect(safeRedirectPath('/dashboard', '/login')).toBe('/dashboard');
    expect(safeRedirectPath('/auth/callback', '/login')).toBe('/auth/callback');
    expect(safeRedirectPath('https://evil.example', '/login')).toBe('/login');
    expect(safeRedirectPath('//evil.example', '/login')).toBe('/login');
    expect(safeRedirectPath('/not-allowed', '/login')).toBe('/login');
  });

  it('allowlists only the public callback status contract', () => {
    expect(CALLBACK_STATUSES).toEqual([
      'login_success',
      'login_failed',
      'gmail_connected',
      'gmail_denied',
      'gmail_permission_incomplete',
      'gmail_reauth_required',
      'gmail_connection_failed',
    ]);
  });
});
