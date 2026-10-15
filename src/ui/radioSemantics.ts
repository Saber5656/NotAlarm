import type { Messages } from '../i18n/messages';

/**
 * Selected-state semantics for a radio-style row. Native reads
 * accessibilityState; react-native-web drops it, so `aria-checked` is set too.
 * `marker` is visible text so the choice is not conveyed by color alone.
 */
export function radioSemantics(
  selected: boolean,
  disabled: boolean,
  messages: Messages,
) {
  return {
    accessibilityRole: 'radio' as const,
    accessibilityState: { checked: selected, disabled },
    'aria-checked': selected,
    marker: selected ? messages.sun.selectedMarker : null,
  };
}

/**
 * The current-location control is one more choice in the same exclusive set,
 * so it reports the same checked state. Its label carries the selected state
 * too, because an explicit label would otherwise hide the visible text.
 */
export function deviceChoiceSemantics(
  selected: boolean,
  disabled: boolean,
  messages: Messages,
) {
  return {
    ...radioSemantics(selected, disabled, messages),
    accessibilityLabel: selected
      ? messages.sun.deviceInUse
      : messages.sun.deviceUse,
  };
}
