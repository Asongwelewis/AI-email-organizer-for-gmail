import { isServerUnreachable } from '@web/services/errorMessages';

/**
 * Reads retry, but only when the server was never reached.
 *
 * Retries used to be off everywhere, so one dropped packet on a phone — or Render answering for a
 * server that was still starting — left "Folders could not be loaded" on screen until someone
 * tapped Try again. An answer from the API is a decision and is shown as it came; no answer at all
 * is worth asking again, three times, a second, two and four apart.
 */
export const MAX_UNREACHABLE_RETRIES = 3;

export function retryWhenUnreachable(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_UNREACHABLE_RETRIES && isServerUnreachable(error);
}

export function unreachableRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000);
}
