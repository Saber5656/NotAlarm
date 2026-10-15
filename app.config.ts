import type { ExpoConfig } from 'expo/config';

import { resolveAppIdentity } from './config/appIdentity.ts';

// app.json stays the shared base; only identity fields vary by APP_VARIANT.
// See docs/RELEASE_PROFILES.md.
export default ({ config }: { config: ExpoConfig }): ExpoConfig => {
  const identity = resolveAppIdentity(process.env);
  return {
    ...config,
    name: identity.name ?? config.name ?? 'AlreadyUp',
    slug: config.slug ?? 'already-up',
    ...(identity.owner ? { owner: identity.owner } : {}),
    ios: { ...config.ios, bundleIdentifier: identity.iosBundleIdentifier },
    android: { ...config.android, package: identity.androidPackage },
    extra: {
      ...config.extra,
      profile: identity.profile,
      ...(identity.privacyUrl
        ? { privacyPolicyUrl: identity.privacyUrl, supportUrl: identity.supportUrl }
        : {}),
    },
  };
};
