import { env } from '@api/config/env.js';
import { AppError } from '@api/errors/AppError.js';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Notional cost rates for the configured model, in micro-USD per million tokens.
 *
 * MailMind runs on Gemini's free tier, where the real cost is $0. These are Google's published
 * PAID rates, recorded so AUTOMATION_MAX_COST_MICRO_USD still bounds a runaway run: without a
 * non-zero rate the budget check can never trip. Verified 2026-08-09 at
 * https://ai.google.dev/gemini-api/docs/pricing — standard (non-batch) tier, per 1M tokens for
 * Gemini 3.5 Flash-Lite: input $0.30, context caching $0.03, output $2.50.
 *
 * GEMINI_MODEL defaults to the `gemini-flash-lite-latest` alias, which Google repoints as models
 * are retired — gemini-2.5-flash-lite was retired out from under this code, which is why the
 * alias is preferred. The trade-off is that the alias's rates can change without a code change,
 * so these are deliberately the HIGHER current Flash-Lite rates: over-estimating cost makes the
 * budget cap trip early and stop a run, while under-estimating would let one overshoot.
 * Re-check them whenever GEMINI_MODEL is pinned to a specific model.
 */
const INPUT_MICRO_USD_PER_MILLION_TOKENS = 300_000;
const CACHED_INPUT_MICRO_USD_PER_MILLION_TOKENS = 30_000;
const OUTPUT_MICRO_USD_PER_MILLION_TOKENS = 2_500_000;

// PRIVACY BOUNDARY. Google's FREE tier states "Content used to improve our products: Yes", so the
// email metadata sent from here may be used to improve Google's products. That is an accepted
// trade-off for single-user personal use ONLY. Before any third party's mail flows through this
// client, move the project to a paid tier, where submitted content is not used that way.
// See docs/backend.md and https://ai.google.dev/gemini-api/docs/pricing (checked 2026-08-09).

export interface GeminiUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function estimatedCostMicroUsd(usage: GeminiUsage): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return Math.ceil(
    (uncached * INPUT_MICRO_USD_PER_MILLION_TOKENS +
      usage.cachedInputTokens * CACHED_INPUT_MICRO_USD_PER_MILLION_TOKENS +
      usage.outputTokens * OUTPUT_MICRO_USD_PER_MILLION_TOKENS) /
      1_000_000,
  );
}

export class GeminiProviderError extends AppError {
  constructor(
    code: ConstructorParameters<typeof AppError>[0],
    message: string,
    statusCode: number,
    public readonly providerStatus: number | null,
    public readonly providerCode: string | null,
    public readonly requestId: string | null,
    public readonly retryable: boolean,
  ) {
    super(code, message, statusCode);
    this.name = 'GeminiProviderError';
  }
}

type GenerateContentPayload = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
};

type GeminiErrorPayload = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export interface GeminiJsonRequest {
  systemInstruction: string;
  /** The user turn. Everything in it is untrusted data, never instructions. */
  payload: unknown;
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface GeminiJsonResponse {
  /** Parsed JSON from the model. Still untrusted: validate it against a Zod schema. */
  data: unknown;
  usage: GeminiUsage;
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Proactive pacing. The free tier's per-minute request cap is low enough that reacting to 429s
 * would waste most of a run, so every request waits its turn behind the previous one. The chain
 * serializes callers, which also keeps concurrent accounts from bursting past the shared quota.
 */
let paceChain: Promise<void> = Promise.resolve();
let lastRequestAtMs = 0;

function paceRequest(): Promise<void> {
  const scheduled = paceChain.then(async () => {
    const waitMs = lastRequestAtMs + env.GEMINI_MIN_REQUEST_INTERVAL_MS - Date.now();
    if (waitMs > 0) await delay(waitMs);
    lastRequestAtMs = Date.now();
  });
  paceChain = scheduled.catch(() => undefined);
  return scheduled;
}

/** Test seam: forget the pacing history so a suite does not inherit the previous test's clock. */
export function resetGeminiPacing(): void {
  paceChain = Promise.resolve();
  lastRequestAtMs = 0;
}

function providerError(
  status: number,
  providerCode: string | null,
  requestId: string | null,
  retryable: boolean,
): GeminiProviderError {
  if (status === 401 || status === 403) {
    return new GeminiProviderError(
      'PROVIDER_AUTHENTICATION_FAILED',
      'Gemini credentials are invalid or lack access to the configured model.',
      503,
      status,
      providerCode,
      requestId,
      false,
    );
  }
  if (status === 429) {
    // The free tier's daily request cap surfaces here too. The caller stops and resumes from its
    // checkpoints on the next scheduled tick rather than burning retries against a spent quota.
    return new GeminiProviderError(
      'PROVIDER_RATE_LIMITED',
      'Gemini is rate limited. MailMind will resume on the next scheduled run.',
      503,
      status,
      providerCode,
      requestId,
      retryable,
    );
  }
  if (status === 404) {
    return new GeminiProviderError(
      'PROVIDER_MODEL_UNAVAILABLE',
      'The configured Gemini model is unavailable to this project.',
      503,
      status,
      providerCode,
      requestId,
      false,
    );
  }
  if (status >= 400 && status < 500) {
    return new GeminiProviderError(
      'PROVIDER_BAD_REQUEST',
      'Gemini rejected the request configuration.',
      502,
      status,
      providerCode,
      requestId,
      false,
    );
  }
  return new GeminiProviderError(
    'PROVIDER_UNAVAILABLE',
    'Gemini is temporarily unavailable.',
    503,
    status,
    providerCode,
    requestId,
    retryable,
  );
}

/**
 * One paced, retried, JSON-mode Gemini call. Shared by every feature that talks to Gemini so
 * pacing and the daily quota are respected across all of them, not per feature.
 */
export async function requestGeminiJson(request: GeminiJsonRequest): Promise<GeminiJsonResponse> {
  if (!env.GEMINI_API_KEY) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', 'Gemini is not configured.', 503);
  }
  const body = {
    systemInstruction: { parts: [{ text: request.systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(request.payload) }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: request.maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: request.responseSchema,
    },
  };
  const url = `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`;

  for (let attempt = 0; attempt <= env.GEMINI_MAX_RETRIES; attempt += 1) {
    try {
      await paceRequest();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': env.GEMINI_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(env.GEMINI_TIMEOUT_MS),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as GeminiErrorPayload | null;
        const providerCode = payload?.error?.status ?? null;
        const requestId = response.headers.get('x-request-id');
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        if (retryable && attempt < env.GEMINI_MAX_RETRIES) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
          const backoffMilliseconds = Number.isFinite(retryAfter)
            ? Math.min(60_000, Math.max(0, retryAfter * 1000))
            : 1000 * 2 ** attempt;
          await delay(backoffMilliseconds);
          continue;
        }
        throw providerError(response.status, providerCode, requestId, retryable);
      }
      const payload = (await response.json()) as GenerateContentPayload;
      if (payload.promptFeedback?.blockReason) {
        throw new AppError(
          'PROVIDER_INVALID_RESPONSE',
          `Gemini blocked the request (${payload.promptFeedback.blockReason}).`,
          502,
        );
      }
      const candidate = payload.candidates?.[0];
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        throw new AppError(
          'PROVIDER_INVALID_RESPONSE',
          `Gemini returned an incomplete response (${candidate.finishReason}).`,
          502,
        );
      }
      const text = candidate?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('')
        .trim();
      if (!text) {
        throw new AppError('PROVIDER_INVALID_RESPONSE', 'Gemini returned no content.', 502);
      }
      try {
        return {
          data: JSON.parse(text),
          usage: {
            inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
            cachedInputTokens: payload.usageMetadata?.cachedContentTokenCount ?? 0,
            outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
          },
        };
      } catch {
        throw new AppError('PROVIDER_INVALID_RESPONSE', 'Gemini returned malformed JSON.', 502);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (attempt < env.GEMINI_MAX_RETRIES) {
        await delay(1000 * 2 ** attempt);
        continue;
      }
      throw new GeminiProviderError(
        'PROVIDER_UNAVAILABLE',
        'Gemini is temporarily unavailable.',
        503,
        null,
        null,
        null,
        true,
      );
    }
  }
  throw new AppError('PROVIDER_UNAVAILABLE', 'Gemini is unavailable.', 502);
}
