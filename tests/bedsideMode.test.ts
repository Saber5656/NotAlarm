/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { makeAlarmRepeat } from '../src/alarmSchedule';
import type {
  AlarmPhase,
  StoredAlarm,
  StoredAlarmDefinition,
} from '../src/alarmStorage';
import {
  BEDSIDE_GUIDANCE,
  KEEP_AWAKE_LOOKAHEAD_MS,
  isForegroundAppState,
  shouldKeepScreenAwake,
} from '../src/bedsideMode';
import { BEDSIDE_FOOTER_COLORS } from '../src/ui/tokens';

const NOW = new Date(2026, 9, 5, 22, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function cycle(dueAtMs: number, phase: AlarmPhase = 'armed'): StoredAlarm {
  return {
    alarmId: 'alarm-1',
    cycleId: `cycle-${dueAtMs}-${phase}`,
    mainAlarmId: `main-${dueAtMs}`,
    armedAtMs: NOW - MINUTE,
    dueAtMs,
    phase,
    stepCount: 0,
    stepCandidateRecorded: false,
  };
}

function alarm(
  cycles: StoredAlarm[],
  overrides: { id?: string; enabled?: boolean } = {},
): StoredAlarmDefinition {
  return {
    id: overrides.id ?? 'alarm-1',
    hour: 7,
    minute: 0,
    repeat: makeAlarmRepeat('daily', NOW),
    enabled: overrides.enabled ?? true,
    createdAtMs: NOW - 86_400_000,
    cycles,
  };
}

describe('shouldKeepScreenAwake', () => {
  test('the look-ahead window is 24 hours', () => {
    assert.equal(KEEP_AWAKE_LOOKAHEAD_MS, 24 * HOUR);
  });

  test('no alarms lets the screen sleep', () => {
    assert.equal(shouldKeepScreenAwake([], NOW), false);
  });

  test('a ringing cycle keeps the screen awake', () => {
    assert.equal(
      shouldKeepScreenAwake([alarm([cycle(NOW - MINUTE, 'ringing')])], NOW),
      true,
    );
  });

  test('a ringing cycle keeps the screen awake even if its alarm was turned off', () => {
    // The ringing card and loop sound do not depend on `enabled`, so the
    // screen must stay on until the user stops it.
    assert.equal(
      shouldKeepScreenAwake(
        [alarm([cycle(NOW - MINUTE, 'ringing')], { enabled: false })],
        NOW,
      ),
      true,
    );
  });

  test('an enabled alarm due in 23h59m keeps the screen awake', () => {
    assert.equal(
      shouldKeepScreenAwake([alarm([cycle(NOW + 24 * HOUR - MINUTE)])], NOW),
      true,
    );
  });

  test('a step candidate cycle is still monitored and keeps the screen awake', () => {
    assert.equal(
      shouldKeepScreenAwake(
        [alarm([cycle(NOW + 30 * MINUTE, 'step_candidate')])],
        NOW,
      ),
      true,
    );
  });

  test('a cycle due exactly 24 hours ahead is inside the window', () => {
    assert.equal(
      shouldKeepScreenAwake([alarm([cycle(NOW + 24 * HOUR)])], NOW),
      true,
    );
  });

  test('a cycle due more than 24 hours ahead lets the screen sleep', () => {
    assert.equal(
      shouldKeepScreenAwake([alarm([cycle(NOW + 24 * HOUR + 1)])], NOW),
      false,
    );
    assert.equal(
      shouldKeepScreenAwake(
        [alarm([cycle(NOW + 2 * 24 * HOUR), cycle(NOW + 3 * 24 * HOUR)])],
        NOW,
      ),
      false,
    );
  });

  test('disabled alarms never keep the screen awake for their monitoring cycles', () => {
    assert.equal(
      shouldKeepScreenAwake(
        [
          alarm([cycle(NOW + HOUR)], { id: 'a', enabled: false }),
          alarm([cycle(NOW + 2 * HOUR, 'step_candidate')], {
            id: 'b',
            enabled: false,
          }),
        ],
        NOW,
      ),
      false,
    );
  });

  test('stopped cycles do not keep the screen awake', () => {
    assert.equal(
      shouldKeepScreenAwake(
        [
          alarm([
            cycle(NOW + HOUR, 'suppressed'),
            cycle(NOW + 2 * HOUR, 'dismissed'),
          ]),
        ],
        NOW,
      ),
      false,
    );
  });

  test('a past-due monitoring cycle keeps the screen awake because it is about to ring', () => {
    // The one-second tick moves it to `ringing`; letting the screen sleep in
    // between would suspend the app before the loop sound starts.
    assert.equal(
      shouldKeepScreenAwake([alarm([cycle(NOW - 5 * MINUTE)])], NOW),
      true,
    );
    assert.equal(shouldKeepScreenAwake([alarm([cycle(NOW)])], NOW), true);
  });

  test('one enabled alarm within 24 hours is enough among several alarms', () => {
    const farAlarm = alarm([cycle(NOW + 3 * 24 * HOUR)], { id: 'far' });
    const offAlarm = alarm([cycle(NOW + HOUR)], { id: 'off', enabled: false });
    assert.equal(shouldKeepScreenAwake([farAlarm, offAlarm], NOW), false);
    assert.equal(
      shouldKeepScreenAwake(
        [farAlarm, offAlarm, alarm([cycle(NOW + 9 * HOUR)], { id: 'soon' })],
        NOW,
      ),
      true,
    );
  });
});

describe('isForegroundAppState', () => {
  test('only the background state releases the screen', () => {
    assert.equal(isForegroundAppState('active'), true);
    // iOS reports inactive while Control Center or a call overlay is shown;
    // the app is still on screen.
    assert.equal(isForegroundAppState('inactive'), true);
    assert.equal(isForegroundAppState('background'), false);
  });

  test('an unknown state is treated as foreground so the screen does not sleep', () => {
    assert.equal(isForegroundAppState('unknown'), true);
    assert.equal(isForegroundAppState(null), true);
    assert.equal(isForegroundAppState(undefined), true);
  });
});

describe('BEDSIDE_GUIDANCE', () => {
  test('tells the user to keep the app open while charging', () => {
    assert.match(BEDSIDE_GUIDANCE.title, /アプリを開いたまま/);
    assert.match(BEDSIDE_GUIDANCE.title, /充電/);
  });

  test('states what is lost when the app is closed instead of promising an alarm', () => {
    assert.match(BEDSIDE_GUIDANCE.detail, /閉じると/);
    assert.match(BEDSIDE_GUIDANCE.detail, /通知音1回だけ/);
    assert.match(BEDSIDE_GUIDANCE.detail, /歩数確認なし/);
  });
});

// WCAG 2.x relative luminance / contrast ratio.
type Rgb = [number, number, number];

function parseColor(color: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return {
      rgb: [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff],
      alpha: 1,
    };
  }
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(color);
  assert.ok(rgba, `unsupported color ${color}`);
  return {
    rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
    alpha: Number(rgba[4]),
  };
}

function composite(top: string, bottom: Rgb): Rgb {
  const { rgb, alpha } = parseColor(top);
  return rgb.map(
    (channel, index) => channel * alpha + bottom[index] * (1 - alpha),
  ) as Rgb;
}

function luminance([red, green, blue]: Rgb): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrast(foreground: Rgb, background: Rgb): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

describe('BEDSIDE_FOOTER_COLORS', () => {
  test('footer text keeps at least 4.5:1 over any background photo', () => {
    // The footer draws its own backdrop, so the worst case is a pure white or
    // pure black photo pixel showing through it.
    for (const photo of [
      [255, 255, 255],
      [0, 0, 0],
    ] as Rgb[]) {
      const backdrop = composite(BEDSIDE_FOOTER_COLORS.backdrop, photo);
      for (const text of [
        BEDSIDE_FOOTER_COLORS.title,
        BEDSIDE_FOOTER_COLORS.detail,
      ]) {
        const ratio = contrast(composite(text, backdrop), backdrop);
        assert.ok(
          ratio >= 4.5,
          `${text} on ${BEDSIDE_FOOTER_COLORS.backdrop} over ${photo}: ${ratio.toFixed(2)}`,
        );
      }
    }
  });
});
