import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFingerprintAsync, diffFingerprints } from '@expo/fingerprint';

test('fingerprinting scans native files, respects ignore patterns and detects source changes', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'notalarm-fingerprint-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, 'ios'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fingerprint-fixture', version: '1.0.0' }));
  writeFileSync(join(project, '.gitignore'), '*.cache\n');
  writeFileSync(join(project, 'ios/App.swift'), 'let alarm = 1\n');
  writeFileSync(join(project, 'ios/ignored.swift'), 'ignored one\n');
  const options = { platforms: ['ios' as const], ignorePaths: ['ios/ignored.swift'], silent: true };

  const first = await createFingerprintAsync(project, options);
  assert.ok(first.sources.some((source) => source.type === 'dir' && source.filePath === 'ios'));
  assert.deepEqual(await createFingerprintAsync(project, options), first);

  writeFileSync(join(project, 'ios/ignored.swift'), 'ignored two\n');
  assert.equal((await createFingerprintAsync(project, options)).hash, first.hash);

  writeFileSync(join(project, 'ios/App.swift'), 'let alarm = 2\n');
  const changed = await createFingerprintAsync(project, options);
  assert.notEqual(changed.hash, first.hash);
  assert.ok(diffFingerprints(first, changed).some((difference) => difference.op === 'changed'));
});
