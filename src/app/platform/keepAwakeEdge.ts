import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { BEDSIDE_KEEP_AWAKE_TAG } from '../../bedsideMode';

/** Keeps the screen on under the bedside tag; rejects when it cannot. */
export function activateBedsideKeepAwake(): Promise<void> {
  return Promise.resolve().then(() =>
    activateKeepAwakeAsync(BEDSIDE_KEEP_AWAKE_TAG),
  );
}

/** Releases the bedside tag; rejects when the release fails. */
export function releaseBedsideKeepAwake(): Promise<void> {
  return Promise.resolve().then(() =>
    deactivateKeepAwake(BEDSIDE_KEEP_AWAKE_TAG),
  );
}
