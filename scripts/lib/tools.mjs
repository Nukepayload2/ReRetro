import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths, readPins } from './config.mjs';
import { git, run } from './process.mjs';

const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

/**
 * Windows build prerequisites for the two tool repositories.
 *
 * Mesen needs MSBuild with the C++ toolset and the .NET 10 SDK (the UI project
 * targets net10.0). 6502bench's SourceGen is a .NET Framework 4.8.1 WPF
 * application, so it needs MSBuild plus that targeting pack.
 */
export function detectBuildTools() {
  const msbuild = findMsBuild();
  const dotnet = run('dotnet', ['--version'], { timeoutMs: 30_000 });
  const targetingPack = existsSync('C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.8.1');
  return {
    msbuild,
    dotnet: {
      available: dotnet.ok,
      version: dotnet.stdout.trim(),
    },
    netFramework481: targetingPack,
  };
}

function findMsBuild() {
  const candidates = [];
  if (existsSync(VSWHERE)) {
    const found = run(VSWHERE, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.Component.MSBuild',
      '-find',
      'MSBuild\\**\\Bin\\MSBuild.exe',
    ], { timeoutMs: 30_000 });
    for (const line of found.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        candidates.push(trimmed);
      }
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Locate the two tools without building anything.
 *
 * Order: explicit option, environment override, the submodule build output,
 * then a conventional install location. The `source` field matters for reports:
 * a binary in an install directory is not the same evidence as one this repo
 * just built.
 */
export function locateTools({ mesenDir, benchDir } = {}) {
  return {
    mesen: locateMesen(mesenDir),
    bench: locateBench(benchDir),
    driver: locateDriver(),
  };
}

/**
 * Locate the headless 6502bench driver.
 *
 * It is built from this repository against the pinned 6502bench projects, so it only
 * exists after `setup.mjs` has run; `sourcegen.mjs` names the remedy when it is absent.
 */
function locateDriver() {
  const candidates = [
    { path: join(paths.root, 'tools', 'SourceGenCli', 'bin', 'Release', 'SourceGenCli.exe'), source: 'repo-build' },
    { path: join(paths.out, 'SourceGenCli', 'SourceGenCli.exe'), source: 'out' },
    { path: process.env.REA_FC_DRIVER ?? '', source: 'environment' },
  ];
  for (const candidate of candidates) {
    if (candidate.path && existsSync(candidate.path)) {
      return { exe: candidate.path, source: candidate.source };
    }
  }
  return { exe: null, source: null };
}

function locateMesen(mesenDir) {
  const candidates = [];
  if (mesenDir) {
    candidates.push({ dir: mesenDir, source: 'option' });
  }
  if (process.env.REA_FC_MESEN_DIR) {
    candidates.push({ dir: process.env.REA_FC_MESEN_DIR, source: 'environment' });
  }
  candidates.push({ dir: join(paths.mesen, 'bin', 'win-x64', 'Release'), source: 'submodule-build' });
  candidates.push({ dir: join(paths.mesen, 'bin', 'win-x64', 'Debug'), source: 'submodule-build' });
  candidates.push({ dir: 'C:\\Program Files\\MesenGM', source: 'install' });

  for (const candidate of candidates) {
    const bridge = join(candidate.dir, 'MCPServer.exe');
    const emulator = join(candidate.dir, 'Mesen.exe');
    if (existsSync(bridge)) {
      return {
        dir: candidate.dir,
        source: candidate.source,
        bridge,
        emulator: existsSync(emulator) ? emulator : null,
      };
    }
  }
  return { dir: null, source: null, bridge: null, emulator: null };
}

function locateBench(benchDir) {
  const candidates = [];
  if (benchDir) {
    candidates.push({ dir: benchDir, source: 'option' });
  }
  if (process.env.REA_FC_BENCH_DIR) {
    candidates.push({ dir: process.env.REA_FC_BENCH_DIR, source: 'environment' });
  }
  candidates.push({ dir: join(paths.bench, 'SourceGen', 'bin', 'Release'), source: 'submodule-build' });
  candidates.push({ dir: join(paths.bench, 'SourceGen', 'bin', 'Debug'), source: 'submodule-build' });
  candidates.push({ dir: 'C:\\Program Files\\6502bench', source: 'install' });

  for (const candidate of candidates) {
    const exe = join(candidate.dir, 'SourceGen.exe');
    if (existsSync(exe)) {
      return { dir: candidate.dir, source: candidate.source, exe };
    }
  }
  return { dir: null, source: null, exe: null };
}

/** Command lines that build each tool from its submodule checkout. */
export function buildCommands(buildTools) {
  const msbuild = buildTools.msbuild ?? 'msbuild';
  return [
    {
      name: 'MesenGM',
      cwd: paths.mesen,
      steps: [
        // The UI project is SDK-style with PackageReference; restore produces
        // obj/project.assets.json, which MSBuild alone does not create here.
        { command: 'dotnet', args: ['restore', join('UI', 'UI.csproj')] },
        { command: msbuild, args: ['Mesen.sln', '/m', '/nologo', '/v:minimal', '/p:Configuration=Release', '/p:Platform=x64'] },
      ],
      outputs: [
        join(paths.mesen, 'bin', 'win-x64', 'Release', 'MCPServer.exe'),
        join(paths.mesen, 'bin', 'win-x64', 'Release', 'Mesen.exe'),
      ],
      requires: () => buildTools.msbuild !== null && buildTools.dotnet.available,
      missingRequirement: 'MSBuild with the C++ toolset and the .NET SDK are required to build Mesen',
    },
    {
      name: '6502bench',
      cwd: paths.bench,
      steps: [
        // SourceGen's SDK-style projects (Asm65, CommonUtil, PluginCommon) need
        // their restore assets before MSBuild can resolve them.
        { command: 'dotnet', args: ['restore', 'WorkBench.sln'] },
        { command: msbuild, args: ['WorkBench.sln', '/m', '/nologo', '/v:minimal', '/p:Configuration=Release', '/p:Platform=Any CPU'] },
      ],
      outputs: [join(paths.bench, 'SourceGen', 'bin', 'Release', 'SourceGen.exe')],
      requires: () => buildTools.msbuild !== null && buildTools.netFramework481 && buildTools.dotnet.available,
      missingRequirement: 'MSBuild with the .NET Framework 4.8.1 targeting pack and the .NET SDK are required to build SourceGen',
    },
    {
      // Console driver over the pinned analysis: the only entry point an agent can call.
      // It references SourceGen/Asm65/CommonUtil projects, so those build first.
      name: 'SourceGenCli',
      cwd: paths.root,
      steps: [
        { command: msbuild, args: [join('tools', 'SourceGenCli', 'SourceGenCli.csproj'), '/nologo', '/v:minimal', '/p:Configuration=Release', '/p:Platform=AnyCPU'] },
      ],
      outputs: [join(paths.root, 'tools', 'SourceGenCli', 'bin', 'Release', 'SourceGenCli.exe')],
      requires: () => buildTools.msbuild !== null && buildTools.netFramework481,
      missingRequirement: 'MSBuild with the .NET Framework 4.8.1 targeting pack is required to build the SourceGen driver',
    },
  ];
}

/** Run a build target's steps and report the outcome without throwing. */
export function buildTarget(target, { timeoutMs = 30 * 60_000 } = {}) {
  const steps = [];
  for (const step of target.steps) {
    const result = run(step.command, step.args, { cwd: target.cwd, timeoutMs });
    steps.push({
      command: [step.command, ...step.args].join(' '),
      status: result.status,
      timedOut: result.timedOut,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
    });
    if (!result.ok) {
      break;
    }
  }

  const outputs = target.outputs.map(output => ({ path: output, exists: existsSync(output) }));
  const ok = steps.every(step => step.status === 0) && outputs.every(output => output.exists);
  return {
    name: target.name,
    ok,
    steps,
    outputs,
    command: steps.map(step => step.command).join(' && '),
    status: steps.at(-1)?.status ?? null,
    timedOut: steps.some(step => step.timedOut),
    stdoutTail: steps.at(-1)?.stdoutTail ?? '',
    stderrTail: steps.at(-1)?.stderrTail ?? '',
  };
}

function tail(text, lines = 20) {
  if (!text) {
    return '';
  }
  return text.split(/\r?\n/).slice(-lines).join('\n');
}

/**
 * Read submodule state without `git submodule status`.
 *
 * That command is avoided on purpose: it can block on hosts that hold locks or
 * restrict child-process pipes. The gitlink recorded in the index
 * (`git ls-files -s third_party`) plus each checkout's `HEAD` give the same
 * facts with two plain queries.
 *
 * Falls back to `pins.json` when git or the repository metadata is unavailable
 * (for example a downloaded source archive). The `source` field says which
 * evidence the caller has: `git` means the checkout was inspected, `pins` means
 * only the committed record exists.
 */
export function submoduleState({ timeoutMs = 20_000 } = {}) {
  const pins = readPins();
  const links = git(['ls-files', '-s', 'third_party'], { cwd: paths.root, timeoutMs });
  const gitlinks = links.ok
    ? links.stdout
      .split(/\r?\n/)
      .filter(line => line.startsWith('160000'))
      .map((line) => {
        const [meta, linkPath] = line.split('\t');
        const [mode, commit, stage] = meta.split(/\s+/);
        return { path: linkPath?.replace(/\\/g, '/'), mode, commit, stage };
      })
    : [];

  const rows = pins.submodules.map((pin) => {
    const present = existsSync(join(paths.root, pin.path));
    const link = gitlinks.find(candidate => candidate.path === pin.path) ?? null;
    let actual = null;
    if (present) {
      const head = git(['-C', pin.path, 'rev-parse', 'HEAD'], { cwd: paths.root, timeoutMs });
      if (head.ok) {
        actual = head.stdout.trim();
      }
    }
    const state = !present
      ? 'missing'
      : actual === null
        ? 'present'
        : actual === pin.commit
          ? 'initialized'
          : 'different-commit';
    return {
      path: pin.path,
      commit: actual ?? pin.commit,
      pinned: pin.commit,
      gitlink: link?.commit ?? null,
      state,
    };
  });

  return {
    source: links.ok ? 'git' : 'pins',
    available: links.ok,
    rows,
    gitlinks,
  };
}

/** List candidate bridge executables for diagnostics. */
export function existingBridgeCandidates() {
  const roots = [
    join(paths.mesen, 'bin', 'win-x64', 'Release'),
    join(paths.mesen, 'bin', 'win-x64', 'Debug'),
  ];
  return roots
    .filter(root => existsSync(root))
    .flatMap(root => readdirSync(root).filter(name => name === 'MCPServer.exe').map(name => join(root, name)));
}
