import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { StoredAlarmDefinition } from '../alarmStorage';
import {
  getBedsideGuidance,
  isForegroundAppState,
  shouldKeepScreenAwake,
} from '../bedsideMode';
import type { Messages } from '../i18n';
import { localizedNotice } from '../i18n/localizedNotice';
import type { NotificationDeliveryState } from '../notificationDelivery';
import {
  currentAppState,
  subscribeAppState,
} from './platform/appStateEdge';
import {
  activateBedsideKeepAwake,
  releaseBedsideKeepAwake,
} from './platform/keepAwakeEdge';
import type { SetNotice, TextRef } from './types';

/**
 * Foreground tracking and the bedside keep-awake lifecycle. Two different
 * foreground notions are kept apart on purpose: the screen-awake policy and
 * the sensors treat `inactive` as still on screen, while queued
 * announcements need a strict `active`.
 */
export function useBedsideAwake(input: {
  alarms: StoredAlarmDefinition[];
  nowMs: number;
  notificationDelivery: NotificationDeliveryState | null;
  messages: Messages;
  textRef: TextRef;
  setNotice: SetNotice;
}) {
  const { alarms, nowMs, notificationDelivery, messages, textRef, setNotice } =
    input;
  const [isAppForeground, setIsAppForeground] = useState(() =>
    isForegroundAppState(currentAppState()),
  );
  // Stricter than keep-awake: `inactive` is not active for announcements.
  const [isAppActive, setIsAppActive] = useState(
    () => currentAppState() === 'active',
  );

  useEffect(
    () =>
      subscribeAppState((state) => {
        setIsAppForeground(isForegroundAppState(state));
        setIsAppActive(state === 'active');
      }),
    [],
  );

  // The bedside copy must not promise a notification sound that the current
  // delivery state cannot make.
  const bedsideGuidance = useMemo(
    () => getBedsideGuidance(notificationDelivery, messages),
    [notificationDelivery, messages],
  );
  // Read when activation fails, so the notice uses the latest delivery state
  // without re-running (and releasing) the keep-awake effect.
  const keepAwakeDeliveryRef = useRef(notificationDelivery);
  useEffect(() => {
    keepAwakeDeliveryRef.current = notificationDelivery;
  }, [notificationDelivery]);

  // Bedside mode: the loop sound and step check only run while the app is on
  // screen, so the screen stays on while an alarm is ringing or due soon.
  const keepScreenAwake =
    Platform.OS !== 'web' &&
    isAppForeground &&
    shouldKeepScreenAwake(alarms, nowMs);

  useEffect(() => {
    if (!keepScreenAwake) {
      return;
    }

    void activateBedsideKeepAwake().catch(() => {
      setNotice(
        localizedNotice(
          (t) => ({
            tone: 'warning',
            text: getBedsideGuidance(keepAwakeDeliveryRef.current, t.messages)
              .keepAwakeFailure,
          }),
          textRef.current,
        ),
      );
    });
    return () => {
      void releaseBedsideKeepAwake().catch(() => undefined);
    };
  }, [keepScreenAwake]);

  return { isAppForeground, isAppActive, bedsideGuidance };
}
