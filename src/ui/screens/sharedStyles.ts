import { StyleSheet } from 'react-native';
import { ALARM_SUMMARY_CARD_HEIGHT } from './layout';

/** Styles used by more than one state screen. */
export const sharedStyles = StyleSheet.create({
  buttonDimmed: {
    opacity: 0.5,
  },
  deliveryWarningCard: {
    // Grows with Dynamic Type so the warning is never clipped.
    minHeight: ALARM_SUMMARY_CARD_HEIGHT,
    overflow: 'hidden',
    marginTop: 12,
    padding: 17,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    borderRadius: 25,
    backgroundColor: 'rgba(128, 28, 42, 0.92)',
  },
  deliveryWarningTitle: {
    flexGrow: 1,
    flexShrink: 1,
    // Wraps the action under a long title (English, or the largest text).
    flexBasis: 160,
    color: '#FFFFFF',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '900',
  },
  deliveryWarningBody: {
    marginTop: 10,
    color: '#FECDCA',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
  },
  settingsButtonText: {
    color: '#B42318',
    fontSize: 13,
    fontWeight: '900',
  },
  ringingCard: {
    minHeight: 150,
    overflow: 'hidden',
    marginTop: 12,
    padding: 19,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    borderRadius: 25,
    backgroundColor: 'rgba(128, 28, 42, 0.92)',
  },
  ringingLabel: {
    color: '#FECDCA',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  ringingTitle: {
    marginTop: 2,
    color: '#FECDCA',
    fontSize: 13,
    fontWeight: '700',
  },
  stopButton: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
  stopButtonText: {
    color: '#B42318',
    fontSize: 17,
    fontWeight: '900',
    textAlign: 'center',
  },
  alarmSummaryCardAccessible: {
    height: 'auto',
    minHeight: ALARM_SUMMARY_CARD_HEIGHT,
  },
});
