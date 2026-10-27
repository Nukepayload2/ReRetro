import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { makeInesImage, setPrgByte } from './helpers/rom-fixture.mjs';

const DRIVER = fileURLToPath(new URL('../tools/SourceGenCli/bin/Release/SourceGenCli.exe', import.meta.url));
const WRAPPER = fileURLToPath(new URL('../scripts/sourcegen.mjs', import.meta.url));

// A 12-byte program with one absolute store to $0324 and one zero-page store, so the
// operand scan has something exact to find and something it must ignore.
const PROGRAM = [
  0xa9, 0x00,       // LDA #$00
  0x85, 0x20,       // STA $20
  0x8d, 0x24, 0x03, // STA $0324
  0xa5, 0x24,       // LDA $24
  0x60,             // RTS
];

function withSlice(run) {
  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-sgt-'));
  const path = join(dir, 'slice.bin');
  writeFileSync(path, Buffer.from(PROGRAM));
  try {
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function driver(args) {
  const result = spawnSync(DRIVER, args, { encoding: 'utf8', timeout: 120_000 });
  const line = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  return { status: result.status, stderr: result.stderr, payload: JSON.parse(line) };
}

test('the driver reports a mapped slice and its CRC', { skip: existsSync(DRIVER) ? false : 'SourceGen driver not built' }, () => {
  withSlice((path) => {
    const { status, payload } = driver(['info', '--data', path, '--base', '0x8000']);
    assert.equal(status, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.length, PROGRAM.length);
    assert.equal(payload.baseAddress, '$8000');
    assert.match(payload.crc32, /^[0-9A-F]{8}$/);
  });
});

test('the driver finds the instruction that writes a RAM address', { skip: existsSync(DRIVER) ? false : 'SourceGen driver not built' }, () => {
  withSlice((path) => {
    const { status, payload } = driver(['xref', '--data', path, '--base', '0x8000', '--address', '0x0324', '--writes-only']);
    assert.equal(status, 0);
    assert.equal(payload.references.length, 1, JSON.stringify(payload));
    const [reference] = payload.references;
    assert.equal(reference.byAddress, '$8004');
    assert.equal(reference.op, 'sta');
    assert.equal(reference.bytes, '8D 24 03');
    assert.equal(reference.mode, 'Abs');
    assert.equal(reference.effect, 'Write');
    assert.equal(reference.writes, true);
    assert.equal(reference.indirect, false);
    // Reached from the seeded entry point, so the analysis itself vouches for it.
    assert.equal(reference.tier, 'code');
    assert.equal(reference.region, 'code');
  });

  withSlice((path) => {
    // A read of $0324 is not a write, and the zero-page store to $20 must not match.
    const reads = driver(['xref', '--data', path, '--base', '0x8000', '--address', '0x0324']).payload;
    assert.equal(reads.references.length, 1);
    const zeroPage = driver(['xref', '--data', path, '--base', '0x8000', '--address', '0x0020']).payload;
    assert.equal(zeroPage.references.length, 1);
    assert.equal(zeroPage.references[0].mode, 'DP');
  });
});

test('the driver lists instructions with their bytes', { skip: existsSync(DRIVER) ? false : 'SourceGen driver not built' }, () => {
  withSlice((path) => {
    const { payload } = driver(['line', '--data', path, '--base', '0x8000', '--address', '0x8004', '--count', '3']);
    assert.equal(payload.lines.length, 3);
    assert.equal(payload.lines[0].address, '$8004');
    assert.equal(payload.lines[0].bytes, '8D 24 03');
    assert.equal(payload.lines[1].address, '$8007');
    assert.equal(payload.lines[1].op, 'lda');
    assert.equal(payload.lines[2].op, 'rts');
  });
});

test('the wrapper analyses a raw slice and answers xref in JSON', { skip: existsSync(DRIVER) ? false : 'SourceGen driver not built' }, () => {
  withSlice((path) => {
    const result = spawnSync(process.execPath, [WRAPPER, 'xref', '--data', path, '--base', '0x8000', '--address', '0x0324', '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, 'xref');
    assert.equal(report.references.length, 1);
    assert.equal(report.references[0].byAddress, 0x8004);
    assert.equal(report.references[0].op, 'sta');
  });
});

test('--prg-bank narrows a whole-bank command to that bank', { skip: existsSync(DRIVER) ? false : 'SourceGen driver not built' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-sgb-'));
  const path = join(dir, 'two-banks.nes');
  // Two PRG banks: the last one is the fixed window at $C000, the first the switchable
  // window at $8000, so the two banks must not report the same base.
  writeFileSync(path, setPrgByte(makeInesImage({ prgBanks: 2, chrBanks: 0 }), 0, 0xea));

  try {
    const all = runJson([WRAPPER, 'stats', '--rom', path, '--json']);
    assert.equal(all.outcomes.length, 2, JSON.stringify(all));

    const last = runJson([WRAPPER, 'stats', '--rom', path, '--prg-bank', '1', '--json']);
    assert.equal(last.outcomes.length, 1, JSON.stringify(last));
    assert.equal(last.outcomes[0].bank.index, 1);
    assert.equal(last.outcomes[0].bank.base, 0xc000);

    const first = runJson([WRAPPER, 'stats', '--rom', path, '--prg-bank', '0', '--json']);
    assert.equal(first.outcomes.length, 1);
    assert.equal(first.outcomes[0].bank.base, 0x8000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runJson(argv) {
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('an unreached store is still reported, at the raw tier', { skip: existsSync(DRIVER) ? false : 'SourceGen driver not built' }, () => {
  // BRK at the slice start stops the seeded analysis immediately, so the store past the
  // filler is unreached. Reporting nothing here is what made the driver answer "nobody
  // writes this address" for addresses that plain code writes.
  const split = [
    0x00,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x8d, 0x24, 0x03, // STA $0324 at $800B
    0x60,
  ];

  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-sge-'));
  const path = join(dir, 'slice.bin');
  writeFileSync(path, Buffer.from(split));

  try {
    const scanned = runJson([WRAPPER, 'xref', '--data', path, '--base', '0x8000', '--address', '0x0324', '--writes-only', '--json']);
    assert.equal(scanned.references.length, 1, JSON.stringify(scanned));
    assert.equal(scanned.references[0].byAddress, 0x800b);
    assert.equal(scanned.references[0].op, 'sta');
    assert.equal(scanned.references[0].bytes, '8D 24 03');
    assert.equal(scanned.references[0].tier, 'raw');
    assert.equal(scanned.references[0].region, 'unvisited');
    assert.equal(scanned.scan.reported, 1);
    assert.equal(scanned.scan.raw, 1);

    // --code-only is the old behaviour, kept so a caller can ask for analysis-verified hits.
    const classifiedOnly = runJson([WRAPPER, 'xref', '--data', path, '--base', '0x8000', '--address', '0x0324', '--writes-only', '--code-only', '--json']);
    assert.equal(classifiedOnly.references.length, 0, JSON.stringify(classifiedOnly));

    // Seeding the entry point upgrades the same byte to the code tier.
    const seeded = runJson([WRAPPER, 'xref', '--data', path, '--base', '0x8000', '--address', '0x0324', '--writes-only', '--entry', '0x800B', '--json']);
    assert.equal(seeded.references.length, 1, JSON.stringify(seeded));
    assert.equal(seeded.references[0].tier, 'code');
    assert.equal(seeded.references[0].region, 'code');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every store and read-modify-write mode is reported, indexed ones included', { skip: existsSync(DRIVER) ? false : 'SourceGen driver not built' }, () => {
  // Four different writes to the same address in unreached bytes: the store family that the
  // operand scan used to miss entirely (STY absolute, indexed STA, RMW).
  const slice = [
    0x00,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x8c, 0x24, 0x03, // STY $0324
    0x9d, 0x24, 0x03, // STA $0324,X
    0x99, 0x24, 0x03, // STA $0324,Y
    0xee, 0x24, 0x03, // INC $0324
    0x60,
  ];

  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-sgf-'));
  const path = join(dir, 'slice.bin');
  writeFileSync(path, Buffer.from(slice));

  try {
    const report = runJson([WRAPPER, 'xref', '--data', path, '--base', '0x8000', '--address', '0x0324', '--writes-only', '--json']);
    assert.deepEqual(report.references.map(reference => reference.mode), ['Abs', 'AbsIndexX', 'AbsIndexY', 'Abs']);
    assert.deepEqual(report.references.map(reference => reference.op), ['sty', 'sta', 'sta', 'inc']);
    assert.deepEqual(report.references.map(reference => reference.indexed), [false, true, true, false]);
    assert.deepEqual(report.references.map(reference => reference.byAddress), [0x800a, 0x800d, 0x8010, 0x8013]);
    for (const reference of report.references) {
      assert.equal(reference.writes, true);
      assert.equal(reference.tier, 'raw');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a store pattern inside a classified instruction is not reported', { skip: existsSync(DRIVER) ? false : 'SourceGen driver not built' }, () => {
  // JMP $248D occupies $8000-$8002 and stops the analysis. Its operand bytes $8D $24 plus
  // the next byte decode as `STA $0324`, but that offset is owned by a real instruction, so
  // reporting it would be a false positive rather than an unreached store.
  const slice = [0x4c, 0x8d, 0x24, 0x03];

  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-sgg-'));
  const path = join(dir, 'slice.bin');
  writeFileSync(path, Buffer.from(slice));

  try {
    const report = runJson([WRAPPER, 'xref', '--data', path, '--base', '0x8000', '--address', '0x0324', '--json']);
    assert.equal(report.references.length, 0, JSON.stringify(report.references));

    // Naming the middle of the instruction as an entry point is a user error the scan must
    // not paper over: the byte is code now, so the hit is reported at the code tier.
    const forced = runJson([WRAPPER, 'xref', '--data', path, '--base', '0x8000', '--address', '0x0324', '--entry', '0x8001', '--json']);
    assert.equal(forced.references.length, 1, JSON.stringify(forced.references));
    assert.equal(forced.references[0].tier, 'code');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
