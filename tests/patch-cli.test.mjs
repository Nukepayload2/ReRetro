import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyIps, parseRom, sha256 } from '../scripts/lib/rom.mjs';
import { makeInesImage, setPrgByte } from './helpers/rom-fixture.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/patch-rom.mjs', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('patch-rom writes a verified patch, computes hashes and exports IPS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-patch-'));
  try {
    const rom = makeInesImage({ prgBanks: 2 });
    setPrgByte(rom, 0x0010, 0x4c);
    setPrgByte(rom, 0x0011, 0x00);
    setPrgByte(rom, 0x0012, 0xc0);
    const romPath = join(dir, 'game.nes');
    const outPath = join(dir, 'game.patched.nes');
    const ipsPath = join(dir, 'game.ips');
    writeFileSync(romPath, rom);
    const before = sha256(rom);

    const result = runCli([
      '--rom', romPath,
      '--out', outPath,
      '--edit', '0x20:4c00c0:ad00c0:redirect vector',
      '--ips', ipsPath,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.verified, true);
    assert.equal(report.originalUnchanged, true);
    assert.equal(report.sha256.before, before);
    assert.notEqual(report.sha256.after, before);
    assert.equal(report.edits[0].cpuAddress, 0x8010);
    assert.equal(report.ips.records.length, 1);

    const patched = readFileSync(outPath);
    assert.equal(patched.subarray(0x20, 0x23).toString('hex'), 'ad00c0');
    assert.equal(sha256(readFileSync(romPath)), before, 'the source ROM must stay untouched');
    assert.ok(existsSync(ipsPath));

    const restored = applyIps(rom, readFileSync(ipsPath));
    assert.ok(restored.buffer.equals(patched));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch-rom refuses a mismatch, an in-place output and an existing output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-patch-'));
  try {
    const rom = makeInesImage({ prgBanks: 1 });
    const romPath = join(dir, 'game.nes');
    writeFileSync(romPath, rom);

    const mismatch = runCli(['--rom', romPath, '--out', join(dir, 'a.nes'), '--edit', '0x20:00:ff', '--json']);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stdout, /do not match/);

    const inPlace = runCli(['--rom', romPath, '--out', romPath, '--edit', '0x20:ff:00', '--json']);
    assert.equal(inPlace.status, 1);
    assert.match(inPlace.stdout, /must differ/);

    const existing = join(dir, 'b.nes');
    writeFileSync(existing, 'x');
    const overwrite = runCli(['--rom', romPath, '--out', existing, '--edit', '0x20:ff:00', '--json']);
    assert.equal(overwrite.status, 1);
    assert.match(overwrite.stdout, /already exists/);

    const forced = runCli(['--rom', romPath, '--out', existing, '--edit', '0x20:ff:00', '--force', '--json']);
    assert.equal(forced.status, 0, forced.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rom info prints the header facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-info-'));
  try {
    const rom = makeInesImage({ prgBanks: 4, chrBanks: 2, flags6: 0x01 });
    const romPath = join(dir, 'game.nes');
    writeFileSync(romPath, rom);
    const result = runCli(['--rom', romPath, '--info', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const info = JSON.parse(result.stdout);
    assert.equal(info.header.prgSize, 0x10000);
    assert.equal(info.header.chrSize, 0x4000);
    assert.equal(info.header.mirroring, 'vertical');
    assert.equal(parseRom(rom).sha256, info.header.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
