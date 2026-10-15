import { StyleSheet, Text, View } from 'react-native';

import type { StoredAlarmDefinition } from '../../alarmStorage';
import type { TextContext } from '../../i18n';
import type { ScreenScrollPolicy } from '../../screenScroll';
import { GlassSurface } from '../GlassSurface';
import { HOME_COLORS } from '../tokens';
import { sharedStyles } from './sharedStyles';
import { ALARM_SUMMARY_CARD_HEIGHT } from './layout';

interface IdleCardProps {
  text: TextContext;
  alarms: StoredAlarmDefinition[];
  screenScroll: ScreenScrollPolicy;
}

export function IdleCard({ text, alarms, screenScroll }: IdleCardProps) {
  const { messages } = text;
  return (
    <GlassSurface
      blurTint="systemUltraThinMaterialDark"
      fallbackColor={HOME_COLORS.summaryBackdrop}
      glassEffectStyle="regular"
      intensity={76}
      reducedTransparencyColor="#173A68"
      style={[
        styles.idleCard,
        screenScroll.scroll &&
          sharedStyles.alarmSummaryCardAccessible,
      ]}
      testID="next-alarm-summary"
      tintColor="#244F8666"
    >
      <View style={styles.idleIcon}>
        <Text style={styles.idleIconText}>☾</Text>
      </View>
      <View style={styles.idleCopy}>
        <Text style={styles.idleTitle}>{messages.alarmList.noNextTitle}</Text>
        <Text style={styles.idleText}>
          {alarms.length === 0
            ? messages.alarmList.noNextEmpty
            : alarms.every((alarm) => !alarm.enabled)
              ? messages.alarmList.noNextOff
              : messages.alarmList.noNextNone}
        </Text>
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  idleCard: {
    height: ALARM_SUMMARY_CARD_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    marginTop: 12,
    padding: 17,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.52)',
    borderRadius: 24,
    backgroundColor: 'rgba(8, 30, 65, 0.1)',
  },
  idleIcon: {
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  idleIconText: {
    color: '#DCE9FF',
    fontSize: 25,
  },
  idleCopy: {
    flex: 1,
  },
  idleTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  idleText: {
    marginTop: 4,
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 11,
    lineHeight: 16,
  },
});
