#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { heading, parseArgs, rows, status } from './lib/cli.mjs';
import { relativePath } from './lib/config.mjs';
import {
  applyEdits,
  bytesMatch,
  fileOffsetToCpu,
  hex,
  makeIps,
  parseInteger,
  parseRom,
  RomError,
  sha256,
  toBytes,
} from './lib/rom.mjs';

const args = parseArgs(process.argv.slice(2));
const json = args.flag('json');

main();

function main() {
  try {
    const romPath = args.get('rom');
    if (!romPath) {
      throw new RomError('--rom <file> is required');
    }
    const romFile = resolve(romPath);
    if (!existsSync(romFile)) {
      throw new RomError('the ROM file does not exist', { path: romPath });
    }

    const buffer = readFileSync(romFile);
    const header = parseRom(buffer);

    if (args.flag('info')) {
      emitInfo(romFile, header);
      return;
    }

    const outPath = args.get('out');
    if (!outPath) {
      throw new RomError('--out <file> is required (the original ROM is never overwritten)');
    }
    const outFile = resolve(outPath);
    if (outFile === romFile) {
      throw new RomError('--out must differ from --rom; the original ROM stays untouched');
    }
    if (existsSync(outFile) && !args.flag('force')) {
      throw new RomError('the output file already exists; pass --force to replace it', { path: outPath });
    }

    const editSpecs = args.all('edit');
    if (editSpecs.length === 0) {
      throw new RomError('at least one --edit <offset>:<old>:<new>[:note] is required');
    }

    const bank = {
      index: Number.parseInt(args.get('bank', '0'), 10),
      cpuStart: parseInteger(args.get('bank-cpu-start', '0x8000'), 'bank-cpu-start'),
      size: parseInteger(args.get('bank-size', '0x4000'), 'bank-size'),
    };

    const edits = editSpecs.map(spec => parseEdit(spec, header));
    const { buffer: patched, applied } = applyEdits(buffer, edits);
    const ips = args.get('ips') ? makeIps(buffer, patched) : null;

    const dryRun = args.flag('dry-run');
    if (!dryRun) {
      writeFileSync(outFile, patched);
      if (ips) {
        writeFileSync(resolve(args.get('ips')), ips.buffer);
      }
    }

    const readBack = dryRun ? patched : readFileSync(outFile);
    const verified = applied.every((edit, index) => bytesMatch(readBack, edit.offset, edit.write));
    const originalUnchanged = sha256(readFileSync(romFile)) === header.sha256;

    const result = {
      rom: relativePath(romFile),
      out: dryRun ? '(dry run)' : relativePath(outFile),
      header,
      edits: applied.map((edit, index) => ({
        fileOffset: hex(edit.offset, 6),
        cpuAddress: cpuAddressFor(header, edit.offset, bank),
        expected: edit.expect,
        written: edit.write,
        note: edits[index].note,
      })),
      ips: ips ? { path: relativePath(resolve(args.get('ips'))), records: ips.records } : null,
      sha256: { before: header.sha256, after: sha256(patched) },
      verified: verified && (dryRun || readBack.equals(patched)),
      originalUnchanged,
      dryRun,
    };

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResult(result);
    }

    if (!result.verified || !result.originalUnchanged) {
      process.exit(1);
    }
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: error.message, details: error.details ?? null }, null, 2));
    } else {
      status('fail', 'patch failed', error.message);
      if (error.details && Object.keys(error.details).length > 0) {
        console.log(JSON.stringify(error.details, null, 2));
      }
    }
    process.exit(1);
  }
}

function parseEdit(spec, header) {
  const parts = String(spec).split(':');
  if (parts.length < 3) {
    throw new RomError('an edit needs <offset>:<old>:<new>[:note]', { edit: spec });
  }
  const [offsetText, oldText, newText, ...noteParts] = parts;
  const offset = parseInteger(offsetText, 'edit offset');
  const expect = toBytes(oldText, 'original bytes');
  const write = toBytes(newText, 'new bytes');
  if (offset < 0 || offset + write.length > header.imageEnd) {
    throw new RomError('the edit falls outside the ROM image (header, PRG and CHR)', {
      offset,
      imageEnd: header.imageEnd,
    });
  }
  return { offset, expect, write, note: noteParts.join(':') };
}

function cpuAddressFor(header, fileOffset, bank) {
  const prgStart = header.prgOffset;
  const bankStart = prgStart + bank.index * bank.size;
  if (fileOffset < bankStart || fileOffset >= bankStart + bank.size) {
    return null;
  }
  try {
    return fileOffsetToCpu(header, {
      offset: fileOffset,
      bankIndex: bank.index,
      bankCpuStart: bank.cpuStart,
      bankSize: bank.size,
    }).cpuAddress;
  } catch {
    return null;
  }
}

function emitInfo(romFile, header) {
  if (json) {
    console.log(JSON.stringify({ rom: relativePath(romFile), header }, null, 2));
    return;
  }
  heading('ROM header');
  rows([
    ['file', relativePath(romFile)],
    ['format', header.format],
    ['mapper', String(header.mapper) + (header.subMapper ? ` (sub ${header.subMapper})` : '')],
    ['PRG ROM', `${header.prgSize} bytes (${header.prgBanks16k} x 16 KB)`],
    ['CHR ROM', `${header.chrSize} bytes (${header.chrBanks8k} x 8 KB)`],
    ['mirroring', header.mirroring],
    ['battery', header.hasBattery ? 'yes' : 'no'],
    ['trainer', header.hasTrainer ? 'yes' : 'no'],
    ['PRG offset', hex(header.prgOffset, 4)],
    ['CHR offset', hex(header.chrOffset, 6)],
    ['trailing bytes', String(header.trailingBytes)],
    ['SHA-256', header.sha256],
  ]);
}

function printResult(result) {
  heading('Patch');
  status(result.verified ? 'ok' : 'fail', result.verified ? 'bytes verified after write' : 'read-back mismatch');
  status(result.originalUnchanged ? 'ok' : 'fail', 'original ROM unchanged', result.originalUnchanged ? '' : 'the source file changed during the run');

  rows([
    ['ROM', result.rom],
    ['output', result.out],
    ['SHA-256 before', result.sha256.before],
    ['SHA-256 after', result.sha256.after],
  ]);

  heading('Edits');
  for (const edit of result.edits) {
    const cpu = edit.cpuAddress === null ? 'n/a (outside the selected bank)' : hex(edit.cpuAddress);
    console.log(`  ${edit.fileOffset}  CPU ${cpu}  ${edit.expected} -> ${edit.written}${edit.note ? '  ' + edit.note : ''}`);
  }

  if (result.ips) {
    heading('IPS');
    rows([
      ['file', result.ips.path],
      ['records', String(result.ips.records.length)],
    ]);
  }

  if (result.dryRun) {
    status('info', 'dry run', 'nothing was written');
  }
}
