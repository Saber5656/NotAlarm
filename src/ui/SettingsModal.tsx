import { BlurView } from 'expo-blur';
import type { ReactNode } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from './GlassSurface';
import { UI_COLORS } from './tokens';

interface SettingsModalProps {
  closeLabel: string;
  /** Later settings (background, language) are added here, not in a new sheet. */
  children?: ReactNode;
  onClose: () => void;
  subtitle?: string;
  title: string;
  visible: boolean;
}

/**
 * Reusable settings sheet. It reuses the composer's backdrop, white sheet and
 * glass close button; the body scrolls so every control stays reachable at the
 * largest text size.
 */
export function SettingsModal({
  children,
  closeLabel,
  onClose,
  subtitle,
  title,
  visible,
}: SettingsModalProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
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
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="box-none"
          style={[
            styles.positioner,
            {
              paddingTop: Math.max(insets.top, 10),
              paddingBottom: Math.max(insets.bottom, 10),
            },
          ]}
        >
          <View
            accessibilityLabel={title}
            accessibilityViewIsModal
            style={styles.sheet}
            testID="settings-sheet"
          >
            <View style={styles.header}>
              <View style={styles.titleCopy}>
                <Text accessibilityRole="header" style={styles.title}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text style={styles.subtitle}>{subtitle}</Text>
                ) : null}
              </View>
              <GlassSurface
                fallbackColor="rgba(255, 255, 255, 0.82)"
                glassEffectStyle="regular"
                intensity={86}
                isInteractive
                reducedTransparencyColor="#F4F5FA"
                style={styles.closeShell}
                tintColor="#FFFFFFA8"
              >
                <Pressable
                  accessibilityLabel={closeLabel}
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={onClose}
                  style={({ pressed }) => [
                    styles.closeButton,
                    pressed && styles.pressed,
                  ]}
                  testID="settings-close"
                >
                  <Text style={styles.closeGlyph}>×</Text>
                </Pressable>
              </GlassSurface>
            </View>
            <ScrollView
              contentContainerStyle={styles.body}
              keyboardShouldPersistTaps="handled"
              style={styles.scroll}
              testID="settings-scroll"
            >
              {children}
            </ScrollView>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    backgroundColor: 'rgba(3, 12, 28, 0.38)',
  },
  positioner: {
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
  header: {
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
  titleCopy: {
    flex: 1,
  },
  title: {
    color: UI_COLORS.textPrimary,
    fontSize: 23,
    fontWeight: '600',
    letterSpacing: -0.6,
  },
  subtitle: {
    marginTop: 4,
    color: UI_COLORS.textMuted,
    fontSize: 12,
  },
  closeShell: {
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
  pressed: {
    opacity: 0.6,
  },
  closeGlyph: {
    marginTop: -2,
    color: UI_COLORS.textMuted,
    fontSize: 25,
    fontWeight: '400',
    lineHeight: 27,
  },
  scroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  body: {
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 22,
    gap: 12,
  },
});
