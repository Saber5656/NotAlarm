import { en } from './en';
import { ja } from './ja';

export {
  describeErrorIn,
  noticeFromCodeIn,
  noticeFromCodesIn,
} from './errorText';
export { createTextContext, type TextContext } from './context';
export { createFormatter, type Formatter } from './format';
export {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_SETTINGS,
  resolveAppLocale,
  resolveLocaleSettings,
  sameLocaleSettings,
  type AppLocale,
  type DeviceLocaleInput,
  type LocaleSettings,
} from './locale';
export type { Messages } from './messages';


export { en, ja };
