import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run a program and capture stdout/stderr through files.
 *
 * Pipes are the obvious choice, but restricted environments (agent sandboxes,
 * hardened build hosts) can deny named pipes. File-backed handles keep the same
 * contract: a status, the two streams as strings, and an explicit timeout flag.
 */
export function run(command, args = [], options = {}) {
  const { cwd, env, timeoutMs = 120_000, input } = options;

  const workDir = mkdtempSync(join(tmpdir(), 'rea-fc-run-'));
  const stdoutPath = join(workDir, 'stdout.log');
  const stderrPath = join(workDir, 'stderr.log');

  let stdinFd = null;
  if (input !== undefined) {
    const stdinPath = join(workDir, 'stdin.log');
    writeFileSync(stdinPath, Buffer.isBuffer(input) ? input : String(input), 'utf8');
    stdinFd = openSync(stdinPath, 'r');
  }

  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');

  let child;
  try {
    child = spawnSync(command, args, {
      cwd,
      env: env ?? process.env,
      timeout: timeoutMs,
      stdio: [stdinFd === null ? 'ignore' : stdinFd, stdoutFd, stderrFd],
      windowsHide: true,
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    if (stdinFd !== null) {
      closeSync(stdinFd);
    }
  }

  const stdout = safeRead(stdoutPath);
  const stderr = safeRead(stderrPath);
  rmSync(workDir, { recursive: true, force: true });

  return {
    status: child.status,
    signal: child.signal,
    stdout,
    stderr,
    error: child.error ?? null,
    timedOut: child.error?.code === 'ETIMEDOUT',
    ok: child.status === 0,
  };
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Run a git command in the repository and return trimmed output. */
export function git(args, { cwd, timeoutMs = 20_000 } = {}) {
  return run('git', args, { cwd, timeoutMs });
}
