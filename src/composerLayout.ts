const COMPACT_COMPOSER_HEIGHT = 700;
const COMPACT_COMPOSER_WIDTH = 360;
const LARGE_TEXT_SCALE = 1.3;

// Native keyboard avoidance changes the form viewport without necessarily
// changing useWindowDimensions (notably iOS padding avoidance).
export function doesComposerContentOverflow(
  contentHeight: number,
  viewportHeight: number,
): boolean {
  return viewportHeight > 0 && contentHeight > viewportHeight + 1;
}

export function getWeekdayColumnCount(availableWidth: number): 4 | 7 {
  return availableWidth >= 7 * 44 + 6 * 4 ? 7 : 4;
}

export function shouldScrollAlarmComposer(
  viewportHeight: number,
  viewportWidth: number,
  fontScale: number,
): boolean {
  return (
    viewportHeight < COMPACT_COMPOSER_HEIGHT ||
    viewportWidth < COMPACT_COMPOSER_WIDTH ||
    fontScale > LARGE_TEXT_SCALE
  );
}
