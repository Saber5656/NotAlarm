import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import {
  MAX_ALARM_COUNT,
  formatRepeatLabel,
} from '../../alarmSchedule';
import type { StoredAlarmDefinition } from '../../alarmStorage';
import { describeTodayOnlyExpiry } from '../../homeStatus';
import type { TextContext } from '../../i18n';
import type { getNotificationDeliveryWarningCopy } from '../../notificationDelivery';
import {
  describeScheduleCoverage,
  getScheduleCoverageLine,
} from '../../scheduleCoverage';
import type { AlarmQueueStatus } from '../../scheduleReconciliation';
import { nextCycleForDefinition } from '../../app/core/formatters';
import { HOME_COLORS, UI_COLORS } from '../tokens';

interface AlarmListPanelProps {
  text: TextContext;
  alarms: StoredAlarmDefinition[];
  orderedAlarms: StoredAlarmDefinition[];
  nowMs: number;
  loadFailed: boolean;
  listLocked: boolean;
  isBusy: boolean;
  deletionPending: boolean;
  editAvailable: boolean;
  refillFailedAlarmIds: ReadonlySet<string>;
  queueStatuses: Record<string, AlarmQueueStatus>;
  suppressedOccurrence: { alarmId: string; text: string } | null;
  deliveryWarningCopy: ReturnType<typeof getNotificationDeliveryWarningCopy> | null;
  toggleAlarm(definition: StoredAlarmDefinition, enabled: boolean): Promise<unknown>;
  openEditComposer(definition: StoredAlarmDefinition): Promise<unknown>;
  confirmDeleteAlarm(definition: StoredAlarmDefinition): void;
}

export function AlarmListPanel({
  text,
  alarms,
  orderedAlarms,
  nowMs,
  loadFailed,
  listLocked,
  isBusy,
  deletionPending,
  editAvailable,
  refillFailedAlarmIds,
  queueStatuses,
  suppressedOccurrence,
  deliveryWarningCopy,
  toggleAlarm,
  openEditComposer,
  confirmDeleteAlarm,
}: AlarmListPanelProps) {
  const { messages, formatter } = text;
  return (
    <View
      accessibilityElementsHidden={listLocked}
      importantForAccessibility={
        listLocked ? 'no-hide-descendants' : 'auto'
      }
      style={[styles.listPanel, listLocked && styles.listPanelLocked]}
    >
      <View style={styles.listHeader}>
        <View>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {messages.alarmList.listHeading}
          </Text>
        </View>
        <View style={styles.alarmCountBadge}>
          <Text style={styles.alarmCount}>
            {alarms.length} / {MAX_ALARM_COUNT}
          </Text>
        </View>
      </View>

      <ScrollView
        bounces={orderedAlarms.length > 1}
        contentContainerStyle={styles.alarmScrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator={orderedAlarms.length > 1}
        style={styles.alarmScroll}
        testID="alarm-list-scroll"
      >

    {orderedAlarms.length === 0 && loadFailed ? (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyTitle}>
          {messages.storageLoadFailed.title}
        </Text>
        <Text style={styles.emptyText}>
          {messages.storageLoadFailed.body}
        </Text>
      </View>
    ) : orderedAlarms.length === 0 ? (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyTitle}>{messages.alarmList.emptyTitle}</Text>
        <Text style={styles.emptyText}>
          {messages.alarmList.emptyBody}
        </Text>
      </View>
    ) : (
      <View style={styles.alarmList}>
        {orderedAlarms.map((definition) => {
          const nextCycle = nextCycleForDefinition(definition, nowMs);
          const coverageLine = getScheduleCoverageLine(
            describeScheduleCoverage(definition, nowMs),
            text,
            {
              refillFailed: refillFailedAlarmIds.has(definition.id),
              queueStatus: queueStatuses[definition.id],
            },
          );
          const todayExpiry = describeTodayOnlyExpiry(definition, nowMs, text);
          const repeatLabel = formatRepeatLabel(
            definition.repeat,
            messages,
            formatter,
          );
          const repeatA11y = todayExpiry
            ? todayExpiry.a11yLabel
            : repeatLabel;
          const alarmClock = formatter.clock(
            definition.hour,
            definition.minute,
          );
          const scheduleLineWarns =
            definition.enabled &&
            (deliveryWarningCopy !== null || coverageLine.isWarning);
          const scheduleLineText = todayExpiry
            ? todayExpiry.explanation
            : definition.enabled && deliveryWarningCopy
              ? deliveryWarningCopy.scheduleLine
              : coverageLine.text;
          return (
            <View
              key={definition.id}
              style={[
                styles.alarmCard,
                !definition.enabled && styles.alarmCardDisabled,
              ]}
            >
              <View style={styles.alarmCardMain}>
                <View style={styles.alarmCardCopy}>
                  <Text
                    adjustsFontSizeToFit
                    minimumFontScale={0.5}
                    numberOfLines={1}
                    style={[
                      styles.alarmTime,
                      !definition.enabled && styles.textDisabled,
                    ]}
                  >
                    {alarmClock}
                  </Text>
                  <Text style={styles.repeatText}>
                    {todayExpiry ? todayExpiry.rowLabel : repeatLabel}
                    {todayExpiry
                      ? ''
                      : nextCycle
                        ? messages.alarmList.nextOccurrence(
                            formatter.day(nextCycle.dueAtMs),
                          )
                        : definition.enabled
                          ? messages.alarmList.noNextOccurrence
                          : messages.alarmList.off}
                  </Text>
                </View>
                <Switch
                  accessibilityHint={
                    todayExpiry && !definition.enabled
                      ? messages.alarmList.toggleHintEnded
                      : messages.alarmList.toggleHintOn
                  }
                  accessibilityLabel={messages.alarmList.rowSpoken(
                    alarmClock,
                    repeatA11y,
                  )}
                  disabled={
                    isBusy ||
                    listLocked ||
                    deletionPending ||
                    Platform.OS === 'web' ||
                    (todayExpiry !== null && !definition.enabled)
                  }
                  onValueChange={(enabled) =>
                    void toggleAlarm(definition, enabled)
                  }
                  trackColor={{ false: '#59616B', true: '#34C759' }}
                  thumbColor="#FFFFFF"
                  value={definition.enabled}
                />
              </View>
              {suppressedOccurrence?.alarmId === definition.id &&
              definition.enabled ? (
                <Text style={styles.rowSuppressedText}>
                  ✓ {suppressedOccurrence.text}
                </Text>
              ) : null}
              <View style={styles.alarmCardFooter}>
                <Text
                  accessibilityLabel={
                    scheduleLineWarns
                      ? `${messages.alarmList.warningLabel}: ${scheduleLineText}`
                      : undefined
                  }
                  style={[
                    styles.scheduleSummary,
                    scheduleLineWarns && styles.scheduleSummaryWarning,
                  ]}
                >
                  {scheduleLineWarns ? '⚠ ' : ''}
                  {scheduleLineText}
                </Text>
                <View style={styles.alarmCardActions}>
                <Pressable
                  accessibilityHint={messages.edit.editHint}
                  accessibilityLabel={messages.edit.editSpoken(
                    alarmClock,
                    repeatA11y,
                  )}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !editAvailable }}
                  disabled={!editAvailable}
                  onPress={() => void openEditComposer(definition)}
                  style={styles.editButton}
                >
                  <Text style={styles.editText}>{messages.edit.editLabel}</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={messages.alarmList.deleteSpoken(
                    alarmClock,
                    repeatA11y,
                  )}
                  accessibilityRole="button"
                  disabled={isBusy || listLocked || deletionPending}
                  onPress={() => confirmDeleteAlarm(definition)}
                  style={styles.deleteButton}
                >
                  <Text style={styles.deleteText}>{messages.common.delete}</Text>
                </Pressable>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    )}

    {Platform.OS === 'web' ? (
      <View style={styles.deviceNotice}>
        <Text style={styles.deviceNoticeText}>
          {messages.alarmList.webOnly}
        </Text>
      </View>
    ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  listPanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    marginTop: 10,
    marginBottom: 1,
    borderWidth: 0,
    backgroundColor: HOME_COLORS.listBackdrop,
    borderRadius: 16,
  },
  listPanelLocked: {
    opacity: 0.45,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingTop: 13,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.18)',
  },
  sectionTitle: {
    color: '#E9EDF2',
    fontSize: 13,
    fontWeight: '500',
  },
  sectionHint: {
    marginTop: 2,
    color: UI_COLORS.textMuted,
    fontSize: 9,
  },
  alarmCountBadge: {
    minWidth: 48,
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 0,
    borderRadius: 999,
    backgroundColor: 'transparent',
  },
  alarmCount: {
    color: HOME_COLORS.listText.count,
    fontSize: 11,
    fontWeight: '900',
  },
  alarmScroll: {
    flex: 1,
    minHeight: 0,
  },
  alarmScrollContent: {
    flexGrow: 1,
    padding: 0,
    paddingBottom: 13,
  },
  alarmList: {
    gap: 0,
  },
  alarmCard: {
    paddingVertical: 14,
    paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    backgroundColor: 'transparent',
  },
  alarmCardDisabled: {
    backgroundColor: 'transparent',
  },
  alarmCardMain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  alarmCardCopy: {
    flex: 1,
  },
  alarmTime: {
    color: '#FFFFFF',
    fontSize: 40,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
  },
  textDisabled: {
    color: HOME_COLORS.listText.disabledTime,
  },
  repeatText: {
    marginTop: 3,
    color: HOME_COLORS.listText.repeat,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '400',
  },
  alarmCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 0,
  },
  scheduleSummary: {
    color: HOME_COLORS.listText.schedule,
    fontSize: 12,
    flex: 1,
    paddingRight: 8,
  },
  scheduleSummaryWarning: {
    color: HOME_COLORS.listText.warning,
    fontWeight: '700',
  },
  alarmCardActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  editButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  editText: {
    color: HOME_COLORS.listText.repeat,
    fontSize: 12,
    fontWeight: '500',
  },
  deleteButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: {
    color: HOME_COLORS.listText.delete,
    fontSize: 12,
    fontWeight: '500',
  },
  emptyCard: {
    flex: 1,
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 24,
    backgroundColor: 'transparent',
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },
  emptyText: {
    maxWidth: 300,
    marginTop: 6,
    color: HOME_COLORS.listText.empty,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  rowSuppressedText: {
    marginTop: 4,
    color: HOME_COLORS.listText.repeat,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
  },
  deviceNotice: {
    marginTop: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(210, 153, 58, 0.24)',
    borderRadius: 14,
    backgroundColor: 'rgba(255, 247, 222, 0.68)',
  },
  deviceNoticeText: {
    color: '#86611E',
    fontSize: 10,
    lineHeight: 15,
    fontWeight: '700',
  },
});
