import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { TextContext } from '../../i18n';
import { GlassSurface } from '../GlassSurface';

interface HomeHeaderProps {
  text: TextContext;
  ringing: boolean;
  loadFailed: boolean;
  canOpenComposer: boolean;
  openSettings(): void;
  openAddComposer(): void;
}

export function HomeHeader({
  text,
  ringing,
  loadFailed,
  canOpenComposer,
  openSettings,
  openAddComposer,
}: HomeHeaderProps) {
  const { messages } = text;
  return (
    <>
      <View style={styles.brandRow}>
        <Text maxFontSizeMultiplier={1.4} numberOfLines={1} style={styles.brandName}>
          AlreadyUp
        </Text>
      </View>

      <View style={styles.titleRow}>
        <View style={styles.titleCopy}>
          <Text
            accessibilityRole="header"
            adjustsFontSizeToFit
            maxFontSizeMultiplier={1.4}
            minimumFontScale={0.6}
            numberOfLines={1}
            style={styles.screenTitle}
          >
            {messages.alarmList.title}
          </Text>
          <Text style={styles.screenSubtitle}>
            {messages.alarmList.tagline}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <GlassSurface
            blurTint="systemUltraThinMaterialDark"
            fallbackColor="rgba(20, 30, 45, 0.32)"
            glassEffectStyle="regular"
            intensity={76}
            isInteractive
            reducedTransparencyColor="#263544"
            style={styles.settingsShell}
            tintColor="#FFFFFF18"
          >
            <Pressable
              accessibilityHint={messages.settings.openHint}
              accessibilityLabel={messages.settings.openLabel}
              accessibilityRole="button"
              accessibilityState={{ disabled: ringing }}
              disabled={ringing}
              onPress={openSettings}
              style={({ pressed }) => [
                styles.addButton,
                pressed && styles.buttonPressed,
              ]}
              testID="settings-button"
            >
              <Text
                allowFontScaling={false}
                style={[
                  styles.settingsGlyph,
                  ringing && styles.addButtonTextDisabled,
                ]}
              >
                ⋯
              </Text>
            </Pressable>
          </GlassSurface>
          <GlassSurface
            blurTint="systemUltraThinMaterialDark"
            fallbackColor="rgba(20, 30, 45, 0.32)"
            glassEffectStyle="regular"
            intensity={76}
            isInteractive
            reducedTransparencyColor="#263544"
            style={styles.addButtonShell}
            tintColor="#FFFFFF18"
          >
            <Pressable
              accessibilityLabel={messages.alarmList.add}
              accessibilityRole="button"
              accessibilityHint={
                loadFailed
                  ? messages.storageLoadFailed.addDisabledReason
                  : undefined
              }
              accessibilityState={{ disabled: !canOpenComposer }}
              disabled={!canOpenComposer}
              onPress={openAddComposer}
              style={({ pressed }) => [
                styles.addButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text
                allowFontScaling={false}
                style={[
                  styles.addButtonText,
                  !canOpenComposer && styles.addButtonTextDisabled,
                ]}
              >
                ＋
              </Text>
            </Pressable>
          </GlassSurface>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  logoMark: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.34)',
    borderRadius: 12,
    backgroundColor: 'rgba(8, 31, 68, 0.42)',
  },
  logoGlyph: {
    color: '#FFFFFF',
    fontSize: 21,
    fontWeight: '900',
    lineHeight: 23,
  },
  brandName: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: -0.35,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  titleCopy: {
    flex: 1,
  },
  screenTitle: {
    color: '#FFFFFF',
    fontSize: 31,
    fontWeight: '600',
    letterSpacing: -1.05,
  },
  screenSubtitle: {
    marginTop: 3,
    color: 'rgba(255, 255, 255, 0.76)',
    fontSize: 12,
    lineHeight: 17,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  settingsShell: {
    width: 44,
    height: 44,
    borderWidth: 0,
    borderRadius: 22,
    backgroundColor: 'transparent',
  },
  settingsGlyph: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '600',
    lineHeight: 24,
  },
  addButtonShell: {
    width: 52,
    height: 52,
    borderWidth: 0,
    borderRadius: 26,
    backgroundColor: 'transparent',
    ...Platform.select({
      web: { boxShadow: '0 10px 22px rgba(3, 18, 47, 0.24)' },
      default: {
        shadowColor: '#03122F',
        shadowOpacity: 0.24,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 10 },
        elevation: 5,
      },
    }),
  },
  addButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 29,
    fontWeight: '500',
    lineHeight: 31,
  },
  addButtonTextDisabled: {
    color: 'rgba(255, 255, 255, 0.52)',
  },
  buttonPressed: {
    transform: [{ scale: 0.96 }],
  },
});
