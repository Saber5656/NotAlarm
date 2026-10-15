/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  segmentRadioSemantics,
  tabSemantics,
  toggleSemantics,
} from "../src/ui/choiceSemantics";

test("weekday toggles expose checked state natively and on web", () => {
  const on = toggleSemantics(true, false);
  assert.equal(on.accessibilityRole, "checkbox");
  assert.equal(on.accessibilityState.checked, true);
  assert.equal(on["aria-checked"], true);
  const off = toggleSemantics(false, true);
  assert.equal(off["aria-checked"], false);
  assert.equal(off.accessibilityState.disabled, true);
});

test("repeat segments are exclusive radios and tabs report selected", () => {
  const radio = segmentRadioSemantics(true, false);
  assert.equal(radio.accessibilityRole, "radio");
  assert.equal(radio["aria-checked"], true);
  const tab = tabSemantics(true, false);
  assert.equal(tab.accessibilityRole, "tab");
  assert.equal(tab.accessibilityState.selected, true);
  assert.equal(tab["aria-selected"], true);
  assert.equal(tabSemantics(false, true)["aria-selected"], false);
});

test("components apply the semantics, groups and a visible weekday marker", () => {
  const composer = readFileSync("src/ui/AlarmComposerModal.tsx", "utf8");
  assert.match(composer, /toggleSemantics\(selected, isBusy\)/);
  assert.match(composer, /messages\.sun\.selectedMarker|weekdayCheck/);
  assert.doesNotMatch(composer, /accessibilityRole="button"\s+accessibilityState=\{\{\s+disabled: isBusy,\s+selected/);
  const repeat = readFileSync("src/ui/LiquidRepeatSelector.tsx", "utf8");
  assert.match(repeat, /segmentRadioSemantics\(selected, disabled\)/);
  assert.match(repeat, /accessibilityRole="radiogroup"/);
  const tabs = readFileSync("src/ui/LiquidComposerTabs.tsx", "utf8");
  assert.match(tabs, /tabSemantics\(selected, optionDisabled\)/);
  assert.match(tabs, /accessibilityRole="tablist"/);
});
