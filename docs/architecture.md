# 架构

## 这个仓库解决什么问题

NES 逆向需要两件工具：静态反汇编（SourceGen）和动态调试（Mesen 的 MCP 调试桥），外加一套不能凭感觉走的取证规则。三者分开存放时，换一台机器就要重新找路径、重对齐版本。

本仓库把三者收成一份可 clone 的交付：

- **规则**：`docs/workflow.md` 是工作流全文，工具路径全部写成仓库相对路径。
- **工具**：`third_party/MesenGM`、`third_party/6502bench` 作为 submodule，pin 在 `third_party/pins.json`（与 gitlink 一致）。
- **接入与取证辅助**：`scripts/` 负责构建/定位、握手核验、确定性补丁、金手指编解码、仓库自检。
- **Agent 入口**：`.agents/skills/nes-rom-reversing/` 给智能体一份可加载的作业单。

没有 submodule 之外的外部依赖，也没有机器级路径映射文件。

## 目录

```text
rea-fc/
  README.md                 仓库入口：它是什么、怎么跑起来
  AGENTS.md                 在本仓库工作的智能体的约定
  docs/
    workflow.md             工作流全文（规则）
    installation.md         构建、注册、核验
    cli.md                  命令与退出码
    third-party.md          submodule pin、许可、更新策略
    architecture.md         本文件
    index.md                文档索引
  .agents/skills/nes-rom-reversing/
    SKILL.md                智能体作业单
    references/             工具面与补丁/金手指速查
  scripts/
    rea-fc.mjs              子命令入口
    setup.mjs               构建 / 定位 / 写客户端配置
    verify.mjs              门槛：submodule、桥、握手、实时探测
    patch-rom.mjs           确定性补丁 + IPS 导出
    cheat-code.mjs          Game Genie 编解码与 bank 唯一性
    check-docs.mjs          仓库自检
    lib/                    纯函数库（rom、cheat、mcp、process、tools、cli、config）
  tests/                    node:test 单元与端到端测试
  third_party/
    pins.json               两个 submodule 的 pin（镜像 gitlink）
    MesenGM/                submodule：模拟器 + MCP 桥
    6502bench/              submodule：SourceGen
```

## 数据流

```text
用户目标
  │
  ├─ 规则：docs/workflow.md（证据三态、补丁形态、冷启动验收）
  │
  ├─ 静态：third_party/6502bench/SourceGen/bin/Release/SourceGen.exe
  │        └─ 反汇编工程、交叉引用、符号、字节环回
  │
  ├─ 动态：third_party/MesenGM/bin/win-x64/Release/MCPServer.exe  ──命名管道──  Mesen.exe
  │        └─ 断点、内存读写、推帧、存档 A/B、导出 ROM/IPS
  │
  └─ 产物：scripts/patch-rom.mjs（补丁 + 前后 SHA256 + 修改表）
           scripts/cheat-code.mjs（码 + 校验唯一性证据）
```

`verify.mjs` 位于动态侧入口：它用文件型 stdio 与 `MCPServer.exe` 完成 `initialize`/`tools/list`，因此在禁止命名管道的受限环境里也能证明工具面存在。`tools/list` 的具体内容来自 Mesen 启动时写下的本机缓存，所以一台新机器要先打开一次 Mesen，桥才能离线报出工具清单。

## 关键决策

**为什么用 submodule 而不是复制源码。** 两个工具仓各自有许可、构建系统和上游历史。submodule 保留上游身份（提交、许可、更新路径），同时把版本钉死，clone 结果可复现。

**为什么 pin 同时写进 gitlink 和 `pins.json`。** gitlink 是权威；`pins.json` 让「没有 git 元数据」的场景（源码归档、下载的 zip）仍能核对版本，也让文档不必读 git 才能说出 pin。

**为什么脚本零依赖。** `git clone --recursive` 之后不需要 `npm install` 就能跑，是「clone 下来就能用」的最小成本。代价是不能用现成测试框架与 CLI 库，收益是工具链只依赖 Node 本身。

**为什么补丁脚本拒绝覆盖原 ROM。** 原 ROM 是唯一基线。所有验证都建立在「基线未变」之上，因此在实现层面直接禁止原地写，而不是靠流程约束。

**为什么证据三态出现在规则、脚本输出和交付模板里。** `verify.mjs` 只证明工具面存在，不证明 ROM 行为；`patch-rom.mjs` 只证明字节写对，不证明游戏行为正确。把「已运行」与「已检查」分开写，交付里就不会出现用工具可用性冒充 ROM 结论的情况。

## 扩展点

- 新工具仓：加 submodule + `pins.json` 条目 + `check-docs.mjs` 的一致性检查（自动覆盖）。
- 新校验：`scripts/lib/` 里加纯函数，`tests/` 里加往返或断言测试，CLI 里加薄封装。
- 新平台：Mesen 的 MCP 桥目前只有 Windows 构建；跨平台部分是 SourceGen 与脚本本身，规则文档不绑定平台。
- 新交付格式：在 `scripts/lib/rom.mjs` 增加导出器（例如 UPS/BPS），保持「原 ROM 只读 + 确定性写入」不变。
