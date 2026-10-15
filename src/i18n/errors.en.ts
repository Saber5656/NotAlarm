import type { ErrorTexts } from '../errorCatalog';

/**
 * English texts for every catalog code. The code, tone and retry policy stay
 * in `src/errorCatalog.ts`; this table only supplies the sentences. Each text
 * keeps the claims of the Japanese entry: what is known, what is not, and who
 * retries.
 */
export const enErrors: ErrorTexts = {
  NTF_UNSUPPORTED_PLATFORM: {
    message: 'Notifications can’t be scheduled in this environment.',
    recovery: 'Open the app on an iPhone or Android device.',
  },
  NTF_PERMISSION_DENIED: {
    message: 'Notifications aren’t allowed, so the alarm was not scheduled.',
    recovery: 'Turn on notifications in the Settings app, then try again.',
  },
  NTF_PERMISSION_CHECK_FAILED: {
    message:
      'Couldn’t check the notification permission, so the alarm was not scheduled.',
    recovery: 'Wait a moment, then try again.',
  },
  NTF_SETUP_FAILED: {
    message: 'Notification setup failed, so the alarm was not scheduled.',
    recovery: 'Reopen the app, then try again.',
  },
  MAIN_REGISTER_FAILED: {
    message: 'Couldn’t schedule the main alarm notification.',
    recovery:
      'Use another alarm as a backup. The app won’t retry automatically. Try again.',
  },
  MAIN_REGISTER_UNCONFIRMED: {
    message:
      'Couldn’t confirm whether the main alarm notification was scheduled. It may be scheduled.',
    recovery:
      'Use another alarm as a backup. Identifiers of notifications that may have been scheduled were saved on this device before scheduling. When you reopen the app, it will check them and cancel them again. Until then, no new alarms will be scheduled.',
  },
  MAIN_UNVERIFIED: {
    message:
      'Couldn’t confirm that the main alarm notification was scheduled. It may not ring.',
    recovery:
      'Use another alarm as a backup. Identifiers of notifications that may have been scheduled are saved on this device. When you reopen the app, it will check them and cancel them again. Until then, no new alarms will be scheduled.',
  },
  MAIN_RECONCILE_PENDING: {
    message:
      'A previously scheduled notification hasn’t been checked yet, so the new alarm was not scheduled.',
    recovery:
      'Use another alarm as a backup. When you reopen the app, it will check and clean up. Repeating the same action won’t schedule anything until then.',
  },
  MAIN_UNVERIFIED_CANCELLED: {
    message:
      'Couldn’t confirm that the main alarm notification was scheduled. The notification was canceled.',
    recovery: 'The alarm is not scheduled. Use another alarm as a backup. Try again.',
  },
  MAIN_UNVERIFIED_MEMORY_ONLY: {
    message:
      'Couldn’t confirm that the main alarm notification was scheduled, and it couldn’t be canceled or saved. It may not ring.',
    recovery:
      'Use another alarm as a backup. If you quit this app, that notification can no longer be tracked. Keep the app open without quitting it, or remove it with “Delete data” in Settings (your alarm settings will be deleted too). Until then, no new alarms will be scheduled.',
  },
  MAIN_PARTIAL: {
    message: 'Some main notifications couldn’t be scheduled.',
    recovery: 'Check the status of each alarm. Use another alarm as a backup.',
  },
  CHECKIN_REGISTER_FAILED: {
    message:
      'Couldn’t schedule the wake-up check notification. The main alarm is scheduled.',
    recovery: 'Stopping by wake-up check isn’t available for this occurrence.',
  },
  CHECKIN_PARTIAL: {
    message: 'Some wake-up check notifications couldn’t be scheduled.',
    recovery:
      'Stopping by wake-up check isn’t available for those occurrences. The main alarm was not changed.',
  },
  SENSOR_UNAVAILABLE: {
    message: 'Step counting isn’t available on this device.',
    recovery: 'Step-based stopping can’t be confirmed. Check your schedule.',
  },
  SENSOR_AVAILABILITY_UNKNOWN: {
    message: 'Couldn’t check whether the step counter is available.',
    recovery: 'Step-based stopping can’t be confirmed. Check your schedule.',
  },
  SENSOR_PERMISSION_DENIED: {
    message: 'Step counting isn’t allowed.',
    recovery: 'Step-based stopping can’t be confirmed. Check your schedule.',
  },
  SENSOR_PERMISSION_UNKNOWN: {
    message: 'Couldn’t check the step counting permission.',
    recovery: 'Step-based stopping can’t be confirmed. Check your schedule.',
  },
  SENSOR_READ_FAILED: {
    message: 'Couldn’t count steps.',
    recovery: 'Step-based stopping can’t be confirmed. Check your schedule.',
  },
  STORAGE_READ_FAILED: {
    message: 'Couldn’t read the saved alarm data.',
    recovery: 'Scheduled notifications were not canceled. Reopen the app.',
  },
  STORAGE_CORRUPT: {
    message: 'The saved alarm data is in an unreadable format.',
    recovery:
      'Scheduled notifications were not canceled. Use another alarm as a backup until this is confirmed.',
  },
  STORAGE_SAVE_FAILED: {
    message: 'Couldn’t save the alarm data.',
    recovery: 'Your change was not applied. Try again.',
  },
  STORAGE_JOURNAL_CORRUPT: {
    message: 'The record of an unfinished operation is in an unreadable format.',
    recovery:
      'The state of the notifications is unconfirmed. Use another alarm as a backup. If this keeps happening, you can use “Delete data” in Settings to remove all of this app’s alarms and scheduled notifications (your alarm settings will be deleted too).',
  },
  STORAGE_JOURNAL_SAVE_FAILED: {
    message: 'Couldn’t save the operation record.',
    recovery: 'The action wasn’t performed because it couldn’t be recorded. Try again.',
  },
  STORAGE_RESET_PENDING: {
    message: 'Deleting data was interrupted.',
    recovery: 'Run “Delete data” in Settings again to finish it.',
  },
  STORAGE_RESET_INCOMPLETE: {
    message: 'Couldn’t finish deleting. Some notifications or data may already be gone.',
    recovery: 'Run it again to continue from where it stopped.',
  },
  ACTION_INVALID: {
    message: 'The wake-up check wasn’t valid, so the alarm will stay on.',
    recovery: 'No action needed.',
  },
  ACTION_STALE: {
    message:
      'This check doesn’t match the current alarm cycle, so the alarm will stay on.',
    recovery: 'No action needed.',
  },
  DEADLINE_PASSED: {
    message: 'The alarm time has arrived, so it wasn’t stopped.',
    recovery: 'The alarm will ring.',
  },
  SKIP_BEFORE_WINDOW: {
    message:
      'It’s not yet time when the alarm can be stopped (from 60 minutes before), so the alarm will stay on.',
    recovery: 'No action needed.',
  },
  WRONG_OCCURRENCE: {
    message:
      'It wasn’t stopped because the occurrence is different from the one you checked.',
    recovery: 'The alarm will stay on.',
  },
  TIME_PAST_TODAY: {
    message: 'For “Today only”, choose a time later than now.',
    recovery: 'Choose the time again.',
  },
  TIME_UNCOMPUTABLE: {
    message: 'Couldn’t calculate the next alarm time.',
    recovery: 'Choose the time or repeat settings again.',
  },
  TIME_INVALID: {
    message: 'The alarm time or date isn’t valid.',
    recovery: 'Choose the time again.',
  },
  REPEAT_INVALID: {
    message: 'The repeat setting isn’t valid.',
    recovery: 'Choose at least one day to repeat.',
  },
  ALARM_TODAY_ENDED: {
    message: 'This “Today only” alarm has ended.',
    recovery: 'Delete it and add a new alarm.',
  },
  ARM_LEAD_TOO_SHORT: {
    message: 'The alarm is less than 10 seconds away, so it can’t be turned on.',
    recovery: 'Try again after that time has passed.',
  },
  ALARM_LIMIT_REACHED: {
    message: 'You’ve reached the maximum number of alarms.',
    recovery: 'Delete alarms you don’t need, then add a new one.',
  },
  ALARM_NOT_FOUND: {
    message: 'The alarm couldn’t be found.',
    recovery: 'Check the list.',
  },
  STEP_COUNT_INVALID: {
    message: 'The step count wasn’t valid, so it wasn’t recorded.',
    recovery: 'The alarm will stay on.',
  },
  CANCEL_UNKNOWN: {
    message:
      'Couldn’t confirm whether the notification was canceled. It’s unknown whether this occurrence will ring.',
    recovery:
      'Use another alarm as a backup. The app won’t try to cancel it again automatically. When you reopen the app, it will only check the scheduled state.',
  },
  CANCEL_NOT_VERIFIED: {
    message: 'Couldn’t confirm that the alarm was stopped.',
    recovery: 'Assume it will ring.',
  },
  SUPPRESSION_JOURNAL_NOT_WRITTEN: {
    message: 'Couldn’t save the stop record, so the notification was not canceled.',
    recovery: 'The alarm will ring as scheduled.',
  },
  SUPPRESSION_SAVE_FAILED: {
    message:
      'Your wake-up was confirmed and the notification was canceled, but the state couldn’t be saved.',
    recovery: 'When you reopen the app, it will restore the state from the stop record.',
  },
  CANCEL_RECOVERY_INCOMPLETE: {
    message: 'Couldn’t finish the previous alarm stop.',
    recovery:
      'An occurrence you stopped may still ring. Use another alarm as a backup. When you reopen the app, it will retry from where it left off. If this keeps happening, you can use “Delete data” in Settings to remove all of this app’s alarms and scheduled notifications (your alarm settings will be deleted too).',
  },
  DISABLE_CANCEL_INCOMPLETE: {
    message: 'Couldn’t finish canceling the notifications.',
    recovery:
      'When you reopen the app, it will continue the stop process from where it left off.',
  },
  DELETE_CANCEL_INCOMPLETE: {
    message: 'Couldn’t finish deleting the alarm.',
    recovery:
      'When you reopen the app, it will continue the stop process from where it left off.',
  },
  ROLLBACK_INCOMPLETE: {
    message:
      'Couldn’t save the alarm settings, and some scheduled notifications couldn’t be canceled.',
    recovery:
      'The notifications that couldn’t be canceled were not recorded and may ring. Use another alarm as a backup. If this keeps happening, you can use “Delete data” in Settings to remove all of this app’s alarms and scheduled notifications (your alarm settings will be deleted too).',
  },
  ROLLBACK_INCOMPLETE_RECORDED: {
    message:
      'Couldn’t save the alarm settings, and some scheduled notifications couldn’t be canceled.',
    recovery:
      'Identifiers of the notifications that couldn’t be canceled are saved on this device. When you reopen the app, it will check them and cancel them again. They may ring until then. Use another alarm as a backup.',
  },
  NOTIFICATION_CANCEL_UNVERIFIED: {
    message: 'Couldn’t confirm that the alarm notification was canceled.',
    recovery:
      'That notification may ring. Use another alarm as a backup. If this keeps happening, you can use “Delete data” in Settings to remove all of this app’s alarms and scheduled notifications (your alarm settings will be deleted too).',
  },
  EDIT_LOCKED: {
    message: 'You can’t edit an alarm while it’s ringing.',
    recovery: 'Stop the alarm first, then edit it again.',
  },
  EDIT_LOCKED_SNOOZED: {
    message: 'You can’t edit an alarm while it’s snoozed.',
    recovery: 'Stop the alarm first, then edit it again.',
  },
  EDIT_UNSETTLED: {
    message: 'The previous operation on this alarm hasn’t finished.',
    recovery:
      'Reopen the app and wait for it to finish, then try again. This alarm was not changed.',
  },
  EDIT_SNOOZE_UNSETTLED: {
    message: 'The snooze operation on this alarm hasn’t finished.',
    recovery:
      'Reopen the app and wait for it to finish, then edit again. This alarm was not changed.',
  },
  EDIT_CAPACITY: {
    message:
      'There’s no room left for notifications (64 maximum), so the alarm can’t be edited.',
    recovery: 'This alarm was not changed. Reduce your other alarms, then try again.',
  },
  EDIT_DEADLINE_PASSED: {
    message: 'The alarm time arrived during editing, so the edit was canceled.',
    recovery: 'This alarm was not changed.',
  },
  EDIT_TIME_TOO_CLOSE: {
    message:
      'The next alarm time got too close during editing, so the edit was canceled.',
    recovery: 'This alarm was not changed. Choose the time again.',
  },
  EDIT_SCHEDULE_FAILED: {
    message:
      'Couldn’t schedule notifications for the new time, so the edit was canceled.',
    recovery:
      'This alarm was not changed, and any notifications scheduled along the way were canceled. Try again.',
  },
  EDIT_SCHEDULE_UNVERIFIED: {
    message:
      'Couldn’t confirm the notifications for the new time, so the edit was canceled.',
    recovery:
      'This alarm was not changed, and the notifications for the new time were canceled. No new alarms can be scheduled until the check is finished. Reopen the app, then try again.',
  },
  EDIT_RECONCILE_PENDING: {
    message:
      'A previously scheduled notification hasn’t been checked yet, so the alarm was not edited.',
    recovery:
      'This alarm was not changed. When you reopen the app, it will check and clean up.',
  },
  EDIT_CANCEL_UNVERIFIED: {
    message:
      'Couldn’t confirm that the old notifications were canceled, so the edit was canceled.',
    recovery:
      'This alarm was not changed, and the notifications for the new time were canceled. Try again.',
  },
  EDIT_SAVE_FAILED: {
    message:
      'The new notifications were scheduled, but the alarm settings couldn’t be saved.',
    recovery:
      'A record of the edit is saved on this device. When you reopen the app, it will finish the edit. Until then, the alarm may still ring at the old time.',
  },
  EDIT_ROLLBACK_INCOMPLETE: {
    message:
      'The edit was canceled, but some notifications for the new time couldn’t be canceled.',
    recovery:
      'Identifiers of the notifications that couldn’t be canceled are saved on this device. When you reopen the app, it will check them and cancel them again. Until then, the alarm may ring at the new time. If this keeps happening, you can use “Delete data” in Settings to remove all of this app’s alarms and scheduled notifications (your alarm settings will be deleted too).',
  },
  EDIT_CLEANUP_INCOMPLETE: {
    message:
      'During the previous edit, some notifications for the old time couldn’t be canceled.',
    recovery:
      'Identifiers of the notifications that couldn’t be canceled are saved on this device. When you reopen the app, it will check them and cancel them again. Until then, the alarm may still ring at the old time.',
  },
  EDIT_CLEANUP_PENDING: {
    message:
      'The time was changed, but some notifications for the old time haven’t been canceled.',
    recovery:
      'The alarm may still ring at the old time. Identifiers of the notifications that couldn’t be canceled are saved on this device. When you reopen the app, it will check them and cancel them again.',
  },
  SNOOZE_NOT_FOUND: {
    message: 'Couldn’t load the record for this alarm, so snooze was not set.',
    recovery: 'Check the alarm’s status.',
  },
  SNOOZE_NOT_RINGING: {
    message: 'This alarm is no longer ringing.',
    recovery: 'Snooze was not set.',
  },
  SNOOZE_LIMIT_REACHED: {
    message: 'You can snooze up to 3 times.',
    recovery: 'The alarm will keep ringing until you stop it.',
  },
  SNOOZE_TOO_LATE: {
    message: 'Snooze isn’t available because the next alarm time is close.',
    recovery: 'The alarm is still ringing.',
  },
  SNOOZE_CAPACITY_FULL: {
    message:
      'This app has reached its limit of scheduled notifications, so snooze couldn’t be set.',
    recovery: 'The alarm is still ringing. Stop it.',
  },
  SNOOZE_LIST_FAILED: {
    message: 'Couldn’t check the scheduled notifications, so snooze was not set.',
    recovery: 'The alarm is still ringing. Stop it, or try again.',
  },
  SNOOZE_INTENT_NOT_SAVED: {
    message: 'Couldn’t save the snooze record, so snooze was not set.',
    recovery: 'The alarm is still ringing. Stop it, or try again.',
  },
  SNOOZE_SCHEDULE_FAILED: {
    message: 'Couldn’t set snooze.',
    recovery: 'The alarm is still ringing. Stop it, or try again.',
  },
  SNOOZE_VERIFY_FAILED: {
    message: 'Couldn’t confirm the snooze setting.',
    recovery: 'The alarm is still ringing. Stop it, or try again.',
  },
  SNOOZE_PERSIST_FAILED: {
    message: 'Couldn’t save the snooze details.',
    recovery: 'The alarm is still ringing. Stop it, or try again.',
  },
  SNOOZE_CLEANUP_UNCONFIRMED: {
    message:
      'Couldn’t set snooze, and couldn’t confirm that the notification that was attempted was canceled.',
    recovery:
      'The alarm is still ringing. It may ring one extra time. Identifiers of notifications that may have been scheduled are saved on this device. When you reopen the app, it will check them and cancel them again.',
  },
  SNOOZE_CLEANUP_MEMORY_ONLY: {
    message:
      'Couldn’t set snooze, and couldn’t confirm that the notification that was attempted was canceled. That notification could not be saved on this device.',
    recovery:
      'The alarm is still ringing. It may ring one extra time. Quitting the app ends tracking of that notification. Keep the app open, or delete it with “Delete data” in Settings (this also deletes your alarm settings). Use another alarm as a backup.',
  },
  SNOOZE_ACCEPTED_CLEANUP_UNCONFIRMED: {
    message:
      'Snooze is set, but couldn’t confirm that the original alarm and other scheduled notifications were canceled.',
    recovery:
      'It will ring at the set time. It may ring more than that. Identifiers of notifications whose cancellation couldn’t be confirmed are saved on this device. When you reopen the app, it will check them and cancel them again.',
  },
  SNOOZE_ACCEPTED_CLEANUP_MEMORY_ONLY: {
    message:
      'Snooze is set, but couldn’t confirm that the original alarm and other scheduled notifications were canceled, and those notifications couldn’t be saved on this device.',
    recovery:
      'It will ring at the set time. It may ring more than that. Quitting the app ends tracking of that notification. Keep the app open, or delete it with “Delete data” in Settings (this also deletes your alarm settings). Use another alarm as a backup.',
  },
  SNOOZE_RESET_PENDING: {
    message: 'Snooze isn’t available because deleting data is in progress.',
    recovery:
      'The alarm is still ringing. Run “Delete data” in Settings again to finish it.',
  },
  SNOOZE_UNEXPECTED_FAILURE: {
    message: 'Couldn’t confirm the snooze result.',
    recovery:
      'If the alarm is ringing, stop it. A snooze notification may ring an extra time.',
  },
  SNOOZE_REARM_FAILED: {
    message: 'Couldn’t confirm that snooze was set again.',
    recovery:
      'It will ring on time while the app is open, but may not ring if you close it.',
  },
  SNOOZE_RECOVERY_UNRESOLVED: {
    message: 'Couldn’t confirm whether the interrupted snooze notification was canceled.',
    recovery:
      'It may ring an extra time. When you reopen the app, it will check the recorded notifications and cancel them again.',
  },
  SNOOZE_RECOVERY_MEMORY_ONLY: {
    message:
      'Couldn’t confirm that the notification of the interrupted snooze was canceled, and it couldn’t be saved on this device.',
    recovery:
      'It may ring an extra time. Quitting the app ends tracking of that notification. Keep the app open, or delete it with “Delete data” in Settings (this also deletes your alarm settings). Use another alarm as a backup.',
  },
  SNOOZE_RECOVERY_FAILED: {
    message: 'Couldn’t confirm the snooze state.',
    recovery:
      'While the app is open, a snooze whose time has passed is treated as ringing or missed.',
  },
  STOP_SAVE_FAILED: {
    message:
      'The stop couldn’t be saved, so the alarm was not stopped. The scheduled notifications were not canceled.',
    recovery: 'The alarm is still ringing. Try stopping it again.',
  },
  STOP_CLEANUP_UNCONFIRMED: {
    message:
      'The alarm was stopped, but couldn’t confirm that the scheduled notifications were canceled.',
    recovery:
      'This occurrence won’t ring again, but a notification may arrive once. Identifiers of notifications whose cancellation couldn’t be confirmed are saved on this device. When you reopen the app, it will check them and cancel them again.',
  },
  STOP_CLEANUP_MEMORY_ONLY: {
    message:
      'The alarm was stopped, but couldn’t confirm that the scheduled notifications were canceled, and those notifications couldn’t be saved on this device.',
    recovery:
      'A notification may arrive once. Quitting the app ends tracking of that notification. Keep the app open, or delete it with “Delete data” in Settings (this also deletes your alarm settings). Use another alarm as a backup.',
  },
  STOP_ALREADY_ENDED: {
    message: 'This alarm has already ended.',
    recovery: 'No action needed.',
  },
  STOP_RESET_PENDING: {
    message:
      'The sound and notifications were stopped, but the stop record wasn’t saved because deleting data is in progress.',
    recovery: 'Run “Delete data” in Settings again to finish it.',
  },
  STOP_FOLLOWUP_FAILED: {
    message:
      'The alarm was stopped. Updating the schedule for the next occurrence failed.',
    recovery: 'Check the alarm’s status. When you reopen the app, it will check again.',
  },
  STOP_FOLLOWUP_RESET_PENDING: {
    message:
      'The alarm was stopped. Because data deletion is in progress, upcoming notifications were not updated.',
    recovery: 'Run “Delete data” in Settings again to finish.',
  },
  CHECKIN_PROCESS_FAILED: {
    message: 'The wake-up check failed.',
    recovery: 'The alarm will stay on to be safe.',
  },
  STEP_PROCESS_FAILED: {
    message: 'The 100-step check failed.',
    recovery: 'Check the alarm’s status.',
  },
  SUPPRESSION_FOLLOWUP_FAILED: {
    message:
      'Your wake-up was confirmed and this occurrence of the alarm was stopped. Updating the schedule for the next occurrence failed.',
    recovery: 'Check the alarm’s status.',
  },
  REFILL_FAILED: {
    message: 'Couldn’t update the notification state.',
    recovery:
      'When you reopen the app, it will check again. Check the status of each alarm.',
  },
  DUE_TRANSITION_FAILED: {
    message: 'The alarm time has arrived, but updating the state failed.',
    recovery: 'Check the screen and any notifications you’ve received.',
  },
  STOP_RINGING_FAILED: {
    message: 'Couldn’t finish stopping the alarm.',
    recovery: 'The alarm is still on. Try stopping it again.',
  },
  MISSED_ACK_FAILED: {
    message: 'Couldn’t mark it as acknowledged.',
    recovery: 'Try again.',
  },
  SOUND_START_FAILED: {
    message: 'Couldn’t start the in-app alarm sound.',
    recovery: 'Check the notification sound and the screen.',
  },
  SETTINGS_OPEN_FAILED: {
    message: 'Couldn’t open the Settings app.',
    recovery: 'Check notifications in your device’s Settings app.',
  },
  UNEXPECTED_FAILURE: {
    message: 'An unexpected error occurred.',
    recovery: 'Check the alarm’s status, and use another alarm as a backup if needed.',
  },
};
