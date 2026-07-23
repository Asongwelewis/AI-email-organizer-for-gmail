import type { ClassificationInput, RuleSignal } from './classification.types.js';

const ruleDefinitions: Array<{
  test: (input: ClassificationInput, text: string) => boolean;
  signal: RuleSignal;
}> = [
  {
    test: (input) => input.gmailLabels.includes('CATEGORY_PROMOTIONS'),
    signal: {
      category: 'PROMOTIONS',
      recommendedAction: 'ARCHIVE_RECOMMENDED',
      confidence: 0.94,
      reasonCodes: ['GMAIL_CATEGORY_PROMOTIONS'],
      explanation: 'Gmail metadata identifies this as a promotion.',
    },
  },
  {
    test: (input) => input.gmailLabels.includes('CATEGORY_SOCIAL'),
    signal: {
      category: 'SOCIAL',
      recommendedAction: 'ARCHIVE_RECOMMENDED',
      confidence: 0.9,
      reasonCodes: ['GMAIL_CATEGORY_SOCIAL'],
      explanation: 'Gmail metadata identifies this as a social update.',
    },
  },
  {
    test: (_input, text) => /\b(receipt|payment confirmation|paid invoice)\b/i.test(text),
    signal: {
      category: 'RECEIPTS',
      recommendedAction: 'ARCHIVE_RECOMMENDED',
      confidence: 0.91,
      reasonCodes: ['RECEIPT_TERMS'],
      explanation: 'The metadata contains strong receipt terminology.',
    },
  },
  {
    test: (_input, text) =>
      /\b(order confirmed|order shipped|delivery|tracking number)\b/i.test(text),
    signal: {
      category: 'ORDERS',
      recommendedAction: 'KEEP_IN_INBOX',
      confidence: 0.86,
      reasonCodes: ['ORDER_TERMS'],
      explanation: 'The metadata contains order or delivery terminology.',
    },
  },
  {
    test: (input, text) =>
      input.senderLocalPartCategory === 'automated' &&
      /\b(security|sign[ -]?in|login|password|verification code|suspicious)\b/i.test(text),
    signal: {
      category: 'SECURITY',
      recommendedAction: 'IMPORTANT_RECOMMENDED',
      confidence: 0.89,
      reasonCodes: ['AUTOMATED_SENDER', 'SECURITY_TERMS'],
      explanation: 'An automated sender and security terminology are both present.',
    },
  },
  {
    test: (input) => /\.(edu|ac\.[a-z]{2})$/i.test(input.senderDomain),
    signal: {
      category: 'EDUCATION',
      recommendedAction: 'KEEP_IN_INBOX',
      confidence: 0.82,
      reasonCodes: ['EDUCATION_DOMAIN'],
      explanation: 'The sender domain has an educational institution suffix.',
    },
  },
  {
    test: (_input, text) => /\b(newsletter|weekly digest|monthly digest|unsubscribe)\b/i.test(text),
    signal: {
      category: 'NEWSLETTERS',
      recommendedAction: 'UNSUBSCRIBE_CANDIDATE',
      confidence: 0.79,
      reasonCodes: ['NEWSLETTER_TERMS'],
      explanation: 'Newsletter or subscription terminology appears in the metadata.',
    },
  },
];

export function evaluateClassificationRules(input: ClassificationInput): RuleSignal[] {
  const text = `${input.subject} ${input.senderDisplayName} ${input.snippet}`;
  return ruleDefinitions.filter((rule) => rule.test(input, text)).map((rule) => rule.signal);
}
