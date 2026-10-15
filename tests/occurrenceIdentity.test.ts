/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { dropUntrustedOccurrenceMetadata } from '../src/alarmStorage';
import type { StoredAlarm, StoredAlarmDefinition } from '../src/alarmStorage';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import {
  LOGICAL_DATE_REACH_MS,
  collectLogicalDateEvidence,
  dateKeyInZone,
  legacyEvidenceNeedsOrigin,
  readOccurrenceIdentity,
} from '../src/occurrenceIdentity';

const DUE = Date.UTC(2026, 9, 15, 22, 0); // Oct 16 07:00 JST / Oct 15 15:00 PDT

function cycle(overrides: Partial<StoredAlarm> = {}): StoredAlarm {
  return {
    alarmId: 'a1',
    cycleId: 'c1',
    mainAlarmId: 'main-1',
    checkInNotificationId: 'check-1',
    armedAtMs: DUE - 3_600_000,
    dueAtMs: DUE,
    phase: 'suppressed',
    stepCount: 0,
    stepCandidateRecorded: false,
    ...overrides,
  };
}

describe('dateKeyInZone validates its inputs without throwing', () => {
  test('unknown zones and malformed or out-of-range offsets are null', () => {
    for (const zone of [
      'Not/AZone',
      'utc-offset:99999999999999999999',
      'utc-offset:-99999999999999999999',
      'utc-offset:100000',
      'utc-offset:-100000',
      'utc-offset:841',
      'utc-offset:-841',
      'utc-offset:',
      'utc-offset:1.5',
      'utc-offset:abc',
      '',
    ]) {
      assert.doesNotThrow(() => dateKeyInZone(DUE, zone), zone);
      assert.equal(dateKeyInZone(DUE, zone), null, zone);
    }
  });

  test('non-finite or unrepresentable instants are null', () => {
    for (const at of [NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1]) {
      assert.doesNotThrow(() => dateKeyInZone(at, 'Asia/Tokyo'));
      assert.equal(dateKeyInZone(at, 'Asia/Tokyo'), null);
      assert.equal(dateKeyInZone(at, 'utc-offset:0'), null);
    }
  });

  test('valid zones and in-range offsets resolve the date in that zone', () => {
    assert.equal(dateKeyInZone(DUE, 'Asia/Tokyo'), '2026-10-16');
    assert.equal(dateKeyInZone(DUE, 'America/Los_Angeles'), '2026-10-15');
    assert.equal(dateKeyInZone(DUE, 'utc-offset:-540'), '2026-10-16');
    assert.equal(dateKeyInZone(DUE, 'utc-offset:420'), '2026-10-15');
    assert.equal(dateKeyInZone(DUE, 'utc-offset:0'), '2026-10-15');
  });
});

describe('readOccurrenceIdentity trusts a pair only when it is consistent', () => {
  test('a consistent pair is accepted', () => {
    assert.deepEqual(
      readOccurrenceIdentity(
        cycle({ logicalDateKey: '2026-10-16', planningZone: 'Asia/Tokyo' }),
      ),
      { logicalDateKey: '2026-10-16', planningZone: 'Asia/Tokyo' },
    );
  });

  test('an unknown zone or malformed offset is not trusted', () => {
    for (const planningZone of ['Not/AZone', 'utc-offset:99999999999', 'utc-offset:x']) {
      assert.equal(
        readOccurrenceIdentity(cycle({ logicalDateKey: '2026-10-16', planningZone })),
        null,
        planningZone,
      );
    }
  });

  test('a real date that is not the due date in that zone is not trusted', () => {
    assert.equal(
      readOccurrenceIdentity(
        cycle({ logicalDateKey: '2026-10-20', planningZone: 'Asia/Tokyo' }),
      ),
      null,
    );
    // Right date, wrong zone for it.
    assert.equal(
      readOccurrenceIdentity(
        cycle({ logicalDateKey: '2026-10-16', planningZone: 'America/Los_Angeles' }),
      ),
      null,
    );
  });
});

describe('invalid metadata is stripped on read and the notification ids survive', () => {
  const definition = (cycles: StoredAlarm[]): StoredAlarmDefinition => ({
    id: 'a1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', DUE),
    enabled: true,
    createdAtMs: DUE,
    cycles,
  });

  test('unknown zone, mismatched date and half pairs become legacy cycles', () => {
    const cycles = [
      cycle({ cycleId: 'unknown', mainAlarmId: 'm-u', checkInNotificationId: 'k-u', logicalDateKey: '2026-10-16', planningZone: 'Not/AZone' }),
      cycle({ cycleId: 'mismatch', mainAlarmId: 'm-m', checkInNotificationId: 'k-m', logicalDateKey: '2026-10-20', planningZone: 'Asia/Tokyo' }),
      cycle({ cycleId: 'offset', mainAlarmId: 'm-o', checkInNotificationId: 'k-o', logicalDateKey: '2026-10-16', planningZone: 'utc-offset:99999999999' }),
      cycle({ cycleId: 'half', mainAlarmId: 'm-h', checkInNotificationId: 'k-h', planningZone: 'Asia/Tokyo' }),
      cycle({ cycleId: 'good', mainAlarmId: 'm-g', checkInNotificationId: 'k-g', logicalDateKey: '2026-10-16', planningZone: 'Asia/Tokyo' }),
    ];
    const [stripped] = dropUntrustedOccurrenceMetadata([definition(cycles)]);
    assert.deepEqual(
      stripped.cycles.map((c) => [c.cycleId, c.mainAlarmId, c.checkInNotificationId]),
      cycles.map((c) => [c.cycleId, c.mainAlarmId, c.checkInNotificationId]),
    );
    for (const c of stripped.cycles.filter((x) => x.cycleId !== 'good')) {
      assert.equal('logicalDateKey' in c, false, c.cycleId);
      assert.equal('planningZone' in c, false, c.cycleId);
    }
    assert.equal(stripped.cycles.find((c) => c.cycleId === 'good')!.planningZone, 'Asia/Tokyo');
  });
});

/** Alignment is judged in the process zone, so the zone is set explicitly. */
function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('collectLogicalDateEvidence (shared by replan and fill)', () => {
  const repeat = makeAlarmRepeat('daily', DUE);
  const base = { nowMs: DUE - 86_400_000, hour: 7, minute: 0, repeat };

  test('a stamped terminal cycle blocks its own date regardless of the origin', () => inZone('America/Los_Angeles', () => {
    const evidence = collectLogicalDateEvidence({
      ...base,
      cycles: [cycle({ logicalDateKey: '2026-10-16', planningZone: 'Asia/Tokyo' })],
      planningZone: 'America/Los_Angeles',
      originZone: null,
    });
    assert.deepEqual([...evidence.blockedDates], ['2026-10-16']);
    assert.equal(evidence.originUnknown, false);
    assert.equal(evidence.stamps.size, 0);
  }));

  test('an unaligned legacy cycle uses the origin and is stamped with it', () => inZone('America/Los_Angeles', () => {
    const evidence = collectLogicalDateEvidence({
      ...base,
      cycles: [cycle()],
      planningZone: 'America/Los_Angeles',
      originZone: 'Asia/Tokyo',
    });
    assert.deepEqual([...evidence.blockedDates], ['2026-10-16']);
    assert.deepEqual(evidence.stamps.get('c1'), {
      logicalDateKey: '2026-10-16',
      planningZone: 'Asia/Tokyo',
    });
  }));

  test('an unaligned legacy cycle with an unknown or invalid origin fails closed', () => inZone('America/Los_Angeles', () => {
    for (const originZone of [null, undefined, 'Not/AZone', 'utc-offset:99999999']) {
      const evidence = collectLogicalDateEvidence({
        ...base,
        cycles: [cycle()],
        planningZone: 'America/Los_Angeles',
        originZone,
      });
      assert.equal(evidence.originUnknown, true, String(originZone));
      assert.equal(evidence.stamps.size, 0);
    }
  }));

  test('evidence older than the reach is ignored; it can no longer recur', () => inZone('America/Los_Angeles', () => {
    const evidence = collectLogicalDateEvidence({
      ...base,
      cycles: [cycle({ dueAtMs: base.nowMs - LOGICAL_DATE_REACH_MS - 1 })],
      planningZone: 'America/Los_Angeles',
      originZone: null,
    });
    assert.equal(evidence.originUnknown, false);
    assert.equal(evidence.blockedDates.size, 0);
  }));

  test('legacyEvidenceNeedsOrigin: unstamped terminal cycles inside the reach only', () => inZone('America/Los_Angeles', () => {
    const now = DUE;
    assert.equal(legacyEvidenceNeedsOrigin([cycle()], now), true);
    assert.equal(
      legacyEvidenceNeedsOrigin(
        [cycle({ logicalDateKey: '2026-10-16', planningZone: 'Asia/Tokyo' })],
        now,
      ),
      false,
    );
    assert.equal(legacyEvidenceNeedsOrigin([cycle({ phase: 'armed' })], now), false);
    assert.equal(
      legacyEvidenceNeedsOrigin([cycle({ dueAtMs: now - LOGICAL_DATE_REACH_MS - 1 })], now),
      false,
    );
  }));
});
