# 第三方工具仓

两个工具以 submodule 形式引入，保留各自的上游身份、许可与历史。本仓库不复制、不改写它们的源码；唯一的重实现是 Game Genie 位序（见下文许可边界）。

## Pin

| 路径 | 上游 | 提交 | 许可 | 角色 |
|------|------|------|------|------|
| `third_party/MesenGM` | `https://github.com/Hoshiruna/MesenGM.git` | `481f4599b7ad9f8db769556f875930a40a307834` | GPL-3.0 | 动态侧：Mesen 模拟器 + MCP 调试桥 `MCPServer.exe` |
| `third_party/6502bench` | `https://github.com/fadden/6502bench.git` | `f43f3761fd63cef7fe2e2e71fb2b58fec0c4a73e` | Apache-2.0 | 静态侧：SourceGen 反汇编工作台 |

提交号同时出现在两处：superproject 的 gitlink（权威）与 `third_party/pins.json`（可读副本）。`scripts/check-docs.mjs` 会核对两者与 `.gitmodules` 是否一致。

## 许可边界

- 本仓库自己的代码与文档是 GPL-3.0；它不改变任何 submodule 的许可。
- `scripts/lib/cheat.mjs` 的 Game Genie 位序与校验位布局取自 `third_party/MesenGM/Core/Shared/CheatManager.cpp`（GPL-3.0）。这也是本仓库整体用 GPL-3.0 的原因；要改成更宽松的许可，先独立重推该位序表。
- `third_party/MesenGM` 是 GPL-3.0 的独立作品。分发含该 submodule 的 clone 时，其源码与二进制仍受 GPL-3.0 约束；本仓库不授予、也不替代它的许可。
- `third_party/6502bench` 是 Apache-2.0。其 `NOTICE.txt` 要求在衍生分发中保留声明；转售或再分发构建产物前先读该文件。
- 本仓库不提交任何工具二进制。构建产物留在 submodule 自己的 `bin/` 目录，由使用者在本机构建。

## 工具面随 pin 变化

pin 的 MesenGM 提交注册 16 个 MCP 工具，没有载入 ROM、存档/读档、输入覆盖、按帧推进这些工具；这些动作在 Mesen 界面里做。上游更新会改变工具面，升级后必须重跑 `node scripts/verify.mjs`，不要沿用旧结论。

## 更新策略

pin 指向两个上游的 `master` 分支提交，升级是显式动作，不是自动跟随：

```powershell
git submodule update --remote third_party/MesenGM third_party/6502bench
```

然后：

1. 用 `git submodule status` 读出新的提交号。
2. 更新 `third_party/pins.json` 的 `commit` 字段。
3. `node scripts/check-docs.mjs` 确认三者一致。
4. 重新构建（`node scripts/setup.mjs`）并跑 `node scripts/verify.mjs`。
5. `node scripts/rea-fc.mjs test`。

工具行为变化会改变取证结论，升级后必须重跑核验；只更新 pin 而不重跑核验，等于把「源码改了」当成「行为已验证」。

## 不做什么

- 不 fork 上游到本仓库内部。
- 不在本仓库打补丁再声称「pin 等于上游」；确需改上游时，先改上游仓再升级 pin。
- 不把 `MCP_SERVER.md`、`docs/sgmanual/` 等工具手册复制进本仓库；它们随 submodule 更新，复制会漂移。
- 不把 ROM、存档、构建产物纳入版本控制。
