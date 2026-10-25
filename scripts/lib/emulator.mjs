import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Emulator initialisation facts for a MesenGM install.
 *
 * The bridge can answer `initialize` and `tools/list` while the emulator is
 * closed, so a green handshake says nothing about whether the emulator itself
 * will start, which profile it will use, or whether it has a controller port.
 * These helpers answer those three questions from the install directory, and
 * `provisionEmulator` makes the install startable and input-capable.
 *
 * Behaviour modelled here lives in the pinned tool's own source, not in this
 * file: `UI/Config/ConfigManager.cs` (`HomeFolder`, `DefaultDocumentsFolder`),
 * `UI/Program.cs` (`DllImportResolver` looks for native libraries only in the
 * home folder) and `UI/Config/InputConfig.cs` (a port defaults to `None`).
 */

/** Native libraries Mesen resolves from its home folder at start-up. */
export const NATIVE_DEPENDENCIES = ['MesenCore', 'libSkiaSharp', 'libHarfBuzzSharp'];

/** Library extensions tried for each native dependency, current platform first. */
export const NATIVE_EXTENSIONS = process.platform === 'win32'
  ? ['.dll', '.so', '.dylib']
  : process.platform === 'darwin' ? ['.dylib', '.so', '.dll'] : ['.so', '.dylib', '.dll'];

export const SETTINGS_FILE = 'settings.json';
export const PORTABLE_HOME_FOLDER = '.';
export const DOCUMENTS_HOME_FOLDER = 'MesenCE';
export const LEGACY_DOCUMENTS_HOME_FOLDER = 'Mesen2';

/** Controller device written into an unconfigured NES port. */
export const DEFAULT_DEVICE = 'NesController';

/** Ports a two-player NES session needs before `set_input` can address them. */
export const DEFAULT_PORTS = ['Port1', 'Port2'];

/**
 * Which profile folder Mesen will use, mirroring `ConfigManager.HomeFolder`.
 *
 * A `settings.json` next to the executable makes the install portable and wins
 * over the documents folder. Otherwise the documents folder named after the
 * emulator is used, unless only the legacy folder carries settings.
 */
export function resolveHomeFolder({ exeDir, documentsDir }) {
  if (!exeDir) {
    throw new Error('resolveHomeFolder needs an executable directory');
  }
  if (existsSync(join(exeDir, SETTINGS_FILE))) {
    return { path: exeDir, portable: true, reason: 'settings.json beside the executable' };
  }

  const primary = documentsDir ? join(documentsDir, DOCUMENTS_HOME_FOLDER) : null;
  const legacy = documentsDir ? join(documentsDir, LEGACY_DOCUMENTS_HOME_FOLDER) : null;
  const primarySettings = primary ? existsSync(join(primary, SETTINGS_FILE)) : false;
  const legacySettings = legacy ? existsSync(join(legacy, SETTINGS_FILE)) : false;

  if (!legacySettings || primarySettings) {
    return {
      path: primary,
      portable: false,
      reason: legacySettings ? 'legacy folder has no settings' : 'documents folder',
    };
  }
  return { path: legacy, portable: false, reason: 'legacy documents folder carries settings' };
}

/** Native libraries present in a home folder, with the resolved file per dependency. */
export function inspectNativeDependencies(homeFolder) {
  const found = [];
  const missing = [];
  for (const name of NATIVE_DEPENDENCIES) {
    const match = NATIVE_EXTENSIONS.map(extension => join(homeFolder, name + extension)).find(candidate => existsSync(candidate));
    if (match) {
      found.push({ name, path: match });
    } else {
      missing.push(name);
    }
  }
  return { found, missing, complete: missing.length === 0 };
}

/** Read a settings file without assuming it parses. */
export function readSettings(homeFolder) {
  const path = homeFolder ? join(homeFolder, SETTINGS_FILE) : null;
  if (!path || !existsSync(path)) {
    return { path, exists: false, data: null, parseError: null };
  }
  const raw = readFileSync(path, 'utf8');
  // The emulator writes its settings with a byte-order mark and reads them back
  // with BOM detection, so a strict JSON parser needs the mark removed first.
  const text = raw.replace(/^\uFEFF/, '');
  try {
    const data = JSON.parse(text);
    return { path, exists: true, data, parseError: null, bytes: raw.length, bom: raw.length !== text.length };
  } catch (error) {
    return { path, exists: true, data: null, parseError: error.message, bytes: raw.length, bom: raw.length !== text.length };
  }
}

/**
 * Fill in controller ports that a first-run wizard would have configured.
 *
 * A settings file written by hand only carries what it lists, so every port
 * stays at `None` and the bridge rejects `set_input` with "Controller 0 is not
 * available". Only `None` and absent ports are replaced; a configured device is
 * left alone. Returns a new object and the list of changes.
 */
export function patchInputPorts(settings, { ports = DEFAULT_PORTS, device = DEFAULT_DEVICE } = {}) {
  const next = structuredClone(settings ?? {});
  next.Nes = next.Nes ?? {};
  const changes = [];

  for (const port of ports) {
    const current = next.Nes[port];
    const from = current && typeof current === 'object' ? current.Type ?? null : null;
    if (from !== null && from !== 'None') {
      continue;
    }
    next.Nes[port] = { ...(current && typeof current === 'object' ? current : {}), Type: device };
    changes.push({ port, from: from ?? 'absent', to: device });
  }

  return { settings: next, changes };
}

/** Controller ports as the bridge will see them. */
export function describeInputPorts(settings) {
  const nes = settings?.Nes ?? {};
  const ports = DEFAULT_PORTS.map((port) => {
    const type = nes[port]?.Type ?? null;
    return { port, device: type, configured: Boolean(type) && type !== 'None' };
  });
  return { ports, ready: ports.every(port => port.configured) };
}

/** Command line that opens a ROM in the emulator. Quoting is for PowerShell and cmd. */
export function describeLaunchCommand({ exePath, romPath }) {
  if (!exePath) {
    return null;
  }
  const parts = [`"${exePath}"`];
  if (romPath) {
    parts.push(`"${romPath}"`);
  }
  return parts.join(' ');
}

/**
 * Make an install startable and input-capable.
 *
 * Writes the settings file Mesen needs to start without the first-run wizard,
 * leaves every other setting untouched, and copies native libraries into a
 * documents-folder profile when that is the profile in use. Choosing the
 * portable profile is the default because it keeps the install self-contained
 * and needs no copies.
 */
export function provisionEmulator({
  exeDir,
  documentsDir,
  romPath = null,
  portable = true,
  ports = DEFAULT_PORTS,
  device = DEFAULT_DEVICE,
  copyNative = true,
} = {}) {
  if (!exeDir || !existsSync(exeDir)) {
    return { ok: false, reason: 'the emulator directory does not exist', exeDir, homeFolder: null };
  }

  const settingsPath = join(exeDir, SETTINGS_FILE);
  const homeFolder = portable ? exeDir : join(documentsDir ?? dirname(exeDir), DOCUMENTS_HOME_FOLDER);
  if (!existsSync(homeFolder)) {
    mkdirSync(homeFolder, { recursive: true });
  }

  const portableSettings = portable ? settingsPath : join(homeFolder, SETTINGS_FILE);
  const existing = readSettings(portable ? exeDir : homeFolder);
  const before = existing.data ?? {};
  const { settings, changes } = patchInputPorts(before, { ports, device });
  writeFileSync(portableSettings, JSON.stringify(settings), 'utf8');

  const copied = [];
  if (copyNative) {
    for (const name of NATIVE_DEPENDENCIES) {
      const target = NATIVE_EXTENSIONS.map(extension => join(homeFolder, name + extension))
        .find(candidate => existsSync(candidate));
      if (target) {
        continue;
      }
      const source = NATIVE_EXTENSIONS.map(extension => join(exeDir, name + extension))
        .find(candidate => existsSync(candidate));
      if (source) {
        copyFileSync(source, join(homeFolder, name + (source.endsWith('.dylib') ? '.dylib' : source.slice(source.lastIndexOf('.')))));
        copied.push(name);
      }
    }
  }

  const native = inspectNativeDependencies(homeFolder);
  const written = readSettings(portable ? exeDir : homeFolder);
  return {
    ok: native.complete,
    exeDir,
    homeFolder,
    portable,
    settingsPath: portableSettings,
    settingsExisted: existing.exists,
    settingsParsed: existing.parseError === null,
    parseError: existing.parseError,
    portChanges: changes,
    ports: describeInputPorts(written.data ?? settings),
    copiedNative: copied,
    missingNative: native.missing,
    launchCommand: describeLaunchCommand({ exePath: join(exeDir, 'Mesen.exe'), romPath }),
  };
}
