/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AlarmEditError,
  MAX_PENDING_NOTIFICATIONS,
  editAlarmDefinition,
  isPendingAlarmEdit,
  recoverPendingAlarmEdit,
  resolveEditedRepeat,
  type AlarmEditGateway,
  type AlarmEditJournal,
  type PendingAlarmEdit,
} from '../src/alarmEdit';
import { getCheckInAtMs } from '../src/alarmPolicy';
import { makeAlarmRepeat } from '../src/alarmSchedule';
import type {
  AlarmPhase,
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime(); // Thu 10/15 12:00
const DAY = 24 * 60 * 60_000;

function cycle(
  alarmId: string,
  index: number,
  phase: AlarmPhase = 'armed',
  dueAtMs = NOW + index * DAY,
): StoredAlarm {
  return {
    alarmId,
    cycleId: `${alarmId}-cycle-${index}`,
    mainAlarmId: `${alarmId}-main-${index}`,
    checkInNotificationId: `${alarmId}-check-${index}`,
    armedAtMs: NOW - 1_000,
    dueAtMs,
    phase,
    stepCount: 42,
    stepCountFromMs: NOW - 5_000,
    stepCandidateRecorded: false,
  };
}

function definition(
  id: string,
  extra: Partial<StoredAlarmDefinition> = {},
): StoredAlarmDefinition {
  return {
    id,
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', NOW),
    enabled: true,
    createdAtMs: NOW - DAY,
    cycles: [1, 2, 3].map((index) => cycle(id, index)),
    ...extra,
  };
}

interface Harness {
  events: string[];
  scheduled: Set<string>;
  gateway: AlarmEditGateway;
  journal: AlarmEditJournal;
  journalEntries: Map<string, PendingAlarmEdit>;
  saved: StoredAlarmDefinition[][];
  failMainAt?: number;
  failCancel: Set<string>;
  failJournalSave?: (entry: PendingAlarmEdit) => boolean;
  failCheckpointTimes: number;
  /** Fake wall clock handed to the edit as `now()`. */
  clock: number;
  /** Runs `act` right after the first event matching `when`. */
  after(when: (event: string) => boolean, act: () => void): void;
  /** Throws from scheduleMain after the OS accepted it (unknown outcome). */
  throwAfterCreate?: (identifier: string) => boolean;
  /** Highest number of pending notifications ever observed. */
  maxPending: number;
  /** Requested ids that were not durable in the journal before scheduling. */
  unjournaledRequests: string[];
  input: (
    alarms: StoredAlarmDefinition[],
    overrides?: Partial<Parameters<typeof editAlarmDefinition>[0]>,
  ) => Parameters<typeof editAlarmDefinition>[0];
}

function harness(initial: StoredAlarmDefinition[], hostCount = 0): Harness {
  const scheduled = new Set<string>();
  for (const alarm of initial) {
    for (const c of alarm.cycles) {
      scheduled.add(c.mainAlarmId);
      if (c.checkInNotificationId) scheduled.add(c.checkInNotificationId);
    }
  }
  for (let index = 0; index < hostCount; index += 1) {
    scheduled.add(`host-${index}`);
  }
  const journalEntries = new Map<string, PendingAlarmEdit>();
  let mainCount = 0;
  let newIndex = 0;
  const rules: Array<{ when: (event: string) => boolean; act: () => void }> =
    [];
  const emit = (event: string): void => {
    h.events.push(event);
    h.maxPending = Math.max(h.maxPending, scheduled.size);
    const index = rules.findIndex((rule) => rule.when(event));
    if (index >= 0) {
      rules.splice(index, 1)[0].act();
    }
  };
  const create = (identifier: string | undefined, prefix: string): string => {
    const id = identifier ?? `${prefix}-${(newIndex += 1)}`;
    if (identifier) {
      const journaled = [...journalEntries.values()].some((entry) =>
        entry.newNotificationIds.includes(identifier),
      );
      if (!journaled) {
        h.unjournaledRequests.push(identifier);
      }
    }
    scheduled.add(id);
    return id;
  };
  const h: Harness = {
    events: [],
    scheduled,
    journalEntries,
    saved: [],
    failCancel: new Set(),
    failCheckpointTimes: 0,
    clock: NOW,
    maxPending: scheduled.size,
    unjournaledRequests: [],
    after(when, act) {
      rules.push({ when, act });
    },
    gateway: {
      async scheduleMain(request) {
        mainCount += 1;
        if (h.failMainAt === mainCount) {
          throw new Error('main schedule failed');
        }
        const id = create(request.identifier, 'new-main');
        emit(`schedule:${id}`);
        if (request.identifier && h.throwAfterCreate?.(request.identifier)) {
          throw new Error('schedule outcome unknown');
        }
        return id;
      },
      async scheduleCheckIn(request) {
        const id = create(request.identifier, 'new-check');
        emit(`schedule:${id}`);
        return id;
      },
      async cancelScheduled(id) {
        if (h.failCancel.has(id)) {
          throw new Error(`cancel failed ${id}`);
        }
        scheduled.delete(id);
        emit(`cancel:${id}`);
      },
      async listScheduledIds() {
        return new Set(scheduled);
      },
    },
    journal: {
      async load() {
        return [...journalEntries.values()];
      },
      async save(entry) {
        if (h.failJournalSave?.(entry)) {
          throw new Error('journal write failed');
        }
        journalEntries.set(entry.alarmId, structuredClone(entry));
        emit(`journal:${entry.stage}`);
      },
      async remove(alarmId) {
        journalEntries.delete(alarmId);
        emit('journal:removed');
      },
    },
    input: (alarms, overrides = {}) => ({
      alarms,
      alarmId: 'a1',
      hour: 6,
      minute: 30,
      repeat: makeAlarmRepeat('weekdays', NOW),
      now: () => h.clock,
      gateway: h.gateway,
      journal: h.journal,
      async checkpoint(next) {
        if (h.failCheckpointTimes > 0) {
          h.failCheckpointTimes -= 1;
          throw new Error('save failed');
        }
        h.saved.push(structuredClone(next));
      },
      async hasUnsettledWork() {
        return false;
      },
      makeCycleId: (() => {
        let n = 0;
        return () => `new-cycle-${(n += 1)}`;
      })(),
      ...overrides,
    }),
  };
  return h;
}

const OLD_IDS = (id: string) =>
  [1, 2, 3].flatMap((index) => [`${id}-main-${index}`, `${id}-check-${index}`]);
const NEW_MAINS = [1, 2, 3].map((index) => `new-cycle-${index}-main`);
const NEW_CHECKINS = [1, 2, 3].map((index) => `new-cycle-${index}-checkin`);
const cancelledIds = (events: string[]) =>
  events
    .filter((event) => event.startsWith('cancel:'))
    .map((event) => event.slice('cancel:'.length));
const newIdsLeft = (scheduled: Set<string>) =>
  [...scheduled].filter((id) => id.startsWith('new-'));

describe('editAlarmDefinition', () => {
  test('stages the replacement mains, then replaces the old ids, then adds check-ins', async () => {
    const a1 = definition('a1');
    const a2 = definition('a2');
    const h = harness([a1, a2]);

    const result = await editAlarmDefinition(h.input([a1, a2]));

    const order = h.events.filter(
      (event) => event.startsWith('schedule:') || event.startsWith('cancel:'),
    );
    assert.deepEqual(order, [
      ...NEW_MAINS.map((id) => `schedule:${id}`),
      ...[1, 2, 3].map((index) => `cancel:a1-main-${index}`),
      ...[1, 2, 3].map((index) => `cancel:a1-check-${index}`),
      ...NEW_CHECKINS.map((id) => `schedule:${id}`),
    ]);
    for (const id of OLD_IDS('a2')) {
      assert.ok(h.scheduled.has(id), `${id} must stay scheduled`);
    }

    const edited = result.alarms.find((alarm) => alarm.id === 'a1')!;
    assert.equal(edited.hour, 6);
    assert.equal(edited.minute, 30);
    assert.equal(edited.repeat.kind, 'weekdays');
    assert.equal(edited.enabled, true);
    assert.deepEqual(
      edited.cycles.map((c) => c.mainAlarmId),
      NEW_MAINS,
    );
    assert.deepEqual(
      edited.cycles.map((c) => c.checkInNotificationId),
      NEW_CHECKINS,
    );
    assert.ok(edited.cycles.every((c) => c.stepCount === 0));
    assert.ok(edited.cycles.every((c) => c.stepCountFromMs === undefined));
    assert.ok(edited.cycles.every((c) => c.phase === 'armed'));
    assert.deepEqual(
      result.alarms.find((alarm) => alarm.id === 'a2'),
      a2,
    );
    assert.equal(result.cleanupPending, false);
    assert.deepEqual(result.issues, []);
    assert.equal(h.journalEntries.size, 0);
    assert.deepEqual(h.saved.at(-1), result.alarms);
  });

  test('journals the old ids before scheduling and the new ids before cancelling', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    await editAlarmDefinition(h.input([a1]));

    assert.equal(h.events[0], 'journal:scheduling');
    const replacing = h.events.indexOf('journal:replacing');
    const firstCancel = h.events.findIndex((event) => event.startsWith('cancel:'));
    assert.ok(replacing > 0 && replacing < firstCancel);
  });

  test('records every requested id in the journal before the OS call that may create it', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const snapshots: PendingAlarmEdit[] = [];
    const original = h.journal.save;
    h.journal.save = async (entry) => {
      snapshots.push(structuredClone(entry));
      await original(entry);
    };
    await editAlarmDefinition(h.input([a1]));

    assert.deepEqual(h.unjournaledRequests, []);
    const first = snapshots[0];
    assert.equal(first.stage, 'scheduling');
    assert.deepEqual([...first.oldNotificationIds].sort(), OLD_IDS('a1').sort());
    assert.deepEqual(first.newNotificationIds, []);
    assert.deepEqual(snapshots[1].newNotificationIds, [NEW_MAINS[0]]);
    const replacing = snapshots.find((entry) => entry.stage === 'replacing')!;
    assert.deepEqual(
      [...replacing.newNotificationIds].sort(),
      [...NEW_MAINS, ...NEW_CHECKINS].sort(),
    );
    assert.equal(replacing.newCycles.length, 3);
    assert.equal(replacing.hour, 6);
  });

  test('refuses before touching anything when the new mains cannot fit the 64-slot budget', async () => {
    const a1 = definition('a1');
    const full = harness([a1], MAX_PENDING_NOTIFICATIONS - 6 - 2);
    assert.equal(full.scheduled.size, 62);
    await assert.rejects(
      editAlarmDefinition(full.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError &&
        error.code === 'capacity' &&
        error.rolledBack,
    );
    assert.equal(full.events.length, 0);
    assert.equal(full.journalEntries.size, 0);
    assert.equal(full.scheduled.size, 62);

    const fits = harness([a1], MAX_PENDING_NOTIFICATIONS - 6 - 3);
    await editAlarmDefinition(fits.input([a1]));
    assert.ok(fits.maxPending <= MAX_PENDING_NOTIFICATIONS);
  });

  test('edits one of ten alarms when the queue holds 60 notifications', async () => {
    const alarms = Array.from({ length: 10 }, (_, index) =>
      definition(`a${index + 1}`),
    );
    const h = harness(alarms);
    assert.equal(h.scheduled.size, 60);

    const result = await editAlarmDefinition(h.input(alarms));

    assert.ok(h.maxPending <= MAX_PENDING_NOTIFICATIONS);
    assert.equal(h.scheduled.size, 60);
    assert.deepEqual(result.issues, []);
    const edited = result.alarms.find((alarm) => alarm.id === 'a1')!;
    assert.deepEqual(
      edited.cycles.map((c) => c.checkInNotificationId),
      NEW_CHECKINS,
    );
    for (const alarm of alarms.slice(1)) {
      for (const id of OLD_IDS(alarm.id)) {
        assert.ok(h.scheduled.has(id));
      }
    }
  });

  test('skips only check-ins, never a main, when other notifications fill the queue meanwhile', async () => {
    const alarms = Array.from({ length: 10 }, (_, index) =>
      definition(`a${index + 1}`),
    );
    const h = harness(alarms);
    h.after(
      (event) => event === 'cancel:a1-check-3',
      () => {
        for (let index = 0; index < 6; index += 1) {
          h.scheduled.add(`late-host-${index}`);
        }
      },
    );

    const result = await editAlarmDefinition(h.input(alarms));

    assert.ok(h.maxPending <= MAX_PENDING_NOTIFICATIONS);
    for (const id of NEW_MAINS) {
      assert.ok(h.scheduled.has(id), `${id} must stay scheduled`);
    }
    const edited = result.alarms.find((alarm) => alarm.id === 'a1')!;
    assert.equal(edited.cycles.length, 3);
    assert.equal(
      edited.cycles.filter((c) => c.checkInNotificationId).length,
      1,
    );
    assert.equal(
      result.issues.filter((issue) => issue.kind === 'check_in_schedule_failed')
        .length,
      2,
    );
    assert.equal(h.journalEntries.size, 0);
  });

  test('skips check-ins with a warning when the queue size cannot be read after the old slots are freed', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const original = h.gateway.listScheduledIds;
    let calls = 0;
    h.gateway.listScheduledIds = async () => {
      calls += 1;
      if (calls > 1) throw new Error('queue unreadable');
      return original();
    };

    const result = await editAlarmDefinition(h.input([a1]));

    for (const id of NEW_MAINS) {
      assert.ok(h.scheduled.has(id), `${id} must stay scheduled`);
    }
    for (const id of NEW_CHECKINS) {
      assert.ok(!h.scheduled.has(id), `${id} must not be scheduled`);
    }
    assert.ok(
      result.alarms[0].cycles.every((c) => c.checkInNotificationId === undefined),
    );
    assert.equal(result.alarms[0].cycles.length, 3);
    assert.equal(
      result.issues.filter((i) => i.kind === 'check_in_schedule_failed').length,
      3,
    );
  });

  test('a failed check-in schedule is a warning, not a failed edit', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const original = h.gateway.scheduleCheckIn;
    h.gateway.scheduleCheckIn = async (request) => {
      if (request.cycleId === 'new-cycle-2') {
        throw new Error('check-in failed');
      }
      return original(request);
    };

    const result = await editAlarmDefinition(h.input([a1]));

    assert.deepEqual(
      result.alarms[0].cycles.map((c) => c.checkInNotificationId),
      [NEW_CHECKINS[0], undefined, NEW_CHECKINS[2]],
    );
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].kind, 'check_in_schedule_failed');
  });

  test('a failed schedule cancels the new ids and keeps the old alarm armed', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.failMainAt = 2;

    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError &&
        error.code === 'schedule_failed' &&
        error.rolledBack,
    );
    for (const id of OLD_IDS('a1')) {
      assert.ok(h.scheduled.has(id), `${id} must stay scheduled`);
    }
    assert.deepEqual(newIdsLeft(h.scheduled), []);
    assert.equal(h.saved.length, 0);
    assert.equal(h.journalEntries.size, 0);
  });

  test('cancels a requested id whose scheduling call failed after the OS accepted it', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.throwAfterCreate = (identifier) => identifier === NEW_MAINS[1];

    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError && error.code === 'schedule_failed',
    );
    assert.deepEqual(newIdsLeft(h.scheduled), []);
    for (const id of OLD_IDS('a1')) {
      assert.ok(h.scheduled.has(id));
    }
  });

  test('a journal failure before a new main is requested schedules nothing more', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.failJournalSave = (entry) =>
      entry.stage === 'scheduling' && entry.newNotificationIds.length === 2;

    await assert.rejects(editAlarmDefinition(h.input([a1])), AlarmEditError);
    for (const id of OLD_IDS('a1')) {
      assert.ok(h.scheduled.has(id));
    }
    assert.deepEqual(newIdsLeft(h.scheduled), []);
    assert.deepEqual(h.unjournaledRequests, []);
    assert.equal(h.saved.length, 0);
  });

  test('a failed first main cancellation rolls back with the old alarm completely unchanged', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    for (const index of [1, 2, 3]) {
      h.failCancel.add(`a1-main-${index}`);
    }

    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError &&
        error.code === 'cancel_failed' &&
        error.rolledBack,
    );
    for (const id of OLD_IDS('a1')) {
      assert.ok(h.scheduled.has(id), `${id} must be untouched`);
    }
    assert.deepEqual(cancelledIds(h.events).filter((id) => id.startsWith('a1-')), []);
    assert.deepEqual(newIdsLeft(h.scheduled), []);
    assert.equal(h.saved.length, 0);
    assert.equal(h.journalEntries.size, 0);
  });

  test('a cancel that threw but really removed the old main is treated as removed', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const original = h.gateway.cancelScheduled;
    h.gateway.cancelScheduled = async (id) => {
      await original(id);
      if (id === 'a1-main-1') {
        throw new Error('lost response');
      }
    };

    const result = await editAlarmDefinition(h.input([a1]));

    assert.deepEqual(
      result.alarms[0].cycles.map((c) => c.mainAlarmId),
      NEW_MAINS,
    );
    for (const id of NEW_MAINS) {
      assert.ok(h.scheduled.has(id));
    }
  });

  test('a cancel failure after an old main is gone rolls forward and keeps the rest journaled', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.failCancel.add('a1-main-3');

    const result = await editAlarmDefinition(h.input([a1]));

    assert.equal(result.cleanupPending, true);
    const edited = result.alarms[0];
    assert.equal(edited.hour, 6);
    // The uncancelled old cycle stays tracked beside the three new ones.
    assert.deepEqual(
      edited.cycles.filter((c) => !c.cycleId.startsWith('new-cycle-')).map((c) => c.mainAlarmId),
      ['a1-main-3'],
    );
    const entry = h.journalEntries.get('a1')!;
    assert.equal(entry.stage, 'replacing');
    assert.deepEqual(entry.oldNotificationIds, ['a1-main-3']);
    assert.ok(h.scheduled.has('a1-main-3'));
  });

  test('is locked at run time when an old cycle came due while the edit waited for its locks', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.clock = a1.cycles[0].dueAtMs + 1;

    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError &&
        error.code === 'locked' &&
        error.rolledBack,
    );
    assert.equal(h.events.length, 0);
  });

  test('aborts and removes the replacement when the old cycle comes due while scheduling', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.after(
      (event) => event === `schedule:${NEW_MAINS[2]}`,
      () => {
        h.clock = a1.cycles[0].dueAtMs + 1;
      },
    );

    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError &&
        error.code === 'deadline' &&
        error.rolledBack,
    );
    for (const id of OLD_IDS('a1')) {
      assert.ok(h.scheduled.has(id), `${id} must stay scheduled`);
    }
    assert.deepEqual(newIdsLeft(h.scheduled), []);
    assert.equal(h.saved.length, 0);
    assert.equal(h.journalEntries.size, 0);
  });

  test('aborts when the new first occurrence is no longer far enough ahead after scheduling', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const newFirstDue = new Date(2026, 9, 16, 6, 30).getTime();
    h.after(
      (event) => event === `schedule:${NEW_MAINS[2]}`,
      () => {
        h.clock = newFirstDue - 5_000;
      },
    );

    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError &&
        error.code === 'invalid_time' &&
        error.rolledBack,
    );
    assert.deepEqual(cancelledIds(h.events).filter((id) => id.startsWith('a1-')), []);
    assert.deepEqual(newIdsLeft(h.scheduled), []);
    assert.equal(h.saved.length, 0);
  });

  test('never cancels or drops an old cycle that came due during partial cancellation', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const second = a1.cycles[1];
    h.after(
      (event) => event === 'cancel:a1-main-1',
      () => {
        h.clock = second.dueAtMs + 1;
      },
    );

    const result = await editAlarmDefinition(h.input([a1]));

    assert.ok(h.scheduled.has('a1-main-2'), 'the due main stays armed');
    assert.ok(!cancelledIds(h.events).includes('a1-check-2'));
    assert.ok(!h.scheduled.has('a1-main-1'));
    assert.ok(!h.scheduled.has('a1-main-3'));
    const cycles = result.alarms[0].cycles;
    const kept = cycles.find((c) => c.cycleId === second.cycleId)!;
    assert.deepEqual(kept, second);
    assert.deepEqual(
      cycles.filter((c) => c.cycleId !== second.cycleId).map((c) => c.mainAlarmId),
      NEW_MAINS,
    );
    assert.deepEqual(h.saved.at(-1), result.alarms);
    assert.equal(h.journalEntries.size, 0);
  });

  test('drops an old cycle whose main was cancelled in time even if its time passes before the final save', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const third = a1.cycles[2];
    h.after(
      (event) => event === 'cancel:a1-check-3',
      () => {
        h.clock = third.dueAtMs + 1;
      },
    );

    const result = await editAlarmDefinition(h.input([a1]));

    // Its main was cancelled while it was still in the future, so it is gone.
    assert.ok(!result.alarms[0].cycles.some((c) => c.cycleId === third.cycleId));
  });

  test('is locked while any alarm is ringing or due', async () => {
    const a1 = definition('a1');
    const ringing = definition('a2', {
      cycles: [cycle('a2', 1, 'ringing', NOW - 1_000)],
    });
    const h = harness([a1, ringing]);
    await assert.rejects(
      editAlarmDefinition(h.input([a1, ringing])),
      (error: unknown) =>
        error instanceof AlarmEditError && error.code === 'locked',
    );

    const due = definition('a3', {
      cycles: [cycle('a3', 1, 'armed', NOW - 1)],
    });
    await assert.rejects(
      editAlarmDefinition(h.input([a1, due])),
      (error: unknown) =>
        error instanceof AlarmEditError && error.code === 'locked',
    );
    assert.equal(h.events.length, 0);
  });

  test('refuses while a stop for the same alarm is unsettled', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const seen: Array<[string, string[]]> = [];
    await assert.rejects(
      editAlarmDefinition(
        h.input([a1], {
          async hasUnsettledWork(alarmId, cycleIds) {
            seen.push([alarmId, cycleIds]);
            return true;
          },
        }),
      ),
      (error: unknown) =>
        error instanceof AlarmEditError && error.code === 'unsettled',
    );
    assert.deepEqual(seen, [['a1', ['a1-cycle-1', 'a1-cycle-2', 'a1-cycle-3']]]);
    assert.equal(h.events.length, 0);
  });

  test('refuses while an earlier edit of the same alarm is unfinished', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.journalEntries.set('a1', {
      alarmId: 'a1',
      stage: 'scheduling',
      requestedAtMs: NOW,
      hour: 5,
      minute: 0,
      repeat: makeAlarmRepeat('daily', NOW),
      oldNotificationIds: [],
      newNotificationIds: ['x'],
      newCycles: [],
    });
    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError && error.code === 'unsettled',
    );
    assert.equal(h.events.length, 0);
  });

  test('rejects a today-only time that has already passed without changes', async () => {
    const a1 = definition('a1', {
      repeat: makeAlarmRepeat('today', NOW),
      cycles: [cycle('a1', 1, 'armed', NOW + 3_600_000)],
    });
    const h = harness([a1]);
    await assert.rejects(
      editAlarmDefinition(
        h.input([a1], {
          hour: 11,
          minute: 0,
          repeat: a1.repeat,
        }),
      ),
      (error: unknown) =>
        error instanceof AlarmEditError && error.code === 'invalid_time',
    );
    assert.equal(h.events.length, 0);
  });

  test('keeps the original date of a today-only alarm and schedules one cycle', async () => {
    const a1 = definition('a1', {
      repeat: makeAlarmRepeat('today', NOW),
      cycles: [cycle('a1', 1, 'armed', NOW + 3_600_000)],
    });
    const h = harness([a1]);
    const result = await editAlarmDefinition(
      h.input([a1], { hour: 20, minute: 15, repeat: a1.repeat }),
    );
    const edited = result.alarms[0];
    assert.deepEqual(edited.repeat, a1.repeat);
    assert.equal(edited.cycles.length, 1);
    assert.equal(
      edited.cycles[0].dueAtMs,
      new Date(2026, 9, 15, 20, 15).getTime(),
    );
  });

  test('edits a disabled alarm without scheduling or cancelling anything', async () => {
    const off = definition('a1', {
      enabled: false,
      cycles: [],
      repeat: makeAlarmRepeat('today', NOW - 3 * DAY),
    });
    const h = harness([off]);
    const result = await editAlarmDefinition(
      h.input([off], { hour: 5, minute: 5, repeat: off.repeat }),
    );
    assert.equal(h.events.length, 0);
    const edited = result.alarms[0];
    assert.equal(edited.enabled, false);
    assert.equal(edited.hour, 5);
    assert.deepEqual(edited.repeat, off.repeat);
    assert.deepEqual(edited.cycles, []);
    assert.equal(h.saved.length, 1);
  });

  test('keeps the journal when the final save fails twice, then recovery finishes it', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.failCheckpointTimes = 2;

    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError &&
        error.code === 'save_failed' &&
        !error.rolledBack,
    );
    const entry = h.journalEntries.get('a1')!;
    assert.equal(entry.stage, 'replacing');
    assert.deepEqual(entry.oldNotificationIds, []);

    const recovered = await recoverPendingAlarmEdit({
      alarms: [a1],
      entry,
      gateway: h.gateway,
      journal: h.journal,
      now: () => h.clock,
      checkpoint: async (next) => {
        h.saved.push(structuredClone(next));
      },
    });
    assert.equal(recovered[0].hour, 6);
    assert.equal(recovered[0].cycles.length, 3);
    assert.equal(h.journalEntries.size, 0);
  });

  test('reports an incomplete rollback and keeps the new ids for retry', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.failMainAt = 2;
    h.failCancel.add(NEW_MAINS[0]);

    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError &&
        error.code === 'rollback_incomplete' &&
        !error.rolledBack,
    );
    const entry = h.journalEntries.get('a1')!;
    assert.equal(entry.stage, 'scheduling');
    assert.deepEqual(entry.newNotificationIds, [NEW_MAINS[0]]);
  });
});

describe('recoverPendingAlarmEdit', () => {
  const entryBase: PendingAlarmEdit = {
    alarmId: 'a1',
    stage: 'scheduling',
    requestedAtMs: NOW,
    hour: 6,
    minute: 30,
    repeat: makeAlarmRepeat('weekdays', NOW),
    oldNotificationIds: OLD_IDS('a1'),
    newNotificationIds: ['new-main-1', 'new-check-2'],
    newCycles: [],
  };

  test('a crash while scheduling cancels the partial new ids and leaves the old alarm', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.scheduled.add('new-main-1');
    h.scheduled.add('new-check-2');
    h.journalEntries.set('a1', entryBase);
    const saved: StoredAlarmDefinition[][] = [];

    const result = await recoverPendingAlarmEdit({
      alarms: [a1],
      entry: entryBase,
      gateway: h.gateway,
      journal: h.journal,
      checkpoint: async (next) => void saved.push(next),
    });

    assert.deepEqual(result, [a1]);
    assert.equal(saved.length, 0);
    assert.ok(!h.scheduled.has('new-main-1') && !h.scheduled.has('new-check-2'));
    for (const id of OLD_IDS('a1')) {
      assert.ok(h.scheduled.has(id));
    }
    assert.equal(h.journalEntries.size, 0);
  });

  test('a crash while replacing applies the new cycles and cancels the remaining old ids', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const newCycles = [cycle('a1', 7), cycle('a1', 8)];
    for (const c of newCycles) {
      h.scheduled.add(c.mainAlarmId);
      h.scheduled.add(c.checkInNotificationId!);
    }
    const entry: PendingAlarmEdit = {
      ...entryBase,
      stage: 'replacing',
      oldNotificationIds: ['a1-main-1'],
      newNotificationIds: newCycles.flatMap((c) => [
        c.mainAlarmId,
        c.checkInNotificationId!,
      ]),
      newCycles,
    };
    h.journalEntries.set('a1', entry);

    const result = await recoverPendingAlarmEdit({
      alarms: [a1],
      entry,
      gateway: h.gateway,
      journal: h.journal,
      checkpoint: async (next) => void h.saved.push(next),
    });

    assert.equal(result[0].hour, 6);
    assert.equal(result[0].enabled, true);
    assert.deepEqual(result[0].cycles, newCycles);
    assert.ok(!h.scheduled.has('a1-main-1'));
    assert.equal(h.journalEntries.size, 0);
  });

  test('keeps the journal when a remaining old id still cannot be cancelled', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.failCancel.add('a1-main-1');
    const entry: PendingAlarmEdit = {
      ...entryBase,
      stage: 'replacing',
      oldNotificationIds: ['a1-main-1', 'a1-check-1'],
      newNotificationIds: [],
      newCycles: [cycle('a1', 7)],
    };
    h.journalEntries.set('a1', entry);

    await assert.rejects(
      recoverPendingAlarmEdit({
        alarms: [a1],
        entry,
        gateway: h.gateway,
        journal: h.journal,
        checkpoint: async (next) => void h.saved.push(next),
      }),
      AlarmEditError,
    );
    assert.deepEqual(h.journalEntries.get('a1')!.oldNotificationIds, [
      'a1-main-1',
    ]);
  });

  test('does not cancel or drop an old cycle that is already due when it settles the edit', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const newCycles = [cycle('a1', 7), cycle('a1', 8)];
    const entry: PendingAlarmEdit = {
      ...entryBase,
      stage: 'replacing',
      oldNotificationIds: ['a1-main-1', 'a1-check-1', 'a1-main-2'],
      newNotificationIds: newCycles.map((c) => c.mainAlarmId),
      newCycles,
    };
    h.journalEntries.set('a1', entry);
    h.clock = a1.cycles[0].dueAtMs + 1;

    const result = await recoverPendingAlarmEdit({
      alarms: [a1],
      entry,
      gateway: h.gateway,
      journal: h.journal,
      now: () => h.clock,
      checkpoint: async (next) => void h.saved.push(next),
    });

    assert.ok(h.scheduled.has('a1-main-1') && h.scheduled.has('a1-check-1'));
    assert.ok(!h.scheduled.has('a1-main-2'));
    assert.deepEqual(
      result[0].cycles.map((c) => c.cycleId).sort(),
      [a1.cycles[0].cycleId, ...newCycles.map((c) => c.cycleId)].sort(),
    );
    assert.deepEqual(
      result[0].cycles.find((c) => c.cycleId === a1.cycles[0].cycleId),
      a1.cycles[0],
    );
    assert.equal(h.journalEntries.size, 0);
  });

  test('drops check-in ids that never reached the OS before the crash', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const newCycles = [cycle('a1', 7), cycle('a1', 8)];
    h.scheduled.add(newCycles[0].mainAlarmId);
    h.scheduled.add(newCycles[1].mainAlarmId);
    h.scheduled.add(newCycles[0].checkInNotificationId!);
    const entry: PendingAlarmEdit = {
      ...entryBase,
      stage: 'replacing',
      oldNotificationIds: [],
      newNotificationIds: [],
      newCycles,
    };
    h.journalEntries.set('a1', entry);

    const result = await recoverPendingAlarmEdit({
      alarms: [a1],
      entry,
      gateway: h.gateway,
      journal: h.journal,
      now: () => h.clock,
      checkpoint: async (next) => void h.saved.push(next),
    });

    assert.equal(
      result[0].cycles[0].checkInNotificationId,
      newCycles[0].checkInNotificationId,
    );
    assert.equal(result[0].cycles[1].checkInNotificationId, undefined);
  });

  test('cancels the replacement when its alarm no longer exists', async () => {
    const h = harness([]);
    const entry: PendingAlarmEdit = {
      ...entryBase,
      stage: 'replacing',
      oldNotificationIds: [],
      newNotificationIds: ['new-main-1'],
      newCycles: [cycle('a1', 7)],
    };
    h.scheduled.add('new-main-1');
    h.journalEntries.set('a1', entry);

    const result = await recoverPendingAlarmEdit({
      alarms: [],
      entry,
      gateway: h.gateway,
      journal: h.journal,
      checkpoint: async () => assert.fail('nothing to save'),
    });
    assert.deepEqual(result, []);
    assert.ok(!h.scheduled.has('new-main-1'));
    assert.equal(h.journalEntries.size, 0);
  });
});

describe('resolveEditedRepeat', () => {
  test('keeps the original date when a today-only alarm stays today-only', () => {
    const original = makeAlarmRepeat('today', NOW - 3 * DAY);
    assert.deepEqual(resolveEditedRepeat(original, 'today', [], NOW), original);
  });

  test('uses today for a newly chosen today-only repeat and builds the others', () => {
    const daily = makeAlarmRepeat('daily', NOW);
    assert.deepEqual(
      resolveEditedRepeat(daily, 'today', [], NOW),
      makeAlarmRepeat('today', NOW),
    );
    assert.deepEqual(
      resolveEditedRepeat(daily, 'custom', [3, 1], NOW),
      makeAlarmRepeat('custom', NOW, [1, 3]),
    );
  });
});

describe('isPendingAlarmEdit', () => {
  const valid: PendingAlarmEdit = {
    alarmId: 'a1',
    stage: 'replacing',
    requestedAtMs: NOW,
    hour: 6,
    minute: 30,
    repeat: makeAlarmRepeat('daily', NOW),
    oldNotificationIds: ['x'],
    newNotificationIds: ['y'],
    newCycles: [cycle('a1', 1)],
  };

  test('accepts a complete entry and rejects malformed ones', () => {
    assert.equal(isPendingAlarmEdit(valid), true);
    assert.equal(isPendingAlarmEdit({ ...valid, stage: 'done' }), false);
    assert.equal(isPendingAlarmEdit({ ...valid, hour: 24 }), false);
    assert.equal(isPendingAlarmEdit({ ...valid, repeat: { kind: 'x' } }), false);
    assert.equal(isPendingAlarmEdit({ ...valid, oldNotificationIds: [1] }), false);
    assert.equal(
      isPendingAlarmEdit({ ...valid, newCycles: [cycle('other', 1)] }),
      false,
    );
    assert.equal(isPendingAlarmEdit(null), false);
  });
});

describe('unconfirmed old cancellation and fresh check-in clock', () => {
  test('keeps an old main whose cancellation failed tracked before it is due', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.failCancel.add('a1-main-3');

    const result = await editAlarmDefinition(h.input([a1]));

    assert.equal(result.cleanupPending, true);
    const tracked = result.alarms[0].cycles.find(
      (c) => c.mainAlarmId === 'a1-main-3',
    );
    assert.ok(tracked, 'the uncancelled old cycle must stay in the definition');
    assert.deepEqual(h.saved.at(-1)![0].cycles.map((c) => c.mainAlarmId), [
      ...NEW_MAINS,
      'a1-main-3',
    ].sort((l, r) => {
      const due = (id: string) =>
        [...h.saved.at(-1)![0].cycles].find((c) => c.mainAlarmId === id)!.dueAtMs;
      return due(l) - due(r);
    }));
  });

  test('a failed old cancel then a deadline before restart leaves it tracked and ringing', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.failCancel.add('a1-main-3');
    const result = await editAlarmDefinition(h.input([a1]));
    const entry = h.journalEntries.get('a1')!;
    assert.deepEqual(entry.oldNotificationIds, ['a1-main-3']);

    h.clock = a1.cycles[2].dueAtMs + 1;
    const recovered = await recoverPendingAlarmEdit({
      alarms: result.alarms,
      entry,
      gateway: h.gateway,
      journal: h.journal,
      now: () => h.clock,
      checkpoint: async (next) => {
        h.saved.push(structuredClone(next));
      },
    });

    assert.ok(recovered[0].cycles.some((c) => c.mainAlarmId === 'a1-main-3'));
    assert.ok(h.scheduled.has('a1-main-3'));
    assert.deepEqual(
      cancelledIds(h.events).filter((id) => id === 'a1-main-3'),
      [],
    );
  });

  test('recovery before the deadline keeps it tracked while cancel still fails, then drops it', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    h.failCancel.add('a1-main-3');
    const result = await editAlarmDefinition(h.input([a1]));
    const entry = h.journalEntries.get('a1')!;
    const saved: StoredAlarmDefinition[][] = [];
    const recover = (alarms: StoredAlarmDefinition[]) =>
      recoverPendingAlarmEdit({
        alarms,
        entry: h.journalEntries.get('a1')!,
        gateway: h.gateway,
        journal: h.journal,
        now: () => h.clock,
        checkpoint: async (next) => {
          saved.push(structuredClone(next));
        },
      });

    await assert.rejects(
      recover(result.alarms),
      (error: unknown) =>
        error instanceof AlarmEditError && error.code === 'cancel_failed',
    );
    assert.equal(h.journalEntries.get('a1')!.oldNotificationIds[0], 'a1-main-3');
    assert.ok(
      (saved.at(-1) ?? result.alarms)[0].cycles.some(
        (c) => c.mainAlarmId === 'a1-main-3',
      ),
    );

    h.failCancel.clear();
    const final = await recover(result.alarms);
    assert.ok(final[0].cycles.every((c) => c.mainAlarmId !== 'a1-main-3'));
    assert.equal(h.journalEntries.size, 0);
    assert.equal(h.scheduled.has('a1-main-3'), false);
  });

  test('schedules each check-in after a freshly read clock, never in the past', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const requests: Array<{ at: number; clock: number }> = [];
    const original = h.gateway.scheduleCheckIn;
    h.gateway.scheduleCheckIn = async (request) => {
      requests.push({ at: request.checkInAtMs, clock: h.clock });
      return original(request);
    };
    // The first new cycle is due 06:30 next day; time passes while scheduling.
    h.after(
      (event) => event === `schedule:${NEW_MAINS[2]}`,
      () => {
        h.clock = NOW + 18 * 60 * 60_000 + 59 * 60_000 / 2 - 30_000;
      },
    );

    await editAlarmDefinition(h.input([a1]));

    assert.ok(requests.length < 3 || requests.length === 3);
    for (const request of requests) {
      assert.ok(request.at > request.clock, 'check-in must be in the future');
    }
  });
});

describe('PR40 review fixes', () => {
  const recoverInput = (
    h: Harness,
    alarms: StoredAlarmDefinition[],
    entry: PendingAlarmEdit,
    checkpoint: (next: StoredAlarmDefinition[]) => Promise<void>,
  ) => ({
    alarms,
    entry,
    gateway: h.gateway,
    journal: h.journal,
    now: () => h.clock,
    checkpoint,
  });

  test('recovery re-reads the clock per old cycle and spares one that became due during its awaits', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const newCycles = [cycle('a1', 7)];
    const entry: PendingAlarmEdit = {
      alarmId: 'a1',
      stage: 'replacing',
      requestedAtMs: NOW,
      hour: 6,
      minute: 30,
      repeat: makeAlarmRepeat('weekdays', NOW),
      oldNotificationIds: ['a1-main-1', 'a1-check-1', 'a1-main-2'],
      newNotificationIds: newCycles.map((c) => c.mainAlarmId),
      newCycles,
    };
    h.journalEntries.set('a1', entry);
    // Still in the future when recovery starts; due once the checkpoint ends.
    const result = await recoverPendingAlarmEdit(
      recoverInput(h, [a1], entry, async (next) => {
        h.saved.push(next);
        h.clock = a1.cycles[0].dueAtMs + 1;
      }),
    );

    assert.ok(h.scheduled.has('a1-main-1'), 'the newly due main is not cancelled');
    assert.ok(h.scheduled.has('a1-check-1'));
    assert.ok(!h.scheduled.has('a1-main-2'), 'a future cycle is still replaced');
    assert.deepEqual(
      result[0].cycles.find((c) => c.cycleId === a1.cycles[0].cycleId),
      a1.cycles[0],
    );
  });

  test('keeps a newly due old cycle journaled until the definition checkpoint, so a crash still tracks it', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const second = a1.cycles[1];
    h.after(
      (event) => event === 'cancel:a1-main-1',
      () => {
        h.clock = second.dueAtMs + 1;
      },
    );
    h.failCheckpointTimes = 2;

    await assert.rejects(
      editAlarmDefinition(h.input([a1])),
      (error: unknown) =>
        error instanceof AlarmEditError && error.code === 'save_failed',
    );

    const entry = h.journalEntries.get('a1')!;
    assert.ok(entry.oldNotificationIds.includes('a1-main-2'));
    assert.ok(entry.oldNotificationIds.includes('a1-check-2'));
    assert.ok(h.scheduled.has('a1-main-2'));

    // The disk still holds the old definition: recovery must keep cycle 2.
    const result = await recoverPendingAlarmEdit(
      recoverInput(h, [a1], entry, async (next) => void h.saved.push(next)),
    );
    assert.ok(h.scheduled.has('a1-main-2'));
    assert.deepEqual(
      result[0].cycles.find((c) => c.cycleId === second.cycleId),
      second,
    );
    assert.equal(h.journalEntries.size, 0);
  });

  test('schedules and persists the check-in from the same arm time', async () => {
    const a1 = definition('a1');
    const h = harness([a1]);
    const requests: number[] = [];
    const original = h.gateway.scheduleCheckIn;
    h.gateway.scheduleCheckIn = async (request) => {
      requests.push(request.checkInAtMs);
      return original(request);
    };
    h.after(
      (event) => event === `schedule:${NEW_MAINS[2]}`,
      () => {
        h.clock = NOW + 20_000;
      },
    );

    const result = await editAlarmDefinition(
      h.input([a1], { hour: 12, minute: 2, repeat: makeAlarmRepeat('daily', NOW) }),
    );

    const first = result.alarms[0].cycles.find(
      (c) => c.cycleId === 'new-cycle-1',
    )!;
    assert.equal(requests[0], getCheckInAtMs(first.dueAtMs, first.armedAtMs));
  });
});
