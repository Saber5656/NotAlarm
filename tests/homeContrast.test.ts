/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import { HOME_COLORS } from '../src/ui/tokens';

type Rgba = [number, number, number, number];

function parse(color: string): Rgba {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      1,
    ];
  }
  const parts = color.match(/[\d.]+/g)!.map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

function over(top: Rgba, bottom: [number, number, number]) {
  return [0, 1, 2].map(
    (i) => top[i] * top[3] + bottom[i] * (1 - top[3]),
  ) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(
  foreground: string,
  background: string,
  photo: [number, number, number],
): number {
  const bg = over(parse(background), photo);
  const fgRgba = parse(foreground);
  const fg = over(fgRgba, bg);
  const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

const WHITE_PHOTO: [number, number, number] = [255, 255, 255];
const BLACK_PHOTO: [number, number, number] = [0, 0, 0];

test('summary card small text keeps 4.5:1 over a white or black photo', () => {
  for (const photo of [WHITE_PHOTO, BLACK_PHOTO]) {
    for (const [name, color] of Object.entries(HOME_COLORS.summaryText)) {
      assert.ok(
        contrast(color, HOME_COLORS.summaryBackdrop, photo) >= 4.5,
        `summary ${name} ${color}`,
      );
    }
    assert.ok(
      contrast(
        HOME_COLORS.progressFill,
        HOME_COLORS.progressTrack,
        photo,
      ) >= 3,
      'progress fill vs track',
    );
  }
});

test('list panel small text keeps 4.5:1 over a white or black photo', () => {
  for (const photo of [WHITE_PHOTO, BLACK_PHOTO]) {
    for (const [name, color] of Object.entries(HOME_COLORS.listText)) {
      assert.ok(
        contrast(color, HOME_COLORS.listBackdrop, photo) >= 4.5,
        `list ${name} ${color}`,
      );
    }
  }
});
