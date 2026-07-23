import type { gmail_message_metadata } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  hashClassificationInput,
  normalizeClassificationInput,
} from '../src/features/classification/classification-input.js';
import { buildClassificationPrompt } from '../src/features/classification/classification-prompts.js';
import { evaluateClassificationRules } from '../src/features/classification/classification-rules.js';
import {
  CLASSIFICATION_CATEGORIES,
  RECOMMENDED_ACTIONS,
} from '../src/features/classification/classification-taxonomy.js';
import { validateClassificationOutput } from '../src/features/classification/classification.validation.js';
import { DisabledClassifierProvider } from '../src/features/classification/providers/disabled-classifier.provider.js';
import { MockClassifierProvider } from '../src/features/classification/providers/mock-classifier.provider.js';

function message(overrides: Partial<gmail_message_metadata> = {}): gmail_message_metadata {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    connected_google_account_id: '00000000-0000-4000-8000-000000000002',
    gmail_message_id: 'gmail-id',
    gmail_thread_id: null,
    history_id: null,
    internal_date: new Date('2026-01-02T00:00:00.000Z'),
    subject: 'Your receipt',
    sender_name: 'Billing',
    sender_email: 'no-reply@shop.example',
    recipient_summary: 'Customer <private.person@example.com>',
    snippet: 'Payment confirmation for private.person@example.com',
    label_ids: ['CATEGORY_UPDATES', 'INBOX'],
    has_attachments: false,
    size_estimate: 100,
    is_unread: true,
    is_starred: false,
    is_important: false,
    is_draft: false,
    is_sent: false,
    is_trashed: false,
    first_seen_at: new Date(),
    last_synced_at: new Date(),
    deleted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('classification domain', () => {
  it('centralizes unique category and recommendation allowlists', () => {
    expect(new Set(CLASSIFICATION_CATEGORIES).size).toBe(CLASSIFICATION_CATEGORIES.length);
    expect(new Set(RECOMMENDED_ACTIONS).size).toBe(RECOMMENDED_ACTIONS.length);
    expect(CLASSIFICATION_CATEGORIES).toContain('SPAM_SUSPECTED');
    expect(RECOMMENDED_ACTIONS).toContain('REVIEW_REQUIRED');
  });

  it('normalizes metadata without complete private addresses', () => {
    const input = normalizeClassificationInput(message(), 'owner@example.com');
    expect(input.senderDomain).toBe('shop.example');
    expect(input.senderLocalPartCategory).toBe('automated');
    expect(input.recipientRoleSummary).toContain('[address]@example.com');
    expect(JSON.stringify(input)).not.toContain('private.person@example.com');
    expect(JSON.stringify(input)).not.toContain('no-reply@shop.example');
  });

  it('produces stable hashes and changes them for material metadata', () => {
    const first = normalizeClassificationInput(message(), 'owner@example.com');
    const second = normalizeClassificationInput(message(), 'owner@example.com');
    const changed = normalizeClassificationInput(
      message({ subject: 'A changed subject' }),
      'owner@example.com',
    );
    expect(hashClassificationInput(first)).toBe(hashClassificationInput(second));
    expect(hashClassificationInput(first)).not.toBe(hashClassificationInput(changed));
  });

  it('applies deterministic receipt and Gmail promotion rules', () => {
    const receipt = evaluateClassificationRules(
      normalizeClassificationInput(message(), 'owner@example.com'),
    );
    const promotion = evaluateClassificationRules(
      normalizeClassificationInput(
        message({ subject: 'Sale', snippet: 'Today only', label_ids: ['CATEGORY_PROMOTIONS'] }),
        'owner@example.com',
      ),
    );
    expect(receipt.some((signal) => signal.category === 'RECEIPTS')).toBe(true);
    expect(promotion[0]).toMatchObject({ category: 'PROMOTIONS', confidence: 0.94 });
  });

  it('builds a versioned prompt with uncertainty and spam safeguards', () => {
    const prompt = buildClassificationPrompt();
    expect(prompt).toContain('mailmind-prompt-v1');
    expect(prompt).toContain('REVIEW_REQUIRED');
    expect(prompt).toContain('never a definitive spam determination');
  });

  it('validates strict structured output and confidence bounds', () => {
    const valid = {
      category: 'WORK',
      recommendedAction: 'KEEP_IN_INBOX',
      confidence: 0.8,
      reasonCodes: ['MODEL_METADATA_EVIDENCE'],
      explanation: 'Metadata suggests work correspondence.',
      requiresReview: false,
    };
    expect(validateClassificationOutput(JSON.stringify(valid))).toEqual(valid);
    expect(() => validateClassificationOutput('{bad json')).toThrow('invalid structured response');
    expect(() => validateClassificationOutput({ ...valid, category: 'UNKNOWN' })).toThrow();
    expect(() => validateClassificationOutput({ ...valid, confidence: 1.01 })).toThrow();
    expect(() => validateClassificationOutput({ ...valid, secret: 'extra' })).toThrow();
  });

  it('uses deterministic mock output and fails safely when disabled', async () => {
    const input = normalizeClassificationInput(
      message({ sender_email: 'person@example.com' }),
      'owner@example.com',
    );
    const mock = new MockClassifierProvider();
    const result = await mock.classify(input, { prompt: 'prompt', ruleSignals: [] });
    expect(result.output).toMatchObject({ category: 'WORK', confidence: 0.76 });
    await expect(
      new DisabledClassifierProvider().classify(input, {
        prompt: 'prompt',
        ruleSignals: [],
      }),
    ).rejects.toMatchObject({ code: 'CLASSIFICATION_DISABLED', retryable: false });
  });
});
