import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { makeInesImage, setPrgByte } from './helpers/rom-fixture.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/cheat-code.mjs', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function withRom(build, run) {
  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-cheat-'));
  const path = join(dir, 'game.nes');
  writeFileSync(path, build());
  try {
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('check derives the fixed window from the CPU address', () => {
  // Three 16 KB banks; the last one is the fixed window at $C000. Asking about $C100 used to
  // be answered with "the CPU address is outside the selected bank window" because the default
  // window was $8000 and 0xC100 - 0x8000 does not fit in a bank.
  withRom(() => {
    const rom = makeInesImage({ prgBanks: 3, chrBanks: 0, prgFill: 0x00 });
    setPrgByte(rom, 0x8000 + 0x0100, 0x42);
    return rom;
  }, (path) => {
    const result = runCli(['check', '--rom', path, '--address', '0xC100', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.bankCpuStart, 0xc000);
    assert.equal(report.offsetInBank, 0x0100);
    assert.equal(report.targetBank, 2);
    assert.equal(report.targetByte, '0x42');
    assert.equal(report.unique, true);
  });
});

test('check still reads a named offset in a named bank', () => {
  withRom(() => {
    const rom = makeInesImage({ prgBanks: 3, chrBanks: 0, prgFill: 0x00 });
    setPrgByte(rom, 0x4000 + 0x0100, 0x42);
    return rom;
  }, (path) => {
    const result = runCli(['check', '--rom', path, '--offset', '0x100', '--bank', '1', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.bankCpuStart, 0x8000);
    assert.equal(report.offsetInBank, 0x0100);
    assert.equal(report.targetBank, 1);
    assert.equal(report.targetByte, '0x42');
  });
});

test('encode reports the compare byte across banks when it has the ROM', () => {
  // Banks 0 and 1 both hold $40 at the landing offset, so a code comparing against $40 would
  // fire in both of them; bank 2 holds $99 and is the only safe landing point.
  withRom(() => {
    const rom = makeInesImage({ prgBanks: 3, chrBanks: 0, prgFill: 0x00 });
    setPrgByte(rom, 0x0100, 0x40);
    setPrgByte(rom, 0x4000 + 0x0100, 0x40);
    setPrgByte(rom, 0x8000 + 0x0100, 0x99);
    return rom;
  }, (path) => {
    const encoded = runCli(['encode', '--address', '0x8100', '--value', '0x00', '--compare', '0x40', '--rom', path, '--bank', '2', '--json']);
    assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);
    const shared = JSON.parse(encoded.stdout);
    assert.equal(shared.code.length, 8);
    assert.equal(shared.uniqueness.unique, false);
    assert.deepEqual(shared.uniqueness.compareMatchesBanks, [0, 1]);
    assert.equal(shared.uniqueness.targetBank, 2);
    assert.equal(shared.uniqueness.targetBankHoldsCompare, false);
    assert.equal(shared.uniqueness.banks.length, 3);

    const safe = JSON.parse(runCli(['encode', '--address', '0x8100', '--value', '0x00', '--compare', '0x99', '--rom', path, '--bank', '2', '--json']).stdout);
    assert.equal(safe.uniqueness.unique, true);
    assert.deepEqual(safe.uniqueness.compareMatchesBanks, [2]);
    assert.equal(safe.uniqueness.targetBankHoldsCompare, true);
  });
});

test('encode without a ROM says the compare byte is unverified instead of staying silent', () => {
  const plain = runCli(['encode', '--address', '0x8100', '--value', '0x00', '--compare', '0x40', '--json']);
  assert.equal(plain.status, 0);
  assert.equal(JSON.parse(plain.stdout).uniqueness, null);

  const human = runCli(['encode', '--address', '0x8100', '--value', '0x00', '--compare', '0x40']);
  assert.match(human.stdout, /compare byte not verified/);

  // A 6-character code has no compare byte, so there is nothing to verify and nothing to warn
  // about: silence here is correct.
  const sixCharacters = runCli(['encode', '--address', '0x8100', '--value', '0x00']);
  assert.doesNotMatch(sixCharacters.stdout, /not verified/);
  assert.equal(JSON.parse(runCli(['encode', '--address', '0x8100', '--value', '0x00', '--json']).stdout).uniqueness, null);
});
