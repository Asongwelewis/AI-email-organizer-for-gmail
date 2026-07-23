import {
  CLASSIFICATION_CATEGORIES,
  PROMPT_VERSION,
  RECOMMENDED_ACTIONS,
  TAXONOMY_VERSION,
} from './classification-taxonomy.js';

export function buildClassificationPrompt(): string {
  return [
    `MailMind email metadata classifier (${PROMPT_VERSION}, ${TAXONOMY_VERSION}).`,
    `Categories: ${CLASSIFICATION_CATEGORIES.join(', ')}.`,
    `Actions: ${RECOMMENDED_ACTIONS.join(', ')}.`,
    'Use only supplied metadata; never invent message content or treat a sender name as verified identity.',
    'Return only JSON with category, recommendedAction, confidence (0..1), reasonCodes, explanation, requiresReview.',
    'When evidence is weak use OTHER, REVIEW_REQUIRED, and requiresReview=true.',
    'SPAM_SUSPECTED is uncertain review advice, never a definitive spam determination.',
  ].join('\n');
}
