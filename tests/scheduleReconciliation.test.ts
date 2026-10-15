/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ALREADY_UP_OWNER, CHECK_IN_KIND, MAIN_ALARM_KIND } from '../src/alarmContracts';
import { getCheckInAtMs } from '../src/alarmPolicy';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import { ScheduledNotificationRollbackError } from '../src/alarmScheduleRollback';
import type {
  AlarmPhase,
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';
import {
  NOTIFICATION_QUEUE_CAPACITY,
  type QueueEntry,
  type QueueInspection,
} from '../src/queueInspection';
import {
  reconcileAlarmSchedules,
  recoverAbortedReconciliation,
  summarizeReconciliation,
  type OrphanStore,
  type ReconcileGateway,
} from '../src/scheduleReconciliation';

const NOW = new Date(2026, 9, 15, 6, 0, 0).getTime();
const at = (day: number, hour = 7, minute = 0) =>
  new Date(2026, 9, day, hour, minute, 0, 0).getTime();

function cycle(
  dueAtMs: number,
  phase: AlarmPhase = 'armed',
  overrides: Partial<StoredAlarm> = {},
): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId: `cycle-${dueAtMs}`,
    mainAlarmId: `main-${dueAtMs}`,
    checkInNotificationId: `checkin-${dueAtMs}`,
    armedAtMs: NOW - 3_600_000,
    dueAtMs,
    phase,
    stepCount: 0,
    stepCandidateRecorded: false,
    ...overrides,
  };
}

function definition(
  cycles: StoredAlarm[],
  overrides: Partial<StoredAlarmDefinition> = {},
): StoredAlarmDefinition {
  return {
    id: 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', NOW),
    enabled: true,
    createdAtMs: NOW - 86_400_000,
    cycles,
    ...overrides,
  };
}

interface OsEntry {
  id: string;
  owned: QueueEntry['owned'];
  atMs: number;
  /** Scheduled by an earlier iOS build: read back only as a relative interval. */
  relative?: boolean;
}

/** A stand-in for the shared OS queue: capacity, foreign entries, eviction. */
class FakeOs {
  entries = new Map<string, OsEntry>();
  maxSeen = 0;
  /** When over capacity the OS silently drops the farthest notification. */
  evictOverflow = false;
  /** The next N schedule calls return an id but store nothing. */
  dropNextSchedules = 0;
  /** Reads fail (queue unknown). */
  unreadable = false;
  /** iOS shape: the absolute fire time is not exposed. */
  relativeTriggers = false;
  failCancel = new Set<string>();
  cancelled: string[] = [];
  private foreignCount = 0;

  add(entry: OsEntry): void {
    if (this.dropNextSchedules > 0 && entry.id.startsWith('new-')) {
      this.dropNextSchedules -= 1;
      return;
    }
    this.entries.set(entry.id, entry);
    if (this.evictOverflow && this.entries.size > NOTIFICATION_QUEUE_CAPACITY) {
      const farthest = [...this.entries.values()].sort(
        (a, b) => b.atMs - a.atMs,
      )[0];
      this.entries.delete(farthest.id);
    }
    this.maxSeen = Math.max(this.maxSeen, this.entries.size);
  }

  addForeign(count: number, atMs = NOW + 400 * 86_400_000): void {
    for (let i = 0; i < count; i += 1) {
      this.foreignCount += 1;
      this.add({ id: `foreign-${this.foreignCount}`, owned: null, atMs });
    }
  }

  snapshot(): QueueInspection {
    if (this.unreadable) return { kind: 'unknown' };
    return {
      kind: 'known',
      entries: [...this.entries.values()].map((entry) => ({
        id: entry.id,
        owned: entry.owned,
        trigger: this.relativeTriggers || entry.relative
          ? { kind: 'relative' as const }
          : { kind: 'date' as const, atMs: entry.atMs },
      })),
    };
  }
}

function osFor(alarms: StoredAlarmDefinition[], foreign = 0): FakeOs {
  const os = new FakeOs();
  for (const alarm of alarms) {
    for (const c of alarm.cycles) {
      os.add({
        id: c.mainAlarmId,
        owned: { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: alarm.id, cycleId: c.cycleId },
        atMs: c.dueAtMs,
      });
      if (c.checkInNotificationId) {
        os.add({
          id: c.checkInNotificationId,
          owned: {
            owner: ALREADY_UP_OWNER, kind: CHECK_IN_KIND,
            alarmId: alarm.id,
            cycleId: c.cycleId,
            mainAlarmId: c.mainAlarmId,
          },
          atMs: getCheckInAtMs(c.dueAtMs, c.armedAtMs),
        });
      }
    }
  }
  os.addForeign(foreign);
  return os;
}

let replanCounter = 0;
let idCounter = 0;

function harness(
  os: FakeOs,
  options: {
    failMainCall?: number;
    failCheckpointCall?: number;
    now?: { value: number };
    onSchedule?: () => void;
    orphansFail?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const saved: StoredAlarmDefinition[][] = [];
  const orphanIds = new Set<string>();
  let mainCalls = 0;
  let checkpoints = 0;
  const gateway: ReconcileGateway = {
    async scheduleMain(i) {
      mainCalls += 1;
      if (options.failMainCall === mainCalls) throw new Error('main failed');
      idCounter += 1;
      const id = `new-main-${idCounter}`;
      calls.push(`main:${i.cycleId}:${i.dueAtMs}`);
      os.add({
        id,
        owned: { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: i.alarmId, cycleId: i.cycleId },
        atMs: i.dueAtMs,
      });
      options.onSchedule?.();
      return id;
    },
    async scheduleCheckIn(i) {
      idCounter += 1;
      const id = `new-checkin-${idCounter}`;
      calls.push(`checkin:${i.cycleId}:${i.mainAlarmId}`);
      os.add({
        id,
        owned: {
          owner: ALREADY_UP_OWNER, kind: CHECK_IN_KIND,
          alarmId: i.alarmId,
          cycleId: i.cycleId,
          mainAlarmId: i.mainAlarmId,
        },
        atMs: i.checkInAtMs,
      });
      return id;
    },
    async cancelScheduled(id) {
      calls.push(`cancel:${id}`);
      if (os.failCancel.has(id)) throw new Error(`cannot cancel ${id}`);
      os.entries.delete(id);
      os.cancelled.push(id);
    },
  };
  const orphans: OrphanStore = {
    async load() {
      if (options.orphansFail) throw new Error('journal unreadable');
      return [...orphanIds];
    },
    async add(ids) {
      ids.forEach((id) => orphanIds.add(id));
    },
    async remove(ids) {
      ids.forEach((id) => orphanIds.delete(id));
    },
  };
  return {
    calls,
    saved,
    orphanIds,
    /** The last state that was really written. */
    durable: (fallback: StoredAlarmDefinition[]) =>
      saved.length > 0 ? saved[saved.length - 1] : fallback,
    run: (
      alarms: StoredAlarmDefinition[],
      extra: { excluded?: string[]; canSchedule?: boolean; nowMs?: () => number } = {},
    ) =>
      reconcileAlarmSchedules({
        alarms,
        excludedAlarmIds: new Set(extra.excluded ?? []),
        readQueue: async () => os.snapshot(),
        canSchedule: extra.canSchedule ?? true,
        nowMs: extra.nowMs ?? (() => options.now?.value ?? NOW),
        gateway,
        orphans,
        checkpoint: async (next) => {
          calls.push('checkpoint');
          checkpoints += 1;
          if (options.failCheckpointCall === checkpoints) {
            throw new Error('save failed');
          }
          saved.push(next);
        },
        makeCycleId: () => `replan-${(replanCounter += 1)}`,
      }),
  };
}

const mainCallsOf = (calls: string[]) => calls.filter((c) => c.startsWith('main:'));

describe('reconcileAlarmSchedules', () => {
  test('a healthy queue is verified and nothing is touched', async () => {
    const alarms = [definition([cycle(at(16)), cycle(at(17))])];
    const h = harness(osFor(alarms));
    const out = await h.run(alarms);
    assert.deepEqual(h.calls, []);
    assert.equal(out.statuses['alarm-1'], 'verified');
    assert.equal(out.alarms, alarms);
  });

  test('reports whether the OS queue could be read', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = osFor(alarms);
    assert.equal((await harness(os).run(alarms)).queueKnown, true);
    os.unreadable = true;
    const blind = await harness(os).run(alarms);
    assert.equal(blind.queueKnown, false);
    assert.equal(blind.statuses['alarm-1'], 'unverified');
  });

  test('a missing main is rescheduled for the same cycle and check-in is re-linked', async () => {
    const alarms = [definition([cycle(at(16)), cycle(at(17))])];
    const os = osFor(alarms);
    os.entries.delete(`main-${at(16)}`);
    const h = harness(os);
    const out = await h.run(alarms);

    const fixed = out.alarms[0].cycles.find((c) => c.dueAtMs === at(16))!;
    assert.equal(fixed.cycleId, `cycle-${at(16)}`);
    assert.match(fixed.mainAlarmId, /^new-main-/);
    assert.match(fixed.checkInNotificationId ?? '', /^new-checkin-/);
    assert.ok(
      h.calls.includes(`checkin:cycle-${at(16)}:${fixed.mainAlarmId}`),
      'the new check-in must reference the new main id',
    );
    assert.ok(h.calls.includes(`cancel:checkin-${at(16)}`));
    assert.equal(out.statuses['alarm-1'], 'repaired');
    assert.equal(out.repaired, 1);
    const other = out.alarms[0].cycles.find((c) => c.dueAtMs === at(17))!;
    assert.equal(other.mainAlarmId, `main-${at(17)}`);
    assert.ok(h.saved.length > 0, 'repairs are checkpointed');
    assert.match(h.calls[0], /^main:/);
  });

  test('a missing check-in alone keeps the verified main', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = osFor(alarms);
    os.entries.delete(`checkin-${at(16)}`);
    const h = harness(os);
    const out = await h.run(alarms);
    assert.ok(!h.calls.some((c) => c.startsWith('main:')));
    assert.equal(out.alarms[0].cycles[0].mainAlarmId, `main-${at(16)}`);
    assert.match(out.alarms[0].cycles[0].checkInNotificationId ?? '', /^new-checkin-/);
    assert.equal(out.statuses['alarm-1'], 'repaired');
  });

  test('a check-in whose time already passed is not recreated', async () => {
    const due = NOW + 5 * 60_000;
    const alarms = [
      definition([cycle(due, 'armed', { armedAtMs: NOW - 3_600_000 })], {
        hour: 6,
        minute: 5,
      }),
    ];
    const os = osFor(alarms);
    os.entries.delete(`checkin-${due}`);
    const h = harness(os);
    const out = await h.run(alarms, { nowMs: () => NOW + 4 * 60_000 });
    assert.deepEqual(h.calls, []);
    assert.equal(out.statuses['alarm-1'], 'verified');
  });

  test('an unknown queue is reported unverified and nothing is changed', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = osFor(alarms);
    os.unreadable = true;
    const h = harness(os);
    const out = await h.run(alarms);
    assert.deepEqual(h.calls, []);
    assert.equal(out.statuses['alarm-1'], 'unverified');
    assert.equal(out.alarms, alarms);
  });

  test('without notification permission nothing is repaired and the gap is reported', async () => {
    const alarms = [definition([cycle(at(16))])];
    const h = harness(new FakeOs());
    const out = await h.run(alarms, { canSchedule: false });
    assert.deepEqual(h.calls, []);
    assert.equal(out.statuses['alarm-1'], 'missing');
  });

  test('permission re-enabled: the same missing queue is repaired on the next pass', async () => {
    const alarms = [definition([cycle(at(16))])];
    const h = harness(new FakeOs());
    const first = await h.run(alarms, { canSchedule: false });
    const second = await h.run(first.alarms, { canSchedule: true });
    assert.equal(second.statuses['alarm-1'], 'repaired');
    assert.match(second.alarms[0].cycles[0].mainAlarmId, /^new-main-/);
  });

  test('repeated reconciliation is idempotent once the queue holds the repairs', async () => {
    const alarms = [definition([cycle(at(16)), cycle(at(17))])];
    const h = harness(new FakeOs());
    const first = await h.run(alarms);
    const callsAfterFirst = h.calls.length;
    const second = await h.run(first.alarms);
    assert.equal(h.calls.length, callsAfterFirst);
    assert.equal(second.statuses['alarm-1'], 'verified');
  });

  test('suppressed, dismissed and ringing occurrences are never recreated', async () => {
    const alarms = [
      definition([
        cycle(at(16), 'suppressed'),
        cycle(at(17), 'dismissed'),
        cycle(at(18), 'ringing'),
        cycle(at(19)),
      ]),
    ];
    const h = harness(new FakeOs());
    const out = await h.run(alarms);
    assert.deepEqual(mainCallsOf(h.calls), [`main:cycle-${at(19)}:${at(19)}`]);
    for (const day of [16, 17, 18]) {
      const c = out.alarms[0].cycles.find((x) => x.dueAtMs === at(day))!;
      assert.equal(c.mainAlarmId, `main-${at(day)}`);
    }
  });

  test('alarms with an unfinished cancel or stop, and disabled alarms, are left alone', async () => {
    const alarms = [
      definition([cycle(at(16))], { id: 'a-pending' }),
      definition([cycle(at(16))], { id: 'a-off', enabled: false }),
    ].map((a) => ({
      ...a,
      cycles: a.cycles.map((c) => ({ ...c, alarmId: a.id, cycleId: `${a.id}-c` })),
    }));
    const h = harness(new FakeOs());
    const out = await h.run(alarms, { excluded: ['a-pending'] });
    assert.deepEqual(h.calls, []);
    assert.equal(out.alarms, alarms);
    assert.equal(out.statuses['a-pending'], undefined);
    assert.equal(out.statuses['a-off'], undefined);
  });

  test('unrelated notifications are never cancelled', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = osFor(alarms, 5);
    os.entries.delete(`main-${at(16)}`);
    const h = harness(os);
    await h.run(alarms);
    for (const call of h.calls.filter((c) => c.startsWith('cancel:'))) {
      assert.equal(call, `cancel:checkin-${at(16)}`);
    }
    assert.equal([...os.entries.keys()].filter((k) => k.startsWith('foreign-')).length, 5);
  });

  test('a due time reached while repairing is left to the ring path', async () => {
    const alarms = [definition([cycle(at(16))])];
    const h = harness(new FakeOs());
    const out = await h.run(alarms, { nowMs: () => at(16) });
    assert.deepEqual(h.calls, []);
    assert.equal(out.alarms[0].cycles[0].mainAlarmId, `main-${at(16)}`);
  });

  test('a main that cannot be rescheduled is reported and other alarms continue', async () => {
    const alarms = [definition([cycle(at(16))])];
    const h = harness(new FakeOs(), { failMainCall: 1 });
    const out = await h.run(alarms);
    assert.equal(out.statuses['alarm-1'], 'missing');
    assert.equal(out.issues[0].kind, 'main_schedule_failed');
    assert.equal(out.alarms[0].cycles[0].mainAlarmId, `main-${at(16)}`);
  });

  test('a failed checkpoint cancels what was just scheduled and rethrows', async () => {
    const alarms = [definition([cycle(at(16))])];
    const h = harness(new FakeOs(), { failCheckpointCall: 1 });
    await assert.rejects(() => h.run(alarms), /save failed/);
    assert.ok(h.calls.some((c) => c.startsWith('cancel:new-main-')));
  });
});

describe('notification queue capacity (64 shared with foreign entries)', () => {
  const zoneChanged = () => {
    // Stored in Tokyo wall clock, reconciled in Los Angeles.
    const now = new Date(2026, 9, 15, 6, 0).getTime();
    const dues = [16, 17, 18].map((d) => Date.UTC(2026, 9, d, 7 - 9, 0));
    return { now, dues };
  };

  async function inZone<T>(zone: string, run: () => Promise<T> | T) {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  function misalignedAlarm(now: number, dues: number[]) {
    return definition(
      dues.map((d) => cycle(d, 'armed', { armedAtMs: now })),
      { repeat: makeAlarmRepeat('daily', now) },
    );
  }

  test('replans one occurrence at a time and never exceeds 64 with foreign entries', async () => {
    const { now, dues } = zoneChanged();
    await inZone('America/Los_Angeles', async () => {
      const alarms = [misalignedAlarm(now, dues)];
      // 6 own + 54 foreign = 60 pending; a batch of 6 new would reach 66.
      const os = osFor(alarms, 54);
      os.evictOverflow = true;
      const h = harness(os, { now: { value: now } });
      const out = await h.run(alarms);
      assert.ok(os.maxSeen <= NOTIFICATION_QUEUE_CAPACITY, `peak ${os.maxSeen}`);
      assert.equal(out.replanned, 3);
      assert.equal(out.alarms[0].cycles.length, 3);
      for (const c of out.alarms[0].cycles) {
        assert.ok(os.entries.has(c.mainAlarmId), 'new main is really queued');
        assert.ok(c.checkInNotificationId && os.entries.has(c.checkInNotificationId));
      }
      for (const old of alarms[0].cycles) {
        assert.ok(!os.entries.has(old.mainAlarmId), 'old main cancelled');
      }
      assert.equal(out.statuses['alarm-1'], 'repaired');
      // Interleaved: the first old pair is cancelled before the second new main.
      const firstCancel = h.calls.findIndex((c) => c.startsWith('cancel:'));
      const secondMain = h.calls.findIndex(
        (c, i) => c.startsWith('main:') && mainCallsOf(h.calls.slice(0, i)).length === 1,
      );
      assert.ok(firstCancel < secondMain);
    });
  });

  for (const pending of [63, 64]) {
    test(`with ${pending} pending the old reservations are kept and the shortage is reported`, async () => {
      const { now, dues } = zoneChanged();
      await inZone('America/Los_Angeles', async () => {
        const alarms = [misalignedAlarm(now, dues)];
        const os = osFor(alarms, pending - 6);
        os.evictOverflow = true;
        const h = harness(os, { now: { value: now } });
        const out = await h.run(alarms);
        assert.deepEqual(h.calls, [], 'nothing scheduled, nothing cancelled');
        assert.equal(out.statuses['alarm-1'], 'capacity_full');
        assert.equal(out.alarms[0].cycles.length, 3);
        assert.equal(os.entries.size, pending);
      });
    });
  }

  test('60 pending still works for a single-pair step even when only 2 slots are free', async () => {
    const { now, dues } = zoneChanged();
    await inZone('America/Los_Angeles', async () => {
      const alarms = [misalignedAlarm(now, dues.slice(0, 1))];
      const os = osFor(alarms, 62 - 2); // 2 own + 60 foreign = 62
      const h = harness(os, { now: { value: now } });
      const out = await h.run(alarms);
      assert.equal(out.replanned, 1);
      assert.ok(os.maxSeen <= NOTIFICATION_QUEUE_CAPACITY);
    });
  });

  test('a missing main at 64 pending is not rescheduled into a full queue', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = osFor(alarms, 62); // main + check-in + 62 = 64
    os.entries.delete(`main-${at(16)}`);
    os.addForeign(1);
    os.evictOverflow = true;
    // The stale check-in is ours and frees one slot, so one main fits; no check-in.
    const h = harness(os);
    const out = await h.run(alarms);
    assert.ok(os.maxSeen <= NOTIFICATION_QUEUE_CAPACITY);
    assert.ok(['capacity_full', 'check_in_missing', 'repaired'].includes(out.statuses['alarm-1']));
    assert.ok(os.entries.has(out.alarms[0].cycles[0].mainAlarmId));
  });

  test('a full queue with nothing of ours to free leaves the missing main reported, not faked', async () => {
    const alarms = [definition([cycle(at(16), 'armed', { checkInNotificationId: undefined })])];
    const os = osFor(alarms, 0);
    os.entries.delete(`main-${at(16)}`);
    os.addForeign(NOTIFICATION_QUEUE_CAPACITY);
    os.evictOverflow = true;
    const h = harness(os);
    const out = await h.run(alarms);
    assert.deepEqual(h.calls, []);
    assert.equal(out.statuses['alarm-1'], 'capacity_full');
    assert.equal(out.alarms[0].cycles[0].mainAlarmId, `main-${at(16)}`);
  });

  test('a missing check-in at 64 pending is reported as capacity, not repaired', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = osFor(alarms, 62);
    os.entries.delete(`checkin-${at(16)}`);
    os.addForeign(1);
    const h = harness(os);
    const out = await h.run(alarms);
    assert.deepEqual(h.calls, []);
    assert.equal(out.statuses['alarm-1'], 'capacity_full');
  });

  test('an OS that reports success but stores nothing never cancels the old reservation', async () => {
    const { now, dues } = zoneChanged();
    await inZone('America/Los_Angeles', async () => {
      const alarms = [misalignedAlarm(now, dues)];
      const os = osFor(alarms);
      os.dropNextSchedules = 100;
      const h = harness(os, { now: { value: now } });
      const out = await h.run(alarms);
      assert.ok(!h.calls.some((c) => c.startsWith('cancel:')));
      for (const old of alarms[0].cycles) {
        assert.ok(os.entries.has(old.mainAlarmId));
      }
      assert.equal(out.statuses['alarm-1'], 'missing');
      assert.ok(out.alarms[0].cycles.some((c) => c.cycleId === alarms[0].cycles[0].cycleId));
    });
  });

  test('an OS eviction of the new reservation keeps the old one until it is confirmed', async () => {
    const { now, dues } = zoneChanged();
    await inZone('America/Los_Angeles', async () => {
      const alarms = [misalignedAlarm(now, dues.slice(0, 1))];
      const os = osFor(alarms, 56); // 2 + 56 = 58; new pair fits...
      // ...but the OS evicts the nearest-dated entry when asked to hold the new main.
      const h = harness(os, {
        now: { value: now },
        onSchedule: () => {
          for (const id of [...os.entries.keys()]) {
            if (id.startsWith('new-main-')) os.entries.delete(id);
          }
        },
      });
      const out = await h.run(alarms);
      assert.ok(os.entries.has(alarms[0].cycles[0].mainAlarmId));
      assert.notEqual(out.statuses['alarm-1'], 'repaired');
      assert.notEqual(out.statuses['alarm-1'], 'verified');
    });
  });

  test('a retry after a partial replacement finishes without a second copy', async () => {
    const { now, dues } = zoneChanged();
    await inZone('America/Los_Angeles', async () => {
      const alarms = [misalignedAlarm(now, dues)];
      const os = osFor(alarms);
      const first = harness(os, { now: { value: now }, failMainCall: 2 });
      const partial = await first.run(alarms);
      // One pair replaced its old one; two olds are still reserved: honest warning.
      assert.equal(partial.alarms[0].cycles.length, 3);
      assert.equal(partial.replanned, 1);
      assert.equal(partial.statuses['alarm-1'], 'duplicated');

      const second = harness(os, { now: { value: now } });
      const done = await second.run(partial.alarms);
      // new1 already stands in for old1; only old2/old3's slots need one more.
      assert.equal(mainCallsOf(second.calls).length, 1, 'no second copy of new1');
      assert.equal(done.replanned, 1);
      assert.equal(done.alarms[0].cycles.length, 2);
      for (const old of alarms[0].cycles) {
        assert.ok(!os.entries.has(old.mainAlarmId));
      }
      assert.equal(done.statuses['alarm-1'], 'repaired');

      const third = harness(os, { now: { value: now } });
      await third.run(done.alarms);
      assert.deepEqual(third.calls, []);
    });
  });
});

describe('crash, save failure and deadline during repair', () => {
  async function inZone<T>(zone: string, run: () => Promise<T> | T) {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }
  const now = new Date(2026, 9, 15, 6, 0).getTime();
  const tokyoDues = [16, 17].map((d) => Date.UTC(2026, 9, d, 7 - 9, 0));
  const misaligned = () =>
    definition(
      tokyoDues.map((d) => cycle(d, 'armed', { armedAtMs: now })),
      { repeat: makeAlarmRepeat('daily', now) },
    );

  test('a checkpoint that fails mid-batch leaves the earlier alarm repair durable', async () => {
    const a = definition([cycle(at(16))]);
    const b = {
      ...definition([cycle(at(16))], { id: 'alarm-2' }),
      cycles: [
        cycle(at(16), 'armed', {
          alarmId: 'alarm-2',
          cycleId: 'b-c',
          mainAlarmId: 'b-main',
          checkInNotificationId: 'b-checkin',
        }),
      ],
    };
    const alarms = [a, b];
    // a: main missing -> main save (1) + check-in save (2); b: main save (3) fails.
    const os = new FakeOs();
    os.add({ id: 'b-checkin', owned: { owner: ALREADY_UP_OWNER, kind: CHECK_IN_KIND, alarmId: 'alarm-2', cycleId: 'b-c', mainAlarmId: 'b-main' }, atMs: at(16) - 1 });
    const h = harness(os, { failCheckpointCall: 3 });
    await assert.rejects(() => h.run(alarms), /save failed/);
    const durable = h.durable(alarms);
    assert.match(durable[0].cycles[0].mainAlarmId, /^new-main-/);
    assert.match(durable[0].cycles[0].checkInNotificationId ?? '', /^new-checkin-/);
    assert.equal(durable[1].cycles[0].mainAlarmId, 'b-main');
    // What was scheduled for b but not saved is cancelled.
    assert.ok(h.calls.some((c) => /^cancel:new-main-/.test(c)));
  });

  test('a rollback that cannot cancel keeps the ids in recoverable tracking', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = new FakeOs();
    os.failCancel.add(`new-main-${idCounter + 1}`);
    const h = harness(os, { failCheckpointCall: 1 });
    await assert.rejects(
      () => h.run(alarms),
      (error) => error instanceof ScheduledNotificationRollbackError,
    );
    const orphanId = `new-main-${idCounter}`;
    assert.deepEqual([...h.orphanIds], [orphanId]);

    // Next pass: the tracked orphan carries our payload, so it is cancelled.
    os.failCancel.clear();
    const retry = harness(os);
    retry.orphanIds.add(orphanId);
    await retry.run(alarms);
    assert.ok(retry.calls.includes(`cancel:${orphanId}`));
    assert.deepEqual([...retry.orphanIds], []);
  });

  test('a tracked orphan id that now holds foreign content is released, not cancelled', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = osFor(alarms);
    os.entries.set('orphan-1', { id: 'orphan-1', owned: null, atMs: at(20) });
    const h = harness(os);
    h.orphanIds.add('orphan-1');
    await h.run(alarms);
    assert.ok(!h.calls.includes('cancel:orphan-1'));
    assert.ok(os.entries.has('orphan-1'));
    assert.deepEqual([...h.orphanIds], []);
  });

  test('a save failure after the old pair was cancelled never recreates the old time', async () => {
    await inZone('America/Los_Angeles', async () => {
      const alarms = [misaligned()];
      const os = osFor(alarms);
      // checkpoints: new pair 1 (1), old 1 drop (2) fails after its cancel.
      const first = harness(os, { now: { value: now }, failCheckpointCall: 2 });
      await assert.rejects(() => first.run(alarms), /save failed/);
      const durable = first.durable(alarms);
      assert.ok(durable[0].cycles.some((c) => c.cycleId === alarms[0].cycles[0].cycleId));
      assert.ok(!os.entries.has(alarms[0].cycles[0].mainAlarmId), 'old pair really cancelled');

      // Recovery uses the durable state; the cancelled old time is not rebuilt.
      const second = harness(os, { now: { value: now } });
      const out = await second.run(durable);
      const rebuilt = mainCallsOf(second.calls).filter((c) =>
        c.includes(`:${tokyoDues[0]}`),
      );
      assert.deepEqual(rebuilt, []);
      assert.ok(!out.alarms[0].cycles.some((c) => c.dueAtMs === tokyoDues[0]));
      const queuedMains = [...os.entries.values()].filter((e) => e.owned?.kind === MAIN_ALARM_KIND);
      assert.equal(queuedMains.length, out.alarms[0].cycles.length, 'no duplicates');
    });
  });

  test('a cancelled old occurrence is not recreated even when replanning is not possible', async () => {
    await inZone('America/Los_Angeles', async () => {
      const alarms = [misaligned()];
      const os = osFor(alarms);
      const first = harness(os, { now: { value: now }, failCheckpointCall: 2 });
      await assert.rejects(() => first.run(alarms));
      const durable = first.durable(alarms);
      const second = harness(os, { now: { value: now } });
      const out = await second.run(durable, { canSchedule: false });
      assert.deepEqual(second.calls, []);
      assert.notEqual(out.statuses['alarm-1'], 'verified');
    });
  });

  test('the old occurrence is not cancelled when its time arrives during the async repair', async () => {
    await inZone('America/Los_Angeles', async () => {
      const alarms = [misaligned()];
      const os = osFor(alarms);
      const clock = { value: now };
      const h = harness(os, {
        now: clock,
        // Scheduling the replacement takes long enough to reach the old due time.
        onSchedule: () => {
          clock.value = tokyoDues[0];
        },
      });
      const out = await h.run(alarms);
      assert.ok(!h.calls.includes(`cancel:${alarms[0].cycles[0].mainAlarmId}`));
      assert.ok(!h.calls.includes(`cancel:${alarms[0].cycles[0].checkInNotificationId}`));
      assert.ok(os.entries.has(alarms[0].cycles[0].mainAlarmId));
      assert.ok(out.alarms[0].cycles.some((c) => c.cycleId === alarms[0].cycles[0].cycleId));
    });
  });

  test('an untracked notification of the same occurrence is adopted instead of duplicated', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = osFor(alarms);
    os.entries.delete(`main-${at(16)}`);
    // A crash after scheduling but before saving left this one behind.
    os.add({
      id: 'orphan-main',
      owned: { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: 'alarm-1', cycleId: `cycle-${at(16)}` },
      atMs: at(16),
    });
    const h = harness(os);
    const out = await h.run(alarms);
    assert.deepEqual(mainCallsOf(h.calls), []);
    assert.equal(out.alarms[0].cycles[0].mainAlarmId, 'orphan-main');
  });
});

describe('queue matching by notification content', () => {
  const alarms = () => [definition([cycle(at(16))])];

  test('the same id carrying another payload is not ours: unverified, nothing cancelled', async () => {
    const list = alarms();
    const os = osFor(list);
    os.entries.set(`main-${at(16)}`, {
      id: `main-${at(16)}`,
      owned: { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: 'someone-else', cycleId: 'other' },
      atMs: at(16),
    });
    const h = harness(os);
    const out = await h.run(list);
    assert.equal(out.statuses['alarm-1'], 'unverified');
    assert.deepEqual(h.calls, []);
    assert.ok(os.entries.has(`main-${at(16)}`), 'foreign entry preserved');
  });

  test('unparseable content under a stored id cannot be verified', async () => {
    const list = alarms();
    const os = osFor(list);
    os.entries.set(`main-${at(16)}`, { id: `main-${at(16)}`, owned: null, atMs: at(16) });
    const h = harness(os);
    const out = await h.run(list);
    assert.equal(out.statuses['alarm-1'], 'unverified');
    assert.deepEqual(h.calls, []);
  });

  test('own payload pending for a different time is unverified where the time is exposed', async () => {
    const list = alarms();
    const os = osFor(list);
    os.entries.get(`main-${at(16)}`)!.atMs = at(16) + 3_600_000;
    const h = harness(os);
    const out = await h.run(list);
    assert.equal(out.statuses['alarm-1'], 'unverified');
    assert.deepEqual(h.calls, []);
  });

  test('an own payload with an unreadable trigger shape is never reported verified', async () => {
    const list = alarms();
    const os = osFor(list);
    const snapshot = os.snapshot.bind(os);
    os.snapshot = () => {
      const known = snapshot();
      if (known.kind !== 'known') return known;
      return {
        kind: 'known',
        entries: known.entries.map((e) => ({ ...e, trigger: { kind: 'unknown' as const } })),
      };
    };
    const h = harness(os);
    const out = await h.run(list);
    assert.equal(out.statuses['alarm-1'], 'unverified');
    assert.deepEqual(h.calls, []);
  });

  test('a check-in naming another main is not accepted as this cycle\'s check-in', async () => {
    const list = alarms();
    const os = osFor(list);
    os.entries.get(`checkin-${at(16)}`)!.owned = {
      kind: CHECK_IN_KIND,
      alarmId: 'alarm-1',
      cycleId: `cycle-${at(16)}`,
      mainAlarmId: 'some-older-main',
    };
    const h = harness(os);
    const out = await h.run(list);
    assert.equal(out.statuses['alarm-1'], 'unverified');
    assert.deepEqual(h.calls, []);
  });
});

describe('reconcileAlarmSchedules with clock and time-zone changes', () => {
  async function withTimeZone<T>(zone: string, run: () => Promise<T> | T) {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  test('repeating HH:mm follows the local wall clock after a zone change', async () => {
    const tokyo = await withTimeZone('Asia/Tokyo', () => {
      const now = new Date(2026, 9, 15, 6, 0).getTime();
      const dues = [16, 17, 18].map((d) => new Date(2026, 9, d, 7, 0).getTime());
      return { now, dues };
    });
    const alarms = [
      definition(
        tokyo.dues.map((d) => cycle(d, 'armed', { armedAtMs: tokyo.now })),
        { repeat: makeAlarmRepeat('daily', tokyo.now) },
      ),
    ];
    await withTimeZone('America/Los_Angeles', async () => {
      const h = harness(osFor(alarms));
      const out = await h.run(alarms, {
        nowMs: () => tokyo.now,
      });
      const cycles = out.alarms[0].cycles;
      assert.equal(out.replanned, 3);
      for (const c of cycles) {
        const d = new Date(c.dueAtMs);
        assert.equal(d.getHours(), 7);
        assert.equal(d.getMinutes(), 0);
        assert.ok(c.dueAtMs > tokyo.now);
      }
      assert.equal(cycles.length, 3);
      // Old reservations are cancelled by their stored ids only.
      for (const old of alarms[0].cycles) {
        assert.ok(h.calls.includes(`cancel:${old.mainAlarmId}`));
        assert.ok(h.calls.includes(`cancel:${old.checkInNotificationId}`));
      }
      // New reservations were made before the old ones were cancelled.
      assert.match(h.calls[0], /^main:/);
      assert.equal(out.statuses['alarm-1'], 'repaired');
    });
  });

  test('an unchanged zone does not replan, including across DST', async () => {
    await withTimeZone('America/Los_Angeles', async () => {
      const now = new Date(2026, 10, 1, 0, 30).getTime(); // DST ends Nov 1
      const dues = [1, 2, 3].map((d) => new Date(2026, 10, d, 7, 0).getTime());
      const alarms = [
        definition(dues.map((d) => cycle(d, 'armed', { armedAtMs: now })), {
          repeat: makeAlarmRepeat('daily', now),
        }),
      ];
      const h = harness(osFor(alarms));
      const out = await h.run(alarms, {
        nowMs: () => now,
      });
      assert.deepEqual(h.calls, []);
      assert.equal(out.replanned, 0);
    });
  });

  test('suppressed occurrences keep their slot when a zone change replans the rest', async () => {
    const now = await withTimeZone('Asia/Tokyo', () =>
      new Date(2026, 9, 15, 6, 0).getTime(),
    );
    const jstDue = (d: number) =>
      new Date(Date.UTC(2026, 9, d, 7 - 9, 0)).getTime();
    await withTimeZone('America/Los_Angeles', async () => {
      const laDue = new Date(2026, 9, 16, 7, 0).getTime();
      const alarms = [
        definition(
          [
            cycle(laDue, 'suppressed', { armedAtMs: now }),
            cycle(jstDue(17), 'armed', { armedAtMs: now }),
          ],
          { repeat: makeAlarmRepeat('daily', now) },
        ),
      ];
      const h = harness(osFor(alarms));
      const out = await h.run(alarms, {
        nowMs: () => now,
      });
      const suppressed = out.alarms[0].cycles.filter(
        (c) => c.phase === 'suppressed',
      );
      assert.equal(suppressed.length, 1);
      assert.equal(suppressed[0].dueAtMs, laDue);
      assert.ok(
        !out.alarms[0].cycles.some(
          (c) => c.phase === 'armed' && c.dueAtMs === laDue,
        ),
        'the suppressed instant must not be re-armed',
      );
    });
  });

  test('today-only stays anchored to its original local date', async () => {
    const now = await withTimeZone('Asia/Tokyo', () =>
      new Date(2026, 9, 15, 6, 0).getTime(),
    );
    const jstDue = new Date(Date.UTC(2026, 9, 14, 22, 0)).getTime(); // Oct 15 07:00 JST
    await withTimeZone('America/Los_Angeles', async () => {
      const alarms = [
        definition([cycle(jstDue, 'armed', { armedAtMs: now - 3_600_000 })], {
          repeat: { kind: 'today', weekdays: [], dateKey: '2026-10-15' },
        }),
      ];
      const h = harness(osFor(alarms));
      const out = await h.run(alarms, {
        nowMs: () => now,
      });
      const c = out.alarms[0].cycles.filter((x) => x.phase === 'armed');
      assert.equal(c.length, 1);
      const d = new Date(c[0].dueAtMs);
      assert.equal(d.getDate(), 15, 'must not move to another local date');
      assert.equal(d.getHours(), 7);
    });
  });

  test('today-only whose anchored wall-clock time has passed keeps its reservation', async () => {
    const now = await withTimeZone('Asia/Tokyo', () =>
      new Date(2026, 9, 15, 6, 0).getTime(),
    );
    const jstDue = new Date(Date.UTC(2026, 9, 14, 22, 0)).getTime();
    // Tokyo -> Honolulu: Oct 15 07:00 HST is 18 h after the stored instant is
    // reachable, so use a zone far ahead instead: Pacific/Kiritimati (+14).
    await withTimeZone('Pacific/Kiritimati', async () => {
      const alarms = [
        definition([cycle(jstDue, 'armed', { armedAtMs: now - 3_600_000 })], {
          repeat: { kind: 'today', weekdays: [], dateKey: '2026-10-15' },
        }),
      ];
      const h = harness(osFor(alarms));
      const out = await h.run(alarms, {
        nowMs: () => now,
      });
      assert.deepEqual(h.calls, []);
      assert.equal(out.alarms[0].cycles[0].mainAlarmId, `main-${jstDue}`);
    });
  });
});

describe('summarizeReconciliation', () => {

  test('warns persistently when the orphan journal is unreadable, even with no alarms', () => {
    const summary = summarizeReconciliation({
      ...base,
      statuses: {},
      orphansUnreadable: true,
    });
    assert.equal(summary.notice?.tone, 'danger');
    assert.deepEqual(summary.problemKeys, ['queue_orphans_unreadable']);
  });

  test('does not report a clean pass when the queue could not be verified', () => {
    const summary = summarizeReconciliation({
      ...base,
      statuses: {},
      queueVerified: false,
    });
    assert.equal(summary.notice?.tone, 'warning');
    assert.deepEqual(summary.problemKeys, ['queue_unverified']);
  });
  const base = { repaired: 0, replanned: 0, zoneChanged: false };

  test('a clean pass says nothing', () => {
    assert.deepEqual(
      summarizeReconciliation({ ...base, statuses: { a: 'verified' } }),
      { notice: null, problemKeys: [] },
    );
  });

  test('a repair is announced, a replan names the clock change', () => {
    const repaired = summarizeReconciliation({
      ...base,
      repaired: 1,
      statuses: { a: 'repaired' },
    });
    assert.equal(repaired.notice?.tone, 'warning');
    assert.match(repaired.notice!.text, /再予約/);
    const replanned = summarizeReconciliation({
      ...base,
      replanned: 2,
      zoneChanged: true,
      statuses: { a: 'repaired' },
    });
    assert.match(replanned.notice!.text, /タイムゾーン|時刻/);
  });

  test('capacity and duplicated each get their own honest wording', () => {
    const capacity = summarizeReconciliation({
      ...base,
      statuses: { a: 'capacity_full' },
    });
    assert.equal(capacity.notice?.tone, 'danger');
    assert.match(capacity.notice!.text, /上限/);
    assert.deepEqual(capacity.problemKeys, ['queue_capacity_full:a']);
    const duplicated = summarizeReconciliation({
      ...base,
      statuses: { a: 'duplicated' },
    });
    assert.equal(duplicated.notice?.tone, 'warning');
    assert.match(duplicated.notice!.text, /2回|重複|二重/);
  });

  test('missing is danger, unverified is a warning, and both key the alarm', () => {
    const missing = summarizeReconciliation({
      ...base,
      statuses: { a: 'missing', b: 'unverified' },
    });
    assert.equal(missing.notice?.tone, 'danger');
    assert.deepEqual(missing.problemKeys.sort(), [
      'queue_missing:a',
      'queue_unverified:b',
    ]);
    const unverified = summarizeReconciliation({
      ...base,
      statuses: { b: 'unverified' },
    });
    assert.equal(unverified.notice?.tone, 'warning');
    assert.match(unverified.notice!.text, /確認できません/);
  });
});

describe('recoverAbortedReconciliation', () => {
  const known = [definition([cycle(at(16))])];
  const durable = [definition([cycle(at(16), 'armed', { mainAlarmId: 'saved-main' })])];

  test('uses the latest durable checkpoint, not the stale input', async () => {
    const out = await recoverAbortedReconciliation(new Error('x'), async () => durable, known);
    assert.equal(out.alarms, durable);
    assert.equal(out.statuses['alarm-1'], 'unverified');
    assert.deepEqual(out.unrecoveredNotificationIds, []);
  });

  test('failed rollback ids are reported, not dropped', async () => {
    const error = new ScheduledNotificationRollbackError(new Error('save'), [
      { notificationId: 'n-1', message: 'x' },
      { notificationId: 'n-2', message: 'y' },
    ]);
    const out = await recoverAbortedReconciliation(error, async () => durable, known);
    assert.deepEqual(out.unrecoveredNotificationIds, ['n-1', 'n-2']);
    assert.equal(out.alarms, durable);
  });

  test('if the checkpoint cannot be reloaded nothing is claimed saved', async () => {
    const out = await recoverAbortedReconciliation(
      new Error('x'),
      async () => {
        throw new Error('storage');
      },
      known,
    );
    assert.equal(out.alarms, null);
    assert.equal(out.statuses['alarm-1'], 'unverified');
  });

  test('summary names unrecovered notifications', () => {
    const summary = summarizeReconciliation({
      statuses: {},
      repaired: 0,
      replanned: 0,
      zoneChanged: false,
      unrecoveredNotificationIds: ['n-1'],
    });
    assert.equal(summary.notice?.tone, 'danger');
    assert.match(summary.notice!.text, /解除できていない/);
    assert.deepEqual(summary.problemKeys, ['queue_unrecovered_notifications']);
  });
});

describe('legacy iOS relative reservations are migrated to verifiable ones', () => {
  const legacyCycle = () =>
    cycle(at(16), 'armed', { stepCount: 37, phase: 'step_candidate', stepCandidateRecorded: true });
  const setup = () => {
    const list = [definition([legacyCycle()])];
    const os = osFor(list);
    for (const entry of os.entries.values()) entry.relative = true;
    return { list, os };
  };

  test('new main is verified and persisted before the exact old ids are cancelled', async () => {
    const { list, os } = setup();
    const h = harness(os);
    const out = await h.run(list);

    const migrated = out.alarms[0].cycles[0];
    const before = list[0].cycles[0];
    assert.match(migrated.mainAlarmId, /^new-main-/);
    assert.match(migrated.checkInNotificationId ?? '', /^new-checkin-/);
    assert.equal(migrated.cycleId, before.cycleId);
    assert.equal(migrated.armedAtMs, before.armedAtMs);
    assert.equal(migrated.stepCount, 37);
    assert.equal(migrated.phase, 'step_candidate');
    assert.equal(migrated.dueAtMs, before.dueAtMs);

    const firstCheckpoint = h.calls.indexOf('checkpoint');
    const mainScheduled = h.calls.findIndex((c) => c.startsWith('main:'));
    const oldMainCancel = h.calls.indexOf(`cancel:main-${at(16)}`);
    assert.ok(mainScheduled !== -1 && mainScheduled < firstCheckpoint);
    assert.ok(firstCheckpoint < oldMainCancel, 'old main is cancelled only after the relink is saved');
    assert.ok(h.calls.includes(`cancel:checkin-${at(16)}`));
    assert.ok(!os.entries.has(`main-${at(16)}`));
    assert.ok(!os.entries.has(`checkin-${at(16)}`));
    assert.equal(out.statuses['alarm-1'], 'repaired');
    assert.deepEqual([...h.orphanIds], []);
  });

  test('a queue with no room keeps the old reservation untouched', async () => {
    const { list, os } = setup();
    os.addForeign(NOTIFICATION_QUEUE_CAPACITY - os.entries.size);
    const h = harness(os);
    const out = await h.run(list);
    assert.equal(out.statuses['alarm-1'], 'capacity_full');
    assert.deepEqual(h.calls, []);
    assert.equal(out.alarms, list);
    assert.ok(os.entries.has(`main-${at(16)}`));
  });

  test('without permission to schedule nothing is changed and it is reported unverified', async () => {
    const { list, os } = setup();
    const h = harness(os);
    const out = await h.run(list, { canSchedule: false });
    assert.equal(out.statuses['alarm-1'], 'unverified');
    assert.deepEqual(h.calls, []);
  });

  test('a main that came due while migrating keeps the old alarm', async () => {
    const { list, os } = setup();
    const now = { value: NOW };
    const h = harness(os, { now, onSchedule: () => { now.value = at(16); } });
    const out = await h.run(list);
    assert.ok(!h.calls.includes(`cancel:main-${at(16)}`));
    assert.ok(!h.calls.includes(`cancel:checkin-${at(16)}`));
    assert.ok(!h.calls.includes('checkpoint'));
    assert.ok(os.entries.has(`main-${at(16)}`));
    assert.equal(out.alarms[0].cycles[0].mainAlarmId, `main-${at(16)}`);
  });

  test('a failed save cancels the new main and leaves the old alarm live and untracked', async () => {
    const { list, os } = setup();
    const h = harness(os, { failCheckpointCall: 1 });
    await assert.rejects(() => h.run(list), /save failed/);
    assert.ok(os.entries.has(`main-${at(16)}`));
    assert.ok(h.calls.some((c) => /^cancel:new-main-/.test(c)));
    assert.ok(!h.calls.includes(`cancel:main-${at(16)}`));
    assert.deepEqual([...h.orphanIds], [], 'the live old ids must not stay tracked as orphans');
  });

  test('old ids stay tracked until cancelled, so a failed cancel is retried, not lost', async () => {
    const { list, os } = setup();
    os.failCancel.add(`main-${at(16)}`);
    const h = harness(os);
    const out = await h.run(list);
    assert.match(out.alarms[0].cycles[0].mainAlarmId, /^new-main-/);
    assert.deepEqual([...h.orphanIds], [`main-${at(16)}`]);

    os.failCancel.clear();
    const retry = harness(os);
    retry.orphanIds.add(`main-${at(16)}`);
    await retry.run(h.durable(list));
    assert.ok(retry.calls.includes(`cancel:main-${at(16)}`));
    assert.deepEqual([...retry.orphanIds], []);
  });

  test('only the check-in is legacy: it is replaced and the main is never rescheduled', async () => {
    const list = [definition([legacyCycle()])];
    const os = osFor(list);
    os.entries.get(`checkin-${at(16)}`)!.relative = true;
    const h = harness(os);
    const out = await h.run(list);
    assert.ok(!h.calls.some((c) => c.startsWith('main:')));
    assert.equal(out.alarms[0].cycles[0].mainAlarmId, `main-${at(16)}`);
    assert.match(out.alarms[0].cycles[0].checkInNotificationId ?? '', /^new-checkin-/);
    assert.ok(h.calls.indexOf('checkpoint') < h.calls.indexOf(`cancel:checkin-${at(16)}`));
  });

  test('foreign content under a legacy id is never cancelled', async () => {
    const { list, os } = setup();
    os.entries.get(`checkin-${at(16)}`)!.owned = null;
    const h = harness(os);
    await h.run(list);
    assert.ok(os.entries.has(`checkin-${at(16)}`));
    assert.ok(!h.calls.includes(`cancel:checkin-${at(16)}`));
  });
});

describe('orphan tracking never cancels a live reservation', () => {
  test('an orphan adopted as the live main is untracked and survives the next, constrained pass', async () => {
    const list = [definition([cycle(at(16))])];
    const os = osFor(list);
    // The stored main vanished; an earlier failed rollback left this one tracked.
    os.entries.delete(`main-${at(16)}`);
    os.add({
      id: 'orphan-main',
      owned: { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, alarmId: 'alarm-1', cycleId: `cycle-${at(16)}` },
      atMs: at(16),
    });
    // The release pass cannot cancel it, so it stays pending and gets adopted.
    os.failCancel.add('orphan-main');
    const first = harness(os);
    first.orphanIds.add('orphan-main');
    const out = await first.run(list);
    assert.equal(out.alarms[0].cycles[0].mainAlarmId, 'orphan-main');
    assert.ok(os.entries.has('orphan-main'));
    assert.deepEqual([...first.orphanIds], []);

    // Worst case replayed: still tracked, now live, no permission, queue full.
    os.addForeign(NOTIFICATION_QUEUE_CAPACITY - os.entries.size);
    const second = harness(os);
    second.orphanIds.add('orphan-main');
    const again = await second.run(out.alarms, { canSchedule: false });
    assert.ok(os.entries.has('orphan-main'), 'the live main must be retained');
    assert.ok(!second.calls.includes('cancel:orphan-main'));
    assert.deepEqual([...second.orphanIds], [], 'a live id is dropped from tracking');
    assert.notEqual(again.statuses['alarm-1'], 'missing');
  });

  test('a tracked id that is a live check-in is retained as well', async () => {
    const list = [definition([cycle(at(16))])];
    const os = osFor(list);
    const h = harness(os);
    h.orphanIds.add(`checkin-${at(16)}`);
    await h.run(list, { canSchedule: false });
    assert.ok(os.entries.has(`checkin-${at(16)}`));
    assert.deepEqual([...h.orphanIds], []);
  });

  test('a check-in adopted while its release failed is untracked', async () => {
    const list = [definition([cycle(at(16))])];
    const os = osFor(list);
    os.entries.delete(`checkin-${at(16)}`);
    os.add({
      id: 'orphan-checkin',
      owned: { owner: ALREADY_UP_OWNER, kind: CHECK_IN_KIND, alarmId: 'alarm-1', cycleId: `cycle-${at(16)}`, mainAlarmId: `main-${at(16)}` },
      atMs: getCheckInAtMs(at(16), list[0].cycles[0].armedAtMs),
    });
    os.failCancel.add('orphan-checkin'); // release fails, so it is adopted instead
    const h = harness(os);
    h.orphanIds.add('orphan-checkin');
    const out = await h.run(list);
    assert.equal(out.alarms[0].cycles[0].checkInNotificationId, 'orphan-checkin');
    assert.deepEqual([...h.orphanIds], []);
  });
});

describe('strict ownership: lookup of a stored id is lenient, discovery is not', () => {
  const list = () => [definition([cycle(at(16))])];
  const cycleId = `cycle-${at(16)}`;

  test('a stored id whose content predates the owner marker still verifies', async () => {
    const alarms = list();
    const os = osFor(alarms);
    os.entries.get(`main-${at(16)}`)!.owned = { kind: MAIN_ALARM_KIND, alarmId: 'alarm-1', cycleId };
    const out = await harness(os).run(alarms);
    assert.equal(out.statuses['alarm-1'], 'verified');
  });

  test('a stored id carrying another owner marker is foreign', async () => {
    const alarms = list();
    const os = osFor(alarms);
    os.entries.get(`main-${at(16)}`)!.owned = { owner: 'other-app/v9', kind: MAIN_ALARM_KIND, alarmId: 'alarm-1', cycleId };
    const h = harness(os);
    const out = await h.run(alarms);
    assert.equal(out.statuses['alarm-1'], 'unverified');
    assert.deepEqual(h.calls, []);
  });

  test('an unmarked untracked notification of the same occurrence is not adopted', async () => {
    const alarms = list();
    const os = osFor(alarms);
    os.entries.delete(`main-${at(16)}`);
    os.add({ id: 'unmarked', owned: { kind: MAIN_ALARM_KIND, alarmId: 'alarm-1', cycleId }, atMs: at(16) });
    const h = harness(os);
    const out = await h.run(alarms);
    assert.notEqual(out.alarms[0].cycles[0].mainAlarmId, 'unmarked');
    assert.equal(mainCallsOf(h.calls).length, 1, 'a fresh main is scheduled instead');
    assert.ok(os.entries.has('unmarked'), 'the ambiguous entry is preserved');
  });

  test('a marked untracked notification without an alarm id is not adopted', async () => {
    const alarms = list();
    const os = osFor(alarms);
    os.entries.delete(`main-${at(16)}`);
    os.add({ id: 'no-alarm', owned: { owner: ALREADY_UP_OWNER, kind: MAIN_ALARM_KIND, cycleId }, atMs: at(16) });
    const h = harness(os);
    const out = await h.run(alarms);
    assert.notEqual(out.alarms[0].cycles[0].mainAlarmId, 'no-alarm');
    assert.ok(os.entries.has('no-alarm'));
  });

  test('a tracked orphan with only generic kind/shape content is released, never cancelled', async () => {
    const alarms = list();
    const os = osFor(alarms);
    os.add({ id: 'shape-only', owned: { kind: MAIN_ALARM_KIND, alarmId: 'alarm-9', cycleId: 'x' }, atMs: at(20) });
    const h = harness(os);
    h.orphanIds.add('shape-only');
    await h.run(alarms);
    assert.ok(!h.calls.includes('cancel:shape-only'));
    assert.ok(os.entries.has('shape-only'));
    assert.deepEqual([...h.orphanIds], []);
  });

  test('a marked orphan missing its identity is not cancelled either', async () => {
    const alarms = list();
    const os = osFor(alarms);
    os.add({ id: 'half', owned: { owner: ALREADY_UP_OWNER, kind: CHECK_IN_KIND, alarmId: 'alarm-9', cycleId: 'x' }, atMs: at(20) });
    const h = harness(os);
    h.orphanIds.add('half');
    await h.run(alarms);
    assert.ok(!h.calls.includes('cancel:half'));
    assert.ok(os.entries.has('half'));
  });
});

describe('an unreadable orphan journal fails closed', () => {
  test('nothing is scheduled or cancelled and the outcome says the journal is unreadable', async () => {
    const alarms = [definition([cycle(at(16))])];
    const os = osFor(alarms);
    os.entries.delete(`main-${at(16)}`);
    const h = harness(os, { orphansFail: true });
    const out = await h.run(alarms);
    assert.equal(out.orphansUnreadable, true);
    assert.deepEqual(h.calls, []);
    assert.notEqual(out.statuses['alarm-1'], 'repaired');
  });

  test('a readable journal reports it normally', async () => {
    const alarms = [definition([cycle(at(16))])];
    const out = await harness(osFor(alarms)).run(alarms);
    assert.equal(out.orphansUnreadable, false);
  });
});
