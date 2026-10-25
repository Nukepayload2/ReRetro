# 安装与环境就绪

本文覆盖两件事：把两个工具仓构建/定位好，再把 `third_party/MesenGM` 的 MCP 调试桥接入 AI 客户端并核验工具面真的可用。本步失败时没有动态取证能力，后续结论只能标「推测」或「猜测」。

工作流本身见 [workflow](workflow.md)；命令细节见 [cli](cli.md)。

## 先决条件

| 项 | 要求 | 说明 |
|----|------|------|
| 操作系统 | Windows 10/11 x64 | Mesen 的 MCP 桥只在 Windows 构建中提供；SourceGen 是 WPF 程序 |
| Node.js | `>=22.19`（`node --version`） | 只跑脚本，零第三方依赖 |
| Git | 支持 submodule | `git clone --recursive` 取工具仓 |
| 构建工具（从源码构建时） | Visual Studio 2022/2026，含 C++ 桌面工作负载、.NET 10 SDK、.NET Framework 4.8.1 targeting pack | Mesen 的 UI 工程目标 `net10.0`；SourceGen 目标 `v4.8.1` |
| 已有安装（跳过构建时） | 任一份 `MCPServer.exe` + `Mesen.exe`（MesenGM 构建产物），任一份 `SourceGen.exe` | 用 `--mesen-dir`、`--bench-dir` 或环境变量指过去，并配合 `--skip-build` |

不构建也可以工作：`setup.mjs` 支持 `--skip-build`。构建产物只落在 submodule 自己的 `bin/` 下，本仓库不提交二进制。

## 取仓库

```powershell
git clone --recursive <repo-url> rea-fc
cd rea-fc
```

已经 clone 但工具目录为空时补一次：

```powershell
git submodule update --init --recursive
```

`third_party/pins.json` 记录两个 submodule 的 pin；`node scripts/check-docs.mjs` 会核对 `.gitmodules`、`pins.json` 与 gitlink 三者是否一致。

### 拿到的是源码目录（还没有 git 元数据）

如果手里只有文件、没有 `.git` 与 `.gitmodules`，先建立仓库并补上两个 submodule，再把 pin 对齐：

```powershell
git init -b main
git submodule add https://github.com/Nukepayload2/MesenGM.git third_party/MesenGM
git submodule add https://github.com/fadden/6502bench.git third_party/6502bench
git -C third_party/MesenGM checkout e18024c81a4dd9b7b7f08e5df0b5fbc2d05b38ca
git -C third_party/6502bench checkout f43f3761fd63cef7fe2e2e71fb2b58fec0c4a73e
git add -A
git commit -m "feat: standalone NES reversing kit with pinned tool submodules"
```

上面的提交号以 `third_party/pins.json` 为准；`git submodule add` 取的是上游默认分支当前 tip，pin 不一致时按 `pins.json` 检出后再 `git add` 两个 submodule 路径。完成后 `node scripts/check-docs.mjs` 应报告 0 违规。

## 第一步：构建或定位工具

```powershell
node scripts/setup.mjs
```

它按顺序做这些事：

1. 检查 Node 版本、MSBuild、dotnet、.NET Framework 4.8.1 targeting pack。
2. 核对 submodule 是否已检出、是否在 pin 上。
3. 定位两个工具；submodule 里还没有构建产物时，用 `dotnet restore` + MSBuild 从源码构建：
   - `Mesen.sln`：`Release|x64`，产物 `third_party/MesenGM/bin/win-x64/Release/`（`Mesen.exe`、`MCPServer.exe`）；
   - `WorkBench.sln`：`Release|Any CPU`，产物 `third_party/6502bench/SourceGen/bin/Release/SourceGen.exe`。
4. 构建无人值守反汇编驱动器 `tools/SourceGenCli`（引用上面的 6502bench 工程，产物 `tools/SourceGenCli/bin/Release/SourceGenCli.exe`）。没有它，静态侧只剩界面操作与调试桥的窗口式反汇编。
5. 把客户端注册条目写进 `out/`（该目录被 git 忽略）：定位到桥时写 `out/mcp.json`、`out/mcp.http.json`、`out/client-setup.md`；`out/environment.json` 每次都写，内含本次检测结果。

常用参数：

| 参数 | 作用 |
|------|------|
| `--mesen-dir <dir>` | 指定运行用的 `MCPServer.exe` 所在目录（不阻止构建；要跳过构建加 `--skip-build`） |
| `--bench-dir <dir>` | 指定 `SourceGen.exe` 所在目录，语义同上 |
| `--skip-build` | 只做检测与配置生成，不构建 |
| `--dry-run` | 只打印将要执行的命令 |
| `--json` | 机器可读输出 |

环境变量 `REA_FC_MESEN_DIR`、`REA_FC_BENCH_DIR` 与对应参数等价，适合写进本机的 shell 配置。

退出码：`0` 桥已就位；`2` 桥缺失；`1` 检查本身失败。构建失败但桥已存在时仍是 `0`，此时看输出里的 `Builds` 段判断降级项。

## 第二步：选择传输方式

| 方式 | 谁来拉起 | 端点 / 命令 | 适用 |
|------|---------|------------|------|
| Streamable HTTP | Mesen 内手动启动（Debug > MCP Server > Start） | `http://127.0.0.1:<port>/mcp/`，默认端口 `51234` | 客户端支持 URL 型 MCP；Mesen 显示启动状态与日志 |
| stdio | MCP 客户端 | `<mesen-install-dir>\MCPServer.exe --stdio` | 客户端能自行拉起子进程；Mesen 重启后桥可重连 |

两种方式都由 `MCPServer.exe` 翻译到同一条命名管道，客户端看到的工具面相同。

## 第三步：让模拟器本身可启动、可按键

桥的握手只证明桥在应答，它不启动模拟器。模拟器侧还有四项事实：profile 目录、`settings.json`、原生库、手柄端口。四项里任意一项不成立，桥依旧全绿，而动态取证一步也走不了——此时读 [emulator-init](emulator-init.md)，按其中的步骤判定与补齐。

最短的一次性补齐：

```powershell
node scripts/rea-fc.mjs emulator provision --rom <rom>   # 写配置、补端口、按需复制原生库
node scripts/rea-fc.mjs emulator inspect --live          # 复核：原生库齐全、available_controllers 非空
```

不写配置只做判定时用 `inspect`；它按 `0 / 2 / 1` 区分「全通过 / 有缺项 / 连可执行文件都没有」。

## 第四步：在客户端注册

`out/client-setup.md` 里有按客户端分开的注册命令；`out/mcp.json` 是通用的 `mcpServers` 形态。以通用 JSON 为例：

```json
{
  "mcpServers": {
    "mesen-debugger": {
      "type": "stdio",
      "command": "<mesen-install-dir>\\MCPServer.exe",
      "args": ["--stdio"]
    }
  }
}
```

- Windows 路径在 JSON 里用双反斜杠；含空格的路径不需要额外引号，数组元素即为完整参数。
- 走 HTTP 时改用 URL 型条目，指向实际端口，例如 `http://127.0.0.1:51234/mcp/`。
- 可执行文件位置以实际安装为准；submodule 的构建产物在 `third_party/MesenGM/bin/win-x64/Release/MCPServer.exe`，但它不一定是用户正在跑的模拟器那份。
- 改动 JSON 后先做一次解析校验（例如把文件读成 JSON 对象），语法错会让整份配置失效，表现为所有 MCP server 一起消失。

### 会话必须常驻

注册后由客户端托管这条 stdio 会话：一个常驻 `MCPServer.exe --stdio`，所有工具调用复用它。逐帧轮询、连续读内存这类取证动作依赖会话存活，桥重启一次就要重新握手。

仓库自带的批处理客户端（`scripts/lib/mcp.mjs`）**每批拉起一个桥进程**，它只是给 `verify`、`doctor` 与 CI 用的核验工具，不是交互取证的通道。同一台机器实测：经它单次调用约 1.6 s（进程启动占大头），而常驻会话里 5 次调用合计约 0.3 s。不要拿批处理客户端做逐帧轮询。

判据：客户端工具面里应出现带服务器前缀的桥工具（形如 `mcp__<server>__get_rom_info`）；只有脚本能读、客户端里看不到，说明注册没生效。

## 第五步：核验生效

注册成功不等于已生效。核验顺序有一个前提：桥的工具清单由 Mesen 在启动时写进本机缓存，桥在没有 Mesen 的情况下靠这份缓存离线应答 `tools/list`。因此**第一次**核验的顺序是：

1. 让模拟器可启动、可按键（第三步）；
2. 打开 Mesen（可以只到主界面），让缓存生成；
3. `node scripts/verify.mjs`。

之后只要缓存还在，桥就能在 Mesen 未运行时回答工具列表。

```powershell
node scripts/verify.mjs          # submodule pin + 桥 + 工具面 + 模拟器层
node scripts/verify.mjs --live   # 追加 Mesen 实时探测与输入端口探测
node scripts/verify.mjs --rom <rom-path> --live   # 追加「载入的是不是这个 ROM」
```

`verify.mjs` 通过文件型 stdio 与桥通信（同一份换行分隔 JSON-RPC，只是把管道换成临时文件），因此在禁止命名管道的受限环境里也能用。它按顺序确认：

| 检查项 | 期望结果 | 不满足说明 |
|--------|---------|-----------|
| 工具列表 | `debugger_status`、`get_rom_info`、`load_rom`、`close_rom`、`get_cpu_state`、`get_ppu_state`、`get_screen`、`get_memory_range`、`search_memory`、`set_memory`、`get_disassembly`、`get_trace_tail`、`get_debug_events`、`set_breakpoints`、`step`、`resume`、`pause`、`run_frames`、`set_input`、`clear_input`、`save_rom`、`save_state`、`load_state`，共 23 个 | 报「Mesen is not running」是缓存还没生成：先打开一次 Mesen；其余情况检查客户端是否加载了新配置 |
| 模拟器层 `emulator-setup` | profile 目录已判定、`settings.json` 可解析、原生库齐全、手柄端口已配置 | 握手绿而模拟器层降级，就是「桥能应答、取证做不了」；按 [emulator-init](emulator-init.md) 补齐 |
| `get_rom_info` | `rom_path` 是目标 ROM，`format` 不是 `Unknown` | 桥通了但没载入 ROM，或载入了别的 ROM |
| `get_rom_info` 的 `memory_types` | 含 `NesPrgRom`、`NesInternalRam` 等区域及其 ID 与大小 | 不要凭记忆填内存区 ID，一律取自本次返回 |
| `debugger_status` | `debugger_running`、`emulation_running`、`execution_stopped` 可解释 | 握手成功不代表 ROM 在跑 |
| 一次实际内存读 | `get_memory_range` 能读到已知字节 | 只有状态接口通、内存接口不通时，不能作为取证依据 |
| 输入端口 `input-probe` | `clear_input` 返回的 `available_controllers` 非空 | 为空说明端口没配，`set_input` 会被拒绝；按键送不进去等于没有动态证据 |

`--rom` 默认只做比对：它把 `get_rom_info.rom_path` 与给定路径规范化后比较，不改变模拟器状态。加 `--load` 时先调 `load_rom` 载入再比对；本地构建缺该工具时按界面载入处理并在输出里说明。

核验通过后，把本次的 `memory_types`（名称、ID、大小）记进工作台账；换 ROM 或换 Mesen 会话后必须重新核验。断点通道用 `node scripts/rea-fc.mjs verify --live --breakpoint` 验一次：它在 NES 栈页设写断点、推一帧，要求返回 `stopped_by_breakpoint: true` 并在事件里出现 `Breakpoint`，最后清空断点并恢复执行。手工做同一件事时，验完必须删掉断点，否则后续推帧都冻在第一个命中点。

工具面以 pinned 提交为准（23 个）。本地构建若多出工具，`verify.mjs` 会把它们列在可选集里而不判失败；缺核心工具才降级。以本次 `tools/list` 返回为准。

## 载入目标 ROM

- 用 `load_rom` 载入（可同时给 `patch_path` 套 IPS/UPS/BPS）；桥不可用时在 Mesen 界面打开，目录里的补丁不会自动应用。
- `load_rom`/`close_rom` 会替换或关闭当前 ROM，并影响共享同一实例的其他客户端；动手前确认没有别人在用。
- 载入后重新 `get_rom_info`，确认 `rom_path` 与格式符合预期。
- 导出一份改动后的 ROM 或 IPS 用 `save_rom`；它不是存档工具。A/B 用 `save_state`/`load_state`，存档读档都不能单独证明补丁有效。

## 常见故障

先跑 `node scripts/rea-fc.mjs doctor`：它按层列出断点与下一步，比对着症状猜快。下表是最常见的几种。

| 症状 | 处理 |
|------|------|
| `setup.mjs` 报 submodule 缺失 | `git submodule update --init --recursive`，再重跑 |
| 构建 Mesen 失败 | 确认 VS 装了 C++ 桌面工作负载与 .NET 10 SDK；先单独打开 `Mesen.sln` 用 `Release|x64` 构建，看第一条真实错误 |
| 重建 Mesen 报 `C1354: corrupt ipdb` 或 `LNK1257` | 上次链接被中断留下的增量代码生成库失效：删 `third_party/MesenGM/InteropDLL/obj/x64/Release/MesenCore.ipdb` 与 `.iobj` 后重试；`setup` 的 Mesen 目标会在构建前自动清掉这两个文件 |
| 干净机器上 Mesen 一启动就退出 | 旧构建的 `Dependencies.zip` 可能不含原生库；重建一次 Mesen 会重新打包，判据是归档里出现 `libSkiaSharp.dll` 与 `libHarfBuzzSharp.dll` |
| 构建 SourceGen 失败 | 确认装了 .NET Framework 4.8.1 targeting pack；报 `NETSDK1004` 是缺少 restore 资产，`setup.mjs` 已执行 `dotnet restore WorkBench.sln`，手工构建时也要先 restore |
| 模拟器启动后立刻退出，stderr 是 `DllNotFoundException` | profile 目录缺原生库；`node scripts/rea-fc.mjs emulator provision` 复制，判据见 [emulator-init](emulator-init.md) |
| 每次启动弹首次运行向导 | profile 目录没有 `settings.json`；`emulator provision` 写一份最小配置 |
| `set_input` 报「Controller 0 is not available」 | 手柄端口是 `None`；`emulator provision` 写入 `NesController` 后重启模拟器 |
| `run_frames` 返回 `timed_out` 且 `frames_elapsed` 为 `0` | 服务端预算内没恢复运行；原样重试同一次推帧，不要先释放按键 |
| `tools/list` 报 Mesen is not running | 打开一次 Mesen 生成工具缓存，再重跑核验；不需要重建桥 |
| 工具调用报 Mesen 未运行 | 打开 Mesen 并载入 ROM；桥不用重启 |
| 工具调用超时 | Mesen 停在自己的调试器或弹了模态窗口；先恢复执行、关对话框。服务端超时上限查 `third_party/MesenGM` |
| 报「No ROM is loaded」 | 在 Mesen UI 里打开游戏 |
| 工具缺失或多余 | pinned 提交的 23 个必须有；缺核心说明连的是旧二进制。多出来的新工具会列在可选集里，不影响通过 |
| HTTP 启动失败 | 端口被占用，在 Debug > MCP Server 里换端口，并同步改客户端 URL |
| 工具能调但整段反汇编是 `unidentified` | 不是注册问题，是反汇编分析缓存缺该段；按 [workflow](workflow.md) 的工具基线处理，不要转去手写反汇编器 |
| 工具行为与源码不一致 | 会话连的是旧进程或旧二进制；重新构建目标、重启 Mesen 与客户端，再重走核验 |
| 连上了却读不到目标 ROM 的数据 | 可能同时连着别的客户端并切换过 ROM；重新 `get_rom_info` 确认当前 ROM |

## 完成后

环境就绪只是入口：基线固化、断点或帧轮询取证、补丁与冷启动验收仍在 [workflow](workflow.md) 里。核验失败的项写进交付的「未决」，不要用静态推测填补。
