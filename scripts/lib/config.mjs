import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this module's location. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const paths = {
  root: REPO_ROOT,
  thirdParty: join(REPO_ROOT, 'third_party'),
  mesen: join(REPO_ROOT, 'third_party', 'MesenGM'),
  bench: join(REPO_ROOT, 'third_party', '6502bench'),
  pins: join(REPO_ROOT, 'third_party', 'pins.json'),
  out: join(REPO_ROOT, 'out'),
  docs: join(REPO_ROOT, 'docs'),
  scripts: join(REPO_ROOT, 'scripts'),
  skill: join(REPO_ROOT, '.agents', 'skills', 'nes-rom-reversing'),
  mcpConfig: join(REPO_ROOT, 'out', 'mcp.json'),
  envFile: join(REPO_ROOT, 'out', 'environment.json'),
};

export const TOOL_NAMES = {
  mesen: 'MesenGM',
  bench: '6502bench',
};

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
export const MIN_NODE = { major: 22, minor: 19 };

/** Read the committed submodule pins. */
export function readPins() {
  if (!existsSync(paths.pins)) {
    throw new Error(`missing submodule pins: ${paths.pins}`);
  }
  return JSON.parse(readFileSync(paths.pins, 'utf8'));
}

/** Repository-relative path for reports, so output never leaks a machine path. */
export function relativePath(absolutePath) {
  const normalized = absolutePath.replace(/\\/g, '/');
  const root = REPO_ROOT.replace(/\\/g, '/');
  return normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : normalized;
}

/** Node version check used by setup and verify. */
export function checkNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return {
    version,
    ok,
    required: `>=${MIN_NODE.major}.${MIN_NODE.minor}`,
  };
}
