const COMPACT_COMPOSER_HEIGHT = 700;
const COMPACT_COMPOSER_WIDTH = 360;
const LARGE_TEXT_SCALE = 1.3;

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
