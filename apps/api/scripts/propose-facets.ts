/**
 * Designs the domain and intent facet vocabularies from the mail already stored for a connected
 * account and prints them with counts and example subjects.
 *
 * Strictly read-only. It reads gmail_message_metadata and the automation decision attached to each
 * message, calls Gemini once, and writes nothing — no database rows, no Gmail labels, no plan.
 * Phase 1 exists to put a vocabulary in front of a human, not to create anything.
 *
 *   npm run propose:facets --workspace @mailmind/api
 *   npm run propose:facets --workspace @mailmind/api -- --email you@example.com
 */
import { prisma } from '../src/database/prisma.js';
import {
  geminiFacetVocabularyPlanner,
  type FacetEvidenceMessage,
  type FacetValue,
} from '../src/features/label-discovery/facet-vocabulary.js';
import { emailIdentity } from '../src/features/label-discovery/label-normalization.js';
import { labelsRepository } from '../src/features/labels/labels.repository.js';

const args = process.argv.slice(2);
const emailIndex = args.indexOf('--email');
const email = emailIndex >= 0 ? args[emailIndex + 1] : undefined;

const write = (line = '') => process.stdout.write(`${line}\n`);

function percent(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;
}

function printFacet(title: string, values: FacetValue[], population: number): void {
  const estimated = values.reduce((total, value) => total + value.estimatedMessageCount, 0);
  write(
    `${title} — ${values.length} values, ${estimated} estimated messages ` +
      `(${percent(estimated, population)} of the mailbox)`,
  );
  write('─'.repeat(78));
  for (const value of values) {
    const grounded =
      value.groundedExampleCount === value.exampleSubjects.length
        ? ''
        : ` [${value.groundedExampleCount}/${value.exampleSubjects.length} examples verified]`;
    write(`  ${value.name.padEnd(24)} ~${value.estimatedMessageCount} messages${grounded}`);
    write(`    ${value.definition}`);
    for (const subject of value.exampleSubjects) write(`      · ${subject}`);
    write();
  }
}

/**
 * The entity facet is derived, not proposed, so it costs no model call. Printing the head of it
 * here shows what the third axis will look like before any of it is built.
 */
function printEntities(messages: FacetEvidenceMessage[], limit = 15): void {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const identity = emailIdentity(message.senderEmail);
    const entity = identity.registrableDomain.split('.')[0];
    if (!entity) continue;
    counts.set(entity, (counts.get(entity) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
  write(
    `entity (derived from sender domain, no model call) — ${counts.size} distinct, top ${top.length}`,
  );
  write('─'.repeat(78));
  write(`  ${top.map(([entity, count]) => `${entity} (${count})`).join(', ')}`);
  write();
}

async function main(): Promise<void> {
  const account = await prisma.connected_google_accounts.findFirst({
    where: {
      gmail_connected: true,
      connection_status: 'CONNECTED',
      ...(email ? { email } : {}),
    },
    orderBy: { updated_at: 'desc' },
  });
  if (!account) {
    process.stderr.write('No connected Gmail account found.\n');
    process.exitCode = 1;
    return;
  }

  const records = await labelsRepository.facetEvidenceMessages(account.id);
  const messages: FacetEvidenceMessage[] = records.map((record) => ({
    id: record.id,
    subject: record.subject,
    senderName: record.sender_name,
    senderEmail: record.sender_email,
    internalDate: record.internal_date,
    filedPath: record.automationAction?.label_path ?? null,
  }));
  const filed = messages.filter((message) => message.filedPath).length;
  write(
    `Account ${account.email}: ${messages.length} eligible stored messages — ` +
      `${filed} filed (${percent(filed, messages.length)}), ` +
      `${messages.length - filed} unfiled (${percent(messages.length - filed, messages.length)}).`,
  );
  write();

  const proposal = await geminiFacetVocabularyPlanner.propose({ messages });
  write(
    `Sampled ${proposal.sample.sampled} messages across ${proposal.sample.senderDomains} sender ` +
      `domains: ${proposal.sample.fromUnfiled} unfiled, ${proposal.sample.fromFiled} filed. ` +
      `Proposed by ${proposal.model} (${proposal.promptVersion}).`,
  );
  write();

  printFacet('domain', proposal.domain, proposal.population.total);
  printFacet('intent', proposal.intent, proposal.population.total);
  printEntities(messages);

  if (proposal.warnings.length > 0) {
    write('Rejected by the validator:');
    for (const warning of proposal.warnings) write(`  - ${warning}`);
    write();
  }
  write(
    `Tokens: ${proposal.usage.inputTokens} in / ${proposal.usage.outputTokens} out ` +
      `(notional ${proposal.estimatedCostMicrousd} micro-USD; the free tier bills nothing).`,
  );
  write();
  write('Nothing was written. No labels, no rules, no plan — this run only proposes a vocabulary.');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
