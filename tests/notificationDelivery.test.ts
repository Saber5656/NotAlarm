/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  type NotificationDeliveryState,
  type NotificationPermissionSnapshot,
  assessNotificationDelivery,
  getNotificationDeliveryWarningCopy,
  shouldWarnNotificationDelivery,
} from '../src/notificationDelivery';

// iOS UNAuthorizationStatus values as reported by expo-notifications.
const NOT_DETERMINED = 0;
const DENIED = 1;
const AUTHORIZED = 2;
const PROVISIONAL = 3;
const EPHEMERAL = 4;

function ios(
  status: number,
  overrides: { allowsSound?: boolean | null; allowsAlert?: boolean | null } = {},
): NotificationPermissionSnapshot {
  return {
    // The general status is only 'granted' for AUTHORIZED on iOS.
    granted: status === AUTHORIZED,
    ios: { status, allowsSound: true, allowsAlert: true, ...overrides },
  };
}

describe('assessNotificationDelivery', () => {
  test('a missing permission snapshot is unknown, never ok', () => {
    assert.equal(assessNotificationDelivery(null), 'unknown');
    assert.equal(assessNotificationDelivery(undefined), 'unknown');
  });

  test('iOS not determined or denied means notifications are off', () => {
    assert.equal(assessNotificationDelivery(ios(NOT_DETERMINED)), 'off');
    assert.equal(assessNotificationDelivery(ios(DENIED)), 'off');
  });

  test('iOS denied stays off even if the general flag claims granted', () => {
    assert.equal(
      assessNotificationDelivery({ granted: true, ios: { status: DENIED } }),
      'off',
    );
  });

  test('iOS provisional delivers quietly, so the alarm is silent', () => {
    assert.equal(assessNotificationDelivery(ios(PROVISIONAL)), 'silent');
  });

  test('iOS authorized with sound turned off is silent', () => {
    assert.equal(
      assessNotificationDelivery(ios(AUTHORIZED, { allowsSound: false })),
      'silent',
    );
  });

  test('iOS authorized with sound on or not reported is ok', () => {
    assert.equal(assessNotificationDelivery(ios(AUTHORIZED)), 'ok');
    assert.equal(
      assessNotificationDelivery(ios(AUTHORIZED, { allowsSound: null })),
      'ok',
    );
    assert.equal(
      assessNotificationDelivery({ granted: true, ios: { status: AUTHORIZED } }),
      'ok',
    );
  });

  test('iOS authorized with alerts off but sound on still rings', () => {
    assert.equal(
      assessNotificationDelivery(ios(AUTHORIZED, { allowsAlert: false })),
      'ok',
    );
  });

  test('iOS ephemeral is ok unless sound is off', () => {
    assert.equal(assessNotificationDelivery(ios(EPHEMERAL)), 'ok');
    assert.equal(
      assessNotificationDelivery(ios(EPHEMERAL, { allowsSound: false })),
      'silent',
    );
  });

  test('an unrecognised iOS status is unknown, never ok', () => {
    assert.equal(
      assessNotificationDelivery({ granted: true, ios: { status: 99 } }),
      'unknown',
    );
    assert.equal(
      assessNotificationDelivery({
        granted: true,
        ios: { status: Number.NaN },
      }),
      'unknown',
    );
  });

  test('without iOS details the general granted flag decides', () => {
    assert.equal(assessNotificationDelivery({ granted: true }), 'ok');
    assert.equal(assessNotificationDelivery({ granted: false }), 'off');
    assert.equal(
      assessNotificationDelivery({ granted: true, ios: null }),
      'ok',
    );
    assert.equal(
      assessNotificationDelivery({ granted: false, ios: null }),
      'off',
    );
  });
});

describe('shouldWarnNotificationDelivery', () => {
  const enabled = { enabled: true };
  const disabled = { enabled: false };

  test('warns for every non-ok state while an alarm is enabled', () => {
    for (const state of ['off', 'silent', 'unknown'] as const) {
      assert.equal(
        shouldWarnNotificationDelivery(state, [disabled, enabled]),
        true,
        state,
      );
    }
  });

  test('does not warn when notifications are ok', () => {
    assert.equal(shouldWarnNotificationDelivery('ok', [enabled]), false);
  });

  test('does not warn when only disabled alarms exist', () => {
    for (const state of ['off', 'silent', 'unknown'] as const) {
      assert.equal(
        shouldWarnNotificationDelivery(state, [disabled, disabled]),
        false,
        state,
      );
    }
  });

  test('does not warn without alarms', () => {
    assert.equal(shouldWarnNotificationDelivery('off', []), false);
  });

  test('does not warn before the state has been checked', () => {
    assert.equal(shouldWarnNotificationDelivery(null, [enabled]), false);
  });
});

describe('getNotificationDeliveryWarningCopy', () => {
  const nextAlarm = '10/3(土) 07:00';

  test('off names the next alarm and says it will not ring when closed', () => {
    assert.deepEqual(getNotificationDeliveryWarningCopy('off', nextAlarm), {
      title: '通知がオフです',
      body: '次のアラーム 10/3(土) 07:00 は、アプリを閉じていると鳴りません。',
      scheduleLine: '通知オフ・アプリを閉じると鳴りません',
    });
  });

  test('silent says the next alarm makes no sound when closed', () => {
    assert.deepEqual(getNotificationDeliveryWarningCopy('silent', nextAlarm), {
      title: '通知の音がオフです',
      body: '次のアラーム 10/3(土) 07:00 は、アプリを閉じていると音が出ません。',
      scheduleLine: '通知音オフ・アプリを閉じると音が出ません',
    });
  });

  test('unknown says it cannot confirm the next alarm will ring', () => {
    assert.deepEqual(getNotificationDeliveryWarningCopy('unknown', nextAlarm), {
      title: '通知の状態を確認できません',
      body: '次のアラーム 10/3(土) 07:00 は、鳴るか確認できません。',
      scheduleLine: '通知の状態を確認できません',
    });
  });

  test('without a next alarm the body still explains the risk', () => {
    const expected: Record<
      Exclude<NotificationDeliveryState, 'ok'>,
      string
    > = {
      off: 'アプリを閉じているとアラームが鳴りません。',
      silent: 'アプリを閉じているとアラームの音が出ません。',
      unknown: 'アラームが鳴るか確認できません。',
    };
    for (const state of ['off', 'silent', 'unknown'] as const) {
      assert.equal(
        getNotificationDeliveryWarningCopy(state, null).body,
        expected[state],
        state,
      );
    }
  });

  test('off and silent limit the claim to when the app is closed', () => {
    // The in-app loop sound still plays in the foreground, so the copy must
    // not say the alarm never rings.
    for (const state of ['off', 'silent'] as const) {
      for (const label of [nextAlarm, null]) {
        const copy = getNotificationDeliveryWarningCopy(state, label);
        for (const text of [copy.body, copy.scheduleLine]) {
          assert.match(text, /アプリを閉じ/, `${state}: ${text}`);
        }
      }
    }
  });
});
