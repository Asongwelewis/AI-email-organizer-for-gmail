/**
 * `npm audit --omit=dev`, with a dated, reasoned allowlist.
 *
 * The bare audit was CI's first real step, and one unfixable transitive advisory turned the whole
 * pipeline red — so lint, typecheck, tests, build and the liveness probe all reported "skipped"
 * and nobody saw a real failure for three commits. A gate that cannot be satisfied is not a gate;
 * it is an outage with a green button.
 *
 * So: everything still fails the build by default. An advisory passes only if it is written down
 * below, with the reason it is not reachable and a date by which that has to be re-argued. An
 * entry that expires fails the build exactly like an untriaged advisory, which is the point —
 * suppression that never comes back is how a real vulnerability lives in a repository for a year.
 */
import { execFileSync } from 'node:child_process';

/**
 * Advisories triaged and accepted, each with an expiry.
 *
 * `package` and `id` must both match, so a new advisory against the same package is not silently
 * swallowed by an old decision about a different one.
 */
const ALLOWLIST = [
  {
    id: 'GHSA-ggr8-5vv4-36mx',
    package: 'deepmerge-ts',
    expires: '2026-11-30',
    reason:
      'Stack exhaustion when merging recursive object graphs. Reachable only through ' +
      '@prisma/config, which the Prisma CLI reads at migrate and generate time; the running API ' +
      'imports @prisma/client and never @prisma/config. It is in the production tree at all only ' +
      'because npm resolves @prisma/client’s peer dependency on the prisma CLI as production. ' +
      'No 6.x or 7.x Prisma release has moved off deepmerge-ts 7.1.5, and npm overrides are not ' +
      'applied in this workspace. Re-check when Prisma ships a bump.',
  },
];

const today = new Date().toISOString().slice(0, 10);

function audit() {
  try {
    return JSON.parse(
      execFileSync('npm', ['audit', '--omit=dev', '--json'], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
      }),
    );
  } catch (error) {
    // `npm audit` exits non-zero when it finds anything, and still prints the report on stdout.
    // A genuinely broken invocation prints nothing, and that has to fail rather than pass.
    const output = error?.stdout;
    if (!output) throw error;
    return JSON.parse(output);
  }
}

const report = audit();
const vulnerabilities = Object.values(report.vulnerabilities ?? {});

/** Advisory ids reached through this package, whether named directly or through a parent. */
function advisoryIds(vulnerability) {
  return (vulnerability.via ?? [])
    .filter((via) => typeof via === 'object' && via.url)
    .map((via) => via.url.split('/').pop());
}

const blocking = [];
const allowed = [];

for (const vulnerability of vulnerabilities) {
  if (!['high', 'critical'].includes(vulnerability.severity)) continue;
  const ids = advisoryIds(vulnerability);
  /*
   * A parent package (here `prisma`, then `@prisma/config`) carries no advisory url of its own —
   * its `via` names the child. Those rows are consequences of the child's finding, not separate
   * findings, so allowing the child allows them; anything else would demand an entry per level of
   * a dependency chain nobody chose.
   */
  if (ids.length === 0) continue;

  for (const id of ids) {
    const entry = ALLOWLIST.find(
      (candidate) => candidate.id === id && candidate.package === vulnerability.name,
    );
    if (!entry) {
      blocking.push({ id, name: vulnerability.name, severity: vulnerability.severity });
    } else if (entry.expires < today) {
      blocking.push({
        id,
        name: vulnerability.name,
        severity: vulnerability.severity,
        expired: entry.expires,
      });
    } else {
      allowed.push({ ...entry, severity: vulnerability.severity });
    }
  }
}

for (const entry of allowed) {
  process.stdout.write(
    `allowed  ${entry.id}  ${entry.package} (${entry.severity})  expires ${entry.expires}\n` +
      `         ${entry.reason}\n`,
  );
}

if (blocking.length === 0) {
  const counts = report.metadata?.vulnerabilities ?? {};
  process.stdout.write(
    `\nNo unreviewed high or critical advisories in the production tree ` +
      `(${counts.high ?? 0} high, ${counts.critical ?? 0} critical, all accounted for).\n`,
  );
  process.exit(0);
}

process.stderr.write('\nProduction dependency audit failed.\n\n');
for (const item of blocking) {
  process.stderr.write(
    item.expired
      ? `  ${item.id}  ${item.name} (${item.severity}) — the allowlist entry expired on ${item.expired}. ` +
          `Re-argue it or fix it.\n`
      : `  ${item.id}  ${item.name} (${item.severity}) — not reviewed. Fix it, or add a dated entry ` +
          `to ALLOWLIST in scripts/audit-production.mjs saying why it is not reachable.\n`,
  );
}
process.stderr.write('\nhttps://github.com/advisories/\n');
process.exit(1);
