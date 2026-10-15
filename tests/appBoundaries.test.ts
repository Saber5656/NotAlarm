import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = process.cwd();

function sources(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      if (!clause?.name && bindings && ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly)) continue;
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.exportClause;
      if (bindings && ts.isNamedExports(bindings) && bindings.elements.length > 0 &&
          bindings.elements.every((item) => item.isTypeOnly)) continue;
      result.push(node.moduleSpecifier.text);
    }
  }
  return result;
}

function localModule(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier);
  return [base + '.ts', base + '.tsx', join(base, 'index.ts')].find(existsSync);
}

test('App composes the app shell without owning alarm services', () => {
  const imports = runtimeImports(join(root, 'App.tsx'));
  assert.ok(imports.some((name) => name.includes('/app/')), 'App must compose the extracted app shell');
  for (const name of imports) {
    assert.doesNotMatch(name, /expo-(notifications|sensors|audio|keep-awake)|alarmStorage|notificationService|suppressionJournal/);
  }
  assert.ok(existsSync(join(root, 'src/app/useAlarmController.ts')), 'one controller owns app state');
  assert.ok(existsSync(join(root, 'src/app/useStepCandidate.ts')), 'step subscription has its own lifecycle hook');
});

test('controller core and alarm policies have no transitive native runtime imports', () => {
  const core = sources(join(root, 'src/app/core'));
  assert.ok(core.length >= 2, 'refill and reconciliation must be testable without React Native');
  const pending = [...core, join(root, 'src/alarmPolicy.ts'), join(root, 'src/alarmOrchestrator.ts')];
  const seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const name of runtimeImports(file)) {
      assert.doesNotMatch(name, /^(react(?:-native)?(?:\/|$)|expo(?:-|\/|$)|@react-native)/, `${file}: ${name}`);
      const local = localModule(file, name);
      if (local) pending.push(local);
    }
  }
});

test('screens render callbacks and state without importing storage or notification services', () => {
  const screens = sources(join(root, 'src/ui/screens'));
  assert.ok(screens.length > 1, 'per-state views must be extracted');
  for (const file of screens) {
    for (const name of runtimeImports(file)) {
      assert.doesNotMatch(name, /alarmStorage|notificationService|suppressionJournalStorage|storageReset|useAlarmController|useStepCandidate|\/platform\/|expo-(notifications|sensors)/, `${file}: ${name}`);
    }
  }
});
