import type { KeyValueStore } from './suppressionJournal';

export const PLANNING_ZONE_KEY = 'already-up/planning-zone/v1';

/**
 * The time zone the stored occurrences were planned in. Repeating HH:mm and
 * the today-only date are local wall-clock values, so a different zone means
 * the stored absolute times may no longer match them.
 */
export function currentPlanningZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) {
      return zone;
    }
  } catch {
    // Fall through to the offset below.
  }
  return `utc-offset:${new Date().getTimezoneOffset()}`;
}

/** A first run (nothing stored) is not a change. */
export function didPlanningZoneChange(
  stored: string | null,
  current: string,
): boolean {
  return stored !== null && stored !== current;
}

export async function loadPlanningZone(
  store: KeyValueStore,
): Promise<string | null> {
  try {
    const raw = await store.getItem(PLANNING_ZONE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    const zone = (parsed as { zone?: unknown } | null)?.zone;
    return typeof zone === 'string' && zone.length > 0 ? zone : null;
  } catch {
    return null;
  }
}

export async function savePlanningZone(
  store: KeyValueStore,
  zone: string,
): Promise<void> {
  await store.setItem(PLANNING_ZONE_KEY, JSON.stringify({ version: 1, zone }));
}
