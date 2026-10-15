/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  SuppressionCancelUnknownError,
  SuppressionSaveError,
} from '../src/alarmOrchestrator';
import { makeAlarmRepeat, type Weekday } from '../src/alarmSchedule';
import type {
  AlarmPhase,
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';
import {
  STORAGE_LOAD_FAILED_COPY,
  RINGING_STOP_LABEL,
  SUPPRESSION_WARNING_COPY,
  canEditAlarm,
  canSubmitComposer,
  classifySuppressionFailure,
  describeAlarmRemains,
  describeSuppressedOccurrence,
  describeTodayOnlyExpiry,
  findAlarmListLock,
  getRingingStopA11yLabel,
  getRingingDisplay,
  planMissedAnnouncement,
  MISSED_CARD_ANNOUNCEMENT,
  runUnlessAlarmListLocked,
  getStepGuidance,
  isAlarmListLocked,
  resolveComposerValues,
  summarizeNewAlarm,
  withoutQueueStatus,
} from '../src/homeStatus';

const NOW = new Date(2026, 9, 2, 22, 0, 0).getTime(); // Fri 10/2 22:00
const HOUR = 60 * 60_000;

function cycle(
  dueAtMs: number,
  phase: AlarmPhase,
  extra: Partial<StoredAlarm> = {},
): StoredAlarm {
  return {
    alarmId: 'a1',
    cycleId: `c-${dueAtMs}`,
    mainAlarmId: `m-${dueAtMs}`,
    armedAtMs: NOW - HOUR,
    dueAtMs,
    phase,
    stepCount: 0,
    stepCandidateRecorded: false,
    ...extra,
  };
}

function definition(cycles: StoredAlarm[]): StoredAlarmDefinition {
  return {
    id: 'a1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', NOW),
    enabled: true,
    createdAtMs: NOW - HOUR,
    cycles,
  };
}

const fmt = (ms: number) => `D${new Date(ms).getDate()}`;

describe('isAlarmListLocked', () => {
  test('locks list switches and delete only while an alarm rings', () => {
    assert.equal(isAlarmListLocked(null), false);
    assert.equal(isAlarmListLocked(cycle(NOW, 'ringing')), true);
  });
});

describe('describeSuppressedOccurrence', () => {
  const due = new Date(2026, 9, 3, 7, 0, 0).getTime();

  test('names the date, time and the 100-step reason', () => {
    const result = describeSuppressedOccurrence(
      [definition([cycle(due, 'suppressed', { stepCandidateRecorded: true })])],
      NOW,
      fmt,
    );
    assert.equal(
      result?.text,
      'D3 07:00 は100歩で起床確認済みのため鳴りません',
    );
  });

  test('names the notification reason when no step evidence was recorded', () => {
    const result = describeSuppressedOccurrence(
      [definition([cycle(due, 'suppressed', { confirmedAtMs: due - 30_000 })])],
      NOW,
      fmt,
    );
    assert.equal(
      result?.text,
      'D3 07:00 は通知で起床確認済みのため鳴りません',
    );
  });

  test('ignores past, armed and ringing cycles and picks the earliest', () => {
    const later = due + 24 * HOUR;
    const result = describeSuppressedOccurrence(
      [
        definition([
          cycle(NOW - HOUR, 'suppressed'),
          cycle(due, 'armed'),
          cycle(later, 'suppressed'),
        ]),
      ],
      NOW,
      fmt,
    );
    assert.equal(result?.text.startsWith('D4 07:00'), true);
    assert.equal(
      describeSuppressedOccurrence(
        [definition([cycle(due, 'armed'), cycle(NOW - HOUR, 'suppressed')])],
        NOW,
        fmt,
      ),
      null,
    );
  });
});

describe('getStepGuidance', () => {
  test('shows the bar only while counting or preparing', () => {
    assert.equal(getStepGuidance('counting').showProgress, true);
    assert.equal(getStepGuidance('preparing').showProgress, true);
  });

  test('hides the bar and says the alarm stays when steps cannot be used', () => {
    for (const state of ['unavailable', 'denied', 'error'] as const) {
      const guidance = getStepGuidance(state);
      assert.equal(guidance.showProgress, false, state);
      assert.match(guidance.message, /歩数による停止を確認できません/, state);
      assert.match(guidance.message, /予定を確認してください/, state);
      // Never asserts the alarm will ring: notification state may be unknown.
      assert.doesNotMatch(guidance.message, /予定どおり鳴ります/, state);
    }
  });

  test('offers the settings shortcut only when permission was denied', () => {
    assert.equal(getStepGuidance('denied').canOpenSettings, true);
    assert.equal(getStepGuidance('unavailable').canOpenSettings, false);
    assert.equal(getStepGuidance('error').canOpenSettings, false);
  });
});

describe('STORAGE_LOAD_FAILED_COPY', () => {
  test('tells that old alarms may still ring and explains why add is off', () => {
    assert.match(STORAGE_LOAD_FAILED_COPY.body, /鳴ることがあります/);
    assert.match(STORAGE_LOAD_FAILED_COPY.addDisabledReason, /追加できません/);
  });

  test('keeps the restart steps non-destructive', () => {
    const steps = STORAGE_LOAD_FAILED_COPY.restartSteps.join('\n');
    assert.match(steps, /完全に終了/);
    assert.match(steps, /開き直/);
    assert.doesNotMatch(steps, /削除|初期化|再インストール|消去/);
  });
});

describe('summarizeNewAlarm', () => {
  const sat = new Date(2026, 9, 3, 21, 0, 0).getTime();

  test('shows repeat and the first ring date, flagging a distant first ring', () => {
    // Friday night, weekdays 07:00 -> Monday 10/5
    const summary = summarizeNewAlarm({
      nowMs: NOW,
      hour: 7,
      minute: 0,
      repeatKind: 'weekdays',
      customWeekdays: [],
      formatDate: (ms) => `${new Date(ms).getMonth() + 1}/${new Date(ms).getDate()}`,
    });
    assert.equal(summary.text, '平日・初回 10/5 07:00（2日9時間後）');
    assert.equal(summary.isDistant, true);
  });

  test('is not distant when the first ring is within 24 hours', () => {
    const summary = summarizeNewAlarm({
      nowMs: sat,
      hour: 7,
      minute: 0,
      repeatKind: 'daily',
      customWeekdays: [],
      formatDate: () => '10/4',
    });
    assert.equal(summary.text, '毎日・初回 10/4 07:00（10時間後）');
    assert.equal(summary.isDistant, false);
  });

  test('says no ring when custom has no weekday or today has passed', () => {
    const none = summarizeNewAlarm({
      nowMs: NOW,
      hour: 7,
      minute: 0,
      repeatKind: 'custom',
      customWeekdays: [],
      formatDate: () => '',
    });
    assert.equal(none.text, '曜日を選ぶと初回の日時が表示されます');
    const passed = summarizeNewAlarm({
      nowMs: NOW,
      hour: 7,
      minute: 0,
      repeatKind: 'today',
      customWeekdays: [],
      formatDate: () => '',
    });
    assert.match(passed.text, /今日の07:00はすでに過ぎています/);
  });
});

describe('ringing copy', () => {
  const ringing = (over: Partial<StoredAlarm> = {}): StoredAlarm => ({
    alarmId: 'a',
    cycleId: 'c',
    mainAlarmId: 'm',
    armedAtMs: 0,
    dueAtMs: new Date(2026, 9, 14, 23, 58).getTime(),
    phase: 'ringing',
    stepCount: 0,
    stepCandidateRecorded: false,
    ...over,
  });

  test('the focused stop label carries the occurrence date', () => {
    const label = getRingingStopA11yLabel(0, 5, '10/14(水)');
    assert.equal(label, '10/14(水) 0時5分のアラームが鳴っています。アラームを止める');
  });

  test('a main ring displays its own due date and time', () => {
    const cycle = ringing();
    assert.deepEqual(getRingingDisplay(cycle), {
      timeMs: cycle.dueAtMs,
      dateMs: cycle.dueAtMs,
    });
  });

  test('a snooze ring displays the snooze time, with the date of that time', () => {
    const snoozeDue = new Date(2026, 9, 15, 0, 3).getTime();
    const cycle = ringing({ snooze: { count: 1, notificationId: 's', dueAtMs: snoozeDue } });
    assert.deepEqual(getRingingDisplay(cycle), { timeMs: snoozeDue, dateMs: snoozeDue });
  });

  test('a snooze record without a delivery time keeps the original', () => {
    const cycle = ringing({ snooze: { count: 1 } });
    assert.equal(getRingingDisplay(cycle).timeMs, cycle.dueAtMs);
  });

  test('missed cycles are announced by id: new once, existing never again', () => {
    const plan = (announced: string[], ids: string[], isRinging = false) =>
      planMissedAnnouncement({ announced: new Set(announced), missedCycleIds: ids, isRinging });
    const first = plan([], ['a', 'b']);
    assert.equal(first.announce, true);
    assert.deepEqual([...first.announced].sort(), ['a', 'b']);
    // Same ids on later ticks stay silent.
    assert.equal(plan(['a', 'b'], ['a', 'b']).announce, false);
    // A new id while the card is already visible announces once.
    const added = plan(['a', 'b'], ['a', 'b', 'c']);
    assert.equal(added.announce, true);
    assert.equal(plan([...added.announced], ['a', 'b', 'c']).announce, false);
    assert.equal(plan([], []).announce, false);
    assert.match(MISSED_CARD_ANNOUNCEMENT, /見逃し/);
  });

  test('ringing defers announcing new ids and never re-announces known ones', () => {
    const during = planMissedAnnouncement({
      announced: new Set(['a']),
      missedCycleIds: ['a', 'n'],
      isRinging: true,
    });
    assert.equal(during.announce, false);
    assert.deepEqual([...during.announced], ['a']);
    // After stop: only the pending id triggers one announcement.
    const after = planMissedAnnouncement({
      announced: during.announced,
      missedCycleIds: ['a', 'n'],
      isRinging: false,
    });
    assert.equal(after.announce, true);
    // Known ids hidden by ringing are not announced again after stop.
    const ringOnly = planMissedAnnouncement({
      announced: new Set(['a']),
      missedCycleIds: ['a'],
      isRinging: true,
    });
    assert.equal(
      planMissedAnnouncement({
        announced: ringOnly.announced,
        missedCycleIds: ['a'],
        isRinging: false,
      }).announce,
      false,
    );
  });

  test('acknowledged or deleted ids are pruned so a later new cycle announces', () => {
    const cleared = planMissedAnnouncement({
      announced: new Set(['a', 'b']),
      missedCycleIds: ['b'],
      isRinging: false,
    });
    assert.equal(cleared.announce, false);
    assert.deepEqual([...cleared.announced], ['b']);
    const empty = planMissedAnnouncement({
      announced: cleared.announced,
      missedCycleIds: [],
      isRinging: false,
    });
    assert.equal(empty.announce, false);
    assert.equal(empty.announced.size, 0);
    assert.equal(
      planMissedAnnouncement({ announced: empty.announced, missedCycleIds: ['a'], isRinging: false }).announce,
      true,
    );
  });

  test('the stop control label carries the time and that it is ringing', () => {
    assert.equal(
      getRingingStopA11yLabel(7, 0),
      '7時0分のアラームが鳴っています。アラームを止める',
    );
    assert.equal(
      getRingingStopA11yLabel(18, 5),
      '18時5分のアラームが鳴っています。アラームを止める',
    );
  });

  test('stop label says it stops the sound, not that the user is awake', () => {
    assert.equal(RINGING_STOP_LABEL, 'アラームを止める');
  });
});

describe('findAlarmListLock', () => {
  const later = NOW + HOUR;

  test('is free when nothing rings and nothing is due', () => {
    assert.equal(findAlarmListLock([definition([cycle(later, 'armed')])], NOW), null);
  });

  test('locks for a ringing cycle', () => {
    assert.equal(
      findAlarmListLock([definition([cycle(NOW - 5_000, 'ringing')])], NOW),
      'ringing',
    );
  });

  test('locks for a monitored cycle whose due time has arrived but is not yet marked ringing', () => {
    assert.equal(
      findAlarmListLock([definition([cycle(NOW, 'armed')])], NOW),
      'due',
    );
    assert.equal(
      findAlarmListLock([definition([cycle(NOW - 1, 'step_candidate')])], NOW),
      'due',
    );
  });

  test('ignores suppressed and dismissed cycles that are past due', () => {
    assert.equal(
      findAlarmListLock(
        [definition([cycle(NOW - HOUR, 'suppressed'), cycle(NOW - HOUR + 1, 'dismissed')])],
        NOW,
      ),
      null,
    );
  });
});

describe('runUnlessAlarmListLocked', () => {
  test('runs the action when the latest alarms are not locked', async () => {
    let ran = 0;
    const result = await runUnlessAlarmListLocked({
      getAlarms: () => [definition([cycle(NOW + HOUR, 'armed')])],
      nowMs: () => NOW,
      run: async () => {
        ran += 1;
        return 'done';
      },
      onBlocked: () => assert.fail('must not block'),
    });
    assert.equal(ran, 1);
    assert.deepEqual(result, { ran: true, value: 'done' });
  });

  test('blocks a stale confirm: the alarm started ringing after the dialog opened', async () => {
    let alarms = [definition([cycle(NOW + HOUR, 'armed')])];
    const open = () => alarms; // read at execution time, not at dialog time
    alarms = [definition([cycle(NOW + HOUR, 'ringing')])];
    const blocked: string[] = [];
    const result = await runUnlessAlarmListLocked({
      getAlarms: open,
      nowMs: () => NOW,
      run: async () => assert.fail('must not run'),
      onBlocked: (reason) => blocked.push(reason),
    });
    assert.deepEqual(blocked, ['ringing']);
    assert.deepEqual(result, { ran: false });
  });

  test('blocks when the clock passed the due time before the ringing state landed', async () => {
    const blocked: string[] = [];
    await runUnlessAlarmListLocked({
      getAlarms: () => [definition([cycle(NOW + 1_000, 'armed')])],
      nowMs: () => NOW + 1_000,
      run: async () => assert.fail('must not run'),
      onBlocked: (reason) => blocked.push(reason),
    });
    assert.deepEqual(blocked, ['due']);
  });
});

describe('SUPPRESSION_WARNING_COPY', () => {
  test('save failure says the stop happened but is not saved, not that the alarm is on', () => {
    const copy = SUPPRESSION_WARNING_COPY.save_failed;
    assert.match(copy.body, /保存できません/);
    assert.doesNotMatch(copy.body, /アラームは有効/);
  });

  test('unknown state never promises armed or stopped', () => {
    const copy = SUPPRESSION_WARNING_COPY.status_unknown;
    assert.match(copy.title, /未確認/);
    assert.match(copy.body, /鳴る場合と鳴らない場合/);
  });
});

describe('summarizeNewAlarm add gating', () => {
  const base = {
    repeatKind: 'daily' as const,
    customWeekdays: [] as never[],
    formatDate: () => 'D',
  };

  test('under the minimum lead asks to pick the time again and cannot be added', () => {
    const now = new Date(2026, 9, 2, 22, 0, 0).getTime();
    const summary = summarizeNewAlarm({
      ...base,
      nowMs: now,
      hour: 22,
      minute: 0,
      // same minute as now with seconds dropped: lead 0 -> next day for daily
    });
    // daily rolls to tomorrow, so this is addable
    assert.equal(summary.canAdd, true);

    const soon = new Date(2026, 9, 2, 22, 0, 55).getTime();
    const tooSoon = summarizeNewAlarm({
      ...base,
      repeatKind: 'today',
      nowMs: soon,
      hour: 22,
      minute: 1,
    });
    assert.equal(tooSoon.canAdd, false);
    assert.match(tooSoon.text, /時刻を選び直してください/);
  });

  test('exactly the minimum lead can be added', () => {
    const now = new Date(2026, 9, 2, 22, 0, 50).getTime();
    const ok = summarizeNewAlarm({
      ...base,
      repeatKind: 'today',
      nowMs: now,
      hour: 22,
      minute: 1,
    });
    assert.equal(ok.canAdd, true);
  });

  test('past today-only and empty custom cannot be added; normal can', () => {
    assert.equal(
      summarizeNewAlarm({ ...base, repeatKind: 'today', nowMs: NOW, hour: 7, minute: 0 }).canAdd,
      false,
    );
    assert.equal(
      summarizeNewAlarm({ ...base, repeatKind: 'custom', nowMs: NOW, hour: 7, minute: 0 }).canAdd,
      false,
    );
    assert.equal(
      summarizeNewAlarm({ ...base, nowMs: NOW, hour: 7, minute: 0 }).canAdd,
      true,
    );
  });
});

describe('classifySuppressionFailure', () => {
  test('maps a save failure to a dedicated warning, never to "alarm is on"', () => {
    const result = classifySuppressionFailure(
      new SuppressionSaveError('c1', new Error('disk')),
    );
    assert.equal(result?.warning, 'save_failed');
    assert.doesNotMatch(result?.notice.text ?? '', /有効/);
    assert.equal(result?.notice.code, 'SUPPRESSION_SAVE_FAILED');
  });

  test('maps an unknown cancellation to the unverified warning', () => {
    const result = classifySuppressionFailure(
      new SuppressionCancelUnknownError('c1', new Error('x')),
    );
    assert.equal(result?.warning, 'status_unknown');
    assert.equal(result?.notice.code, 'CANCEL_UNKNOWN');
  });

  test('other errors are not suppression failures', () => {
    assert.equal(classifySuppressionFailure(new Error('x')), null);
  });
});

describe('describeAlarmRemains', () => {
  test('keeps the unverified-cancel danger wording and explains the new reasons', () => {
    assert.equal(describeAlarmRemains('CANCEL_NOT_VERIFIED').tone, 'danger');
    assert.match(describeAlarmRemains('ALARM_DUE_OR_PAST').text, /鳴ります/);
    assert.match(describeAlarmRemains('JOURNAL_NOT_WRITTEN').text, /取り消していません/);
    assert.match(describeAlarmRemains('INVALID_RESPONSE').text, /維持します/);
  });
});

describe('describeTodayOnlyExpiry', () => {
  const created = new Date(2026, 9, 15, 6, 0).getTime();
  const fmt = () => '10/15(木)';
  const def = (kind: 'today' | 'daily'): StoredAlarmDefinition => ({
    id: 'a',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat(kind, created),
    enabled: false,
    createdAtMs: created,
    cycles: [],
  });

  test('shows original date and Ended for an expired today-only alarm', () => {
    const next = new Date(2026, 9, 16, 5, 0).getTime();
    const info = describeTodayOnlyExpiry(def('today'), next, fmt);
    assert.ok(info);
    assert.match(info.rowLabel, /今日だけ.*10\/15.*終了/);
    assert.match(info.a11yLabel, /10\/15.*終了/);
    assert.match(info.explanation, /新しいアラーム/);
  });

  describe('never Ended while the cycle is still active', () => {
    const due = new Date(2026, 9, 15, 7, 0).getTime();
    const withCycles = (
      enabled: boolean,
      cycles: StoredAlarm[],
    ): StoredAlarmDefinition => ({ ...def('today'), enabled, cycles });

    test('due - 1ms, exactly due and overdue armed before tick', () => {
      const armed = [cycle(due, 'armed')];
      for (const now of [due - 1, due, due + 5000]) {
        assert.equal(describeTodayOnlyExpiry(withCycles(true, armed), now, fmt), null);
        assert.equal(describeTodayOnlyExpiry(withCycles(false, armed), now, fmt), null);
      }
    });

    test('ringing past due and pending cancellation stay active', () => {
      const ringing = [cycle(due, 'ringing')];
      assert.equal(describeTodayOnlyExpiry(withCycles(true, ringing), due + 60000, fmt), null);
      assert.equal(describeTodayOnlyExpiry(withCycles(false, ringing), due + 60000, fmt), null);
      const candidate = [cycle(due, 'step_candidate')];
      assert.equal(describeTodayOnlyExpiry(withCycles(false, candidate), due + 60000, fmt), null);
    });

    test('unknown future phases are conservatively active', () => {
      const future = [cycle(due, 'snoozed' as AlarmPhase)];
      assert.equal(describeTodayOnlyExpiry(withCycles(false, future), due + 60000, fmt), null);
    });

    test('enabled without cycles is not Ended', () => {
      assert.equal(describeTodayOnlyExpiry(withCycles(true, []), due + 60000, fmt), null);
    });

    test('truly ended disabled record, even with terminal cycles, is Ended', () => {
      assert.ok(describeTodayOnlyExpiry(withCycles(false, []), due + 60000, fmt));
      const done = [cycle(due, 'suppressed'), cycle(due, 'dismissed')];
      assert.ok(describeTodayOnlyExpiry(withCycles(false, done), due + 60000, fmt));
    });
  });

  test('null before expiry and for repeating alarms', () => {
    assert.equal(describeTodayOnlyExpiry(def('today'), created, fmt), null);
    assert.equal(describeTodayOnlyExpiry(def('daily'), created + 9e8, fmt), null);
  });
});

describe('summarizeNewAlarm when editing an existing alarm', () => {
  const formatDate = () => '10/3';

  test('keeps the original date of a today-only alarm instead of moving it to today', () => {
    const original = makeAlarmRepeat('today', NOW - 3 * 24 * HOUR);
    const summary = summarizeNewAlarm({
      nowMs: NOW,
      hour: 23,
      minute: 30,
      repeatKind: 'today',
      customWeekdays: [],
      existingRepeat: original,
      formatDate,
    });
    assert.equal(summary.canAdd, false);
    assert.match(summary.text, /この日の23:30はすでに過ぎています/);
  });

  test('saves an off alarm without scheduling and says so', () => {
    const summary = summarizeNewAlarm({
      nowMs: NOW,
      hour: 7,
      minute: 0,
      repeatKind: 'weekdays',
      customWeekdays: [],
      enabled: false,
      formatDate,
    });
    assert.equal(summary.canAdd, true);
    assert.equal(summary.isDistant, false);
    assert.equal(
      summary.text,
      '平日・オフのまま保存します（オンにすると通知を予約します）',
    );
  });

  test('an off custom alarm still needs a weekday', () => {
    const summary = summarizeNewAlarm({
      nowMs: NOW,
      hour: 7,
      minute: 0,
      repeatKind: 'custom',
      customWeekdays: [],
      enabled: false,
      formatDate,
    });
    assert.equal(summary.canAdd, false);
  });
});

describe('composer state and commands', () => {
  const open = {
    ringing: false,
    loadFailed: false,
    deletionPending: false,
    isBusy: false,
    listFull: false,
  };

  test('opening the add composer always starts from the defaults, never an edited alarm', () => {
    const edited = {
      selectedTime: new Date(2026, 9, 15, 5, 45),
      repeatKind: 'custom' as const,
      customWeekdays: [0, 6] as Weekday[],
    };
    const wake = new Date(2026, 9, 15, 7, 0);
    const next = resolveComposerValues({ mode: 'add', current: edited, defaultWakeTime: wake });
    assert.deepEqual(next, {
      selectedTime: wake,
      repeatKind: 'weekdays',
      customWeekdays: [1, 2, 3, 4, 5],
    });
    assert.notEqual(next.customWeekdays, edited.customWeekdays);
  });

  test('editing keeps the values loaded from the alarm', () => {
    const current = {
      selectedTime: new Date(2026, 9, 15, 5, 45),
      repeatKind: 'daily' as const,
      customWeekdays: [1] as Weekday[],
    };
    assert.deepEqual(
      resolveComposerValues({ mode: 'edit', current, defaultWakeTime: new Date() }),
      current,
    );
  });

  test('editing is unavailable while deletion recovery owns storage', () => {
    assert.equal(canEditAlarm({ ...open, listLocked: false, isWeb: false }), true);
    assert.equal(
      canEditAlarm({ ...open, deletionPending: true, listLocked: false, isWeb: false }),
      false,
    );
    assert.equal(canEditAlarm({ ...open, isBusy: true, listLocked: false, isWeb: false }), false);
    assert.equal(canEditAlarm({ ...open, listLocked: true, isWeb: false }), false);
    assert.equal(canEditAlarm({ ...open, listLocked: false, isWeb: true }), false);
  });

  test('submit respects deletionPending for edit and add, and a full list only blocks add', () => {
    const base = { ...open, isWeb: false, canAdd: true };
    assert.equal(canSubmitComposer({ ...base, isEditing: true }), true);
    assert.equal(canSubmitComposer({ ...base, isEditing: true, listFull: true }), true);
    assert.equal(canSubmitComposer({ ...base, isEditing: false, listFull: true }), false);
    for (const isEditing of [true, false]) {
      assert.equal(
        canSubmitComposer({ ...base, isEditing, deletionPending: true }),
        false,
      );
      assert.equal(canSubmitComposer({ ...base, isEditing, canAdd: false }), false);
      assert.equal(canSubmitComposer({ ...base, isEditing, ringing: true }), false);
      assert.equal(canSubmitComposer({ ...base, isEditing, loadFailed: true }), false);
      assert.equal(canSubmitComposer({ ...base, isEditing, isBusy: true }), false);
      assert.equal(canSubmitComposer({ ...base, isEditing, isWeb: true }), false);
    }
  });

  test('replacing a schedule drops only that alarm\'s queue status', () => {
    const statuses = { a1: 'verified', a2: 'verified' } as const;
    const next = withoutQueueStatus(statuses, 'a1');
    assert.deepEqual(next, { a2: 'verified' });
    assert.deepEqual(statuses, { a1: 'verified', a2: 'verified' });
    assert.equal(withoutQueueStatus(next, 'a1'), next);
  });
});
