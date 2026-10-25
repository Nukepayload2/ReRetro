import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const DOCTOR = fileURLToPath(new URL('../scripts/diagnose.mjs', import.meta.url));

function runDoctor(args = []) {
  return spawnSync(process.execPath, [DOCTOR, ...args], { encoding: 'utf8', timeout: 180_000 });
}

test('the diagnostic flow reports every layer with a verdict and next actions', () => {
  const result = runDoctor(['--json']);
  // 0 ready, 1 broken, 2 degraded: all are legitimate depending on the host,
  // but the report itself must always be well formed.
  assert.ok([0, 1, 2].includes(result.status), `unexpected exit ${result.status}: ${result.stderr}`);

  const report = JSON.parse(result.stdout);
  const ids = report.steps.map(step => step.id);
  for (const required of ['runtime', 'repository', 'binaries', 'toolchain', 'handshake']) {
    assert.ok(ids.includes(required), `missing diagnostic step ${required}`);
  }
  assert.ok(['ready', 'degraded', 'broken'].includes(report.verdict));
  assert.equal(report.exitCode, result.status);
  assert.ok(Array.isArray(report.nextActions));

  for (const step of report.steps) {
    assert.equal(typeof step.title, 'string');
    assert.ok(['ok', 'warn', 'fail', 'info'].includes(step.status), `unexpected status ${step.status}`);
  }

  // A broken or degraded report must tell the reader what to do next.
  if (report.exitCode !== 0) {
    assert.ok(report.nextActions.length > 0, 'a non-ready report needs at least one next action');
  }
});

test('the diagnostic flow degrades instead of failing when Mesen is merely closed', () => {
  const result = runDoctor(['--json', '--live']);
  assert.ok([0, 1, 2].includes(result.status), result.stderr);
  const report = JSON.parse(result.stdout);
  const live = report.steps.find(step => step.id === 'live');
  if (!live) {
    return; // no bridge on this host: the handshake layer already explains it
  }
  if (live.status === 'warn') {
    assert.match(JSON.stringify(live), /Mesen|ROM/i);
  }
});
