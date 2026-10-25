#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { heading, parseArgs, rows, status } from './lib/cli.mjs';
import { checkNodeVersion, paths, readPins, relativePath } from './lib/config.mjs';
import { callBridgeTools, compareTools, readToolSurface, resultText } from './lib/mcp.mjs';
import { locateTools, submoduleState } from './lib/tools.mjs';

const args = parseArgs(process.argv.slice(2));
const json = args.flag('json');
const live = args.flag('live');
const rom = args.get('rom');
const timeoutMs = Number.parseInt(args.get('timeout', '30000'), 10);

const report = {
  node: checkNodeVersion(),
  submodules: null,
  tools: null,
  handshake: null,
  live: null,
  gates: [],
  exitCode: 0,
};

main();

function main() {
  report.submodules = gateSubmodules();
  report.tools = locateTools({ mesenDir: args.get('mesen-dir'), benchDir: args.get('bench-dir') });
  report.handshake = gateBridge();
  if (live || rom) {
    report.live = probeLive();
  }
  finish();
}

function gateSubmodules() {
  const pins = readPins();
  const state = submoduleState();
  const rowsOut = pins.submodules.map((pin) => {
    const observed = state.rows.find(row => row.path.replace(/\\/g, '/') === pin.path);
    const present = existsSync(resolve(paths.root, pin.path));
    const matches = observed ? observed.commit === pin.commit : false;
    return {
      path: pin.path,
      url: pin.url,
      pinned: pin.commit,
      observed: observed?.commit ?? null,
      state: observed?.state ?? (present ? 'present' : 'missing'),
      present,
      matches,
    };
  });

  const allPresent = rowsOut.every(row => row.present && (row.observed === null || row.matches));
  pushGate('submodules', allPresent ? 'pass' : 'fail', allPresent
    ? 'both submodules are checked out at their pinned commits'
    : 'initialize submodules with: git submodule update --init --recursive');
  return { source: state.source, rows: rowsOut };
}

function gateBridge() {
  const bridge = report.tools.mesen.bridge;
  if (!bridge) {
    pushGate('bridge-binary', 'fail', 'MCPServer.exe not found; run node scripts/setup.mjs');
    return { ok: false, reason: 'bridge missing' };
  }
  pushGate('bridge-binary', 'pass', relativePath(bridge));

  try {
    const surface = readToolSurface({ command: bridge, timeoutMs });
    const comparison = compareTools(surface.tools);
    const ok = comparison.ok && surface.tools.length > 0;
    const version = `${surface.server?.name ?? 'unknown'} ${surface.server?.version ?? ''}`.trim();
    const detail = `${surface.tools.length} tools from ${version}: ${comparison.present.length} core` +
      (comparison.optionalPresent.length > 0 ? ` + ${comparison.optionalPresent.length} optional (${comparison.optionalPresent.join(', ')})` : '') +
      (comparison.missing.length > 0 ? `; missing core: ${comparison.missing.join(', ')}` : '');
    pushGate('bridge-handshake', ok ? 'pass' : 'warn', detail);
    return {
      ok,
      server: surface.server,
      protocolVersion: surface.protocolVersion,
      instructions: surface.instructions,
      toolCount: surface.tools.length,
      tools: surface.tools.map(tool => tool.name),
      comparison,
    };
  } catch (error) {
    if (isMesenDown(error)) {
      pushGate('bridge-handshake', 'warn',
        'the tool list is not cached yet; open Mesen once so the bridge can answer tools/list offline');
      return { ok: false, reason: 'tool list not cached', details: error.details ?? null };
    }
    pushGate('bridge-handshake', 'fail', error.message);
    return { ok: false, reason: error.message, details: error.details ?? null };
  }
}

function probeLive() {
  const bridge = report.tools.mesen.bridge;
  if (!bridge) {
    pushGate('live-probe', 'fail', 'bridge missing');
    return { ok: false, reason: 'bridge missing' };
  }

  let first;
  try {
    const calls = [];
    // `--load` uses the bridge's own loader when the session advertises it
    // (newer MesenGM builds). Without it the ROM is loaded in the Mesen UI and
    // `--rom` only compares.
    if (rom && args.flag('load')) {
      calls.push({ name: 'load_rom', arguments: { path: resolve(rom) } });
    }
    calls.push({ name: 'get_rom_info', arguments: {} });
    calls.push({ name: 'debugger_status', arguments: {} });
    first = callBridgeTools({
      command: bridge,
      calls,
      timeoutMs: Math.max(timeoutMs, 60_000),
    });
  } catch (error) {
    if (isMesenDown(error)) {
      pushGate('live-probe', 'warn', 'Mesen is not running; open it, load the target ROM, then rerun with --live');
      return { ok: false, reason: 'Mesen is not running' };
    }
    pushGate('live-probe', 'fail', error.message);
    return { ok: false, reason: error.message };
  }

  const romInfoResult = first.results.find(entry => entry.name === 'get_rom_info');
  const romInfo = parseJson(romInfoResult?.result);
  const memoryTypes = Array.isArray(romInfo?.memory_types) ? romInfo.memory_types : [];
  const loaded = romInfo && romInfo.format && romInfo.format !== 'Unknown';
  const expectedRom = rom ? resolve(rom) : null;
  const romMatches = expectedRom && loaded
    ? normalizePath(romInfo?.rom_path ?? '') === normalizePath(expectedRom)
    : null;

  const calls = first.results.map(entry => ({
    name: entry.name,
    ok: entry.ok,
    error: entry.error,
    text: entry.result ? resultText(entry.result).slice(0, 4_000) : null,
  }));

  if (rom && args.flag('load') && !first.tools.some(tool => tool.name === 'load_rom')) {
    calls.push({
      name: 'load_rom',
      ok: false,
      error: { message: 'this bridge build has no load_rom tool; load the ROM in the Mesen UI' },
      text: null,
    });
  }

  // One real memory read: the workflow requires more than a status call, and
  // this is the cheapest read that proves the memory path.
  const region = memoryTypes.find(entry => /prg/i.test(entry.name ?? '')) ?? memoryTypes[0];
  if (loaded && region) {
    try {
      const read = callBridgeTools({
        command: bridge,
        calls: [{ name: 'get_memory_range', arguments: { memory_type: region.id, start_address: 0, length: 16 } }],
        timeoutMs: Math.max(timeoutMs, 60_000),
      });
      const entry = read.results[0];
      calls.push({
        name: 'get_memory_range',
        ok: entry.ok,
        error: entry.error,
        text: entry.result ? resultText(entry.result).slice(0, 1_000) : null,
      });
    } catch (error) {
      calls.push({ name: 'get_memory_range', ok: false, error: { message: error.message }, text: null });
    }
  }

  const ok = calls.every(entry => entry.ok) && loaded && romMatches !== false;
  const detail = !loaded
    ? 'no ROM is loaded in Mesen; open the target ROM first'
    : romMatches === false
      ? `loaded ROM is ${romInfo.rom_path}, not ${expectedRom}`
      : 'Mesen answered ROM, debugger and memory probes';
  pushGate('live-probe', ok ? 'pass' : 'warn', detail);

  return {
    ok,
    server: first.server,
    rom: romInfo ? { path: romInfo.rom_path, format: romInfo.format, console: romInfo.console_type_name, memoryTypes } : null,
    romMatches,
    calls,
  };
}

function isMesenDown(error) {
  const haystack = JSON.stringify(error?.details ?? {}) + ' ' + (error?.message ?? '');
  return /Mesen is not running|mesen-unavailable|not answer.*Mesen/i.test(haystack);
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function parseJson(result) {
  const text = result ? resultText(result) : '';
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pushGate(name, kind, message) {
  report.gates.push({ name, kind, message });
}

function finish() {
  const failed = report.gates.filter(gate => gate.kind === 'fail');
  const warned = report.gates.filter(gate => gate.kind === 'warn');

  if (failed.length > 0) {
    report.exitCode = 1;
  } else if (warned.length > 0 || !report.tools.mesen.emulator || !report.tools.bench.exe) {
    report.exitCode = 2;
  }

  if (json) {
    console.log(JSON.stringify({ ...report, ok: report.exitCode === 0 }, null, 2));
    process.exit(report.exitCode);
  }

  heading('Gates');
  for (const gate of report.gates) {
    status(gate.kind === 'pass' ? 'ok' : gate.kind === 'warn' ? 'warn' : 'fail', gate.name, gate.message);
  }

  heading('Evidence');
  rows([
    ['Node', `${report.node.version}${report.node.ok ? '' : ' (unsupported)'}`],
    ['submodule source', report.submodules.source === 'git' ? 'git checkout inspected' : 'pins.json only'],
    ['bridge', report.tools.mesen.bridge ? relativePath(report.tools.mesen.bridge) : 'missing'],
    ['emulator', report.tools.mesen.emulator ? relativePath(report.tools.mesen.emulator) : 'missing'],
    ['SourceGen', report.tools.bench.exe ? relativePath(report.tools.bench.exe) : 'missing'],
    ['handshake', report.handshake?.ok ? `ok (${report.handshake.toolCount} tools)` : 'not proven'],
    ['tool surface', report.handshake?.comparison
      ? `${report.handshake.comparison.present.length} core + ${report.handshake.comparison.optionalPresent.length} optional`
      : 'not measured'],
  ]);

  if (report.live) {
    heading('Live probe');
    if (report.live.rom) {
      rows([
        ['ROM', report.live.rom.path || '(none)'],
        ['format', report.live.rom.format],
        ['console', report.live.rom.console],
        ['memory regions', String(report.live.rom.memoryTypes.length)],
        ['matches --rom', report.live.romMatches === null ? 'not requested' : String(report.live.romMatches)],
      ]);
    }
    for (const entry of report.live.calls ?? []) {
      status(entry.ok ? 'ok' : 'warn', entry.name, entry.ok ? '' : entry.error?.message ?? 'no result');
      if (entry.text) {
        console.log(indent(entry.text));
      }
    }
    if (!report.live.calls) {
      status('warn', 'live probe', report.live.reason ?? 'unavailable');
    }
  }

  heading('Verdict');
  if (report.exitCode === 0) {
    status('ok', 'ready', 'bridge handshake proven; dynamic evidence can be collected');
  } else if (report.exitCode === 2) {
    status('warn', 'degraded', 'at least one tool or probe is missing; see the gate messages');
  } else {
    status('fail', 'not ready', 'fix the failing gates before claiming ROM behavior');
  }
  if (!report.tools.bench.exe) {
    status('warn', 'static side unavailable', 'build SourceGen (node scripts/setup.mjs) or point REA_FC_BENCH_DIR at an install');
  }
  if (report.exitCode !== 0) {
    status('info', 'next', 'docs/installation.md');
  }

  process.exit(report.exitCode);
}

function indent(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 12)
    .map(line => `    ${line}`)
    .join('\n');
}
