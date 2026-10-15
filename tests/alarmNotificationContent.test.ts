/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { getMainAlarmNotificationBody } from '../src/alarmNotificationContent';
import { ja } from './support/text';

test('a repeating alarm tells the user that opening the app keeps later occurrences', () => {
  assert.equal(
    getMainAlarmNotificationBody({ repeats: true }, ja),
    '起床が確認できなかったため、アラームを鳴らしています。アプリを開くと次回以降の予約を続けます。',
  );
});

test('a today-only alarm has no later occurrences to keep', () => {
  const body = getMainAlarmNotificationBody({ repeats: false }, ja);

  assert.equal(body, '起床が確認できなかったため、アラームを鳴らしています。');
  assert.doesNotMatch(body, /次回以降/);
});
