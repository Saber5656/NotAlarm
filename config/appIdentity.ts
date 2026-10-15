// Pure profile resolver for app.config.ts. Production values come only from
// the owner (environment); nothing here invents an identity or URL.

export const PROTOTYPE_IDENTIFIER = 'app.alreadyup.prototype';

export type AppProfile = 'development' | 'preview' | 'production';

export type AppIdentity = {
  profile: AppProfile;
  name?: string;
  iosBundleIdentifier: string;
  androidPackage: string;
  owner?: string;
  privacyUrl?: string;
  supportUrl?: string;
};

type Env = Record<string, string | undefined>;

const IOS_BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|localhost|invalid|test)$/i;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Production profile requires ${key} from the app owner.`);
  }
  return value;
}

function identifier(env: Env, key: string, pattern: RegExp): string {
  const value = required(env, key);
  if (/prototype/i.test(value)) {
    throw new Error(`${key} must not contain the prototype identifier.`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${key} is not a valid identifier: ${value}`);
  }
  return value;
}

function publicUrl(env: Env, key: string): string {
  const value = required(env, key);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an https URL.`);
  }
  if (url.protocol !== 'https:' || PLACEHOLDER_HOST.test(url.hostname)) {
    throw new Error(`${key} must be a well-formed https URL with a non-placeholder host (format check only; reachability is not verified).`);
  }
  return value;
}

export function resolveAppIdentity(env: Env): AppIdentity {
  const variant = env.APP_VARIANT?.trim() || 'development';
  if (variant === 'development') {
    return {
      profile: 'development',
      iosBundleIdentifier: PROTOTYPE_IDENTIFIER,
      androidPackage: PROTOTYPE_IDENTIFIER,
    };
  }
  if (variant === 'preview') {
    return {
      profile: 'preview',
      name: 'AlreadyUp Preview',
      iosBundleIdentifier: `${PROTOTYPE_IDENTIFIER}.preview`,
      androidPackage: `${PROTOTYPE_IDENTIFIER}.preview`,
    };
  }
  if (variant !== 'production') {
    throw new Error(
      `APP_VARIANT must be development, preview or production (got "${variant}").`,
    );
  }
  const name = required(env, 'ALREADYUP_APP_NAME');
  const iosBundleIdentifier = identifier(env, 'ALREADYUP_IOS_BUNDLE_ID', IOS_BUNDLE_ID);
  const androidPackage = identifier(env, 'ALREADYUP_ANDROID_PACKAGE', ANDROID_PACKAGE);
  // Optional: a local production build does not need EAS.
  const owner = env.ALREADYUP_EAS_OWNER?.trim() || undefined;
  const privacyUrl = publicUrl(env, 'ALREADYUP_PRIVACY_URL');
  const supportUrl = publicUrl(env, 'ALREADYUP_SUPPORT_URL');
  if (required(env, 'ALREADYUP_ASSETS_APPROVED') !== 'true') {
    throw new Error('ALREADYUP_ASSETS_APPROVED must be "true" once the owner approves the icon/splash assets.');
  }
  return {
    profile: 'production',
    name,
    iosBundleIdentifier,
    androidPackage,
    ...(owner ? { owner } : {}),
    privacyUrl,
    supportUrl,
  };
}
