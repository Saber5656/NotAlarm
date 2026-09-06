# Expo SDK compatibility

This project targets Expo SDK 57 to match the user's installed iPhone Expo Go (SDK 57).

On 2026-09-05 the user explicitly approved replacing the former SDK 54 pin after a physical-device compatibility error. Distribution remains Expo Go; this does not authorize signing, credentials, store submission, or a development-build migration.

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing SDK-dependent code. Keep dependencies aligned with the SDK using Expo's version checks. Future SDK-major or distribution changes require explicit approval and a documented decision. A successful manifest/bundle request is not proof of a successful physical-device launch.
