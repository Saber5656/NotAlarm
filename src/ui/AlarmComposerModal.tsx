import DateTimePicker, {
  DateTimePickerAndroid,
} from '@react-native-community/datetimepicker';
import { BlurView } from 'expo-blur';
import { useEffect } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RepeatKind, Weekday } from '../alarmSchedule';
import { GlassSurface } from './GlassSurface';
import { UI_COLORS } from './tokens';

interface AlarmComposerModalProps {
  canSubmit: boolean;
  customWeekdays: Weekday[];
  formNotice?: {
    text: string;
    tone: 'danger' | 'warning';
  };
  isBusy: boolean;
  onClose: () => void;
  onRepeatKindChange: (kind: RepeatKind) => void;
  onSubmit: () => void;
  onTimeChange: (date: Date) => void;
  onToggleWeekday: (weekday: Weekday) => void;
  repeatKind: RepeatKind;
  selectedTime: Date;
  visible: boolean;
}

const REPEAT_OPTIONS: Array<{ kind: RepeatKind; label: string }> = [
  { kind: 'today', label: '今日だけ' },
  { kind: 'daily', label: '毎日' },
  { kind: 'weekdays', label: '平日' },
  { kind: 'custom', label: '曜日指定' },
];

const WEEKDAY_OPTIONS: Array<{ value: Weekday; label: string }> = [
  { value: 1, label: '月' },
  { value: 2, label: '火' },
  { value: 3, label: '水' },
  { value: 4, label: '木' },
  { value: 5, label: '金' },
  { value: 6, label: '土' },
  { value: 0, label: '日' },
];

function formatAlarmTime(date: Date): string {
  return `${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

export function AlarmComposerModal({
  canSubmit,
  customWeekdays,
  formNotice,
  isBusy,
  onClose,
  onRepeatKindChange,
  onSubmit,
  onTimeChange,
  onToggleWeekday,
  repeatKind,
  selectedTime,
  visible,
}: AlarmComposerModalProps) {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (formNotice && visible && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibilityWithOptions(formNotice.text, {
        queue: formNotice.tone !== 'danger',
      });
    }
  }, [formNotice?.text, formNotice?.tone, visible]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const dismissTimePicker = () => {
      void DateTimePickerAndroid.dismiss('time').catch(() => undefined);
    };

    if (!visible) {
      dismissTimePicker();
    }

    return dismissTimePicker;
  }, [visible]);

  const closeIfIdle = () => {
    if (!isBusy) {
      if (Platform.OS === 'android') {
        void DateTimePickerAndroid.dismiss('time').catch(() => undefined);
      }
      onClose();
    }
  };

  const openAndroidTimePicker = () => {
    DateTimePickerAndroid.open({
      display: 'default',
      is24Hour: true,
      mode: 'time',
      onChange: (event, date) => {
        if (event.type === 'set' && date) {
          onTimeChange(date);
        }
      },
      value: selectedTime,
    });
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={closeIfIdle}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.modalRoot}>
        <BlurView
          experimentalBlurMethod="none"
          intensity={34}
          style={StyleSheet.absoluteFill}
          tint="systemThinMaterialDark"
        />
        <Pressable
          accessible={false}
          onPress={closeIfIdle}
          style={styles.backdrop}
        />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[
            styles.keyboardLayer,
            { paddingBottom: Math.max(insets.bottom, 10) },
          ]}
        >
          <GlassSurface
            accessibilityLabel="アラームを追加"
            accessibilityViewIsModal
            blurTint="systemThickMaterialLight"
            intensity={88}
            reducedTransparencyColor="#F2F4FA"
            style={styles.sheet}
            tintColor="#F7F8FFB8"
          >
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleCopy}>
                <Text style={styles.eyebrow}>NEW ALARM</Text>
                <Text style={styles.sheetTitle}>アラームを追加</Text>
                <Text style={styles.sheetSubtitle}>
                  時刻と繰り返しを選んでください
                </Text>
              </View>
              <Pressable
                accessibilityLabel="閉じる"
                accessibilityRole="button"
                disabled={isBusy}
                hitSlop={12}
                onPress={closeIfIdle}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text style={styles.closeGlyph}>×</Text>
              </Pressable>
            </View>

            <ScrollView
              bounces={false}
              contentContainerStyle={styles.formContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
              style={styles.formScroll}
              testID="alarm-composer-scroll"
            >
              <View style={styles.timePanel}>
                <View style={styles.timeCopy}>
                  <Text style={styles.fieldLabel}>時刻</Text>
                  <Text style={styles.timePreview}>
                    {formatAlarmTime(selectedTime)}
                  </Text>
                </View>
                {Platform.OS === 'web' ? (
                  <View style={styles.deviceOnlyPicker}>
                    <Text style={styles.deviceOnlyPickerText}>実機で選択</Text>
                  </View>
                ) : Platform.OS === 'android' ? (
                  <Pressable
                    accessibilityLabel="アラーム時刻を選択"
                    accessibilityRole="button"
                    disabled={isBusy}
                    hitSlop={4}
                    onPress={openAndroidTimePicker}
                    style={({ pressed }) => [
                      styles.deviceOnlyPicker,
                      (pressed || isBusy) && styles.buttonPressed,
                    ]}
                  >
                    <Text style={styles.deviceOnlyPickerText}>時刻を変更</Text>
                  </Pressable>
                ) : (
                  <DateTimePicker
                    accessibilityLabel="アラーム時刻を選択"
                    display="compact"
                    mode="time"
                    onChange={(_, date) => date && onTimeChange(date)}
                    value={selectedTime}
                  />
                )}
              </View>

              <Text style={styles.fieldLabel}>繰り返し</Text>
              <View style={styles.optionGrid}>
                {REPEAT_OPTIONS.map((option) => {
                  const selected = repeatKind === option.kind;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={option.kind}
                      onPress={() => onRepeatKindChange(option.kind)}
                      style={({ pressed }) => [
                        styles.optionButton,
                        selected && styles.optionButtonSelected,
                        pressed && styles.buttonPressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.optionButtonText,
                          selected && styles.optionButtonTextSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {repeatKind === 'custom' ? (
                <View style={styles.weekdayBlock}>
                  <Text style={styles.weekdayHint}>鳴らす曜日</Text>
                  <View style={styles.weekdayRow}>
                    {WEEKDAY_OPTIONS.map((option) => {
                      const selected = customWeekdays.includes(option.value);
                      return (
                        <Pressable
                          accessibilityLabel={`${option.label}曜日`}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          hitSlop={2}
                          key={option.value}
                          onPress={() => onToggleWeekday(option.value)}
                          style={({ pressed }) => [
                            styles.weekdayButton,
                            selected && styles.weekdayButtonSelected,
                            pressed && styles.buttonPressed,
                          ]}
                        >
                          <Text
                            style={[
                              styles.weekdayButtonText,
                              selected && styles.weekdayButtonTextSelected,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  {customWeekdays.length === 0 ? (
                    <Text style={styles.weekdayError}>
                      曜日を1つ以上選択してください
                    </Text>
                  ) : null}
                </View>
              ) : null}

              <View style={styles.behaviorNote}>
                <View style={styles.stepBadge}>
                  <Text style={styles.stepBadgeText}>100</Text>
                </View>
                <View style={styles.behaviorCopy}>
                  <Text style={styles.behaviorTitle}>100歩で起床を確認</Text>
                  <Text style={styles.behaviorText}>
                    対象のアラームだけを停止し、ほかの時刻には影響しません。
                  </Text>
                </View>
              </View>

            </ScrollView>

            <View style={styles.sheetFooter}>
              {formNotice ? (
                <View
                  accessibilityLiveRegion={
                    formNotice.tone === 'danger' ? 'assertive' : 'polite'
                  }
                  accessibilityRole={
                    formNotice.tone === 'danger' ? 'alert' : undefined
                  }
                  style={[
                    styles.formNotice,
                    formNotice.tone === 'warning' && styles.formNoticeWarning,
                  ]}
                >
                  <Text
                    style={[
                      styles.formNoticeText,
                      formNotice.tone === 'warning' &&
                        styles.formNoticeTextWarning,
                    ]}
                  >
                    {formNotice.text}
                  </Text>
                </View>
              ) : null}
              {Platform.OS === 'web' ? (
                <Text style={styles.deviceHint}>登録はExpo Go実機で行えます</Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                disabled={!canSubmit}
                onPress={onSubmit}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (!canSubmit || pressed) && styles.primaryButtonInactive,
                ]}
              >
                {isBusy ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryButtonText}>この内容で追加</Text>
                )}
              </Pressable>
            </View>
          </GlassSurface>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    backgroundColor: 'rgba(18, 24, 45, 0.22)',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  keyboardLayer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    pointerEvents: 'box-none',
  },
  sheet: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '90%',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 30,
    backgroundColor: 'rgba(247, 249, 255, 0.72)',
    ...Platform.select({
      web: { boxShadow: '0 18px 34px rgba(38, 53, 101, 0.24)' },
      default: {
        shadowColor: '#263565',
        shadowOpacity: 0.24,
        shadowRadius: 34,
        shadowOffset: { width: 0, height: 18 },
        elevation: 18,
      },
    }),
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(117, 132, 180, 0.16)',
  },
  sheetTitleCopy: {
    flex: 1,
  },
  eyebrow: {
    color: UI_COLORS.accentLabel,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  sheetTitle: {
    marginTop: 5,
    color: '#17213D',
    fontSize: 23,
    fontWeight: '900',
    letterSpacing: -0.6,
  },
  sheetSubtitle: {
    marginTop: 4,
    color: UI_COLORS.textMuted,
    fontSize: 12,
  },
  closeButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.58)',
  },
  closeGlyph: {
    marginTop: -2,
    color: UI_COLORS.textMuted,
    fontSize: 25,
    fontWeight: '400',
    lineHeight: 27,
  },
  formScroll: {
    flexShrink: 1,
  },
  formContent: {
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 12,
  },
  timePanel: {
    minHeight: 94,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    marginBottom: 20,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.2)',
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
  },
  timeCopy: {
    flexShrink: 1,
  },
  fieldLabel: {
    marginBottom: 9,
    color: UI_COLORS.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  timePreview: {
    color: '#17213D',
    fontSize: 35,
    fontWeight: '900',
    letterSpacing: -1.2,
  },
  deviceOnlyPicker: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.2)',
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.48)',
  },
  deviceOnlyPickerText: {
    color: UI_COLORS.textMuted,
    fontSize: 10,
    fontWeight: '800',
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionButton: {
    minWidth: '47%',
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.24)',
    borderRadius: 15,
    backgroundColor: 'rgba(255, 255, 255, 0.46)',
  },
  optionButtonSelected: {
    borderColor: '#7183EE',
    backgroundColor: 'rgba(222, 227, 255, 0.9)',
  },
  optionButtonText: {
    color: UI_COLORS.textMuted,
    fontSize: 13,
    fontWeight: '800',
  },
  optionButtonTextSelected: {
    color: '#3E50BE',
  },
  weekdayBlock: {
    marginTop: 17,
  },
  weekdayHint: {
    marginBottom: 9,
    color: UI_COLORS.textMuted,
    fontSize: 11,
    fontWeight: '800',
  },
  weekdayRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: 4,
  },
  weekdayButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.26)',
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
  },
  weekdayButtonSelected: {
    borderColor: UI_COLORS.accent,
    backgroundColor: UI_COLORS.accent,
  },
  weekdayButtonText: {
    color: UI_COLORS.textMuted,
    fontSize: 12,
    fontWeight: '900',
  },
  weekdayButtonTextSelected: {
    color: '#FFFFFF',
  },
  weekdayError: {
    marginTop: 8,
    color: '#A34840',
    fontSize: 10,
    fontWeight: '700',
  },
  behaviorNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 20,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(88, 177, 168, 0.18)',
    borderRadius: 17,
    backgroundColor: 'rgba(220, 246, 242, 0.68)',
  },
  stepBadge: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: UI_COLORS.positive,
  },
  stepBadgeText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  behaviorCopy: {
    flex: 1,
  },
  behaviorTitle: {
    color: '#244A49',
    fontSize: 12,
    fontWeight: '900',
  },
  behaviorText: {
    marginTop: 3,
    color: '#557274',
    fontSize: 11,
    lineHeight: 16,
  },
  formNotice: {
    marginBottom: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(217, 119, 108, 0.35)',
    borderRadius: 14,
    backgroundColor: 'rgba(255, 235, 232, 0.78)',
  },
  formNoticeWarning: {
    borderColor: 'rgba(169, 116, 0, 0.32)',
    backgroundColor: 'rgba(255, 248, 222, 0.9)',
  },
  formNoticeText: {
    color: '#8F3C34',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
  },
  formNoticeTextWarning: {
    color: '#6F4C00',
  },
  sheetFooter: {
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: 'rgba(117, 132, 180, 0.16)',
  },
  deviceHint: {
    marginBottom: 8,
    color: UI_COLORS.textMuted,
    fontSize: 11,
    textAlign: 'center',
  },
  primaryButton: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: '#5367DE',
    ...Platform.select({
      web: { boxShadow: '0 8px 16px rgba(74, 95, 215, 0.24)' },
      default: {
        shadowColor: '#4A5FD7',
        shadowOpacity: 0.24,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
        elevation: 5,
      },
    }),
  },
  primaryButtonInactive: {
    backgroundColor: '#9BA5C7',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
  },
  buttonPressed: {
    transform: [{ scale: 0.98 }],
  },
});
