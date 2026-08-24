import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NOTICE_OFFSCREEN_Y,
  clampNoticeSwipeOffset,
  shouldCaptureNoticeSwipe,
  shouldDismissNoticeSwipe,
} from '../src/noticeGesture';

test('notice swipe capture accepts a deliberate upward gesture only', () => {
  assert.equal(shouldCaptureNoticeSwipe(2, -7), true);
  assert.equal(shouldCaptureNoticeSwipe(10, -7), false);
  assert.equal(shouldCaptureNoticeSwipe(0, 12), false);
  assert.equal(shouldCaptureNoticeSwipe(Number.NaN, -12), false);
});

test('notice swipe movement is clamped between rest and offscreen', () => {
  assert.equal(clampNoticeSwipeOffset(20), 0);
  assert.equal(clampNoticeSwipeOffset(-24), -24);
  assert.equal(clampNoticeSwipeOffset(-240), NOTICE_OFFSCREEN_Y);
  assert.equal(clampNoticeSwipeOffset(Number.NaN), 0);
});

test('notice swipe dismisses by distance or upward velocity', () => {
  assert.equal(shouldDismissNoticeSwipe(-32, 0), true);
  assert.equal(shouldDismissNoticeSwipe(-12, -0.6), true);
  assert.equal(shouldDismissNoticeSwipe(-12, -0.2), false);
  assert.equal(shouldDismissNoticeSwipe(18, -1), false);
});
