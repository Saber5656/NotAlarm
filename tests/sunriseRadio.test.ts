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
