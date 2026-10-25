#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { heading, parseArgs, status } from './lib/cli.mjs';
import { displayPath, relativePath } from './lib/config.mjs';
import {
  DEFAULT_DEVICE,
  describeInputPorts,
  describeLaunchCommand,
  inspectNativeDependencies,
  provisionEmulator,
  readSettings,
  resolveHomeFolder,
} from './lib/emulator.mjs';
import { callBridgeTools, resultText } from './lib/mcp.mjs';
import { locateTools } from './lib/tools.mjs';

/**
 * Emulator initialisation for a MesenGM install.
 *
 * `inspect` reports the facts that decide whether the emulator will start and
 * whether the bridge can send input: profile folder, settings file, native
 * libraries and controller ports. `provision` writes the settings file and
 * copies what is missing, so a clean machine reaches a launchable, input-capable
 * emulator without opening the first-run wizard by hand.
 *
 * The handshake is not part of this check: `verify.mjs` already proves the
 * bridge answers while the emulator is closed.
 */

const args = parseArgs(process.argv.slice(2));
const action = args.positional[0] ?? 'inspect';
const json = args.flag('json');
const rom = args.get('rom');
const live = args.flag('live');
const timeoutMs = Number.parseInt(args.get('timeout', '30000'), 10);
const emulatorDir = args.get('mesen-dir') ?? null;

const tools = locateTools({ mesenDir: emulatorDir, benchDir: args.get('bench-dir') });

if (action === 'inspect') {
  inspect();
} else if (action === 'provision') {
  provision();
} else {
  console.error(`unknown action: ${action}`);
  console.error('usage: node scripts/emulator.mjs <inspect|provision> [--mesen-dir <dir>] [--rom <rom>] [--no-portable] [--live] [--json]');
  process.exit(1);
}

// ---------------------------------------------------------------- inspect

function inspect() {
  const report = collect();
  const exitCode = !report.emulator ? 1 : report.ok ? 0 : 2;

  if (json) {
    console.log(JSON.stringify({ ...report, exitCode }, null, 2));
    process.exit(exitCode);
  }

  heading('模拟器初始化');
  if (!report.emulator) {
    status('fail', 'Mesen.exe', '未定位到；先跑 node scripts/setup.mjs 或 --mesen-dir 指向已有安装');
    console.log('\n没有模拟器可执行文件时，桥的握手仍然能通过：握手只证明桥在应答，不证明模拟器能启动。');
    process.exit(exitCode);
  }
  status('ok', 'Mesen.exe', relativePath(report.emulator));
  status(report.home && report.home.path ? 'ok' : 'warn', 'profile 目录',
    report.home ? `${displayPath(report.home.path)}（${report.home.portable ? '便携' : '文档目录'}：${report.home.reason}）` : '无法判定');
  status(report.settings.exists ? 'ok' : 'warn', 'settings.json',
    report.settings.exists
      ? `${report.settings.bytes ?? 0} 字节${report.settings.parseError ? '，但解析失败：' + report.settings.parseError : ''}`
      : '缺失：首次启动会进入配置向导，向导前就可能因原生库缺失直接退出');
  status(report.native.complete ? 'ok' : 'fail', '原生库',
    report.native.complete
      ? `齐全（${report.native.found.map(entry => entry.name).join(', ')}）`
      : `缺 ${report.native.missing.join(', ')}：Mesen 只从 profile 目录加载这些库，缺一个就起不来`);
  status(report.ports.ready ? 'ok' : 'warn', '手柄端口',
    report.ports.ready
      ? report.ports.ports.map(entry => `${entry.port}=${entry.device}`).join('，')
      : `${report.ports.ports.map(entry => `${entry.port}=${entry.device ?? '缺失'}`).join('，')}；端口为 None 时 set_input 会被桥拒绝`);
  if (report.launchCommand) {
    status('info', '启动命令', report.launchCommand);
  }

  if (report.live) {
    heading('实时探测');
    if (report.live.error) {
      status('warn', 'clear_input', report.live.error);
    } else {
      status(report.live.available.length > 0 ? 'ok' : 'warn', 'available_controllers',
        JSON.stringify(report.live.available));
    }
  }

  heading('结论');
  if (exitCode === 0) {
    status('ok', 'ready', '模拟器可以启动，桥可以送按键');
  } else if (exitCode === 2) {
    status('warn', 'degraded', '模拟器可能起不来或收不到按键；按下面的下一步补');
    status('info', 'next', 'node scripts/rea-fc.mjs emulator provision');
  } else {
    status('fail', 'missing', '没有模拟器可执行文件');
    status('info', 'next', 'node scripts/setup.mjs');
  }
  process.exit(exitCode);
}

// ---------------------------------------------------------------- provision

function provision() {
  if (!emulatorExeDir()) {
    console.error('Mesen.exe 未定位到：先跑 node scripts/setup.mjs，或用 --mesen-dir 指向已有安装');
    process.exit(1);
  }
  const exeDir = emulatorExeDir();
  const documentsDir = join(homedir(), 'Documents');
  const result = provisionEmulator({
    exeDir,
    documentsDir,
    romPath: rom ?? null,
    portable: !args.flag('no-portable'),
    device: args.get('device', DEFAULT_DEVICE),
  });

  if (json) {
    console.log(JSON.stringify({ ...result, settingsPath: displayPath(result.settingsPath ?? ''), homeFolder: displayPath(result.homeFolder ?? '') }, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  heading('模拟器初始化：写入');
  status('ok', 'profile 目录', `${displayPath(result.homeFolder)}（${result.portable ? '便携' : '文档目录'}）`);
  status(result.settingsExisted ? 'ok' : 'info', 'settings.json',
    result.settingsExisted
      ? '已存在，按原内容合并后写回'
      : '原本缺失：已写入最小配置，跳过首次运行向导');
  if (!result.settingsParsed) {
    status('warn', '原配置解析失败', `${result.parseError}；已用最小配置覆盖，旧文件内容不再保留`);
  }
  if (result.portChanges.length === 0) {
    status('ok', '手柄端口', '已配置，未改动');
  } else {
    status('ok', '手柄端口', result.portChanges.map(change => `${change.port}: ${change.from} → ${change.to}`).join('，'));
  }
  if (result.copiedNative.length > 0) {
    status('ok', '原生库', `从可执行目录补入 ${result.copiedNative.join(', ')}`);
  }
  if (result.missingNative.length > 0) {
    status('fail', '原生库', `仍缺 ${result.missingNative.join(', ')}：可执行目录也没有这些库；重新构建工具后再跑一次本命令`);
  }

  heading('下一步');
  status('info', '1', `启动：${result.launchCommand}`);
  status('info', '2', 'node scripts/rea-fc.mjs verify --live --rom <rom>');
  status('info', '3', 'node scripts/rea-fc.mjs doctor --live');
  process.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------- helpers

function collect() {
  const emulator = tools.mesen.emulator;
  if (!emulator) {
    return { emulator: null, home: null, settings: { exists: false }, native: { complete: false, missing: [], found: [] }, ports: { ready: false, ports: [] }, launchCommand: null, ok: false, live: null };
  }

  const exeDir = dirname(emulator);
  const home = resolveHomeFolder({ exeDir, documentsDir: join(homedir(), 'Documents') });
  const settings = readSettings(home.path);
  const native = inspectNativeDependencies(home.path);
  const ports = describeInputPorts(settings.data ?? {});
  const launchCommand = describeLaunchCommand({ exePath: emulator, romPath: rom ? resolve(rom) : null });
  const ok = settings.exists && !settings.parseError && native.complete && ports.ready;

  const report = { emulator, home, settings: { exists: settings.exists, bytes: settings.bytes ?? 0, parseError: settings.parseError }, native, ports, launchCommand, ok, live: null };
  if (live) {
    report.live = probeControllers();
  }
  return report;
}

function probeControllers() {
  const bridge = tools.mesen.bridge;
  if (!bridge) {
    return { error: '没有桥可执行文件', available: [] };
  }
  try {
    const result = callBridgeTools({
      command: bridge,
      calls: [{ name: 'clear_input', arguments: { controller: 0 } }],
      timeoutMs: Math.max(timeoutMs, 30_000),
    });
    const entry = result.results[0];
    if (!entry?.ok) {
      return { error: JSON.stringify(entry?.error ?? {}) , available: [] };
    }
    const payload = parseJson(entry.result);
    return { available: Array.isArray(payload?.available_controllers) ? payload.available_controllers : [] };
  } catch (error) {
    return { error: error.message, available: [] };
  }
}

function emulatorExeDir() {
  return tools.mesen.emulator ? dirname(tools.mesen.emulator) : null;
}

function parseJson(result) {
  try {
    return JSON.parse(resultText(result));
  } catch {
    return null;
  }
}
