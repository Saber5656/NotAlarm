import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { getRingingCycle } from '../alarmScheduling';
import type { StoredAlarm } from '../alarmStorage';
import type { ErrorCode } from '../errorCatalog';
import type { Messages } from '../i18n';
import { noticeFromCodeIn } from '../i18n';
import { localizedNotice } from '../i18n/localizedNotice';
import {
  canCloseSettings,
  deleteAllLocalData,
  getLocalDataDeletionAvailability,
} from '../localDataDeletion';
import type { SunBackgroundState } from '../useSunBackground';
import { storageReset } from './platform/gateways';
import type {
  AlarmsRef,
  MessagesNow,
  SetCurrentAlarms,
  SetNotice,
  SettingsNotice,
  TextRef,
} from './types';

function blockedDeletionNotice(state: {
  isRinging: boolean;
  isBusy: boolean;
  isLoaded: boolean;
}): SettingsNotice {
  return {
    text: (messages) => {
      const availability = getLocalDataDeletionAvailability(state, messages);
      return availability.allowed ? '' : availability.reason;
    },
  };
}

export interface LocalDataDeletionInput {
  alarmsRef: AlarmsRef;
  messages: Messages;
  messagesNow: MessagesNow;
  textRef: TextRef;
  isBusy: boolean;
  setIsBusy(busy: boolean): void;
  isLoaded: boolean;
  loadFailed: boolean;
  ringingCycle: StoredAlarm | null;
  sun: SunBackgroundState;
  setNotice: SetNotice;
  setCurrentAlarms: SetCurrentAlarms;
  setLoadFailed(failed: boolean): void;
  setLoadFailureCode(code: ErrorCode | null): void;
  setDeletionPending(pending: boolean): void;
  setSuppressionWarning(warning: null): void;
  /** Forgets everything remembered for the deleted alarms. */
  forgetDeletedAlarms(): void;
}

/**
 * Both ways of deleting local data: the settings sheet and the recovery card
 * on a failed load. Each is a two-step confirmation, runs the one reset
 * service, invalidates the sun lookup before awaiting and settles it after.
 */
export function useLocalDataDeletion({
  alarmsRef,
  messages,
  messagesNow,
  textRef,
  isBusy,
  setIsBusy,
  isLoaded,
  loadFailed,
  ringingCycle,
  sun,
  setNotice,
  setCurrentAlarms,
  setLoadFailed,
  setLoadFailureCode,
  setDeletionPending,
  setSuppressionWarning,
  forgetDeletedAlarms,
}: LocalDataDeletionInput) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<SettingsNotice | null>(null);
  // isBusy in a closure can be stale between the two Alert steps.
  const deletionInFlightRef = useRef(false);

  const applyLocalDataDeleted = useCallback(() => {
    // Warnings remembered for the deleted alarms must not mute new ones.
    forgetDeletedAlarms();
    setCurrentAlarms([]);
    setSuppressionWarning(null);
    setLoadFailed(false);
    setLoadFailureCode(null);
    setDeletionPending(false);
  }, [forgetDeletedAlarms, setCurrentAlarms]);

  const performStorageReset = useCallback(async () => {
    if (!loadFailed || isBusy) {
      return;
    }
    setIsBusy(true);
    // Before any await: an in-flight GPS answer or save must now do nothing.
    sun.beginDeletion();
    try {
      const { ambiguousCount } = await storageReset.reset();
      applyLocalDataDeleted();
      sun.completeDeletion();
      setNotice(
        ambiguousCount > 0
          ? localizedNotice(
              (t) => ({
                tone: 'danger',
                text: t.messages.storageLoadFailed.resetAmbiguous,
              }),
              textRef.current,
            )
          : { tone: 'neutral', text: messagesNow().storageLoadFailed.resetDone },
      );
    } catch {
      // The failure card stays; part of the data may already be gone and a
      // retry resumes from the saved intent.
      sun.failDeletion();
      setNotice(noticeFromCodeIn(messagesNow(), 'STORAGE_RESET_INCOMPLETE'));
    } finally {
      setIsBusy(false);
    }
  }, [applyLocalDataDeleted, isBusy, loadFailed, sun]);

  const performLocalDataDeletion = useCallback(async () => {
    // Re-checked when the dialog is confirmed: an alarm may have started.
    const deletionState = {
      isRinging: getRingingCycle(alarmsRef.current) !== null,
      isBusy,
      isLoaded,
    };
    if (!getLocalDataDeletionAvailability(deletionState, messagesNow()).allowed) {
      setSettingsNotice(blockedDeletionNotice(deletionState));
      return;
    }
    if (deletionInFlightRef.current) {
      return;
    }
    deletionInFlightRef.current = true;
    setIsBusy(true);
    setSettingsNotice(null);
    sun.beginDeletion();
    try {
      const outcome = await deleteAllLocalData(storageReset);
      if (outcome.kind === 'failed') {
        sun.failDeletion();
        // The in-memory list is not rewritten; storage may be partly removed,
        // and alarm writes are refused until a retry finishes.
        setDeletionPending(true);
        setSettingsNotice({ text: (m) => m.settings.failed });
        // Also on home, so the failure and the retry steps outlive the sheet.
        setNotice(
          localizedNotice(
            (t) => ({ tone: 'danger', text: t.messages.settings.failedHome }),
            textRef.current,
          ),
        );
        return;
      }
      applyLocalDataDeleted();
      sun.completeDeletion();
      setIsSettingsOpen(false);
      setNotice(
        outcome.ambiguousCount > 0
          ? localizedNotice(
              (t) => ({ tone: 'danger', text: t.messages.settings.ambiguousWarning }),
              textRef.current,
            )
          : { tone: 'neutral', text: messagesNow().settings.done },
      );
    } finally {
      deletionInFlightRef.current = false;
      setIsBusy(false);
    }
  }, [applyLocalDataDeleted, isBusy, isLoaded, sun]);

  // Back, backdrop and the close button all land here; the ref is read at call
  // time so a deletion started a moment ago still blocks them.
  const closeSettings = useCallback(() => {
    if (canCloseSettings({ deletionInFlight: deletionInFlightRef.current })) {
      setIsSettingsOpen(false);
    }
  }, []);

  const openSettings = () => {
    setNotice(null);
    setSettingsNotice(null);
    setIsSettingsOpen(true);
  };

  const confirmLocalDataDeletion = useCallback(() => {
    const deletionState = {
      isRinging: getRingingCycle(alarmsRef.current) !== null,
      isBusy,
      isLoaded,
    };
    if (!getLocalDataDeletionAvailability(deletionState, messagesNow()).allowed) {
      setSettingsNotice(blockedDeletionNotice(deletionState));
      return;
    }
    Alert.alert(
      messages.settings.firstConfirmTitle,
      messages.settings.firstConfirmBody,
      [
        { text: messages.common.cancel, style: 'cancel' },
        {
          text: messages.common.next,
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              messages.settings.finalConfirmTitle,
              messages.settings.finalConfirmBody,
              [
                { text: messages.common.cancel, style: 'cancel' },
                {
                  text: messages.settings.confirmAction,
                  style: 'destructive',
                  onPress: () => void performLocalDataDeletion(),
                },
              ],
            ),
        },
      ],
    );
  }, [isBusy, isLoaded, messages, performLocalDataDeletion]);

  const confirmStorageReset = useCallback(() => {
    if (!loadFailed || isBusy) {
      return;
    }
    Alert.alert(
      messages.storageLoadFailed.resetFirstTitle,
      messages.storageLoadFailed.resetFirstBody,
      [
        { text: messages.common.cancel, style: 'cancel' },
        {
          text: messages.common.next,
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              messages.storageLoadFailed.resetFinalTitle,
              messages.storageLoadFailed.resetFinalBody,
              [
                { text: messages.common.cancel, style: 'cancel' },
                {
                  text: messages.storageLoadFailed.resetAction,
                  style: 'destructive',
                  onPress: () => void performStorageReset(),
                },
              ],
            ),
        },
      ],
    );
  }, [isBusy, loadFailed, messages, performStorageReset]);

  useEffect(() => {
    // A ringing alarm takes the screen; the sheet must not reappear after stop.
    if (ringingCycle) {
      setIsSettingsOpen(false);
    }
  }, [ringingCycle]);

  return {
    isSettingsOpen,
    settingsNotice,
    openSettings,
    closeSettings,
    confirmLocalDataDeletion,
    confirmStorageReset,
  };
}
