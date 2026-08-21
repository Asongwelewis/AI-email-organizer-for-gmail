/**
 * Assigns facets to stored mail for a connected account and reports what it cost.
 *
 * Writes `message_facets` and routing rules. Touches Gmail in no way at all — turning a facet
 * combination into a folder is the pivot's job, and until that lands nothing here is visible in
 * the mailbox.
 *
 *   npm run classify:facets --workspace @mailmind/api
 *   npm run classify:facets --workspace @mailmind/api -- --limit 250 --email you@example.com
 */
import { prisma } from '../src/database/prisma.js';
import { facetClassificationService } from '../src/features/automation/facet-classification.service.js';

const args = process.argv.slice(2);
const valueOf = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const email = valueOf('--email');
const limitArg = Number(valueOf('--limit'));
const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : undefined;

const write = (line = '') => process.stdout.write(`${line}\n`);
const per1000 = (tokens: number, messages: number) =>
  messages === 0 ? 0 : Math.round((tokens / messages) * 1000);

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

  // The label classifier's own history, so the token comparison is against what actually ran
  // rather than against an estimate of it.
  const previous = await prisma.automation_runs.aggregate({
    where: { connected_google_account_id: account.id },
    _sum: { input_tokens: true, output_tokens: true, ai_classified_count: true },
  });
  const previousMessages = previous._sum.ai_classified_count ?? 0;

  const counters = await facetClassificationService.classifyAccount(account.id, { limit });

  write(`Account ${account.email}`);
  write(
    `Seen ${counters.messagesSeen} unclassified messages: ` +
      `${counters.ruleDecided} decided by rule, ${counters.modelDecided} by model, ` +
      `${counters.failed} failed.`,
  );
  write(
    `Facets assigned — entity ${counters.entityAssigned}, domain ${counters.domainAssigned}, ` +
      `intent ${counters.intentAssigned}.`,
  );
  write(
    `Rules: ${counters.rulesLearned} learned this run; ` +
      `${counters.crossEntityRuleHits} hit(s) from a subject rule firing on an entity it was ` +
      'not learned on.',
  );
  if (counters.stoppedReason) write(`Stopped early: ${counters.stoppedReason}.`);
  if (counters.lastErrorCode) write(`Last error: ${counters.lastErrorCode}.`);
  write();

  const classified = counters.ruleDecided + counters.modelDecided;
  write('Tokens per 1,000 messages');
  write('─'.repeat(64));
  write(
    `  label classifier (previous)  ` +
      `${per1000(previous._sum.input_tokens ?? 0, previousMessages)} in / ` +
      `${per1000(previous._sum.output_tokens ?? 0, previousMessages)} out ` +
      `(over ${previousMessages} messages)`,
  );
  write(
    `  facet classifier (this run)  ` +
      `${per1000(counters.usage.inputTokens, classified)} in / ` +
      `${per1000(counters.usage.outputTokens, classified)} out ` +
      `(over ${classified} messages, ${counters.providerCalls} provider call(s))`,
  );
  write();
  write(
    `Raw: ${counters.usage.inputTokens} in / ${counters.usage.outputTokens} out ` +
      `(notional ${counters.costMicrousd} micro-USD; the free tier bills nothing).`,
  );
  write();
  write('Nothing was written to Gmail. This pass only assigns facets.');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
