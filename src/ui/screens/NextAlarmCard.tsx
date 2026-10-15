import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { STEP_THRESHOLD } from '../../alarmPolicy';
import type { StoredAlarm, StoredAlarmDefinition } from '../../alarmStorage';
import { formatLeadTime, type StepGuidance } from '../../homeStatus';
import type { TextContext } from '../../i18n';
import type { ScreenScrollPolicy } from '../../screenScroll';
import type { StepWindowPhase } from '../../stepWindow';
import { GlassSurface } from '../GlassSurface';
import { HOME_COLORS } from '../tokens';
import { sharedStyles } from './sharedStyles';
import { ALARM_SUMMARY_CARD_HEIGHT } from './layout';

interface NextAlarmCardProps {
  text: TextContext;
  monitoringCycle: StoredAlarm;
  monitoringDefinition: StoredAlarmDefinition;
  nowMs: number;
  screenScroll: ScreenScrollPolicy;
  stepGuidance: StepGuidance;
  stepWindowPhase: StepWindowPhase | null;
  stepWindowStartLabel: string;
  windowStepCount: number;
  skipAction: ReactNode;
  openNotificationSettings(): void;
}

export function NextAlarmCard({
  text,
  monitoringCycle,
  monitoringDefinition,
  nowMs,
  screenScroll,
  stepGuidance,
  stepWindowPhase,
  stepWindowStartLabel,
  windowStepCount,
  skipAction,
  openNotificationSettings,
}: NextAlarmCardProps) {
  const { messages, formatter } = text;
  return (
    <GlassSurface
      blurTint="systemUltraThinMaterialDark"
      fallbackColor={HOME_COLORS.summaryBackdrop}
      glassEffectStyle="regular"
      intensity={76}
      reducedTransparencyColor="#173A68"
      style={[
        styles.nextAlarmCard,
        (screenScroll.scroll || !stepGuidance.showProgress) &&
          sharedStyles.alarmSummaryCardAccessible,
      ]}
      testID="next-alarm-summary"
      tintColor="#244F8666"
    >
      <View style={styles.nextAlarmHeader}>
        <View>
          <Text style={styles.nextAlarmLabel}>{messages.alarmList.nextAlarm}</Text>
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.5}
            numberOfLines={1}
            style={styles.nextAlarmTime}
          >
            {formatter.clock(
              monitoringDefinition.hour,
              monitoringDefinition.minute,
            )}
          </Text>
        </View>
        <View style={styles.nextAlarmMeta}>
          <Text style={styles.nextAlarmDate}>
            {formatter.day(monitoringCycle.dueAtMs)}
          </Text>
          <Text style={styles.nextAlarmCountdown}>
            {formatLeadTime(monitoringCycle.dueAtMs - nowMs, messages)}
          </Text>
        </View>
      </View>
      {stepWindowPhase === 'before' ? (
        <View
          accessible
          accessibilityLabel={messages.steps.windowStartsSpoken(
            stepWindowStartLabel,
            STEP_THRESHOLD,
          )}
          style={[styles.progressCopy, styles.progressCopyPending]}
        >
          <Text style={styles.progressText}>
            {messages.steps.windowStarts(stepWindowStartLabel)}
          </Text>
          <Text style={styles.progressStatus}>
            {messages.steps.whileOpen(STEP_THRESHOLD)}
          </Text>
        </View>
      ) : !stepGuidance.showProgress ? (
        <View style={[styles.progressCopy, styles.progressCopyPending]}>
          <Text style={styles.progressStatus}>
            {stepGuidance.message}
            {stepGuidance.code ? (
              <Text style={styles.errorCodeInline}>
                {'\n'}{messages.common.errorCode} {stepGuidance.code}
              </Text>
            ) : null}
          </Text>
          {stepGuidance.canOpenSettings ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={4}
              onPress={openNotificationSettings}
              style={({ pressed }) => [
                styles.stepSettingsButton,
                pressed && sharedStyles.buttonDimmed,
              ]}
            >
              <Text style={styles.stepSettingsButtonText}>
                {messages.common.openSettings}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          <View
            accessible
            accessibilityLabel={messages.steps.progressLabel}
            accessibilityRole="progressbar"
            accessibilityValue={{
              max: STEP_THRESHOLD,
              min: 0,
              now: Math.min(windowStepCount, STEP_THRESHOLD),
              text: messages.common.stepsOf(windowStepCount, STEP_THRESHOLD),
            }}
            style={styles.progressTrack}
          >
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.min(
                    100,
                    (windowStepCount / STEP_THRESHOLD) * 100,
                  )}%`,
                },
              ]}
            />
          </View>
          <View style={styles.progressCopy}>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={styles.progressText}
            >
              {messages.steps.progress(windowStepCount, STEP_THRESHOLD)}
            </Text>
            <Text style={styles.progressStatus}>{stepGuidance.message}</Text>
          </View>
        </>
      )}
      {skipAction}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  nextAlarmCard: {
    height: ALARM_SUMMARY_CARD_HEIGHT,
    overflow: 'hidden',
    marginTop: 12,
    padding: 17,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.52)',
    borderRadius: 25,
    backgroundColor: 'rgba(8, 30, 65, 0.1)',
    ...Platform.select({
      web: { boxShadow: '0 14px 30px rgba(0, 10, 31, 0.2)' },
      default: {
        shadowColor: '#000A1F',
        shadowOpacity: 0.2,
        shadowRadius: 26,
        shadowOffset: { width: 0, height: 14 },
        elevation: 5,
      },
    }),
  },
  nextAlarmGlow: {
    position: 'absolute',
    top: -64,
    right: -30,
    width: 170,
    height: 170,
    borderRadius: 85,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    backgroundColor: 'rgba(152, 186, 246, 0.12)',
    pointerEvents: 'none',
  },
  nextAlarmHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  nextAlarmLabel: {
    color: HOME_COLORS.summaryText.label,
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  nextAlarmTime: {
    marginTop: 2,
    color: '#FFFFFF',
    fontSize: 48,
    lineHeight: 50,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1.6,
  },
  nextAlarmMeta: {
    flexShrink: 1,
    alignItems: 'flex-end',
  },
  nextAlarmDate: {
    color: HOME_COLORS.summaryText.date,
    fontSize: 12,
    fontWeight: '900',
  },
  nextAlarmCountdown: {
    marginTop: 4,
    textAlign: 'right',
    color: HOME_COLORS.summaryText.countdown,
    fontSize: 12,
  },
  progressTrack: {
    height: 6,
    marginTop: 8,
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: HOME_COLORS.progressTrack,
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: HOME_COLORS.progressFill,
  },
  progressCopy: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 7,
  },
  progressCopyPending: {
    // Keeps the copy where it sits when the progress track is shown.
    marginTop: 21,
  },
  progressText: {
    flexShrink: 1,
    color: HOME_COLORS.summaryText.progress,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
  },
  errorCodeInline: {
    fontSize: 10,
    lineHeight: 14,
    opacity: 0.85,
  },
  progressStatus: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 120,
    color: HOME_COLORS.summaryText.status,
    fontSize: 11,
    lineHeight: 15,
    textAlign: 'right',
  },
  stepSettingsButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
  stepSettingsButtonText: {
    color: '#173A68',
    fontSize: 13,
    fontWeight: '900',
  },
});
