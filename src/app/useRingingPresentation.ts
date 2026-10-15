import { useCallback, useEffect, useRef } from 'react';
import { Platform, type View } from 'react-native';

import type { StoredAlarm } from '../alarmStorage';
import { startForegroundAlarmSound, stopForegroundAlarmSound } from '../alarmSound';
import { planMissedAnnouncement } from '../homeStatus';
import { noticeFromCodeIn } from '../i18n';
import {
  announcePolitely,
  focusElement,
} from './platform/accessibilityEdge';
import type { MessagesNow, SetNotice } from './types';

/**
 * What the screen does around a ringing alarm and missed alarms: the composer
 * gives way, screen-reader focus lands on the stop control, newly missed
 * occurrences are announced once each, and the foreground loop sound plays.
 */
export function useRingingPresentation(input: {
  ringingCycle: StoredAlarm | null;
  missedCycles: StoredAlarm[];
  isComposerOpen: boolean;
  isAppActive: boolean;
  closeComposerForRinging(): void;
  messagesNow: MessagesNow;
  setNotice: SetNotice;
}) {
  const {
    ringingCycle,
    missedCycles,
    isComposerOpen,
    isAppActive,
    closeComposerForRinging,
    messagesNow,
    setNotice,
  } = input;
  const stopButtonRef = useRef<View>(null);
  // Set when an alarm starts ringing under the open composer; focus waits for
  // the modal to finish dismissing.
  const ringFocusPendingRef = useRef(false);

  useEffect(() => {
    if (ringingCycle) {
      closeComposerForRinging();
    }
  }, [ringingCycle?.cycleId]);

  const focusStopButton = useCallback(() => {
    focusElement(stopButtonRef);
  }, []);

  useEffect(() => {
    if (!ringingCycle || Platform.OS === 'web') {
      ringFocusPendingRef.current = false;
      return;
    }

    // The stop control's label carries the time and that it is ringing, so
    // moving focus there is the whole announcement; a separate announce would
    // be cut off by the focus change. Not yet measured with VoiceOver on a
    // device (see docs/DEVICE_TEST.md).
    if (isComposerOpen) {
      // The composer is closing under the ringing card. On iOS its
      // onDismiss moves focus; elsewhere a timer covers the close animation.
      ringFocusPendingRef.current = true;
      if (Platform.OS === 'ios') {
        return;
      }
    }
    const focusTimer = setTimeout(
      () => {
        ringFocusPendingRef.current = false;
        focusStopButton();
      },
      isComposerOpen ? 700 : 300,
    );
    return () => clearTimeout(focusTimer);
  }, [ringingCycle?.cycleId]);

  const missedCycleIdsKey = missedCycles.map((cycle) => cycle.cycleId).join('|');
  const missedAnnouncedRef = useRef<ReadonlySet<string>>(new Set());
  // Polite announcement per newly missed cycle id; focus is never moved. The
  // string key changes only when the id set does, so the clock tick is silent.
  useEffect(() => {
    // New ids stay pending (not recorded as announced) until the app is
    // active; becoming active re-runs this effect once.
    if (!isAppActive) {
      return;
    }
    const plan = planMissedAnnouncement({
      announced: missedAnnouncedRef.current,
      missedCycleIds: missedCycles.map((cycle) => cycle.cycleId),
      isRinging: ringingCycle !== null,
    });
    missedAnnouncedRef.current = plan.announced;
    if (plan.announce) {
      announcePolitely(messagesNow().missed.cardAnnouncement);
    }
  }, [missedCycleIdsKey, ringingCycle !== null, isAppActive]);

  const handleComposerDismissed = useCallback(() => {
    if (!ringFocusPendingRef.current) {
      return;
    }
    ringFocusPendingRef.current = false;
    // One frame for the ringing card to settle after the modal is gone.
    setTimeout(focusStopButton, 100);
  }, [focusStopButton]);

  useEffect(() => {
    if (!ringingCycle) {
      stopForegroundAlarmSound();
      return;
    }

    void startForegroundAlarmSound().catch(() => {
      setNotice(noticeFromCodeIn(messagesNow(), 'SOUND_START_FAILED'));
    });
    return stopForegroundAlarmSound;
  }, [ringingCycle?.cycleId]);

  return { stopButtonRef, handleComposerDismissed };
}
