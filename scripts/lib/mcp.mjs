import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Mesen bridge handshake over file-backed stdio.
 *
 * `MCPServer.exe --stdio` reads newline-delimited JSON-RPC from stdin and writes
 * newline-delimited JSON-RPC to stdout. A client normally gives it pipes. This
 * module gives it files instead: the same bytes, the same framing, and it still
 * works where named pipes are unavailable (restricted agent sandboxes and
 * locked-down build machines). Interactive clients keep using pipes or the HTTP
 * transport; verification only needs a batch of requests and their replies.
 */

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Tool surface of the MesenGM MCP bridge.
 *
 * `CORE_MESEN_TOOLS` exist at the commit pinned in `third_party/pins.json`
 * (the Nukepayload2 fork, which adds ROM loading, save states, input overrides
 * and frame stepping on top of the upstream 16).
 *
 * `OPTIONAL_MESEN_TOOLS` is the escape hatch for tools that appear in a local
 * build but not at the pin: verification requires the core set and reports the
 * optional set without failing on it. Keep it empty unless a tool is genuinely
 * optional for the pinned surface.
 *
 * The bridge replays a tool-list cache that Mesen writes when it starts, so
 * `tools/list` answers offline only after Mesen has run at least once in the
 * current user profile.
 */
export const CORE_MESEN_TOOLS = [
  'debugger_status',
  'get_rom_info',
  'load_rom',
  'close_rom',
  'get_cpu_state',
  'get_ppu_state',
  'get_screen',
  'get_memory_range',
  'search_memory',
  'set_memory',
  'get_disassembly',
  'get_trace_tail',
  'get_debug_events',
  'set_breakpoints',
  'step',
  'resume',
  'pause',
  'run_frames',
  'set_input',
  'clear_input',
  'save_rom',
  'save_state',
  'load_state',
];

/** Tools that may exist in a local build but are not required by the pin. */
export const OPTIONAL_MESEN_TOOLS = [];

/** Every documented tool, core first. */
export const EXPECTED_MESEN_TOOLS = [...CORE_MESEN_TOOLS, ...OPTIONAL_MESEN_TOOLS];

export class McpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'McpError';
    this.details = details;
  }
}

/**
 * Send a batch of JSON-RPC requests to the bridge and collect the replies.
 *
 * @param {object} options
 * @param {string} options.command Absolute path to MCPServer.exe.
 * @param {Array<object>} options.messages JSON-RPC messages, in order.
 * @param {number} [options.timeoutMs] Budget for the whole batch.
 * @param {string} [options.cwd] Working directory for the bridge process.
 */
export function runBridgeBatch({ command, messages, timeoutMs = DEFAULT_TIMEOUT_MS, cwd }) {
  if (!existsSync(command)) {
    throw new McpError('the bridge executable does not exist', { command });
  }

  const workDir = mkdtempSync(join(tmpdir(), 'reretro-mcp-'));
  const inputPath = join(workDir, 'stdin.jsonl');
  const outputPath = join(workDir, 'stdout.jsonl');
  const errorPath = join(workDir, 'stderr.log');

  writeFileSync(inputPath, messages.map(message => JSON.stringify(message)).join('\n') + '\n', 'utf8');

  const inputFd = openSync(inputPath, 'r');
  const outputFd = openSync(outputPath, 'w');
  const errorFd = openSync(errorPath, 'w');

  let child;
  try {
    child = spawn(command, ['--stdio'], {
      cwd,
      stdio: [inputFd, outputFd, errorFd],
      windowsHide: true,
    });
  } finally {
    closeSync(inputFd);
    closeSync(outputFd);
    closeSync(errorFd);
  }

  const expectedIds = new Set(messages.filter(message => message.id !== undefined).map(message => message.id));
  const responses = new Map();
  let rawOutput = '';
  let stderr = '';
  const deadline = Date.now() + timeoutMs;

  const readOutput = () => {
    try {
      rawOutput = readFileSync(outputPath, 'utf8');
    } catch {
      rawOutput = '';
    }
    for (const line of rawOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const message = JSON.parse(trimmed);
        if (message.id !== undefined && !responses.has(message.id)) {
          responses.set(message.id, message);
        }
      } catch {
        // A partial trailing line stays unparsed until the next read.
      }
    }
  };

  const readError = () => {
    try {
      stderr = readFileSync(errorPath, 'utf8').slice(-8_000);
    } catch {
      stderr = '';
    }
  };

  try {
    while (Date.now() < deadline) {
      readOutput();
      if (expectedIds.size === responses.size) {
        break;
      }
      sleep(50);
    }
    readOutput();
    readError();

    const missing = [...expectedIds].filter(id => !responses.has(id));
    return {
      responses: messages.map(message => message.id !== undefined ? responses.get(message.id) ?? null : null),
      raw: rawOutput,
      stderr,
      missing,
      timedOut: missing.length > 0,
      workDir,
    };
  } finally {
    killProcess(child);
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Temp cleanup failure must not hide the handshake result.
    }
  }
}

/** Kill a spawned process without assuming Node signals reach it. */
export function killProcess(child) {
  try {
    child.kill();
  } catch {
    // Fall through to taskkill.
  }
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // Best effort: the batch result is already collected.
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Handshake with the bridge and return its tool surface.
 *
 * Mirrors what an MCP client does: `initialize`, `notifications/initialized`,
 * then `tools/list`. The bridge answers these locally, so this succeeds even
 * when Mesen is closed.
 */
export function readToolSurface({ command, timeoutMs = DEFAULT_TIMEOUT_MS, cwd }) {
  const batch = runBridgeBatch({
    command,
    cwd,
    timeoutMs,
    messages: [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'reretro', version: '0.1.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ],
  });

  const [initialize, , listing] = batch.responses;
  if (!initialize || initialize.error) {
    throw new McpError('the bridge did not answer initialize', {
      response: initialize ?? null,
      stderr: batch.stderr,
      timedOut: batch.timedOut,
    });
  }
  if (!listing || listing.error) {
    throw new McpError('the bridge did not answer tools/list', {
      response: listing ?? null,
      stderr: batch.stderr,
      timedOut: batch.timedOut,
    });
  }

  const tools = Array.isArray(listing.result?.tools) ? listing.result.tools : [];
  return {
    server: initialize.result?.serverInfo ?? null,
    protocolVersion: initialize.result?.protocolVersion ?? null,
    instructions: initialize.result?.instructions ?? null,
    tools,
    stderr: batch.stderr,
  };
}

/**
 * Run tool calls in one bridge session.
 *
 * Requests are issued in order after the handshake. A call that needs Mesen
 * fails with the bridge's own error payload, which is reported as data rather
 * than thrown, so one missing emulator does not hide the rest of the batch.
 */
export function callBridgeTools({ command, calls, timeoutMs = DEFAULT_TIMEOUT_MS, cwd }) {
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'reretro', version: '0.1.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  calls.forEach((call, index) => {
    messages.push({
      jsonrpc: '2.0',
      id: 100 + index,
      method: 'tools/call',
      params: { name: call.name, arguments: call.arguments ?? {} },
    });
  });

  const batch = runBridgeBatch({ command, messages, timeoutMs, cwd });
  const initialize = batch.responses[0];
  // responses[1] is the notification (always null); responses[2] is tools/list.
  const listing = batch.responses[2];
  if (!initialize || initialize.error) {
    throw new McpError('the bridge did not answer initialize', {
      response: initialize ?? null,
      stderr: batch.stderr,
    });
  }
  const tools = Array.isArray(listing?.result?.tools) ? listing.result.tools : [];
  const results = calls.map((call, index) => {
    const response = batch.responses[3 + index];
    return {
      name: call.name,
      arguments: call.arguments ?? {},
      ok: Boolean(response && !response.error),
      error: response?.error ?? null,
      result: response?.result ?? null,
    };
  });

  return {
    server: initialize.result?.serverInfo ?? null,
    protocolVersion: initialize.result?.protocolVersion ?? null,
    tools,
    results,
    stderr: batch.stderr,
    timedOut: batch.timedOut,
  };
}

/** Compare the running tool surface with the documented one. */
/**
 * Compare the running tool surface with the documented one.
 *
 * `ok` only requires the core set: an older or newer MesenGM build stays
 * usable, and the optional tools are reported rather than enforced.
 */
export function compareTools(tools, { core = CORE_MESEN_TOOLS, optional = OPTIONAL_MESEN_TOOLS } = {}) {
  const present = new Set(tools.map(tool => tool.name));
  const documented = [...core, ...optional];
  return {
    present: core.filter(name => present.has(name)),
    missing: core.filter(name => !present.has(name)),
    optionalPresent: optional.filter(name => present.has(name)),
    optionalMissing: optional.filter(name => !present.has(name)),
    unexpected: tools.map(tool => tool.name).filter(name => !documented.includes(name)),
    ok: core.every(name => present.has(name)),
  };
}

/** Flatten a tool result into text for reports. */
export function resultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n');
  if (text) {
    return text;
  }
  if (result?.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return JSON.stringify(result ?? null, null, 2);
}
