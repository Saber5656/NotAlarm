import assert from 'node:assert/strict';
import test from 'node:test';

import { getScreenScrollPolicy } from '../src/screenScroll';

const viewports = [
  { width: 375, height: 667 },
  { width: 320, height: 568 },
];

test('load-failure screen scrolls at short viewports for fontScale 1.0-1.3', () => {
  for (const { height } of viewports) {
    for (const fontScale of [1, 1.15, 1.3]) {
      const policy = getScreenScrollPolicy({
        fontScale,
        viewportHeight: height,
        loadFailed: true,
        ringing: false,
      });
      assert.equal(policy.scroll, true);
      assert.equal(policy.minHeight, height);
    }
  }
});

test('main and ringing screens stay fixed at fontScale <= 1.3', () => {
  for (const fontScale of [1, 1.3]) {
    assert.equal(
      getScreenScrollPolicy({ fontScale, viewportHeight: 667, loadFailed: false, ringing: false }).scroll,
      false,
    );
    assert.equal(
      getScreenScrollPolicy({ fontScale, viewportHeight: 667, loadFailed: true, ringing: true }).scroll,
      false,
    );
  }
});

test('large font keeps the existing scroll and min height', () => {
  const policy = getScreenScrollPolicy({
    fontScale: 1.5,
    viewportHeight: 667,
    loadFailed: false,
    ringing: false,
  });
  assert.deepEqual(policy, { scroll: true, minHeight: 1080 });
  assert.equal(
    getScreenScrollPolicy({ fontScale: 3, viewportHeight: 667, loadFailed: false, ringing: true }).minHeight,
    1440,
  );
});
