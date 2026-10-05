/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { makeAlarmRepeat, type RepeatKind } from '../src/alarmSchedule';
import type {
  AlarmPhase,
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';
import {
  describeScheduleCoverage,
  getScheduleCoverageLine,
} from '../src/scheduleCoverage';

const NOW = new Date(2026, 9, 5, 6, 0, 0).getTime();
const MONDAY_7 = new Date(2026, 9, 5, 7, 0, 0).getTime();
const TUESDAY_7 = new Date(2026, 9, 6, 7, 0, 0).getTime();
const WEDNESDAY_7 = new Date(2026, 9, 7, 7, 0, 0).getTime();
const SUNDAY_7 = new Date(2026, 9, 4, 7, 0, 0).getTime();

function cycle(dueAtMs: number, phase: AlarmPhase = 'armed'): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId: `cycle-${dueAtMs}-${phase}`,
    mainAlarmId: `main-${dueAtMs}`,
    armedAtMs: NOW - 60_000,
    dueAtMs,
    phase,
    stepCount: 0,
    stepCandidateRecorded: false,
  };
}

function definition(
  cycles: StoredAlarm[],
  overrides: { enabled?: boolean; repeat?: RepeatKind } = {},
): StoredAlarmDefinition {
  return {
    id: 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat(overrides.repeat ?? 'weekdays', NOW),
    enabled: overrides.enabled ?? true,
    createdAtMs: NOW - 86_400_000,
    cycles,
  };
}

describe('describeScheduleCoverage', () => {
  test('a disabled alarm is off even if cycles remain stored', () => {
    assert.deepEqual(
      describeScheduleCoverage(
        definition([cycle(MONDAY_7)], { enabled: false }),
        NOW,
      ),
      { kind: 'off' },
    );
  });

  test('an enabled alarm without any cycle has no reservation', () => {
    assert.deepEqual(describeScheduleCoverage(definition([]), NOW), {
      kind: 'none',
    });
  });

  test('ringing, stopped and past cycles do not count as reservations', () => {
    assert.deepEqual(
      describeScheduleCoverage(
        definition([
          cycle(SUNDAY_7, 'ringing'),
          cycle(SUNDAY_7 - 86_400_000, 'armed'),
          cycle(MONDAY_7, 'suppressed'),
          cycle(TUESDAY_7, 'dismissed'),
        ]),
        NOW,
      ),
      { kind: 'none' },
    );
  });

  test('upcoming monitoring cycles report how many remain and the last due time', () => {
    assert.deepEqual(
      describeScheduleCoverage(
        definition([
          cycle(WEDNESDAY_7),
          cycle(MONDAY_7, 'step_candidate'),
          cycle(TUESDAY_7),
        ]),
        NOW,
      ),
      {
        kind: 'scheduled',
        remaining: 3,
        lastDueAtMs: WEDNESDAY_7,
        isRunningLow: false,
      },
    );
  });

  test('a repeating alarm with one occurrence left is running low', () => {
    const customMonday = {
      ...definition([cycle(MONDAY_7)]),
      repeat: makeAlarmRepeat('custom', NOW, [1]),
    };
    for (const alarm of [
      definition([cycle(MONDAY_7)], { repeat: 'daily' }),
      definition([cycle(MONDAY_7)], { repeat: 'weekdays' }),
      customMonday,
    ]) {
      assert.deepEqual(describeScheduleCoverage(alarm, NOW), {
        kind: 'scheduled',
        remaining: 1,
        lastDueAtMs: MONDAY_7,
        isRunningLow: true,
      });
    }
  });

  test('two remaining occurrences are not yet running low', () => {
    const coverage = describeScheduleCoverage(
      definition([cycle(MONDAY_7), cycle(TUESDAY_7)]),
      NOW,
    );
    assert.equal(coverage.kind, 'scheduled');
    assert.equal(coverage.kind === 'scheduled' && coverage.isRunningLow, false);
  });

  test('a today-only alarm with its single occurrence is not running low', () => {
    assert.deepEqual(
      describeScheduleCoverage(
        definition([cycle(MONDAY_7)], { repeat: 'today' }),
        NOW,
      ),
      {
        kind: 'scheduled',
        remaining: 1,
        lastDueAtMs: MONDAY_7,
        isRunningLow: false,
      },
    );
  });

  test('cycles due at or before now are ignored', () => {
    assert.deepEqual(
      describeScheduleCoverage(
        definition([cycle(MONDAY_7), cycle(TUESDAY_7), cycle(WEDNESDAY_7)]),
        MONDAY_7,
      ),
      {
        kind: 'scheduled',
        remaining: 2,
        lastDueAtMs: WEDNESDAY_7,
        isRunningLow: false,
      },
    );
    assert.deepEqual(
      describeScheduleCoverage(
        definition([cycle(MONDAY_7), cycle(TUESDAY_7), cycle(WEDNESDAY_7)]),
        TUESDAY_7 + 1,
      ),
      {
        kind: 'scheduled',
        remaining: 1,
        lastDueAtMs: WEDNESDAY_7,
        isRunningLow: true,
      },
    );
  });

  test('an unreadable clock never reports a reservation', () => {
    assert.deepEqual(
      describeScheduleCoverage(definition([cycle(MONDAY_7)]), Number.NaN),
      { kind: 'none' },
    );
  });
});

describe('getScheduleCoverageLine', () => {
  const formatDate = (timestampMs: number) =>
    timestampMs === WEDNESDAY_7 ? '10/7(水)' : 'unexpected';

  test('off keeps the existing copy without a warning', () => {
    assert.deepEqual(getScheduleCoverageLine({ kind: 'off' }, formatDate), {
      text: '通知は予約されていません',
      isWarning: false,
    });
  });

  test('no reservation is a warning', () => {
    assert.deepEqual(getScheduleCoverageLine({ kind: 'none' }, formatDate), {
      text: '予約がありません',
      isWarning: true,
    });
  });

  test('a healthy schedule names the last reserved date', () => {
    assert.deepEqual(
      getScheduleCoverageLine(
        {
          kind: 'scheduled',
          remaining: 3,
          lastDueAtMs: WEDNESDAY_7,
          isRunningLow: false,
        },
        formatDate,
      ),
      { text: '10/7(水)まで予約済み', isWarning: false },
    );
  });

  test('a schedule running low asks the user to open the app', () => {
    assert.deepEqual(
      getScheduleCoverageLine(
        {
          kind: 'scheduled',
          remaining: 1,
          lastDueAtMs: WEDNESDAY_7,
          isRunningLow: true,
        },
        formatDate,
      ),
      {
        text: '10/7(水)まで予約済み・アプリを開くと先の分を予約します',
        isWarning: true,
      },
    );
  });
});
