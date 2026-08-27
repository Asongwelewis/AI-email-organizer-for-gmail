/**
 * The Phase 4 measurement: what facets changed, in numbers.
 *
 * Read-only. Everything here is computed from what is already stored — no Gemini call, no Gmail
 * call — so it can be re-run as often as you like and always describes the current state.
 *
 *   npm run report:facets --workspace @mailmind/api
 */
import { prisma } from '../src/database/prisma.js';
import { entityFor } from '../src/features/label-discovery/entity.js';
import { matchesRule } from '../src/features/label-discovery/routing-rules.js';
import { ALTERNATE_PIVOT, buildPivot } from '../src/features/label-discovery/pivot.js';
import { pivotService } from '../src/features/labels/pivot.service.js';

const write = (line = '') => process.stdout.write(`${line}\n`);
const pct = (part: number, whole: number) =>
  whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;
const per1000 = (tokens: number, messages: number) =>
  messages === 0 ? 0 : Math.round((tokens / messages) * 1000);

/** The mailbox as the previous, single-tree classifier left it. Quoted in every comparison. */
const BASELINE = { total: 9431, filed: 1332, none: 8099 };

function bucket(confidence: number): string {
  if (confidence >= 0.95) return '0.95+';
  if (confidence >= 0.9) return '0.90-0.94';
  if (confidence >= 0.8) return '0.80-0.89';
  if (confidence >= 0.6) return '0.60-0.79';
  return '<0.60';
}

const BUCKETS = ['0.95+', '0.90-0.94', '0.80-0.89', '0.60-0.79', '<0.60'];

function printDistribution(label: string, values: number[]): void {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(bucket(value), (counts.get(bucket(value)) ?? 0) + 1);
  const cells = BUCKETS.map((name) => {
    const count = counts.get(name) ?? 0;
    return `${name} ${String(count).padStart(5)} (${pct(count, values.length).padStart(6)})`;
  });
  write(`  ${label.padEnd(9)} n=${String(values.length).padStart(5)}  ${cells.join('   ')}`);
}

function printTree(title: string, result: ReturnType<typeof buildPivot>, limit: number): void {
  const leaves = result.nodes.filter((node) => node.isLeaf);
  const filed = result.nodes.reduce((total, node) => total + node.messageCount, 0);
  write(
    `${title}  [${result.order.join(' > ')}] — ${result.nodes.length} folders, ` +
      `${leaves.length} leaves, ${filed} filed, ${result.unfiled.total} unfiled`,
  );
  write('─'.repeat(78));
  const children = new Map<string | null, typeof result.nodes>();
  for (const node of result.nodes) {
    const bucketed = children.get(node.parentFacetKey) ?? [];
    bucketed.push(node);
    children.set(node.parentFacetKey, bucketed);
  }
  let shown = 0;
  const walk = (parent: string | null, indent: string): void => {
    const bucketed = [...(children.get(parent) ?? [])].sort(
      (left, right) => right.subtreeMessageCount - left.subtreeMessageCount,
    );
    for (const node of bucketed) {
      if (shown >= limit) return;
      shown += 1;
      const marker = node.isLeaf ? '📄' : '📁';
      const own = node.isLeaf ? `${node.messageCount}` : `${node.subtreeMessageCount} below`;
      write(`${indent}${marker} ${node.leafName}  (${own})`);
      walk(node.facetKey, `${indent}  `);
    }
  };
  walk(null, '');
  if (result.nodes.length > shown) write(`  … ${result.nodes.length - shown} more folders`);
  write();
}

async function main(): Promise<void> {
  const account = await prisma.connected_google_accounts.findFirst({
    where: { gmail_connected: true, connection_status: 'CONNECTED' },
    orderBy: { updated_at: 'desc' },
  });
  if (!account) {
    process.stderr.write('No connected Gmail account found.\n');
    process.exitCode = 1;
    return;
  }
  const where = { connected_google_account_id: account.id };

  // ── Coverage ────────────────────────────────────────────────────────────────────────────────
  const [applied, review, none, totalActions, facetCount] = await Promise.all([
    prisma.automation_message_actions.count({ where: { ...where, status: 'APPLIED' } }),
    prisma.automation_message_actions.count({ where: { ...where, status: 'REVIEW_REQUIRED' } }),
    prisma.automation_message_actions.count({ where: { ...where, label_name: 'NONE' } }),
    prisma.automation_message_actions.count({ where }),
    prisma.message_facets.count({ where }),
  ]);

  write(`Account ${account.email}`);
  write();
  write('COVERAGE');
  write('─'.repeat(78));
  write(
    `  before   ${BASELINE.total} messages: ${BASELINE.filed} filed ` +
      `(${pct(BASELINE.filed, BASELINE.total)}), ${BASELINE.none} NONE ` +
      `(${pct(BASELINE.none, BASELINE.total)}), 0 held for review`,
  );
  write(
    `  after    ${totalActions} messages: ${applied} filed (${pct(applied, totalActions)}), ` +
      `${none} NONE (${pct(none, totalActions)}), ${review} held for review ` +
      `(${pct(review, totalActions)})`,
  );
  write(`  ${facetCount} message(s) carry facets.`);
  write();

  // ── Tokens ──────────────────────────────────────────────────────────────────────────────────
  // Filing spends nothing, so a filing run's zero-token row would drag the average down; only runs
  // that actually called the model are counted on either side.
  const labelRuns = await prisma.automation_runs.aggregate({
    where: { ...where, ai_classified_count: { gt: 0 } },
    _sum: { input_tokens: true, output_tokens: true, ai_classified_count: true },
  });
  const labelMessages = labelRuns._sum.ai_classified_count ?? 0;
  const facetModelDecided = await prisma.message_facets.count({
    where: { ...where, source: 'MODEL' },
  });

  write('TOKENS PER 1,000 MESSAGES');
  write('─'.repeat(78));
  write(
    `  label classifier   ${per1000(labelRuns._sum.input_tokens ?? 0, labelMessages)} in / ` +
      `${per1000(labelRuns._sum.output_tokens ?? 0, labelMessages)} out ` +
      `(measured over ${labelMessages} messages)`,
  );
  write(
    `  facet classifier   see the classify:facets run output; ` +
      `${facetModelDecided} message(s) reached the model, ` +
      `${facetCount - facetModelDecided} were decided by rule and cost nothing`,
  );
  write();

  // ── Rules ───────────────────────────────────────────────────────────────────────────────────
  const facetRows = await prisma.message_facets.findMany({
    where,
    select: {
      entity: true,
      domain: true,
      intent: true,
      source: true,
      entity_confidence: true,
      domain_confidence: true,
      intent_confidence: true,
      gmail_message_id: true,
      message: { select: { subject: true, sender_email: true } },
    },
  });
  const rules = await prisma.learned_classification_patterns.findMany({
    where: {
      ...where,
      active: true,
      OR: [{ facet_domain: { not: null } }, { facet_intent: { not: null } }],
    },
  });
  const subjectRules = rules.filter((rule) => rule.rule_kind === 'SUBJECT_CONTAINS');

  // Recomputed from what is stored rather than taken from a run counter, so the number survives
  // however many runs it took to get here.
  let subjectRuleHits = 0;
  let crossEntityHits = 0;
  const crossEntityExamples: string[] = [];
  for (const row of facetRows) {
    const entity = row.entity ?? entityFor(row.message.sender_email);
    for (const rule of subjectRules) {
      if (
        !matchesRule(
          { kind: 'SUBJECT_CONTAINS', value: rule.match_value },
          { subject: row.message.subject, senderEmail: row.message.sender_email },
        )
      ) {
        continue;
      }
      subjectRuleHits += 1;
      if (rule.learned_from_entity && entity && rule.learned_from_entity !== entity) {
        crossEntityHits += 1;
        if (crossEntityExamples.length < 6) {
          crossEntityExamples.push(
            `"${rule.match_value}" → ${rule.facet_intent ?? rule.facet_domain} ` +
              `(learned on ${rule.learned_from_entity}, fired on ${entity})`,
          );
        }
      }
      break;
    }
  }

  const ruleDecided = facetRows.filter((row) => row.source === 'RULE').length;
  write('RULES');
  write('─'.repeat(78));
  write(
    `  ${rules.length} active facet rule(s): ${subjectRules.length} subject, ` +
      `${rules.length - subjectRules.length} sender.`,
  );
  write(
    `  ${ruleDecided} message(s) decided entirely by rule ` +
      `(${pct(ruleDecided, facetRows.length)} of the mailbox) — no model call.`,
  );
  write(
    `  ${subjectRuleHits} message(s) match a subject rule; ${crossEntityHits} of those ` +
      `(${pct(crossEntityHits, subjectRuleHits)}) fired on an entity the rule was NOT learned on.`,
  );
  for (const example of crossEntityExamples) write(`    · ${example}`);
  write();

  // ── Confidence ──────────────────────────────────────────────────────────────────────────────
  write('CONFIDENCE BY FACET');
  write('─'.repeat(78));
  printDistribution(
    'entity',
    facetRows.filter((row) => row.entity).map((row) => row.entity_confidence),
  );
  printDistribution(
    'domain',
    facetRows.flatMap((row) => (row.domain_confidence === null ? [] : [row.domain_confidence])),
  );
  printDistribution(
    'intent',
    facetRows.flatMap((row) => (row.intent_confidence === null ? [] : [row.intent_confidence])),
  );
  write();

  // ── Both trees ──────────────────────────────────────────────────────────────────────────────
  const settings = await pivotService.settings(account.id);
  const faceted = await pivotService.facetedMessages(account.id);
  printTree('CANONICAL', buildPivot(faceted, settings.canonicalPivot, settings), 45);
  printTree(
    'ALTERNATE (computed on read, never written to Gmail)',
    buildPivot(faceted, ALTERNATE_PIVOT, settings),
    45,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
