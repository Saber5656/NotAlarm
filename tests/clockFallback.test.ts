/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createTextContext } from '../src/i18n/context';
import type { LocaleSettings } from '../src/i18n/locale';

const settings = (
  locale: 'ja' | 'en',
  intlTag: string,
  hour12: boolean | null,
): LocaleSettings => ({ locale, intlTag, hour12, timeZone: 'UTC' });

describe('clock preference fallback follows the Intl locale convention', () => {
  test('no device preference: en-GB 24h, en-US 12h, ja-JP 24h', () => {
    assert.equal(createTextContext(settings('en', 'en-GB', null)).uses24HourClock, true);
    assert.equal(createTextContext(settings('en', 'en-US', null)).uses24HourClock, false);
    assert.equal(createTextContext(settings('ja', 'ja-JP', null)).uses24HourClock, true);
  });

  test('explicit device preference wins', () => {
    assert.equal(createTextContext(settings('en', 'en-GB', true)).uses24HourClock, false);
    assert.equal(createTextContext(settings('en', 'en-US', false)).uses24HourClock, true);
    assert.equal(createTextContext(settings('ja', 'ja-JP', true)).uses24HourClock, false);
  });

  test('formatter and picker agree, canonical times and midnight kept', () => {
    for (const [locale, tag] of [['en', 'en-GB'], ['en', 'en-US'], ['ja', 'ja-JP']] as const) {
      for (const hour12 of [null, true, false]) {
        const ctx = createTextContext(settings(locale, tag, hour12));
        const text = ctx.formatter.clock(15, 5);
        assert.equal(/am|pm/i.test(text) || /午/.test(text), !ctx.uses24HourClock, `${tag} ${hour12}: ${text}`);
      }
    }
    const gb = createTextContext(settings('en', 'en-GB', false));
    assert.match(gb.formatter.clock(0, 5), /^00:05$/);
  });
});
