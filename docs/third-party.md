# 第三方工具仓

两个工具以 submodule 形式引入，保留各自的提交、许可与历史。`third_party/6502bench` 是真正的第三方，本仓库不复制、不改写它的源码；`third_party/MesenGM` 是本项目自己的 fork，调试桥的修复就提交在那里（见下文「本项目的 fork」）。唯一的重实现是 Game Genie 位序（见下文许可边界）。

## Pin

| 路径 | 来源 | 提交 | 许可 | 角色 |
|------|------|------|------|------|
| `third_party/MesenGM` | `https://github.com/Nukepayload2/MesenGM.git`（本项目的 fork） | `6ba3506895837a1f1f72e6bcbe3ad9dcd2a2f7c6` | GPL-3.0 | 动态侧：Mesen 模拟器 + MCP 调试桥 `MCPServer.exe`（23 个工具） |
| `third_party/6502bench` | `https://github.com/fadden/6502bench.git`（第三方） | `f43f3761fd63cef7fe2e2e71fb2b58fec0c4a73e` | Apache-2.0 | 静态侧：SourceGen 反汇编工作台 |

提交号同时出现在两处：superproject 的 gitlink（权威）与 `third_party/pins.json`（可读副本）。`scripts/check-docs.mjs` 会核对两者与 `.gitmodules` 是否一致。

## 本项目的 fork

`MesenGM` 的地址是本项目的 fork，不是第三方上游。调试桥的行为是本仓库交付物的一部分——事件历史、断点命中原因、`run_frames` 的返回字段都在这里定义——所以这些改动直接提交到该 fork，再升级 pin：

1. 在 `third_party/MesenGM` 里提交，推到 fork 的分支；pin 指向的提交必须在该 fork 里可取，否则别人的 `git submodule update` 拿不到它。`verify.mjs` 的 `pin-remote` 层查这一点，加 `--fetch` 才会发网络请求。
2. `node scripts/reretro.mjs pins --write`，再 `git add third_party/MesenGM`，把 gitlink 前移。
3. `node scripts/setup.mjs` 重建，`node scripts/verify.mjs` 核验工具面。

fork 内提交不属于本仓库的历史，因此**改了什么必须同时落到 `docs/`**：工具行为变化会改变取证结论，只改 fork 不写文档，下一个人读到的仍是旧行为。

`6502bench` 保持第三方身份：需要改它时先提上游或在本机打补丁并注明，不复用「我们的 fork」这套说法。

## 许可边界

- 本仓库自己的代码与文档是 GPL-3.0；它不改变任何 submodule 的许可。
- `scripts/lib/cheat.mjs` 的 Game Genie 位序与校验位布局取自 `third_party/MesenGM/Core/Shared/CheatManager.cpp`（GPL-3.0）。这也是本仓库整体用 GPL-3.0 的原因；要改成更宽松的许可，先独立重推该位序表。
- `third_party/MesenGM` 是 GPL-3.0 的独立作品。分发含该 submodule 的 clone 时，其源码与二进制仍受 GPL-3.0 约束；本仓库不授予、也不替代它的许可。
- `third_party/6502bench` 是 Apache-2.0。其 `NOTICE.txt` 要求在衍生分发中保留声明；转售或再分发构建产物前先读该文件。
- 本仓库不提交任何工具二进制。构建产物留在 submodule 自己的 `bin/` 目录，由使用者在本机构建。

## 工具面随 pin 变化

pin 的 MesenGM 提交（Nukepayload2 fork）注册 23 个工具：上游 16 个，加上 `load_rom`、`close_rom`、`save_state`、`load_state`、`set_input`、`clear_input`、`run_frames`。必须集在 `scripts/lib/mcp.mjs` 的 `CORE_MESEN_TOOLS`；`OPTIONAL_MESEN_TOOLS` 留空，用于本地构建多出工具时降级报告，不参与通过判定。

升级 pin 时先对齐检出提交，再记录 pin、移动 gitlink、重建并核验：

```powershell
git -C third_party/MesenGM fetch
git -C third_party/MesenGM checkout <new-commit>
node scripts/reretro.mjs pins --write
git add third_party/MesenGM
git commit -m "chore: bump MesenGM pin"
node scripts/setup.mjs
node scripts/verify.mjs
```

`pins --write` 只改 `pins.json`；superproject 的 gitlink 要单独 `git add` 才会跟着移动，否则 `check-docs` 会报两者不一致。新提交若改变工具集合，同步更新 `CORE_MESEN_TOOLS` 与 `docs/`、skill 里的工具表。

## 更新策略

pin 是显式动作，不是自动跟随。MesenGM 的提交来自本项目的 fork，6502bench 的提交来自第三方：

```powershell
git submodule update --remote third_party/MesenGM third_party/6502bench
node scripts/reretro.mjs pins --write
git add third_party/MesenGM third_party/6502bench
git commit -m "chore: bump tool submodules"
node scripts/setup.mjs
node scripts/verify.mjs
node scripts/reretro.mjs test
```

工具行为变化会改变取证结论，升级后必须重跑核验；只更新 pin 而不重跑核验，等于把「源码改了」当成「行为已验证」。

## 不做什么

- 不在本仓库内复制工具源码；改动一律落在各自的仓库里，本仓库只记 pin。
- 不在本仓库打补丁再声称「pin 等于上游」；MesenGM 改 fork 再升级 pin，6502bench 改上游再升级 pin。
- 不让 pin 指向 fork 里推送不出去的提交：本地提交必须先推到 fork，否则 clone 下来的 submodule 无法检出。
- 不把 `MCP_SERVER.md`、`docs/sgmanual/` 等工具手册复制进本仓库；它们随 submodule 更新，复制会漂移。
- 不把 ROM、存档、构建产物纳入版本控制。
