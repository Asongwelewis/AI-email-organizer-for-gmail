import { AppError, type ErrorCode } from '@api/errors/AppError.js';

export class ClassificationError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    public readonly retryable: boolean,
  ) {
    super(code, message, statusCode);
  }
}
