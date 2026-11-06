import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinRemoteState } from '../scripts/lib/tools.mjs';

const GIT = spawnSync('git', ['--version'], { encoding: 'utf8' });
const SKIP = GIT.status === 0 ? false : 'git is not available';

/** Run git in a scratch repository and fail loudly rather than swallowing a setup error. */
function gitIn(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/**
 * A scratch repository with two commits and one synthetic remote-tracking ref, so the pin
 * check can be exercised without a network or a real submodule.
 */
function withScratchRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), 'reretro-pin-'));
  try {
    gitIn(dir, ['init', '--quiet']);
    gitIn(dir, ['config', 'user.email', 'test@example.invalid']);
    gitIn(dir, ['config', 'user.name', 'test']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'file.txt'), 'one\n');
    gitIn(dir, ['add', 'file.txt']);
    gitIn(dir, ['commit', '--quiet', '-m', 'first']);
    const first = gitIn(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'file.txt'), 'two\n');
    gitIn(dir, ['add', 'file.txt']);
    gitIn(dir, ['commit', '--quiet', '-m', 'second']);
    const second = gitIn(dir, ['rev-parse', 'HEAD']);
    return run({ dir, first, second });
  } finally {
    // Git keeps packed objects read-only and a scanner can hold them briefly on Windows, so
    // deleting the scratch repository needs retries.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('a pinned commit is served when a remote-tracking ref contains it', { skip: SKIP }, () => {
  withScratchRepo(({ dir, first, second }) => {
    // The remote has seen the first commit only, which is what a fetch before the second
    // commit existed would leave behind.
    gitIn(dir, ['update-ref', 'refs/remotes/origin/master', first]);

    const served = pinRemoteState({ dir, commit: first });
    assert.equal(served.state, 'served');
    assert.deepEqual(served.branches, ['origin/master']);

    const unpushed = pinRemoteState({ dir, commit: second });
    assert.equal(unpushed.state, 'unpushed');
    assert.deepEqual(unpushed.branches, []);
    assert.match(unpushed.reason, /no fetched branch/);
  });
});

test('no remote-tracking ref means unmeasured, not unpushed', { skip: SKIP }, () => {
  withScratchRepo(({ dir, first }) => {
    // `git submodule update --init` leaves exactly this state: a detached HEAD at the pin and
    // no remote refs. Reporting that as "not pushed" would be a false negative.
    const state = pinRemoteState({ dir, commit: first });
    assert.equal(state.state, 'unmeasured');
    assert.equal(state.reason, 'no remote-tracking refs');
  });
});

test('a fetch that cannot be performed degrades to unknown', { skip: SKIP }, () => {
  // Point the check at a directory that is not a repository: git refuses without opening a
  // transport. A local-path remote would be the obvious way to write this, but local transport
  // hangs in this environment (see TI-012), which is exactly the kind of block the check is
  // meant to report rather than join.
  const dir = mkdtempSync(join(tmpdir(), 'reretro-pin-norepo-'));
  try {
    const state = pinRemoteState({ dir, commit: '0'.repeat(40), fetch: true, timeoutMs: 20_000 });
    assert.equal(state.state, 'unknown');
    assert.match(state.reason, /fetch failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
