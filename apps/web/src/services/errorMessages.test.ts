import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';

import { getApiErrorCode, getSafeErrorMessage } from './errorMessages';

function apiError(code?: string, message?: string): AxiosError {
  const error = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  error.response = {
    data: code || message ? { error: { code, message } } : {},
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

const LABEL_CODES = [
  'LABEL_NAME_INVALID',
  'LABEL_DUPLICATE',
  'LABEL_LIMIT_REACHED',
  'LABEL_SET_EMPTY',
  'LABEL_NOT_FOUND',
  'LABEL_VALIDATION_FAILED',
  'LABEL_PROPOSAL_NOT_ENOUGH_MAIL',
  'LABEL_PROPOSAL_ALREADY_RUNNING',
];

describe('getSafeErrorMessage', () => {
  it('has a curated message for every label code and for a missing Gmail connection', () => {
    for (const code of [...LABEL_CODES, 'GMAIL_ACCOUNT_NOT_CONNECTED']) {
      const message = getSafeErrorMessage(apiError(code, 'server text'), 'fallback');
      expect(message, code).not.toBe('fallback');
      expect(message, code).not.toBe(code);
    }
  });

  it('echoes the server code and message for an unrecognized code', () => {
    expect(
      getSafeErrorMessage(apiError('LABEL_ENGINE_OFFLINE', 'Engine is down.'), 'fallback'),
    ).toBe('LABEL_ENGINE_OFFLINE: Engine is down.');
  });

  it('falls back to whichever half the server sent', () => {
    expect(getSafeErrorMessage(apiError('SOME_CODE'), 'fallback')).toBe('SOME_CODE');
    expect(getSafeErrorMessage(apiError(undefined, 'Only a message.'), 'fallback')).toBe(
      'Only a message.',
    );
  });

  it('uses the caller fallback only when the error carries nothing usable', () => {
    expect(getSafeErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
    expect(getSafeErrorMessage(apiError(), 'fallback')).toBe('fallback');
    expect(getApiErrorCode(new Error('boom'))).toBeNull();
  });
});
