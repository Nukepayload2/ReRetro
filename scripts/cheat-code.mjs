#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { heading, parseArgs, rows, status } from './lib/cli.mjs';
import { compareByteVerdict, compareValueVerdict, decodeGameGenie, encodeGameGenie } from './lib/cheat.mjs';
import { relativePath } from './lib/config.mjs';
import { dumpBankBytes, hex, parseInteger, parseRom, RomError } from './lib/rom.mjs';

const args = parseArgs(process.argv.slice(2));
const json = args.flag('json');
const command = args.positional[0];

main();

function main() {
  try {
    switch (command) {
      case 'decode':
        emit(decode());
        break;
      case 'encode':
        emit(encode());
        break;
      case 'check':
        emit(check());
        break;
      default:
        usage();
        process.exit(1);
    }
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: error.message, details: error.details ?? null }, null, 2));
    } else {
      status('fail', `cheat-code ${command ?? ''} failed`, error.message);
    }
    process.exit(1);
  }
}

function decode() {
  const code = args.positional[1] ?? args.get('code');
  if (!code) {
    throw new Error('decode needs a code, for example: cheat-code decode SXIOPO');
  }
  return decodeGameGenie(code);
}

function encode() {
  const address = parseInteger(required('address'), 'address');
  const value = parseInteger(required('value'), 'value');
  const compare = args.get('compare') === undefined ? null : parseInteger(args.get('compare'), 'compare');
  if (address < 0x8000) {
    throw new Error('address is a CPU address; NES cartridge space starts at 0x8000');
  }
  const encoded = encodeGameGenie({ address, value, compare });
  // A 6-character code has no compare byte, so no bank can disagree with it; an 8-character
  // code is only as safe as the uniqueness of that byte, which the caller cannot see without
  // the ROM.
  return { ...encoded, uniqueness: compare === null ? null : uniquenessFor(address, compare) };
}

function uniquenessFor(address, compare) {
  if (args.get('rom') === undefined) {
    return null;
  }
  const { file, buffer, header } = loadRom();
  const window = resolveWindow(header, { address });
  const bankRows = dumpBankBytes(buffer, header, { offsetInBank: window.offsetInBank, bankSize: window.bankSize });
  const verdict = compareValueVerdict(bankRows, compare);
  const targetByte = bankRows.find(row => row.bank === window.targetBank)?.byte ?? null;
  return {
    rom: relativePath(file),
    bankSize: window.bankSize,
    bankCpuStart: window.bankCpuStart,
    offsetInBank: window.offsetInBank,
    targetBank: window.targetBank,
    targetBankByte: targetByte === null ? null : hex(targetByte, 2),
    targetBankHoldsCompare: targetByte === compare,
    compareMatchesBanks: verdict.matchingBanks,
    unique: verdict.unique,
    banks: bankRows.map(row => ({ bank: row.bank, fileOffset: hex(row.offset, 6), byte: hex(row.byte, 2) })),
  };
}

function check() {
  const { file, buffer, header } = loadRom();
  const window = resolveWindow(header, {
    address: args.get('address') === undefined ? undefined : parseInteger(args.get('address'), 'address'),
    offsetInBank: args.get('offset') === undefined ? undefined : parseInteger(args.get('offset'), 'offset'),
  });

  const bankRows = dumpBankBytes(buffer, header, { offsetInBank: window.offsetInBank, bankSize: window.bankSize });
  const verdict = compareByteVerdict(bankRows, window.targetBank);

  return {
    rom: relativePath(file),
    mapper: header.mapper,
    prgSize: header.prgSize,
    bankSize: window.bankSize,
    bankCpuStart: window.bankCpuStart,
    offsetInBank: window.offsetInBank,
    targetBank: verdict.targetBank,
    targetByte: hex(verdict.targetByte, 2),
    unique: verdict.unique,
    matchingBanks: verdict.matchingBanks,
    banks: verdict.banks.map(row => ({ bank: row.bank, fileOffset: hex(row.offset, 6), byte: hex(row.byte, 2) })),
  };
}

function loadRom() {
  const romPath = args.get('rom');
  if (!romPath) {
    throw new Error('--rom <file> is required');
  }
  const file = resolve(romPath);
  if (!existsSync(file)) {
    throw new RomError('the ROM file does not exist', { path: romPath });
  }
  const buffer = readFileSync(file);
  return { file, buffer, header: parseRom(buffer) };
}

/**
 * Which bank window a CPU address falls in, and which bank it names.
 *
 * The fixed window at the top of the address space can only hold the last bank, so an
 * address of $C000 or above no longer has to be spelled out with `--bank-cpu-start` and
 * `--bank`. Getting that wrong made the bank check read the wrong bank's byte while still
 * reporting a confident verdict.
 */
function resolveWindow(header, { address, offsetInBank }) {
  if (address !== undefined && offsetInBank !== undefined) {
    throw new Error('give --address or --offset, not both');
  }
  const bankSize = parseInteger(args.get('bank-size', '0x4000'), 'bank-size');
  const bankCount = header.prgSize / bankSize;
  if (!Number.isInteger(bankCount) || bankCount < 1) {
    throw new RomError('--bank-size does not divide the PRG ROM into whole banks', { bankSize, prgSize: header.prgSize });
  }

  const fixedStart = 0x10000 - bankSize;
  const explicitStart = args.get('bank-cpu-start') === undefined
    ? null
    : parseInteger(args.get('bank-cpu-start'), 'bank-cpu-start');
  let bankCpuStart;
  let offset;
  if (address !== undefined) {
    bankCpuStart = explicitStart ?? (address >= fixedStart ? fixedStart : 0x8000);
    offset = address - bankCpuStart;
    if (offset < 0 || offset >= bankSize) {
      throw new RomError('the CPU address is outside the selected bank window', { address, bankCpuStart, bankSize });
    }
  } else if (offsetInBank !== undefined) {
    bankCpuStart = explicitStart ?? 0x8000;
    offset = offsetInBank;
    if (offset < 0 || offset >= bankSize) {
      throw new RomError('offset in bank is outside the bank size', { offsetInBank, bankSize });
    }
  } else {
    throw new Error('needs --address <cpu-address> or --offset <offset-in-bank>');
  }

  const explicitBank = args.get('bank');
  const targetBank = explicitBank !== undefined
    ? Number.parseInt(explicitBank, 10)
    : (address !== undefined && bankCpuStart === fixedStart ? bankCount - 1 : 0);
  if (!Number.isInteger(targetBank) || targetBank < 0 || targetBank >= bankCount) {
    throw new RomError('the target bank does not exist in this ROM', { bank: targetBank, banks: bankCount });
  }

  return { bankSize, bankCpuStart, offsetInBank: offset, targetBank, bankCount };
}

function required(name) {
  const value = args.get(name);
  if (value === undefined) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function emit(result) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'decode') {
    heading('Decoded code');
    rows([
      ['code', result.code],
      ['length', `${result.length} characters`],
      ['CPU address', hex(result.address)],
      ['value', hex(result.value, 2)],
      ['compare', result.compare === null ? 'none (always replaces)' : hex(result.compare, 2)],
    ]);
    return;
  }

  if (command === 'encode') {
    heading('Encoded code');
    rows([
      ['code', result.code],
      ['CPU address', hex(result.address)],
      ['value', hex(result.value, 2)],
      ['compare', result.compare === null ? 'none' : hex(result.compare, 2)],
    ]);
    if (result.uniqueness === null) {
      if (result.compare !== null) {
        status('warn', 'compare byte not verified', 'pass --rom <file> so the compare byte can be checked across every PRG bank');
      }
    } else {
      const verdict = result.uniqueness;
      rows([
        ['ROM', verdict.rom],
        ['bank window', `${hex(verdict.bankSize, 4)} at ${hex(verdict.bankCpuStart, 4)}`],
        ['offset in bank', hex(verdict.offsetInBank, 4)],
        ['target bank', `${verdict.targetBank} (byte ${verdict.targetBankByte})`],
        ['banks holding the compare byte', verdict.compareMatchesBanks.join(', ') || 'none'],
      ]);
      status(verdict.unique ? 'ok' : 'warn',
        verdict.unique ? 'compare byte is unique to one bank' : 'the compare byte also appears in another bank',
        verdict.unique ? 'safe as an 8-character code' : `it would also fire in bank(s) ${verdict.compareMatchesBanks.filter(bank => bank !== verdict.targetBank).join(', ')}; move the landing point`);
      if (!verdict.targetBankHoldsCompare) {
        status('warn', 'target bank does not hold the compare byte', 'the code will not fire there until that byte equals the compare value');
      }
      for (const row of verdict.banks) {
        console.log(`  bank ${String(row.bank).padStart(2)}  ${row.fileOffset}  ${row.byte}`);
      }
    }
    status('info', 'round trip', `decode ${result.code} to confirm the code before delivery`);
    return;
  }

  heading('Bank uniqueness');
  rows([
    ['ROM', result.rom],
    ['mapper', String(result.mapper)],
    ['bank window', `${hex(result.bankSize, 4)} at ${hex(result.bankCpuStart, 4)}`],
    ['offset in bank', hex(result.offsetInBank, 4)],
    ['target bank', `${result.targetBank} (byte ${result.targetByte})`],
    ['banks holding the same byte', result.matchingBanks.join(', ')],
  ]);
  status(result.unique ? 'ok' : 'warn', result.unique ? 'compare value is unique' : 'another bank holds the same byte', result.unique ? 'safe to use as a 8-character compare value' : 'choose another landing point or deliver a ROM patch');
  console.log('');
  for (const row of result.banks) {
    console.log(`  bank ${String(row.bank).padStart(2)}  ${row.fileOffset}  ${row.byte}`);
  }
}

function usage() {
  console.log(`usage:
  node scripts/cheat-code.mjs decode <CODE> [--json]
  node scripts/cheat-code.mjs encode --address 0xNNNN --value 0xNN [--compare 0xNN] [--rom <file>] [--bank N] [--json]
  node scripts/cheat-code.mjs check --rom <file> (--offset 0xNN | --address 0xNNNN) [--bank N] [--bank-size 0x4000] [--bank-cpu-start 0x8000] [--json]
`);
}
