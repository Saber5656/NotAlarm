import { createContext, useContext } from 'react';

import { createTextContext, type TextContext } from '../i18n/context';
import { DEFAULT_LOCALE_SETTINGS } from '../i18n/locale';

const I18nContext = createContext<TextContext>(
  createTextContext(DEFAULT_LOCALE_SETTINGS),
);

export const I18nProvider = I18nContext.Provider;

/** The sentences and date/time forms for the current device language. */
export function useText(): TextContext {
  return useContext(I18nContext);
}
