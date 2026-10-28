import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareByteVerdict, compareValueVerdict, decodeGameGenie, encodeGameGenie } from '../scripts/lib/cheat.mjs';
import { dumpBankBytes, parseRom } from '../scripts/lib/rom.mjs';
import { makeInesImage, setPrgByte } from './helpers/rom-fixture.mjs';

test('decodes a 6-character code into address and value', () => {
  const decoded = decodeGameGenie('SZUXPO');
  assert.equal(decoded.length, 6);
  assert.equal(decoded.compare, null);
  assert.ok(decoded.address >= 0x8000 && decoded.address <= 0xffff);
  assert.ok(decoded.value >= 0 && decoded.value <= 0xff);
});

test('decodes an 8-character code with a compare byte', () => {
  const decoded = decodeGameGenie('GZUXNGEI');
  assert.equal(decoded.length, 8);
  assert.ok(decoded.compare !== null);
  assert.ok(decoded.compare >= 0 && decoded.compare <= 0xff);
});

test('rejects malformed codes and letters outside the alphabet', () => {
  assert.throws(() => decodeGameGenie('ABC'), /Game Genie/);
  assert.throws(() => decodeGameGenie('QQQQQQ'), /Game Genie/);
  assert.throws(() => decodeGameGenie('APZLGIT'), /Game Genie/);
});

test('encode and decode are inverses for 6-character codes', () => {
  for (const address of [0x8000, 0x8123, 0xc000, 0xfff0, 0x9abc]) {
    for (const value of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
      const encoded = encodeGameGenie({ address, value });
      assert.equal(encoded.code.length, 6);
      const decoded = decodeGameGenie(encoded.code);
      assert.equal(decoded.address, address);
      assert.equal(decoded.value, value);
    }
  }
});

test('encode and decode are inverses for 8-character codes', () => {
  for (const address of [0x8000, 0xbf00, 0xd123, 0xffff]) {
    for (const value of [0x00, 0x55, 0xaa, 0xff]) {
      for (const compare of [0x00, 0x33, 0xcc, 0xff]) {
        const encoded = encodeGameGenie({ address, value, compare });
        assert.equal(encoded.code.length, 8);
        const decoded = decodeGameGenie(encoded.code);
        assert.equal(decoded.address, address);
        assert.equal(decoded.value, value);
        assert.equal(decoded.compare, compare);
      }
    }
  }
});

test('rejects addresses outside cartridge space', () => {
  assert.throws(() => encodeGameGenie({ address: 0x7fff, value: 1 }), /0x8000/);
  assert.throws(() => encodeGameGenie({ address: 0x10000, value: 1 }), /0xFFFF/);
  assert.throws(() => encodeGameGenie({ address: 0x8000, value: 0x100 }), /one byte/);
});

test('compare byte uniqueness is reported across banks', () => {
  const rom = makeInesImage({ prgBanks: 3 });
  setPrgByte(rom, 0x0200, 0x40);
  setPrgByte(rom, 0x0200 + 0x4000, 0x40);
  setPrgByte(rom, 0x0200 + 0x8000, 0x99);
  const header = parseRom(rom);
  const rows = dumpBankBytes(rom, header, { offsetInBank: 0x0200 });

  const shared = compareByteVerdict(rows, 0);
  assert.equal(shared.unique, false);
  assert.deepEqual(shared.matchingBanks, [0, 1]);

  const unique = compareByteVerdict(rows, 2);
  assert.equal(unique.unique, true);
  assert.deepEqual(unique.matchingBanks, [2]);
});

test('a compare value is judged by the banks that hold it, not by the target bank', () => {
  const rom = makeInesImage({ prgBanks: 3, prgFill: 0x00 });
  setPrgByte(rom, 0x0200, 0x40);
  setPrgByte(rom, 0x0200 + 0x4000, 0x40);
  setPrgByte(rom, 0x0200 + 0x8000, 0x99);
  const rows = dumpBankBytes(rom, parseRom(rom), { offsetInBank: 0x0200 });

  // The value a code compares against is what decides where it fires, so it is judged
  // directly; asking about the target bank's current byte only answers a different question.
  assert.deepEqual(compareValueVerdict(rows, 0x40), { compare: 0x40, matchingBanks: [0, 1], unique: false });
  assert.deepEqual(compareValueVerdict(rows, 0x99), { compare: 0x99, matchingBanks: [2], unique: true });
  assert.deepEqual(compareValueVerdict(rows, 0x01), { compare: 0x01, matchingBanks: [], unique: false });

  assert.throws(() => compareByteVerdict(rows, 7), /target bank/);
});
