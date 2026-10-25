/** Builders for synthetic iNES images used by the tests. */

export function makeInesImage({ prgBanks = 2, chrBanks = 1, flags6 = 0, flags7 = 0, prgFill = 0xff, chrFill = 0x00 } = {}) {
  const header = Buffer.alloc(16);
  header.write('NES\x1a', 0, 'binary');
  header[4] = prgBanks;
  header[5] = chrBanks;
  header[6] = flags6;
  header[7] = flags7;
  const trainer = (flags6 & 0x04) !== 0 ? Buffer.alloc(0x200, 0x00) : Buffer.alloc(0);
  const prg = Buffer.alloc(prgBanks * 0x4000, prgFill);
  const chr = Buffer.alloc(chrBanks * 0x2000, chrFill);
  return Buffer.concat([header, trainer, prg, chr]);
}

/** Write a byte at a PRG-ROM file offset inside a synthetic image. */
export function setPrgByte(buffer, offsetInImage, value) {
  buffer[0x10 + offsetInImage] = value;
  return buffer;
}
