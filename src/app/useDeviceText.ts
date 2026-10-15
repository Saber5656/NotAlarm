import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  createTextContext,
  sameLocaleSettings,
  type Messages,
  type TextContext,
} from '../i18n';
import { readDeviceLocaleSettings } from '../i18n/deviceLocale';
import { relocalizeNotice } from '../i18n/localizedNotice';
import { setNotificationMessages } from '../notificationService';
import { subscribeAppState } from './platform/appStateEdge';
import type { Notice } from './types';

/**
 * Device language and clock preference. Read again every time the app returns
 * to the foreground (Android can change them while the app runs).
 */
export function useDeviceText(
  setNotice: Dispatch<SetStateAction<Notice | null>>,
) {
  const [localeSettings, setLocaleSettings] = useState(readDeviceLocaleSettings);
  const text = useMemo(
    () => createTextContext(localeSettings),
    [localeSettings],
  );
  // Callbacks and long-lived listeners read the latest language from here, so
  // they never speak a stale one.
  const textRef = useRef<TextContext>(text);
  const localeSettingsRef = useRef(localeSettings);
  textRef.current = text;
  const messagesNow = (): Messages => textRef.current.messages;

  useEffect(() => {
    const refreshLocale = () => {
      const next = readDeviceLocaleSettings();
      const nextText = createTextContext(next);
      // Notification text is fixed when it is scheduled, so it follows the
      // device language from the first pass on, changed or not.
      setNotificationMessages(nextText.messages);
      if (sameLocaleSettings(localeSettingsRef.current, next)) {
        return;
      }
      localeSettingsRef.current = next;
      textRef.current = nextText;
      setLocaleSettings(next);
      // Sentences already on screen were written in the previous language.
      setNotice((previous) => relocalizeNotice(previous, nextText));
    };
    refreshLocale();
    return subscribeAppState((state) => {
      if (state === 'active') {
        refreshLocale();
      }
    });
  }, []);

  return { text, textRef, messagesNow };
}
