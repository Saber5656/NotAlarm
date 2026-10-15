import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = process.cwd();

function sources(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(root, directory, entry.name);
      return entry.isDirectory()
        ? sources(join(directory, entry.name))
        : /\.tsx?$/.test(path)
          ? [path]
          : [];
    },
  );
}

/** Runtime (non type-only) relative imports of one file, as absolute files. */
function localRuntimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  for (const node of source.statements) {
    const isImport = ts.isImportDeclaration(node);
    const isExport = ts.isExportDeclaration(node) && !!node.moduleSpecifier;
    if (!isImport && !isExport) continue;
    const specifier = node.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
    if (isImport) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      if (!clause?.name && bindings && ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly)) continue;
    } else if (node.isTypeOnly) {
      continue;
    }
    const base = resolve(dirname(file), specifier.text);
    const target = [base + '.ts', base + '.tsx', join(base, 'index.ts')].find(existsSync);
    if (target) result.push(target);
  }
  return result;
}

test('the app shell, controller, core, platform and screens have no circular runtime imports', () => {
  const files = [
    join(root, 'App.tsx'),
    ...sources('src/app'),
    ...sources('src/ui/screens'),
  ];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  function visit(file: string): void {
    if (state.get(file) === 'done') return;
    if (state.get(file) === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(file)), file].map((f) => relative(root, f));
      assert.fail(`circular runtime import: ${cycle.join(' -> ')}`);
    }
    state.set(file, 'visiting');
    stack.push(file);
    for (const next of localRuntimeImports(file)) visit(next);
    stack.pop();
    state.set(file, 'done');
  }

  for (const file of files) visit(file);
});

test('only the platform layer and the composition hooks reach services; core and screens never import app hooks', () => {
  for (const file of sources('src/app/core')) {
    for (const target of localRuntimeImports(file)) {
      const rel = relative(root, target);
      assert.doesNotMatch(rel, /^src\/app\/(platform|use[A-Z])|^src\/ui\//, `${relative(root, file)} -> ${rel}`);
    }
  }
  for (const file of sources('src/ui/screens')) {
    for (const target of localRuntimeImports(file)) {
      const rel = relative(root, target);
      assert.doesNotMatch(rel, /^src\/app\/(platform|use[A-Z])/, `${relative(root, file)} -> ${rel}`);
    }
  }
  // Gateways never import a coordinator or a hook (the coordinators import them).
  for (const target of localRuntimeImports(join(root, 'src/app/platform/gateways.ts'))) {
    assert.doesNotMatch(relative(root, target), /^src\/app\/(core|use[A-Z])|coordinators/, relative(root, target));
  }
});

test('the root App only composes the provider and AlarmApp', () => {
  const app = readFileSync(join(root, 'App.tsx'), 'utf8');
  const targets = [...app.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(targets.sort(), ['./src/app/AlarmApp', 'react-native-safe-area-context']);
  assert.doesNotMatch(app, /\buse[A-Z]\w*\(/);
});
