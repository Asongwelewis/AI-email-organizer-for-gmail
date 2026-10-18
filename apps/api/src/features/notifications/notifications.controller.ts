import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { isPushConfigured, pushPublicKey } from './push.service.js';
import { notificationsService } from './notifications.service.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(40).optional(),
});

const readBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200).optional(),
});

/** Exactly what `PushSubscription.toJSON()` produces in a browser, and nothing else. */
const subscriptionBody = z.object({
  endpoint: z
    .string()
    .min(12)
    .max(1000)
    .refine((value) => value.startsWith('https://'), 'must be https'),
  keys: z.object({
    p256dh: z.string().min(16).max(200),
    auth: z.string().min(8).max(100),
  }),
});

const unsubscribeBody = z.object({ endpoint: z.string().min(12).max(1000) });

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code = 'NOTIFICATION_VALIDATION_FAILED',
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      code as 'NOTIFICATION_VALIDATION_FAILED',
      'Notification request validation failed.',
      400,
    );
  }
  return parsed.data;
}

function noStore(response: Response): void {
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
}

export const notificationsController = {
  async list(request: Request, response: Response): Promise<void> {
    noStore(response);
    const query = parse(listQuery, request.query);
    response.json(await notificationsService.list(request.auth!.user.id, query));
  },

  async markRead(request: Request, response: Response): Promise<void> {
    const body = parse(readBody, request.body ?? {});
    const marked = await notificationsService.markRead(request.auth!.user.id, body.ids);
    response.json({ marked });
  },

  /** What a browser needs to subscribe, and whether this one deployment can push at all. */
  async pushConfig(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json({
      configured: isPushConfigured(),
      publicKey: pushPublicKey(),
      subscriptions: await notificationsService.subscriptionCount(request.auth!.user.id),
    });
  },

  async subscribe(request: Request, response: Response): Promise<void> {
    if (!isPushConfigured()) {
      throw new AppError(
        'PUSH_NOT_CONFIGURED',
        'This server is not set up to send notifications to your device.',
        503,
      );
    }
    const body = parse(subscriptionBody, request.body, 'PUSH_SUBSCRIPTION_INVALID');
    await notificationsService.subscribe(
      request.auth!.user.id,
      body,
      request.get('user-agent') ?? null,
    );
    response.status(201).json({ subscribed: true });
  },

  async unsubscribe(request: Request, response: Response): Promise<void> {
    const body = parse(unsubscribeBody, request.body, 'PUSH_SUBSCRIPTION_INVALID');
    await notificationsService.unsubscribe(request.auth!.user.id, body.endpoint);
    response.json({ subscribed: false });
  },
};
