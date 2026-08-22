import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldScrollAlarmComposer } from '../src/composerLayout';

test('standard phone layout keeps the alarm composer fixed', () => {
  assert.equal(shouldScrollAlarmComposer(844, 390, 1), false);
});

test('compact screens use scrolling as a safety fallback', () => {
  assert.equal(shouldScrollAlarmComposer(667, 375, 1), true);
  assert.equal(shouldScrollAlarmComposer(844, 320, 1), true);
});

test('large text uses scrolling so controls remain reachable', () => {
  assert.equal(shouldScrollAlarmComposer(844, 390, 1.31), true);
});
