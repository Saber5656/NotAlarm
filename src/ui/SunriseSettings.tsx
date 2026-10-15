import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SUN_REGIONS } from '../sunRegions';
import { sunStatusText } from '../sunStatusText';
import type { SunBackgroundState } from '../useSunBackground';
import { deviceChoiceSemantics, radioSemantics } from './radioSemantics';
import { useText } from './I18nContext';
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
  const { messages } = useText();
  const { preference, isBusy } = state;
  const disabled = isBusy || state.writesBlocked || resetPending;
  const status = resetPending ? 'reset-pending' : state.status;
  const deviceSelected = preference.mode === 'device';
  const device = deviceChoiceSemantics(deviceSelected, disabled, messages);

  return (
    <View style={styles.section} testID="sunrise-settings">
      <Text accessibilityRole="header" style={styles.heading}>
        {messages.sun.heading}
      </Text>
      <Text style={styles.body}>
        {messages.sun.body}
      </Text>

      <Row
        detail={messages.sun.fixedDetail}
        disabled={disabled}
        label={messages.sun.fixedLabel}
        onPress={() => void state.chooseFixed()}
        selected={preference.mode === 'fixed'}
        testID="sun-fixed"
      />

      <Text style={styles.subheading}>{messages.sun.regionHeading}</Text>
      <View style={styles.regionGrid}>
        {SUN_REGIONS.map((region) => (
          <Row
            compact
            disabled={disabled}
            key={region.id}
            label={messages.sun.regions[region.id as keyof typeof messages.sun.regions]}
            onPress={() => void state.chooseRegion(region.id)}
            selected={
              preference.mode === 'region' && preference.regionId === region.id
            }
            testID={`sun-region-${region.id}`}
          />
        ))}
      </View>

      <Pressable
        accessibilityHint={messages.sun.deviceHint}
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
          {deviceSelected ? messages.sun.deviceInUse : messages.sun.deviceUse}
        </Text>
        {device.marker ? (
          <Text style={styles.marker}>{device.marker}</Text>
        ) : null}
        <Text style={styles.detail}>
          {messages.sun.deviceDetail}
        </Text>
      </Pressable>

      {status ? (
        <Text
          accessibilityLiveRegion="polite"
          style={styles.status}
          testID="sun-status"
        >
          {sunStatusText(status, messages, {
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
  const { messages } = useText();
  const semantics = radioSemantics(selected, disabled, messages);
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
