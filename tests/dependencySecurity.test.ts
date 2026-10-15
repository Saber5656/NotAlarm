/// <reference types="node" />

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

import {
  checkCallPathAssumptions,
  checkResolvedExpoConfig,
  resolveExpoConfig,
  checkExportedBundles,
  evaluateAudit,
  type AdvisoryException,
  type AuditReport,
} from '../scripts/dependencySecurity';

const root = fileURLToPath(new URL('..', import.meta.url));
const exceptions: AdvisoryException[] = JSON.parse(
  readFileSync(new URL('../security/advisory-exceptions.json', import.meta.url), 'utf8'),
).exceptions;

const BRACES = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const FORGE = 'https://github.com/advisories/GHSA-86w9-cpqp-85rv';
const beforeExpiry = new Date('2026-10-15T00:00:00Z');

function advisory(name: string, url: string, severity = 'high') {
  return { source: 1, name, dependency: name, title: 't', url, severity, range: '*' };
}

function auditWith(vulnerabilities: AuditReport['vulnerabilities']): AuditReport {
  return { vulnerabilities };
}

const currentAudit = auditWith({
  braces: { name: 'braces', severity: 'high', via: [advisory('braces', BRACES)] },
  micromatch: { name: 'micromatch', severity: 'high', via: ['braces'] },
  'metro-file-map': { name: 'metro-file-map', severity: 'high', via: ['micromatch'] },
  'node-forge': { name: 'node-forge', severity: 'high', via: [advisory('node-forge', FORGE)] },
  '@expo/code-signing-certificates': {
    name: '@expo/code-signing-certificates',
    severity: 'high',
    via: ['node-forge'],
  },
});

describe('advisory exceptions', () => {
  test('cover exactly the two upstream-unfixed advisories and expire on 2026-11-14', () => {
    assert.deepEqual(
      exceptions.map((e) => [e.package, e.advisoryUrl, e.installedVersion, e.expires]),
      [
        ['braces', BRACES, '3.0.3', '2026-11-14'],
        ['node-forge', FORGE, '1.4.0', '2026-11-14'],
      ],
    );
  });

  test('accept the known advisories and everything propagated from them', () => {
    assert.deepEqual(evaluateAudit(currentAudit, exceptions, beforeExpiry), []);
  });

  test('fail closed once an exception has expired', () => {
    const problems = evaluateAudit(currentAudit, exceptions, new Date('2026-11-15T00:00:00Z'));
    assert.ok(problems.some((p) => /expired/.test(p)), problems.join('\n'));
  });

  test('do not hide a new advisory on an excepted package', () => {
    const report = auditWith({
      ...currentAudit.vulnerabilities,
      braces: {
        name: 'braces',
        severity: 'high',
        via: [advisory('braces', BRACES), advisory('braces', 'https://github.com/advisories/GHSA-new')],
      },
    });
    const problems = evaluateAudit(report, exceptions, beforeExpiry);
    assert.ok(problems.some((p) => /GHSA-new/.test(p)), problems.join('\n'));
  });

  test('do not hide a new critical finding on another package', () => {
    const report = auditWith({
      ...currentAudit.vulnerabilities,
      lodash: {
        name: 'lodash',
        severity: 'critical',
        via: [advisory('lodash', 'https://github.com/advisories/GHSA-x', 'critical')],
      },
    });
    const problems = evaluateAudit(report, exceptions, beforeExpiry);
    assert.ok(problems.some((p) => /lodash/.test(p)), problems.join('\n'));
  });

  test('do not hide a package that mixes an excepted dependency with its own advisory', () => {
    const report = auditWith({
      ...currentAudit.vulnerabilities,
      micromatch: {
        name: 'micromatch',
        severity: 'high',
        via: ['braces', advisory('micromatch', 'https://github.com/advisories/GHSA-y')],
      },
    });
    const problems = evaluateAudit(report, exceptions, beforeExpiry);
    assert.ok(problems.some((p) => /GHSA-y/.test(p)), problems.join('\n'));
  });

  test('fail when the installed version no longer matches the assessed version', () => {
    const problems = evaluateAudit(currentAudit, exceptions, beforeExpiry, {
      braces: '3.0.4',
      'node-forge': '1.4.0',
    });
    assert.ok(problems.some((p) => /braces/.test(p) && /3\.0\.4/.test(p)), problems.join('\n'));
  });

  test('accept propagation cycles that contain no advisory of their own', () => {
    const report = auditWith({
      ...currentAudit.vulnerabilities,
      metro: { name: 'metro', severity: 'high', via: ['metro-config', 'metro-file-map'] },
      'metro-config': { name: 'metro-config', severity: 'high', via: ['metro'] },
    });
    assert.deepEqual(evaluateAudit(report, exceptions, beforeExpiry), []);
  });

  test('reject a propagation cycle that has its own advisory', () => {
    const report = auditWith({
      ...currentAudit.vulnerabilities,
      metro: {
        name: 'metro',
        severity: 'high',
        via: ['metro-config', advisory('metro', 'https://github.com/advisories/GHSA-z')],
      },
      'metro-config': { name: 'metro-config', severity: 'high', via: ['metro'] },
    });
    const problems = evaluateAudit(report, exceptions, beforeExpiry);
    assert.ok(problems.some((p) => /metro-config/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /GHSA-z/.test(p)), problems.join('\n'));
  });

  test('fail closed on malformed expiry dates', () => {
    for (const expires of ['2026-13-01', '2026-02-30', '2026-00-10', '2026-11-00', '2026-4-5', '', '2026-11-14T00:00:00Z', ' 2026-11-14', 'never', '20261114']) {
      const problems = evaluateAudit(currentAudit, [{ ...exceptions[0], expires }, exceptions[1]], beforeExpiry);
      assert.ok(problems.some((p) => /invalid expires/.test(p)), `${JSON.stringify(expires)}: ${problems.join('\n')}`);
      assert.ok(problems.some((p) => /braces/.test(p) && /not covered/.test(p)), `${JSON.stringify(expires)} must not stay active`);
    }
  });

  test('fail closed on a non-string expiry and on unknown exception shape', () => {
    const bad = [{ ...exceptions[0], expires: 20261114 as unknown as string }];
    assert.ok(evaluateAudit(currentAudit, bad, beforeExpiry).some((p) => /invalid expires/.test(p)));
    const extra = [{ ...exceptions[0], package: '*' }, exceptions[1]];
    assert.ok(evaluateAudit(currentAudit, extra, beforeExpiry).some((p) => /invalid exception/.test(p)));
    const wildcardUrl = [{ ...exceptions[0], advisoryUrl: '*' }, exceptions[1]];
    assert.ok(evaluateAudit(currentAudit, wildcardUrl, beforeExpiry).some((p) => /invalid exception/.test(p)));
  });

  test('accept leap days only in leap years', () => {
    const on = (expires: string) => evaluateAudit(currentAudit, [{ ...exceptions[0], expires }, exceptions[1]], new Date('2026-10-15T00:00:00Z'));
    assert.deepEqual(on('2028-02-29'), []);
    assert.ok(on('2027-02-29').some((p) => /invalid expires/.test(p)));
  });

  test('fail closed when the current time is not a valid date', () => {
    for (const now of [new Date('not a date'), new Date(NaN), undefined as unknown as Date]) {
      assert.ok(evaluateAudit(currentAudit, exceptions, now).some((p) => /invalid current time/.test(p)));
    }
  });

  test('treat the whole expiry day as valid and the next day as expired', () => {
    assert.deepEqual(evaluateAudit(currentAudit, exceptions, new Date('2026-11-14T23:59:59Z')), []);
    assert.ok(evaluateAudit(currentAudit, exceptions, new Date('2026-11-15T00:00:00Z')).some((p) => /expired/.test(p)));
  });

  test('pass with an empty audit so the exception can simply be removed later', () => {
    assert.deepEqual(evaluateAudit(auditWith({}), exceptions, beforeExpiry), []);
  });
});

describe('assessed call-path assumptions for the installed dependencies', () => {
  test('still hold for this checkout', () => {
    assert.deepEqual(checkCallPathAssumptions(root), []);
  });

  test('accept the real resolved Expo config via the installed CLI', () => {
    assert.deepEqual(checkResolvedExpoConfig(resolveExpoConfig(root)), []);
  });

  test('reject a dynamically resolved codeSigningCertificate or EAS projectId', () => {
    const resolved = (config: object) => () => config;
    assert.equal(checkCallPathAssumptions(root, resolved({ updates: { codeSigningCertificate: './c.pem' } })).length, 1);
    assert.equal(checkCallPathAssumptions(root, resolved({ extra: { eas: { projectId: 'x' } } })).length, 1);
    assert.deepEqual(checkCallPathAssumptions(root, resolved({ name: 'a', updates: { enabled: false } })), []);
  });

  test('fail closed when the config cannot be resolved', () => {
    const broken = () => {
      throw new Error('boom');
    };
    assert.ok(checkCallPathAssumptions(root, broken).some((p) => /could not resolve/.test(p)));
  });
});

describe('exported bundle sourcemaps', () => {
  const mapWith = (sources: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'alr14-'));
    writeFileSync(join(dir, 'index.js.map'), JSON.stringify({ sources }));
    return dir;
  };

  test('accept app, react-native and expo runtime sources', () => {
    const dir = mapWith(['/r/App.tsx', '/r/node_modules/react-native/index.js', '/r/node_modules/expo/src/Expo.ts']);
    assert.deepEqual(checkExportedBundles(dir), []);
  });

  test('reject a bundle that contains an affected package', () => {
    const dir = mapWith(['/r/node_modules/node-forge/lib/rsa.js', '/r/node_modules/braces/index.js']);
    assert.equal(checkExportedBundles(dir).length, 2);
  });

  test('fail closed when there are no sourcemaps to inspect', () => {
    assert.equal(checkExportedBundles(mkdtempSync(join(tmpdir(), 'alr14-'))).length, 1);
  });
});

describe('CI wiring', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const runs = [...ci.matchAll(/^\s*- run: (.+)$/gm)].map((m) => m[1].trim());

  test('exports with sourcemaps into dist-ci and then checks that export with the real clock', () => {
    const exportIndex = runs.findIndex((r) => /^npx expo export\b/.test(r));
    assert.ok(exportIndex >= 0, 'export step missing');
    assert.match(runs[exportIndex], /--source-maps/);
    assert.match(runs[exportIndex], /--output-dir dist-ci/);
    const checkIndex = runs.findIndex((r) => /^npm run security:check\b/.test(r));
    assert.ok(checkIndex > exportIndex, 'security:check must run after the export');
    assert.match(runs[checkIndex], /--dist dist-ci/);
    assert.doesNotMatch(runs[checkIndex], /--audit-json/);
  });

  test('uses Node 22', () => {
    assert.match(ci, /node-version: '22\.x'/);
  });
});
