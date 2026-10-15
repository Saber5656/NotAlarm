const LARGE_TEXT_SCALE = 1.3;

export interface ScreenScrollPolicy {
  scroll: boolean;
  minHeight: number;
}

// The load-failure card holds the only way to reset, so it must scroll on
// short viewports; main and ringing screens stay fixed unless text is large.
export function getScreenScrollPolicy(input: {
  fontScale: number;
  viewportHeight: number;
  loadFailed: boolean;
  ringing: boolean;
}): ScreenScrollPolicy {
  const largeText = input.fontScale > LARGE_TEXT_SCALE;
  const scroll = largeText || (input.loadFailed && !input.ringing);
  return {
    scroll,
    minHeight: Math.max(
      input.viewportHeight,
      largeText ? Math.round(720 * Math.min(input.fontScale, 2)) : 0,
    ),
  };
}
