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
import { toggleSemantics } from './choiceSemantics';
import { parseAlarmTimeInput } from '../alarmTime';
import type { BedsideGuidance } from '../bedsideMode';
import type { NewAlarmSummary } from '../homeStatus';
import {
  doesComposerContentOverflow,
  getWeekdayColumnCount,
  shouldScrollAlarmComposer,
} from '../composerLayout';
import { GlassSurface } from './GlassSurface';
import {
  LiquidComposerTabs,
  type ComposerSection,
} from './LiquidComposerTabs';
import { LiquidRepeatSelector } from './LiquidRepeatSelector';
import { useText } from './I18nContext';
import { UI_COLORS } from './tokens';

interface AlarmComposerModalProps {
  /** Same copy as the main-screen footer, for the current delivery state. */
  bedsideGuidance: BedsideGuidance;
  canSubmit: boolean;
  customWeekdays: Weekday[];
  formNotice?: {
    text: string;
    tone: 'danger' | 'warning';
  };
  isBusy: boolean;
  /** 'edit' reuses this form prefilled for an existing alarm. */
  mode?: 'add' | 'edit';
  onClose: () => void;
  /** iOS: the modal finished closing (used to hand over screen-reader focus). */
  onDismissed?: () => void;
  onRepeatKindChange: (kind: RepeatKind) => void;
  onSubmit: () => void;
  onTimeChange: (date: Date) => void;
  onToggleWeekday: (weekday: Weekday) => void;
  repeatKind: RepeatKind;
  selectedTime: Date;
  /** Repeat and first ring, shown on every tab above the add button. */
  summary: NewAlarmSummary;
  visible: boolean;
}

// Monday first, as in the picker row. Names come from the device language.
const WEEKDAY_VALUES: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];

function sanitizeClockInput(value: string): string {
  return value
    .replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    )
    .replace(/\D/g, '')
    .slice(0, 2);
}

export function AlarmComposerModal({
  bedsideGuidance,
  canSubmit,
  customWeekdays,
  formNotice,
  isBusy,
  mode = 'add',
  onClose,
  onRepeatKindChange,
  onSubmit,
  onTimeChange,
  onToggleWeekday,
  repeatKind,
  selectedTime,
  summary,
  onDismissed,
  visible,
}: AlarmComposerModalProps) {
  const insets = useSafeAreaInsets();
  const { messages, formatter, intlTag, uses24HourClock } = useText();
  const formatAlarmTime = (date: Date): string =>
    formatter.clock(date.getHours(), date.getMinutes());
  const { fontScale, height: viewportHeight, width: viewportWidth } =
    useWindowDimensions();
  const usesLargeText = fontScale > 1.3;
  const usesScrollableFallback = shouldScrollAlarmComposer(
    viewportHeight,
    viewportWidth,
    fontScale,
  );
  const minuteInputRef = useRef<TextInput>(null);
  const titleRef = useRef<Text>(null);
  const [formViewportHeight, setFormViewportHeight] = useState(0);
  const [formContentHeight, setFormContentHeight] = useState(0);
  const [weekdayWidth, setWeekdayWidth] = useState(0);
  const formCanScroll = doesComposerContentOverflow(
    formContentHeight,
    formViewportHeight,
  );
  const weekdayColumns = getWeekdayColumnCount(weekdayWidth);
  const [activeSection, setActiveSection] =
    useState<ComposerSection>('time');
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

  // Hands screen-reader focus to the sheet title once the modal is on screen,
  // so the first thing announced is where the user is, not a control behind it.
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const timer = setTimeout(() => {
      if (titleRef.current) {
        AccessibilityInfo.sendAccessibilityEvent(titleRef.current, 'focus');
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      setActiveSection('time');
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

    if (!visible || isTimeEditing || activeSection !== 'time') {
      dismissTimePicker();
    }

    return dismissTimePicker;
  }, [activeSection, isTimeEditing, visible]);

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
    setActiveSection('time');
    setIsTimeEditing(true);
  };

  const selectSection = (section: ComposerSection) => {
    if (isBusy || (isTimeEditing && section !== 'time')) {
      return;
    }

    if (Platform.OS === 'android' && section !== 'time') {
      void DateTimePickerAndroid.dismiss('time').catch(() => undefined);
    }
    setActiveSection(section);
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
      is24Hour: uses24HourClock,
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
    } catch {
      // The input is the only thing that can be wrong; a thrown message is
      // never shown.
      const message = messages.composer.timeInputInvalid;
      setTimeInputError(message);
      if (Platform.OS === 'ios') {
        AccessibilityInfo.announceForAccessibility(message);
      }
    }
  };

  const isEdit = mode === 'edit';
  const submitEnabled = canSubmit && !isTimeEditing;
  const weekdaySelectionError =
    repeatKind === 'custom' && customWeekdays.length === 0
      ? messages.composer.weekdayNeeded
      : null;

  return (
    <Modal
      animationType="fade"
      onDismiss={onDismissed}
      onRequestClose={closeIfIdle}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.modalRoot}>
        <BlurView
          blurMethod="none"
          intensity={34}
          style={StyleSheet.absoluteFill}
          tint="systemThinMaterialDark"
        />
        <Pressable
          accessible={false}
          onPress={closeIfIdle}
          style={StyleSheet.absoluteFill}
        />

        <KeyboardAvoidingView
          behavior={
            Platform.OS === 'ios'
              ? 'padding'
              : Platform.OS === 'android'
                ? 'height'
                : undefined
          }
          style={styles.keyboardLayer}
        >
          <View
            pointerEvents="box-none"
            testID="alarm-composer-positioner"
            style={[
              styles.sheetPositioner,
              { paddingTop: Math.max(insets.top, 10), paddingBottom: Math.max(insets.bottom, 10) },
            ]}
          >
          <View
            accessibilityLabel={
              isEdit ? messages.composer.editTitle : messages.composer.title
            }
            accessibilityViewIsModal
            testID="alarm-composer-sheet"
            style={[
              styles.sheet,
              !usesScrollableFallback && styles.sheetFixed,
            ]}
          >
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleCopy}>
                <Text
                  accessibilityRole="header"
                  ref={titleRef}
                  style={styles.sheetTitle}
                >
                  {isEdit ? messages.composer.editTitle : messages.composer.title}
                </Text>
                <Text style={styles.sheetSubtitle}>
                  {isEdit
                    ? messages.composer.editSubtitle
                    : messages.composer.subtitle}
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
                  accessibilityLabel={messages.composer.close}
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

            <LiquidComposerTabs
              disabled={isBusy}
              onChange={selectSection}
              repeatDisabled={isTimeEditing}
              style={styles.sectionTabs}
              value={activeSection}
            />

            <ScrollView
              bounces={formCanScroll}
              contentContainerStyle={[
                styles.formContent,
                !usesScrollableFallback && styles.formContentFixed,
              ]}
              keyboardShouldPersistTaps="handled"
              onLayout={(event) => setFormViewportHeight(event.nativeEvent.layout.height)}
              onContentSizeChange={(_, height) => setFormContentHeight(height)}
              scrollEnabled={formCanScroll}
              showsVerticalScrollIndicator={formCanScroll}
              style={styles.formScroll}
              testID="alarm-composer-scroll"
            >
              {activeSection === 'time' ? (
                <View style={styles.timePanel}>
                {isTimeEditing ? (
                  <View style={styles.timeEditor}>
                    <View style={styles.timeInputRow}>
                      <TextInput
                        accessibilityLabel={messages.composer.hour}
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
                        accessibilityLabel={messages.composer.minute}
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
                        <Text style={styles.timeCancelText}>
                          {messages.composer.timeCancel}
                        </Text>
                      </Pressable>
                      <GlassSurface
                        fallbackColor="rgba(225, 233, 255, 0.96)"
                        intensity={88}
                        isInteractive
                        reducedTransparencyColor="#E1E9FF"
                        style={styles.timeConfirmShell}
                        tintColor="#D5E0FFD8"
                      >
                        <Pressable
                          accessibilityRole="button"
                          onPress={confirmTimeEditing}
                          style={({ pressed }) => [
                            styles.timeConfirmButton,
                            pressed && styles.buttonPressed,
                          ]}
                        >
                          <Text style={styles.timeConfirmText}>
                            {messages.composer.timeConfirm}
                          </Text>
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
                            {messages.composer.dialTitle}
                          </Text>
                          <Text style={styles.dialPickerHint}>
                            {messages.composer.dialHint}
                          </Text>
                        </View>
                        <DateTimePicker
                          accessibilityLabel={messages.composer.dialSpoken}
                          disabled={isBusy}
                          display="spinner"
                          is24Hour={uses24HourClock}
                          locale={intlTag}
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
                        accessibilityHint={messages.composer.openDialHint}
                        accessibilityLabel={messages.composer.openDialSpoken}
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
                            {messages.composer.openDialTitle}
                          </Text>
                          <Text style={styles.dialPickerHint}>
                            {messages.composer.openDialTap}
                          </Text>
                        </View>
                      </Pressable>
                    ) : (
                      <View style={styles.dialUnavailable}>
                        <Text style={styles.dialPickerLabel}>
                          {messages.composer.openDialSet}
                        </Text>
                        <Text style={styles.dialPickerHint}>
                          {messages.composer.needsDevice}
                        </Text>
                      </View>
                    )}

                    <GlassSurface
                      fallbackColor="rgba(255, 255, 255, 0.96)"
                      intensity={76}
                      isInteractive
                      reducedTransparencyColor="#FFFFFF"
                      style={styles.timePreviewShell}
                      tintColor="#FFFFFFD8"
                    >
                      <Pressable
                        accessibilityHint={messages.composer.typeTimeHint}
                        accessibilityLabel={messages.composer.typeTimeSpoken(
                          formatAlarmTime(selectedTime),
                        )}
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
                          <Text style={styles.selectedTimeLabel}>
                            {messages.composer.selected}
                          </Text>
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
                          <Text style={styles.timeEditLabel}>
                            {messages.composer.typeDigits}
                          </Text>
                          <Text style={styles.timeEditHint}>
                            {messages.composer.tapTime}
                          </Text>
                        </View>
                      </Pressable>
                    </GlassSurface>
                  </>
                )}
                </View>
              ) : (
                <View style={styles.repeatPanel}>
                  <Text style={styles.sectionLead}>{messages.composer.pickDays}</Text>
                  <LiquidRepeatSelector
                    disabled={isBusy}
                    onChange={(kind) => {
                      if (!isBusy) {
                        onRepeatKindChange(kind);
                      }
                    }}
                    value={repeatKind}
                  />

                  {repeatKind === 'custom' ? (
                    <View
                      onLayout={(event) => setWeekdayWidth(event.nativeEvent.layout.width)}
                      style={styles.weekdayBlock}
                    >
                      <Text style={styles.weekdayHint}>
                        {messages.composer.weekdayHint}
                      </Text>
                      <View style={[styles.weekdayRow, { maxWidth: weekdayColumns * 44 + (weekdayColumns - 1) * 4 }]}>
                        {WEEKDAY_VALUES.map((value) => {
                          const selected = customWeekdays.includes(value);
                          return (
                            <Pressable
                              accessibilityLabel={formatter.weekdayLong(value)}
                              {...toggleSemantics(selected, isBusy)}
                              disabled={isBusy}
                              hitSlop={2}
                              key={value}
                              onPress={() => {
                                if (!isBusy) {
                                  onToggleWeekday(value);
                                }
                              }}
                              style={({ pressed }) => [
                                styles.weekdayButton,
                                selected && styles.weekdayButtonSelected,
                                isBusy && styles.weekdayButtonDisabled,
                                pressed && styles.buttonPressed,
                              ]}
                            >
                              {selected ? (
                                <Text
                                  accessibilityElementsHidden
                                  importantForAccessibility="no"
                                  style={styles.weekdayCheck}
                                >
                                  ✓
                                </Text>
                              ) : null}
                              <Text
                                style={[
                                  styles.weekdayButtonText,
                                  selected && styles.weekdayButtonTextSelected,
                                ]}
                              >
                                {formatter.weekdayShort(value)}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  ) : null}

                  <View style={styles.behaviorNote}>
                    <View style={styles.stepBadge}>
                      <Text style={styles.stepBadgeText}>100</Text>
                    </View>
                    <View style={styles.behaviorCopy}>
                      <Text style={styles.behaviorTitle}>
                        {messages.composer.behaviorTitle}
                      </Text>
                      <Text style={styles.behaviorText}>
                        {messages.composer.behaviorBody}
                      </Text>
                      <Text style={styles.behaviorBedside}>
                        {messages.composer.bedsideNote(
                          bedsideGuidance.title,
                          bedsideGuidance.detail,
                        )}
                      </Text>
                    </View>
                  </View>
                </View>
              )}
            </ScrollView>

            {!isTimeEditing ? <View style={styles.sheetFooter}>
              <Text
                accessibilityLabel={
                  isEdit
                    ? messages.composer.editSummarySpoken(summary.text)
                    : messages.composer.summarySpoken(summary.text)
                }
                accessibilityLiveRegion="polite"
                style={[
                  styles.summaryText,
                  summary.isDistant && styles.summaryTextDistant,
                ]}
                testID="composer-summary"
              >
                {summary.text}
              </Text>
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
              ) : weekdaySelectionError ? (
                <View
                  accessibilityLiveRegion="polite"
                  style={[styles.formNotice, styles.formNoticeWarning]}
                >
                  <Text
                    style={[
                      styles.formNoticeText,
                      styles.formNoticeTextWarning,
                    ]}
                  >
                    {weekdaySelectionError}
                  </Text>
                </View>
              ) : null}
              {Platform.OS === 'web' ? (
                <Text style={styles.deviceHint}>
                  {messages.composer.deviceHint}
                </Text>
              ) : null}
              <GlassSurface
                fallbackColor={
                  submitEnabled
                    ? 'rgba(47, 94, 219, 0.96)'
                    : 'rgba(155, 165, 199, 0.94)'
                }
                intensity={92}
                isInteractive
                reducedTransparencyColor={
                  submitEnabled ? '#2F5EDB' : '#9BA5C7'
                }
                style={styles.primaryButtonShell}
                tintColor={submitEnabled ? '#3264E4D8' : '#9BA5C7C8'}
              >
                <Pressable
                  accessibilityHint={
                    submitEnabled
                      ? undefined
                      : (weekdaySelectionError ?? summary.text)
                  }
                  accessibilityLabel={
                    isEdit ? messages.composer.editSubmit : messages.composer.submit
                  }
                  accessibilityRole="button"
                  accessibilityState={{
                    busy: isBusy,
                    disabled: !submitEnabled,
                  }}
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
                      {isEdit ? messages.composer.editSubmit : messages.composer.submit}
                    </Text>
                  )}
                </Pressable>
              </GlassSurface>
            </View> : null}
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
    backgroundColor: 'rgba(3, 12, 28, 0.38)',
  },
  keyboardLayer: {
    flex: 1,
    pointerEvents: 'box-none',
  },
  sheetPositioner: {
    flex: 1,
    minHeight: 0,
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
    borderColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 30,
    backgroundColor: 'rgba(248, 249, 252, 0.985)',
    ...Platform.select({
      web: { boxShadow: '0 22px 44px rgba(3, 15, 39, 0.32)' },
      default: {
        shadowColor: '#030F27',
        shadowOpacity: 0.32,
        shadowRadius: 40,
        shadowOffset: { width: 0, height: 22 },
        elevation: 18,
      },
    }),
  },
  sheetFixed: {
    height: '88%',
  },
  sheetHeader: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(50, 67, 98, 0.1)',
  },
  sheetTitleCopy: {
    flex: 1,
  },
  sheetTitle: {
    color: '#0B1A33',
    fontSize: 23,
    fontWeight: '600',
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
  sectionTabs: {
    flexShrink: 0,
    marginHorizontal: 22,
    marginTop: 12,
  },
  formScroll: {
    flex: 1,
    minHeight: 0,
  },
  formContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
  },
  formContentFixed: {
    justifyContent: 'flex-start',
  },
  timePanel: {
    minHeight: 94,
  },
  repeatPanel: {
    flexGrow: 1,
  },
  sectionLead: {
    marginBottom: 9,
    color: UI_COLORS.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  timePreview: {
    color: '#0B1A33',
    fontSize: 27,
    fontWeight: '400',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.8,
  },
  timePreviewShell: {
    minHeight: 64,
    marginTop: 10,
    borderWidth: 0,
    borderColor: 'rgba(43, 62, 96, 0.08)',
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
    overflow: 'hidden',
    borderWidth: 0,
    borderColor: 'rgba(49, 70, 108, 0.1)',
    borderRadius: 18,
    backgroundColor: 'transparent',
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
    color: '#243552',
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
    borderColor: '#2F5EDB',
    borderRadius: 17,
    backgroundColor: '#FFFFFF',
    color: '#0B1A33',
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
    color: '#234FBF',
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
  weekdayButtonDisabled: {
    opacity: 0.48,
  },
  weekdayCheck: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
    lineHeight: 11,
  },
  weekdayButtonText: {
    color: UI_COLORS.textMuted,
    fontSize: 12,
    fontWeight: '900',
  },
  weekdayButtonTextSelected: {
    color: '#FFFFFF',
  },
  behaviorNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 20,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(30, 40, 50, 0.18)',
  },
  stepBadge: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: '#E7EBEA',
  },
  stepBadgeText: {
    color: '#244A49',
    fontSize: 15,
    fontWeight: '500',
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
  behaviorBedside: {
    marginTop: 4,
    color: '#244A49',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
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
    flexShrink: 0,
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: 'rgba(50, 67, 98, 0.1)',
  },
  summaryText: {
    marginBottom: 8,
    color: UI_COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  summaryTextDistant: {
    color: '#8A4B00',
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
      web: { boxShadow: '0 10px 20px rgba(38, 78, 182, 0.28)' },
      default: {
        shadowColor: '#264EB6',
        shadowOpacity: 0.28,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 10 },
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
    fontWeight: '600',
  },
  buttonPressed: {
    transform: [{ scale: 0.98 }],
  },
});
