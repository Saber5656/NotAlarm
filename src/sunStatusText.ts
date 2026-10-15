import type { Messages } from './i18n/messages';

export type SunStatusKey = keyof Messages['sun']['status'];

/**
 * Brief status line; the background never affects whether an alarm rings.
 * `scheduleActive` is true while a region or device schedule is still applied.
 * Failed lookups leave the saved choice alone, so the text must say which
 * applies.
 */
export function sunStatusText(
  key: SunStatusKey,
  messages: Messages,
  { scheduleActive = false }: { scheduleActive?: boolean } = {},
): string {
  const kept = messages.sun.keptStatus as Partial<Record<SunStatusKey, string>>;
  return (scheduleActive && kept[key]) || messages.sun.status[key];
}
