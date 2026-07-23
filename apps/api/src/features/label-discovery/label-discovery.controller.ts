import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { LABEL_CANDIDATE_TYPES } from './label-discovery.taxonomy.js';
import { labelDiscoveryService } from './label-discovery.service.js';

const uuid = z.string().uuid();
const candidateStatuses = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'DEFERRED',
  'MERGED',
  'CREATED',
  'SUPERSEDED',
  'FAILED',
] as const;
const runSchema = z
  .object({
    minMessages: z.number().int().min(3).max(100).optional(),
    lookbackDays: z.number().int().min(7).max(365).optional(),
    maxCandidates: z.number().int().min(1).max(50).optional(),
    allowedCandidateTypes: z.array(z.enum(LABEL_CANDIDATE_TYPES)).min(1).max(6).optional(),
    preferOrganizations: z.boolean().optional(),
    preferTopics: z.boolean().optional(),
  })
  .strict();
const listSchema = z.object({
  status: z.enum(candidateStatuses).optional(),
  candidateType: z.enum(LABEL_CANDIDATE_TYPES).optional(),
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const approvalSchema = z.object({ leafName: z.string().trim().min(2).max(60).optional() }).strict();
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();
const mergeSchema = z.object({ targetCandidateId: uuid }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      'LABEL_DISCOVERY_VALIDATION_FAILED',
      'Label-discovery request validation failed.',
      400,
    );
  }
  return result.data;
}

export class LabelDiscoveryController {
  async status(request: Request, response: Response): Promise<void> {
    response.json(await labelDiscoveryService.status(request.auth!.user.id));
  }

  async run(request: Request, response: Response): Promise<void> {
    response.json(
      await labelDiscoveryService.run(request.auth!.user.id, parse(runSchema, request.body)),
    );
  }

  async candidates(request: Request, response: Response): Promise<void> {
    response.json(
      await labelDiscoveryService.candidates(
        request.auth!.user.id,
        parse(listSchema, request.query),
      ),
    );
  }

  async candidate(request: Request, response: Response): Promise<void> {
    response.json(
      await labelDiscoveryService.candidate(
        request.auth!.user.id,
        parse(uuid, request.params['id']),
      ),
    );
  }

  async approve(request: Request, response: Response): Promise<void> {
    const input = parse(approvalSchema, request.body);
    response
      .status(201)
      .json(
        await labelDiscoveryService.approve(
          request.auth!.user.id,
          parse(uuid, request.params['id']),
          input.leafName,
        ),
      );
  }

  async reject(request: Request, response: Response): Promise<void> {
    const input = parse(reasonSchema, request.body);
    response
      .status(201)
      .json(
        await labelDiscoveryService.reject(
          request.auth!.user.id,
          parse(uuid, request.params['id']),
          input.reason,
        ),
      );
  }

  async defer(request: Request, response: Response): Promise<void> {
    const input = parse(reasonSchema, request.body);
    response
      .status(201)
      .json(
        await labelDiscoveryService.defer(
          request.auth!.user.id,
          parse(uuid, request.params['id']),
          input.reason,
        ),
      );
  }

  async merge(request: Request, response: Response): Promise<void> {
    const input = parse(mergeSchema, request.body);
    response
      .status(201)
      .json(
        await labelDiscoveryService.merge(
          request.auth!.user.id,
          parse(uuid, request.params['id']),
          input.targetCandidateId,
        ),
      );
  }
}

export const labelDiscoveryController = new LabelDiscoveryController();
