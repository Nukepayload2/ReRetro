#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { heading, parseArgs, rows, status } from './lib/cli.mjs';
import { checkNodeVersion, displayPath, paths, readPins, relativePath } from './lib/config.mjs';
import {
  describeInputPorts,
  inspectNativeDependencies,
  readSettings,
  resolveHomeFolder,
} from './lib/emulator.mjs';
import { callBridgeTools, compareTools, readToolSurface, resultText } from './lib/mcp.mjs';
import { detectBuildTools, locateTools, submoduleState } from './lib/tools.mjs';

/**
 * Diagnostic flow for the Mesen bridge.
 *
 * `verify.mjs` answers one question: is the kit ready? This command answers the
 * follow-up — if it is not, where does it break and what should be done next?
 * It walks the same layers in order (runtime, repository, toolchain, binaries,
 * emulator profile, tool-list cache, handshake, optional live probe) and stops
 * giving advice at the first layer that needs a human action.
 *
 * The emulator layer exists because a green handshake is answered by the bridge
 * alone: it stays green while the emulator itself cannot start, and while its
 * controller ports are unconfigured and reject every `set_input`.
 */

const args = parseArgs(process.argv.slice(2));
const json = args.flag('json');
const live = args.flag('live');
const rom = args.get('rom');
const timeoutMs = Number.parseInt(args.get('timeout', '30000'), 10);

const steps = [];

step('runtime', '运行时', checkRuntime);
step('repository', '仓库与 submodule', checkRepository);
const tools = locateTools({ mesenDir: args.get('mesen-dir'), benchDir: args.get('bench-dir') });
step('binaries', '工具二进制', () => checkBinaries(tools));
step('emulator', '模拟器初始化', () => checkEmulator(tools));
step('toolchain', '构建工具链', checkToolchain);
step('tool-cache', 'Mesen 工具列表缓存', checkToolCache);
const surface = step('handshake', '桥握手', () => checkHandshake(tools));
if (surface?.data?.ok && (live || rom)) {
  const liveStep = step('live', '实时探测', () => checkLive(tools, surface.data.tools));
  if (liveStep?.data?.input) {
    step('input', '输入端口（实时）', () => checkInput(liveStep.data.input));
  }
}

finish();

// ---------------------------------------------------------------- steps

function checkRuntime() {
  const node = checkNodeVersion();
  return {
    status: node.ok ? 'ok' : 'fail',
    detail: `Node ${node.version}（要求 ${node.required}），${process.platform}`,
    remedy: node.ok ? null : `升级 Node 到 ${node.required}`,
    data: node,
  };
}

function checkRepository() {
  const pins = readPins();
  const state = submoduleState();
  const rowsOut = pins.submodules.map((pin) => {
    const observed = state.rows.find(row => row.path.replace(/\\/g, '/') === pin.path);
    return {
      path: pin.path,
      pinned: pin.commit,
      observed: observed?.commit ?? null,
      present: existsSync(join(paths.root, pin.path)),
      matches: observed ? observed.commit === pin.commit : false,
      state: observed?.state ?? 'missing',
    };
  });

  const missing = rowsOut.filter(row => !row.present);
  const drifted = rowsOut.filter(row => row.present && !row.matches);
  const healthy = missing.length === 0 && drifted.length === 0;

  const detail = healthy
    ? `两个 submodule 都在 pin 上（source: ${state.source === 'git' ? 'git' : 'pins.json'}）`
    : missing.length > 0
      ? `缺少检出：${missing.map(row => row.path).join(', ')}`
      : `与 pin 不一致：${drifted.map(row => row.path).join(', ')}`;

  return {
    status: healthy ? 'ok' : 'fail',
    detail,
    remedy: healthy ? null : 'git submodule update --init --recursive，然后 node scripts/rea-fc.mjs pins',
    data: { rows: rowsOut },
  };
}

function checkBinaries(located) {
  const bridge = located.mesen.bridge;
  const emulator = located.mesen.emulator;
  const sourcegen = located.bench.exe;

  if (!bridge) {
    return {
      status: 'fail',
      detail: 'MCPServer.exe 未找到',
      remedy: 'node scripts/setup.mjs（或 --mesen-dir / REA_FC_MESEN_DIR 指向已有安装）',
      data: located,
    };
  }

  const missing = [];
  if (!emulator) {
    missing.push('Mesen.exe');
  }
  if (!sourcegen) {
    missing.push('SourceGen.exe');
  }

  return {
    status: missing.length === 0 ? 'ok' : 'warn',
    detail: `桥 ${relativePath(bridge)}（${located.mesen.source}）` +
      (missing.length === 0 ? '' : `；缺少 ${missing.join(' / ')}`),
    remedy: missing.length === 0 ? null : 'node scripts/setup.mjs 补齐缺失的工具；只缺 SourceGen 时静态侧不可用',
    data: located,
  };
}

function checkEmulator(located) {
  const emulator = located.mesen.emulator;
  if (!emulator) {
    return {
      status: 'warn',
      detail: 'Mesen.exe 未定位到：桥能应答，但没有模拟器可启动',
      remedy: 'node scripts/setup.mjs（或 --mesen-dir / REA_FC_MESEN_DIR 指向已有安装）',
      data: null,
    };
  }

  const exeDir = dirname(emulator);
  const home = resolveHomeFolder({ exeDir, documentsDir: join(homedir(), 'Documents') });
  const settings = readSettings(home.path);
  const native = inspectNativeDependencies(home.path);
  const ports = describeInputPorts(settings.data ?? {});

  const problems = [];
  if (!settings.exists) {
    problems.push('没有 settings.json，首次启动会先进配置向导');
  } else if (settings.parseError) {
    problems.push(`settings.json 解析失败：${settings.parseError}`);
  }
  if (!native.complete) {
    problems.push(`缺原生库 ${native.missing.join(', ')}，模拟器会在启动阶段直接退出`);
  }
  if (!ports.ready) {
    problems.push(`手柄端口未配置（${ports.ports.filter(port => !port.configured).map(port => port.port).join(', ')}），set_input 会被拒绝`);
  }

  return {
    status: problems.length === 0 ? 'ok' : 'warn',
    detail: problems.length === 0
      ? `profile ${displayPath(home.path)}（${home.portable ? '便携' : '文档目录'}），原生库齐全，${ports.ports.map(port => `${port.port}=${port.device}`).join('，')}`
      : `${problems.join('；')}`,
    remedy: problems.length === 0 ? null : 'node scripts/rea-fc.mjs emulator provision，然后重启 Mesen 再重跑',
    data: {
      exeDir: displayPath(exeDir),
      homeFolder: displayPath(home.path),
      portable: home.portable,
      settings: { exists: settings.exists, bytes: settings.bytes ?? 0, parseError: settings.parseError },
      native,
      ports,
    },
  };
}

function checkToolchain() {
  const toolchain = detectBuildTools();
  const ready = Boolean(toolchain.msbuild) && toolchain.dotnet.available && toolchain.netFramework481;
  return {
    status: ready ? 'ok' : 'warn',
    detail: [
      `MSBuild ${toolchain.msbuild ? '有' : '无'}`,
      `dotnet ${toolchain.dotnet.version || '无'}`,
      `.NET Framework 4.8.1 ${toolchain.netFramework481 ? '有' : '无'}`,
    ].join('，'),
    remedy: ready ? null : '安装 Visual Studio 的 C++ 工作负载、.NET 10 SDK 与 .NET Framework 4.8.1 targeting pack，再跑 setup',
    data: toolchain,
  };
}

function checkToolCache() {
  if (process.platform !== 'win32') {
    return { status: 'info', detail: '非 Windows，Mesen 桥不可用', remedy: '在 Windows x64 上运行', data: null };
  }
  const base = process.env.LOCALAPPDATA;
  if (!base) {
    return { status: 'info', detail: 'LOCALAPPDATA 不可读', remedy: '确认用户环境变量', data: null };
  }
  const cachePath = join(base, 'Mesen2', 'mcp-tools.cache.json');
  const present = existsSync(cachePath);
  return {
    status: present ? 'ok' : 'warn',
    detail: present ? '已存在，桥可在 Mesen 未运行时回答 tools/list' : '尚未生成，首次 tools/list 会报「Mesen is not running」',
    remedy: present ? null : '打开一次 Mesen（可以只到主界面），让桥写出工具列表缓存，然后重跑本命令',
    data: { path: cachePath, present },
  };
}

function checkHandshake(located) {
  const bridge = located.mesen.bridge;
  if (!bridge) {
    return { status: 'fail', detail: '跳过：没有桥可执行文件', remedy: '先修复「工具二进制」一层', data: { ok: false } };
  }

  try {
    const surface = readToolSurface({ command: bridge, timeoutMs });
    const comparison = compareTools(surface.tools);
    return {
      status: comparison.ok ? 'ok' : 'fail',
      detail: `${surface.server?.name ?? '未知桥'} ${surface.server?.version ?? ''}：${surface.tools.length} 个工具` +
        `（核心 ${comparison.present.length}/${comparison.present.length + comparison.missing.length}）` +
        (comparison.optionalPresent.length ? `，可选 ${comparison.optionalPresent.join(', ')}` : '') +
        (comparison.missing.length ? `，缺 ${comparison.missing.join(', ')}` : ''),
      remedy: comparison.ok ? null : '连的可能是旧二进制：重新构建 MesenGM，并核对 pins.json',
      data: { ok: comparison.ok, tools: surface.tools, comparison, server: surface.server },
    };
  } catch (error) {
    const details = JSON.stringify(error.details ?? {});
    if (/Mesen is not running|mesen-unavailable/.test(details + error.message)) {
      return {
        status: 'warn',
        detail: 'tools/list 未应答：本机还没有 Mesen 写出的工具缓存',
        remedy: '打开一次 Mesen，让缓存生成，然后重跑；不需要重建桥',
        data: { ok: false, reason: 'tool-list-cache-missing' },
      };
    }
    if (/no answer to .* within/.test(error.message)) {
      return {
        status: 'warn',
        detail: `握手超时（${error.message}）`,
        remedy: 'Mesen 可能停在自己的调试器或模态窗口：恢复执行、关对话框，然后重试',
        data: { ok: false, reason: 'timeout' },
      };
    }
    return {
      status: 'fail',
      detail: error.message,
      remedy: 'node scripts/setup.mjs 重新构建；仍失败时把 out/environment.json 与本次输出一起提供',
      data: { ok: false, reason: error.message },
    };
  }
}

function checkLive(located, toolList) {
  const bridge = located.mesen.bridge;
  const available = new Set(toolList.map(tool => tool.name));
  const calls = [];
  if (rom && available.has('load_rom')) {
    calls.push({ name: 'load_rom', arguments: { path: rom } });
  }
  calls.push({ name: 'get_rom_info', arguments: {} });
  calls.push({ name: 'debugger_status', arguments: {} });
  // Asking the bridge to release controller 0 is a no-op for game state and
  // returns the controller list, which is the only proof that input can be sent.
  calls.push({ name: 'clear_input', arguments: { controller: 0 } });

  try {
    const result = callBridgeTools({ command: bridge, calls, timeoutMs: Math.max(timeoutMs, 60_000) });
    const romInfo = parseJson(result.results.find(entry => entry.name === 'get_rom_info')?.result);
    const loaded = romInfo && romInfo.format && romInfo.format !== 'Unknown';
    const inputResult = result.results.find(entry => entry.name === 'clear_input');
    const inputPayload = parseJson(inputResult?.result);
    const input = {
      ok: Boolean(inputResult?.ok),
      available: Array.isArray(inputPayload?.available_controllers) ? inputPayload.available_controllers : [],
      error: inputResult?.ok ? null : JSON.stringify(inputResult?.error ?? {}).slice(0, 200),
    };
    const failures = result.results.filter(entry => !entry.ok && entry.name !== 'clear_input');
    const mesenDown = result.results.some(entry => /Mesen is not running/i.test(JSON.stringify(entry.error ?? {})));

    if (mesenDown) {
      return {
        status: 'warn',
        detail: 'Mesen 没有运行',
        remedy: '按 docs/emulator-init.md 启动 Mesen 并载入目标 ROM，然后用 --live --rom <rom> 重跑',
        data: { loaded: false, results: result.results, input },
      };
    }

    return {
      status: failures.length === 0 ? 'ok' : 'warn',
      detail: loaded
        ? `ROM ${romInfo.rom_path}（${romInfo.format}），${result.results.length} 个调用均成功`
        : 'Mesen 在运行但没有载入 ROM',
      remedy: loaded ? null : '在 Mesen 里载入目标 ROM，或加 --rom <rom> 让 load_rom 载入',
      data: { loaded, rom: romInfo, results: result.results, input },
    };
  } catch (error) {
    return {
      status: 'warn',
      detail: error.message,
      remedy: '先看「桥握手」一层；实时探测依赖同一个桥',
      data: null,
    };
  }
}

function checkInput(input) {
  const available = Array.isArray(input.available) ? input.available : [];
  return {
    status: available.length > 0 ? 'ok' : 'warn',
    detail: available.length > 0
      ? `available_controllers ${JSON.stringify(available)}`
      : `available_controllers 为空${input.error ? `（${input.error}）` : ''}：桥会拒绝 set_input`,
    remedy: available.length > 0 ? null : 'node scripts/rea-fc.mjs emulator provision 配置 Nes.Port1，重启 Mesen 后重跑',
    data: input,
  };
}

function parseJson(result) {
  if (!result) {
    return null;
  }
  try {
    return JSON.parse(resultText(result));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- plumbing

function step(id, title, run) {
  const result = run();
  const entry = { id, title, ...result };
  steps.push(entry);
  return entry;
}

function finish() {
  const failed = steps.filter(entry => entry.status === 'fail');
  const warned = steps.filter(entry => entry.status === 'warn');
  const exitCode = failed.length > 0 ? 1 : warned.length > 0 ? 2 : 0;
  const nextActions = steps.filter(entry => entry.remedy).map(entry => ({ step: entry.id, action: entry.remedy }));
  const verdict = exitCode === 0 ? 'ready' : exitCode === 2 ? 'degraded' : 'broken';

  if (json) {
    console.log(JSON.stringify({ ok: exitCode === 0, exitCode, verdict, steps, nextActions }, null, 2));
    process.exit(exitCode);
  }

  heading('诊断');
  for (const entry of steps) {
    status(entry.status === 'ok' ? 'ok' : entry.status === 'warn' ? 'warn' : entry.status === 'fail' ? 'fail' : 'info',
      entry.title, entry.detail);
  }

  heading('证据');
  rows([
    ['Node', process.versions.node],
    ['仓库', relativePath(paths.root)],
    ['桥', tools.mesen.bridge ? relativePath(tools.mesen.bridge) : '缺失'],
    ['模拟器', tools.mesen.emulator ? relativePath(tools.mesen.emulator) : '缺失'],
    ['SourceGen', tools.bench.exe ? relativePath(tools.bench.exe) : '缺失'],
  ]);

  heading('结论');
  status(verdict === 'ready' ? 'ok' : verdict === 'degraded' ? 'warn' : 'fail', verdict,
    verdict === 'ready' ? '各层都通过，可以开始取证'
      : verdict === 'degraded' ? '仓库本身没问题，缺的是环境或一次 Mesen 启动'
        : '有需要人处理的问题，按下面的下一步修');

  if (nextActions.length > 0) {
    heading('下一步');
    for (const action of nextActions) {
      console.log(`  - [${action.step}] ${action.action}`);
    }
  }

  process.exit(exitCode);
}
