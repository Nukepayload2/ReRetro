import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyEdits,
  applyIps,
  cpuToFileOffset,
  dumpBankBytes,
  fileOffsetToCpu,
  makeIps,
  parseRom,
  RomError,
  sha256,
} from '../scripts/lib/rom.mjs';
import { makeInesImage, setPrgByte } from './helpers/rom-fixture.mjs';

test('parses an iNES header and locates the PRG image', () => {
  const rom = makeInesImage({ prgBanks: 2, chrBanks: 1 });
  const header = parseRom(rom);
  assert.equal(header.format, 'ines');
  assert.equal(header.prgSize, 0x8000);
  assert.equal(header.chrSize, 0x2000);
  assert.equal(header.prgBanks16k, 2);
  assert.equal(header.mapper, 0);
  assert.equal(header.mirroring, 'horizontal');
  assert.equal(header.prgOffset, 0x10);
  assert.equal(header.chrOffset, 0x8010);
  assert.equal(header.imageEnd, 0xa010);
  assert.equal(header.trailingBytes, 0);
  assert.equal(header.sha256, sha256(rom));
});

test('rejects files that are not iNES images', () => {
  assert.throws(() => parseRom(Buffer.alloc(4)), RomError);
  assert.throws(() => parseRom(Buffer.alloc(32)), /NES/);
  const truncated = makeInesImage({ prgBanks: 2 }).subarray(0, 0x100);
  assert.throws(() => parseRom(truncated), /more data than the file contains/);
});

test('honours a trainer before the PRG image', () => {
  const rom = makeInesImage({ prgBanks: 1, chrBanks: 0, flags6: 0x04 });
  const header = parseRom(rom);
  assert.equal(header.hasTrainer, true);
  assert.equal(header.prgOffset, 0x210);
});

test('maps CPU addresses to file offsets for 16 KB banks', () => {
  const rom = makeInesImage({ prgBanks: 2 });
  const header = parseRom(rom);
  assert.equal(cpuToFileOffset(header, { cpuAddress: 0x8000, bankIndex: 0 }).offset, 0x10);
  assert.equal(cpuToFileOffset(header, { cpuAddress: 0xc000, bankIndex: 1, bankCpuStart: 0xc000 }).offset, 0x4010);
  assert.equal(cpuToFileOffset(header, { cpuAddress: 0x8123, bankIndex: 1 }).offset, 0x4133);
  assert.throws(() => cpuToFileOffset(header, { cpuAddress: 0x7fff, bankIndex: 0 }), RomError);
  assert.throws(() => cpuToFileOffset(header, { cpuAddress: 0x8000, bankIndex: 2 }), RomError);
});

test('maps CPU addresses for a flat 32 KB layout', () => {
  const header = parseRom(makeInesImage({ prgBanks: 2 }));
  const mapped = cpuToFileOffset(header, {
    cpuAddress: 0x8123,
    bankIndex: 0,
    bankSize: 0x8000,
    bankCpuStart: 0x8000,
  });
  assert.equal(mapped.offset, 0x133);
  assert.equal(fileOffsetToCpu(header, { offset: 0x133, bankSize: 0x8000 }).cpuAddress, 0x8123);
});

test('dumps the same in-bank offset across every PRG bank', () => {
  const rom = makeInesImage({ prgBanks: 3 });
  setPrgByte(rom, 0x0100, 0x11);
  setPrgByte(rom, 0x0100 + 0x4000, 0x22);
  setPrgByte(rom, 0x0100 + 0x8000, 0x11);
  const header = parseRom(rom);
  const rows = dumpBankBytes(rom, header, { offsetInBank: 0x0100 });
  assert.deepEqual(rows.map(row => row.byte), [0x11, 0x22, 0x11]);
  assert.deepEqual(rows.map(row => row.bank), [0, 1, 2]);
});

test('applyEdits verifies the original bytes before writing', () => {
  const rom = makeInesImage({ prgBanks: 1 });
  setPrgByte(rom, 0x0010, 0x4c);
  setPrgByte(rom, 0x0011, 0x00);
  setPrgByte(rom, 0x0012, 0xc0);

  const { buffer, applied } = applyEdits(rom, [{ offset: 0x20, expect: '4c00c0', write: 'ad00c0' }]);
  assert.equal(buffer.subarray(0x20, 0x23).toString('hex'), 'ad00c0');
  assert.equal(applied.length, 1);
  assert.equal(rom.subarray(0x20, 0x23).toString('hex'), '4c00c0', 'the source buffer must not change');

  assert.throws(
    () => applyEdits(rom, [{ offset: 0x20, expect: 'dead', write: 'beef' }]),
    (error) => error instanceof RomError && error.details.actual === '4c00',
  );
  assert.throws(
    () => applyEdits(rom, [{ offset: 0x20, expect: '4c', write: 'ad00' }]),
    /different lengths/,
  );
});

test('IPS patches round-trip through applyIps', () => {
  const original = makeInesImage({ prgBanks: 2 });
  const patched = Buffer.from(original);
  patched[0x20] = 0xea;
  patched[0x21] = 0xea;
  patched[0x9000] = 0x42;

  const ips = makeIps(original, patched);
  assert.equal(ips.records.length, 2);

  const restored = applyIps(original, ips.buffer);
  assert.ok(restored.buffer.equals(patched));
  assert.equal(restored.trailingBytes, 0);
});
