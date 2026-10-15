/// <reference types="node" />

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export type AdvisoryException = {
  package: string;
  advisoryUrl: string;
  installedVersion: string;
  expires: string;
};

type Via = string | { name: string; url: string };

export type AuditReport = {
  vulnerabilities: Record<string, { name: string; severity: string; via: Via[] }>;
};

/** End of the given UTC calendar day in ms, or undefined unless it is a real YYYY-MM-DD date. */
export function endOfCalendarDay(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date.getTime();
}

function exceptionShapeProblem(exception: AdvisoryException): string | undefined {
  const ok =
    exception !== null &&
    typeof exception === 'object' &&
    typeof exception.package === 'string' &&
    /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(exception.package) &&
    typeof exception.advisoryUrl === 'string' &&
    /^https:\/\/github\.com\/advisories\/GHSA(-[a-z0-9]{4}){3}$/.test(exception.advisoryUrl) &&
    typeof exception.installedVersion === 'string' &&
    /^\d+\.\d+\.\d+$/.test(exception.installedVersion);
  return ok ? undefined : `invalid exception entry ${JSON.stringify(exception)}`;
}

/**
 * Returns problems for every npm-audit finding that is not an unexpired,
 * version-pinned exception or a pure propagation of one. Anything else, at any
 * severity, is reported.
 */
export function evaluateAudit(
  report: AuditReport,
  exceptions: AdvisoryException[],
  now: Date,
  installed?: Record<string, string | undefined>,
): string[] {
  const problems: string[] = [];
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return ['invalid current time; cannot evaluate exception expiry'];
  }
  const active = new Map<string, AdvisoryException>();
  for (const exception of exceptions) {
    const shapeProblem = exceptionShapeProblem(exception);
    if (shapeProblem) {
      problems.push(shapeProblem);
      continue;
    }
    const expiresAt = endOfCalendarDay(exception.expires);
    if (expiresAt === undefined) {
      problems.push(`exception for ${exception.package} has invalid expires ${JSON.stringify(exception.expires)}`);
      continue;
    }
    if (now.getTime() > expiresAt) {
      problems.push(`exception for ${exception.package} expired on ${exception.expires}`);
      continue;
    }
    const version = installed?.[exception.package];
    if (installed && version !== exception.installedVersion) {
      problems.push(
        `${exception.package} is ${version ?? 'missing'} but the exception assessed ${exception.installedVersion}`,
      );
      continue;
    }
    active.set(exception.package, exception);
  }

  // Start from "everything is propagation" and drop what has an advisory of its
  // own or depends on something dropped. Cycles (metro <-> metro-config) with no
  // advisory of their own stay covered; a cycle holding any other advisory does not.
  const covered = new Set<string>(Object.values(report.vulnerabilities).map((v) => v.name));
  const vulnerabilities = Object.values(report.vulnerabilities);
  let shrank = true;
  while (shrank) {
    shrank = false;
    for (const vulnerability of vulnerabilities) {
      if (!covered.has(vulnerability.name)) continue;
      const accepted = vulnerability.via.every((via) =>
        typeof via === 'string'
          ? covered.has(via)
          : active.get(via.name)?.advisoryUrl === via.url,
      );
      if (!accepted) {
        covered.delete(vulnerability.name);
        shrank = true;
      }
    }
  }

  for (const vulnerability of vulnerabilities) {
    if (covered.has(vulnerability.name)) continue;
    const reasons = vulnerability.via.map((via) =>
      typeof via === 'string' ? `via ${via}` : `${via.name} ${via.url}`,
    );
    problems.push(
      `${vulnerability.severity} finding not covered by an exception: ${vulnerability.name} (${reasons.join(', ')})`,
    );
  }
  return problems;
}

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const readJson = (root: string, path: string) => JSON.parse(read(root, path));

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file, accept, out);
    else if (accept(file)) out.push(file);
  }
  return out;
}

const ASSESSED_VERSIONS: Record<string, string> = {
  braces: '3.0.3',
  micromatch: '4.0.8',
  'node-forge': '1.4.0',
  '@expo/code-signing-certificates': '0.0.6',
};

// Every package-lock dependent of the affected packages, as assessed.
const ASSESSED_DEPENDENTS: Record<string, string[]> = {
  braces: ['node_modules/micromatch'],
  micromatch: [
    'node_modules/@expo/metro/node_modules/metro-file-map',
    'node_modules/metro-file-map',
  ],
  'node-forge': [
    'node_modules/@expo/code-signing-certificates',
    'node_modules/expo/node_modules/@expo/cli',
  ],
};

// The @expo/cli the code-dominance assessment was made against, pinned by version and by the
// content digest of the two files that import node-forge / call the verification paths.
export const ASSESSED_CLI_VERSION = '57.0.30';
export const ASSESSED_CLI_DIGESTS: Record<string, string> = {
  'build/src/utils/codesigning.js': '935fadac6f1dc56bc088acb04416d1fc83bd70505f368b87dd210d0aa4617de2',
  'build/src/run/ios/codeSigning/Security.js': 'af3f12dfb57ef87ae4cb3903af4398eeb034750c08d4fe523bc6a7d3062998b2',
};

function versionAt(dir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

/** Every directory under root/node_modules (at any nesting) that is an installed copy of `name`. */
export function installedCopyPaths(root: string, name: string): string[] {
  const found: string[] = [];
  const visit = (nodeModules: string) => {
    if (!existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules)) {
      const dir = join(nodeModules, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (entry.startsWith('@')) {
        for (const scoped of readdirSync(dir)) consider(join(dir, scoped), `${entry}/${scoped}`);
      } else {
        consider(dir, entry);
      }
    }
  };
  const consider = (dir: string, packageName: string) => {
    if (packageName === name) found.push(dir);
    if (statSync(dir).isDirectory()) visit(join(dir, 'node_modules'));
  };
  visit(join(root, 'node_modules'));
  return found;
}

/** Node's lookup: the nearest node_modules/<name> walking up from the importer directory. */
export function resolveInstalledFrom(root: string, importerDir: string, name: string): string | undefined {
  let dir = join(root, importerDir);
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root || dir === dirname(dir)) return undefined;
    dir = dirname(dir);
  }
}

/**
 * Every installed copy of an assessed package must be the assessed version: all nested copies,
 * every lockfile entry, and what node resolves from each known importer. Unreadable input fails.
 */
export function checkInstalledCopies(root: string): string[] {
  const problems: string[] = [];
  for (const [name, version] of Object.entries(ASSESSED_VERSIONS)) {
    const copies = installedCopyPaths(root, name);
    if (copies.length === 0) problems.push(`${name} has no installed copy, assessed ${version}`);
    for (const copy of copies) {
      const installed = versionAt(copy);
      if (installed !== version) problems.push(`${copy.slice(root.length + 1)} is ${installed ?? 'unreadable'}, assessed ${version}`);
    }
  }
  let lock: Record<string, { version?: string }> = {};
  try {
    lock = readJson(root, 'package-lock.json').packages ?? {};
  } catch (error) {
    problems.push(`could not read package-lock.json: ${(error as Error).message}`);
  }
  for (const [path, entry] of Object.entries(lock)) {
    const name = Object.keys(ASSESSED_VERSIONS).find((n) => path === `node_modules/${n}` || path.endsWith(`/node_modules/${n}`));
    if (name && entry.version !== ASSESSED_VERSIONS[name]) {
      problems.push(`lock ${path} is ${entry.version ?? 'unversioned'}, assessed ${ASSESSED_VERSIONS[name]}`);
    }
  }
  for (const [name, importers] of Object.entries(ASSESSED_DEPENDENTS)) {
    for (const importer of importers) {
      const resolved = resolveInstalledFrom(root, importer, name);
      const installed = resolved && versionAt(resolved);
      if (installed !== ASSESSED_VERSIONS[name]) {
        problems.push(`${importer} resolves ${name} to ${installed ?? 'nothing'}, assessed ${ASSESSED_VERSIONS[name]}`);
      }
    }
  }
  return problems;
}

/** Audit `nodes` paths (affected installed copies) must each be a copy that checkInstalledCopies covers. */
export function checkAuditNodes(root: string, report: AuditReport): string[] {
  const problems: string[] = [];
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    if (!(vulnerability.name in ASSESSED_VERSIONS)) continue;
    const nodes = (vulnerability as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes) || nodes.length === 0 || !nodes.every((n) => typeof n === 'string')) {
      problems.push(`audit entry ${vulnerability.name} has missing, empty or invalid nodes`);
      continue;
    }
    for (const node of nodes as string[]) {
      const installed = versionAt(join(root, node));
      if (installed !== ASSESSED_VERSIONS[vulnerability.name]) {
        problems.push(`audit node ${node} is ${installed ?? 'unreadable'}, assessed ${ASSESSED_VERSIONS[vulnerability.name]}`);
      }
    }
  }
  return problems;
}

/** The assessed @expo/cli: exact version and exact content of the files the dominance proof was made on. */
export function checkCliPin(root: string, cli: string = CLI): string[] {
  const problems: string[] = [];
  const version = versionAt(join(root, cli));
  if (version !== ASSESSED_CLI_VERSION) problems.push(`@expo/cli is ${version ?? 'unreadable'}, assessed ${ASSESSED_CLI_VERSION}`);
  for (const [file, digest] of Object.entries(ASSESSED_CLI_DIGESTS)) {
    let actual: string;
    try {
      actual = createHash('sha256').update(readFileSync(join(root, cli, file))).digest('hex');
    } catch {
      problems.push(`@expo/cli ${file} is unreadable`);
      continue;
    }
    if (actual !== digest) problems.push(`@expo/cli ${file} content changed (sha256 ${actual}), reassess guard dominance`);
  }
  return problems;
}

const METRO_FILE_MAP_COPIES = [
  'node_modules/@expo/metro/node_modules/metro-file-map',
  'node_modules/metro-file-map',
];
const CLI = 'node_modules/expo/node_modules/@expo/cli';

/**
 * Re-checks the facts the reachability assessment in docs/DEPENDENCY_SECURITY.md
 * relies on, against the installed sources. Any drift is a reason to reassess.
 */
export type ResolvedExpoConfig = {
  updates?: { codeSigningCertificate?: unknown };
  extra?: { eas?: { projectId?: unknown } };
};

/** Flags resolved public config values that turn on the @expo/cli code-signing / dev certificate paths. */
export function checkResolvedExpoConfig(config: ResolvedExpoConfig): string[] {
  const problems: string[] = [];
  if (config.updates?.codeSigningCertificate) {
    problems.push('resolved Expo config sets updates.codeSigningCertificate (code signing path)');
  }
  if (config.extra?.eas?.projectId) {
    problems.push('resolved Expo config sets extra.eas.projectId (dev certificate path)');
  }
  return problems;
}

/**
 * Resolves the public Expo config (app.json, app.config.ts, ...) with the installed expo CLI.
 * The repo's own config is trusted; the run is bounded by a timeout and a fixed argv.
 */
export function resolveExpoConfig(root: string): ResolvedExpoConfig {
  const output = execFileSync(join(root, 'node_modules/.bin/expo'), ['config', '--type', 'public', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output) as ResolvedExpoConfig;
}

export function checkCallPathAssumptions(
  root: string,
  resolveConfig: (root: string) => ResolvedExpoConfig = resolveExpoConfig,
): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);

  problems.push(...checkInstalledCopies(root), ...checkCliPin(root));

  const lock = readJson(root, 'package-lock.json').packages as Record<
    string,
    { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  >;
  for (const [name, expected] of Object.entries(ASSESSED_DEPENDENTS)) {
    const actual = Object.entries(lock)
      .filter(([, pkg]) => pkg.dependencies?.[name] || pkg.optionalDependencies?.[name])
      .map(([path]) => path || '(root)')
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      fail(`dependents of ${name} changed: ${actual.join(', ')}`);
    }
  }

  // braces is only reachable through micromatch.parse / micromatch.braces;
  // metro-file-map's only micromatch use is micromatch.some (picomatch).
  const micromatch = read(root, 'node_modules/micromatch/index.js').replace(/\/\*[\s\S]*?\*\//g, '');
  const bracesCalls = micromatch.match(/(?<![.\w])braces\(/g)?.length ?? 0;
  if (bracesCalls !== 2) fail(`micromatch calls braces() ${bracesCalls} times, assessed 2`);
  const some = micromatch.match(/^micromatch\.some = [\s\S]*?^};/m)?.[0] ?? '';
  if (!some) fail('micromatch.some not found');
  if (/braces|micromatch\.parse|expand/.test(some)) fail('micromatch.some now reaches braces');
  for (const copy of METRO_FILE_MAP_COPIES) {
    const files = walk(join(root, copy, 'src'), (file) => file.endsWith('.js'));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!/micromatch/.test(text)) continue;
      if (!file.endsWith(join('watchers', 'common.js'))) fail(`${file} uses micromatch`);
      const uses = [...text.matchAll(/_micromatch\.default\.(\w+)/g)].map((m) => m[1]);
      if (uses.length === 0 || uses.some((use) => use !== 'some')) {
        fail(`${file} uses micromatch other than .some: ${uses.join(',')}`);
      }
    }
  }

  // node-forge: only @expo/cli's code-signing paths import it.
  const cliFiles = walk(join(root, CLI, 'build', 'src'), (file) => file.endsWith('.js'));
  const forgeImporters = cliFiles.filter((file) => /require\("node-forge"\)/.test(readFileSync(file, 'utf8')));
  if (forgeImporters.length !== 1 || !forgeImporters[0].endsWith(join('codeSigning', 'Security.js'))) {
    fail(`@expo/cli node-forge importers changed: ${forgeImporters.join(', ')}`);
  } else if (/\.verify\(/.test(readFileSync(forgeImporters[0], 'utf8'))) {
    fail('@expo/cli Security.js now calls verify');
  }
  const verifyCallers = cliFiles.filter((file) =>
    /validateSelfSignedCertificate|signBufferRSASHA256AndVerify|generateDevelopmentCertificateFromCSR/.test(
      readFileSync(file, 'utf8'),
    ),
  );
  if (verifyCallers.length !== 1 || !verifyCallers[0].endsWith(join('utils', 'codesigning.js'))) {
    fail(`code-signing verify callers changed: ${verifyCallers.join(', ')}`);
  }
  const signing = read(root, 'node_modules/@expo/code-signing-certificates/build/main.js');
  const verifies = signing.match(/\.verify\(/g)?.length ?? 0;
  if (verifies !== 3) fail(`@expo/code-signing-certificates calls verify ${verifies} times, assessed 3`);

  // Repo inputs: nothing that turns the code-signing or custom-glob paths on.
  try {
    problems.push(...checkResolvedExpoConfig(resolveConfig(root)));
  } catch (error) {
    fail(`could not resolve the Expo config: ${(error as Error).message}`);
  }
  const pkg = readJson(root, 'package.json');
  for (const name of ['expo-updates', 'eas-cli']) {
    if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) fail(`${name} is now a dependency`);
  }
  for (const file of ['metro.config.js', 'metro.config.cjs', 'metro.config.mjs', '.watchmanconfig']) {
    if (existsSync(join(root, file))) fail(`${file} exists (custom Metro extensions/globs)`);
  }
  return problems;
}

const FORBIDDEN_IN_BUNDLE = /node_modules\/(braces|micromatch|node-forge|picomatch|@expo\/code-signing-certificates|metro-file-map)\//;

/** Fails if any exported sourcemap contains the affected packages. */
export function checkExportedBundles(distDir: string): string[] {
  const maps = walk(distDir, (file) => file.endsWith('.map'));
  if (maps.length === 0) return [`no sourcemaps under ${distDir}`];
  const problems: string[] = [];
  for (const map of maps) {
    const sources: string[] = JSON.parse(readFileSync(map, 'utf8')).sources ?? [];
    for (const source of sources.filter((s) => FORBIDDEN_IN_BUNDLE.test(s))) {
      problems.push(`${map} bundles ${source}`);
    }
  }
  return problems;
}
