/**
 * Runs the taxonomy planner against the mail already stored for a connected account and prints
 * the proposed tree with counts.
 *
 * Read-only by default: it reads gmail_message_metadata, calls Gemini once, and writes nothing.
 * Nothing is ever created in Gmail from here — that only happens when a human confirms a plan
 * through POST /api/labels/confirm.
 *
 *   npm run plan:taxonomy --workspace @mailmind/api
 *   npm run plan:taxonomy --workspace @mailmind/api -- --email you@example.com --persist
 *
 * --persist stores the plan as the account's PENDING proposal, ready for review in the app.
 */
import { prisma } from '../src/database/prisma.js';
import { labelsRepository } from '../src/features/labels/labels.repository.js';
import {
  geminiTaxonomyPlanner,
  type PlannedNode,
  type PlannerMessage,
} from '../src/features/label-discovery/taxonomy-planner.js';

const args = process.argv.slice(2);
const persist = args.includes('--persist');
const emailIndex = args.indexOf('--email');
const email = emailIndex >= 0 ? args[emailIndex + 1] : undefined;

function tree(nodes: PlannedNode[]): void {
  const children = new Map<string | null, PlannedNode[]>();
  for (const node of nodes) {
    const bucket = children.get(node.parentPath) ?? [];
    bucket.push(node);
    children.set(node.parentPath, bucket);
  }
  const rolled = new Map<string, number>();
  for (const node of [...nodes].sort((left, right) => right.depth - left.depth)) {
    const total = node.matchedMessageCount + (rolled.get(node.path) ?? 0);
    rolled.set(node.path, total);
    if (node.parentPath) {
      rolled.set(node.parentPath, (rolled.get(node.parentPath) ?? 0) + total);
    }
  }
  const walk = (parentPath: string | null, indent: string): void => {
    for (const node of children.get(parentPath) ?? []) {
      const counts = `${rolled.get(node.path) ?? 0} matched / ${node.estimatedMessageCount} est.`;
      const marker = node.isLeaf ? '📄' : '📁';
      process.stdout.write(`${indent}${marker} ${node.name}  (${counts}) [${node.kind}]\n`);
      for (const rule of node.rules) {
        process.stdout.write(
          `${indent}     · ${rule.kind} "${rule.value}" → ${rule.matchedMessageCount}\n`,
        );
      }
      walk(node.path, `${indent}  `);
    }
  };
  walk(null, '');
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

  const [records, gmailLabelNames] = await Promise.all([
    labelsRepository.eligibleMessages(account.id),
    labelsRepository.existingGmailLabelNames(account.id),
  ]);
  process.stdout.write(
    `Account ${account.email}: ${records.length} eligible stored messages, ` +
      `${gmailLabelNames.length} existing Gmail labels.\n\n`,
  );

  const messages: PlannerMessage[] = records.map((message) => ({
    id: message.id,
    subject: message.subject,
    senderName: message.sender_name,
    senderEmail: message.sender_email,
    internalDate: message.internal_date,
  }));
  const plan = await geminiTaxonomyPlanner.plan({
    messages,
    existingGmailLabelNames: gmailLabelNames,
  });

  const leaves = plan.nodes.filter((node) => node.isLeaf);
  process.stdout.write(
    `Planned ${plan.nodes.length} folders (${leaves.length} leaves) from a sample of ` +
      `${plan.sampledMessageCount} of ${plan.analyzedMessageCount} messages ` +
      `using ${plan.model}.\n\n`,
  );
  tree(plan.nodes);

  const routed = new Set<string>();
  for (const node of plan.nodes) {
    for (const rule of node.rules) routed.add(`${rule.kind}:${rule.value}`);
  }
  process.stdout.write(
    `\n${routed.size} routing rules cover ${plan.nodes.reduce((total, node) => total + node.matchedMessageCount, 0)} ` +
      `of the ${plan.sampledMessageCount} sampled messages; the rest fall back to the model.\n`,
  );
  process.stdout.write(
    `Tokens: ${plan.usage.inputTokens} in / ${plan.usage.outputTokens} out ` +
      `(notional ${plan.estimatedCostMicrousd} micro-USD; the free tier bills nothing).\n`,
  );
  if (plan.warnings.length > 0) {
    process.stdout.write(`\nRejected by the validator:\n`);
    for (const warning of plan.warnings) process.stdout.write(`  - ${warning}\n`);
  }

  if (persist) {
    const planId = await labelsRepository.storePlan(account.id, plan);
    process.stdout.write(`\nStored as pending plan ${planId}. Nothing was created in Gmail.\n`);
  } else {
    process.stdout.write(`\nDry run: nothing was written. Re-run with --persist to store it.\n`);
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
