/**
 * NES Game Genie codec.
 *
 * The bit layout is ported from Mesen's `CheatManager::ConvertFromNesGameGenie`
 * (Core/Shared/CheatManager.cpp in the MesenGM submodule). Mesen is the
 * authority here: a code is useful only if the emulator that loads it decodes
 * the same address, value and compare byte.
 *
 * A 6-character code carries address + value. An 8-character code also carries
 * a compare byte: the replacement happens only when the CPU reads exactly that
 * value, which is what keeps a code in a switchable window from corrupting
 * other banks.
 */

export const GAME_GENIE_LETTERS = 'APZLGITYEOXUKSVN';

const ADDRESS_BITS = [14, 13, 12, 19, 22, 21, 20, 7, 10, 9, 8, 15, 18, 17, 16];
const VALUE_BITS = [3, 6, 5, 4, 23, 2, 1, 0];
// Bit 5 of the value moves to bit 31 in 8-character codes, which frees bit 23
// for the compare byte.
const VALUE_BITS_WITH_COMPARE = [3, 6, 5, 4, 31, 2, 1, 0];
const COMPARE_BITS = [27, 30, 29, 28, 23, 26, 25, 24];

export class CheatCodeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CheatCodeError';
    this.details = details;
  }
}

function decodeBits(raw, bitIndexes) {
  let result = 0;
  for (const bitIndex of bitIndexes) {
    result = (result << 1) | ((raw >> bitIndex) & 1);
  }
  return result >>> 0;
}

/** Decode a 6- or 8-character NES Game Genie code. */
export function decodeGameGenie(code) {
  if (typeof code !== 'string') {
    throw new CheatCodeError('code must be a string');
  }
  const normalized = code.trim().toUpperCase().replace(/\s+/g, '');
  if (!/^(?:[APZLGITYEOXUKSVN]{6}|[APZLGITYEOXUKSVN]{8})$/.test(normalized)) {
    throw new CheatCodeError('not a NES Game Genie code (6 or 8 letters from APZLGITYEOXUKSVN)', { code });
  }

  let raw = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    raw |= GAME_GENIE_LETTERS.indexOf(normalized[index]) << (index * 4);
  }

  const hasCompare = normalized.length === 8;
  const valueBits = hasCompare ? VALUE_BITS_WITH_COMPARE : VALUE_BITS;
  const address = decodeBits(raw, ADDRESS_BITS) + 0x8000;
  const value = decodeBits(raw, valueBits);
  const compare = hasCompare ? decodeBits(raw, COMPARE_BITS) : null;

  return { code: normalized, length: normalized.length, address, value, compare };
}

/** Encode an address, value and optional compare byte into a Game Genie code. */
export function encodeGameGenie({ address, value, compare = null }) {
  assertByteRange(address, 'address');
  assertByteRange(value, 'value');
  if (address < 0x8000 || address > 0xffff) {
    throw new CheatCodeError('address must be a CPU address between 0x8000 and 0xFFFF', { address });
  }
  if (value > 0xff) {
    throw new CheatCodeError('value must fit in one byte', { value });
  }
  if (compare !== null && (compare < 0 || compare > 0xff)) {
    throw new CheatCodeError('compare must fit in one byte', { compare });
  }

  const hasCompare = compare !== null;
  const valueBits = hasCompare ? VALUE_BITS_WITH_COMPARE : VALUE_BITS;
  let raw = 0;

  const addressValue = address - 0x8000;
  for (let bit = 0; bit < 15; bit += 1) {
    const set = (addressValue >> (14 - bit)) & 1;
    if (set) {
      raw |= 1 << ADDRESS_BITS[bit];
    }
  }
  for (let bit = 0; bit < 8; bit += 1) {
    if ((value >> (7 - bit)) & 1) {
      raw |= 1 << valueBits[bit];
    }
  }
  if (hasCompare) {
    for (let bit = 0; bit < 8; bit += 1) {
      if ((compare >> (7 - bit)) & 1) {
        raw |= 1 << COMPARE_BITS[bit];
      }
    }
  }

  const length = hasCompare ? 8 : 6;
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += GAME_GENIE_LETTERS[(raw >>> (index * 4)) & 0x0f];
  }

  return { code, address, value, compare };
}

function assertByteRange(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CheatCodeError(`${label} must be a non-negative integer`, { value });
  }
}

/**
 * Which banks hold a given compare value at the same in-bank offset.
 *
 * A code is evaluated wherever its CPU address is mapped, so a compare byte is safe only
 * when exactly one bank holds it: two banks holding the same byte means the replacement
 * also happens in the other one. Encoders that know the ROM can answer this before the
 * code is delivered; without it the code looks safe and is not.
 */
export function compareValueVerdict(rows, compare) {
  const matchingBanks = rows.filter((row) => row.byte === compare).map((row) => row.bank);
  return { compare, matchingBanks, unique: matchingBanks.length === 1 };
}

/**
 * Decision helper for compare-byte selection.
 *
 * `rows` comes from `dumpBankBytes`: the byte at the same in-bank offset in
 * every PRG bank. A compare byte is safe only when exactly the target bank
 * holds it; otherwise the code would also rewrite the same offset in another
 * bank.
 */
export function compareByteVerdict(rows, targetBank) {
  const target = rows.find((row) => row.bank === targetBank);
  if (!target) {
    throw new CheatCodeError('the target bank is not in the row set', { targetBank, banks: rows.map((row) => row.bank) });
  }
  const verdict = compareValueVerdict(rows, target.byte);
  return {
    targetBank,
    targetByte: target.byte,
    matchingBanks: verdict.matchingBanks,
    unique: verdict.unique,
    banks: rows,
  };
}
