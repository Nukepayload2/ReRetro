---
name: nes-rom-reversing
description: NES/6502 ROM reversing and permanent patches through the MesenGM MCP debugger and the 6502bench SourceGen workbench. Use for finding the code that owns a state value, proving it with breakpoints or frame polling, writing a minimal ROM hook or a Game Genie code, and validating with a cold start. Not for developing the emulator, the bridge, or the disassembler.
metadata:
  version: "1"
---

# NES/6502 ROM 逆向

规则全文在 `docs/workflow.md`；工具参数查 `third_party/MesenGM/MCP_SERVER.md` 与 `third_party/MesenGM/MCPServer/skills/mesengm-mcp/references/tool-details.md`；静态分析查 `third_party/6502bench/docs/sgmanual/`。本文件是作业单，不替代规则。

## 输入

- 目标 ROM 与期望效果（可观察、可验收的行为或数值）。
- 可复现的进入路径（标题、菜单、关卡）。
- 可用的反汇编工程或符号表；没有则先用 SourceGen 建。

## 产出

- 最小化永久补丁 ROM，或带校验值的 Game Genie 码。
- 原 ROM / 补丁 ROM 的 SHA256、文件偏移、CPU 地址、原字节、新字节。
- 冷启动验证记录（写入点、写入值、重复次数、回归项）。
- 回滚说明与未决风险，逐条标注 `实锤` / `推测` / `猜测`。

## 任务账本

上下文被压缩、换会话、或连续两次在同一处返工时，第一件事是读 `tmp/ledger.md`（本地草稿区，git-ignored），再动手。

账本形状按 `Catalysts/Storage.md`，不写自由格式笔记：

| 字段 | 内容 |
|------|------|
| 任务片段 `E-nnn` | 一个目标 + 一个验收边界；状态（进行中/完成/未开始）与结果 |
| 失败点 `F-nnn` | 症状 → 原因（标注证据态）→ 之后必须遵守的规则 |
| 地址表 | 已定位的 RAM 地址、含义、证据态；未定位的写「未定位」，不写猜测值 |
| 存档索引 | 每个即时存档的帧号、位置、**可用性结论**（回读后按键是否产生 RAM 差分） |
| 下一步 | 只留一条，可执行到能观测 |

纪律：每完成一步整篇重写账本；只写状态摘要与结论，不复制原始日志或命令输出；不写机器绝对路径。

## 1. 先过环境门

```powershell
node scripts/verify.mjs
node scripts/reretro.mjs doctor --live --rom <rom>
```

- 桥必须以 MCP 服务器形态注册进当前客户端，取证走客户端托管的常驻 stdio 会话；仓库脚本里的批处理客户端只做核验（每批拉起一个桥进程，单次调用约 1.6 s），不要用它逐帧轮询。
- 只有 `bridge-handshake` 通过，才允许做动态取证；通过只证明工具面可达，不证明目标 ROM 已载入。
- 握手不覆盖模拟器：模拟器层（profile 目录、`settings.json`、原生库、手柄端口）与 `input-probe` 也要过。哪一层没过按 `docs/emulator-init.md` 补齐，`node scripts/reretro.mjs emulator provision` 一次写配置、补端口、复制原生库。
- 工具清单要 Mesen 至少启动一次才有缓存；报「Mesen is not running」时先打开 Mesen，再重跑核验。
- 要证明「载入的是目标 ROM」，用 `node scripts/verify.mjs --live --rom <rom>`；`--rom` 只比对 `rom_path`。
- `run_frames` 报 `timed_out` 且 `frames_elapsed` 为 `0` 时原样重试，不要先释放按键：按键会被释放吞掉，表现成游戏不响应输入。
- 门没过时不进入 ROM 分析，也不要用自制脚本顶替缺失的工具。结论上限：推测。

## 2. 固定基线

```powershell
node scripts/reretro.mjs info <rom>
```

记录 PRG/CHR 大小、mapper、镜像方式、SHA256、文件大小；复制到只读基线；补丁一律写到新文件。把目标改写成含变量、写入点、值、观测方式的可验收断言，不写「效果变强」。

## 3. 静态定位（SourceGen）

- 在 SourceGen 里建可复现工程（CPU 选型、入口点、分析范围），不手工拼反汇编。
- `SourceGen.exe` 只接受一个参数，且必须是已有的 `.dis65` 工程：没有 headless 模式，从 ROM 建工程、分析、导出汇编都只能走界面。命令行分析改用 `node scripts/reretro.mjs sourcegen`（参数见 `docs/cli.md`），它把 PRG bank 切片后交给同一份分析代码；两者都不需要时就退回调试桥的 `get_disassembly`，并在交付里注明「无工程、无符号、无交叉引用」。
- 给目标 bank 的例程、数据表、RAM 变量建符号，符号名要能直接用于断点与补丁脚本。
- 用交叉引用视图找出所有读取者、写入者、初始化者、每帧更新者。
- 导出汇编做字节环回：装配结果与原 PRG 逐字节一致，否则边界划分有误。
- 位置分三类：初始化写入（影响开局）、每帧写入（影响移动/碰撞/AI）、目标动作瞬间写入（钩子最佳落点）。

## 4. 动态取证（Mesen 调试桥）

- `get_rom_info` 取 `memory_types`，不要凭记忆填内存区 ID；PRG ROM 与内部 RAM 分开用。
- 在目标变量上设写断点，记录命中时的 `PC`、`A/X/Y`、旧值与新值。断点列表是整体替换，设置前先确认当前列表。
- 在候选例程设执行断点，确认实际走的分支，而不是只看最终画面。
- 断点或轨迹不工作时不要停等修复：逐帧推进、读关键变量，按「值变化的那一帧」定位，交付里注明这是轮询证据。
- 写断点设上了、事件却恒为空时，先确认断点带 `mark_events`（默认真）且地址口径对得上，再改走静态路径：变量地址 → `sourcegen xref --all-banks --writes-only` → 命中偏移还原 CPU 地址 → `sourcegen line` 或 `get_disassembly` 读上下文。`xref` 会解码未分类字节，`tier=raw` 是「代码确实存在但分析没走到」的那一类；`indirect: true` 报的是指针槽位，不是目标。扁平 PRG 搜 `8D/8C/9D <lo> <hi>` 只用来独立复核某条命中。不要用值变化的帧号代替写入指令。
- 解释 `$8000-$BFFF` 前先确认当前 bank：取足够长的字节串与各 PRG bank 比对，再换算 bank 内偏移。
- 直接改 PRG 内存只对当前进程有效；A/B 之前重新写入并读回。

## 5. 选形态

风险从低到高：窄路径代码钩子 → 独占数据表修改 → 全局表/读取覆盖。永久交付优先 ROM 补丁；金手指适合探索，但可切换区的码必须带校验值，且先确认该偏移在各 bank 唯一。

## 6. 生成补丁

```powershell
node scripts/reretro.mjs patch --rom <rom> --out <patched> --edit <offset>:<old>:<new>:<note> --ips <file>
```

脚本会断言原字节、写入、读回、给出前后 SHA256，并拒绝覆盖原 ROM。钩子自身要满足：`JMP` 落在指令边界、代码洞同 bank 且连续 `FF`、保留被替换指令语义、分支偏移重算、跳回原指令的下一条、栈平衡。

金手指：

```powershell
node scripts/reretro.mjs cheat check --rom <rom> --address <cpu-address>
node scripts/reretro.mjs cheat encode --address <cpu> --value <v> --compare <c>
```

## 7. 冷启动验收

完全重置 → 从标题手动进入 → 测未触发效果的基础行为 → 触发目标动作并核对写入点 → 核对下游效果 → 跑对照组（补丁关掉、同输入同帧数）→ 重复 10 次记命中率 → 回归 CPU/AI、关卡进出、菜单 → 再做一次完整冷启动。

只有走完这些，结论才能标 `实锤`。

## 8. 交付

给出原/补丁 ROM 路径与 SHA256、修改表（文件偏移/CPU 地址/原字节/新字节/作用）、写入点与写入值、重复次数、回归结果、回滚方式、未决风险。只交付金手指时给出码、解码结果、逐 bank 原始字节、双读结果、重载步骤、对照组结果。

## 硬性禁止

不覆盖原 ROM；不用即时存档单独证明有效；不把 CPU 地址当文件偏移；不在可切换区用无校验码；不对实体状态做全局读取覆盖；不拆断点未检查的共享表；不把屏幕效果当状态证据；不隐藏未验证项；不在工具未就绪时用自制脚本凑证据。

另外五条来自实测返工：

- 不让模拟器在无观测的情况下自由运行：无人值守只会把角色推到死亡。
- 不用「贴脸几帧变量没变」否定一次事件：判定动作是否发生，用整段状态差分或断点证据，不用单字节窗口。
- 不把同一个判断写成第二套工具：MCP 已经是驱动通道，不再造平行 CLI。
- **工具返回 0 条不等于不存在**：`xref` 未命中只能写「未检出」。排除整类方案（例如「没有现成门控」）之前必须先做一次独立复核——扁平字节搜、`--code-only` 与默认结果的差、`indirect` 命中的分组——并在交付里写明复核方式。把排除性结论建立在单条工具断言上，是最贵的一类错误。
- **跳过写入不等于状态不变**：把「设置速度/位置」的指令跳过后，上一次的值仍然生效。要让角色停住，先找 ROM 里现成的**状态门控**——形如 `LDA $<状态字段> / CMP #<$值> / BNE / STA $<速度字段>`，改它的比较立即数即可覆盖新状态；确认没有现成门控之后，才考虑代码洞、计时器或 NMI 钩子。搜索顺序：状态字段的比较立即数 → 邻近的速度/位置清零写。


## 参考

- `references/mesen-tool-surface.md` — pinned 版本的 23 个工具、界面侧兜底与危险动作
- `references/patch-and-cheats.md` — 补丁/金手指检查表与脚本字段
