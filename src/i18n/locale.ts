/**
 * Locale resolution. Pure and React Native free: the device inputs (language
 * tags, the 12/24-hour preference, the time zone) are read once at the edge
 * (`deviceLocale.ts`) and passed in, so every rule here is testable.
 */

export type AppLocale = 'ja' | 'en';

/** Japanese is the product default and the fallback for unsupported languages. */
export const DEFAULT_LOCALE: AppLocale = 'ja';

const DEFAULT_INTL_TAG: Record<AppLocale, string> = {
  ja: 'ja-JP',
  en: 'en-US',
};

/**
 * Everything locale-dependent formatting needs. `hour12` mirrors the device
 * clock preference: `true` / `false` force 12 / 24 hours, `null` means the
 * device did not say, so the locale's own convention applies.
 */
export interface LocaleSettings {
  locale: AppLocale;
  /** BCP 47 tag handed to Intl (keeps the device region, e.g. en-GB). */
  intlTag: string;
  hour12: boolean | null;
  /** Fixed zone for tests; `undefined` uses the runtime's current zone. */
  timeZone?: string;
}

export const DEFAULT_LOCALE_SETTINGS: LocaleSettings = {
  locale: DEFAULT_LOCALE,
  intlTag: DEFAULT_INTL_TAG[DEFAULT_LOCALE],
  hour12: null,
};

function languageOf(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

function supportedLocaleOf(tag: string): AppLocale | null {
  const language = languageOf(tag);
  return language === 'ja' || language === 'en' ? language : null;
}

/**
 * The first device language this app supports wins, in the order the user
 * ranked them. A device that lists only unsupported languages gets Japanese.
 */
export function resolveAppLocale(languageTags: readonly string[]): AppLocale {
  for (const tag of languageTags) {
    const locale = supportedLocaleOf(tag);
    if (locale) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

function isValidIntlTag(tag: string): boolean {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0;
  } catch {
    return false;
  }
}

export interface DeviceLocaleInput {
  /** Device language tags, most preferred first (e.g. `['en-GB', 'ja-JP']`). */
  languageTags: readonly string[];
  /** Device clock preference; `null` when the platform cannot tell. */
  uses24HourClock: boolean | null;
  timeZone?: string | null;
}

export function resolveLocaleSettings(input: DeviceLocaleInput): LocaleSettings {
  const locale = resolveAppLocale(input.languageTags);
  const matchingTag = input.languageTags.find(
    (tag) => supportedLocaleOf(tag) === locale && /[-_]/.test(tag),
  );
  const normalizedTag = matchingTag?.replace('_', '-');
  const intlTag =
    normalizedTag && isValidIntlTag(normalizedTag)
      ? normalizedTag
      : DEFAULT_INTL_TAG[locale];
  return {
    locale,
    intlTag,
    hour12: input.uses24HourClock === null ? null : !input.uses24HourClock,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  };
}

export function sameLocaleSettings(
  a: LocaleSettings,
  b: LocaleSettings,
): boolean {
  return (
    a.locale === b.locale &&
    a.intlTag === b.intlTag &&
    a.hour12 === b.hour12 &&
    a.timeZone === b.timeZone
  );
}
