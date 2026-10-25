import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { scanText } from '../scripts/check-docs.mjs';

const CHECK_DOCS = fileURLToPath(new URL('../scripts/check-docs.mjs', import.meta.url));

test('the repository contains no external key placeholders or machine paths', () => {
  const result = spawnSync(process.execPath, [CHECK_DOCS, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
  assert.ok(report.files > 10, `expected the scanner to cover the repository, scanned ${report.files}`);
});

test('documented relative links resolve', () => {
  const result = spawnSync(process.execPath, [CHECK_DOCS, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(result.stdout);
  const broken = report.violations.filter(violation => violation.rule === 'broken link');
  assert.deepEqual(broken, []);
});

// The literals are assembled at runtime so this test file does not trip the
// scanner it is testing.
const backslash = '\\';
const drive = 'C:';
const projectsDrive = 'G:';

test('the scanner catches user-profile and project-root paths in every separator style', () => {
  const samples = [
    `${drive}${backslash}Users${backslash}bob${backslash}project`,
    `${drive}/Users/bob/project`,
    `${projectsDrive}${backslash}Projects${backslash}repo`,
    `${projectsDrive}/Projects/repo`,
    '/' + 'home/bob/project',
  ];
  for (const sample of samples) {
    assert.ok(scanText(sample, 'sample').length > 0, `expected a violation for ${sample}`);
  }
});

test('the scanner catches placeholder syntax and the external workspace name', () => {
  const placeholder = '{' + '{Bench6502}}';
  assert.ok(scanText(placeholder, 'sample').length > 0);
  assert.ok(scanText('see ' + 'Material' + 'Box' + ' for details', 'sample').length > 0);
});

test('the scanner leaves portable placeholder paths alone', () => {
  assert.deepEqual(scanText('C:\\path\\file.txt', 'sample'), []);
  assert.deepEqual(scanText('see docs/workflow.md', 'sample'), []);
});
