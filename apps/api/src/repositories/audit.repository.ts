import type { audit_result, Prisma } from '@prisma/client';

import { prisma } from '@api/database/prisma.js';

export interface AuditInput {
  action: string;
  result?: audit_result;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  metadata?: Prisma.InputJsonObject;
}

export class AuditRepository {
  create(input: AuditInput) {
    return prisma.audit_logs.create({
      data: {
        action: input.action,
        result: input.result ?? 'INFO',
        ...(input.userId ? { user_id: input.userId } : {}),
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.requestId ? { request_id: input.requestId } : {}),
        metadata: input.metadata ?? {},
      },
    });
  }
}

export const auditRepository = new AuditRepository();
