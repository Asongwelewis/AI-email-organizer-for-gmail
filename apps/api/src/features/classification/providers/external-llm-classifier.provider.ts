import { env } from '@api/config/env.js';
import { ClassificationError } from '../classification.errors.js';
import type {
  ClassificationInput,
  EmailClassifierProvider,
  ProviderClassificationResult,
  ProviderContext,
} from '../classification.types.js';

interface ExternalResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class ExternalLlmClassifierProvider implements EmailClassifierProvider {
  readonly name = 'external';
  readonly model = env.AI_CLASSIFIER_MODEL;
  readonly enabled = env.AI_CLASSIFIER_ENABLED && Boolean(env.AI_CLASSIFIER_API_KEY);

  async classify(
    input: ClassificationInput,
    context: ProviderContext,
  ): Promise<ProviderClassificationResult> {
    if (!this.enabled || !env.AI_CLASSIFIER_BASE_URL || !env.AI_CLASSIFIER_API_KEY) {
      throw new ClassificationError(
        'CLASSIFICATION_PROVIDER_UNAVAILABLE',
        'The external classifier is not configured.',
        503,
        false,
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.AI_CLASSIFIER_TIMEOUT_MS);
    try {
      const response = await fetch(env.AI_CLASSIFIER_BASE_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${env.AI_CLASSIFIER_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: env.AI_CLASSIFIER_OUTPUT_MAX_TOKENS,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: context.prompt },
            {
              role: 'user',
              content: JSON.stringify({ metadata: input, ruleSignals: context.ruleSignals }),
            },
          ],
        }),
      });
      if (response.status === 429) {
        throw new ClassificationError(
          'CLASSIFICATION_PROVIDER_RATE_LIMITED',
          'The classifier provider is rate limited.',
          503,
          true,
        );
      }
      if (!response.ok) {
        throw new ClassificationError(
          'CLASSIFICATION_PROVIDER_UNAVAILABLE',
          'The classifier provider is unavailable.',
          503,
          response.status >= 500,
        );
      }
      const body = (await response.json()) as ExternalResponse;
      return {
        output: body.choices?.[0]?.message?.content,
        ...(body.usage?.prompt_tokens === undefined
          ? {}
          : { inputUnits: body.usage.prompt_tokens }),
        ...(body.usage?.completion_tokens === undefined
          ? {}
          : { outputUnits: body.usage.completion_tokens }),
      };
    } catch (error) {
      if (error instanceof ClassificationError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ClassificationError(
          'CLASSIFICATION_PROVIDER_TIMEOUT',
          'The classifier provider timed out.',
          503,
          true,
        );
      }
      throw new ClassificationError(
        'CLASSIFICATION_PROVIDER_UNAVAILABLE',
        'The classifier provider is unavailable.',
        503,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
