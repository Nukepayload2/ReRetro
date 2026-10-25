#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heading, parseArgs, rows, status } from './lib/cli.mjs';
import { paths, readPins, relativePath } from './lib/config.mjs';
import { git } from './lib/process.mjs';

/**
 * Compare (and optionally rewrite) `third_party/pins.json` against the commits
 * that are actually checked out.
 *
 * Use it after moving a submodule checkout forward, for example when an upstream
 * tool ships a new bridge surface:
 *
 *   git -C third_party/MesenGM checkout <new-commit>
 *   node scripts/update-pins.mjs --write
 *   node scripts/verify.mjs
 */

const args = parseArgs(process.argv.slice(2));
const write = args.flag('write');
const json = args.flag('json');

const pins = readPins();
const rowsOut = [];
let changed = false;

for (const pin of pins.submodules) {
  const dir = join(paths.root, pin.path);
  const present = existsSync(dir);
  const head = present ? git(['-C', pin.path, 'rev-parse', 'HEAD'], { cwd: paths.root }) : null;
  const actual = head?.ok ? head.stdout.trim() : null;
  const matches = actual === pin.commit;
  if (!matches && actual) {
    changed = true;
  }
  rowsOut.push({
    path: pin.path,
    pinned: pin.commit,
    actual,
    present,
    matches,
  });
}

if (write && changed) {
  const next = {
    ...pins,
    submodules: pins.submodules.map((pin) => {
      const row = rowsOut.find(candidate => candidate.path === pin.path);
      return row?.actual ? { ...pin, commit: row.actual } : pin;
    }),
  };
  writeFileSync(paths.pins, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

if (json) {
  console.log(JSON.stringify({ ok: rowsOut.every(row => row.matches), wrote: write && changed, rows: rowsOut }, null, 2));
} else {
  heading('Submodule pins');
  for (const row of rowsOut) {
    status(row.present ? (row.matches ? 'ok' : 'warn') : 'fail', row.path,
      `pinned ${row.pinned.slice(0, 12)} / checkout ${row.actual ? row.actual.slice(0, 12) : 'missing'}`);
  }
  if (changed) {
    status(write ? 'ok' : 'warn', write ? 'pins.json updated' : 'pins.json is behind the checkouts',
      write ? relativePath(paths.pins) : 'rerun with --write to record the new commits');
  }
  status('info', 'stage the gitlinks', `git add ${rowsOut.filter(row => !row.matches).map(row => row.path).join(' ') || 'third_party'}`);
  status('info', 'after changing a pin', 'rebuild the tool, then run node scripts/verify.mjs');
}

process.exit(rowsOut.every(row => row.matches) || (write && changed) ? 0 : 1);
