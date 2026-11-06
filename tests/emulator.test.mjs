import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  describeInputPorts,
  describeLaunchCommand,
  inspectNativeDependencies,
  patchInputPorts,
  provisionEmulator,
  readSettings,
  resolveHomeFolder,
  DEFAULT_DEVICE,
} from '../scripts/lib/emulator.mjs';

const EMULATOR_CLI = fileURLToPath(new URL('../scripts/emulator.mjs', import.meta.url));

function withTempDir(prefix, run) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a settings file beside the executable makes the profile portable', () => {
  withTempDir('reretro-home-', (root) => {
    const exeDir = join(root, 'bin');
    const documentsDir = join(root, 'Documents');
    mkdirSync(exeDir, { recursive: true });
    mkdirSync(join(documentsDir, 'MesenCE'), { recursive: true });
    writeFileSync(join(documentsDir, 'MesenCE', 'settings.json'), '{}');

    const withoutPortable = resolveHomeFolder({ exeDir, documentsDir });
    assert.equal(withoutPortable.portable, false);
    assert.equal(withoutPortable.path, join(documentsDir, 'MesenCE'));

    writeFileSync(join(exeDir, 'settings.json'), '{}');
    const portable = resolveHomeFolder({ exeDir, documentsDir });
    assert.equal(portable.portable, true);
    assert.equal(portable.path, exeDir);
  });
});

test('the legacy documents folder wins only when it is the one with settings', () => {
  withTempDir('reretro-home-', (root) => {
    const exeDir = join(root, 'bin');
    const documentsDir = join(root, 'Documents');
    mkdirSync(exeDir, { recursive: true });
    mkdirSync(join(documentsDir, 'Mesen2'), { recursive: true });
    writeFileSync(join(documentsDir, 'Mesen2', 'settings.json'), '{}');

    const resolved = resolveHomeFolder({ exeDir, documentsDir });
    assert.equal(resolved.path, join(documentsDir, 'Mesen2'));
    assert.equal(resolved.portable, false);
  });
});

test('native dependency inspection names what is missing', () => {
  withTempDir('reretro-native-', (root) => {
    const empty = inspectNativeDependencies(root);
    assert.equal(empty.complete, false);
    assert.deepEqual(empty.missing, ['MesenCore', 'libSkiaSharp', 'libHarfBuzzSharp']);

    for (const name of ['MesenCore', 'libSkiaSharp', 'libHarfBuzzSharp']) {
      writeFileSync(join(root, `${name}.dll`), 'stub');
    }
    const complete = inspectNativeDependencies(root);
    assert.equal(complete.complete, true);
    assert.equal(complete.found.length, 3);
  });
});

test('settings with a byte-order mark still parse', () => {
  withTempDir('reretro-settings-', (root) => {
    writeFileSync(join(root, 'settings.json'), '\uFEFF{"Nes":{"Port1":{"Type":"NesController"}}}', 'utf8');
    const settings = readSettings(root);
    assert.equal(settings.exists, true);
    assert.equal(settings.parseError, null);
    assert.equal(settings.bom, true);
    assert.equal(settings.data.Nes.Port1.Type, 'NesController');
  });
});

test('unconfigured and absent controller ports are filled in, configured ones are kept', () => {
  const { settings, changes } = patchInputPorts({
    Video: { Scale: 3 },
    Nes: { Port1: { Type: 'None' }, Emulation: 'keep' },
  });

  assert.deepEqual(changes, [
    { port: 'Port1', from: 'None', to: DEFAULT_DEVICE },
    { port: 'Port2', from: 'absent', to: DEFAULT_DEVICE },
  ]);
  assert.equal(settings.Nes.Port1.Type, DEFAULT_DEVICE);
  assert.equal(settings.Nes.Port2.Type, DEFAULT_DEVICE);
  assert.equal(settings.Video.Scale, 3);
  assert.equal(settings.Nes.Emulation, 'keep');

  const again = patchInputPorts(settings);
  assert.deepEqual(again.changes, []);
});

test('an unconfigured port is reported as not ready', () => {
  const empty = describeInputPorts({});
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.ports.map(port => port.configured), [false, false]);

  const configured = describeInputPorts({ Nes: { Port1: { Type: 'NesController' }, Port2: { Type: 'NesController' } } });
  assert.equal(configured.ready, true);
});

test('the launch command quotes both the executable and the ROM', () => {
  assert.equal(
    describeLaunchCommand({ exePath: 'C:\\a b\\Mesen.exe', romPath: 'C:\\roms\\x y.nes' }),
    '"C:\\a b\\Mesen.exe" "C:\\roms\\x y.nes"',
  );
  assert.equal(describeLaunchCommand({ exePath: null }), null);
});

test('provisioning a portable profile writes a startable, input-capable install', () => {
  withTempDir('reretro-provision-', (root) => {
    const exeDir = join(root, 'bin');
    mkdirSync(exeDir, { recursive: true });
    for (const name of ['MesenCore', 'libSkiaSharp', 'libHarfBuzzSharp']) {
      writeFileSync(join(exeDir, `${name}.dll`), 'stub');
    }
    writeFileSync(join(exeDir, 'Mesen.exe'), 'stub');

    const result = provisionEmulator({ exeDir, documentsDir: join(root, 'Documents'), romPath: 'C:\\roms\\x.nes' });

    assert.equal(result.ok, true);
    assert.equal(result.portable, true);
    assert.equal(result.homeFolder, exeDir);
    assert.deepEqual(result.portChanges.map(change => change.port), ['Port1', 'Port2']);
    assert.equal(result.ports.ready, true);
    assert.equal(result.missingNative.length, 0);
    assert.match(result.launchCommand, /x\.nes"$/);

    const written = readSettings(exeDir);
    assert.equal(written.parseError, null);
    assert.equal(written.data.Nes.Port1.Type, DEFAULT_DEVICE);
  });
});

test('provisioning a documents profile copies the native libraries it needs', () => {
  withTempDir('reretro-provision-', (root) => {
    const exeDir = join(root, 'bin');
    const documentsDir = join(root, 'Documents');
    mkdirSync(exeDir, { recursive: true });
    for (const name of ['MesenCore', 'libSkiaSharp', 'libHarfBuzzSharp']) {
      writeFileSync(join(exeDir, `${name}.dll`), 'stub');
    }

    const result = provisionEmulator({ exeDir, documentsDir, portable: false });

    assert.equal(result.ok, true);
    assert.equal(result.portable, false);
    assert.equal(result.homeFolder, join(documentsDir, 'MesenCE'));
    assert.deepEqual(result.copiedNative.sort(), ['MesenCore', 'libHarfBuzzSharp', 'libSkiaSharp'].sort());
    assert.ok(existsSync(join(documentsDir, 'MesenCE', 'settings.json')));
  });
});

test('the emulator command reports facts as JSON and a matching exit code', () => {
  const result = spawnSync(process.execPath, [EMULATOR_CLI, 'inspect', '--json'], { encoding: 'utf8', timeout: 60_000 });
  assert.ok([0, 1, 2].includes(result.status), `unexpected exit ${result.status}: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, result.status);
  assert.equal(typeof report.ok, 'boolean');
  if (!report.emulator) {
    assert.equal(result.status, 1);
    return;
  }
  assert.equal(typeof report.native.complete, 'boolean');
  assert.ok(Array.isArray(report.ports.ports));
  assert.match(report.launchCommand, /Mesen\.exe/);
});
