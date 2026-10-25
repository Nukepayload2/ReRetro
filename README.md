# rea-fc

**NES/6502 逆向工具包：一套规则、两个工具仓、零依赖脚本。** 把 NES ROM 逆向需要的静态反汇编、动态调试与取证规则收成一份 clone 即用的交付。

> A standalone NES/6502 reversing kit. The workflow lives in [docs/workflow.md](docs/workflow.md); the two tool repositories are pinned as submodules; the scripts need only Node.js. No external workspace, no machine-local path mapping.

## 快速开始

```powershell
git clone --recursive <repo-url> rea-fc
cd rea-fc
node scripts/setup.mjs      # 检测构建先决、构建工具、写出 MCP 注册条目
node scripts/verify.mjs     # 证明调试桥与工具面可用
```

把 `out/client-setup.md` 里的条目加进 MCP 客户端，再让模拟器本身可启动、可按键（写 profile 配置、补原生库、配置手柄端口）：

```powershell
node scripts/rea-fc.mjs emulator provision --rom <rom>
node scripts/verify.mjs --live --rom <rom>
```

`verify` 通过只证明桥与工具面可达，不证明模拟器能启动或收得到按键：这两件事由 profile 目录、配置文件、原生库与手柄端口决定，判据见 [docs/emulator-init.md](docs/emulator-init.md)。之后按 [docs/workflow.md](docs/workflow.md) 干活。环境没跑起来时先跑 `node scripts/rea-fc.mjs doctor`：它按「运行时 → submodule → 二进制 → 模拟器初始化 → 工具链 → 工具列表缓存 → 握手 → 实时探测 → 输入端口」逐层给出断点与下一步。

## 包含什么

| 部分 | 内容 |
|------|------|
| 规则 | [docs/workflow.md](docs/workflow.md)：适用边界、核心原则、静态定位、动态取证、补丁形态、金手指形态、冷启动验收、交付模板、禁止项、症状诊断 |
| 初始化 | [docs/emulator-init.md](docs/emulator-init.md)：桥已应答但模拟器起不来、载不进 ROM 或收不到按键时的判据与补齐步骤 |
| 工具 | `third_party/MesenGM`（模拟器 + MCP 调试桥，23 个工具，含载入 ROM / 存档读档 / 输入 / 推帧）、`third_party/6502bench`（SourceGen 反汇编），pin 见 [docs/third-party.md](docs/third-party.md) |
| 命令 | `setup`、`doctor`、`verify`、`emulator`、`info`、`patch`、`cheat`、`pins`、`check`、`test`，见 [docs/cli.md](docs/cli.md) |
| 智能体 | [.agents/skills/nes-rom-reversing/SKILL.md](.agents/skills/nes-rom-reversing/SKILL.md) |
| 测试 | `node --test tests/`：iNES 解析、偏移换算、Game Genie 编解码往返、补丁确定性、IPS 往返、模拟器初始化判定、桥握手 |

## 要求
- Windows 10/11 x64（Mesen 的 MCP 桥只随 Windows 构建提供；SourceGen 是 WPF 程序）。
- Node.js `>=22.19`。
- 从源码构建时：Visual Studio 2022/2026，含 C++ 桌面工作负载、.NET 10 SDK、.NET Framework 4.8.1 targeting pack。
- 已有安装时可跳过构建：`node scripts/setup.mjs --skip-build --mesen-dir <dir> --bench-dir <dir>`。

细节见 [docs/installation.md](docs/installation.md)。

## 证据纪律

交付里的每条断言标注三态，未标注按猜测处理：

| 状态 | 含义 | 能作前提 |
|------|------|----------|
| 实锤 | 已运行 / 有结果支撑 / 已采纳 | 可以 |
| 推测 | 基于已检查证据推断，未运行 | 点名依据后可作局部参考 |
| 猜测 | 无证据或未检查 | 不可以 |

`verify.mjs` 通过只证明工具面可达，不证明目标 ROM 已载入；`patch` 通过只证明字节写对，不证明游戏行为正确。冷启动验收是唯一能支撑「补丁有效」的证据。

## 边界

- 不附带任何 ROM、存档或金手指清单，也不提供绕过授权的用法。
- 只对自己拥有或获授权的 ROM 使用；许可见 [DISCLAIMER.md](DISCLAIMER.md)。
- 金手指与补丁的语义以 `third_party/MesenGM` 的实现为准；换模拟器要重新核验。

## 开发

```powershell
node --test tests/          # 单元 + 端到端测试
node scripts/check-docs.mjs # 仓库自检：无外部工作区依赖、无本机路径、链接与 pin 一致
```

仓库约定见 [AGENTS.md](AGENTS.md)。

## 许可

本仓库代码与文档采用 **GNU General Public License v3.0（GPLv3，SPDX：`GPL-3.0-only`）**，全文见 [LICENSE](LICENSE)。`scripts/lib/cheat.mjs` 的 Game Genie 位序取自 MesenGM 的 GPL 实现，这也是整体采用 GPLv3 的原因。

`third_party/MesenGM` 同为 GPL-3.0；`third_party/6502bench` 为 Apache-2.0。两者各自保留其许可与声明，本仓库不重新许可它们；详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
