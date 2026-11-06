#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Entry point for `npx reretro` / `npm run reretro -- <command>`.
 *
 * Each command stays a standalone script so it can also be run directly:
 * `node scripts/verify.mjs`.
 */
const here = dirname(fileURLToPath(import.meta.url));

const COMMANDS = {
  setup: { script: 'setup.mjs', summary: 'detect build tools, build the tools, write MCP client config' },
  doctor: { script: 'diagnose.mjs', summary: 'walk the bridge layers and name the next action' },
  verify: { script: 'verify.mjs', summary: 'prove the bridge and tool surface, optionally probe a live Mesen' },
  emulator: { script: 'emulator.mjs', summary: 'inspect or provision the emulator profile, native libraries and controller ports' },
  patch: { script: 'patch-rom.mjs', summary: 'write a deterministic ROM patch and optional IPS file' },
  info: { script: 'patch-rom.mjs', summary: 'print the iNES header of a ROM', prefix: ['--info'] },
  cheat: { script: 'cheat-code.mjs', summary: 'encode, decode or bank-check a Game Genie code' },
  sourcegen: { script: 'sourcegen.mjs', summary: 'build, list or cross-reference a PRG bank without the SourceGen GUI' },
  pins: { script: 'update-pins.mjs', summary: 'compare or record the submodule commits in third_party/pins.json' },
  check: { script: 'check-docs.mjs', summary: 'verify the repository has no machine-local paths or external workspace dependency' },
  test: { script: null, summary: 'run the test suite (node --test on every tests/*.test.mjs)' },
};

main();

function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    usage();
    process.exit(command ? 0 : 1);
  }

  if (command === 'test') {
    // `node --test tests/` passes the directory to the test runner as one entry
    // point, and Node 22 then loads it as a module: "Cannot find module .../tests".
    // Enumerating the files keeps every supported Node version running the same list.
    const result = spawnSync(process.execPath, ['--test', ...(rest.length ? rest : testFiles())], {
      cwd: join(here, '..'),
      stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }

  const entry = COMMANDS[command];
  if (!entry || !entry.script) {
    console.error(`unknown command: ${command}`);
    usage();
    process.exit(1);
  }

  let args = [...(entry.prefix ?? []), ...rest];
  if (command === 'info' && rest.length > 0 && !rest[0].startsWith('-')) {
    // `info <rom>` accepts the ROM as a positional argument.
    args = ['--rom', rest[0], ...rest.slice(1), ...(entry.prefix ?? [])];
  }
  const result = spawnSync(process.execPath, [join(here, entry.script), ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

function testFiles() {
  const dir = join(here, '..', 'tests');
  return readdirSync(dir)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => join(dir, name));
}

function usage() {
  console.log(`reretro — a standalone NES/6502 reversing kit

usage: reretro <command> [options]

commands:`);
  for (const [name, entry] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${entry.summary}`);
  }
  console.log(`
examples:
  node scripts/reretro.mjs setup
  node scripts/reretro.mjs verify --live
  node scripts/reretro.mjs emulator inspect --rom roms/game.nes
  node scripts/reretro.mjs emulator provision --rom roms/game.nes
  node scripts/reretro.mjs info roms/game.nes
  node scripts/reretro.mjs patch --rom roms/game.nes --out out/game.patched.nes --edit 0x15A2:EA:AD --ips out/game.ips
  node scripts/reretro.mjs cheat encode --address 0xC0A0 --value 0x0A --compare 0x03

docs: docs/workflow.md, docs/installation.md, docs/cli.md`);
}
