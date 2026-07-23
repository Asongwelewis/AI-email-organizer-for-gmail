import { env } from '@api/config/env.js';
import type { EmailClassifierProvider } from '../classification.types.js';
import { DisabledClassifierProvider } from './disabled-classifier.provider.js';
import { ExternalLlmClassifierProvider } from './external-llm-classifier.provider.js';
import { MockClassifierProvider } from './mock-classifier.provider.js';

export function createClassifierProvider(): EmailClassifierProvider {
  if (!env.AI_CLASSIFIER_ENABLED || env.AI_CLASSIFIER_PROVIDER === 'disabled') {
    return new DisabledClassifierProvider();
  }
  if (env.AI_CLASSIFIER_PROVIDER === 'mock') return new MockClassifierProvider();
  return new ExternalLlmClassifierProvider();
}
