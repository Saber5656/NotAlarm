/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  type NotificationDeliveryState,
  type NotificationPermissionSnapshot,
  assessAndroidAlarmChannel,
  assessNotificationDelivery,
  resolveNotificationDelivery,
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

  test('off names the next alarm and says it rings only while the app stays on screen', () => {
    assert.deepEqual(getNotificationDeliveryWarningCopy('off', nextAlarm), {
      title: '通知がオフです',
      body: '通知がオフのため、次のアラーム 10/3(土) 07:00 は、アプリを画面に表示したままにしていないと鳴りません。',
      scheduleLine: '通知オフ・アプリ表示中のみ鳴ります',
    });
  });

  test('silent says the next alarm makes a sound only while the app stays on screen', () => {
    assert.deepEqual(getNotificationDeliveryWarningCopy('silent', nextAlarm), {
      title: '通知の音がオフです',
      body: '通知の音がオフのため、次のアラーム 10/3(土) 07:00 は、アプリを画面に表示したままにしていないと音が出ません。',
      scheduleLine: '通知音オフ・アプリ表示中のみ音が出ます',
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
      off: '通知がオフのため、アプリを画面に表示したままにしていないとアラームが鳴りません。',
      silent:
        '通知の音がオフのため、アプリを画面に表示したままにしていないとアラームの音が出ません。',
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

  test('off and silent say the alarm needs the app on screen, not just open', () => {
    // Only the in-app loop sound can ring without notifications, and it stops
    // when the screen locks or another app comes to the front, so the copy
    // must name staying on screen rather than only closing the app.
    for (const state of ['off', 'silent'] as const) {
      for (const label of [nextAlarm, null]) {
        const copy = getNotificationDeliveryWarningCopy(state, label);
        assert.match(copy.body, /アプリを画面に表示したまま/, `${state}: ${copy.body}`);
        assert.match(copy.scheduleLine, /アプリ表示中のみ/, `${state}: ${copy.scheduleLine}`);
        for (const text of [copy.body, copy.scheduleLine]) {
          assert.doesNotMatch(text, /アプリを閉じ/, `${state}: ${text}`);
        }
      }
    }
  });
});

// expo-notifications AndroidImportance values.
const IMPORTANCE = { UNKNOWN: 0, UNSPECIFIED: 1, NONE: 2, MIN: 3, LOW: 4, DEFAULT: 5, HIGH: 6, MAX: 7 };

describe('assessAndroidAlarmChannel', () => {
  const channel = (over: Record<string, unknown> = {}) => ({
    importance: IMPORTANCE.MAX,
    sound: 'default',
    ...over,
  });

  test('an audible high-importance channel with a sound is ok', () => {
    assert.equal(assessAndroidAlarmChannel(channel()), 'ok');
    assert.equal(assessAndroidAlarmChannel(channel({ importance: IMPORTANCE.HIGH, sound: 'custom' })), 'ok');
    assert.equal(assessAndroidAlarmChannel(channel({ importance: IMPORTANCE.DEFAULT })), 'ok');
  });

  test('a blocked channel is off', () => {
    assert.equal(assessAndroidAlarmChannel(channel({ importance: IMPORTANCE.NONE })), 'off');
  });

  test('low or min importance is silent', () => {
    assert.equal(assessAndroidAlarmChannel(channel({ importance: IMPORTANCE.LOW })), 'silent');
    assert.equal(assessAndroidAlarmChannel(channel({ importance: IMPORTANCE.MIN })), 'silent');
  });

  test('a channel with no sound is silent even at max importance', () => {
    assert.equal(assessAndroidAlarmChannel(channel({ sound: null })), 'silent');
  });

  test('missing channel or unreadable shape is unknown, never ok', () => {
    assert.equal(assessAndroidAlarmChannel(null), 'unknown');
    assert.equal(assessAndroidAlarmChannel(undefined), 'unknown');
    assert.equal(assessAndroidAlarmChannel({} as never), 'unknown');
    assert.equal(assessAndroidAlarmChannel(channel({ importance: IMPORTANCE.UNKNOWN })), 'unknown');
    assert.equal(assessAndroidAlarmChannel(channel({ importance: IMPORTANCE.UNSPECIFIED })), 'unknown');
    assert.equal(assessAndroidAlarmChannel(channel({ importance: 99 })), 'unknown');
    assert.equal(assessAndroidAlarmChannel(channel({ importance: '7' })), 'unknown');
    assert.equal(assessAndroidAlarmChannel(channel({ sound: undefined })), 'unknown');
    assert.equal(assessAndroidAlarmChannel(channel({ sound: 'weird' })), 'unknown');
  });
});

describe('resolveNotificationDelivery', () => {
  const ok = { granted: true };
  const base = (over: Partial<Parameters<typeof resolveNotificationDelivery>[0]> = {}) => {
    const calls = { channel: [] as string[], perm: 0 };
    return {
      calls,
      deps: {
        platform: 'android' as string,
        platformVersion: 34 as unknown,
        mainChannelId: 'main',
        getPermissions: async () => { calls.perm += 1; return ok; },
        getChannel: async (id: string) => { calls.channel.push(id); return { importance: 7, sound: 'default' }; },
        ...over,
      },
    };
  };

  test('android reads only the main channel and reports ok when both pass', async () => {
    const { deps, calls } = base();
    assert.equal(await resolveNotificationDelivery(deps), 'ok');
    assert.deepEqual(calls.channel, ['main']);
  });

  test('global permission off wins and skips the channel read', async () => {
    const { deps, calls } = base({ getPermissions: async () => ({ granted: false }) });
    assert.equal(await resolveNotificationDelivery(deps), 'off');
    assert.deepEqual(calls.channel, []);
  });

  test('a bad main channel degrades an otherwise granted permission', async () => {
    const { deps } = base({ getChannel: async () => ({ importance: 2, sound: 'default' }) });
    assert.equal(await resolveNotificationDelivery(deps), 'off');
    const silent = base({ getChannel: async () => ({ importance: 7, sound: null }) });
    assert.equal(await resolveNotificationDelivery(silent.deps), 'silent');
    const missing = base({ getChannel: async () => null });
    assert.equal(await resolveNotificationDelivery(missing.deps), 'unknown');
  });

  test('read errors are unknown', async () => {
    const a = base({ getChannel: async () => { throw new Error('x'); } });
    assert.equal(await resolveNotificationDelivery(a.deps), 'unknown');
    const b = base({ getPermissions: async () => { throw new Error('x'); } });
    assert.equal(await resolveNotificationDelivery(b.deps), 'unknown');
  });

  test('ios keeps permission-only delivery and never reads channels', async () => {
    const { deps, calls } = base({ platform: 'ios', getPermissions: async () => ios(PROVISIONAL) });
    assert.equal(await resolveNotificationDelivery(deps), 'silent');
    assert.deepEqual(calls.channel, []);
    const granted = base({ platform: 'ios', getPermissions: async () => ios(AUTHORIZED) });
    assert.equal(await resolveNotificationDelivery(granted.deps), 'ok');
  });

  test('android API 24/25 has no channels: permission-only, channel API not called', async () => {
    for (const v of [24, 25]) {
      const { deps, calls } = base({ platformVersion: v });
      assert.equal(await resolveNotificationDelivery(deps), 'ok');
      assert.deepEqual(calls.channel, []);
    }
    const off = base({ platformVersion: 25, getPermissions: async () => ({ granted: false }) });
    assert.equal(await resolveNotificationDelivery(off.deps), 'off');
  });

  test('android API 26+ reads the main channel', async () => {
    for (const v of [26, 34]) {
      const { deps, calls } = base({ platformVersion: v });
      assert.equal(await resolveNotificationDelivery(deps), 'ok');
      assert.deepEqual(calls.channel, ['main']);
    }
  });

  test('android with unknown or malformed API version fails closed without reading channels', async () => {
    for (const v of [undefined, null, NaN, '25', '', 'x', -1, 0, 25.5, Infinity, {}]) {
      const { deps, calls } = base({ platformVersion: v });
      assert.equal(await resolveNotificationDelivery(deps), 'unknown', String(v));
      assert.deepEqual(calls.channel, []);
    }
    const off = base({ platformVersion: undefined, getPermissions: async () => ({ granted: false }) });
    assert.equal(await resolveNotificationDelivery(off.deps), 'off');
  });

  test('ios ignores the version value', async () => {
    const { deps, calls } = base({ platform: 'ios', platformVersion: '17.0', getPermissions: async () => ios(AUTHORIZED) });
    assert.equal(await resolveNotificationDelivery(deps), 'ok');
    assert.deepEqual(calls.channel, []);
  });
});
