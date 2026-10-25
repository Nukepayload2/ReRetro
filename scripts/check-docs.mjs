#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heading, parseArgs, status } from './lib/cli.mjs';
import { paths, readPins, REPO_ROOT } from './lib/config.mjs';
import { git } from './lib/process.mjs';

const args = parseArgs(process.argv.slice(2));
const json = args.flag('json');

const SKIP_DIRS = new Set(['.git', 'third_party', 'out', 'node_modules', 'tmp', 'roms']);
// Local task briefs live beside the kit but are not part of it.
const SKIP_FILES = new Set(['goal.txt']);
const TEXT_EXTENSIONS = new Set([
  '.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt', '.ps1', '.cmd',
]);

// The forbidden words are assembled from fragments so that this scanner does
// not trip over its own rule table.
const WORKSPACE_NAME = 'Material' + 'Box';
const PORTAL_FILE = 'portal' + '.local';

const FORBIDDEN = [
  { name: 'portal placeholder', pattern: /\{\{/, hint: 'resolve the path inside this repository instead of an external key' },
  { name: 'workspace reference', pattern: new RegExp(WORKSPACE_NAME, 'i'), hint: 'the kit must not depend on an external workspace' },
  { name: 'portal file reference', pattern: new RegExp(PORTAL_FILE.replace('.', '\\.'), 'i'), hint: 'there is no machine-local portal file in this kit' },
  { name: 'user-profile path', pattern: /[A-Za-z]:[\\/]{1,2}Users[\\/]/i, hint: 'use a repository-relative path or a portable placeholder' },
  { name: 'home-directory path', pattern: /\/home\/[a-z0-9_.-]+\//i, hint: 'use a repository-relative path' },
  { name: 'project-root absolute path', pattern: /[A-Za-z]:[\\/]{1,2}Projects[\\/]/i, hint: 'use a repository-relative path' },
];

function main() {
  const violations = [];
  const files = listTextFiles(REPO_ROOT);

  for (const file of files) {
    const display = relative(REPO_ROOT, file).replace(/\\/g, '/');
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    violations.push(...scanText(text, display));
    if (display.endsWith('.md')) {
      violations.push(...checkLinks(file, display, text));
    }
  }

  const submoduleIssues = checkSubmodules();
  violations.push(...submoduleIssues);

  if (json) {
    console.log(JSON.stringify({ ok: violations.length === 0, files: files.length, violations }, null, 2));
  } else {
    heading('Repository self-check');
    status('info', 'scanned files', String(files.length));
    if (violations.length === 0) {
      status('ok', 'no violations');
    } else {
      for (const violation of violations) {
        status('fail', `${violation.file}:${violation.line ?? '-'}`, `${violation.rule ?? 'submodule'} — ${violation.text ?? violation.hint ?? ''}`);
      }
    }
  }

  process.exit(violations.length === 0 ? 0 : 1);
}

/** Scan one file's text for forbidden references. Exported for tests. */
export function scanText(text, display) {
  const violations = [];
  const lines = text.split(/\r?\n/);
  for (const rule of FORBIDDEN) {
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        violations.push({ file: display, line: index + 1, rule: rule.name, hint: rule.hint, text: line.trim().slice(0, 160) });
      }
    });
  }
  return violations;
}

function listTextFiles(dir, collected = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      listTextFiles(join(dir, entry.name), collected);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (SKIP_FILES.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    const extension = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')) : '';
    if (TEXT_EXTENSIONS.has(extension) || entry.name === '.gitmodules' || entry.name === '.gitignore' || entry.name === '.gitattributes' || entry.name === '.editorconfig') {
      collected.push(full);
    }
  }
  return collected;
}

const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkLinks(file, display, text) {
  const issues = [];
  const baseDir = resolve(file, '..');
  for (const match of text.matchAll(LINK_PATTERN)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/i.test(target)) {
      continue;
    }
    const cleaned = target.split('#')[0];
    if (!cleaned) {
      continue;
    }
    const resolved = resolve(baseDir, cleaned);
    if (!existsSync(resolved)) {
      issues.push({ file: display, rule: 'broken link', hint: cleaned, text: target });
    }
  }
  return issues;
}

function checkSubmodules() {
  const issues = [];
  const pins = readPins();
  const gitmodulesPath = join(REPO_ROOT, '.gitmodules');
  const isRepo = existsSync(join(REPO_ROOT, '.git'));

  // A directory that has no git metadata yet is a source drop, not a broken
  // checkout: the submodules are added by the one-time repository bootstrap
  // documented in docs/installation.md.
  if (!existsSync(gitmodulesPath)) {
    if (!isRepo) {
      return issues;
    }
    issues.push({ file: '.gitmodules', rule: 'submodule', hint: 'a git checkout must declare its submodules' });
    return issues;
  }

  const declared = parseGitmodules(readFileSync(gitmodulesPath, 'utf8'));

  for (const pin of pins.submodules) {
    const entry = declared.find(candidate => candidate.path === pin.path);
    if (!entry) {
      issues.push({ file: '.gitmodules', rule: 'submodule', hint: `${pin.path} is missing from .gitmodules` });
      continue;
    }
    if (entry.url !== pin.url) {
      issues.push({ file: '.gitmodules', rule: 'submodule', hint: `${pin.path} url ${entry.url} != pins.json ${pin.url}` });
    }
    if (!existsSync(join(REPO_ROOT, pin.path))) {
      issues.push({ file: pin.path, rule: 'submodule', hint: 'checkout is missing; run git submodule update --init --recursive' });
    }
  }

  const gitlinks = git(['ls-files', '-s', 'third_party'], { cwd: REPO_ROOT });
  if (gitlinks.ok) {
    const recorded = gitlinks.stdout
      .split(/\r?\n/)
      .filter(line => line.startsWith('160000'))
      .map((line) => {
        const [meta, path] = line.split('\t');
        return { path, commit: meta.split(/\s+/)[1] };
      });
    for (const entry of recorded) {
      const pin = pins.submodules.find(candidate => candidate.path === entry.path.replace(/\\/g, '/'));
      if (!pin) {
        issues.push({ file: entry.path, rule: 'submodule', hint: 'gitlink is recorded but pins.json has no entry' });
      } else if (pin.commit !== entry.commit) {
        issues.push({ file: entry.path, rule: 'submodule', hint: `gitlink ${entry.commit} != pins.json ${pin.commit}` });
      }
    }
    for (const pin of pins.submodules) {
      if (!recorded.some(entry => entry.path.replace(/\\/g, '/') === pin.path)) {
        issues.push({ file: pin.path, rule: 'submodule', hint: 'pins.json lists this submodule but git has no gitlink for it' });
      }
    }
  }

  return issues;
}

function parseGitmodules(text) {
  const entries = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const section = line.match(/^\[submodule\s+"([^"]+)"\]$/);
    if (section) {
      current = { name: section[1], path: null, url: null };
      entries.push(current);
      continue;
    }
    const pair = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (pair && current) {
      current[pair[1]] = pair[2].trim();
    }
  }
  return entries;
}

export { checkLinks, listTextFiles };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}