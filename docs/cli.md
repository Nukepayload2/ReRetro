# 命令行

所有命令都是零依赖的 Node 脚本，可以经 `scripts/rea-fc.mjs` 子命令调用，也可以直接 `node scripts/<name>.mjs`。工作流规则见 [workflow](workflow.md)，安装见 [installation](installation.md)。

统一约定：

- 参数形如 `--name value` 或 `--name=value`；开关形如 `--flag`，否定形如 `--no-flag`。
- `--json` 输出机器可读结果；成功与失败都走 stdout，退出码区分结果。
- 报告里的路径尽量写成仓库相对路径；机器专属路径只出现在 `out/`（被 git 忽略）。
- 退出码：`0` 通过，`1` 失败，`2` 降级（工具或探测缺失）。

## `setup`

```powershell
node scripts/rea-fc.mjs setup [--mesen-dir <dir>] [--bench-dir <dir>] [--skip-build] [--dry-run] [--json]
```

检测构建先决、核对 submodule pin、构建缺失的工具（`dotnet restore` + MSBuild），并把客户端注册条目写进 `out/`。

| 输出 | 内容 |
|------|------|
| `out/mcp.json` | stdio 型 `mcpServers` 配置，指向本次定位到的 `MCPServer.exe`（定位到桥时才写） |
| `out/mcp.http.json` | HTTP 型配置模板（默认端口 `51234`，定位到桥时才写） |
| `out/client-setup.md` | Claude Code / Codex / 通用 JSON 三种注册写法（定位到桥时才写） |
| `out/environment.json` | 本次检测结果，供排障与复核（每次运行都写） |

## `verify`

```powershell
node scripts/rea-fc.mjs verify [--live] [--rom <rom-path>] [--timeout <ms>] [--json]
```

按顺序校验：submodule 检出与 pin → 桥可执行文件 → `initialize`/`tools/list` 握手 →（可选）Mesen 实时探测。

工具清单由 Mesen 在启动时写入本机缓存，桥靠这份缓存离线应答。首次核验前先打开一次 Mesen；否则 `tools/list` 会返回「Mesen is not running」，脚本按降级（退出码 `2`）处理并给出提示。

`--live` 追加一次实时探测：`get_rom_info`、`debugger_status`，在已载入 ROM 且有内存区时再做一次 `get_memory_range` 实际读取。`--rom` 把 `get_rom_info.rom_path` 与给定路径规范化比较，不改变模拟器状态。

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
