import { logger } from '@api/config/logger.js';
import { auditRepository, type AuditInput } from '@api/repositories/audit.repository.js';

export class AuditService {
  async record(input: AuditInput): Promise<void> {
    try {
      await auditRepository.create(input);
    } catch (error) {
      logger.error(
        { error, action: input.action, requestId: input.requestId },
        'audit write failed',
      );
    }
  }
}

export const auditService = new AuditService();
