/**
 * Pivots facets into folders.
 *
 * Dry run by default: it prints the tree it would materialise, what it would create in Gmail, and
 * what would stay in the inbox — and writes nothing. `--apply` is the only mode that touches Gmail,
 * and even then it only ever CREATES leaf labels; it never deletes one and never unlabels mail.
 *
 *   npm run pivot:facets --workspace @mailmind/api
 *   npm run pivot:facets --workspace @mailmind/api -- --alternate
 *   npm run pivot:facets --workspace @mailmind/api -- --min 8
 *   npm run pivot:facets --workspace @mailmind/api -- --apply
 */
import { prisma } from '../src/database/prisma.js';
import {
  ALTERNATE_PIVOT,
  buildPivot,
  type PivotFacet,
  type PivotResult,
} from '../src/features/label-discovery/pivot.js';
import { pivotService } from '../src/features/labels/pivot.service.js';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const apply = has('--apply');
const showAlternate = has('--alternate') || !apply;
const email = valueOf('--email');
const minArg = Number(valueOf('--min'));
const minMessages = Number.isFinite(minArg) && minArg > 0 ? Math.floor(minArg) : undefined;
const pivotArg = valueOf('--pivot');

const write = (line = '') => process.stdout.write(`${line}\n`);

function printTree(title: string, result: PivotResult, limit = 40): void {
  const leaves = result.nodes.filter((node) => node.isLeaf);
  write(
    `${title}  [${result.order.join(' > ')}] — ${result.nodes.length} folders, ` +
      `${leaves.length} leaves`,
  );
  write('─'.repeat(78));
  const children = new Map<string | null, typeof result.nodes>();
  for (const node of result.nodes) {
    const bucket = children.get(node.parentFacetKey) ?? [];
    bucket.push(node);
    children.set(node.parentFacetKey, bucket);
  }
  let shown = 0;
  const walk = (parent: string | null, indent: string): void => {
    const bucket = [...(children.get(parent) ?? [])].sort(
      (left, right) => right.subtreeMessageCount - left.subtreeMessageCount,
    );
    for (const node of bucket) {
      if (shown >= limit) return;
      shown += 1;
      const marker = node.isLeaf ? '📄' : '📁';
      const own = node.isLeaf ? `${node.messageCount} filed` : `${node.subtreeMessageCount} below`;
      write(`${indent}${marker} ${node.leafName}  (${own})`);
      walk(node.facetKey, `${indent}  `);
    }
  };
  walk(null, '');
  if (result.nodes.length > shown) write(`  … ${result.nodes.length - shown} more not shown`);
  write(
    `  Unfiled: ${result.unfiled.total} ` +
      `(${result.unfiled.noFacetValue} with no facet value, ` +
      `${result.unfiled.belowThreshold} below the folder threshold). ` +
      `${result.collapsed} combination(s) collapsed.`,
  );
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

  if (pivotArg || minMessages !== undefined) {
    const order = pivotArg
      ? (pivotArg.split(',').map((part) => part.trim()) as PivotFacet[])
      : (await pivotService.settings(account.id)).canonicalPivot;
    await pivotService.setPivot(account.id, order, minMessages);
    write(`Canonical pivot set to [${order.join(' > ')}], minimum ${minMessages ?? 'unchanged'}.`);
    write();
  }

  const settings = await pivotService.settings(account.id);
  const messages = await pivotService.facetedMessages(account.id);
  write(
    `Account ${account.email}: ${messages.length} messages carry facets. ` +
      `Canonical pivot [${settings.canonicalPivot.join(' > ')}], ` +
      `folders below ${settings.minMessages} message(s) collapse.`,
  );
  write();

  printTree('CANONICAL', buildPivot(messages, settings.canonicalPivot, settings));
  if (showAlternate) {
    printTree(
      'ALTERNATE (computed on read, never written to Gmail)',
      buildPivot(messages, ALTERNATE_PIVOT, settings),
    );
  }

  const plan = await pivotService.plan(account.id);
  const creates = plan.changes.filter((change) => change.action === 'CREATE').length;
  write(
    `Plan: ${plan.changes.length} folders — ${creates} new row(s), ` +
      `${plan.changes.length - creates} existing row(s) reused. ` +
      `${plan.gmailLabelsToCreate} Gmail label(s) would be created.`,
  );
  if (plan.orphaned.length > 0) {
    write(
      `${plan.orphaned.length} existing folder(s) match no facet combination and are left alone:`,
    );
    for (const orphan of plan.orphaned.slice(0, 10)) write(`  - ${orphan.fullPath}`);
  }
  write();

  if (!apply) {
    write('Dry run. Nothing was written and Gmail was not called. Re-run with --apply.');
    return;
  }

  const result = await pivotService.apply(account.id, account.user_id);
  write(
    `Applied: ${result.rowsCreated} folder row(s) created, ${result.rowsKept} reused; ` +
      `${result.gmailLabelsCreated} Gmail label(s) created, ` +
      `${result.gmailLabelsReused} reused.`,
  );
  write('No mail was labelled and no label was deleted.');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
