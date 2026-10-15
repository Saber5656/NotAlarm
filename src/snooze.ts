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

/**
 * What a cancellation that could not be confirmed left behind. Absent means
 * every notification the operation may have created or owned is confirmed gone.
 */
export interface CleanupReport {
  /** A notification may still exist; a later recovery or deletion retries. */
  cleanup?: 'unconfirmed';
  /**
   * Set when no storage write could record that notification: it is only held
   * in this process and is lost if the app restarts before it is settled.
   */
  tracking?: 'memory_only';
}

/**
 * The definitions exactly as the transaction committed them, stamped with the
 * storage epoch (see storageResetGate). The screen applies this instead of
 * reading storage again, so a failing read cannot hide a persisted result.
 * Attached by the transaction wrapper; absent for a store without one.
 */
export interface CommittedSnapshot {
  alarms?: StoredAlarmDefinition[];
}

export type SnoozeResult =
  | ({
      status: 'snoozed';
      cycle: StoredAlarm;
      dueAtMs: number;
    } & CleanupReport &
      CommittedSnapshot)
  | ({
      status: 'rejected';
      reason: SnoozeRejection;
    } & CleanupReport);

/**
 * `stopped` means the stop is durable: the occurrence can no longer ring.
 * `cleanup: 'unconfirmed'` then says a scheduled notification of it could not
 * be confirmed cancelled yet; it stays recorded (or held, see `tracking`).
 * `CANCEL_FAILED` is no longer produced (the stop is written ahead instead)
 * and is kept so existing exhaustive handling still compiles.
 */
export type StopResult =
  | ({ status: 'stopped'; cycle: StoredAlarm } & CleanupReport &
      CommittedSnapshot)
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
  /** Cycles whose unsettled ids no storage write could record (lost on restart). */
  memoryOnly?: string[];
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
  /**
   * Notification ids that may still be scheduled and that no storage write
   * could record. A deletion must cancel them (see `extraKnownIds`).
   */
  unsettledIds(): string[];
  /** Call once a deletion confirmed every owned notification gone. */
  forgetUnsettled(): void;
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
  // Ids that may still be scheduled when no storage write could record them.
  // Fail closed: they block a new snooze of that cycle, ride along with a
  // stop's durable record, are retried by recovery and cancelled by a deletion.
  const unsettled = new Map<string, Set<string>>();

  function remember(cycleId: string, ids: readonly string[]): void {
    const known = unsettled.get(cycleId) ?? new Set<string>();
    ids.forEach((id) => known.add(id));
    unsettled.set(cycleId, known);
  }

  function forget(cycleId: string, ids: readonly string[]): void {
    const known = unsettled.get(cycleId);
    if (!known) {
      return;
    }
    ids.forEach((id) => known.delete(id));
    if (known.size === 0) {
      unsettled.delete(cycleId);
    }
  }

  function remembered(cycleId: string): string[] {
    return [...(unsettled.get(cycleId) ?? [])];
  }

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

  /**
   * Cancels one scheduled notification and proves it is gone. A cancel that
   * resolves is not enough: the queue is read again and must no longer hold it.
   */
  async function cancelConfirmed(id: string): Promise<boolean> {
    try {
      await gateway.cancelScheduled(id);
    } catch {
      return false;
    }
    try {
      return !(await gateway.listScheduledIds()).has(id);
    } catch {
      return false;
    }
  }

  /** Cancels every id; returns the ones that are not confirmed gone. */
  async function cancelAllConfirmed(ids: readonly string[]): Promise<string[]> {
    const left: string[] = [];
    for (const id of ids) {
      if (!(await cancelConfirmed(id))) {
        left.push(id);
      }
    }
    return left;
  }

  /** Writes `cycle`; false when the write was refused. */
  async function tryWrite(
    store: SnoozeStore,
    cycle: StoredAlarm,
  ): Promise<boolean> {
    try {
      await store.save(cycle);
      return true;
    } catch {
      return false;
    }
  }

  /** Stored record that names `ids` for a later cancel; the first is the key. */
  function withTracked(
    cycle: StoredAlarm,
    ids: readonly string[],
    dueAtMs: number,
  ): StoredAlarm {
    const existing = cycle.snooze?.pending;
    const all = [
      ...new Set([
        ...(existing ? [existing.requestedId, ...(existing.strayIds ?? [])] : []),
        ...ids,
      ]),
    ];
    return {
      ...cycle,
      snooze: {
        ...(cycle.snooze ?? { count: 0 }),
        pending: {
          requestedId: all[0],
          dueAtMs: existing?.dueAtMs ?? dueAtMs,
          ...(all.length > 1 ? { strayIds: all.slice(1) } : {}),
        },
      },
    };
  }

  /**
   * Makes sure ids that may still be scheduled are recorded: durably when a
   * write works, otherwise in memory (reported as such).
   */
  async function track(
    store: SnoozeStore,
    cycle: StoredAlarm,
    ids: readonly string[],
    dueAtMs: number,
    /** Ids held in memory if no write works; the rest are already durable. */
    held: readonly string[] = ids,
  ): Promise<{ record: StoredAlarm; tracking?: 'memory_only' }> {
    const record = withTracked(cycle, ids, dueAtMs);
    if (await tryWrite(store, record)) {
      forget(cycle.cycleId, ids);
      return { record };
    }
    remember(cycle.cycleId, held);
    return { record: cycle, tracking: 'memory_only' };
  }

  /** Cancels what an attempt may have created; reports if that is unsure. */
  async function discardAttempt(
    store: SnoozeStore,
    base: StoredAlarm,
    attempt: { requestedId: string; dueAtMs: number; strayIds?: string[] },
  ): Promise<CleanupReport> {
    const ids = [attempt.requestedId, ...(attempt.strayIds ?? [])];
    const left = await cancelAllConfirmed(ids);
    if (left.length === 0) {
      forget(base.cycleId, ids);
      // Everything is verified gone; a leftover pending record is harmless.
      await tryWrite(store, withoutPending(base));
      return {};
    }
    // The requested id is already recorded by the intent write; any other
    // unconfirmed id needs its own record, or a restart would forget it.
    const strays = left.filter((id) => id !== attempt.requestedId);
    if (strays.length > 0) {
      const tracked = await track(
        store,
        withoutPending(base),
        [attempt.requestedId, ...strays],
        attempt.dueAtMs,
        strays,
      );
      return {
        cleanup: 'unconfirmed',
        ...(tracked.tracking ? { tracking: tracked.tracking } : {}),
      };
    }
    return { cleanup: 'unconfirmed' };
  }

  async function performSnooze(
    store: SnoozeStore,
    cycleId: string,
    options: { notAfterMs?: number },
  ): Promise<SnoozeResult> {
    const reject = (
      reason: SnoozeRejection,
      extra: CleanupReport = {},
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

    // Ids only this process remembers must be settled before anything new is
    // scheduled for the same occurrence.
    const heldBack = await cancelAllConfirmed(remembered(cycleId));
    forget(
      cycleId,
      remembered(cycleId).filter((id) => !heldBack.includes(id)),
    );
    if (heldBack.length > 0) {
      return reject('SCHEDULE_FAILED', {
        cleanup: 'unconfirmed',
        tracking: 'memory_only',
      });
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
      if (!(await cancelConfirmed(id))) {
        return reject('SCHEDULE_FAILED', { cleanup: 'unconfirmed' });
      }
      scheduledIds.delete(id);
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
      return reject(
        'SCHEDULE_FAILED',
        await discardAttempt(store, base, { requestedId, dueAtMs }),
      );
    }
    if (returnedId !== requestedId) {
      // Write ahead: if cancelling the unexpected ID fails it stays tracked.
      // A refused write is not swallowed: discardAttempt records the id again
      // after the cancel, and holds it in memory when no write works.
      await tryWrite(store, {
        ...base,
        snooze: {
          ...(base.snooze ?? { count: 0 }),
          pending: { requestedId, dueAtMs, strayIds: [returnedId] },
        },
      });
      return reject(
        'SCHEDULE_FAILED',
        await discardAttempt(store, base, {
          requestedId,
          dueAtMs,
          strayIds: [returnedId],
        }),
      );
    }

    let confirmed = false;
    try {
      confirmed = (await gateway.listScheduledIds()).has(requestedId);
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      return reject(
        'VERIFY_FAILED',
        await discardAttempt(store, base, { requestedId, dueAtMs }),
      );
    }

    const snoozed: StoredAlarm = {
      ...base,
      phase: 'snoozed',
      snooze: { count: used + 1, notificationId: requestedId, dueAtMs },
    };
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
      saved = await tryWrite(store, snoozed);
      // Retried once; then the attempt is undone below.
    }
    if (!saved) {
      return reject(
        'PERSIST_FAILED',
        await discardAttempt(store, base, { requestedId, dueAtMs }),
      );
    }

    // The tick may have marked this occurrence ringing before its main (or
    // the previous snooze) was delivered, so either can still be pending and
    // would sound right after the new snooze. Cancel and confirm them now that
    // the replacement is verified and stored; dismissing only covers banners.
    const earlier = [
      ...new Set(
        [cycle.mainAlarmId, cycle.snooze?.notificationId].filter(
          (id): id is string => !!id && id !== requestedId,
        ),
      ),
    ];
    const notCancelled = await cancelAllConfirmed(earlier);
    for (const id of earlier) {
      await gateway.dismissDelivered(id).catch(() => undefined);
    }
    if (notCancelled.length === 0) {
      return { status: 'snoozed', cycle: snoozed, dueAtMs };
    }
    const tracked = await track(store, snoozed, notCancelled, dueAtMs);
    return {
      status: 'snoozed',
      cycle: tracked.record,
      dueAtMs,
      cleanup: 'unconfirmed',
      ...(tracked.tracking ? { tracking: tracked.tracking } : {}),
    };
  }

  async function performStop(
    store: SnoozeStore,
    cycleId: string,
  ): Promise<StopResult> {
    const cycle = await store.load(cycleId).catch(() => null);
    if (!cycle || (cycle.phase !== 'ringing' && cycle.phase !== 'snoozed')) {
      return { status: 'ignored' };
    }

    // Every OS notification this occurrence may still own: the tick can mark
    // it ringing before its main or check-in was delivered, so those are
    // cancelled too, alongside the snooze delivery, a pending attempt, its
    // strays and ids held in memory. The main id is always present.
    const owned = [
      cycle.mainAlarmId,
      cycle.checkInNotificationId,
      ...getSnoozeIds(cycle),
    ].filter((id): id is string => !!id);
    const held = remembered(cycleId).filter((id) => !owned.includes(id));
    const scheduledIds = [...new Set([...owned, ...held])];
    const { snooze: _snooze, ...rest } = cycle;
    const dismissed: StoredAlarm = { ...rest, phase: 'dismissed' };

    // Write ahead: the stop is stored together with every id still to cancel
    // before any of them is cancelled. If this write fails nothing has been
    // cancelled, so every pending notification (and the waiting snooze) keeps
    // its OS alarm; once it succeeds a crash or a failed cancel leaves a
    // dismissed cycle that recovery cleans.
    const writeAhead: StoredAlarm = {
      ...dismissed,
      snooze: {
        count: cycle.snooze?.count ?? 0,
        pending: {
          requestedId: scheduledIds[0],
          dueAtMs: cycle.snooze?.dueAtMs ?? cycle.snooze?.pending?.dueAtMs ?? nowMs(),
          ...(scheduledIds.length > 1 ? { strayIds: scheduledIds.slice(1) } : {}),
        },
      },
    };
    if (!(await tryWrite(store, writeAhead))) {
      return { status: 'failed', reason: 'SAVE_FAILED' };
    }
    // Held ids are durable now.
    forget(cycleId, held);

    const notCancelled = await cancelAllConfirmed(scheduledIds);
    for (const id of scheduledIds) {
      await gateway.dismissDelivered(id).catch(() => undefined);
    }

    if (notCancelled.length > 0) {
      return {
        status: 'stopped',
        cycle: writeAhead,
        cleanup: 'unconfirmed',
      };
    }
    // Confirmed gone: drop the record. If this write is refused the stored
    // cycle is still dismissed and recovery clears the leftover pending.
    if (await tryWrite(store, dismissed)) {
      return { status: 'stopped', cycle: dismissed };
    }
    return { status: 'stopped', cycle: writeAhead };
  }

  async function performRecover(
    store: SnoozeStore,
    given: readonly StoredAlarmDefinition[] | undefined,
  ): Promise<SnoozeRecoveryOutcome> {
    const outcome: SnoozeRecoveryOutcome = {
      cleaned: [],
      rearmed: [],
      rearmFailed: [],
      unresolved: [],
    };
    const markUnresolved = (cycleId: string) => {
      if (!outcome.unresolved.includes(cycleId)) {
        outcome.unresolved.push(cycleId);
      }
    };
    const markMemoryOnly = (cycleId: string) => {
      outcome.memoryOnly = [...new Set([...(outcome.memoryOnly ?? []), cycleId])];
    };

    // Ids held only in memory come first: cancel them, or move them into a
    // durable record now that writing may work again.
    for (const cycleId of [...unsettled.keys()]) {
      const left = await cancelAllConfirmed(remembered(cycleId));
      forget(
        cycleId,
        remembered(cycleId).filter((id) => !left.includes(id)),
      );
      if (left.length === 0) {
        continue;
      }
      const held = await store.load(cycleId).catch(() => null);
      const dueAtMs = held?.snooze?.dueAtMs ?? nowMs();
      if (held && (await track(store, held, left, dueAtMs)).tracking === undefined) {
        // Durable now; the cleanup below retries the cancel from the record.
        continue;
      }
      markUnresolved(cycleId);
      markMemoryOnly(cycleId);
    }

    let alarms: readonly StoredAlarmDefinition[] = given ?? [];
    if (!given && store.loadAll) {
      try {
        alarms = await store.loadAll();
      } catch {
        return outcome;
      }
    }
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
        markUnresolved(cycle.cycleId);
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
        markUnresolved(listed.cycleId);
        continue;
      }
      if (!cycle) {
        continue;
      }
      const pending = cycle.snooze?.pending;
      if (pending) {
        const left: string[] = [];
        for (const id of [pending.requestedId, ...(pending.strayIds ?? [])]) {
          if (queue.has(id) && !(await cancelConfirmed(id))) {
            left.push(id);
          }
        }
        // Whatever happened, the private copy may be stale now.
        await refreshQueue();
        if (left.length > 0) {
          markUnresolved(cycle.cycleId);
          continue;
        }
        // A stopped cycle keeps no snooze state once its leftovers are gone.
        const { snooze: _kept, ...withoutSnooze } = cycle;
        const cleaned =
          cycle.phase === 'dismissed' ? withoutSnooze : withoutPending(cycle);
        if (!(await tryWrite(store, cleaned))) {
          markUnresolved(cycle.cycleId);
          continue;
        }
        outcome.cleaned.push(cycle.cycleId);
        // The cleaned cycle is judged again below, in this same pass: its
        // accepted snooze may still be missing from the queue.
        cycle = cleaned;
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
          if (!(await cancelConfirmed(returnedId))) {
            // Keep the unknown ID tracked so a later recovery cancels it; when
            // no write works it is held in memory instead of being forgotten.
            const tracked = await track(
              store,
              cycle,
              [requestedId, returnedId],
              snooze.dueAtMs,
              [returnedId],
            );
            if (tracked.tracking) {
              markUnresolved(cycle.cycleId);
              markMemoryOnly(cycle.cycleId);
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
    unsettledIds: () => [
      ...new Set([...unsettled.values()].flatMap((ids) => [...ids])),
    ],
    forgetUnsettled: () => unsettled.clear(),
  };
}
