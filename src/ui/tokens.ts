export const UI_COLORS = {
  accent: '#2F5EDB',
  accentLabel: '#315CC6',
  positive: '#18776B',
  textPrimary: '#0B1A33',
  textSecondary: '#44536C',
  textMuted: '#5B667A',
} as const;

// Bedside guidance footer. It draws its own backdrop so the text keeps at
// least 4.5:1 over any part of the background photo.
export const BEDSIDE_FOOTER_COLORS = {
  backdrop: 'rgba(6, 21, 45, 0.86)',
  title: '#FFFFFF',
  detail: '#C5CDD8',
} as const;

// Main-screen colours. Small text sits on a backdrop whose own alpha keeps
// 4.5:1 over any photo (checked against pure white and pure black in
// tests/homeContrast.test.ts); the progress fill needs 3:1 against its track.
export const HOME_COLORS = {
  summaryBackdrop: 'rgba(8, 30, 65, 0.7)',
  summaryText: {
    label: '#FFFFFF',
    date: '#FFFFFF',
    countdown: '#F1F5FA',
    progress: '#A8F0E4',
    status: '#F1F5FA',
  },
  progressTrack: 'rgba(0, 8, 24, 0.6)',
  progressFill: '#A8F0E4',
  listBackdrop: 'rgba(6, 21, 45, 0.86)',
  listText: {
    repeat: '#D5DCE6',
    schedule: '#D0D8E3',
    count: '#D0D8E3',
    disabledTime: '#B4BCD0',
    warning: '#FFB4AC',
    delete: '#FFB4AC',
    empty: '#D5DCE6',
  },
} as const;
