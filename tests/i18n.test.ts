/// <reference types="node" />

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test, { describe } from 'node:test';

import {
  AppError,
  ERROR_CODES,
  JA_ERROR_TEXTS,
  describeErrorCode,
  type ErrorCode,
} from '../src/errorCatalog';
import {
  describeErrorIn,
  noticeFromCodeIn,
  noticeFromCodesIn,
} from '../src/i18n/errorText';
import { createTextContext } from '../src/i18n/context';
import {
  resolveAppLocale,
  resolveLocaleSettings,
  sameLocaleSettings,
} from '../src/i18n/locale';
import { createFormatter } from '../src/i18n/format';
import {
  AWAKE_CHECKIN_CATEGORY,
  CONFIRM_AWAKE_ACTION,
} from '../src/alarmContracts';
import { getMainAlarmNotificationBody } from '../src/alarmNotificationContent';
import { formatRepeatLabel } from '../src/alarmSchedule';
import { getBedsideGuidance } from '../src/bedsideMode';
import { formatLeadTime, summarizeNewAlarm } from '../src/homeStatus';
import { getNotificationDeliveryWarningCopy } from '../src/notificationDelivery';
import { EN_SETTINGS, EN_TEXT, JA_SETTINGS, JA_TEXT, en, ja } from './support/text';

const CJK = /[぀-ヿ㐀-鿿]/;

type Leaf = string | ((...args: never[]) => string) | readonly string[];

function flatten(value: unknown, prefix = ''): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  const visit = (node: unknown, path: string) => {
    if (
      typeof node === 'string' ||
      typeof node === 'function' ||
      Array.isArray(node)
    ) {
      out.set(path, node as Leaf);
      return;
    }
    for (const [key, child] of Object.entries(node as object)) {
      visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(value, prefix);
  return out;
}

function render(value: Leaf): string {
  if (typeof value === 'function') {
    return value(...(sampleArgs(value) as never[]));
  }
  return typeof value === 'string' ? value : value.join('\n');
}

function paramsObject(fn: (...args: never[]) => string): unknown[] | null {
  const text = fn.toString();
  if (/params\.max/.test(text)) {
    return [{ max: 7 }];
  }
  if (/params\.reason/.test(text)) {
    return [{ reason: '«reason»' }];
  }
  if (/params\.clock/.test(text)) {
    return [{ clock: '07:05' }];
  }
  return null;
}

/** Marker strings make a dropped argument visible in the rendered sentence. */
function sampleArgs(fn: (...args: never[]) => string): unknown[] {
  return (
    paramsObject(fn) ??
    Array.from({ length: fn.length }, (_, index) => `«${index}»`)
  );
}

/** Counts (3, 4, ...) for functions that branch on numbers. */
function numericArgs(fn: (...args: never[]) => string): unknown[] {
  return (
    paramsObject(fn) ?? Array.from({ length: fn.length }, (_, index) => 3 + index)
  );
}

describe('catalog parity', () => {
  const jaLeaves = flatten(ja);
  const enLeaves = flatten(en);

  test('both languages define exactly the same keys with the same shape', () => {
    assert.deepEqual([...enLeaves.keys()].sort(), [...jaLeaves.keys()].sort());
    for (const [key, jaValue] of jaLeaves) {
      const enValue = enLeaves.get(key) as Leaf;
      assert.equal(typeof enValue, typeof jaValue, key);
      if (typeof jaValue === 'function') {
        assert.equal(
          (enValue as (...args: never[]) => string).length,
          jaValue.length,
          `${key}: parameter count`,
        );
      }
      if (Array.isArray(jaValue)) {
        assert.equal((enValue as string[]).length, jaValue.length, key);
      }
    }
  });

  test('the English catalog contains no Japanese and the Japanese one no leftover English sentences', () => {
    for (const [key, value] of enLeaves) {
      const rendered = render(value);
      assert.doesNotMatch(rendered, CJK, `en.${key}`);
    }
    for (const [key, value] of jaLeaves) {
      const rendered = render(value);
      // A sentence-like run of 4+ English words in the Japanese catalog is a
      // placeholder left behind. "Expo Go" and "Expo" are product names.
      const withoutNames = rendered.replace(/Expo( Go)?/g, '');
      assert.doesNotMatch(
        withoutNames,
        /\b[A-Za-z]{3,}\b(\s+\b[A-Za-z]+\b){3,}/,
        `ja.${key}: ${rendered}`,
      );
    }
  });

  test('functions use all their arguments and never print undefined', () => {
    for (const [locale, leaves] of [
      ['ja', jaLeaves],
      ['en', enLeaves],
    ] as const) {
      for (const [key, value] of leaves) {
        if (typeof value !== 'function' || paramsObject(value)) {
          continue;
        }
        const marked = value(...(sampleArgs(value) as never[]));
        const counted = value(...(numericArgs(value) as never[]));
        for (const rendered of [marked, counted]) {
          assert.doesNotMatch(rendered, /undefined|NaN|\[object/, `${locale}.${key}`);
        }
        for (let index = 0; index < value.length; index += 1) {
          const used =
            marked.includes(`«${index}»`) ||
            counted.includes(String(3 + index));
          // `suppressedBy` takes a flag that only selects the wording.
          assert.ok(
            used || key === 'suppression.suppressedBy',
            `${locale}.${key} ignores argument ${index}`,
          );
        }
      }
    }
  });

  test('every error code has text in both languages', () => {
    for (const code of Object.keys(ja.errors)) {
      assert.ok(code in en.errors, code);
    }
  });

  test('the 100-step wording matches the policy constant', async () => {
    const { STEP_THRESHOLD } = await import('../src/alarmPolicy');
    assert.equal(STEP_THRESHOLD, 100);
    assert.match(ja.checkIn.stepsDetected, /100/);
    assert.match(en.checkIn.stepsDetected, /100/);
  });
});

describe('locale resolution', () => {
  test('Japanese is the default and the fallback', () => {
    assert.equal(resolveAppLocale([]), 'ja');
    assert.equal(resolveAppLocale(['fr-FR', 'de-DE']), 'ja');
    assert.equal(resolveAppLocale(['ja-JP']), 'ja');
  });

  test('a device whose language is English gets English', () => {
    assert.equal(resolveAppLocale(['en-US']), 'en');
    assert.equal(resolveAppLocale(['en_GB']), 'en');
    assert.equal(resolveAppLocale(['EN']), 'en');
  });

  test('the first supported language in the device ranking wins', () => {
    assert.equal(resolveAppLocale(['fr-FR', 'en-US', 'ja-JP']), 'en');
    assert.equal(resolveAppLocale(['ja-JP', 'en-US']), 'ja');
  });

  test('settings keep the device region and the 12/24-hour preference', () => {
    const gb = resolveLocaleSettings({
      languageTags: ['en-GB'],
      uses24HourClock: true,
    });
    assert.equal(gb.locale, 'en');
    assert.equal(gb.intlTag, 'en-GB');
    assert.equal(gb.hour12, false);
    assert.equal(
      resolveLocaleSettings({ languageTags: ['en-US'], uses24HourClock: false })
        .hour12,
      true,
    );
    assert.equal(
      resolveLocaleSettings({ languageTags: ['ja-JP'], uses24HourClock: null })
        .hour12,
      null,
    );
  });

  test('an unusable tag falls back to the default tag for the language', () => {
    const settings = resolveLocaleSettings({
      languageTags: ['en-ZZ-invalid-tag-!!'],
      uses24HourClock: null,
    });
    assert.equal(settings.locale, 'en');
    assert.equal(settings.intlTag, 'en-US');
  });

  test('a change in language or clock is detected, an identical read is not', () => {
    assert.equal(sameLocaleSettings(JA_SETTINGS, { ...JA_SETTINGS }), true);
    assert.equal(sameLocaleSettings(JA_SETTINGS, EN_SETTINGS), false);
    assert.equal(
      sameLocaleSettings(EN_SETTINGS, { ...EN_SETTINGS, hour12: true }),
      false,
    );
  });
});

describe('formatter', () => {
  // 2026-10-15 is a Thursday. A fixed zone makes the result machine independent.
  const ZONE = 'Asia/Tokyo';
  const at = Date.UTC(2026, 9, 14, 22, 5); // 2026-10-15 07:05 JST
  const midnight = Date.UTC(2026, 9, 14, 15, 5); // 2026-10-15 00:05 JST

  test('Japanese defaults to a padded 24-hour clock', () => {
    const f = createFormatter({ ...JA_SETTINGS, timeZone: ZONE });
    assert.equal(f.clock(7, 5), '07:05');
    assert.equal(f.clockAt(at), '07:05');
    assert.equal(f.day(at), '10/15(木)');
    assert.equal(f.weekdayShort(1), '月');
    assert.equal(f.weekdayLong(1), '月曜日');
  });

  test('English defaults to the 12-hour clock with weekday names', () => {
    const f = createFormatter({ ...EN_SETTINGS, timeZone: ZONE });
    assert.match(f.clock(7, 5), /^7:05\s?AM$/);
    assert.match(f.clockAt(at), /^7:05\s?AM$/);
    assert.equal(f.day(at), 'Thu, 10/15');
    assert.equal(f.weekdayShort(0), 'Sun');
    assert.equal(f.weekdayLong(6), 'Saturday');
  });

  test('the device 24-hour preference overrides the language default', () => {
    const en24 = createFormatter({ ...EN_SETTINGS, hour12: false, timeZone: ZONE });
    assert.equal(en24.clock(7, 5), '07:05');
    assert.equal(en24.clock(18, 30), '18:30');
    assert.equal(en24.clockAt(midnight), '00:05');
    const ja12 = createFormatter({ ...JA_SETTINGS, hour12: true, timeZone: ZONE });
    assert.match(ja12.clock(18, 30), /6:30/);
    assert.match(ja12.clock(18, 30), /午後/);
  });

  test('the wall-clock formatter does not depend on the time zone', () => {
    const tokyo = createFormatter({ ...EN_SETTINGS, hour12: false, timeZone: ZONE });
    const la = createFormatter({
      ...EN_SETTINGS,
      hour12: false,
      timeZone: 'America/Los_Angeles',
    });
    assert.equal(tokyo.clock(7, 5), la.clock(7, 5));
    assert.notEqual(tokyo.clockAt(at), la.clockAt(at));
  });
});

describe('text built from the formatter', () => {
  test('repeat labels use the language and the localized weekday names', () => {
    const custom = { kind: 'custom' as const, weekdays: [1, 3, 5] as (0 | 1 | 3 | 5)[] };
    assert.equal(
      formatRepeatLabel(custom, JA_TEXT.messages, JA_TEXT.formatter),
      '月・水・金',
    );
    assert.equal(
      formatRepeatLabel(custom, EN_TEXT.messages, EN_TEXT.formatter),
      'Mon, Wed, Fri',
    );
    for (const kind of ['today', 'daily', 'weekdays'] as const) {
      const label = formatRepeatLabel(
        { kind, weekdays: [] },
        EN_TEXT.messages,
        EN_TEXT.formatter,
      );
      assert.doesNotMatch(label, CJK);
    }
  });

  test('lead times are spoken in each language with correct plurals', () => {
    const minute = 60_000;
    assert.equal(formatLeadTime(0, ja), 'まもなく鳴ります');
    assert.equal(formatLeadTime(2 * 60 * minute + 5 * minute, ja), '2時間5分後');
    assert.equal(formatLeadTime(minute, en), 'in 1 minute');
    assert.equal(formatLeadTime(125 * minute, en), 'in 2 hours 5 minutes');
    assert.equal(formatLeadTime(60 * minute, en), 'in 1 hour');
    assert.equal(formatLeadTime(25 * 60 * minute, en), 'in 1 day 1 hour');
  });

  test('the composer summary follows the language and the clock preference', () => {
    const now = new Date(2026, 9, 2, 22, 0, 0).getTime();
    const input = {
      nowMs: now,
      hour: 7,
      minute: 0,
      repeatKind: 'daily' as const,
      customWeekdays: [] as never[],
    };
    const jaSummary = summarizeNewAlarm({ ...input, text: JA_TEXT });
    assert.match(jaSummary.text, /^毎日・初回 .+ 07:00（9時間後）$/);
    const enSummary = summarizeNewAlarm({ ...input, text: EN_TEXT });
    assert.match(enSummary.text, /^Every day · first .+ 7:00\s?AM \(in 9 hours\)$/);
    const en24 = summarizeNewAlarm({
      ...input,
      text: createTextContext({ ...EN_SETTINGS, hour12: false }),
    });
    assert.match(en24.text, /07:00 \(in 9 hours\)$/);
    assert.equal(enSummary.canAdd, jaSummary.canAdd);
    assert.equal(enSummary.isDistant, jaSummary.isDistant);
  });

  test('the delivery warning reads as a sentence in English with and without a next alarm', () => {
    for (const state of ['off', 'silent', 'unknown'] as const) {
      const withNext = getNotificationDeliveryWarningCopy(state, 'Thu, 10/15 7:00 AM', en);
      const without = getNotificationDeliveryWarningCopy(state, null, en);
      for (const text of [withNext.title, withNext.body, withNext.scheduleLine, without.body]) {
        assert.doesNotMatch(text, CJK);
      }
      assert.match(withNext.body, /^[A-Z].*\.$/);
      assert.match(without.body, /^[A-Z].*\.$/);
      assert.match(withNext.body, /Thu, 10\/15 7:00 AM/);
    }
  });

  test('bedside guidance never promises a sound in English either', () => {
    for (const state of ['off', 'silent', 'unknown', null] as const) {
      const guidance = getBedsideGuidance(state, en);
      assert.doesNotMatch(guidance.detail, /single notification sound/);
      assert.doesNotMatch(guidance.keepAwakeFailure, /single notification sound/);
    }
    assert.match(getBedsideGuidance('ok', en).detail, /single notification sound/);
  });
});

describe('error catalog texts', () => {
  const codes = Object.keys(JA_ERROR_TEXTS) as ErrorCode[];

  test('every catalog code has an English and a Japanese sentence pair', () => {
    assert.equal(codes.length, ERROR_CODES.length);
    assert.deepEqual(Object.keys(en.errors).sort(), [...ERROR_CODES].sort());
    assert.deepEqual(Object.keys(ja.errors).sort(), [...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      for (const messages of [ja, en]) {
        assert.ok(messages.errors[code].message.trim().length > 0, code);
        assert.ok(messages.errors[code].recovery.trim().length > 0, code);
      }
    }
  });

  test('Japanese is the catalog text itself and English contains no Japanese', () => {
    for (const code of ERROR_CODES) {
      assert.equal(ja.errors[code].message, describeErrorCode(code).message, code);
      assert.equal(ja.errors[code].recovery, describeErrorCode(code).recovery, code);
      assert.doesNotMatch(en.errors[code].message, CJK, code);
      assert.doesNotMatch(en.errors[code].recovery, CJK, code);
      assert.notEqual(en.errors[code].message, ja.errors[code].message, code);
    }
  });

  test('the notice keeps its code, tone and retry policy in every language', () => {
    for (const code of ERROR_CODES) {
      const inJa = noticeFromCodeIn(ja, code);
      const inEn = noticeFromCodeIn(en, code);
      assert.equal(inJa.code, code);
      assert.equal(inEn.code, code);
      assert.equal(inJa.tone, describeErrorCode(code).tone, code);
      assert.equal(inEn.tone, inJa.tone, code);
      assert.doesNotMatch(inEn.text, CJK, code);
    }
  });

  test('sentences are separated by the language, not run together', () => {
    const notice = noticeFromCodeIn(en, 'NTF_PERMISSION_DENIED');
    assert.equal(
      notice.text,
      `${en.errors.NTF_PERMISSION_DENIED.message} ${en.errors.NTF_PERMISSION_DENIED.recovery}`,
    );
    assert.equal(
      noticeFromCodeIn(ja, 'NTF_PERMISSION_DENIED').text,
      describeErrorCode('NTF_PERMISSION_DENIED').message +
        describeErrorCode('NTF_PERMISSION_DENIED').recovery,
    );
  });

  test('several outcomes keep every sentence, the worst tone and the first code', () => {
    for (const messages of [ja, en]) {
      const notice = noticeFromCodesIn(messages, [
        'STOP_FOLLOWUP_FAILED',
        'STOP_CLEANUP_MEMORY_ONLY',
      ]);
      assert.equal(notice.code, 'STOP_FOLLOWUP_FAILED');
      assert.equal(notice.tone, 'warning');
      assert.ok(notice.text.includes(messages.errors.STOP_FOLLOWUP_FAILED.message));
      assert.ok(notice.text.includes(messages.errors.STOP_CLEANUP_MEMORY_ONLY.message));
    }
    const worst = noticeFromCodesIn(en, ['STOP_CLEANUP_UNCONFIRMED', 'STOP_RESET_PENDING']);
    assert.equal(worst.tone, 'danger');
    assert.equal(worst.code, 'STOP_CLEANUP_UNCONFIRMED');
  });

  test('a thrown value contributes only its catalog code, never a foreign-language message', () => {
    const coded = new AppError('ALARM_NOT_FOUND');
    assert.equal(describeErrorIn(en, coded).text, noticeFromCodeIn(en, 'ALARM_NOT_FOUND').text);
    assert.equal(describeErrorIn(ja, coded).code, 'ALARM_NOT_FOUND');
    for (const unknown of [new Error('ECONNRESET /private/var token=abc'), 'boom', null]) {
      const notice = describeErrorIn(en, unknown);
      assert.equal(notice.code, 'UNEXPECTED_FAILURE');
      assert.doesNotMatch(notice.text, /ECONNRESET|private|token/);
    }
    assert.equal(describeErrorIn(en, new Error('x'), 'REFILL_FAILED').code, 'REFILL_FAILED');
  });

  test('durable and memory-only tracking are never worded alike in English', () => {
    const pairs: [ErrorCode, ErrorCode][] = [
      ['SNOOZE_CLEANUP_UNCONFIRMED', 'SNOOZE_CLEANUP_MEMORY_ONLY'],
      ['SNOOZE_ACCEPTED_CLEANUP_UNCONFIRMED', 'SNOOZE_ACCEPTED_CLEANUP_MEMORY_ONLY'],
      ['STOP_CLEANUP_UNCONFIRMED', 'STOP_CLEANUP_MEMORY_ONLY'],
    ];
    for (const [durable, memoryOnly] of pairs) {
      const d = noticeFromCodeIn(en, durable).text;
      const m = noticeFromCodeIn(en, memoryOnly).text;
      assert.match(d, /saved on this device|recorded on this device/i, durable);
      assert.match(m, /quit|close|closed|force/i, memoryOnly);
      assert.doesNotMatch(m, /will check|reopen the app, it will/i, memoryOnly);
    }
  });
});

describe('what stays the same in every language', () => {
  test('notification action and category identifiers are not in the catalog', () => {
    const everything = JSON.stringify([...flatten(ja).values(), ...flatten(en).values()].map(String));
    assert.ok(!everything.includes(CONFIRM_AWAKE_ACTION));
    assert.ok(!everything.includes(AWAKE_CHECKIN_CATEGORY));
  });

  test('the main notification body differs only in language, not in structure', () => {
    for (const messages of [ja, en]) {
      const repeating = getMainAlarmNotificationBody({ repeats: true }, messages);
      const once = getMainAlarmNotificationBody({ repeats: false }, messages);
      assert.ok(repeating.startsWith(once));
      assert.notEqual(repeating, once);
    }
  });
});

describe('source hygiene', () => {
  function sources(dir: string): string[] {
    return readdirSync(new URL(dir, import.meta.url)).flatMap((name) => {
      const url = new URL(`${dir}/${name}`, import.meta.url);
      if (statSync(url).isDirectory()) {
        return name === 'i18n' ? [] : sources(`${dir}/${name}`);
      }
      return /\.tsx?$/.test(name) ? [`${dir}/${name}`] : [];
    });
  }

  test('no Japanese text outside the catalog: screens, policy and services use it', () => {
    // The error catalog owns the Japanese sentences of every failure code; the
    // English table lives under src/i18n.
    const files = ['../App.tsx', ...sources('../src')].filter(
      (file) => file !== '../src/errorCatalog.ts',
    );
    const offenders = files.filter((file) =>
      CJK.test(readFileSync(new URL(file, import.meta.url), 'utf8')),
    );
    assert.deepEqual(offenders, []);
  });

  test('pure policy modules stay free of React Native and expo-localization', () => {
    const ok = sources('../src').filter(
      (file) => !file.startsWith('../src/ui/') && !file.endsWith('notificationService.ts') && !file.endsWith('Storage.ts') && !file.endsWith('alarmSound.ts') && !/\/use[A-Z]\w*\.ts$/.test(file),
    );
    for (const file of ok) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(text, /from 'react-native'|from 'expo-localization'/, file);
    }
  });
});
