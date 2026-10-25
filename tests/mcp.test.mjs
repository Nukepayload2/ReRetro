import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CORE_MESEN_TOOLS,
  EXPECTED_MESEN_TOOLS,
  OPTIONAL_MESEN_TOOLS,
  callBridgeTools,
  compareTools,
  readToolSurface,
} from '../scripts/lib/mcp.mjs';
import { locateTools } from '../scripts/lib/tools.mjs';

const tools = locateTools();
const bridge = tools.mesen.bridge;

test('the surface comparison requires the core set and reports optional tools separately', () => {
  const coreOnly = compareTools(CORE_MESEN_TOOLS.map(name => ({ name })));
  assert.equal(coreOnly.ok, true);
  assert.deepEqual(coreOnly.missing, []);
  assert.deepEqual(coreOnly.optionalPresent, []);

  const newer = compareTools([...CORE_MESEN_TOOLS, ...OPTIONAL_MESEN_TOOLS].map(name => ({ name })));
  assert.equal(newer.ok, true);
  assert.deepEqual(newer.optionalMissing, []);
  assert.equal(newer.optionalPresent.length, OPTIONAL_MESEN_TOOLS.length);
  assert.deepEqual(newer.unexpected, []);

  const older = compareTools(CORE_MESEN_TOOLS.slice(1).map(name => ({ name })));
  assert.equal(older.ok, false);
  assert.deepEqual(older.missing, [CORE_MESEN_TOOLS[0]]);

  assert.equal(EXPECTED_MESEN_TOOLS.length, CORE_MESEN_TOOLS.length + OPTIONAL_MESEN_TOOLS.length);
});

// The bridge replays a tool-list cache that Mesen writes when it starts. On a
// machine that has never opened Mesen, tools/list reports "Mesen is not
// running"; that is an environment state, not a defect in this repository.
test('the bridge handshake exposes at least the core tool surface', {
  skip: bridge ? false : 'MCPServer.exe is not built yet (run node scripts/setup.mjs)',
  timeout: 120_000,
}, () => {
  let surface;
  try {
    surface = readToolSurface({ command: bridge, timeoutMs: 90_000 });
  } catch (error) {
    const details = JSON.stringify(error.details ?? {});
    if (/Mesen is not running|mesen-unavailable/.test(details + error.message)) {
      // Open Mesen once, then rerun; the cache makes the list answerable offline.
      return;
    }
    throw error;
  }

  assert.ok(surface.tools.length > 0, 'tools/list returned no tools');
  assert.equal(surface.server?.name, 'Mesen2-MCP');

  const comparison = compareTools(surface.tools);
  assert.deepEqual(comparison.missing, [], 'core tools are missing from the bridge');
  assert.ok(comparison.ok);
});

test('tool calls stay aligned with their request even when the bridge answers with errors', {
  skip: bridge ? false : 'MCPServer.exe is not built yet (run node scripts/setup.mjs)',
  timeout: 120_000,
}, () => {
  const batch = callBridgeTools({
    command: bridge,
    calls: [
      { name: 'get_rom_info', arguments: {} },
      { name: 'debugger_status', arguments: {} },
    ],
    timeoutMs: 90_000,
  });

  assert.ok(Array.isArray(batch.tools));
  assert.equal(batch.results.length, 2);
  assert.deepEqual(batch.results.map(entry => entry.name), ['get_rom_info', 'debugger_status']);
  // With Mesen closed both calls fail; the point is that each result belongs to
  // its own request and carries the bridge's error, not a neighbouring payload.
  if (!batch.results.every(entry => entry.ok)) {
    assert.match(JSON.stringify(batch.results), /Mesen is not running/);
  }
});
