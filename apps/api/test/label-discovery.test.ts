import { describe, expect, it } from 'vitest';

import { calculateLabelConfidence } from '../src/features/label-discovery/label-confidence.js';
import {
  candidateHash,
  discoverDeterministicCandidates,
} from '../src/features/label-discovery/label-discovery.engine.js';
import {
  buildControlledLabelPath,
  displayNameForDomain,
  emailIdentity,
  isGenericLabelName,
  isTemporarySubject,
  labelsAreSimilar,
  normalizeDisplayName,
  normalizeLabelForComparison,
  normalizeSubjectPattern,
  validateLeafName,
} from '../src/features/label-discovery/label-normalization.js';
import { validateLabelCandidateModelOutput } from '../src/features/label-discovery/label-provider.validation.js';
import type {
  DiscoveryMessage,
  DiscoveryPreferences,
} from '../src/features/label-discovery/label-discovery.types.js';

const preferences: DiscoveryPreferences = {
  minMessages: 3,
  lookbackDays: 90,
  maxCandidates: 20,
  allowedCandidateTypes: ['SOURCE', 'ORGANIZATION', 'TOPIC', 'SUBSCRIPTION', 'PROJECT', 'WORKFLOW'],
  preferOrganizations: true,
  preferTopics: true,
};
const now = new Date();

function message(id: string, input: Partial<DiscoveryMessage> = {}): DiscoveryMessage {
  return {
    id,
    gmailThreadId: `thread-${id}`,
    internalDate: new Date(now.getTime() - Number(id) * 86_400_000),
    subject: `GitHub activity digest ${id}`,
    senderName: 'GitHub',
    senderEmail: `notifications@github.com`,
    gmailLabels: ['CATEGORY_UPDATES'],
    category: 'NOTIFICATIONS',
    correctedCategory: null,
    ...input,
  };
}

describe('label discovery normalization', () => {
  it('extracts public-suffix-aware registrable domains', () => {
    expect(emailIdentity('alerts@mail.company.co.uk').registrableDomain).toBe('company.co.uk');
    expect(emailIdentity('notifications@github.com').registrableDomain).toBe('github.com');
  });

  it('normalizes automated senders and recognizable display names', () => {
    expect(emailIdentity('no-reply@github.com').automated).toBe(true);
    expect(normalizeDisplayName('Notifications GitHub Inc.')).toBe('GitHub');
    expect(displayNameForDomain('github.com')).toBe('GitHub');
  });

  it('normalizes recurring subjects without storing codes', () => {
    expect(normalizeSubjectPattern('Re: Login code 12345678 for 2026')).toBe(
      'login code [number] for [date]',
    );
    expect(isTemporarySubject('Your one-time verification code')).toBe(true);
  });

  it('builds only the controlled three-level hierarchy', () => {
    expect(buildControlledLabelPath('SOURCE', 'GitHub')).toBe('MailMind/Sources/GitHub');
    expect(() => validateLeafName('INBOX')).toThrow('LABEL_CANDIDATE_NAME_INVALID');
    expect(() => validateLeafName('Unsafe/Child')).toThrow('LABEL_CANDIDATE_NAME_INVALID');
    expect(() => validateLeafName('🔐 Security')).toThrow('LABEL_CANDIDATE_NAME_INVALID');
  });

  it('normalizes duplicate punctuation and detects conservative similarity', () => {
    expect(normalizeLabelForComparison('MailMind/Sources/Git Hub')).toBe('github');
    expect(labelsAreSimilar('Git Hub', 'GitHub')).toBe(true);
    expect(labelsAreSimilar('GitHub', 'GitLab')).toBe(false);
    expect(isGenericLabelName('Notifications')).toBe(true);
  });
});

describe('deterministic label discovery', () => {
  it('requires volume plus consistency and discovers a stable source group', () => {
    const discovery = discoverDeterministicCandidates(
      [message('1'), message('2'), message('3'), message('4')],
      preferences,
      {
        minCategoryAgreement: 0.7,
        minSourceAgreement: 0.7,
        minimumConfidence: 0.6,
        existingLabelNames: [],
      },
    );
    expect(discovery.groups.some((group) => group.sourceKey === 'github.com')).toBe(true);
    expect(discovery.groups[0]?.reasonCodes).toContain('DOMAIN_CONSISTENCY');
  });

  it('does not create candidates from volume with mixed categories', () => {
    const messages = [
      message('1', { category: 'WORK' }),
      message('2', { category: 'FINANCE' }),
      message('3', { category: 'TRAVEL' }),
    ];
    const discovery = discoverDeterministicCandidates(messages, preferences, {
      minCategoryAgreement: 0.7,
      minSourceAgreement: 0.7,
      minimumConfidence: 0.6,
      existingLabelNames: [],
    });
    expect(discovery.groups.filter((group) => group.sourceKey === 'github.com')).toHaveLength(0);
  });

  it('discovers topics from multiple related subject patterns', () => {
    const messages = [
      message('1', { subject: 'Application received', category: 'WORK' }),
      message('2', { subject: 'Interview invitation', category: 'WORK' }),
      message('3', { subject: 'Recruiter follow-up', category: 'WORK' }),
      message('4', { subject: 'Application update', category: 'WORK' }),
    ];
    const discovery = discoverDeterministicCandidates(messages, preferences, {
      minCategoryAgreement: 0.7,
      minSourceAgreement: 0.7,
      minimumConfidence: 0.55,
      existingLabelNames: [],
    });
    expect(discovery.groups.some((group) => group.suggestedLeafName === 'Job Applications')).toBe(
      true,
    );
  });

  it('detects subscription groups from automated promotional sources', () => {
    const messages = [message('1'), message('2'), message('3'), message('4')].map((item) => ({
      ...item,
      senderEmail: 'newsletter@netflix.com',
      senderName: 'Netflix',
      category: 'NEWSLETTERS' as const,
      gmailLabels: ['CATEGORY_PROMOTIONS'],
    }));
    const discovery = discoverDeterministicCandidates(messages, preferences, {
      minCategoryAgreement: 0.7,
      minSourceAgreement: 0.7,
      minimumConfidence: 0.55,
      existingLabelNames: [],
    });
    expect(discovery.groups.some((group) => group.candidateType === 'SUBSCRIPTION')).toBe(true);
  });

  it('penalizes temporary groups and existing-label duplicates', () => {
    const temporary = [message('1'), message('2'), message('3')].map((item) => ({
      ...item,
      subject: 'Your one-time verification code',
      gmailThreadId: 'one-thread',
    }));
    const discovery = discoverDeterministicCandidates(temporary, preferences, {
      minCategoryAgreement: 0.7,
      minSourceAgreement: 0.7,
      minimumConfidence: 0.5,
      existingLabelNames: ['MailMind/Sources/GitHub'],
    });
    expect(discovery.groups).toHaveLength(0);
  });

  it('enforces maximum candidates and hashes stable group identities', () => {
    expect(candidateHash('SOURCE', 'github.com')).toBe(candidateHash('SOURCE', 'github.com'));
    expect(candidateHash('SOURCE', 'github.com')).not.toBe(
      candidateHash('ORGANIZATION', 'github.com'),
    );
    const limited = discoverDeterministicCandidates(
      [message('1'), message('2'), message('3'), message('4')],
      { ...preferences, maxCandidates: 1 },
      {
        minCategoryAgreement: 0.7,
        minSourceAgreement: 0.7,
        minimumConfidence: 0.5,
        existingLabelNames: [],
      },
    );
    expect(limited.groups.length).toBeLessThanOrEqual(1);
  });
});

describe('confidence and optional provider validation', () => {
  it('calculates a bounded deterministic score with penalties', () => {
    const base = {
      sourceConsistency: 1,
      messageCount: 10,
      minimumMessages: 3,
      categoryAgreement: 1,
      recent: true,
      threadCount: 5,
      namingConfidence: 1,
      userCorrectionSupport: 0.4,
      temporary: false,
      generic: false,
      existingLabelSimilarity: false,
      sparseDistribution: false,
    };
    const strong = calculateLabelConfidence(base);
    const penalized = calculateLabelConfidence({
      ...base,
      temporary: true,
      generic: true,
    });
    expect(strong).toBeGreaterThan(penalized);
    expect(strong).toBeLessThanOrEqual(1);
  });

  it('strictly validates model output and drops unknown merge keys', () => {
    const output = validateLabelCandidateModelOutput(
      {
        suggestedLeafName: 'GitHub',
        candidateType: 'SOURCE',
        confidence: 0.9,
        shouldCreate: true,
        mergeGroupKeys: ['github.com', 'unknown.example'],
        reasonCodes: ['DOMAIN_CONSISTENCY'],
      },
      new Set(['github.com']),
    );
    expect(output.mergeGroupKeys).toEqual(['github.com']);
    expect(() =>
      validateLabelCandidateModelOutput(
        { ...output, arbitraryPath: 'Unsafe/Root' },
        new Set(['github.com']),
      ),
    ).toThrow('LABEL_DISCOVERY_INVALID_PROVIDER_RESPONSE');
  });
});
