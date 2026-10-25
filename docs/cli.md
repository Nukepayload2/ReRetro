# 命令行

所有命令都是零依赖的 Node 脚本，可以经 `scripts/rea-fc.mjs` 子命令调用，也可以直接 `node scripts/<name>.mjs`。工作流规则见 [workflow](workflow.md)，安装见 [installation](installation.md)。

统一约定：

- 参数形如 `--name value` 或 `--name=value`；开关形如 `--flag`，否定形如 `--no-flag`。
- `--json` 输出机器可读结果；成功与失败都走 stdout，退出码区分结果。
- 报告里的路径尽量写成仓库相对路径；机器专属路径只出现在 `out/`（被 git 忽略）。
- 退出码：`0` 通过，`1` 失败，`2` 降级（工具或探测缺失）。

## `setup`

```powershell
node scripts/rea-fc.mjs setup [--mesen-dir <dir>] [--bench-dir <dir>] [--skip-build] [--rebuild] [--dry-run] [--json]
```

检测构建先决、核对 submodule pin、构建缺失的工具（`dotnet restore` + MSBuild），并把客户端注册条目写进 `out/`。

工具二进制存在时默认跳过构建；改过 submodule 源码后用 `--rebuild` 强制重建，否则跑的还是旧产物。

| 输出 | 内容 |
|------|------|
| `out/mcp.json` | stdio 型 `mcpServers` 配置，指向本次定位到的 `MCPServer.exe`（定位到桥时才写） |
| `out/mcp.http.json` | HTTP 型配置模板（默认端口 `51234`，定位到桥时才写） |
| `out/client-setup.md` | Claude Code / Codex / 通用 JSON 三种注册写法（定位到桥时才写） |
| `out/environment.json` | 本次检测结果，供排障与复核（每次运行都写） |

退出码：`0` 全部通过；`1` 有构建失败（磁盘上是旧产物，不是本次源码）；`2` 缺桥。submodule 存在未提交改动时该行标 `modified`。

## `doctor`

```powershell
node scripts/rea-fc.mjs doctor [--live] [--rom <rom-path>] [--timeout <ms>] [--json]
```

逐层诊断，用来回答「哪里断了、下一步做什么」。`verify` 只给通过/降级；`doctor` 会把每一层单独摊开：

| 层 | 检查内容 | 不通过时的下一步 |
|----|----------|------------------|
| 运行时 | Node 版本、平台 | 升级 Node |
| 仓库与 submodule | 两个工具仓是否检出、是否在 pin 上 | `git submodule update --init --recursive`，再跑 `pins` |
| 工具二进制 | `MCPServer.exe`、`Mesen.exe`、`SourceGen.exe` 是否定位到 | `setup`，或 `--mesen-dir` 指向已有安装 |
| 模拟器初始化 | profile 目录、`settings.json` 是否可解析、原生库是否齐全、手柄端口是否配置 | `emulator provision`，判据见 [emulator-init](emulator-init.md) |
| 构建工具链 | MSBuild、dotnet、.NET Framework 4.8.1 pack | 安装对应 VS 工作负载与 SDK |
| 工具列表缓存 | Mesen 写出的 `mcp-tools.cache.json` 是否存在 | 打开一次 Mesen 生成缓存 |
| 桥握手 | `initialize` / `tools/list` 与工具面比对 | 重新构建或核对 pin |
| 实时探测（`--live`） | `get_rom_info`、`debugger_status`、一次内存读 | 打开 Mesen、载入 ROM，或加 `--rom` |
| 输入端口（`--live`） | `clear_input` 返回的 `available_controllers` | 端口为 `None` 时用 `emulator provision` 配置 |

退出码：`0` 各层通过，`2` 仓库正常但缺环境（Mesen 没开、缓存没生成），`1` 有需要人处理的问题。`--json` 输出每一层的 `status`、`detail`、`remedy` 与汇总的 `nextActions`。

## `verify`

```powershell
node scripts/rea-fc.mjs verify [--live] [--breakpoint] [--rom <rom-path>] [--load] [--timeout <ms>] [--json]
```

按顺序校验：submodule 检出与 pin → submodule 工作树是否干净 → 桥可执行文件 → `initialize`/`tools/list` 握手 →（可选）Mesen 实时探测。

工具清单由 Mesen 在启动时写入本机缓存，桥靠这份缓存离线应答。首次核验前先打开一次 Mesen；否则 `tools/list` 会返回「Mesen is not running」，脚本按降级（退出码 `2`）处理并给出提示。

握手要求 pinned 的 23 个工具（含载入/关闭 ROM、存档/读档、输入覆盖、按帧推进）；本地构建多出的工具单独列出，不判失败。

`--live` 追加一次实时探测：`get_rom_info`、`debugger_status`，在已载入 ROM 且有内存区时再做一次 `get_memory_range` 实际读取。`--rom` 把 `get_rom_info.rom_path` 与给定路径规范化比较；加 `--load` 时，若本次工具面带 `load_rom`，先让它载入再比对，否则按界面载入处理。

`--breakpoint` 追加 `breakpoint-probe`：在 NES 栈页 `$01F0-$01FF` 设写断点、推进最多 60 帧，要求 `run_frames` 报 `stopped_by_breakpoint`/`break_source: Breakpoint`/`breakpoint_id: 0` 与停止地址，`get_debug_events` 能给出非空历史，最后清空断点并恢复执行。它替换整个断点列表，所以不在 `--live` 里默认开启；只对 NES 生效，其他机型判为降级。开了预测型断点时命中可能先于访问发生，因此该门不要求出现 `Breakpoint` 事件。

## `emulator`

```powershell
node scripts/rea-fc.mjs emulator inspect [--mesen-dir <dir>] [--rom <rom>] [--live] [--json]
node scripts/rea-fc.mjs emulator provision [--mesen-dir <dir>] [--rom <rom>] [--no-portable] `
  [--device NesController] [--json]
```

判定并补齐模拟器侧的初始化事实：profile 目录、`settings.json`、原生库（`MesenCore`、`libSkiaSharp`、`libHarfBuzzSharp`）、手柄端口。规则与判据见 [emulator-init](emulator-init.md)。

| 动作 | 行为 | 退出码 |
|------|------|--------|
| `inspect` | 只读：给出 profile 目录与判定依据、配置文件是否可解析、原生库是否齐全、端口设备、启动命令 | `0` 全通过，`2` 有缺项，`1` 连 `Mesen.exe` 都没定位到 |
| `provision` | 写 `settings.json`（保留其余配置项，只补 `None`/缺失的端口），默认把可执行文件目录设为便携 profile；文档目录 profile 下按需复制原生库 | `0` 成功，`1` 失败 |

- `--live` 用桥的 `clear_input` 复核 `available_controllers`：这是「按键真能送进去」的直接证据，`inspect` 的静态判定不能替代它。
- `--rom` 让输出的启动命令带上 ROM 路径；只影响打印，不启动模拟器。
- `--no-portable` 改为写入 `%USERPROFILE%\Documents\MesenCE` 下的文档目录 profile。
- 不写 ROM、不写存档、不改 submodule 的跟踪文件；写入目标是可执行文件所在目录与 profile 目录。

## `info`
```powershell
node scripts/rea-fc.mjs info <rom> [--json]
```

打印 iNES 头事实：格式、mapper、PRG/CHR 大小、镜像方式、battery、trainer、PRG/CHR 偏移、尾随字节、SHA256。固定基线的第一步就用它。

## `patch`

```powershell
node scripts/rea-fc.mjs patch --rom <rom> --out <patched> `
  --edit <offset>:<old>:<new>[:note] [--edit ...] `
  [--ips <ips-file>] [--bank <n>] [--bank-cpu-start 0x8000] [--bank-size 0x4000] `
  [--force] [--dry-run] [--json]
```

- `offset` 是文件偏移（十进制或 `0x` 十六进制）；`old`、`new` 是十六进制字节串（`4c00c0` 或 `4c 00 c0`）。
- 每条编辑先断言原字节，再写入；全部完成后读回校验，并给出前后 SHA256。
- 原 ROM 永不被覆盖：`--out` 与 `--rom` 相同会直接报错；目标已存在时需 `--force`。
- `--ips` 从「原 ROM → 新 ROM」的差异生成 IPS；IPS 只是交付格式，权威产物是脚本重放的结果。
- `--bank`/`--bank-cpu-start`/`--bank-size` 用于把文件偏移标注成 CPU 地址，标注不上时如实显示 `n/a`。

生成 IPS 时若某条记录会落在 `0x454F46`（IPS 的结束标记 `EOF`），脚本直接报错而不是产出一个会被读成结束符的补丁。

## `cheat`

```powershell
node scripts/rea-fc.mjs cheat decode <CODE> [--json]
node scripts/rea-fc.mjs cheat encode --address 0xNNNN --value 0xNN [--compare 0xNN] [--json]
node scripts/rea-fc.mjs cheat check --rom <rom> (--offset 0xNN | --address 0xNNNN) `
  [--bank N] [--bank-size 0x4000] [--bank-cpu-start 0x8000] [--json]
```

- `decode`/`encode` 使用 `third_party/MesenGM` 的 `CheatManager` 位序：6 位码是「地址 + 值」，8 位码是「地址 + 值 + 校验值」。
- `check` 打印同一 bank 内偏移在每个 PRG bank 的原始字节，并给出目标 bank 的校验值是否唯一。唯一性不成立时不要交付 8 位码。

## `sourcegen`

```powershell
node scripts/rea-fc.mjs sourcegen stats --rom <rom> [--prg-bank <n>] [--json]
node scripts/rea-fc.mjs sourcegen build --rom <rom> [--prg-bank <n>] [--save-project <dis65>] [--json]
node scripts/rea-fc.mjs sourcegen line  --rom <rom> --prg-bank <n> --address 0x8000 [--count 32] [--json]
node scripts/rea-fc.mjs sourcegen xref  --rom <rom> --address 0x0324 [--all-banks] [--writes-only] [--json]
```

`stats`/`build` 不给 `--prg-bank` 时逐 bank 全跑，给了就只报那一个 bank——要单看固定 bank 的覆盖率必须显式给 `--prg-bank`。

无人值守的反汇编入口。`scripts/sourcegen.mjs` 把 PRG bank 切成 16 KB 切片，交给 `tools/SourceGenCli`（引用 pin 的 `SourceGen`/`Asm65`/`CommonUtil` 工程的小工具），再把结果换回 CPU 地址与 ROM 文件偏移。分析本身来自 6502bench，驱动器只决定问什么、怎么打印。

| 动作 | 输出 |
|------|------|
| `stats` | 每个 bank 的覆盖率：代码字节、指令数、未访问字节数、消息数 |
| `build` | 同上，可 `--save-project` 写出 `.dis65`，界面能直接打开继续加工 |
| `line` | 指定地址起的指令表：地址、原始字节、助记符、操作数 |
| `xref` | 操作数命中所查地址的指令；`--writes-only` 只留写与读改写，`--all-banks` 扫全部 bank |

- 非 iNES 输入用 `--data <file> --base 0x8000`，语义相同。
- 固定 bank（通常最后一个，映射在 `$C000`）会自动读 `$FFFA-$FFFF` 的 NMI/Reset/IRQ 向量作为分析入口；可切换 bank 只有起始字节一个种子。
- 覆盖率低就是分析没到：`--entry <addr>` 可重复，用来把已确认的入口（例如断点抓到的 `pc`）补进种子，再重看 `stats` 的指令数与 `xref` 的命中。`xref` 没命中可能是没分析到，不等于该地址没被写。
- CPU 默认 `2a03`（NES），可用 `--cpu 6502|65c02|65816`；`--no-undocumented` 排除未文档化指令。
- 跨 bank 引用不在单 bank 分析范围内：`--all-banks` 是逐 bank 分析后合并，不是跨 bank 符号解析。
- 驱动器缺失时本命令直接失败并给出 `node scripts/setup.mjs`；`setup` 把它作为第三个构建目标。

## `pins`

```powershell
node scripts/rea-fc.mjs pins [--write] [--json]
```

对比 `third_party/pins.json` 与两个 submodule 实际检出的提交。默认只报告并在一不一致时退出 `1`；`--write` 把实际提交写回 `pins.json`。升级 submodule 后用它记录 pin，再跑 `verify`。

## `check`

```powershell
node scripts/rea-fc.mjs check [--json]
```

仓库自检：扫描外部 key 占位符、外部工作区依赖、本机用户路径、`/home/` 路径、断链，以及 `.gitmodules`、`pins.json`、gitlink 三者的一致性。CI 与 `npm test` 都会跑它。

## `test`

```powershell
node scripts/rea-fc.mjs test
```

等价于 `node --test tests/`。单元测试覆盖 iNES 解析、偏移换算、Game Genie 编解码往返、补丁确定性与 IPS 往返；桥握手测试在 `MCPServer.exe` 不存在、或本机还没有 Mesen 写出的工具缓存时跳过。
