# 仓库约定

面向在本仓库里做改动的智能体。产品说明见 [README.md](README.md)，规则全文见 [docs/workflow.md](docs/workflow.md)。

## 权威与边界

- 本仓库是独立交付：不依赖外部材料索引、机器级路径映射或未入库的本地文件。任何新增引用都必须落在仓库内。
- 工具仓是 submodule，pin 是显式事实。不要为了「跑得快」把上游源码拷进裸目录，也不要改 submodule 内文件后继续声称 pin 等于上游。
- 规则文档与工具手册分工：规则写在 `docs/`，工具事实查 `third_party/<tool>/` 的源码与手册。不要在规则文档里复述工具参数。
- 证据三态（实锤 / 推测 / 猜测）出现在代码输出与交付模板里。工具可用性不是 ROM 结论。

## 改动纪律

- 先读触碰面：改脚本前读对应 `scripts/lib/` 模块与 `tests/` 的既有断言；改文档前读同目录相邻文档的文体。
- 新增能力先看能不能复用：`scripts/lib/rom.mjs` 已有 iNES 解析、偏移换算、编辑断言、IPS；`scripts/lib/cheat.mjs` 已有 Game Genie 编解码。新格式先加纯函数再包 CLI。
- 每条新增的机械判别都要有可执行检查：单元测试、`check-docs.mjs` 规则或 CI 步骤，至少一种。
- 不引入运行时第三方依赖。脚本只依赖 Node 内建模块，这是「clone 下来就能跑」的前提。
- 脚本里不写本机绝对路径，不写死用户名或盘符；路径从 `scripts/lib/config.mjs` 推导，机器专属输出只进 `out/`。
- 文档里的外部工具路径用仓库相对路径（`third_party/...`）；不要写外部工作区的占位符或本机路径。

## 命令

```powershell
node --test tests/            # 全部测试
node scripts/check-docs.mjs   # 自检：占位符、外部依赖、本机路径、断链、pin 一致性
node scripts/setup.mjs        # 构建/定位工具并写客户端配置
node scripts/rea-fc.mjs doctor # 逐层诊断，输出断点与下一步
node scripts/verify.mjs       # 桥与工具面证据
node scripts/rea-fc.mjs pins  # 对比或记录 submodule pin（升级后加 --write）
```

工具面以 pinned 提交为准（当前 23 个）；`scripts/lib/mcp.mjs` 的 `CORE_MESEN_TOOLS` 是必须集，`OPTIONAL_MESEN_TOOLS` 只留给本地构建多出的工具。核验只要求核心集，并把多出来的工具单独列出；改工具集合时两处一起改。

`tests/mcp.test.mjs` 在 `MCPServer.exe` 不存在、或本机还没有 Mesen 写出的工具缓存时自动跳过；要让它在 CI 之外真正跑起来，先构建 MesenGM 并打开一次 Mesen。`verify.mjs` 在同样情况下把握手判为降级并给出下一步，而不是伪装通过。

## 交付与提交

- 提交信息用 Conventional Commit 风格（`feat:`、`fix:`、`docs:`、`test:`、`chore:`）。
- 提交前至少跑 `node --test tests/` 与 `node scripts/check-docs.mjs`。
- 断言标注三态：有运行结果支撑的写「实锤」，只读过源码或文档的写「推测」，没验证的写「猜测」。不要把推测写成事实；证据动词（已检查、已运行）可以说清楚依据，但结论仍要落到三态。
- 不提交 ROM、存档、`out/`、`tmp/`、构建产物或任何凭据。

## 文档文体

- `docs/` 是规则与参考文体：现在时、无叙述主体，不写「本轮」「上次」这类过程记录；过程记录去提交信息或 `tmp/`。
- 表格优先承载可判定的约束；一句话能说清的不要拆成一段。
- 新增章节时同步更新 [docs/index.md](docs/index.md) 的入口表。
