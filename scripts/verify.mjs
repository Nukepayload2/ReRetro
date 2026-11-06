#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { heading, parseArgs, rows, status } from './lib/cli.mjs';
import { checkNodeVersion, displayPath, paths, readPins, relativePath } from './lib/config.mjs';
import { describeInputPorts, inspectNativeDependencies, readSettings, resolveHomeFolder } from './lib/emulator.mjs';
import { callBridgeTools, compareTools, readToolSurface, resultText } from './lib/mcp.mjs';
import { locateTools, pinRemoteState, submoduleState } from './lib/tools.mjs';

const args = parseArgs(process.argv.slice(2));
const json = args.flag('json');
const live = args.flag('live');
const probeBreakpoints = args.flag('breakpoint');
const rom = args.get('rom');
const timeoutMs = Number.parseInt(args.get('timeout', '30000'), 10);

const report = {
  node: checkNodeVersion(),
  submodules: null,
  tools: null,
  handshake: null,
  emulator: null,
  live: null,
  gates: [],
  exitCode: 0,
};

main();

function main() {
  report.submodules = gateSubmodules();
  gatePinRemote(report.submodules.rows);
  report.tools = locateTools({ mesenDir: args.get('mesen-dir'), benchDir: args.get('bench-dir') });
  report.handshake = gateBridge();
  report.emulator = gateEmulator();
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
      dirty: observed?.dirty ?? 0,
      present,
      matches,
    };
  });

  const allPresent = rowsOut.every(row => row.present && (row.observed === null || row.matches));
  const dirty = rowsOut.filter(row => row.dirty > 0);
  pushGate('submodules', allPresent ? 'pass' : 'fail', allPresent
    ? 'both submodules are checked out at their pinned commits'
    : 'initialize submodules with: git submodule update --init --recursive');
  //A dirty checkout builds from local edits, so the pinned commit alone no longer
  //describes the binaries: say so instead of reporting the pin as proven.
  pushGate('submodule-worktree', dirty.length === 0 ? 'pass' : 'warn', dirty.length === 0
    ? 'no uncommitted changes in the submodule checkouts'
    : dirty.map(row => `${row.path} has ${row.dirty} uncommitted change(s); commit them in the fork and record the pin, or the binaries do not match the pin`).join('; '));
  return { source: state.source, rows: rowsOut };
}

/**
 * Prove each pin is a commit its remote can serve.
 *
 * A pin that exists only in this checkout breaks `git submodule update --init` for everyone
 * else, and the other gates cannot see it: the checkout matches the pin, the gitlink matches
 * the pin, and the binaries match the checkout. `--fetch` turns the answer from "what the
 * last fetch saw" into "what the remote serves now", which needs network.
 */
function gatePinRemote(rows) {
  const fetch = args.flag('fetch');
  const messages = [];
  let kind = 'pass';
  for (const row of rows) {
    if (!row.present) {
      continue;
    }
    const state = pinRemoteState({ dir: resolve(paths.root, row.path), commit: row.pinned, fetch });
    if (state.state === 'served') {
      messages.push(`${row.path}: ${row.pinned.slice(0, 12)} is on ${state.branches.join(', ')}`);
    } else if (state.state === 'unmeasured') {
      // A tarball checkout or a submodule cloned without remote refs has nothing to compare
      // against; calling that "unpushed" would be the false negative this gate exists to avoid.
      messages.push(`${row.path}: ${state.reason}; rerun with --fetch to compare against ${row.url}`);
    } else if (state.state === 'unpushed') {
      kind = 'warn';
      messages.push(`${row.path}: ${row.pinned.slice(0, 12)} is on no fetched branch — push it to ${row.url} (rerun with --fetch if the refs are stale)`);
    } else {
      kind = 'warn';
      messages.push(`${row.path}: cannot ask ${row.url} (${state.reason})`);
    }
  }
  if (messages.length > 0) {
    pushGate('pin-remote', kind, messages.join('; '));
  }
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

/**
 * Prove the emulator itself can start and accept input.
 *
 * The handshake gate is answered by the bridge alone, so it stays green while
 * the emulator is unstartable or has no controller port. This gate reads the
 * facts that decide those two questions, and is a pass when a live probe
 * already saw controllers, because then the emulator is demonstrably running.
 */
function gateEmulator() {
  const emulator = report.tools.mesen.emulator;
  if (!emulator) {
    pushGate('emulator-setup', 'fail', 'Mesen.exe not found; run node scripts/setup.mjs');
    return { ok: false, reason: 'emulator missing' };
  }

  const exeDir = dirname(emulator);
  const home = resolveHomeFolder({ exeDir, documentsDir: join(homedir(), 'Documents') });
  const settings = readSettings(home.path);
  const native = inspectNativeDependencies(home.path);
  const ports = describeInputPorts(settings.data ?? {});

  const problems = [];
  if (!settings.exists) {
    problems.push('no settings.json: the first run enters the configuration wizard');
  } else if (settings.parseError) {
    problems.push(`settings.json does not parse (${settings.parseError})`);
  }
  if (!native.complete) {
    problems.push(`missing native libraries ${native.missing.join(', ')}`);
  }
  if (!ports.ready) {
    problems.push(`controller ports unconfigured (${ports.ports.filter(port => !port.configured).map(port => port.port).join(', ')})`);
  }

  pushGate('emulator-setup', problems.length === 0 ? 'pass' : 'warn', problems.length === 0
    ? `profile ${displayPath(home.path)} (${home.portable ? 'portable' : 'documents'}), native libraries complete, ${ports.ports.map(port => `${port.port}=${port.device}`).join(', ')}`
    : `${problems.join('; ')} — run node scripts/reretro.mjs emulator provision`);

  return {
    ok: problems.length === 0,
    emulator: relativePath(emulator),
    homeFolder: displayPath(home.path),
    portable: home.portable,
    settings: { exists: settings.exists, bytes: settings.bytes ?? 0, parseError: settings.parseError },
    native,
    ports,
    problems,
  };
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
    // Releasing controller 0 changes no game state and returns the controller
    // list: the only direct proof that the bridge can send input at all.
    calls.push({ name: 'clear_input', arguments: { controller: 0 } });
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

  const calls = first.results
    .filter(entry => entry.name !== 'clear_input')
    .map(entry => ({
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

  const inputResult = first.results.find(entry => entry.name === 'clear_input');
  const controllers = parseJson(inputResult?.result)?.available_controllers ?? [];
  pushGate('input-probe', controllers.length > 0 ? 'pass' : 'warn', controllers.length > 0
    ? `available_controllers ${JSON.stringify(controllers)}`
    : 'no controller port is configured; set_input will be rejected — run node scripts/reretro.mjs emulator provision');

  const breakpoints = (loaded && (probeBreakpoints || null))
    ? probeBreakpointTools(bridge, romInfo, timeoutMs)
    : null;

  return {
    ok,
    server: first.server,
    rom: romInfo ? { path: romInfo.rom_path, format: romInfo.format, console: romInfo.console_type_name, memoryTypes } : null,
    romMatches,
    controllers,
    breakpoints,
    calls,
  };
}

/**
 * Prove the breakpoint path end to end: set a write breakpoint on the 6502 stack page
 * (pushed every frame), advance frames, and require the stop to be reported with its
 * address, source and id, plus a served event history. It replaces the whole breakpoint
 * list, which is why it is opt-in.
 *
 * The probe does not require a Breakpoint event: with predictive breakpoints enabled
 * (Mesen's default) the CPU stops on the instruction that is about to write, so the hit is
 * reported while the operation, and its event, still lie ahead.
 */
function probeBreakpointTools(bridge, romInfo, timeout) {
  if (romInfo?.console_type_name !== 'Nes') {
    pushGate('breakpoint-probe', 'warn', `console is ${romInfo?.console_type_name ?? 'unknown'}; the probe needs the NES stack page`);
    return null;
  }

  const calls = [
    { name: 'set_breakpoints', arguments: { breakpoints: [{ address: 0x01f0, end_address: 0x01ff, type: 2 }] } },
    // A stack write happens within the first instructions of a frame, so a working
    // breakpoint stops the run long before the 60-frame target. Asking for one frame only
    // would race with the tool's own trailing step at the frame boundary.
    { name: 'run_frames', arguments: { frames: 60, timeout_ms: 2500 } },
    // The whole retained history, not a tail: the hit is not always the newest event.
    { name: 'get_debug_events', arguments: { max_count: 1000 } },
    { name: 'set_breakpoints', arguments: { breakpoints: [] } },
    { name: 'resume', arguments: {} },
  ];

  let results;
  try {
    results = callBridgeTools({ command: bridge, calls, timeoutMs: Math.max(timeout, 60_000) }).results;
  } catch (error) {
    pushGate('breakpoint-probe', 'warn', `breakpoint probe did not run: ${error.message}`);
    return { error: error.message };
  }

  const [setResult, runResult, eventsResult, clearResult] = results;
  const set = parseJson(setResult?.result);
  const run = parseJson(runResult?.result);
  const events = parseJson(eventsResult?.result);
  const cleared = parseJson(clearResult?.result);
  const hits = (events?.events ?? []).filter(event => event.type === 'Breakpoint');

  const failures = [];
  if (set?.marked !== 1) {
    failures.push(`set_breakpoints reported marked ${set?.marked ?? 'nothing'} (expected 1)`);
  }
  if (run?.stopped_by_breakpoint !== true) {
    failures.push(`run_frames reported stopped_by_breakpoint ${run?.stopped_by_breakpoint ?? 'nothing'} after a stack write breakpoint`);
  }
  if (run?.break_source !== 'Breakpoint') {
    failures.push(`run_frames reported break_source ${run?.break_source ?? 'nothing'} (expected Breakpoint)`);
  }
  if (run?.breakpoint_id !== 0) {
    failures.push(`run_frames reported breakpoint_id ${run?.breakpoint_id ?? 'nothing'} (expected 0)`);
  }
  if (run?.timed_out === true) {
    failures.push('run_frames timed out instead of stopping at the breakpoint');
  }
  if (run?.success === true) {
    failures.push(`run_frames reached all ${run?.frames_requested} frame(s) with the breakpoint armed`);
  }
  if (typeof run?.pc !== 'number') {
    failures.push('run_frames did not report the address it stopped at');
  }
  if (!(events?.total > 0)) {
    failures.push('get_debug_events served an empty history');
  }
  if (cleared?.breakpoints_set !== 0) {
    failures.push(`the trailing set_breakpoints [] did not clear the list (${cleared?.breakpoints_set ?? 'nothing'})`);
  }

  const detail = failures.length === 0
    ? `stopped after ${run?.frames_elapsed ?? '?'} frame(s), ${hits.length} Breakpoint event(s), breakpoint_id ${hits[0]?.breakpoint_id ?? '?'}`
    : failures.join('; ');
  pushGate('breakpoint-probe', failures.length === 0 ? 'pass' : 'warn', detail);

  return {
    ok: failures.length === 0,
    detail,
    framesElapsed: run?.frames_elapsed ?? null,
    stoppedByBreakpoint: run?.stopped_by_breakpoint ?? null,
    resumedFrom: run?.resumed_from ?? null,
    hits: hits.length,
    breakpointIds: hits.map(event => event.breakpoint_id),
    totalEvents: events?.total ?? null,
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
    if (report.live.breakpoints) {
      rows([
        ['breakpoint probe', report.live.breakpoints.ok ? 'hit on the first frame' : 'no hit'],
        ['frames before the stop', String(report.live.breakpoints.framesElapsed ?? '?')],
        ['Breakpoint events', String(report.live.breakpoints.hits ?? 0)],
        ['breakpoint_id', JSON.stringify(report.live.breakpoints.breakpointIds ?? [])],
      ]);
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
    status('warn', 'static side unavailable', 'build SourceGen (node scripts/setup.mjs) or point RERETRO_BENCH_DIR at an install');
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
