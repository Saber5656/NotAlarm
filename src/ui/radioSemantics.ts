/**
 * Selected-state semantics for a radio-style row. Native reads
 * accessibilityState; react-native-web drops it, so `aria-checked` is set too.
 * `marker` is visible text so the choice is not conveyed by color alone.
 */
export function radioSemantics(selected: boolean, disabled: boolean) {
  return {
    accessibilityRole: 'radio' as const,
    accessibilityState: { checked: selected, disabled },
    'aria-checked': selected,
    marker: selected ? '✓ 選択中' : null,
  };
}
