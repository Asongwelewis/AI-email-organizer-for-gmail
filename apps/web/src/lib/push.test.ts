import { describe, expect, it } from 'vitest';

import { base64UrlToBytes, pushAvailability } from './push';

describe('turning device notifications on', () => {
  // The server hands out its VAPID public key base64url-encoded; the push manager wants raw bytes.
  it('decodes a base64url key, padding and alphabet included', () => {
    expect([...base64UrlToBytes('AQID')]).toEqual([1, 2, 3]);
    expect([...base64UrlToBytes('-_8')]).toEqual([251, 255]);
  });

  it('reports a browser without push support as unsupported rather than failing', () => {
    // jsdom has no PushManager, which is exactly a browser that cannot do this.
    expect(pushAvailability()).toBe('unsupported');
  });
});
