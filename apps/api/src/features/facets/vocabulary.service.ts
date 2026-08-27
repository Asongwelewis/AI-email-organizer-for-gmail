import { auditService } from '@api/audit/audit.service.js';
import { prisma } from '@api/database/prisma.js';
import {
  activityRepository,
  type ActivityRepository,
} from '@api/features/activity/activity.repository.js';
import {
  facetVocabularyRepository,
  type AccountVocabulary,
  type FacetVocabularyRepository,
  type VocabularyDraft,
} from '@api/features/label-discovery/facet-vocabulary.repository.js';
import {
  geminiFacetVocabularyGrounder,
  type FacetEvidenceMessage,
  type FacetVocabularyGrounder,
  type FacetVocabularyReport,
} from '@api/features/label-discovery/facet-vocabulary.js';
import { APPROVED_FACET_VOCABULARY } from '@api/features/label-discovery/facets.js';

/**
 * Propose → confirm, for the vocabulary a mailbox is classified against.
 *
 * The same shape as the folder tree, for the same reason: a taxonomy that starts being used
 * without anybody agreeing to it is the thing this codebase refuses to do. A proposal is grounded
 * in the mailbox's own mail and written as PROPOSED, where the classifier cannot see it. Only an
 * approval moves it.
 *
 * **The starter set is a starting point, not an inheritance.** A mailbox with nothing approved is
 * proposed the checked-in vocabulary, grounded against its own mail so the values that fit nothing
 * come back at zero weight with no examples. Approving is where it becomes theirs, and editing
 * before approving is the point of the step existing.
 */

export interface VocabularyProposal extends FacetVocabularyReport {
  /** What the classifier speaks today. Empty when this mailbox has never approved a vocabulary. */
  approved: AccountVocabulary;
}

export class VocabularyService {
  constructor(
    private readonly vocabularies: FacetVocabularyRepository = facetVocabularyRepository,
    private readonly grounder: FacetVocabularyGrounder = geminiFacetVocabularyGrounder,
    private readonly accounts: ActivityRepository = activityRepository,
  ) {}

  /** The approved set, the pending proposal, and whether the classifier can run at all. */
  async overview(userId: string) {
    const account = await this.accounts.activeAccountForUser(userId);
    const [approved, proposed] = await Promise.all([
      this.vocabularies.approved(account.id),
      this.vocabularies.proposed(account.id),
    ]);
    return {
      approved,
      proposed,
      /** The classifier refuses until both axes have at least one approved value. */
      ready: approved.domain.length > 0 && approved.intent.length > 0,
    };
  }

  /**
   * Grounds a candidate vocabulary in this mailbox's own mail and records it as a proposal.
   *
   * One Gemini call, and it writes nothing the classifier can read. The candidate set is the
   * account's own approved vocabulary when it has one — so re-proposing measures how well the
   * current set still fits — and the starter set when it does not.
   */
  async propose(userId: string): Promise<VocabularyProposal> {
    const account = await this.accounts.activeAccountForUser(userId);
    const approved = await this.vocabularies.approved(account.id);
    const candidate =
      approved.domain.length > 0 && approved.intent.length > 0
        ? approved
        : APPROVED_FACET_VOCABULARY;

    const report = await this.grounder.ground({
      messages: await this.evidence(account.id),
      vocabulary: candidate,
    });

    await this.vocabularies.propose(
      account.id,
      (['domain', 'intent'] as const).flatMap((facet) =>
        report[facet].map((value) => ({
          facet,
          name: value.name,
          definition: value.definition,
        })),
      ),
    );
    await auditService.record({
      action: 'facets.vocabulary.proposed',
      result: 'INFO',
      userId,
      metadata: {
        domainValues: report.domain.length,
        intentValues: report.intent.length,
        sampled: report.sample.sampled,
        findings: report.findings.length,
      },
    });
    return { ...report, approved };
  }

  /**
   * Approves a vocabulary. The only step after which the classifier speaks differently.
   *
   * Mail already classified is not touched: `prompt_version` carries a fingerprint of the
   * vocabulary, so every affected message simply reads as stale and re-classifies on the next
   * pass. Deleting those rows here would empty the folders in front of the person who just
   * approved something.
   */
  async approve(userId: string, values: VocabularyDraft[]): Promise<AccountVocabulary> {
    const account = await this.accounts.activeAccountForUser(userId);
    const before = await this.vocabularies.approved(account.id);
    const approved = await this.vocabularies.approve(account.id, values);
    await auditService.record({
      action: 'facets.vocabulary.approved',
      result: 'SUCCESS',
      userId,
      metadata: {
        domainValues: approved.domain.length,
        intentValues: approved.intent.length,
        replacedDomainValues: before.domain.length,
        replacedIntentValues: before.intent.length,
      },
    });
    return approved;
  }

  /**
   * The mail a grounding reads. Metadata only, exactly as everywhere else, and the previous
   * classifier's filing decision alongside it — mail that reached no folder is the interesting
   * half, because it is what a vocabulary is failing to describe.
   */
  private async evidence(accountId: string): Promise<FacetEvidenceMessage[]> {
    const rows = await prisma.gmail_message_metadata.findMany({
      where: {
        connected_google_account_id: accountId,
        deleted_at: null,
        is_trashed: false,
        is_draft: false,
        sender_email: { not: null },
      },
      orderBy: { internal_date: 'desc' },
      take: 20_000,
      select: {
        id: true,
        subject: true,
        sender_email: true,
        sender_name: true,
        internal_date: true,
        automationAction: { select: { label_path: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      senderEmail: row.sender_email ?? '',
      senderName: row.sender_name,
      internalDate: row.internal_date,
      filedPath: row.automationAction?.label_path ?? null,
    }));
  }
}

export const vocabularyService = new VocabularyService();
