import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SUN_REGIONS } from '../sunRegions';
import { sunStatusText } from '../sunStatusText';
import type { SunBackgroundState } from '../useSunBackground';
import { deviceChoiceSemantics, radioSemantics } from './radioSemantics';
import { UI_COLORS } from './tokens';

interface SunriseSettingsProps {
  state: SunBackgroundState;
  /** An earlier data deletion is unfinished; choices stay off until retried. */
  resetPending?: boolean;
}

/**
 * Section for the shared SettingsModal body (no sheet or entry point of its
 * own). Choices are plain selectable rows so every target is >= 44pt, reads
 * its selected state aloud, and survives the largest text size by wrapping.
 */
export function SunriseSettings({
  state,
  resetPending = false,
}: SunriseSettingsProps) {
  const { preference, isBusy } = state;
  const disabled = isBusy || state.writesBlocked || resetPending;
  const status = resetPending ? 'reset-pending' : state.status;
  const deviceSelected = preference.mode === 'device';
  const device = deviceChoiceSemantics(deviceSelected, disabled);

  return (
    <View style={styles.section} testID="sunrise-settings">
      <Text accessibilityRole="header" style={styles.heading}>
        背景の日の出・日の入り
      </Text>
      <Text style={styles.body}>
        背景の明るさを切り替える時刻だけに使います。アラームの時刻や鳴動には影響しません。
      </Text>

      <Row
        detail="日の出 6:00・日の入り 18:00（初期設定）"
        disabled={disabled}
        label="固定の時刻"
        onPress={() => void state.chooseFixed()}
        selected={preference.mode === 'fixed'}
        testID="sun-fixed"
      />

      <Text style={styles.subheading}>地域を選ぶ（位置情報は使いません）</Text>
      <View style={styles.regionGrid}>
        {SUN_REGIONS.map((region) => (
          <Row
            compact
            disabled={disabled}
            key={region.id}
            label={region.label}
            onPress={() => void state.chooseRegion(region.id)}
            selected={
              preference.mode === 'region' && preference.regionId === region.id
            }
            testID={`sun-region-${region.id}`}
          />
        ))}
      </View>

      <Pressable
        accessibilityHint="押したときだけ、おおよその現在地を一度使います。"
        accessibilityLabel={device.accessibilityLabel}
        accessibilityRole={device.accessibilityRole}
        accessibilityState={{ ...device.accessibilityState, busy: isBusy }}
        aria-checked={device['aria-checked']}
        disabled={disabled}
        onPress={() => void state.useDeviceLocation()}
        style={({ pressed }) => [
          styles.deviceButton,
          deviceSelected && styles.selected,
          pressed && styles.pressed,
          disabled && styles.disabled,
        ]}
        testID="sun-device"
      >
        <Text style={[styles.label, deviceSelected && styles.labelSelected]}>
          {deviceSelected ? '現在地を使用中（約10km単位）' : '現在地を使う'}
        </Text>
        {device.marker ? (
          <Text style={styles.marker}>{device.marker}</Text>
        ) : null}
        <Text style={styles.detail}>
          ボタンを押したときだけ、おおよその位置を一度確認します。位置は約10km単位に丸めて端末内にだけ保存し、追跡や送信はしません。
        </Text>
      </Pressable>

      {status ? (
        <Text
          accessibilityLiveRegion="polite"
          style={styles.status}
          testID="sun-status"
        >
          {sunStatusText(status, {
            scheduleActive: state.schedule !== undefined,
          })}
        </Text>
      ) : null}
    </View>
  );
}

interface RowProps {
  compact?: boolean;
  detail?: string;
  disabled: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
  testID: string;
}

function Row({
  compact = false,
  detail,
  disabled,
  label,
  onPress,
  selected,
  testID,
}: RowProps) {
  const semantics = radioSemantics(selected, disabled);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole={semantics.accessibilityRole}
      accessibilityState={semantics.accessibilityState}
      aria-checked={semantics['aria-checked']}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        compact && styles.rowCompact,
        selected && styles.selected,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={[styles.label, selected && styles.labelSelected]}>
        {label}
      </Text>
      {semantics.marker ? (
        <Text style={styles.marker}>{semantics.marker}</Text>
      ) : null}
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  heading: { color: UI_COLORS.textPrimary, fontSize: 17, fontWeight: '700' },
  subheading: {
    marginTop: 4,
    color: UI_COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  body: { color: UI_COLORS.textSecondary, fontSize: 13, lineHeight: 19 },
  regionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(49, 70, 108, 0.14)',
    borderRadius: 16,
    backgroundColor: '#EEF0F5',
  },
  rowCompact: { minWidth: 96, flexGrow: 1 },
  deviceButton: {
    minHeight: 48,
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(49, 70, 108, 0.14)',
    borderRadius: 16,
    backgroundColor: '#EEF0F5',
  },
  selected: {
    borderColor: UI_COLORS.accent,
    backgroundColor: '#E3EAFB',
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
  label: { color: UI_COLORS.textPrimary, fontSize: 15, fontWeight: '600' },
  marker: { color: UI_COLORS.accentLabel, fontSize: 12, fontWeight: '800' },
  labelSelected: { color: UI_COLORS.accentLabel, fontWeight: '800' },
  detail: { color: UI_COLORS.textMuted, fontSize: 12, lineHeight: 17 },
  status: { color: UI_COLORS.textSecondary, fontSize: 13, lineHeight: 19 },
});
