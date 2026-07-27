import { describe, expect, it } from 'vitest';

import type { ClassificationResult } from '@web/types/classification';
import { groupRecommendationResults } from './groupRecommendationResults';

const result = (id: string, messageId: string): ClassificationResult => ({
  id,
  messageId,
  message: {
    subject: 'Weekly report',
    sender: 'Team',
    senderDomain: 'example.com',
    snippet: 'The same visible preview',
    gmailLabels: ['INBOX'],
    date: '2026-07-20T10:00:00.000Z',
  },
  recommendedCategory: 'WORK',
  suggestedAction: 'KEEP_IN_INBOX',
  confidence: 0.91,
  requiresReview: true,
  explanation: 'Work update.',
  reasonCodes: ['WORK'],
  source: 'AI',
  status: 'NEEDS_REVIEW',
  classifiedAt: '2026-07-20T10:00:00.000Z',
  correction: null,
});

describe('groupRecommendationResults', () => {
  it('groups visually identical cards while preserving every result and message ID', () => {
    const groups = groupRecommendationResults([
      result('result-1', 'message-1'),
      result('result-2', 'message-2'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.id)).toEqual(['result-1', 'result-2']);
    expect(groups[0]?.members.map((member) => member.messageId)).toEqual([
      'message-1',
      'message-2',
    ]);
  });

  it('keeps visually different recommendations separate', () => {
    const changed = result('result-2', 'message-2');
    changed.message = { ...changed.message, subject: 'Different report' };
    expect(groupRecommendationResults([result('result-1', 'message-1'), changed])).toHaveLength(2);
  });
});
