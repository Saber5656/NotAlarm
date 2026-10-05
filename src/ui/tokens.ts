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
