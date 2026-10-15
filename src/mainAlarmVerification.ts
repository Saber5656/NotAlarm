import { AppError, errorCodeOf } from './errorCatalog';
import type { AlarmSchedulingGateway } from './alarmOrchestrator';
import type { OrphanStore } from './scheduleReconciliation';

export interface MainVerificationOptions {
  /**
   * Durable record of notification ids whose registration could not be
   * verified. Without it ids are only held in memory.
   */
  orphans?: Pick<OrphanStore, 'load' | 'add' | 'remove'>;
  /**
   * Cancels exactly this identifier and verifies it is absent from the OS
   * queue; rejects if cancellation or readback is uncertain. Used only when
   * the journal write fails. App supplies cancelNotificationIfPresent.
   */
  cancelScheduled?(notificationId: string): Promise<void>;
}

export interface VerifiedSchedulingGateway extends AlarmSchedulingGateway {
  /**
   * Same registration and verification, but never refused because an earlier
   * id is still unresolved. Only the reconciliation pass that resolves those
   * ids uses it. Its verified ids stay recorded like any other until the pass
   * reaches its checkpoint (releaseProvisional) or a confirmed cancel.
   */
  scheduleMainForReconcile: AlarmSchedulingGateway['scheduleMain'];
  /** Ids the OS returned but that are neither verified nor durably recorded. */
  unresolvedMainIds(): string[];
  /** Moves held ids into the journal, or cancels them by exact id. */
  flushUnresolved(): Promise<void>;
  /**
   * The definition checkpoint holding these main ids succeeded, or their
   * cancellation was confirmed: drops them (and any requested id that went
   * with them) from the journal.
   */
  releaseProvisional(mainIds: readonly string[]): Promise<void>;
  /**
   * These ids could not be settled: they stay in the journal and block new
   * registrations. Without an argument every provisional id is abandoned.
   */
  abandonProvisional(mainIds?: readonly string[]): void;
  /** Forgets held ids after a reset has confirmed every owned id cancelled. */
  clearUnresolved(): void;
}

/**
 * Wraps a scheduling gateway so a main alarm only counts as reserved when the
 * OS lists the identifier it returned.
 *
 * Once `scheduleMain` has returned an id, the notification exists as far as
 * this app can tell. If the verification then fails (unreadable list or id
 * missing) the id is recorded durably before MAIN_UNVERIFIED is thrown, so the
 * next reconciliation can cancel exactly that notification and a reset
 * cancels it too. While any such id is unresolved, new main registrations are
 * refused (MAIN_RECONCILE_PENDING) so a manual retry cannot ring twice.
 * Nothing is cancelled here unless the journal write itself fails.
 */
export function withMainVerification(
  gateway: AlarmSchedulingGateway,
  listScheduledIds: () => Promise<ReadonlySet<string>>,
  options: MainVerificationOptions = {},
): VerifiedSchedulingGateway {
  const { orphans, cancelScheduled } = options;
  const held = new Set<string>();
  /**
   * Verified ids whose definition checkpoint has not happened yet, keyed by the
   * returned id and listing every journaled id of that registration. They stay
   * in the journal so a crash cannot forget them; the operation that owns them
   * settles them, so they do not block that operation's next occurrence.
   */
  const provisional = new Map<string, string[]>();

  function isProvisional(id: string): boolean {
    for (const group of provisional.values()) {
      if (group.includes(id)) {
        return true;
      }
    }
    return false;
  }

  async function hasUnresolved(): Promise<boolean> {
    if (held.size > 0) {
      return true;
    }
    if (!orphans) {
      return false;
    }
    try {
      return (await orphans.load()).some((id) => !isProvisional(id));
    } catch {
      // An unreadable journal may hide a scheduled id.
      return true;
    }
  }

  /**
   * How an unverified id was kept:
   *  - 'journal': written to the durable record; a later launch cancels it.
   *  - 'cancelled': the journal write failed but the exact id was cancelled.
   *  - 'memory': neither worked. The id is lost if the app closes.
   */
  async function remember(id: string): Promise<'journal' | 'cancelled' | 'memory'> {
    if (orphans) {
      try {
        await orphans.add([id]);
        return 'journal';
      } catch {
        // Fall through: keep the exact id some other way.
      }
    }
    try {
      if (cancelScheduled) {
        await cancelScheduled(id);
        return 'cancelled';
      }
    } catch {
      // Cancellation outcome unknown: hold the id and block new reservations.
    }
    held.add(id);
    return 'memory';
  }

  let nextId = 0;
  /** An id this wrapper chose itself and journaled before asking the OS. */
  function allocateIdentifier(): string {
    nextId += 1;
    return `main-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}-${nextId}`;
  }

  async function registerAndVerify(
    input: Parameters<AlarmSchedulingGateway['scheduleMain']>[0],
  ): Promise<string> {
    // A registration failure propagates as is; the caller maps it to
    // MAIN_REGISTER_FAILED.
    // A caller that passes an identifier journals it itself (the edit does).
    // Otherwise the id is chosen and journaled here, before the OS request, so
    // a crash between the request and the verification still leaves its id on
    // record. If it cannot be recorded, nothing is requested.
    let preJournaled: string | undefined;
    let request = input;
    if (!input.identifier && orphans) {
      const identifier = allocateIdentifier();
      try {
        await orphans.add([identifier]);
      } catch {
        throw new AppError('STORAGE_JOURNAL_SAVE_FAILED');
      }
      preJournaled = identifier;
      request = { ...input, identifier };
    }
    // A failure here propagates as is (MAIN_REGISTER_FAILED). The request may
    // still have reached the OS, so the pre-journaled id stays until a
    // reconciliation settles it.
    let mainAlarmId: string;
    try {
      mainAlarmId = await gateway.scheduleMain(request);
    } catch (error) {
      if (preJournaled) {
        // The request may have reached the OS before it failed, so the app
        // cannot say it was not scheduled; the recorded id settles it later.
        throw new AppError(
          errorCodeOf(error, 'MAIN_REGISTER_UNCONFIRMED'),
          error,
        );
      }
      throw error;
    }
    if (preJournaled && mainAlarmId !== preJournaled) {
      // The OS did not honour the requested id: keep the real one as well.
      await remember(mainAlarmId);
    }
    let listed: boolean;
    let readError: unknown;
    try {
      listed = (await listScheduledIds()).has(mainAlarmId);
    } catch (error) {
      listed = false;
      readError = error;
    }
    if (!listed) {
      const kept = await remember(mainAlarmId);
      throw new AppError(
        kept === 'memory'
          ? 'MAIN_UNVERIFIED_MEMORY_ONLY'
          : kept === 'cancelled'
            ? 'MAIN_UNVERIFIED_CANCELLED'
            : 'MAIN_UNVERIFIED',
        readError,
      );
    }
    if (preJournaled) {
      // Verified is not stored: the record stays until the owner settles it at
      // its definition checkpoint or a confirmed cancel (releaseProvisional /
      // abandonProvisional). The reconciliation pass is such an owner too.
      provisional.set(mainAlarmId, [...new Set([preJournaled, mainAlarmId])]);
    }
    return mainAlarmId;
  }

  return {
    ...gateway,
    async scheduleMain(input) {
      if (await hasUnresolved()) {
        throw new AppError('MAIN_RECONCILE_PENDING');
      }
      return registerAndVerify(input);
    },
    scheduleMainForReconcile: (input) => registerAndVerify(input),
    unresolvedMainIds: () => [...held],
    async flushUnresolved() {
      for (const id of [...held]) {
        held.delete(id);
        await remember(id);
      }
    },
    async releaseProvisional(mainIds) {
      // Only ids this wrapper registered and still owns are removed; an id it
      // does not know (another operation's record) is never touched.
      const owned = mainIds.filter((id) => provisional.has(id));
      const ids = new Set<string>();
      for (const id of owned) {
        provisional.get(id)?.forEach((member) => ids.add(member));
      }
      if (ids.size === 0 || !orphans) {
        return;
      }
      try {
        await orphans.remove([...ids]);
        for (const id of owned) {
          provisional.delete(id);
        }
      } catch {
        // The record stays; reconciliation drops it (a stored cycle that
        // points to the id is never cancelled, a cancelled id is harmless).
      }
    },
    abandonProvisional(mainIds) {
      if (!mainIds) {
        provisional.clear();
        return;
      }
      for (const id of mainIds) {
        provisional.delete(id);
      }
    },
    clearUnresolved() {
      held.clear();
      provisional.clear();
    },
  };
}
