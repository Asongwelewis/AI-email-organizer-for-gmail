import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { PIVOT_FACETS, type PivotFacet } from '@api/features/label-discovery/pivot.js';
import { facetsService } from './facets.service.js';
import { vocabularyService } from './vocabulary.service.js';

const facetName = z.enum(PIVOT_FACETS);

/**
 * A pivot is an ORDER of distinct facets, so both properties are enforced here rather than left to
 * the service: `["entity", "entity"]` is not a deeper tree, it is the same level twice.
 */
const pivotOrder = z
  .array(facetName)
  .min(1)
  .max(PIVOT_FACETS.length)
  .refine((order) => new Set(order).size === order.length, {
    message: 'A pivot must name each facet at most once.',
  });

/**
 * The floor under a folder. Zero would make a folder per one-off sender and turn the tree into a
 * list of the mailbox; the ceiling keeps a typo from collapsing the whole tree to nothing.
 */
const minMessages = z.coerce.number().int().min(1).max(1000);

const settingsBody = z
  .object({ canonicalPivot: pivotOrder, minMessages: minMessages.optional() })
  .strict();

/** `?order=entity,intent&minMessages=5` — a query string, so the ordering is shareable as a link. */
const viewQuery = z
  .object({
    order: z
      .string()
      .transform((value) => value.split(',').map((part) => part.trim()))
      .pipe(pivotOrder)
      .optional(),
    minMessages: minMessages.optional(),
  })
  .strict();

/**
 * `entity=netflix|intent=payment-failed`. Bounded and shape-checked here so a malformed key is a
 * 400 rather than a query, and so the length of a facet value cannot be used to push work into
 * the database.
 */
const messagesQuery = z
  .object({
    facetKey: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[a-z]+=[^|]+(\|[a-z]+=[^|]+)*$/, 'not a facet key'),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().uuid().optional(),
  })
  .strict();

/**
 * A facet value as it is spelled everywhere else: lowercase, hyphen-separated, bounded. Checking
 * the shape here means a malformed filter is a 400 rather than a query that quietly matches
 * nothing and reads to the person as "you have no mail like that".
 */
const facetValue = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'not a facet value');

/**
 * `?q=payment&intent=payment-failed&order=domain,intent`. Every part is optional here; the service
 * is what refuses a search that constrains nothing, because "a phrase or at least one facet" is a
 * rule about the search and not about the shape of the query string.
 */
const searchQuery = z
  .object({
    q: z.string().max(200).optional(),
    entity: facetValue.optional(),
    domain: facetValue.optional(),
    intent: facetValue.optional(),
    order: z
      .string()
      .transform((value) => value.split(',').map((part) => part.trim()))
      .pipe(pivotOrder)
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().uuid().optional(),
  })
  .strict();

/**
 * The values a person approved. Shape-checked here rather than trusted: these strings become the
 * closed vocabulary a model is told to choose from and the folder names a pivot spells, so a value
 * that is not a slug, or a definition long enough to swamp the prompt, is a 400.
 */
const vocabularyBody = z
  .object({
    values: z
      .array(
        z
          .object({
            facet: z.enum(['domain', 'intent']),
            name: facetValue,
            definition: z.string().min(10).max(400),
          })
          .strict(),
      )
      .min(2)
      .max(128),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('FACET_VALIDATION_FAILED', 'Facet request validation failed.', 400);
  }
  return parsed.data;
}

/** Reads are per-account and change under the caller, so none of them may be cached. */
function noStore(response: Response): void {
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  response.set('Pragma', 'no-cache');
}

export class FacetsController {
  /** 202: classifying a mailbox is thousands of paced Gemini calls. The client polls the run id. */
  async classify(request: Request, response: Response): Promise<void> {
    response.status(202).json(await facetsService.startClassification(request.auth!.user.id));
  }

  /** 202: filing is one Gmail call per message. */
  async file(request: Request, response: Response): Promise<void> {
    response.status(202).json(await facetsService.startFiling(request.auth!.user.id));
  }

  async settings(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json(await facetsService.settings(request.auth!.user.id));
  }

  /**
   * Changes which ordering is the canonical one. Writes nothing to Gmail on its own — the tree
   * only moves when `apply` is called, which is what makes it safe to try an ordering out.
   */
  async setSettings(request: Request, response: Response): Promise<void> {
    const body = parse(settingsBody, request.body);
    response.json(
      await facetsService.setSettings(
        request.auth!.user.id,
        body.canonicalPivot as PivotFacet[],
        body.minMessages,
      ),
    );
  }

  async plan(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json(await facetsService.plan(request.auth!.user.id));
  }

  async view(request: Request, response: Response): Promise<void> {
    noStore(response);
    const query = parse(viewQuery, request.query);
    response.json(
      await facetsService.view(
        request.auth!.user.id,
        query.order as PivotFacet[] | undefined,
        query.minMessages,
      ),
    );
  }

  /** The mail inside one folder, newest first. Metadata only, and no Gmail call. */
  async folderMessages(request: Request, response: Response): Promise<void> {
    noStore(response);
    const query = parse(messagesQuery, request.query);
    response.json(
      await facetsService.folderMessages(request.auth!.user.id, query.facetKey, {
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      }),
    );
  }

  async apply(request: Request, response: Response): Promise<void> {
    response.json(await facetsService.apply(request.auth!.user.id));
  }

  /**
   * Subject and sender across the whole mailbox, narrowed by any combination of facets, with the
   * folder each hit sits in attached. No model call and no Gmail call.
   */
  async search(request: Request, response: Response): Promise<void> {
    noStore(response);
    const query = parse(searchQuery, request.query);
    response.json(
      await facetsService.search(
        request.auth!.user.id,
        query.q ?? null,
        {
          ...(query.entity === undefined ? {} : { entity: query.entity }),
          ...(query.domain === undefined ? {} : { domain: query.domain }),
          ...(query.intent === undefined ? {} : { intent: query.intent }),
        },
        {
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.order === undefined ? {} : { order: query.order as PivotFacet[] }),
        },
      ),
    );
  }

  /** What there is to filter by, and how much mail sits behind each value. */
  async vocabulary(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json(await facetsService.vocabulary(request.auth!.user.id));
  }

  /** The approved vocabulary, any pending proposal, and whether the classifier can run. */
  async vocabularyOverview(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json(await vocabularyService.overview(request.auth!.user.id));
  }

  /**
   * Grounds a candidate vocabulary in this mailbox's own mail and records it as a proposal.
   * Spends one Gemini call and changes nothing the classifier can see.
   */
  async proposeVocabulary(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json(await vocabularyService.propose(request.auth!.user.id));
  }

  /** The human approval. The only step after which the classifier speaks differently. */
  async approveVocabulary(request: Request, response: Response): Promise<void> {
    const body = parse(vocabularyBody, request.body);
    response.json(await vocabularyService.approve(request.auth!.user.id, body.values));
  }
}

export const facetsController = new FacetsController();
