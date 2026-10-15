/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

import { OWNER, sourcesUnder } from './support/source';

// These are structural checks on the JSX source (the screens cannot be
// rendered under tsx). They catch a control losing its role, label or large
// text behavior; they are NOT a VoiceOver / TalkBack verification, which
// stays pending on a device (docs/DEVICE_TEST.md).
const FILES = [
  // Every state screen of the home view (the former single App.tsx JSX).
  ...sourcesUnder('src/ui/screens').filter((file) => file.endsWith('.tsx')),
  OWNER.app,
  'src/ui/AlarmComposerModal.tsx',
  'src/ui/SettingsModal.tsx',
  'src/ui/NoticeBanner.tsx',
  'src/ui/LiquidComposerTabs.tsx',
  'src/ui/LiquidRepeatSelector.tsx',
];

function read(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
}

/** The attribute text of every `<Tag ...>` opening element in a source. */
function openingTags(source: string, tag: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(`<${tag}`, from);
    if (start === -1) {
      return tags;
    }
    const after = source[start + tag.length + 1];
    from = start + tag.length + 1;
    if (after !== ' ' && after !== '\n') {
      continue;
    }
    let depth = 0;
    let end = from;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === '{' || char === '(') {
        depth += 1;
      } else if (char === '}' || char === ')') {
        depth -= 1;
      } else if (char === '>' && depth === 0 && source[end - 1] !== '=') {
        break;
      }
    }
    tags.push(source.slice(start, end + 1));
    from = end;
  }
}

describe('controls', () => {
  test('every pressable is a button for assistive technology, or hidden decoration', () => {
    let seen = 0;
    for (const file of FILES) {
      for (const tag of openingTags(read(file), 'Pressable')) {
        seen += 1;
        assert.ok(
          /accessibilityRole="button"/.test(tag) || /\.\.\.(toggle|segmentRadio|tab|radio|deviceChoice)Semantics\(/.test(tag) || /accessibilityRole=\{[^}]*\}/.test(tag) || /accessible=\{false\}/.test(tag),
          `${file}: Pressable without a role\n${tag.slice(0, 200)}`,
        );
      }
    }
    assert.ok(seen >= 20, `scanner found only ${seen} pressables`);
  });

  test('icon-only controls carry a label from the catalog, never a literal', () => {
    // The glyph buttons (＋ ⋯ × ✕) have no text a screen reader could read.
    for (const file of FILES) {
      for (const tag of openingTags(read(file), 'Pressable')) {
        const label = tag.match(/accessibilityLabel=(\{[^}]*\}|"[^"]*")/)?.[1];
        if (label?.startsWith('"')) {
          assert.fail(`${file}: hard-coded accessibility label ${label}`);
        }
      }
    }
    const header = read(OWNER.header);
    assert.match(header, /accessibilityLabel=\{messages\.alarmList\.add\}/);
    assert.match(header, /accessibilityLabel=\{messages\.settings\.openLabel\}/);
    assert.match(read('src/ui/NoticeBanner.tsx'), /accessibilityLabel=\{messages\.notice\.dismiss\}/);
    assert.match(read('src/ui/AlarmComposerModal.tsx'), /accessibilityLabel=\{messages\.composer\.close\}/);
  });

  test('the primary stop, add and confirm controls report their disabled and busy state', () => {
    for (const [file, label] of [
      [OWNER.ringingCard, 'messages.ringing.stopHint'],
      [OWNER.missedCard, 'messages.missed.acknowledgeAllHint'],
    ] as const) {
      const card = read(file);
      const at = card.indexOf(label);
      assert.notEqual(at, -1, label);
      const tag = card.slice(at - 200, at + 600);
      assert.match(tag, /accessibilityState=\{\{ disabled: isBusy \}\}/, label);
    }
    const composer = read('src/ui/AlarmComposerModal.tsx');
    assert.match(
      composer,
      /accessibilityLabel=\{\s*isEdit \? messages\.composer\.editSubmit : messages\.composer\.submit\s*\}/,
    );
    assert.match(composer, /busy: isBusy,\s+disabled: !submitEnabled/);
    // When add is disabled, the reason is the hint, not just a dimmed button.
    assert.match(composer, /\(weekdaySelectionError \?\? summary\.text\)/);
  });

  test('the ringing stop control receives screen reader focus with a self-contained label', () => {
    assert.match(read(OWNER.accessibilityEdge), /AccessibilityInfo\.setAccessibilityFocus\(handle\)/);
    assert.match(read(OWNER.ringingCard), /getRingingStopA11yLabel\(/);
  });
});

describe('status is not conveyed by color alone', () => {
  test('a warning schedule line gets a text marker and a spoken prefix', () => {
    const list = read(OWNER.list);
    assert.match(list, /\{scheduleLineWarns \? '⚠ ' : ''\}/);
    assert.match(list, /messages\.alarmList\.warningLabel/);
  });

  test('notices announce their tone as a live region and carry a symbol', () => {
    const banner = read('src/ui/NoticeBanner.tsx');
    assert.match(banner, /accessibilityLiveRegion=/);
    assert.match(banner, /SYMBOLS\[notice\.tone\]/);
  });

  test('on/off and ended states are written out in the row, not only styled', () => {
    const list = read(OWNER.list);
    assert.match(list, /messages\.alarmList\.off/);
    assert.match(list, /todayExpiry\.rowLabel/);
  });
});

describe('modals', () => {
  test('both sheets are modal for screen readers, closable, and expose a header', () => {
    for (const file of ['src/ui/AlarmComposerModal.tsx', 'src/ui/SettingsModal.tsx']) {
      const source = read(file);
      assert.match(source, /accessibilityViewIsModal/, file);
      assert.match(source, /onRequestClose=/, file);
      assert.match(source, /accessibilityRole="header"/, file);
    }
  });

  test('the composer moves screen reader focus to its title when it opens', () => {
    const composer = read('src/ui/AlarmComposerModal.tsx');
    assert.match(composer, /sendAccessibilityEvent\(titleRef\.current, 'focus'\)/);
  });

  test('the form scrolls, and the primary action is pinned outside the scroll area', () => {
    const composer = read('src/ui/AlarmComposerModal.tsx');
    const scrollAt = composer.indexOf('<ScrollView');
    const scrollEnd = composer.indexOf('</ScrollView>');
    const footerAt = composer.indexOf('styles.sheetFooter');
    assert.ok(scrollAt !== -1 && scrollEnd > scrollAt);
    assert.ok(footerAt > scrollEnd, 'submit button lives below the scroll view');
    assert.match(read('src/ui/SettingsModal.tsx'), /<ScrollView/);
  });
});

describe('large text and small screens', () => {
  test('single-line text is only used where it shrinks to fit or is capped', () => {
    for (const file of FILES) {
      for (const tag of openingTags(read(file), 'Text')) {
        if (!/numberOfLines=\{1\}/.test(tag)) {
          continue;
        }
        assert.ok(
          /adjustsFontSizeToFit/.test(tag) || /maxFontSizeMultiplier/.test(tag),
          `${file}: single-line Text can truncate\n${tag.slice(0, 160)}`,
        );
      }
    }
  });

  test('the home screen scrolls at accessibility font sizes', () => {
    // The font-scale rule (above 1.3) lives in getScreenScrollPolicy.
    assert.match(read(OWNER.app), /const screenScroll = getScreenScrollPolicy\(\{[^}]*fontScale/);
    assert.match(read(OWNER.home), /useAccessibilityScroll=\{screenScroll\.scroll\}/);
    assert.match(read('src/screenScroll.ts'), /LARGE_TEXT_SCALE = 1\.3/);
  });

  test('rows that hold a title and an action wrap instead of overflowing', () => {
    const delivery = read(OWNER.deliveryCard);
    const header = delivery.slice(delivery.indexOf('deliveryWarningHeader: {'));
    assert.match(header.slice(0, 200), /flexWrap: 'wrap'/);
    const next = read(OWNER.nextCard);
    const progress = next.slice(next.indexOf('progressCopy: {'));
    assert.match(progress.slice(0, 200), /flexWrap: 'wrap'/);
  });

  test('touch targets are at least 44pt for the small text buttons', () => {
    for (const [file, name] of [
      [OWNER.deliveryCard, 'settingsButton'],
      [OWNER.list, 'deleteButton'],
      [OWNER.loadFailedCard, 'resetButton'],
    ] as const) {
      const source = read(file);
      assert.notEqual(source.indexOf(`  ${name}: {`), -1, `${file}: ${name}`);
      const block = source.slice(source.indexOf(`  ${name}: {`));
      assert.match(block.slice(0, 120), /minHeight: 44/, name);
    }
  });
});

describe('language and clock follow the device', () => {
  test('the app refreshes language and clock when it returns to the foreground', () => {
    const text = read(OWNER.deviceText);
    const at = text.indexOf('const refreshLocale = () => {');
    assert.notEqual(at, -1);
    const body = text.slice(at, at + 1200);
    assert.match(body, /readDeviceLocaleSettings\(\)/);
    assert.match(body, /setNotificationMessages\(/);
    assert.match(body, /subscribeAppState\(/);
    assert.match(body, /state === 'active'/);
    // The edge subscribes to the real app state change event.
    assert.match(read('src/app/platform/appStateEdge.ts'), /AppState\.addEventListener\('change'/);
  });

  test('the whole screen reads text from one provider', () => {
    assert.match(read(OWNER.app), /<I18nProvider value=\{text\}>/);
  });

  test('time pickers follow the device clock preference', () => {
    const composer = read('src/ui/AlarmComposerModal.tsx');
    assert.match(composer, /is24Hour: uses24HourClock/);
    assert.match(composer, /is24Hour=\{uses24HourClock\}/);
    assert.match(composer, /locale=\{intlTag\}/);
    assert.doesNotMatch(composer, /is24Hour: true/);
  });
});

describe('current editing, skip and sunrise controls carry their semantics', () => {
  test('the edit button is a named, hinted button that reports disabled', () => {
    const list = read(OWNER.list);
    const button = list.slice(list.indexOf('accessibilityHint={messages.edit.editHint}'));
    const props = button.slice(0, button.indexOf('style={styles.editButton}'));
    assert.match(props, /accessibilityLabel=\{messages\.edit\.editSpoken\(/);
    assert.match(props, /accessibilityRole="button"/);
    assert.match(props, /accessibilityState=\{\{ disabled: !editAvailable \}\}/);
  });

  test('the skip button is a labelled, hinted button outside the warning card', () => {
    const skip = read(OWNER.skipButton);
    const at = skip.indexOf('<Pressable');
    const props = skip.slice(at, skip.indexOf('testID="skip-this-occurrence"', at));
    assert.match(props, /accessibilityHint=\{messages\.skip\.hint\}/);
    assert.match(props, /accessibilityLabel=\{messages\.skip\.spoken\(/);
    assert.match(props, /accessibilityRole="button"/);
  });

  test('the composer names itself for the edit mode and speaks the saved content', () => {
    const composer = read('src/ui/AlarmComposerModal.tsx');
    assert.match(composer, /isEdit \? messages\.composer\.editTitle/);
    assert.match(composer, /messages\.composer\.editSummarySpoken\(/);
    assert.match(composer, /messages\.composer\.editSubmit/);
  });

  test('the submit control speaks the same label it shows, in create and edit mode', () => {
    const composer = read('src/ui/AlarmComposerModal.tsx');
    const end = composer.indexOf('onPress={onSubmit}');
    const start = composer.lastIndexOf('<Pressable', end);
    assert.ok(end > 0 && start > 0, 'submit Pressable not found');
    const props = composer.slice(start, end);
    assert.match(
      props,
      /accessibilityLabel=\{\s*isEdit \? messages\.composer\.editSubmit : messages\.composer\.submit\s*\}/,
    );
    assert.match(props, /busy: isBusy/);
    const visible = composer.slice(end, composer.indexOf('</Pressable>', end));
    assert.match(visible, /isEdit \? messages\.composer\.editSubmit : messages\.composer\.submit/);
    assert.match(visible, /<ActivityIndicator/);
  });

  test('the load-failure card shows the message in the current language', () => {
    const source = read(OWNER.loadFailedCard);
    const at = source.indexOf('{loadFailureCode ? (');
    const card = source.slice(at, source.indexOf('common.errorCode', at));
    assert.match(card, /messages\.errors\[loadFailureCode\]\.message/);
    assert.doesNotMatch(card, /describeErrorCode\(/);
  });

  test('sunrise choices read their selected state in the current language', () => {
    const source = read('src/ui/SunriseSettings.tsx');
    assert.match(source, /radioSemantics\(selected, disabled, messages\)/);
    assert.match(source, /messages\.sun\.regions\[/);
    assert.match(source, /sunStatusText\(status, messages,/);
    assert.match(source, /accessibilityLiveRegion="polite"/);
  });
});
