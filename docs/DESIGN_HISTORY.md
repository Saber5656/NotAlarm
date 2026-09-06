# AlreadyUp design history

Design iterations are preserved as Git commits, not overwritten snapshots. Existing background assets and design documents remain tracked. Commit links below identify the implemented state, not image-generation concepts or proof of iPhone verification.

| Stage | Commit | Intent |
| --- | --- | --- |
| Composer sections | `7e93a21` | Separate time and repeat controls without displacing the home screen |
| Local-time scene | `6513bb4` | Introduce a time-aware background |
| Photographic landscape | `9957d39` | Replace the illustrated treatment with natural photography |
| Stable glass home | `8413f50` | Restore fixed home layout and stable summary sizing |
| Reachable composer | `09608f3` | Keep dial / optional keyboard controls reachable |
| List guidance | `c2f419c` | Improve alarm list controls and empty-state guidance |
| Expo Go compatibility | `3f32fe7` | Preserve UI while aligning with the approved SDK57 device runtime |

## Refinement: quiet landscape and typography

Issue: https://github.com/Saber5656/NotAlarm/issues/9

The current iteration removes nested white alarm cards and the large enclosing list panel. A continuous, darkened photographic landscape provides the canvas; thin dividers and lighter, tabular time typography distinguish alarm rows. The next-alarm surface retains its fixed 140-point height and native glass treatment. An uncolored circular add control replaces the blue square. The composer keeps its native dial and optional keyboard, with fewer decorative borders and less heavy type.

Constraints remain: only the alarm list scrolls at ordinary phone text sizes; accessibility overflow escape hatches remain; toggle success stays silent; alarm scheduling, stored data, permissions and SDK versions are unchanged.

Design references: [Apple Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) describes material, interaction and layering as one system; [Expo57 GlassEffect](https://docs.expo.dev/versions/v57.0.0/sdk/glass-effect/) provides the actual native material on supported iOS. Browser blur is a fallback, not evidence that native lensing has been verified. Physical iPhone validation remains a separate gate.
