/**
 * Selected-state semantics for toggles and exclusive segments. Native reads
 * accessibilityState; react-native-web drops it, so the ARIA prop is set too.
 */
export function toggleSemantics(selected: boolean, disabled: boolean) {
  return {
    accessibilityRole: 'checkbox' as const,
    accessibilityState: { checked: selected, disabled },
    'aria-checked': selected,
  };
}

export function segmentRadioSemantics(selected: boolean, disabled: boolean) {
  return {
    accessibilityRole: 'radio' as const,
    accessibilityState: { checked: selected, disabled },
    'aria-checked': selected,
  };
}

export function tabSemantics(selected: boolean, disabled: boolean) {
  return {
    accessibilityRole: 'tab' as const,
    accessibilityState: { selected, disabled },
    'aria-selected': selected,
  };
}
