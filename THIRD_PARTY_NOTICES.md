# Third-party notices

本仓库代码与文档是 GPL-3.0（见 [LICENSE](LICENSE)）。下面的工具是独立作品，以 git submodule 引入，各自保留许可；本仓库不重新许可它们，也不提交它们的二进制。

## MesenGM — `third_party/MesenGM`

- 上游：<https://github.com/Hoshiruna/MesenGM>
- 许可：GNU General Public License v3.0（`git submodule update --init` 后见 `third_party/MesenGM/LICENSE`）
- 角色：NES 模拟器与 MCP 调试桥（`MCPServer.exe`），动态取证侧。

`scripts/lib/cheat.mjs` 的 Game Genie 位序与校验位布局取自该工程的 `Core/Shared/CheatManager.cpp`（`ConvertFromNesGameGenie`）。这是本仓库整体采用 GPL-3.0 的原因之一；若只想用 MIT 分发本仓库，需要先独立重推该位序表并移除该推导说明。

## 6502bench（SourceGen）— `third_party/6502bench`

- 上游：<https://github.com/fadden/6502bench>，项目页 <https://6502bench.com/>
- 许可：Apache License 2.0（见 `third_party/6502bench/LICENSE`）
- 角色：静态反汇编工作台，用来建立可复现工程、符号与字节环回校验。

`third_party/6502bench/NOTICE.txt` 要求在衍生分发中保留其声明。转售或再分发 SourceGen 构建产物前先读该文件。

## 运行时依赖

`scripts/` 只用 Node.js 内建模块，没有需要审计或 vendor 的 npm 运行时依赖。

## ROM、存档与抓包

本仓库不包含任何 ROM、即时存档、金手指清单或抓包。使用者在本机产生的内容留在本机；使用边界见 [DISCLAIMER.md](DISCLAIMER.md)。
