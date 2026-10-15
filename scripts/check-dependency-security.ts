/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  checkCallPathAssumptions,
  checkAuditNodes,
  checkExportedBundles,
  installedCopyPaths,
  evaluateAudit,
  type AdvisoryException,
  type AuditReport,
} from './dependencySecurity';

// Usage: tsx scripts/check-dependency-security.ts [--audit-json file] [--dist dir]
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const exceptions: AdvisoryException[] = JSON.parse(
  readFileSync(new URL('../security/advisory-exceptions.json', import.meta.url), 'utf8'),
).exceptions;
const installed = Object.fromEntries(
  exceptions.map((e) => [
    e.package,
    // Every installed copy, so a differing nested copy cannot hide behind the hoisted one.
    [
      ...new Set(
        installedCopyPaths(root, e.package).map(
          (dir) => JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version as string,
        ),
      ),
    ].sort().join(',') || undefined,
  ]),
);

let auditText = option('--audit-json') ? readFileSync(option('--audit-json')!, 'utf8') : '';
if (!auditText) {
  // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
  try {
    auditText = execFileSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    auditText = (error as { stdout?: string }).stdout ?? '';
  }
}
const report = JSON.parse(auditText) as AuditReport;
const problems = [
  ...evaluateAudit(report, exceptions, new Date(), installed),
  ...checkAuditNodes(root, report),
  ...checkCallPathAssumptions(root),
  ...(option('--dist') ? checkExportedBundles(option('--dist')!) : []),
];
if (problems.length > 0) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log('dependency security: only the documented, unexpired advisory exceptions remain');
