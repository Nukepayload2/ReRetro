#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { heading, parseArgs, rows, status } from './lib/cli.mjs';
import { displayPath, paths, relativePath } from './lib/config.mjs';
import { parseRom, PRG_BANK_16K, hex } from './lib/rom.mjs';

/**
 * Headless 6502bench driver front end.
 *
 * SourceGen's own executable only opens an existing .dis65 project in a WPF window, so
 * this command slices a PRG bank out of an iNES image, hands it to `SourceGenCli` (the
 * console driver built from the pinned 6502bench analysis), and translates the answers
 * back into CPU addresses and file offsets of the original ROM.
 *
 * Commands:
 *   stats  --rom <rom> --prg-bank N [--base 0x8000]
 *   build  --rom <rom> --prg-bank N [--save-project <dis65>]
 *   xref   --rom <rom> --address 0x0324 [--all-banks] [--writes-only]
 *   line   --rom <rom> --prg-bank N --address 0xC000 [--count 32]
 *
 * `--data <file> --base <addr>` drives the same commands on a raw slice.
 */

/** Temporary slice directories, removed on exit. Declared before any top-level use. */
const workDirs = [];

const args = parseArgs(process.argv.slice(2));
const command = args.positional[0] ?? 'stats';
const json = args.flag('json');
const romPath = args.get('rom');
const dataPath = args.get('data');
const writesOnly = args.flag('writes-only');
const allBanks = args.flag('all-banks');
const count = Number.parseInt(args.get('count', '32'), 10);

const driver = locateDriver();
if (!driver) {
  fail('the SourceGen driver is missing; build it with node scripts/setup.mjs (or --build-driver)');
}

const source = loadSource();
const result = run();

if (json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
print(result);
process.exit(result.ok ? 0 : 1);

// ---------------------------------------------------------------- commands

function run() {
  switch (command) {
    case 'stats': return forEachBank(bank => driverCall('stats', bank));
    case 'build': return forEachBank(bank => driverCall('build', bank));
    case 'line': return forEachBank(bank => driverCall('line', bank, { address: requiredAddress() }), { only: bankFromArgs() });
    case 'xref': return xref();
    default: fail(`unknown command: ${command}`);
  }
}

function xref() {
  const address = requiredAddress();
  const banks = allBanks ? source.banks() : [bankFromArgs()];
  const references = [];
  const errors = [];
  for (const bank of banks) {
    const outcome = driverCall('xref', bank, { address, writesOnly });
    if (!outcome.ok) {
      errors.push({ bank: bank.index, error: outcome.error });
      continue;
    }
    for (const reference of outcome.references) {
      references.push({
        ...reference,
        bank: bank.index,
        byAddress: driverNumber(reference.byAddress),
        byOffset: driverNumber(reference.byOffset),
        romOffset: source.romOffset(bank, driverNumber(reference.byOffset)),
      });
    }
  }
  return { ok: errors.length === 0 || references.length > 0, command: 'xref', address: hex(address, 4), writesOnly, banks: banks.length, references, errors };
}

function forEachBank(run_, { only } = {}) {
  const banks = only ? [only] : source.banks();
  const outcomes = banks.map(bank => ({ ...run_(bank), bank }));
  return {
    ok: outcomes.every(outcome => outcome.ok),
    command,
    rom: source.description(),
    outcomes,
  };
}

// ---------------------------------------------------------------- driver

function driverCall(name, bank, extra = {}) {
  const slice = source.slicePath(bank);
  const base = `0x${bank.base.toString(16)}`;
  const argv = [name, '--data', slice, '--base', base];
  if (name === 'xref') {
    argv.push('--address', `0x${extra.address.toString(16)}`);
    if (extra.writesOnly) {
      argv.push('--writes-only');
    }
  }
  if (name === 'line') {
    argv.push('--address', `0x${extra.address.toString(16)}`, '--count', String(count));
  }
  if (name === 'build' && args.get('save-project')) {
    const project = args.get('save-project');
    const target = args.flag('per-bank') ? project.replace(/\.dis65$/i, '') + `-bank${bank.index}.dis65` : project;
    argv.push('--save-project', resolve(target));
  }

  const result = spawnSync(driver, argv, { encoding: 'utf8', timeout: 300_000 });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  const line = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  let payload = null;
  try {
    payload = JSON.parse(line);
  } catch {
    return { ok: false, error: (result.stderr || result.stdout || 'no output').trim().slice(-400) };
  }
  if (!payload.ok) {
    return { ok: false, error: payload.error ?? 'driver reported failure', payload };
  }
  return { ...payload, ok: true, bankIndex: bank.index };
}

/** Driver output spells addresses as $1234; callers want numbers. */
function driverNumber(value) {
  if (typeof value === 'number') {
    return value;
  }
  return Number.parseInt(String(value).replace(/[$]/g, ''), 16);
}

function startWorkDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

function locateDriver() {
  const candidates = [
    join(paths.out, 'SourceGenCli', 'SourceGenCli.exe'),
    join(paths.root, 'tools', 'SourceGenCli', 'bin', 'Release', 'SourceGenCli.exe'),
    process.env.REA_FC_DRIVER ?? '',
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

// ---------------------------------------------------------------- source

function loadSource() {
  if (romPath) {
    const buffer = readFileSync(resolve(romPath));
    const rom = parseRom(buffer);
    const workDir = startWorkDir('rea-fc-bank-');
    const slices = new Map();
    return {
      description: () => ({ path: relativePath(resolve(romPath)), sha256: rom.sha256, mapper: rom.mapper, prgBanks: rom.prgBanks16k, prgOffset: rom.prgOffset }),
      banks: () => Array.from({ length: rom.prgBanks16k }, (_, index) => bankOf(index, rom.prgBanks16k)),
      slicePath: (bank) => {
        if (!slices.has(bank.index)) {
          const start = rom.prgOffset + bank.index * PRG_BANK_16K;
          const path = join(workDir, `bank${String(bank.index).padStart(2, '0')}.bin`);
          writeFileSync(path, buffer.subarray(start, start + PRG_BANK_16K));
          slices.set(bank.index, path);
        }
        return slices.get(bank.index);
      },
      romOffset: (bank, bankRelativeOffset) => rom.prgOffset + bank.index * PRG_BANK_16K + bankRelativeOffset,
    };
  }
  if (dataPath) {
    const base = Number.parseInt(String(args.get('base', '0x8000')), 0);
    const buffer = readFileSync(resolve(dataPath));
    const workDir = startWorkDir('rea-fc-slice-');
    const path = join(workDir, 'slice.bin');
    writeFileSync(path, buffer);
    const single = bankOf(0, 1, base);
    return {
      description: () => ({ path: relativePath(resolve(dataPath)), length: buffer.length, base: hex(base, 4) }),
      banks: () => [single],
      slicePath: () => path,
      romOffset: (bank, bankRelativeOffset) => bankRelativeOffset,
    };
  }
  fail('give --rom <rom> or --data <file>');
  return null;
}

/**
 * CPU window of a PRG bank.
 *
 * A 16 KB bank occupies either the switchable window at $8000 or, for the last bank of
 * a mapper that fixes one, $C000. `--base` overrides the guess for exotic mappers.
 */
function bankOf(index, total, baseOverride) {
  const base = baseOverride ?? (index === total - 1 ? 0xc000 : 0x8000);
  return { index, base, switchable: base === 0x8000 };
}

/**
 * Which bank `--address` lives in, when only one is in play.
 *
 * Outside `--all-banks` the caller names the bank with `--prg-bank`; the address alone
 * cannot say which switchable bank is mapped.
 */
function bankFromArgs() {
  const explicit = args.get('prg-bank');
  const total = source.banks().length;
  if (explicit === undefined) {
    if (total === 1) {
      return source.banks()[0];
    }
    fail('need --prg-bank <n> for a multi-bank ROM, or --all-banks to scan every bank');
  }
  const index = Number.parseInt(String(explicit), 10);
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    fail(`--prg-bank must be 0..${total - 1}`);
  }
  const base = args.get('base') !== undefined ? Number.parseInt(String(args.get('base')), 0) : undefined;
  return bankOf(index, total, base);
}

function requiredAddress() {
  const raw = args.get('address');
  if (raw === undefined) {
    fail('--address is required');
  }
  const value = Number.parseInt(String(raw), 0);
  if (!Number.isInteger(value)) {
    fail(`--address is not a number: ${raw}`);
  }
  return value;
}

// ---------------------------------------------------------------- output

function fail(message) {
  console.error(`sourcegen: ${message}`);
  process.exit(1);
}

function print(report) {
  heading('SourceGen');
  if (!report.ok) {
    status('fail', report.command, report.errors?.map(error => error.error).join('; ') ?? 'failed');
    process.exit(1);
  }
  for (const outcome of report.outcomes ?? []) {
    const bank = outcome.bank;
    status('ok', `bank ${bank.index} @ ${hex(bank.base, 4)}`, outcome.coverage
      ? `code ${outcome.coverage.codeBytes} B / ${outcome.coverage.instructions} 指令，未访问 ${outcome.coverage.unvisitedBytes} B`
      : outcome.projectSaved ? `project ${displayPath(outcome.projectPath)}` : `lines ${outcome.lines?.length ?? 0}`);
    for (const line of outcome.lines ?? []) {
      console.log(`  ${line.address}  ${line.bytes.padEnd(11)} ${line.op ?? ''} ${line.operand ?? ''}`);
    }
  }
  if (report.command === 'xref') {
    rows([['address', report.address], ['banks', String(report.banks)], ['writes only', String(report.writesOnly)]]);
    if (report.references.length === 0) {
      status('warn', 'no reference', '该地址在这些 bank 里没有匹配的绝对/零页操作数');
    }
    for (const reference of report.references) {
      console.log(`  bank ${reference.bank}  ${reference.byAddress}  ${reference.op} ${reference.bytes}  ${reference.mode}  ${reference.effect}  file 0x${reference.romOffset.toString(16).toUpperCase()}`);
    }
  }
}

process.on('exit', () => {
  for (const dir of workDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory must not change the exit code.
    }
  }
});
