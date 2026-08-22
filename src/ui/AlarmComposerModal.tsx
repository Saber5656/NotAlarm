import DateTimePicker, {
  DateTimePickerAndroid,
} from '@react-native-community/datetimepicker';
import { BlurView } from 'expo-blur';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RepeatKind, Weekday } from '../alarmSchedule';
import { parseAlarmTimeInput } from '../alarmTime';
import { GlassSurface } from './GlassSurface';
import { LiquidRepeatSelector } from './LiquidRepeatSelector';
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

function sanitizeClockInput(value: string): string {
  return value
    .replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    )
    .replace(/\D/g, '')
    .slice(0, 2);
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
  const { fontScale } = useWindowDimensions();
  const usesLargeText = fontScale > 1.3;
  const minuteInputRef = useRef<TextInput>(null);
  const [isTimeEditing, setIsTimeEditing] = useState(false);
  const [draftHour, setDraftHour] = useState(
    selectedTime.getHours().toString().padStart(2, '0'),
  );
  const [draftMinute, setDraftMinute] = useState(
    selectedTime.getMinutes().toString().padStart(2, '0'),
  );
  const [timeInputError, setTimeInputError] = useState<string | null>(null);

  useEffect(() => {
    if (formNotice && visible && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibilityWithOptions(formNotice.text, {
        queue: formNotice.tone !== 'danger',
      });
    }
  }, [formNotice?.text, formNotice?.tone, visible]);

  useEffect(() => {
    if (!visible) {
      setIsTimeEditing(false);
      setTimeInputError(null);
      Keyboard.dismiss();
    }
  }, [visible]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const dismissTimePicker = () => {
      void DateTimePickerAndroid.dismiss('time').catch(() => undefined);
    };

    if (!visible || isTimeEditing) {
      dismissTimePicker();
    }

    return dismissTimePicker;
  }, [isTimeEditing, visible]);

  const closeIfIdle = () => {
    if (!isBusy) {
      if (Platform.OS === 'android') {
        void DateTimePickerAndroid.dismiss('time').catch(() => undefined);
      }
      setIsTimeEditing(false);
      setTimeInputError(null);
      Keyboard.dismiss();
      onClose();
    }
  };

  const beginTimeEditing = () => {
    if (Platform.OS === 'android') {
      void DateTimePickerAndroid.dismiss('time').catch(() => undefined);
    }
    setDraftHour(selectedTime.getHours().toString().padStart(2, '0'));
    setDraftMinute(selectedTime.getMinutes().toString().padStart(2, '0'));
    setTimeInputError(null);
    setIsTimeEditing(true);
  };

  const applyPickedTime = (pickedTime: Date) => {
    const nextTime = new Date(selectedTime);
    nextTime.setHours(
      pickedTime.getHours(),
      pickedTime.getMinutes(),
      0,
      0,
    );
    onTimeChange(nextTime);
  };

  const openAndroidTimePicker = () => {
    if (isBusy || isTimeEditing) {
      return;
    }

    DateTimePickerAndroid.open({
      display: 'clock',
      is24Hour: true,
      mode: 'time',
      onChange: (event, date) => {
        if (event.type === 'set' && date) {
          applyPickedTime(date);
        }
      },
      value: selectedTime,
    });
  };

  const cancelTimeEditing = () => {
    setIsTimeEditing(false);
    setTimeInputError(null);
    Keyboard.dismiss();
  };

  const confirmTimeEditing = () => {
    try {
      const { hour, minute } = parseAlarmTimeInput(draftHour, draftMinute);
      const nextTime = new Date(selectedTime);
      nextTime.setHours(hour, minute, 0, 0);
      onTimeChange(nextTime);
      setDraftHour(hour.toString().padStart(2, '0'));
      setDraftMinute(minute.toString().padStart(2, '0'));
      setTimeInputError(null);
      setIsTimeEditing(false);
      Keyboard.dismiss();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : '時は0〜23、分は0〜59で入力してください。';
      setTimeInputError(message);
      if (Platform.OS === 'ios') {
        AccessibilityInfo.announceForAccessibility(message);
      }
    }
  };

  const submitEnabled = canSubmit && !isTimeEditing;

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
          behavior={
            Platform.OS === 'ios'
              ? 'padding'
              : Platform.OS === 'android'
                ? 'height'
                : undefined
          }
          style={[
            styles.keyboardLayer,
            { paddingBottom: Math.max(insets.bottom, 10) },
          ]}
        >
          <View
            accessibilityLabel="アラームを追加"
            accessibilityViewIsModal
            style={styles.sheet}
          >
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleCopy}>
                <Text style={styles.eyebrow}>NEW ALARM</Text>
                <Text style={styles.sheetTitle}>アラームを追加</Text>
                <Text style={styles.sheetSubtitle}>
                  時刻と繰り返しを選んでください
                </Text>
              </View>
              <GlassSurface
                fallbackColor="rgba(255, 255, 255, 0.82)"
                glassEffectStyle="regular"
                intensity={86}
                isInteractive
                reducedTransparencyColor="#F4F5FA"
                style={styles.closeButtonShell}
                tintColor="#FFFFFFA8"
              >
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
              </GlassSurface>
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
                <Text style={styles.fieldLabel}>時刻</Text>
                {isTimeEditing ? (
                  <View style={styles.timeEditor}>
                    <View style={styles.timeInputRow}>
                      <TextInput
                        accessibilityLabel="時"
                        autoFocus
                        inputMode="numeric"
                        keyboardType="number-pad"
                        maxLength={2}
                        onChangeText={(value) => {
                          const next = sanitizeClockInput(value);
                          setDraftHour(next);
                          setTimeInputError(null);
                          if (next.length === 2) {
                            minuteInputRef.current?.focus();
                          }
                        }}
                        onSubmitEditing={() => minuteInputRef.current?.focus()}
                        returnKeyType="next"
                        selectTextOnFocus
                        style={styles.timeInput}
                        testID="alarm-hour-input"
                        value={draftHour}
                      />
                      <Text style={styles.timeColon}>:</Text>
                      <TextInput
                        accessibilityLabel="分"
                        inputMode="numeric"
                        keyboardType="number-pad"
                        maxLength={2}
                        onChangeText={(value) => {
                          setDraftMinute(sanitizeClockInput(value));
                          setTimeInputError(null);
                        }}
                        onSubmitEditing={confirmTimeEditing}
                        ref={minuteInputRef}
                        returnKeyType="done"
                        selectTextOnFocus
                        style={styles.timeInput}
                        testID="alarm-minute-input"
                        value={draftMinute}
                      />
                    </View>
                    {timeInputError ? (
                      <Text
                        accessibilityLiveRegion="assertive"
                        accessibilityRole="alert"
                        style={styles.timeInputError}
                      >
                        {timeInputError}
                      </Text>
                    ) : null}
                    <View style={styles.timeEditorActions}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={cancelTimeEditing}
                        style={({ pressed }) => [
                          styles.timeCancelButton,
                          pressed && styles.buttonPressed,
                        ]}
                      >
                        <Text style={styles.timeCancelText}>キャンセル</Text>
                      </Pressable>
                      <GlassSurface
                        fallbackColor="rgba(206, 216, 255, 0.94)"
                        intensity={88}
                        isInteractive
                        reducedTransparencyColor="#DCE2FA"
                        style={styles.timeConfirmShell}
                        tintColor="#C9D3FFB8"
                      >
                        <Pressable
                          accessibilityRole="button"
                          onPress={confirmTimeEditing}
                          style={({ pressed }) => [
                            styles.timeConfirmButton,
                            pressed && styles.buttonPressed,
                          ]}
                        >
                          <Text style={styles.timeConfirmText}>この時刻に決定</Text>
                        </Pressable>
                      </GlassSurface>
                    </View>
                  </View>
                ) : (
                  <>
                    {Platform.OS === 'ios' ? (
                      <View style={styles.dialPickerShell}>
                        <View
                          style={[
                            styles.dialPickerHeader,
                            usesLargeText && styles.stackedControlCopy,
                          ]}
                        >
                          <Text style={styles.dialPickerLabel}>
                            時刻ダイヤル
                          </Text>
                          <Text style={styles.dialPickerHint}>
                            上下に回して選択
                          </Text>
                        </View>
                        <DateTimePicker
                          accessibilityLabel="アラーム時刻をダイヤルで選択"
                          disabled={isBusy}
                          display="spinner"
                          minuteInterval={1}
                          mode="time"
                          onChange={(_, date) =>
                            date && applyPickedTime(date)
                          }
                          style={styles.iosTimePicker}
                          testID="alarm-time-dial"
                          textColor="#17213D"
                          themeVariant="light"
                          value={selectedTime}
                        />
                      </View>
                    ) : Platform.OS === 'android' ? (
                      <Pressable
                        accessibilityHint="Androidの時計ダイヤルを開きます"
                        accessibilityLabel="ダイヤルで時刻を選択"
                        accessibilityRole="button"
                        disabled={isBusy}
                        onPress={openAndroidTimePicker}
                        style={({ pressed }) => [
                          styles.androidDialButton,
                          (pressed || isBusy) && styles.buttonPressed,
                        ]}
                        testID="alarm-time-dial-trigger"
                      >
                        <View style={styles.dialIcon}>
                          <Text style={styles.dialIconText}>◷</Text>
                        </View>
                        <View style={styles.androidDialCopy}>
                          <Text style={styles.dialPickerLabel}>
                            時計ダイヤルで選択
                          </Text>
                          <Text style={styles.dialPickerHint}>
                            タップして開く
                          </Text>
                        </View>
                      </Pressable>
                    ) : (
                      <View style={styles.dialUnavailable}>
                        <Text style={styles.dialPickerLabel}>
                          ダイヤルで設定
                        </Text>
                        <Text style={styles.dialPickerHint}>
                          Expo Go実機で使用できます
                        </Text>
                      </View>
                    )}

                    <GlassSurface
                      fallbackColor="rgba(255, 255, 255, 0.76)"
                      intensity={76}
                      isInteractive
                      reducedTransparencyColor="#F4F5F9"
                      style={styles.timePreviewShell}
                      tintColor="#EEF1FF80"
                    >
                      <Pressable
                        accessibilityHint="時と分をキーボードから直接入力できます"
                        accessibilityLabel={`${formatAlarmTime(selectedTime)}、キーボードで時刻を入力`}
                        accessibilityRole="button"
                        disabled={isBusy}
                        onPress={beginTimeEditing}
                        style={({ pressed }) => [
                          styles.timePreviewButton,
                          usesLargeText && styles.stackedControlCopy,
                          pressed && styles.buttonPressed,
                        ]}
                        testID="alarm-time-edit-trigger"
                      >
                        <View>
                          <Text style={styles.selectedTimeLabel}>選択中</Text>
                          <Text style={styles.timePreview}>
                            {formatAlarmTime(selectedTime)}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.timeEditCopy,
                            usesLargeText && styles.timeEditCopyLargeText,
                          ]}
                        >
                          <Text style={styles.timeEditLabel}>数字で入力</Text>
                          <Text style={styles.timeEditHint}>時刻をタップ</Text>
                        </View>
                      </Pressable>
                    </GlassSurface>
                  </>
                )}
              </View>

              <Text style={styles.fieldLabel}>繰り返し</Text>
              <LiquidRepeatSelector
                onChange={onRepeatKindChange}
                value={repeatKind}
              />

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
              <GlassSurface
                fallbackColor={
                  submitEnabled
                    ? 'rgba(76, 96, 211, 0.94)'
                    : 'rgba(155, 165, 199, 0.94)'
                }
                intensity={92}
                isInteractive
                reducedTransparencyColor={
                  submitEnabled ? '#4D61D2' : '#9BA5C7'
                }
                style={styles.primaryButtonShell}
                tintColor={submitEnabled ? '#5367DEC8' : '#9BA5C7C8'}
              >
                <Pressable
                  accessibilityRole="button"
                  disabled={!submitEnabled}
                  onPress={onSubmit}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  {isBusy ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      {isTimeEditing
                        ? '時刻を確定してください'
                        : 'この内容で追加'}
                    </Text>
                  )}
                </Pressable>
              </GlassSurface>
            </View>
          </View>
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
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 30,
    backgroundColor: 'rgba(244, 246, 251, 0.97)',
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
  closeButtonShell: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.88)',
    borderRadius: 22,
  },
  closeButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
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
    marginBottom: 20,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.2)',
    borderRadius: 22,
    backgroundColor: 'rgba(231, 234, 243, 0.68)',
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
    fontSize: 27,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  timePreviewShell: {
    minHeight: 64,
    marginTop: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 18,
  },
  timePreviewButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 18,
  },
  selectedTimeLabel: {
    marginBottom: 1,
    color: UI_COLORS.textMuted,
    fontSize: 9,
    fontWeight: '800',
  },
  timeEditCopy: {
    alignItems: 'flex-end',
  },
  timeEditCopyLargeText: {
    alignItems: 'flex-start',
  },
  timeEditLabel: {
    color: UI_COLORS.accentLabel,
    fontSize: 11,
    fontWeight: '900',
  },
  timeEditHint: {
    marginTop: 3,
    color: UI_COLORS.textMuted,
    fontSize: 10,
  },
  dialPickerShell: {
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.18)',
    borderRadius: 18,
    backgroundColor: 'rgba(250, 251, 254, 0.88)',
  },
  dialPickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 13,
    paddingTop: 10,
  },
  stackedControlCopy: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    gap: 3,
  },
  dialPickerLabel: {
    color: '#344160',
    fontSize: 11,
    fontWeight: '900',
  },
  dialPickerHint: {
    color: UI_COLORS.textMuted,
    fontSize: 10,
  },
  iosTimePicker: {
    width: '100%',
    height: 216,
  },
  androidDialButton: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.2)',
    borderRadius: 18,
    backgroundColor: 'rgba(250, 251, 254, 0.88)',
  },
  dialIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: 'rgba(104, 121, 224, 0.14)',
  },
  dialIconText: {
    color: '#5064D8',
    fontSize: 22,
    fontWeight: '800',
  },
  androidDialCopy: {
    flex: 1,
    gap: 3,
  },
  dialUnavailable: {
    minHeight: 58,
    justifyContent: 'center',
    gap: 3,
    marginTop: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.16)',
    borderRadius: 16,
    backgroundColor: 'rgba(250, 251, 254, 0.72)',
  },
  timeEditor: {
    gap: 10,
  },
  timeInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  timeInput: {
    width: 82,
    minHeight: 64,
    paddingHorizontal: 8,
    borderWidth: 1.5,
    borderColor: '#7585DD',
    borderRadius: 17,
    backgroundColor: '#FFFFFF',
    color: '#17213D',
    fontSize: 32,
    fontWeight: '900',
    textAlign: 'center',
  },
  timeColon: {
    marginTop: -4,
    color: '#3A4664',
    fontSize: 31,
    fontWeight: '900',
  },
  timeInputError: {
    color: '#983F37',
    fontSize: 11,
    fontWeight: '800',
    lineHeight: 16,
    textAlign: 'center',
  },
  timeEditorActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  timeCancelButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 14,
  },
  timeCancelText: {
    color: UI_COLORS.textMuted,
    fontSize: 12,
    fontWeight: '800',
  },
  timeConfirmShell: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 14,
  },
  timeConfirmButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 14,
  },
  timeConfirmText: {
    color: '#3548B6',
    fontSize: 12,
    fontWeight: '900',
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
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(123, 140, 196, 0.26)',
    borderRadius: 22,
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
  primaryButtonShell: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.84)',
    borderRadius: 18,
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
  primaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
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
