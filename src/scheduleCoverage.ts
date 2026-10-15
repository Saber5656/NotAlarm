import type { StoredAlarmDefinition } from './alarmStorage';
import type { AlarmQueueStatus } from './scheduleReconciliation';

/**
 * How far ahead an alarm is reserved with the OS. Only monitoring cycles
 * (armed / step_candidate) due after now count: ringing, stopped and past
 * cycles will not ring again.
 */
export type ScheduleCoverage =
  | { kind: 'off' }
  | { kind: 'none' }
  | {
      kind: 'scheduled';
      remaining: number;
      lastDueAtMs: number;
      isRunningLow: boolean;
    };

export interface ScheduleCoverageLine {
  text: string;
  isWarning: boolean;
}

export function describeScheduleCoverage(
  definition: StoredAlarmDefinition,
  nowMs: number,
): ScheduleCoverage {
  if (!definition.enabled) {
    return { kind: 'off' };
  }

  const upcomingDueTimes = definition.cycles
    .filter(
      (cycle) =>
        (cycle.phase === 'armed' || cycle.phase === 'step_candidate') &&
        cycle.dueAtMs > nowMs,
    )
    .map((cycle) => cycle.dueAtMs);
  if (upcomingDueTimes.length === 0) {
    return { kind: 'none' };
  }

  return {
    kind: 'scheduled',
    remaining: upcomingDueTimes.length,
    lastDueAtMs: Math.max(...upcomingDueTimes),
    // Later occurrences are only reserved while the app runs, so a repeating
    // alarm down to its last occurrence stops after it unless the app opens.
    isRunningLow:
      definition.repeat.kind !== 'today' && upcomingDueTimes.length <= 1,
  };
}

export interface ScheduleCoverageLineOptions {
  /**
   * The latest refill attempt for this alarm reported an issue or skipped it,
   * so opening the app would not reserve the later occurrences either.
   */
  refillFailed?: boolean;
  /**
   * What the latest comparison with the OS queue found. Stored occurrences are
   * not the OS queue, so an unverifiable or missing queue must not read as
   * reserved.
   */
  queueStatus?: AlarmQueueStatus;
}

export function getScheduleCoverageLine(
  coverage: ScheduleCoverage,
  formatDate: (timestampMs: number) => string,
  options: ScheduleCoverageLineOptions = {},
): ScheduleCoverageLine {
  switch (coverage.kind) {
    case 'off':
      return { text: '通知は予約されていません', isWarning: false };
    case 'none':
      return { text: '予約がありません', isWarning: true };
    case 'scheduled': {
      if (options.queueStatus === 'unverified') {
        return { text: '通知の予約状況を確認できません', isWarning: true };
      }
      if (options.queueStatus === 'missing') {
        return {
          text: '通知が端末に見つかりません・再予約できませんでした',
          isWarning: true,
        };
      }
      if (options.queueStatus === 'capacity_full') {
        return {
          text: '通知の上限に達しており、再予約できませんでした',
          isWarning: true,
        };
      }
      if (options.queueStatus === 'duplicated') {
        return {
          text: '古い時刻の予約が残っており、2回鳴る可能性があります',
          isWarning: true,
        };
      }
      const until = `${formatDate(coverage.lastDueAtMs)}まで予約済み`;
      if (options.queueStatus === 'check_in_missing') {
        return {
          text: `${until}・起床確認通知が予約されていません`,
          isWarning: true,
        };
      }
      if (!coverage.isRunningLow) {
        return { text: until, isWarning: false };
      }
      return {
        text: options.refillFailed
          ? `${until}・先の分を予約できませんでした`
          : `${until}・アプリを開くと先の分を予約します`,
        isWarning: true,
      };
    }
  }
}
