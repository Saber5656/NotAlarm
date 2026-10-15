import { getCalendars, getLocales } from 'expo-localization';

import { resolveLocaleSettings, type LocaleSettings } from './locale';

/**
 * The only place that touches expo-localization (included in Expo Go). It is
 * synchronous. iOS keeps its result while the app runs, but Android can change
 * the language or clock preference without a restart, so callers read it again
 * whenever the app returns to the foreground.
 */
export function readDeviceLocaleSettings(): LocaleSettings {
  let languageTags: string[] = [];
  let uses24HourClock: boolean | null = null;
  try {
    languageTags = getLocales().map((locale) => locale.languageTag);
  } catch {
    // Unreadable device language: fall back to the Japanese default.
  }
  try {
    uses24HourClock = getCalendars()[0]?.uses24hourClock ?? null;
  } catch {
    // Unknown clock preference: the locale's own convention applies.
  }
  return resolveLocaleSettings({ languageTags, uses24HourClock });
}
