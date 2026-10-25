#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { heading, parseArgs, rows, status } from './lib/cli.mjs';
import { compareByteVerdict, decodeGameGenie, encodeGameGenie } from './lib/cheat.mjs';
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
  return encodeGameGenie({ address, value, compare });
}

function check() {
  const romPath = args.get('rom');
  if (!romPath) {
    throw new Error('check needs --rom <file>');
  }
  const file = resolve(romPath);
  if (!existsSync(file)) {
    throw new RomError('the ROM file does not exist', { path: romPath });
  }

  const buffer = readFileSync(file);
  const header = parseRom(buffer);
  const bankSize = parseInteger(args.get('bank-size', '0x4000'), 'bank-size');
  const bankCpuStart = parseInteger(args.get('bank-cpu-start', '0x8000'), 'bank-cpu-start');

  let offsetInBank;
  if (args.get('offset') !== undefined) {
    offsetInBank = parseInteger(args.get('offset'), 'offset');
  } else if (args.get('address') !== undefined) {
    const address = parseInteger(args.get('address'), 'address');
    offsetInBank = address - bankCpuStart;
    if (offsetInBank < 0 || offsetInBank >= bankSize) {
      throw new RomError('the CPU address is outside the selected bank window', {
        address,
        bankCpuStart,
        bankSize,
      });
    }
  } else {
    throw new Error('check needs --offset <offset-in-bank> or --address <cpu-address>');
  }

  const rowsOut = dumpBankBytes(buffer, header, { offsetInBank, bankSize });
  const targetBank = Number.parseInt(args.get('bank', '0'), 10);
  if (!rowsOut.some(row => row.bank === targetBank)) {
    throw new RomError('the target bank does not exist in this ROM', {
      bank: targetBank,
      banks: rowsOut.length,
    });
  }
  const verdict = compareByteVerdict(rowsOut, targetBank);

  return {
    rom: relativePath(file),
    mapper: header.mapper,
    prgSize: header.prgSize,
    bankSize,
    bankCpuStart,
    offsetInBank,
    targetBank,
    targetByte: hex(verdict.targetByte, 2),
    unique: verdict.unique,
    matchingBanks: verdict.matchingBanks,
    banks: verdict.banks.map(row => ({ bank: row.bank, fileOffset: hex(row.offset, 6), byte: hex(row.byte, 2) })),
  };
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
  node scripts/cheat-code.mjs encode --address 0xNNNN --value 0xNN [--compare 0xNN] [--json]
  node scripts/cheat-code.mjs check --rom <file> (--offset 0xNN | --address 0xNNNN) [--bank N] [--bank-size 0x4000] [--bank-cpu-start 0x8000] [--json]
`);
}
