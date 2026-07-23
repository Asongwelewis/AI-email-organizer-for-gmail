import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from '@api/config/env.js';
import { AppError } from '@api/errors/AppError.js';

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export class EncryptionService {
  constructor(
    private readonly key: Buffer = env.TOKEN_ENCRYPTION_KEY_BYTES,
    private readonly keyVersion: number = env.TOKEN_ENCRYPTION_KEY_VERSION,
  ) {
    if (key.length !== 32) throw new Error('Encryption key must be exactly 32 bytes');
  }

  encrypt(plaintext: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(value: EncryptedValue): string {
    try {
      if (value.keyVersion !== this.keyVersion) throw new Error('unsupported key version');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new AppError('INTERNAL_SERVER_ERROR', 'Unable to process protected credentials.', 500);
    }
  }
}

export const encryptionService = new EncryptionService();
