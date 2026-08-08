/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAlarmToneBytes } from '../src/alarmTone';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

test('generated alarm sound is a non-empty PCM WAV', () => {
  const bytes = createAlarmToneBytes();

  assert.equal(ascii(bytes, 0, 4), 'RIFF');
  assert.equal(ascii(bytes, 8, 4), 'WAVE');
  assert.equal(ascii(bytes, 36, 4), 'data');
  assert.ok(bytes.length > 44);
  assert.ok(bytes.slice(44).some((value) => value !== 0));
});
