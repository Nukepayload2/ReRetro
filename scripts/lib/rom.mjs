import { createHash } from 'node:crypto';

/** Length of the iNES header that precedes PRG ROM data. */
export const INES_HEADER_SIZE = 0x10;
/** Size of one PRG ROM bank in the 16 KB bank view used by most mappers. */
export const PRG_BANK_16K = 0x4000;
/** Size of one CHR ROM bank. */
export const CHR_BANK_8K = 0x2000;

export class RomError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RomError';
    this.details = details;
  }
}

/**
 * Parse the iNES / NES 2.0 header of a ROM image.
 *
 * The header is read only; the ROM buffer is never modified. Fields that the
 * tooling does not interpret are still reported so that a plan can be checked
 * against the actual file instead of an assumption.
 */
export function parseRom(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new RomError('expected a Buffer');
  }
  if (buf.length < INES_HEADER_SIZE) {
    throw new RomError('ROM is shorter than the 16-byte iNES header', { size: buf.length });
  }
  if (buf[0] !== 0x4e || buf[1] !== 0x45 || buf[2] !== 0x53 || buf[3] !== 0x1a) {
    throw new RomError('missing "NES\\x1A" magic; this is not an iNES image');
  }

  const flags6 = buf[6];
  const flags7 = buf[7];
  const nes2 = (flags7 & 0x0c) === 0x08;
  const trainerSize = (flags6 & 0x04) !== 0 ? 0x200 : 0;

  let prgSize;
  let chrSize;
  let mapper;
  let subMapper = 0;

  if (nes2) {
    const prgLsb = buf[4];
    const prgMsb = buf[9] & 0x0f;
    const chrLsb = buf[5];
    const chrMsb = (buf[9] >> 4) & 0x0f;

    if (prgMsb === 0x0f) {
      // Exponent-multiplier form: 2^E * (2*M + 1) * 16 KiB.
      const exponent = prgLsb >> 2;
      const multiplier = (prgLsb & 0x03) * 2 + 1;
      prgSize = 2 ** exponent * multiplier * PRG_BANK_16K;
    } else {
      prgSize = ((prgMsb << 8) | prgLsb) * PRG_BANK_16K;
    }

    if (chrMsb === 0x0f) {
      const exponent = chrLsb >> 2;
      const multiplier = (chrLsb & 0x03) * 2 + 1;
      chrSize = 2 ** exponent * multiplier * CHR_BANK_8K;
    } else {
      chrSize = ((chrMsb << 8) | chrLsb) * CHR_BANK_8K;
    }

    mapper = (flags6 >> 4) | (flags7 & 0xf0) | ((buf[8] & 0x0f) << 8);
    subMapper = (buf[8] >> 4) & 0x0f;
  } else {
    prgSize = buf[4] * PRG_BANK_16K;
    chrSize = buf[5] * CHR_BANK_8K;
    mapper = (flags6 >> 4) | (flags7 & 0xf0);
  }

  const prgOffset = INES_HEADER_SIZE + trainerSize;
  const chrOffset = prgOffset + prgSize;
  const imageEnd = chrOffset + chrSize;

  if (prgSize === 0) {
    throw new RomError('header declares no PRG ROM', { prgSize });
  }
  if (imageEnd > buf.length) {
    throw new RomError('header declares more data than the file contains', {
      declaredBytes: imageEnd,
      actualBytes: buf.length,
    });
  }

  return {
    format: nes2 ? 'nes2.0' : 'ines',
    prgSize,
    chrSize,
    prgBanks16k: prgSize / PRG_BANK_16K,
    chrBanks8k: chrSize / CHR_BANK_8K,
    mapper,
    subMapper,
    mirroring: (flags6 & 0x08) !== 0 ? 'four-screen' : (flags6 & 0x01) !== 0 ? 'vertical' : 'horizontal',
    hasBattery: (flags6 & 0x02) !== 0,
    hasTrainer: trainerSize !== 0,
    consoleType: (flags7 & 0x03) === 3 ? 'vs-system' : (flags7 & 0x03) === 1 ? 'playchoice-10' : 'nes',
    prgOffset,
    chrOffset,
    imageEnd,
    trailingBytes: buf.length - imageEnd,
    fileSize: buf.length,
    sha256: sha256(buf),
  };
}

/** Hex SHA-256 of a buffer. */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Convert a CPU address to a file offset inside the PRG ROM image.
 *
 * `bankCpuStart` is where the mapped bank appears in the CPU address space
 * ($8000 or $C000 for the two 16 KB windows; $8000 for a flat 32 KB layout).
 */
export function cpuToFileOffset(rom, { cpuAddress, bankIndex = 0, bankCpuStart = 0x8000, bankSize = PRG_BANK_16K }) {
  assertInteger(cpuAddress, 'cpuAddress');
  assertInteger(bankIndex, 'bankIndex');
  assertInteger(bankCpuStart, 'bankCpuStart');
  assertInteger(bankSize, 'bankSize');

  if (cpuAddress < bankCpuStart || cpuAddress >= bankCpuStart + bankSize) {
    throw new RomError('CPU address is outside the mapped window', { cpuAddress, bankCpuStart, bankSize });
  }
  if (bankIndex < 0 || bankIndex * bankSize + bankSize > rom.prgSize) {
    throw new RomError('bank index is outside the PRG ROM image', {
      bankIndex,
      bankSize,
      prgSize: rom.prgSize,
      prgBanks: rom.prgSize / bankSize,
    });
  }

  const offset = rom.prgOffset + bankIndex * bankSize + (cpuAddress - bankCpuStart);
  return { offset, prgOffsetInImage: offset - rom.prgOffset };
}

/** Inverse of {@link cpuToFileOffset} for a known bank mapping. */
export function fileOffsetToCpu(rom, { offset, bankIndex = 0, bankCpuStart = 0x8000, bankSize = PRG_BANK_16K }) {
  assertInteger(offset, 'offset');
  const bankStart = rom.prgOffset + bankIndex * bankSize;
  if (offset < bankStart || offset >= bankStart + bankSize) {
    throw new RomError('file offset is outside the selected PRG bank', { offset, bankIndex, bankStart });
  }
  return { cpuAddress: bankCpuStart + (offset - bankStart), bankIndex };
}

/**
 * Byte at `offsetInBank` inside every PRG bank.
 *
 * This is the bank-uniqueness evidence a Game Genie compare value needs: a code
 * that targets a switchable window replaces the same offset in every bank.
 */
export function dumpBankBytes(buf, rom, { offsetInBank, bankSize = PRG_BANK_16K }) {
  assertInteger(offsetInBank, 'offsetInBank');
  if (offsetInBank < 0 || offsetInBank >= bankSize) {
    throw new RomError('offset in bank is outside the bank size', { offsetInBank, bankSize });
  }
  const bankCount = rom.prgSize / bankSize;
  const rows = [];
  for (let bank = 0; bank < bankCount; bank += 1) {
    const offset = rom.prgOffset + bank * bankSize + offsetInBank;
    rows.push({ bank, offset, byte: buf[offset] });
  }
  return rows;
}

/**
 * Apply deterministic byte edits to a copy of the ROM.
 *
 * Every edit asserts the bytes it expects before writing, so a wrong ROM,
 * wrong bank or stale offset fails loudly instead of silently producing a
 * different patch.
 */
export function applyEdits(buf, edits) {
  const output = Buffer.from(buf);
  const applied = [];

  for (const edit of edits) {
    const { offset, expect, write, note } = edit;
    assertInteger(offset, 'edit offset');
    const expected = toBytes(expect, 'expect');
    const written = toBytes(write, 'write');

    if (expected.length !== written.length) {
      throw new RomError('the expected bytes and the replacement bytes have different lengths', {
        offset,
        expectLength: expected.length,
        writeLength: written.length,
      });
    }
    if (offset < 0 || offset + expected.length > output.length) {
      throw new RomError('edit is outside the ROM file', { offset, length: expected.length, fileSize: output.length });
    }

    const actual = output.subarray(offset, offset + expected.length);
    if (!actual.equals(expected)) {
      throw new RomError('the bytes at the target offset do not match the expected original', {
        offset,
        expected: expected.toString('hex'),
        actual: actual.toString('hex'),
      });
    }

    written.copy(output, offset);
    applied.push({ offset, expect: expected.toString('hex'), write: written.toString('hex'), note: note ?? '' });
  }

  return { buffer: output, applied };
}

/** Parse a byte string such as "4c", "4c 00 ea" or "0x4c". */
export function toBytes(value, label = 'value') {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value !== 'string') {
    throw new RomError(`${label} must be a hex string or a byte array`);
  }
  const cleaned = value.replace(/0x/gi, '').replace(/[\s,]/g, '');
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) {
    throw new RomError(`${label} is not a valid hex byte string`, { value });
  }
  return Buffer.from(cleaned, 'hex');
}

/** True when every byte of `expected` equals the ROM bytes at `offset`. */
export function bytesMatch(buf, offset, expected) {
  const bytes = toBytes(expected, 'expected');
  if (offset < 0 || offset + bytes.length > buf.length) {
    return false;
  }
  return buf.subarray(offset, offset + bytes.length).equals(bytes);
}

/**
 * Build an IPS patch from the differing regions of two ROM images.
 *
 * Plain records only; contiguous runs longer than 0x8000 bytes are split so a
 * record never needs the RLE form. Offset 0x454F46 ("EOF") is skipped because
 * classic IPS readers treat it as the end marker.
 */
export function makeIps(original, patched) {
  if (original.length !== patched.length) {
    throw new RomError('IPS patches in this tool require images of the same length', {
      originalBytes: original.length,
      patchedBytes: patched.length,
    });
  }

  const chunks = [];
  let cursor = 0;
  while (cursor < patched.length) {
    if (original[cursor] === patched[cursor]) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < patched.length && original[cursor] !== patched[cursor]) {
      cursor += 1;
    }
    chunks.push({ start, data: Buffer.from(patched.subarray(start, cursor)) });
  }

  const records = [];
  for (const chunk of chunks) {
    for (let position = 0; position < chunk.data.length; position += 0x8000) {
      const start = chunk.start + position;
      if (start === 0x454f46) {
        throw new RomError('an IPS record would start at the "EOF" marker offset', { offset: start });
      }
      const data = chunk.data.subarray(position, Math.min(position + 0x8000, chunk.data.length));
      records.push({ start, data });
    }
  }

  const total = records.reduce((size, record) => size + 5 + record.data.length, 0) + 3;
  const out = Buffer.alloc(total);
  let position = 0;
  for (const record of records) {
    out[position] = (record.start >> 16) & 0xff;
    out[position + 1] = (record.start >> 8) & 0xff;
    out[position + 2] = record.start & 0xff;
    out[position + 3] = (record.data.length >> 8) & 0xff;
    out[position + 4] = record.data.length & 0xff;
    record.data.copy(out, position + 5);
    position += 5 + record.data.length;
  }
  out.write('EOF', position, 'ascii');
  return { buffer: out, records: records.map((r) => ({ offset: r.start, length: r.data.length })) };
}

/** Apply an IPS patch to a buffer and return a new buffer. */
export function applyIps(original, ips) {
  const out = Buffer.from(original);
  let position = 0;
  let records = 0;

  while (position + 3 <= ips.length) {
    if (ips[position] === 0x45 && ips[position + 1] === 0x4f && ips[position + 2] === 0x46) {
      return { buffer: out, records, trailingBytes: ips.length - position - 3 };
    }
    const offset = (ips[position] << 16) | (ips[position + 1] << 8) | ips[position + 2];
    const length = (ips[position + 3] << 8) | ips[position + 4];
    position += 5;
    if (length === 0) {
      const count = (ips[position] << 8) | ips[position + 1];
      position += 2;
      out.fill(ips[position], offset, offset + count);
      position += 1;
    } else {
      ips.copy(out, offset, position, position + length);
      position += length;
    }
    records += 1;
  }

  return { buffer: out, records, trailingBytes: 0 };
}

/** Parse an integer written as decimal or 0x-prefixed hex. */
export function parseInteger(value, label) {
  if (typeof value === 'number') {
    assertInteger(value, label);
    return value;
  }
  if (typeof value !== 'string') {
    throw new RomError(`${label} must be a number or a numeric string`);
  }
  const trimmed = value.trim();
  const parsed = /^0x/i.test(trimmed) ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RomError(`${label} is not a non-negative integer`, { value });
  }
  return parsed;
}

export function assertInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RomError(`${label} must be a non-negative integer`, { value });
  }
}

/** Format an integer as a $XXXX / 0xXXXX style address for reports. */
export function hex(value, width = 4) {
  return '0x' + value.toString(16).toUpperCase().padStart(width, '0');
}
