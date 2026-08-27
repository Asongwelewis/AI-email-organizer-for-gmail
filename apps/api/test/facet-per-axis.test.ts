import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  safeErrorDetails: () => ({}),
}));

import { env } from '../src/config/env.js';
import { GeminiFacetClassifier } from '../src/features/automation/facet-classifier.js';
import { APPROVED_FACET_VOCABULARY } from '../src/features/label-discovery/facets.js';
import {
  resetGeminiModelVersion,
  resetGeminiPacing,
} from '../src/integrations/gemini/gemini.client.js';

/*
 * A vocabulary is per account now, so the classifier is handed one rather than reading a module
 * constant. The checked-in set is a perfectly good fixture — it is a real approved vocabulary,
 * just no longer the only one there can be.
 */
const VOCABULARY = APPROVED_FACET_VOCABULARY;
const DOMAIN = VOCABULARY.domain[0]!.name;
const INTENT = VOCABULARY.intent[0]!.name;

const input = {
  key: 'm1',
  subject: 'Your payment could not be processed',
  sender: 'billing@example.com',
  senderHost: 'billing.example.com',
  snippet: 'We were unable to charge your card.',
};

const respondWith = (results: unknown[]) =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: JSON.stringify({ results }) }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 120,
            candidatesTokenCount: 40,
            cachedContentTokenCount: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );

/**
 * A facet is discarded per axis, not per message.
 *
 * This is the whole reason facets replaced the tree. Under one taxonomy, not knowing one thing
 * about a message meant knowing nothing about it, and 85.9% of the mailbox came back NONE — not
 * because the classifier was wrong, but because it was asked a question with no right answer.
 * Throwing away a valid intent because the domain came back as something never defined would
 * reintroduce exactly that failure one axis at a time.
 */
describe('a facet is discarded per axis, not per message', () => {
  const originalKey = env.GEMINI_API_KEY;
  const originalInterval = env.GEMINI_MIN_REQUEST_INTERVAL_MS;

  beforeEach(() => {
    env.GEMINI_API_KEY = 'test-gemini-key';
    env.GEMINI_MIN_REQUEST_INTERVAL_MS = 0;
    resetGeminiPacing();
    resetGeminiModelVersion();
  });

  afterEach(() => {
    env.GEMINI_API_KEY = originalKey;
    env.GEMINI_MIN_REQUEST_INTERVAL_MS = originalInterval;
    vi.unstubAllGlobals();
  });

  it('keeps a valid intent when the domain came back outside the vocabulary', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith([
        {
          key: 'm1',
          domain: 'cryptocurrency',
          domainConfidence: 0.91,
          intent: INTENT,
          intentConfidence: 0.88,
        },
      ]),
    );

    const [result] = (
      await new GeminiFacetClassifier().classify([input], { vocabulary: VOCABULARY })
    ).classifications;

    expect(result).toMatchObject({ domain: null, intent: INTENT, intentConfidence: 0.88 });
    // A discarded axis carries no confidence: there is no decision left to be confident about.
    expect(result!.domainConfidence).toBe(0);
  });

  it('keeps a valid domain when the intent came back outside the vocabulary', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith([
        {
          key: 'm1',
          domain: DOMAIN,
          domainConfidence: 0.93,
          intent: 'unsubscribe-request',
          intentConfidence: 0.7,
        },
      ]),
    );

    const [result] = (
      await new GeminiFacetClassifier().classify([input], { vocabulary: VOCABULARY })
    ).classifications;

    expect(result).toMatchObject({ domain: DOMAIN, domainConfidence: 0.93, intent: null });
    expect(result!.intentConfidence).toBe(0);
  });

  // UNKNOWN is the model saying "no value of this facet fits", which is an answer, not a fault.
  it('treats UNKNOWN on one axis as no decision on that axis alone', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith([
        {
          key: 'm1',
          domain: DOMAIN,
          domainConfidence: 0.95,
          intent: 'UNKNOWN',
          intentConfidence: 0.4,
        },
      ]),
    );

    const [result] = (
      await new GeminiFacetClassifier().classify([input], { vocabulary: VOCABULARY })
    ).classifications;

    expect(result).toMatchObject({ domain: DOMAIN, intent: null, intentConfidence: 0 });
  });

  // Both axes unusable is still a well-formed answer about one message, not a provider fault:
  // the entity facet is derived in code and carries the message on its own.
  it('returns a message with neither axis rather than failing the batch', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith([
        {
          key: 'm1',
          domain: 'cryptocurrency',
          domainConfidence: 0.9,
          intent: 'unsubscribe-request',
          intentConfidence: 0.9,
        },
      ]),
    );

    const { classifications } = await new GeminiFacetClassifier().classify([input], {
      vocabulary: VOCABULARY,
    });

    expect(classifications).toHaveLength(1);
    expect(classifications[0]).toMatchObject({ domain: null, intent: null });
  });
});
