import type { MutableRefObject } from 'react';

import type { StoredAlarmDefinition } from '../alarmStorage';
import type { Messages, TextContext } from '../i18n';
import type { AppNotice } from '../ui/NoticeBanner';

export type Notice = AppNotice;

/** Shows (or with null clears) the one notice banner. */
export type SetNotice = (notice: Notice | null) => void;

/** The language in effect right now, for callbacks that outlive a render. */
export type TextRef = MutableRefObject<TextContext>;

/**
 * The settings sheet's message, kept as a way to write it so a language
 * change reads it again instead of leaving the old sentence behind.
 */
export interface SettingsNotice {
  text: (messages: Messages) => string;
}

/** Reads the sentences of the language in effect right now. */
export type MessagesNow = () => Messages;

/**
 * The epoch-safe setter of the one alarm list: a result read before a
 * finished deletion is dropped instead of reaching the screen.
 */
export type SetCurrentAlarms = (next: StoredAlarmDefinition[]) => void;

/** Latest alarm list for callbacks and listeners that outlive a render. */
export type AlarmsRef = MutableRefObject<StoredAlarmDefinition[]>;
