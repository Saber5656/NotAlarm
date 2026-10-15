/// <reference types="node" />

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const tracer = join(root, 'scripts/trace/dependency-trace.cjs');

type TraceEvent = { ev: string; [key: string]: unknown };

// Runs `code` in a fresh node process with the tracer preloaded; returns the recorded events.
function trace(code: string): TraceEvent[] {
  const out = join(mkdtempSync(join(tmpdir(), 'alr14-trace-')), 'trace.jsonl');
  execFileSync(process.execPath, ['-e', code], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--require ${tracer}`, TRACE_OUT: out },
    stdio: 'pipe',
  });
  try {
    return readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe('dependency tracer positive controls', () => {
  test('records braces() calls made through micromatch.braces', () => {
    const events = trace(`require('micromatch').braces('a{b,c}')`);
    assert.ok(events.some((e) => e.ev === 'load' && /braces/.test(String(e.file))), 'braces load');
    assert.ok(events.some((e) => e.ev === 'braces' && e.pattern === 'a{b,c}'), JSON.stringify(events));
  });

  test('records braces() calls made through micromatch.parse', () => {
    const events = trace(`require('micromatch').parse('a{b,c}')`);
    assert.ok(events.some((e) => e.ev === 'braces'), JSON.stringify(events));
  });

  test('records node-forge signature verification (certificate and key)', () => {
    const events = trace(`
      const forge = require('node-forge');
      const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey; cert.serialNumber = '01';
      cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 1e9);
      cert.setSubject([{ name: 'commonName', value: 't' }]); cert.setIssuer(cert.subject.attributes);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      cert.verify(cert);
      const md = forge.md.sha256.create(); md.update('x');
      keys.publicKey.verify(md.digest().bytes(), keys.privateKey.sign(md));
    `);
    const forgeEvents = events.filter((e) => e.ev === 'forge');
    assert.ok(forgeEvents.length >= 2, JSON.stringify(events));
  });
});

describe('dependency tracer negative observations (valid only because the controls above pass)', () => {
  test('micromatch.some loads braces but never calls braces()', () => {
    const events = trace(`require('micromatch').some(['a.js'], ['**/*.js'])`);
    assert.ok(events.some((e) => e.ev === 'load' && /micromatch/.test(String(e.file))));
    assert.equal(events.filter((e) => e.ev === 'braces').length, 0);
  });

  test('loading node-forge without verifying records no forge call', () => {
    const events = trace(`require('node-forge').md.sha256.create()`);
    assert.ok(events.some((e) => e.ev === 'load' && /node-forge/.test(String(e.file))));
    assert.equal(events.filter((e) => e.ev === 'forge').length, 0);
  });
});
