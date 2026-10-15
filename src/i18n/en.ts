import { enErrors } from './errors.en';
import type { Messages } from './messages';

/** English catalog. Same keys and parameters as the Japanese default. */
const plural = (count: number, one: string, other: string): string =>
  count === 1 ? one : other;

export const en: Messages = {
  common: {
    sentenceGap: ' ',
    errorCode: 'Error code',
    close: 'Close',
    cancel: 'Cancel',
    delete: 'Delete',
    next: 'Next',
    openSettings: 'Open Settings',
    stepsOf: (count, threshold) => `${count} of ${threshold} steps`,
  },

  errors: enErrors,

  repeat: {
    today: 'Today only',
    daily: 'Every day',
    weekdays: 'Weekdays',
    custom: 'Custom days',
    weekdayJoin: ', ',
    sectionLabel: 'Repeat',
    todayOnlyEnded: (date) => `Today only (${date}) · Ended`,
    todayOnlyEndedSpoken: (date) => `Today only, ${date}, ended`,
    todayOnlyEndedExplanation:
      'This day’s alarm has ended. To use it again, add a new alarm.',
  },

  lead: {
    soon: 'Ringing soon',
    daysHours: (days, hours) =>
      `in ${days} ${plural(days, 'day', 'days')} ${hours} ${plural(hours, 'hour', 'hours')}`,
    hoursMinutes: (hours, minutes) =>
      `in ${hours} ${plural(hours, 'hour', 'hours')}${
        minutes > 0 ? ` ${minutes} ${plural(minutes, 'minute', 'minutes')}` : ''
      }`,
    minutes: (minutes) => `in ${minutes} ${plural(minutes, 'minute', 'minutes')}`,
  },

  notifications: {
    checkInTitle: 'Are you up yet?',
    checkInBody: 'Tap “I’m up” only if you are definitely awake.',
    checkInButton: 'I’m up',
    snoozeTitle: '⏰ Snooze is over',
    snoozeBody:
      'The snooze time has come. Open the app to stop the alarm.',
    checkInPreview: 'Wake-up check',
    mainTitle: '⏰ Time to get up',
    mainBody: 'Your wake-up was not confirmed, so the alarm is ringing.',
    keepReservingHint:
      'Open the app to keep scheduling the following alarms.',
    alarmChannel: 'Alarms',
    checkInChannel: 'Wake-up check',
  },

  delivery: {
    titleOff: 'Notifications are off',
    titleSilent: 'Notification sound is off',
    titleUnknown: 'Cannot check notification status',
    reasonOff: 'Notifications are off, so ',
    reasonSilent: 'Notification sound is off, so ',
    reasonUnknown: '',
    withNextOff: 'will not ring unless the app stays on screen.',
    withNextSilent: 'will make no sound unless the app stays on screen.',
    withNextUnknown: 'may not ring.',
    withoutNextOff: 'alarms will not ring unless the app stays on screen.',
    withoutNextSilent:
      'alarms will make no sound unless the app stays on screen.',
    withoutNextUnknown: 'Alarms may not ring.',
    scheduleLineOff: 'Notifications off · rings only while the app is open',
    scheduleLineSilent:
      'Notification sound off · sounds only while the app is open',
    scheduleLineUnknown: 'Cannot check notification status',
    bodyWithNext: (reason, nextAlarm, consequence) =>
      `${reason === '' ? 'The' : `${reason}the`} next alarm, ${nextAlarm}, ${consequence}`,
    bodyWithoutNext: (reason, consequence) => `${reason}${consequence}`,
    openSettingsHint: 'Turn notifications on in your device settings',
  },

  bedside: {
    title: 'When you sleep, keep the app on screen and charging',
    leavesScreen: 'If the screen locks or the app is closed, ',
    detailOk: 'the alarm is a single notification sound with no step check',
    detailOff: 'it will not ring',
    detailSilent: 'it will make no sound',
    detailUnknown: 'it may not ring',
    whenScreenOffOk:
      'the alarm becomes a single notification sound with no step check',
    whenScreenOffOff: 'the alarm will not ring',
    whenScreenOffSilent: 'the alarm will make no sound',
    whenScreenOffUnknown: 'the alarm may not ring',
    keepAwakeFailure: (whenScreenOff) =>
      `Could not keep the screen on. If the screen turns off, ${whenScreenOff}, so turn off auto-lock on your device.`,
  },

  coverage: {
    off: 'No notifications scheduled',
    none: 'Nothing scheduled',
    unverified: 'Cannot check scheduled notifications',
    missing: 'Notification missing from the device · could not reschedule',
    capacityFull: 'Notification limit reached · could not reschedule',
    duplicated: 'An old time is still scheduled, so it may ring twice',
    reservedUntil: (date) => `Scheduled until ${date}`,
    checkInMissing: (until) => `${until} · wake-up check not scheduled`,
    refillFailed: (until) => `${until} · could not schedule later alarms`,
    refillOnOpen: (until) => `${until} · open the app to schedule later alarms`,
  },

  reconcile: {
    unrecoveredNotifications:
      'Some notifications from a schedule that could not be saved are still on the device. Cancelling them will be retried the next time the app starts.',
    orphansUnreadable:
      'The record of notifications that could not be cancelled is unreadable, so new scheduling is paused. Check each alarm’s status.',
    queueUnverified:
      'Cannot check the device’s scheduled notifications, so alarms may not ring. Check each alarm’s status.',
    pendingOrphans:
      'Notifications that could not be cancelled are still on the device. The same alarm may ring twice, so new scheduling is paused. Cancelling them will be retried the next time the app starts.',
    capacityFull:
      'The device’s notification limit (64) is nearly reached, so alarms could not be rescheduled. Delete or turn off alarms you don’t need, then reopen the app.',
    missing:
      'Some alarms have no notification on the device and could not be rescheduled. Check each alarm’s status.',
    duplicated:
      'Both the old and new times are still scheduled, so the same alarm may ring twice.',
    checkInMissing: 'Some wake-up check notifications could not be rescheduled.',
    replannedZone:
      'Upcoming alarms were rescheduled to match the time zone change.',
    replannedTime:
      'Upcoming alarms were rescheduled to match the change in time.',
    repaired: 'Alarm notifications that had disappeared from the device were rescheduled.',
  },

  steps: {
    preparing: 'Preparing the pedometer',
    counting: 'Counting only while the app is open',
    windowStarts: (start) => `Wake-up check starts at ${start}`,
    windowStartsSpoken: (start, threshold) =>
      `Wake-up check starts at ${start}. It is confirmed by ${threshold} steps while the app is open.`,
    whileOpen: (threshold) => `${threshold} steps while the app is open`,
    progressLabel: 'Wake-up check steps',
    progress: (count, threshold) =>
      `Wake-up check ${count} / ${threshold} steps`,
  },

  storageLoadFailed: {
    title: 'Cannot load your alarms',
    body: 'Alarms you set earlier may still ring. Scheduled notifications have not been cancelled.',
    addDisabledReason: 'New alarms cannot be added because alarms cannot be loaded.',
    restartSteps: [
      'Swipe the app up to quit it completely, then open it again.',
      'If that does not help, restart your device and open the app.',
      'Until this is confirmed, also use another alarm.',
    ],
    lastResort:
      'As a last resort if restarting does not help, you can cancel this app’s scheduled notifications and reset its saved data. Other apps’ notifications are not cancelled.',
    resetAction: 'Cancel notifications and reset',
    resetHint:
      'Cancels the scheduled notifications confirmed to belong to this app and deletes saved data. You will be asked to confirm twice.',
    resetFirstTitle: 'Cancel notifications and reset?',
    resetFirstBody:
      'This cancels the scheduled notifications confirmed to belong to this app and deletes the saved alarms. You will need to create your alarms again.',
    resetFinalTitle: 'Really reset?',
    resetFinalBody:
      'Cancelled notifications and deleted data cannot be restored. Use another alarm until the reset is finished.',
    resetDone: 'Reset complete. You can add alarms now.',
    resetAmbiguous:
      'Reset complete. However, old-format notifications that cannot be identified as this app’s remain. They may belong to other apps, so they were not cancelled, and they may still ring. Check your device’s notification settings and schedules.',
  },

  edit: {
    editLabel: 'Edit',
    editHint:
      'Changes the time and repeat. For an alarm that is on, notifications are scheduled again.',
    editSpoken: (time, repeat) => `Edit the ${time} alarm, ${repeat}`,
    cleanupPending: (clock) =>
      `Changed to ${clock}, but some old notifications could not be removed. Notifications for the old time may still ring. Reopen the app to retry.`,
    savedOff: (clock) => `Changed to ${clock}. The alarm is still off.`,
    savedNext: (clock, date) =>
      `Alarm changed to ${clock}. It will next ring ${date} at ${clock}.`,
    saved: (clock) => `Alarm changed to ${clock}.`,
  },

  skip: {
    label: 'Skip this time',
    hint: 'Skips only this occurrence. The repeat setting does not change. To stop the whole alarm, use the switch in the list.',
    spoken: (when) => `Skip the ${when} occurrence only`,
    confirmTitle: 'Skip this time only?',
    confirmBody: (when) =>
      `Skips only the ${when} occurrence. Other scheduled occurrences and the repeat setting do not change.`,
    done: 'Skipped this occurrence. The repeat setting did not change.',
    stoppedRefillFailed:
      'This occurrence was stopped. Updating the next schedule failed, so check the alarm’s state.',
    failed: 'Could not skip this time. The alarm stays on to be safe.',
  },

  sun: {
    heading: 'Background sunrise and sunset',
    body: 'Only used to time the background brightness changes. It does not affect alarm times or ringing.',
    fixedLabel: 'Fixed times',
    fixedDetail: 'Sunrise 6:00 · sunset 18:00 (default)',
    regionHeading: 'Choose a region (location is not used)',
    deviceHint: 'Uses your approximate location once, only when you press it.',
    deviceUse: 'Use current location',
    deviceInUse: 'Using current location (about 10 km)',
    deviceDetail:
      'Checks your approximate location once, only when you press the button. It is rounded to about 10 km, stored only on this device, and never tracked or sent.',
    selectedMarker: '✓ Selected',
    regions: {
      sapporo: 'Sapporo',
      tokyo: 'Tokyo',
      osaka: 'Osaka',
      naha: 'Naha',
      honolulu: 'Honolulu',
      'los-angeles': 'Los Angeles',
      'new-york': 'New York',
      london: 'London',
      tromso: 'Tromsø (Norway)',
      sydney: 'Sydney',
      auckland: 'Auckland',
    },
    status: {
      'invalid-saved': 'The saved setting could not be read, so fixed times are used.',
      'permission-revoked': 'Location permission is off, so fixed times are used again.',
      'timezone-changed': 'The device time zone changed, so fixed times are used again.',
      polar: 'There is no sunrise or sunset here today, so fixed times are used.',
      denied: 'Location was not allowed, so fixed times stay in use.',
      timeout: 'Could not get your location, so fixed times stay in use.',
      error: 'Could not get your location, so fixed times stay in use.',
      'unsupported-timezone':
        'Could not confirm the time zone, so fixed times stay in use.',
      'reset-pending':
        'This setting cannot be changed until data deletion finishes. Run “Delete data” again.',
    },
    keptStatus: {
      denied: 'Location was not allowed, so your previous setting stays in use.',
      timeout: 'Could not get your location, so your previous setting stays in use.',
      error: 'Could not get your location, so your previous setting stays in use.',
      'unsupported-timezone':
        'Could not confirm the time zone, so your previous setting stays in use.',
    },
  },

  suppression: {
    saveFailedTitle: 'Cannot save the stop record',
    saveFailedBody:
      'Your wake-up was confirmed and the notifications were cancelled, but that state could not be saved. Reopen the app to retry recovery. Until then, the schedule on screen may differ from the actual notifications.',
    statusUnknownTitle: 'Stop and schedule status is unconfirmed',
    statusUnknownBody:
      'Could not confirm whether the notifications were cancelled. This alarm may or may not ring. Use another alarm as well.',
    skippedThisTime: (when) =>
      `${when} will not ring because you skipped this one`,
    suppressedBy: (when, byStep) =>
      `${when} will not ring because wake-up was confirmed ${
        byStep ? 'by steps' : 'from the notification'
      }`,
  },

  summary: {
    pickWeekdays: 'Select days to see the first date and time',
    todayPassed: (clock) =>
      `${clock} today has already passed. Choose another time.`,
    originalDayPassed: (clock) =>
      `${clock} on that day has already passed. Choose another time.`,
    savedOff: (repeat) =>
      `${repeat} · saved as off (turn it on to schedule notifications)`,
    cannotCompute: 'Cannot work out the first date and time',
    tooSoon: (clock) =>
      `${clock} is too soon to schedule. Choose another time.`,
    firstRing: (repeat, date, clock, lead) =>
      `${repeat} · first ${date} ${clock} (${lead})`,
  },

  ringing: {
    stopLabel: 'Stop alarm',
    stopHint: 'Stops the ringing sound. Later repeats are kept.',
    stopSpoken: (clock, stopLabel, date) =>
      `The ${clock} alarm${date ? ` for ${date}` : ''} is ringing. ${stopLabel}`,
    badge: 'Ringing',
    title: 'Time to get up',
    lockedNotice: (stopLabel) =>
      `Alarms cannot be switched, edited or deleted while one is ringing. Tap “${stopLabel}” first.`,
    snoozedLockedNotice: (stopLabel) =>
      `While a snooze is waiting, you can’t turn alarms on or off, edit them, or delete them. Press “${stopLabel}” first.`,
    persistFailed: 'Could not save the ringing alarm state.',
    stopped: 'Alarm stopped.',
  },

  snooze: {
    waitingTitle: 'Snoozing',
    waitingDetail: (clock, used, max) =>
      `Rings again at ${clock} (snooze ${used} of ${max}). This does not count as waking up.`,
    stopLabel: 'Stop alarm',
    stopHint: 'Also cancels the scheduled ring and ends this alarm.',
    title: 'Snooze',
    exhaustedDetail: (max) =>
      `You can snooze up to ${max} times. It keeps ringing until you stop it.`,
    actionLabel: (minutes) => `Ring again in ${minutes} minutes`,
    exhaustedHint: 'Unavailable because the snooze limit has been reached.',
    availableDetail: (clock, remaining) =>
      `Rings again at ${clock} (${plural(remaining, '1 more snooze', `${remaining} more snoozes`)} left). This does not count as waking up.`,
    actionHint: (minutes) =>
      `Stops the sound now and rings again in ${minutes} minutes.`,
    snoozed: (clock) => `Snoozed. It rings again at ${clock}.`,
  },

  checkIn: {
    confirmed: 'Wake-up confirmed. Only this time’s alarm was stopped.',
    failed: 'Confirming your wake-up failed. The alarm is kept for safety.',
    stepsDetected: '100 steps detected. Only this time’s alarm was stopped.',
    stepsCancelUnconfirmed:
      '100 steps detected, but stopping the notification could not be confirmed. The alarm stays on.',
  },

  missed: {
    title: 'Missed alarms',
    explanation: 'No sound will play. It is not known whether you woke up.',
    total: (count) => `${count} missed ${plural(count, 'alarm', 'alarms')} in total`,
    hidden: (count) => `${count} more`,
    acknowledgeAll: 'Mark all as seen',
    acknowledgeAllHint:
      'Marks every missed alarm as seen. Upcoming repeats are kept.',
    acknowledgeAllSpoken: (count) =>
      `Mark ${count} missed ${plural(count, 'alarm', 'alarms')} as seen`,
    cardAnnouncement:
      'You have missed alarms. No sound was played. You can mark them as seen.',
    acknowledged: 'Missed alarms were marked as seen.',
    acknowledgeRefillFailed:
      'Marked as seen, but the next alarms could not be scheduled. Check the alarm status.',
  },

  scheduleIssue: {
    incomplete: 'Some occurrences are not fully scheduled.',
    nextLead: 'Next occurrences: ',
    addedLead: 'The alarm was added. ',
    enabledLead: 'The alarm was turned on. ',
    changedLead: (clock) => `Changed to ${clock}. `,
  },

  refill: {
  },

  alarmList: {
    loading: 'Checking your alarms…',
    title: 'Alarms',
    tagline: 'A quiet start to your morning.',
    add: 'Add alarm',
    nextAlarm: 'Next alarm',
    noNextTitle: 'No upcoming alarm',
    noNextEmpty: 'Use the + at the top right to add a wake-up time.',
    noNextOff: 'Turn on a switch in the list to set the next alarm.',
    noNextNone:
      'Nothing is scheduled next. Check the time and repeat you set.',
    listHeading: 'Your alarms',
    emptyTitle: 'No alarms yet',
    emptyBody: 'Choose a time and repeat to add your first alarm.',
    nextOccurrence: (date) => ` · Next ${date}`,
    noNextOccurrence: ' · Nothing scheduled next',
    off: ' · Off',
    toggleHintEnded: 'This alarm has ended and cannot be turned on. Add a new alarm.',
    toggleHintOn:
      'Switch for the whole alarm. Turning it off cancels the notifications of every occurrence, including repeats. To stop only this occurrence, use Skip this time above.',
    rowSpoken: (time, repeat) => `${time} alarm, ${repeat}, all occurrences`,
    deleteSpoken: (time, repeat) => `Delete the ${time} alarm, ${repeat}`,
    warningLabel: 'Warning',
    webOnly: 'Notifications and step counting work on a real iPhone or Android device.',
    added: (clock, firstRing) =>
      `Added the ${clock} alarm. It first rings ${firstRing}.`,
    deleted: 'Alarm deleted.',
    deleteTitle: 'Delete this alarm?',
    deleteBody: (time, repeat) => `This deletes the ${time} alarm (${repeat}).`,
  },

  settings: {
    openLabel: 'Settings and privacy',
    openHint: 'Opens an explanation of the saved data and how to delete it',
    title: 'Settings and privacy',
    subtitle: 'Saved data and deletion',
    summaryHeading: 'Data we save',
    summary: [
      'Alarm times, repeats and on/off state, the identifiers of scheduled notifications, and the 100-step count and the time and state of wake-up confirmations are saved only on this device.',
      'Steps are counted only while the app is open. Raw motion data such as acceleration, and Health data, are not saved.',
      'This app does not send your saved alarms anywhere. However, the Expo development server used during development does communicate, for example to load the app.',
    ],
    deleteHeading: 'Delete data',
    deleteBody:
      'Cancels the notifications this app scheduled and erases the alarm data and recovery records on this device. Other apps’ notifications and data are not touched.',
    deleteAction: 'Delete data',
    deleteHint:
      'You will be asked to confirm twice. If it stops partway, run it again to continue',
    firstConfirmTitle: 'Delete your data?',
    firstConfirmBody:
      'This cancels the notifications this app scheduled and erases the saved alarms. Other apps’ notifications are not cancelled. You will need to create your alarms again.',
    finalConfirmTitle: 'Really delete?',
    finalConfirmBody:
      'Cancelled notifications and erased data cannot be restored. Use another alarm until deletion is finished.',
    confirmAction: 'Delete',
    done: 'This app’s data and scheduled notifications were deleted.',
    ambiguousWarning:
      'Deleted. However, old-format notifications that cannot be identified as this app’s remain. They may belong to other apps, so they were not cancelled, and they may still ring. Check your device’s notification settings.',
    failed:
      'Deletion could not be completed. Some notifications or data may already be gone. Alarms cannot be added or changed until deletion finishes. Run “Delete data” again to continue where it stopped.',
    failedHome:
      'Deleting your data could not be completed. Alarms cannot be added or changed until deletion finishes. Open “Settings and privacy”, then run “Delete data” again to continue where it stopped.',
    blockedRinging: 'Data cannot be deleted while an alarm is ringing. Stop it first.',
    blockedBusy: 'Please wait until the current operation finishes.',
    blockedLoading: 'Please wait until loading finishes.',
  },

  composer: {
    timeInputInvalid: 'Enter an hour from 0 to 23 and a minute from 0 to 59.',
    title: 'Add alarm',
    subtitle: 'Choose a time and repeat',
    editTitle: 'Edit alarm',
    editSubtitle: 'Saving reschedules the notifications of this alarm only',
    close: 'Close',
    tabsLabel: 'Settings sections',
    tabTime: 'Time',
    tabRepeat: 'Repeat',
    tabLockedHint: 'Confirm or cancel the time before switching',
    hour: 'Hour',
    minute: 'Minute',
    timeCancel: 'Cancel',
    timeConfirm: 'Set this time',
    dialTitle: 'Time dial',
    dialHint: 'Scroll up or down to choose',
    dialSpoken: 'Choose the alarm time with the dial',
    openDialSpoken: 'Choose the time with the dial',
    openDialHint: 'Opens the Android clock dial',
    openDialTitle: 'Choose with the clock dial',
    openDialTap: 'Tap to open',
    openDialSet: 'Set with the dial',
    needsDevice: 'Works on a real device in Expo Go',
    typeTimeHint: 'Type the hour and minute with the keyboard',
    typeTimeSpoken: (clock) => `${clock}, type the time with the keyboard`,
    selected: 'Selected',
    typeDigits: 'Type digits',
    tapTime: 'Tap the time',
    pickDays: 'Choose the days to ring',
    weekdayHint: 'Days to ring',
    weekdayNeeded: 'Choose at least one day under “Repeat”.',
    behaviorTitle: 'Confirm wake-up with 100 steps',
    behaviorBody:
      'Steps are counted from 60 minutes before the alarm, while the app is on screen. Only that alarm is stopped; other times are not affected.',
    summarySpoken: (summary) => `To be added. ${summary}`,
    editSummarySpoken: (summary) => `To be saved. ${summary}`,
    deviceHint: 'Adding alarms works on a real device in Expo Go',
    bedsideNote: (title, detail) => `${title}. ${detail}.`,
    submit: 'Add with these settings',
    editSubmit: 'Save with these settings',
  },

  notice: {
    dismiss: 'Dismiss notice',
    dismissHint: 'You can also swipe up to dismiss',
  },
};
