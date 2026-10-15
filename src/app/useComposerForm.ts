import { useCallback, useState } from 'react';

import type { RepeatKind, Weekday } from '../alarmSchedule';
import { resolveComposerValues } from '../homeStatus';
import { defaultWakeTime } from './core/formatters';
import type { Notice, SetNotice } from './types';

/**
 * The composer sheet: whether it is open, which alarm it edits (null while
 * adding) and the values on the form. The submit actions live with the alarm
 * mutations; this hook only owns the form.
 */
export function useComposerForm(notice: Notice | null, setNotice: SetNotice) {
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  // The alarm the open composer is editing; null while adding a new one.
  const [editingAlarmId, setEditingAlarmId] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState(defaultWakeTime);
  const [repeatKind, setRepeatKind] = useState<RepeatKind>('weekdays');
  const [customWeekdays, setCustomWeekdays] = useState<Weekday[]>([1, 2, 3, 4, 5]);

  const toggleCustomWeekday = (weekday: Weekday) => {
    setCustomWeekdays((current) =>
      current.includes(weekday)
        ? current.filter((day) => day !== weekday)
        : ([...current, weekday].sort(
            (left, right) => left - right,
          ) as Weekday[]),
    );
  };

  const openAddComposer = () => {
    setNotice(null);
    // Always start from the defaults, whatever the form held before.
    const values = resolveComposerValues({
      mode: 'add',
      current: { selectedTime, repeatKind, customWeekdays },
      defaultWakeTime: defaultWakeTime(),
    });
    setEditingAlarmId(null);
    setSelectedTime(values.selectedTime);
    setRepeatKind(values.repeatKind);
    setCustomWeekdays(values.customWeekdays);
    setIsComposerOpen(true);
  };

  const closeComposer = () => {
    setIsComposerOpen(false);
    setEditingAlarmId(null);
    if (notice?.tone === 'danger' || notice?.tone === 'warning') {
      setNotice(null);
    }
  };

  /** A ringing alarm takes the screen: the composer gives way. */
  const closeComposerForRinging = useCallback(() => {
    setIsComposerOpen(false);
    setEditingAlarmId(null);
  }, []);

  return {
    isComposerOpen,
    setIsComposerOpen,
    editingAlarmId,
    setEditingAlarmId,
    selectedTime,
    setSelectedTime,
    repeatKind,
    setRepeatKind,
    customWeekdays,
    setCustomWeekdays,
    toggleCustomWeekday,
    openAddComposer,
    closeComposer,
    closeComposerForRinging,
  };
}

export type ComposerForm = ReturnType<typeof useComposerForm>;
