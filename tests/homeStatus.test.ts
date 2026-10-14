/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  SuppressionCancelUnknownError,
  SuppressionSaveError,
} from '../src/alarmOrchestrator';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import type {
  AlarmPhase,
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';
import {
  STORAGE_LOAD_FAILED_COPY,
  RINGING_STOP_LABEL,
  SUPPRESSION_WARNING_COPY,
  classifySuppressionFailure,
  describeAlarmRemains,
  describeSuppressedOccurrence,
  findAlarmListLock,
  getRingingStopA11yLabel,
  runUnlessAlarmListLocked,
  getStepGuidance,
  isAlarmListLocked,
  summarizeNewAlarm,
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

  test('gives non-destructive restart steps and never suggests a reset', () => {
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
    assert.doesNotMatch(result?.notice ?? '', /有効/);
  });

  test('maps an unknown cancellation to the unverified warning', () => {
    const result = classifySuppressionFailure(
      new SuppressionCancelUnknownError('c1', new Error('x')),
    );
    assert.equal(result?.warning, 'status_unknown');
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
