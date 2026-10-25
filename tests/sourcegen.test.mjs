import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

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
