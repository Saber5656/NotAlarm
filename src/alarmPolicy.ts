export const STEP_THRESHOLD = 20;
export const CHECK_IN_LEAD_MS = 60_000;
export const MIN_ARM_LEAD_MS = 10_000;

/**
 * The minimum immutable identity and timing data needed to decide whether a
 * scheduled alarm may be cancelled.
 */
export interface AlarmRecord {
  cycleId: string;
  mainAlarmId: string;
  checkInNotificationId?: string;
  armedAtMs: number;
  dueAtMs: number;
}

export interface ExplicitAwakeConfirmation {
  kind: "EXPLICIT_AWAKE_CONFIRMATION";
  cycleId: string;
  mainAlarmId: string;
  checkInNotificationId: string;
  confirmedAtMs: number;
}

export type StepEvidence =
  | {
      kind: "STEP_MONITORING";
      observedAtMs: number;
      steps: number;
    }
  | {
      kind: "STEP_THRESHOLD_REACHED";
      observedAtMs: number;
      steps: number;
    }
  | {
      kind: "ERROR";
      reason: "INVALID_STEP_SAMPLE";
    };

export type WakeEvidence =
  | ExplicitAwakeConfirmation
  | StepEvidence
  | { kind: "UNKNOWN" }
  | { kind: "ERROR"; reason: string };

export type SuppressionRejectionReason =
  | "INVALID_ALARM_RECORD"
  | "INVALID_PROCESSING_TIME"
  | "ALARM_DUE_OR_PAST"
  | "NOT_EXPLICIT_CONFIRMATION"
  | "INVALID_STEP_TIME"
  | "STALE_STEP_EVIDENCE"
  | "STEP_AT_OR_AFTER_DUE"
  | "WRONG_CYCLE"
  | "WRONG_MAIN_ALARM"
  | "WRONG_CHECK_IN"
  | "INVALID_CONFIRMATION_TIME"
  | "STALE_CONFIRMATION"
  | "CONFIRMATION_BEFORE_CHECK_IN_WINDOW"
  | "CONFIRMATION_AT_OR_AFTER_DUE"
  | "CONFIRMATION_IN_FUTURE";

export type SuppressionDecision =
  | { canSuppress: true; reason: "CONFIRMED_AWAKE" | "STEP_THRESHOLD_REACHED" }
  | { canSuppress: false; reason: SuppressionRejectionReason };

export type SuppressionOutcome = "SUPPRESSED" | "ALARM_REMAINS_ARMED";

/**
 * Converts pedometer output into wake evidence. Reaching 20 steps is treated
 * as sufficient wake evidence for the presentation MVP.
 */
export function classifyStepEvidence(
  steps: number,
  observedAtMs: number,
): StepEvidence {
  if (
    !Number.isFinite(steps) ||
    steps < 0 ||
    !Number.isFinite(observedAtMs)
  ) {
    return { kind: "ERROR", reason: "INVALID_STEP_SAMPLE" };
  }

  return {
    kind: steps >= STEP_THRESHOLD ? "STEP_THRESHOLD_REACHED" : "STEP_MONITORING",
    observedAtMs,
    steps,
  };
}

/**
 * Returns the desired time for the single pre-alarm awake check-in.
 */
export function getCheckInAtMs(dueAtMs: number, armedAtMs: number): number {
  const availableLeadMs = dueAtMs - armedAtMs;
  const leadMs = Math.min(CHECK_IN_LEAD_MS, Math.floor(availableLeadMs / 2));
  return dueAtMs - leadMs;
}

/**
 * Fail-closed cancellation policy.
 *
 * A 100-step threshold observation or an explicit confirmation for the exact
 * active cycle may authorize cancellation. Unknown/error/stale evidence leaves
 * the alarm armed.
 */
export function canSuppressAlarm(
  record: AlarmRecord,
  confirmation: WakeEvidence,
  nowMs: number,
): SuppressionDecision {
  if (!isValidAlarmRecord(record)) {
    return { canSuppress: false, reason: "INVALID_ALARM_RECORD" };
  }

  if (!Number.isFinite(nowMs)) {
    return { canSuppress: false, reason: "INVALID_PROCESSING_TIME" };
  }

  // The due-time race is intentionally won by the alarm.
  if (nowMs >= record.dueAtMs) {
    return { canSuppress: false, reason: "ALARM_DUE_OR_PAST" };
  }

  if (confirmation.kind === "STEP_THRESHOLD_REACHED") {
    if (
      !Number.isFinite(confirmation.observedAtMs) ||
      !Number.isFinite(confirmation.steps)
    ) {
      return { canSuppress: false, reason: "INVALID_STEP_TIME" };
    }
    if (confirmation.observedAtMs < record.armedAtMs) {
      return { canSuppress: false, reason: "STALE_STEP_EVIDENCE" };
    }
    if (confirmation.observedAtMs >= record.dueAtMs) {
      return { canSuppress: false, reason: "STEP_AT_OR_AFTER_DUE" };
    }
    if (confirmation.steps < STEP_THRESHOLD) {
      return { canSuppress: false, reason: "NOT_EXPLICIT_CONFIRMATION" };
    }
    return { canSuppress: true, reason: "STEP_THRESHOLD_REACHED" };
  }

  if (confirmation.kind !== "EXPLICIT_AWAKE_CONFIRMATION") {
    return { canSuppress: false, reason: "NOT_EXPLICIT_CONFIRMATION" };
  }

  if (confirmation.cycleId !== record.cycleId) {
    return { canSuppress: false, reason: "WRONG_CYCLE" };
  }

  if (confirmation.mainAlarmId !== record.mainAlarmId) {
    return { canSuppress: false, reason: "WRONG_MAIN_ALARM" };
  }

  if (
    typeof record.checkInNotificationId !== "string" ||
    confirmation.checkInNotificationId !== record.checkInNotificationId
  ) {
    return { canSuppress: false, reason: "WRONG_CHECK_IN" };
  }

  if (!Number.isFinite(confirmation.confirmedAtMs)) {
    return { canSuppress: false, reason: "INVALID_CONFIRMATION_TIME" };
  }

  if (confirmation.confirmedAtMs < record.armedAtMs) {
    return { canSuppress: false, reason: "STALE_CONFIRMATION" };
  }

  if (
    confirmation.confirmedAtMs <
    getCheckInAtMs(record.dueAtMs, record.armedAtMs)
  ) {
    return {
      canSuppress: false,
      reason: "CONFIRMATION_BEFORE_CHECK_IN_WINDOW",
    };
  }

  if (confirmation.confirmedAtMs >= record.dueAtMs) {
    return {
      canSuppress: false,
      reason: "CONFIRMATION_AT_OR_AFTER_DUE",
    };
  }

  if (confirmation.confirmedAtMs > nowMs) {
    return { canSuppress: false, reason: "CONFIRMATION_IN_FUTURE" };
  }

  return { canSuppress: true, reason: "CONFIRMED_AWAKE" };
}

/**
 * An authorized attempt is not a successful suppression until cancellation is
 * confirmed. Errors and false/unknown results keep the alarm armed.
 */
export function finalizeSuppression(
  decision: SuppressionDecision,
  cancellationSucceeded: boolean | undefined,
): SuppressionOutcome {
  return decision.canSuppress && cancellationSucceeded === true
    ? "SUPPRESSED"
    : "ALARM_REMAINS_ARMED";
}

function isValidAlarmRecord(record: AlarmRecord): boolean {
  return (
    typeof record.cycleId === "string" &&
    record.cycleId.length > 0 &&
    typeof record.mainAlarmId === "string" &&
    record.mainAlarmId.length > 0 &&
    Number.isFinite(record.armedAtMs) &&
    Number.isFinite(record.dueAtMs) &&
    record.dueAtMs - record.armedAtMs >= MIN_ARM_LEAD_MS
  );
}
