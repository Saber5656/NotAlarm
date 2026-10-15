import {
  createFormatter,
  createTextContext,
  en,
  ja,
  type Formatter,
  type LocaleSettings,
  type TextContext,
} from '../../src/i18n';

export const JA_SETTINGS: LocaleSettings = {
  locale: 'ja',
  intlTag: 'ja-JP',
  hour12: null,
};

export const EN_SETTINGS: LocaleSettings = {
  locale: 'en',
  intlTag: 'en-US',
  hour12: null,
};

/** Japanese (default) text in the runtime's own time zone, like the app. */
export const JA_TEXT: TextContext = createTextContext(JA_SETTINGS);
export const EN_TEXT: TextContext = createTextContext(EN_SETTINGS);

export { createFormatter, en, ja };

/** The same text with some formatter methods replaced by a test stub. */
export function withFormatter(
  base: TextContext,
  overrides: Partial<Formatter>,
): TextContext {
  return { ...base, formatter: { ...base.formatter, ...overrides } };
}
