import { describe, expect, it } from 'vitest';

import { safeErrorDetails } from '../src/config/logger.js';

describe('safe error logging', () => {
  it('extracts database diagnostics without returning the unsafe error message', () => {
    const error = new Error(
      'PostgresError { code: "23514", message: "access=secret-token", ' +
        'detail: "Failing row contains (secret-refresh)", ' +
        'constraint "connected_google_accounts_timestamps_check" }',
    );

    const details = safeErrorDetails(error);

    expect(details).toEqual({
      errorType: 'Error',
      databaseCode: '23514',
      databaseConstraint: 'connected_google_accounts_timestamps_check',
    });
    expect(JSON.stringify(details)).not.toMatch(/secret|token|refresh|Failing row/i);
  });

  it('includes only strictly formatted application error codes', () => {
    expect(safeErrorDetails({ code: 'AUTH_SESSION_EXPIRED' })).toMatchObject({
      errorCode: 'AUTH_SESSION_EXPIRED',
    });
    expect(safeErrorDetails({ code: 'token=secret-value' })).not.toHaveProperty('errorCode');
  });
});
