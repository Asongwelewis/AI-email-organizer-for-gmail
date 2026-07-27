import { describe, expect, it } from 'vitest';

import type { AutomationReviewItem } from '@web/types/automation';
import { groupAutomationReviewItems } from './groupAutomationReviewItems';

const item = (id: string): AutomationReviewItem => ({
  id,
  category: 'WORK',
  labelPath: 'MailMind/Work',
  confidence: 0.62,
  explanation: 'Ambiguous work message.',
  reasonCodes: ['AMBIGUOUS'],
  createdAt: '2026-07-26T02:00:00.000Z',
  message: {
    subject: 'Project update',
    senderName: 'Alex',
    senderEmail: 'alex@example.com',
    snippet: 'Same preview',
    receivedAt: '2026-07-26T01:00:00.000Z',
  },
});

describe('groupAutomationReviewItems', () => {
  it('groups identical cards without losing their separate action IDs', () => {
    const groups = groupAutomationReviewItems([item('action-1'), item('action-2')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.id)).toEqual(['action-1', 'action-2']);
  });
});
