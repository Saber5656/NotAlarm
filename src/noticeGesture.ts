export const NOTICE_OFFSCREEN_Y = -160;

const NOTICE_SWIPE_CAPTURE_DISTANCE = 6;
const NOTICE_SWIPE_DISMISS_DISTANCE = 32;
const NOTICE_SWIPE_DISMISS_VELOCITY = -0.55;

export function shouldCaptureNoticeSwipe(dx: number, dy: number): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return false;
  }

  return (
    dy <= -NOTICE_SWIPE_CAPTURE_DISTANCE &&
    Math.abs(dy) > Math.abs(dx) * 1.1
  );
}

export function clampNoticeSwipeOffset(offsetY: number): number {
  if (!Number.isFinite(offsetY)) {
    return 0;
  }

  return Math.max(NOTICE_OFFSCREEN_Y, Math.min(0, offsetY));
}

export function shouldDismissNoticeSwipe(dy: number, vy: number): boolean {
  if (!Number.isFinite(dy) || !Number.isFinite(vy)) {
    return false;
  }

  return (
    dy <= -NOTICE_SWIPE_DISMISS_DISTANCE ||
    (dy <= -10 && vy <= NOTICE_SWIPE_DISMISS_VELOCITY)
  );
}
