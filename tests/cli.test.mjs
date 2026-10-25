import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeInesImage, setPrgByte } from './helpers/rom-fixture.mjs';

const CLI = fileURLToPath(new URL('../scripts/rea-fc.mjs', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('the dispatcher accepts a positional ROM for info', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rea-fc-cli-'));
  try {
    const rom = makeInesImage({ prgBanks: 2, chrBanks: 1 });
    setPrgByte(rom, 0x0000, 0x4c);
    const romPath = join(dir, 'game.nes');
    writeFileSync(romPath, rom);

    const result = runCli(['info', romPath, '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const info = JSON.parse(result.stdout);
    assert.equal(info.header.prgSize, 0x8000);
    assert.equal(info.header.format, 'ines');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dispatcher exposes cheat encode and decode as one command', () => {
  const encoded = runCli(['cheat', 'encode', '--address', '0xC0A0', '--value', '0x0A', '--json']);
  assert.equal(encoded.status, 0, encoded.stderr || encoded.stdout);
  const code = JSON.parse(encoded.stdout).code;

  const decoded = runCli(['cheat', 'decode', code, '--json']);
  assert.equal(decoded.status, 0, decoded.stderr);
  const result = JSON.parse(decoded.stdout);
  assert.equal(result.address, 0xc0a0);
  assert.equal(result.value, 0x0a);
  assert.equal(result.compare, null);
});

test('the dispatcher reports an unknown command with a non-zero status', () => {
  const result = runCli(['nope']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /unknown command/);
});
