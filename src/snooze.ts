import type { StoredAlarm, StoredAlarmDefinition } from './alarmStorage';

/** Initial product default; fixed, not user-configurable. */
export const SNOOZE_INTERVAL_MS = 5 * 60_000;
export const SNOOZE_MAX_COUNT = 3;
/** iOS keeps at most 64 pending local notifications, other apps included. */
export const NOTIFICATION_CAPACITY = 64;

/**
 * Snooze state of one occurrence. It never changes `dueAtMs` of the cycle, so
 * the original wake-evidence deadline stays exactly where it was.
 */
export interface SnoozeRecord {
  /** Snoozes accepted so far for this occurrence. */
  count: number;
  /** Exact delivery ID of the current (or last) accepted snooze. */
  notificationId?: string;
  /** When that snooze is delivered. */
  dueAtMs?: number;
  /**
   * An attempt in progress: the ID is written before anything is scheduled so
   * a crash cannot leave a notification nobody remembers.
   */
  pending?: PendingSnooze;
}

export interface PendingSnooze {
  requestedId: string;
  dueAtMs: number;
  /**
   * IDs the system returned instead of the requested one and that could not
   * be cancelled yet; kept so a later recovery can still cancel them.
   */
  strayIds?: string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isSnoozeRecord(value: unknown): value is SnoozeRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<SnoozeRecord>;
  const pending = record.pending;
  return (
    Number.isInteger(record.count) &&
    record.count! >= 0 &&
    record.count! <= SNOOZE_MAX_COUNT &&
    (record.notificationId === undefined ||
      isNonEmptyString(record.notificationId)) &&
    (record.dueAtMs === undefined || isFiniteNumber(record.dueAtMs)) &&
    (pending === undefined ||
      (!!pending &&
        typeof pending === 'object' &&
        isNonEmptyString(pending.requestedId) &&
        isFiniteNumber(pending.dueAtMs) &&
        (pending.strayIds === undefined ||
          (Array.isArray(pending.strayIds) &&
            pending.strayIds.every(isNonEmptyString)))))
  );
}

/** Storage-level check: a snoozed cycle must carry its delivery ID and time. */
export function hasValidSnoozeState(cycle: {
  phase: string;
  snooze?: unknown;
}): boolean {
  if (cycle.snooze !== undefined && !isSnoozeRecord(cycle.snooze)) {
    return false;
  }
  if (cycle.phase !== 'snoozed') {
    return true;
  }
  const snooze = cycle.snooze as SnoozeRecord | undefined;
  return (
    !!snooze &&
    snooze.count >= 1 &&
    isNonEmptyString(snooze.notificationId) &&
    isFiniteNumber(snooze.dueAtMs)
  );
}

/** Every snooze notification ID that may exist for this occurrence. */
export function getSnoozeIds(cycle: Pick<StoredAlarm, 'snooze'>): string[] {
  const ids = [
    cycle.snooze?.notificationId,
    cycle.snooze?.pending?.requestedId,
    ...(cycle.snooze?.pending?.strayIds ?? []),
  ];
  return [...new Set(ids.filter(isNonEmptyString))];
}

export interface SnoozeAvailability {
  canSnooze: boolean;
  used: number;
  remaining: number;
  /** When a snooze pressed now would ring again. */
  nextAtMs: number;
}

export function getSnoozeAvailability(
  cycle: Pick<StoredAlarm, 'snooze'>,
  nowMs: number,
): SnoozeAvailability {
  const used = cycle.snooze?.count ?? 0;
  const remaining = Math.max(0, SNOOZE_MAX_COUNT - used);
  return {
    canSnooze: remaining > 0,
    used,
    remaining,
    nextAtMs: nowMs + SNOOZE_INTERVAL_MS,
  };
}

/**
 * Whether a delivered alarm notification should start ringing this cycle. A
 * snoozed cycle rings only for its own snooze delivery, never for a stale one.
 */
export function shouldRingFromDelivery(
  cycle: Pick<StoredAlarm, 'phase' | 'snooze'>,
  identifier: string,
): boolean {
  if (cycle.phase === 'armed' || cycle.phase === 'step_candidate') {
    return true;
  }
  return (
    cycle.phase === 'snoozed' && cycle.snooze?.notificationId === identifier
  );
}

/**
 * Applies a delivery to the latest stored state. Decided on the state read
 * inside the storage turn, so a stop, snooze or reset that finished after the
 * delivery was received is never overwritten by a stale copy of the cycle.
 * Returns the same array when the delivery changes nothing.
 */
export function markDeliveredCycleRinging(
  alarms: StoredAlarmDefinition[],
  cycleId: string,
  identifier: string,
): StoredAlarmDefinition[] {
  let changed = false;
  const next = alarms.map((alarm) => {
    if (!alarm.cycles.some((cycle) => cycle.cycleId === cycleId)) {
      return alarm;
    }
    return {
      ...alarm,
      cycles: alarm.cycles.map((cycle) => {
        if (
          cycle.cycleId !== cycleId ||
          !shouldRingFromDelivery(cycle, identifier)
        ) {
          return cycle;
        }
        changed = true;
        return { ...cycle, phase: 'ringing' as const };
      }),
    };
  });
  return changed ? next : alarms;
}

export interface SnoozeGateway {
  /** Every pending notification of the device, other apps' included. */
  listScheduledIds(): Promise<ReadonlySet<string>>;
  /** Must schedule under exactly `identifier`; resolves to the ID used. */
  schedule(input: {
    identifier: string;
    alarmId: string;
    cycleId: string;
    dueAtMs: number;
    snoozeNumber: number;
  }): Promise<string>;
  /** Rejects unless the cancellation was confirmed. */
  cancelScheduled(notificationId: string): Promise<void>;
  dismissDelivered(notificationId: string): Promise<void>;
}

export interface SnoozeStore {
  load(cycleId: string): Promise<StoredAlarm | null>;
  save(cycle: StoredAlarm): Promise<void>;
  /** Every stored alarm; lets recovery read inside its own transaction. */
  loadAll?(): Promise<readonly StoredAlarmDefinition[]>;
}

export interface SnoozeServiceDependencies {
  gateway: SnoozeGateway;
  store: SnoozeStore;
  /**
   * Runs one operation inside the app's storage locks and hands it a store
   * that is local to that transaction. The service never takes those locks
   * itself: a `store` backed by a locking queue would wait for its own
   * transaction. Without it, operations use `store` directly.
   */
  transact?<T>(run: (store: SnoozeStore) => Promise<T>): Promise<T>;
  nowMs(): number;
  makeId(): string;
  capacity?: number;
}

export type SnoozeRejection =
  | 'NOT_FOUND'
  | 'NOT_RINGING'
  | 'LIMIT_REACHED'
  | 'TOO_LATE'
  | 'CAPACITY_FULL'
  | 'LIST_FAILED'
  | 'INTENT_NOT_SAVED'
  | 'SCHEDULE_FAILED'
  | 'VERIFY_FAILED'
  | 'PERSIST_FAILED';

export type SnoozeResult =
  | { status: 'snoozed'; cycle: StoredAlarm; dueAtMs: number }
  | {
      status: 'rejected';
      reason: SnoozeRejection;
      /** Present only when the attempted notification may still exist. */
      cleanup?: 'unconfirmed';
    };

export type StopResult =
  | { status: 'stopped'; cycle: StoredAlarm }
  | { status: 'ignored' }
  | { status: 'failed'; reason: 'CANCEL_FAILED' | 'SAVE_FAILED' };

export interface SnoozeRecoveryOutcome {
  /** Leftover attempts that were cancelled and cleared. */
  cleaned: string[];
  /** Waiting snoozes whose notification was missing and was scheduled again. */
  rearmed: string[];
  /** Waiting snoozes that could not be scheduled again. */
  rearmFailed: string[];
  /** Leftover attempts whose cancellation could not be confirmed. */
  unresolved: string[];
}

export interface SnoozeService {
  snooze(
    cycleId: string,
    options?: { notAfterMs?: number },
  ): Promise<SnoozeResult>;
  stop(cycleId: string): Promise<StopResult>;
  /** `alarms` only picks candidates; omitted, they are read inside the lock. */
  recover(
    alarms?: readonly StoredAlarmDefinition[],
  ): Promise<SnoozeRecoveryOutcome>;
}

function withoutPending(cycle: StoredAlarm): StoredAlarm {
  const { pending: _pending, ...rest } = cycle.snooze ?? { count: 0 };
  const hasState =
    rest.count > 0 || rest.notificationId !== undefined;
  const { snooze: _snooze, ...cycleRest } = cycle;
  return hasState ? { ...cycleRest, snooze: rest } : cycleRest;
}

export function createSnoozeService({
  gateway,
  store: directStore,
  transact,
  nowMs,
  makeId,
  capacity = NOTIFICATION_CAPACITY,
}: SnoozeServiceDependencies): SnoozeService {
  // Snooze, stop and recovery run one at a time so a double press, or a stop
  // racing a snooze, always sees the state the previous one left.
  let tail: Promise<unknown> = Promise.resolve();
  const inFlightSnoozes = new Map<string, Promise<SnoozeResult>>();

  function enqueue<T>(run: (store: SnoozeStore) => Promise<T>): Promise<T> {
    const operation = tail.then(() =>
      transact ? transact(run) : run(directStore),
    );
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Cancels what an attempt may have created; reports if that is unsure. */
  async function discardAttempt(
    store: SnoozeStore,
    base: StoredAlarm,
    ids: readonly string[],
  ): Promise<{ cleanup?: 'unconfirmed' }> {
    for (const id of ids) {
      try {
        await gateway.cancelScheduled(id);
      } catch {
        // The requested ID stays recorded so recovery can try again.
        return { cleanup: 'unconfirmed' };
      }
    }
    await store.save(withoutPending(base)).catch(() => undefined);
    return {};
  }

  async function performSnooze(
    store: SnoozeStore,
    cycleId: string,
    options: { notAfterMs?: number },
  ): Promise<SnoozeResult> {
    const reject = (
      reason: SnoozeRejection,
      extra: { cleanup?: 'unconfirmed' } = {},
    ): SnoozeResult => ({ status: 'rejected', reason, ...extra });

    const cycle = await store.load(cycleId).catch(() => null);
    if (!cycle) {
      return reject('NOT_FOUND');
    }
    if (cycle.phase !== 'ringing') {
      return reject('NOT_RINGING');
    }
    const used = cycle.snooze?.count ?? 0;
    if (used >= SNOOZE_MAX_COUNT) {
      return reject('LIMIT_REACHED');
    }
    const dueAtMs = nowMs() + SNOOZE_INTERVAL_MS;
    // A snooze must end before the same alarm's next occurrence is due. The
    // latest stored state is read here, inside the transaction.
    let notAfterMs = options.notAfterMs;
    if (store.loadAll) {
      try {
        const next = (await store.loadAll())
          .filter((alarm) => alarm.id === cycle.alarmId)
          .flatMap((alarm) => alarm.cycles)
          .filter(
            (other) =>
              (other.phase === 'armed' || other.phase === 'step_candidate') &&
              other.dueAtMs > cycle.dueAtMs,
          )
          .map((other) => other.dueAtMs)
          .sort((left, right) => left - right)[0];
        if (next !== undefined) {
          notAfterMs = Math.min(notAfterMs ?? next, next);
        }
      } catch {
        return reject('NOT_FOUND');
      }
    }
    if (notAfterMs !== undefined && dueAtMs >= notAfterMs) {
      return reject('TOO_LATE');
    }

    let scheduledIds: Set<string>;
    try {
      scheduledIds = new Set(await gateway.listScheduledIds());
    } catch {
      return reject('LIST_FAILED');
    }

    // Every ID a previous attempt recorded must be settled before pending is
    // replaced, or the replaced record would forget a notification.
    const pendingRecord = cycle.snooze?.pending;
    for (const id of pendingRecord
      ? [pendingRecord.requestedId, ...(pendingRecord.strayIds ?? [])]
      : []) {
      if (!scheduledIds.has(id)) {
        continue;
      }
      try {
        await gateway.cancelScheduled(id);
        scheduledIds.delete(id);
      } catch {
        return reject('SCHEDULE_FAILED', { cleanup: 'unconfirmed' });
      }
    }
    if (scheduledIds.size + 1 > capacity) {
      return reject('CAPACITY_FULL');
    }

    const requestedId = makeId();
    const base = withoutPending(cycle);
    try {
      await store.save({
        ...base,
        snooze: {
          ...(base.snooze ?? { count: 0 }),
          pending: { requestedId, dueAtMs },
        },
      });
    } catch {
      return reject('INTENT_NOT_SAVED');
    }

    let returnedId: string;
    try {
      returnedId = await gateway.schedule({
        identifier: requestedId,
        alarmId: cycle.alarmId,
        cycleId: cycle.cycleId,
        dueAtMs,
        snoozeNumber: used + 1,
      });
    } catch {
      return reject('SCHEDULE_FAILED', await discardAttempt(store, base, [requestedId]));
    }
    if (returnedId !== requestedId) {
      // Write ahead: if cancelling the unexpected ID fails it stays tracked.
      await store
        .save({
          ...base,
          snooze: {
            ...(base.snooze ?? { count: 0 }),
            pending: { requestedId, dueAtMs, strayIds: [returnedId] },
          },
        })
        .catch(() => undefined);
      return reject(
        'SCHEDULE_FAILED',
        await discardAttempt(store, base, [requestedId, returnedId]),
      );
    }

    let confirmed = false;
    try {
      confirmed = (await gateway.listScheduledIds()).has(requestedId);
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      return reject('VERIFY_FAILED', await discardAttempt(store, base, [requestedId]));
    }

    const snoozed: StoredAlarm = {
      ...base,
      phase: 'snoozed',
      snooze: { count: used + 1, notificationId: requestedId, dueAtMs },
    };
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
      try {
        await store.save(snoozed);
        saved = true;
      } catch {
        // Retried once; then the attempt is undone below.
      }
    }
    if (!saved) {
      return reject('PERSIST_FAILED', await discardAttempt(store, base, [requestedId]));
    }

    // The earlier banners are no longer meaningful; failing here is harmless.
    const previousSnoozeId = cycle.snooze?.notificationId;
    for (const id of [cycle.mainAlarmId, previousSnoozeId]) {
      if (id) {
        await gateway.dismissDelivered(id).catch(() => undefined);
      }
    }
    return { status: 'snoozed', cycle: snoozed, dueAtMs };
  }

  async function performStop(
    store: SnoozeStore,
    cycleId: string,
  ): Promise<StopResult> {
    const cycle = await store.load(cycleId).catch(() => null);
    if (!cycle || (cycle.phase !== 'ringing' && cycle.phase !== 'snoozed')) {
      return { status: 'ignored' };
    }

    const scheduledIds = getSnoozeIds(cycle);
    for (const id of scheduledIds) {
      try {
        await gateway.cancelScheduled(id);
      } catch {
        return { status: 'failed', reason: 'CANCEL_FAILED' };
      }
    }
    if (cycle.checkInNotificationId) {
      // Its time is before the due time, so it has already passed.
      await gateway
        .cancelScheduled(cycle.checkInNotificationId)
        .catch(() => undefined);
    }
    for (const id of [cycle.mainAlarmId, ...scheduledIds]) {
      await gateway.dismissDelivered(id).catch(() => undefined);
    }

    const { snooze: _snooze, ...rest } = cycle;
    const dismissed: StoredAlarm = { ...rest, phase: 'dismissed' };
    try {
      await store.save(dismissed);
    } catch {
      return { status: 'failed', reason: 'SAVE_FAILED' };
    }
    return { status: 'stopped', cycle: dismissed };
  }

  async function performRecover(
    store: SnoozeStore,
    given: readonly StoredAlarmDefinition[] | undefined,
  ): Promise<SnoozeRecoveryOutcome> {
    let alarms: readonly StoredAlarmDefinition[] = given ?? [];
    if (!given && store.loadAll) {
      try {
        alarms = await store.loadAll();
      } catch {
        return { cleaned: [], rearmed: [], rearmFailed: [], unresolved: [] };
      }
    }
    const outcome: SnoozeRecoveryOutcome = {
      cleaned: [],
      rearmed: [],
      rearmFailed: [],
      unresolved: [],
    };
    const cycles = alarms.flatMap((alarm) => alarm.cycles);
    const relevant = cycles.filter(
      (cycle) => cycle.snooze?.pending || cycle.phase === 'snoozed',
    );
    if (relevant.length === 0) {
      return outcome;
    }

    let scheduledIds: ReadonlySet<string>;
    try {
      scheduledIds = await gateway.listScheduledIds();
    } catch {
      for (const cycle of relevant) {
        outcome.unresolved.push(cycle.cycleId);
      }
      return outcome;
    }

    // A private copy that follows every cancel and schedule below, so each
    // recovered slot is counted against the capacity.
    const queue = new Set(scheduledIds);
    let queueReadable = true;

    // After any uncertain schedule or cancel the private copy may be stale;
    // it is trusted again only after a fresh read.
    async function refreshQueue(): Promise<void> {
      try {
        const fresh = await gateway.listScheduledIds();
        queue.clear();
        fresh.forEach((id) => queue.add(id));
        queueReadable = true;
      } catch {
        queueReadable = false;
      }
    }

    for (const listed of relevant) {
      // The listing only picks candidates; every decision uses a fresh read.
      let cycle: StoredAlarm | null;
      try {
        cycle = await store.load(listed.cycleId);
      } catch {
        outcome.unresolved.push(listed.cycleId);
        continue;
      }
      if (!cycle) {
        continue;
      }
      const pending = cycle.snooze?.pending;
      if (pending) {
        try {
          for (const id of [pending.requestedId, ...(pending.strayIds ?? [])]) {
            if (queue.has(id)) {
              await gateway.cancelScheduled(id);
              queue.delete(id);
            }
          }
          await store.save(withoutPending(cycle));
          outcome.cleaned.push(cycle.cycleId);
        } catch {
          outcome.unresolved.push(cycle.cycleId);
        }
        continue;
      }

      const snooze = cycle.snooze;
      if (
        cycle.phase === 'snoozed' &&
        snooze?.notificationId &&
        snooze.dueAtMs !== undefined &&
        snooze.dueAtMs > nowMs() &&
        !queue.has(snooze.notificationId)
      ) {
        if (!queueReadable || queue.size + 1 > capacity) {
          outcome.rearmFailed.push(cycle.cycleId);
          continue;
        }
        const requestedId = snooze.notificationId;
        let returnedId: string;
        try {
          returnedId = await gateway.schedule({
            identifier: requestedId,
            alarmId: cycle.alarmId,
            cycleId: cycle.cycleId,
            dueAtMs: snooze.dueAtMs,
            snoozeNumber: snooze.count,
          });
        } catch {
          // The system may have created it before failing.
          await refreshQueue();
          outcome.rearmFailed.push(cycle.cycleId);
          continue;
        }
        if (returnedId !== requestedId) {
          try {
            await gateway.cancelScheduled(returnedId);
          } catch {
            // Keep the unknown ID tracked so a later recovery cancels it.
            try {
              await store.save({
                ...cycle,
                snooze: {
                  ...snooze,
                  pending: {
                    requestedId,
                    dueAtMs: snooze.dueAtMs,
                    strayIds: [returnedId],
                  },
                },
              });
            } catch {
              outcome.unresolved.push(cycle.cycleId);
            }
          }
          await refreshQueue();
          outcome.rearmFailed.push(cycle.cycleId);
          continue;
        }
        await refreshQueue();
        if (!queueReadable) {
          outcome.rearmFailed.push(cycle.cycleId);
          continue;
        }
        if (queue.has(requestedId)) {
          outcome.rearmed.push(cycle.cycleId);
        } else {
          outcome.rearmFailed.push(cycle.cycleId);
        }
      }
    }
    return outcome;
  }

  return {
    snooze(cycleId, options = {}) {
      const existing = inFlightSnoozes.get(cycleId);
      if (existing) {
        return existing;
      }
      const operation = enqueue((store) =>
        performSnooze(store, cycleId, options),
      ).finally(
        () => {
          inFlightSnoozes.delete(cycleId);
        },
      );
      inFlightSnoozes.set(cycleId, operation);
      return operation;
    },
    stop: (cycleId) => enqueue((store) => performStop(store, cycleId)),
    recover: (alarms) => enqueue((store) => performRecover(store, alarms)),
  };
}
