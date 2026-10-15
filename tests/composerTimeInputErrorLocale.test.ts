import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync("src/ui/AlarmComposerModal.tsx", "utf8");

test("time input error is a locale-independent flag, not copied text", () => {
  assert.doesNotMatch(composer, /useState<string \| null>\(null\);\s*\n\s*\n\s*useEffect/);
  assert.match(composer, /\[hasTimeInputError, setHasTimeInputError\] = useState\(false\)/);
  assert.doesNotMatch(composer, /setTimeInputError\(message\)/);
  assert.doesNotMatch(composer, /\{timeInputError\}/);
});

test("time input error renders the current provider message and still announces", () => {
  assert.match(composer, /\{hasTimeInputError \? \(/);
  assert.match(composer, /\{messages\.composer\.timeInputInvalid\}/);
  assert.match(composer, /announceForAccessibility\(\s*messages\.composer\.timeInputInvalid,?\s*\)/);
  assert.match(composer, /accessibilityRole="alert"/);
});

test("invalid draft values are preserved when the error is flagged", () => {
  const catchBlock = composer.slice(composer.indexOf("} catch {", composer.indexOf("confirmTimeEditing")));
  assert.doesNotMatch(catchBlock.slice(0, 400), /setDraft(Hour|Minute)/);
});
