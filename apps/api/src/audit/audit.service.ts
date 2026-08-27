import { logger } from '@api/config/logger.js';
import { captureApiException } from '@api/observability/sentry.js';
import { auditRepository, type AuditInput } from '@api/repositories/audit.repository.js';

export class AuditService {
  async record(input: AuditInput): Promise<void> {
    try {
      await auditRepository.create(input);
    } catch (error) {
      captureApiException(error, { operation: 'audit_write', audit_action: input.action });
      logger.error(
        {
          errorType: error instanceof Error ? error.name : 'UnknownError',
          action: input.action,
          requestId: input.requestId,
        },
        'audit write failed',
      );
    }
  }
}

export const auditService = new AuditService();
