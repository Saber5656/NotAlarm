import { createFormatter, type Formatter } from './format';
import { en } from './en';
import { ja } from './ja';
import type { LocaleSettings } from './locale';
import type { Messages } from './messages';

/** What a text-producing policy function needs: sentences and date/time forms. */
export interface TextContext {
  messages: Messages;
  formatter: Formatter;
  /** BCP 47 tag for native widgets that take a locale (e.g. the time dial). */
  intlTag: string;
  /** Whether clock widgets should show 24 hours (device preference first). */
  uses24HourClock: boolean;
}

export function createTextContext(settings: LocaleSettings): TextContext {
  return {
    messages: settings.locale === 'en' ? en : ja,
    formatter: createFormatter(settings),
    intlTag: settings.intlTag,
    // Without a device preference, the Intl locale convention decides, the
    // same one the formatter falls back to.
    uses24HourClock:
      settings.hour12 === null
        ? localeUses24HourClock(settings.intlTag)
        : !settings.hour12,
  };
}

function localeUses24HourClock(intlTag: string): boolean {
  const { hourCycle } = new Intl.DateTimeFormat(intlTag, {
    hour: 'numeric',
  }).resolvedOptions();
  return hourCycle === 'h23' || hourCycle === 'h24';
}
