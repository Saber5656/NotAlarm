/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { radioSemantics } from "../src/ui/radioSemantics";

test("a selected row exposes native state, web ARIA and non-color text", () => {
  const selected = radioSemantics(true, false);
  assert.equal(selected.accessibilityRole, "radio");
  assert.equal(selected.accessibilityState.checked, true);
  assert.equal(selected["aria-checked"], true);
  assert.equal(selected.marker, "✓ 選択中");
  const other = radioSemantics(false, true);
  assert.equal(other.accessibilityState.checked, false);
  assert.equal(other.accessibilityState.disabled, true);
  assert.equal(other["aria-checked"], false);
  assert.equal(other.marker, null);
});

import { deviceChoiceSemantics } from "../src/ui/radioSemantics";

test("the current-location choice exposes checked state, web ARIA and a selected label", () => {
  const selected = deviceChoiceSemantics(true, false);
  assert.equal(selected.accessibilityRole, "radio");
  assert.equal(selected.accessibilityState.checked, true);
  assert.equal(selected["aria-checked"], true);
  assert.equal(selected.marker, "✓ 選択中");
  assert.match(selected.accessibilityLabel, /使用中/);
  const idle = deviceChoiceSemantics(false, true);
  assert.equal(idle.accessibilityState.checked, false);
  assert.equal(idle.accessibilityState.disabled, true);
  assert.equal(idle["aria-checked"], false);
  assert.equal(idle.marker, null);
  assert.equal(idle.accessibilityLabel, "現在地を使う");
});

import { readFileSync } from "node:fs";

test("the settings sheet applies the device-choice semantics to the sun-device control", () => {
  const source = readFileSync("src/ui/SunriseSettings.tsx", "utf8");
  assert.match(source, /deviceChoiceSemantics\(deviceSelected, disabled\)/);
  const control = source.slice(source.indexOf("<Pressable\n        accessibilityHint"));
  const props = control.slice(0, control.indexOf('testID="sun-device"'));
  assert.match(props, /accessibilityRole=\{device\.accessibilityRole\}/);
  assert.match(props, /aria-checked=\{device\['aria-checked'\]\}/);
  assert.match(props, /accessibilityLabel=\{device\.accessibilityLabel\}/);
  assert.doesNotMatch(props, /accessibilityRole="button"/);
});
