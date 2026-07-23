import { createHash } from 'node:crypto';
import type { classification_category } from '@prisma/client';

import { calculateLabelConfidence } from './label-confidence.js';
import {
  displayNameForDomain,
  emailIdentity,
  isGenericLabelName,
  isTemporarySubject,
  labelsAreSimilar,
  normalizeDisplayName,
  normalizeSubjectPattern,
} from './label-normalization.js';
import {
  LABEL_DISCOVERY_VERSION,
  LABEL_NAMING_VERSION,
  type LabelCandidateType,
  type LabelReasonCode,
} from './label-discovery.taxonomy.js';
import type {
  CandidateGroup,
  DiscoveryMessage,
  DiscoveryPreferences,
} from './label-discovery.types.js';

interface EngineOptions {
  minCategoryAgreement: number;
  minSourceAgreement: number;
  minimumConfidence: number;
  existingLabelNames: string[];
}

interface TopicDefinition {
  key: string;
  name: string;
  pattern: RegExp;
  categories: classification_category[];
}

const TOPICS: TopicDefinition[] = [
  {
    key: 'job-applications',
    name: 'Job Applications',
    pattern: /\b(application|applicant|interview|recruiter|candidate|job opportunity)\b/i,
    categories: ['WORK', 'NOTIFICATIONS'],
  },
  {
    key: 'receipts',
    name: 'Receipts',
    pattern: /\b(receipt|invoice|payment confirmation|order paid|payment received)\b/i,
    categories: ['RECEIPTS', 'ORDERS', 'FINANCE'],
  },
  {
    key: 'security-alerts',
    name: 'Security Alerts',
    pattern: /\b(security|sign[- ]in|login|verification|password|suspicious activity)\b/i,
    categories: ['SECURITY', 'NOTIFICATIONS'],
  },
  {
    key: 'travel-plans',
    name: 'Travel Plans',
    pattern: /\b(flight|hotel|reservation|booking|itinerary|boarding)\b/i,
    categories: ['TRAVEL'],
  },
  {
    key: 'support-requests',
    name: 'Support Requests',
    pattern: /\b(support|ticket|case|request received|help desk)\b/i,
    categories: ['SUPPORT'],
  },
];

export function discoverDeterministicCandidates(
  messages: DiscoveryMessage[],
  preferences: DiscoveryPreferences,
  options: EngineOptions,
): { groups: CandidateGroup[]; rejectedByRules: number } {
  const domainGroups = groupByDomain(messages);
  const raw: CandidateGroup[] = [];
  let rejectedByRules = 0;

  for (const [domain, groupMessages] of domainGroups) {
    const candidate = buildDomainCandidate(domain, groupMessages, preferences, options);
    if (candidate) raw.push(candidate);
    else rejectedByRules += 1;
  }
  if (preferences.preferTopics && preferences.allowedCandidateTypes.includes('TOPIC')) {
    for (const topic of TOPICS) {
      const matching = messages.filter((message) => {
        const subject = normalizeSubjectPattern(message.subject);
        const category = message.correctedCategory ?? message.category;
        return (
          topic.pattern.test(subject) || (category ? topic.categories.includes(category) : false)
        );
      });
      if (matching.length === 0) continue;
      const candidate = buildTopicCandidate(topic, matching, preferences, options);
      if (candidate) raw.push(candidate);
      else rejectedByRules += 1;
    }
  }

  return {
    groups: raw
      .sort(
        (left, right) =>
          right.confidence - left.confidence || right.messageCount - left.messageCount,
      )
      .slice(0, preferences.maxCandidates),
    rejectedByRules,
  };
}

function groupByDomain(messages: DiscoveryMessage[]): Map<string, DiscoveryMessage[]> {
  const groups = new Map<string, DiscoveryMessage[]>();
  for (const message of messages) {
    const domain = emailIdentity(message.senderEmail).registrableDomain;
    if (!domain) continue;
    const group = groups.get(domain) ?? [];
    group.push(message);
    groups.set(domain, group);
  }
  return groups;
}

function buildDomainCandidate(
  domain: string,
  messages: DiscoveryMessage[],
  preferences: DiscoveryPreferences,
  options: EngineOptions,
): CandidateGroup | null {
  if (messages.length < preferences.minMessages) return null;
  const category = dominantCategory(messages);
  const categoryAgreement = category.agreement;
  const sourceAgreement = 1;
  if (
    categoryAgreement < options.minCategoryAgreement ||
    sourceAgreement < options.minSourceAgreement
  ) {
    return null;
  }
  const senderAddresses = new Set(
    messages.map((message) => message.senderEmail?.toLowerCase()).filter(Boolean),
  );
  const automatedCount = messages.filter(
    (message) => emailIdentity(message.senderEmail).automated,
  ).length;
  const promotionalCount = messages.filter(
    (message) =>
      message.gmailLabels.some((label) =>
        ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES'].includes(label),
      ) ||
      ['NEWSLETTERS', 'PROMOTIONS'].includes(message.correctedCategory ?? message.category ?? ''),
  ).length;
  let candidateType: LabelCandidateType =
    preferences.preferOrganizations || senderAddresses.size > 1 ? 'ORGANIZATION' : 'SOURCE';
  if (
    automatedCount / messages.length >= 0.7 &&
    promotionalCount / messages.length >= 0.5 &&
    preferences.allowedCandidateTypes.includes('SUBSCRIPTION')
  ) {
    candidateType = 'SUBSCRIPTION';
  }
  if (!preferences.allowedCandidateTypes.includes(candidateType)) {
    if (preferences.allowedCandidateTypes.includes('SOURCE')) candidateType = 'SOURCE';
    else return null;
  }
  const display = dominantDisplayName(messages);
  const leafName = displayNameForDomain(domain, display.name);
  return finishGroup({
    candidateType,
    sourceKey: domain,
    suggestedLeafName: leafName,
    messages,
    category,
    sourceAgreement,
    displayNameAgreement: display.agreement,
    subjectPatternAgreement: dominantSubjectAgreement(messages),
    preferences,
    options,
  });
}

function buildTopicCandidate(
  topic: TopicDefinition,
  messages: DiscoveryMessage[],
  preferences: DiscoveryPreferences,
  options: EngineOptions,
): CandidateGroup | null {
  if (messages.length < preferences.minMessages) return null;
  const matchingPatterns = new Set(
    messages.map((message) => normalizeSubjectPattern(message.subject)).filter(Boolean),
  );
  if (matchingPatterns.size < 2) return null;
  const domains = messages
    .map((message) => emailIdentity(message.senderEmail).registrableDomain)
    .filter(Boolean);
  const sourceAgreement = dominantAgreement(domains);
  return finishGroup({
    candidateType: 'TOPIC',
    sourceKey: `topic:${topic.key}`,
    suggestedLeafName: topic.name,
    messages,
    category: dominantCategory(messages),
    sourceAgreement,
    displayNameAgreement: dominantDisplayName(messages).agreement,
    subjectPatternAgreement: dominantTopicAgreement(messages, topic.pattern),
    preferences,
    options,
  });
}

function finishGroup(input: {
  candidateType: LabelCandidateType;
  sourceKey: string;
  suggestedLeafName: string;
  messages: DiscoveryMessage[];
  category: { category: classification_category | null; agreement: number };
  sourceAgreement: number;
  displayNameAgreement: number;
  subjectPatternAgreement: number;
  preferences: DiscoveryPreferences;
  options: EngineOptions;
}): CandidateGroup | null {
  const dates = input.messages
    .map((message) => message.internalDate)
    .filter((date): date is Date => date !== null)
    .sort((left, right) => left.getTime() - right.getTime());
  const firstMessageAt = dates[0] ?? null;
  const lastMessageAt = dates.at(-1) ?? null;
  const recent =
    lastMessageAt !== null && Date.now() - lastMessageAt.getTime() <= 30 * 24 * 60 * 60 * 1000;
  const threads = new Set(input.messages.map((message) => message.gmailThreadId ?? message.id))
    .size;
  const temporaryRatio =
    input.messages.filter((message) => isTemporarySubject(message.subject)).length /
    input.messages.length;
  const shortSpan =
    firstMessageAt !== null &&
    lastMessageAt !== null &&
    lastMessageAt.getTime() - firstMessageAt.getTime() <= 2 * 24 * 60 * 60 * 1000;
  const temporary = temporaryRatio >= 0.7 || (shortSpan && threads <= 1);
  const generic = isGenericLabelName(input.suggestedLeafName);
  const existingSimilarity = input.options.existingLabelNames.some((name) =>
    labelsAreSimilar(name, input.suggestedLeafName),
  );
  const correctionCount = input.messages.filter(
    (message) => message.correctedCategory !== null,
  ).length;
  const userCorrectionSupport = Math.min(1, correctionCount / Math.max(input.messages.length, 1));
  const confidence = calculateLabelConfidence({
    sourceConsistency: input.sourceAgreement,
    messageCount: input.messages.length,
    minimumMessages: input.preferences.minMessages,
    categoryAgreement: input.category.agreement,
    recent,
    threadCount: threads,
    namingConfidence: input.displayNameAgreement || input.subjectPatternAgreement,
    userCorrectionSupport,
    temporary,
    generic,
    existingLabelSimilarity: existingSimilarity,
    sparseDistribution: Boolean(
      shortSpan && input.messages.length < input.preferences.minMessages * 2,
    ),
  });
  if (generic || temporary || existingSimilarity || confidence < input.options.minimumConfidence) {
    return null;
  }
  const reasonCodes: LabelReasonCode[] = ['SOURCE_VOLUME'];
  if (recent) reasonCodes.push('SOURCE_RECENCY');
  if (input.sourceAgreement >= 0.7) reasonCodes.push('DOMAIN_CONSISTENCY');
  if (input.displayNameAgreement >= 0.7) reasonCodes.push('DISPLAY_NAME_CONSISTENCY');
  if (input.category.agreement >= 0.7) reasonCodes.push('CATEGORY_AGREEMENT');
  if (input.subjectPatternAgreement >= 0.7) reasonCodes.push('SUBJECT_PATTERN_AGREEMENT');
  if (threads >= 2) reasonCodes.push('THREAD_DIVERSITY');
  if (
    input.messages.some((message) =>
      message.gmailLabels.some((label) => label.startsWith('CATEGORY_')),
    )
  ) {
    reasonCodes.push('EXISTING_GMAIL_CATEGORY');
  }
  if (userCorrectionSupport > 0) reasonCodes.push('USER_CORRECTION_SUPPORT');
  return {
    candidateType: input.candidateType,
    sourceKey: input.sourceKey,
    suggestedLeafName: input.suggestedLeafName,
    messageIds: input.messages.map((message) => message.id).sort(),
    messageCount: input.messages.length,
    threadCount: threads,
    firstMessageAt,
    lastMessageAt,
    dominantCategory: input.category.category,
    categoryAgreement: Number(input.category.agreement.toFixed(4)),
    sourceAgreement: Number(input.sourceAgreement.toFixed(4)),
    displayNameAgreement: Number(input.displayNameAgreement.toFixed(4)),
    subjectPatternAgreement: Number(input.subjectPatternAgreement.toFixed(4)),
    userCorrectionSupport,
    recent,
    temporary,
    generic,
    reasonCodes,
    confidence,
    inputHash: candidateHash(input.candidateType, input.sourceKey),
  };
}

function dominantCategory(messages: DiscoveryMessage[]): {
  category: classification_category | null;
  agreement: number;
} {
  const values = messages
    .map((message) => message.correctedCategory ?? message.category)
    .filter((value): value is classification_category => value !== null);
  if (values.length === 0) return { category: null, agreement: 0 };
  const counts = count(values);
  const [category, amount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { category, agreement: amount / messages.length };
}

function dominantDisplayName(messages: DiscoveryMessage[]): {
  name: string | null;
  agreement: number;
} {
  const values = messages
    .map((message) => normalizeDisplayName(message.senderName))
    .filter((value) => value.length >= 2);
  if (values.length === 0) return { name: null, agreement: 0 };
  const counts = count(values.map((value) => value.toLowerCase()));
  const [normalized, amount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return {
    name: values.find((value) => value.toLowerCase() === normalized) ?? normalized,
    agreement: amount / messages.length,
  };
}

function dominantSubjectAgreement(messages: DiscoveryMessage[]): number {
  const patterns = messages
    .map((message) => normalizeSubjectPattern(message.subject))
    .filter(Boolean);
  return dominantAgreement(patterns);
}

function dominantTopicAgreement(messages: DiscoveryMessage[], pattern: RegExp): number {
  return (
    messages.filter((message) => pattern.test(normalizeSubjectPattern(message.subject))).length /
    messages.length
  );
}

function dominantAgreement(values: string[]): number {
  if (values.length === 0) return 0;
  const maximum = Math.max(...count(values).values());
  return maximum / values.length;
}

function count<T>(values: T[]): Map<T, number> {
  const result = new Map<T, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

export function candidateHash(candidateType: LabelCandidateType, sourceKey: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        candidateType,
        sourceKey: sourceKey.toLowerCase(),
        discoveryVersion: LABEL_DISCOVERY_VERSION,
        namingVersion: LABEL_NAMING_VERSION,
      }),
    )
    .digest('hex');
}
