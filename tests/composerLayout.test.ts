import assert from 'node:assert/strict';
import test from 'node:test';

import {
  doesComposerContentOverflow,
  getWeekdayColumnCount,
  shouldScrollAlarmComposer,
} from '../src/composerLayout';

test('form enables scrolling when keyboard reduces its measured viewport', () => {
  assert.equal(doesComposerContentOverflow(220, 400), false);
  assert.equal(doesComposerContentOverflow(220, 150), true);
  assert.equal(doesComposerContentOverflow(220, 400), false);
});

test('content growth from input errors enables scrolling without viewport resize', () => {
  assert.equal(doesComposerContentOverflow(140, 160), false);
  assert.equal(doesComposerContentOverflow(190, 160), true);
  assert.equal(doesComposerContentOverflow(160.5, 160), false);
  assert.equal(doesComposerContentOverflow(190, 0), false);
});

test('weekdays fit seven 44pt targets or deliberately wrap four plus three', () => {
  assert.equal(getWeekdayColumnCount(332), 7);
  assert.equal(getWeekdayColumnCount(331), 4);
  assert.equal(getWeekdayColumnCount(317), 4);
});

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
