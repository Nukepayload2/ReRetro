# 文档索引

一套规则、两个工具、几个脚本。按任务挑入口：

| 文档 | 什么时候读 |
|------|-----------|
| [workflow](workflow.md) | 要做 ROM 逆向、定位变量、写补丁或金手指、做冷启动验收时。这是规则全文。 |
| [installation](installation.md) | 第一次在这台机器上跑起来：构建工具、注册调试桥、核验工具面。 |
| [emulator-init](emulator-init.md) | 桥已应答但模拟器起不来、载不进 ROM 或收不到按键时：profile 目录、配置文件、原生库、手柄端口。 |
| [cli](cli.md) | 要查命令参数、退出码、输出字段时。 |
| [tool-issues](tool-issues.md) | 工具报错、报「没有」、或语义容易误读时：仍未修的缺陷与绕行规则。修掉的条目不留档。 |
| [third-party](third-party.md) | 关心 submodule pin、许可、升级流程时。 |
| [architecture](architecture.md) | 要改本仓库结构、加脚本或判断证据边界时。 |
| [README](../README.md) | 只想知道这是什么、怎么四步跑起来。 |
| [AGENTS](../AGENTS.md) | 在本仓库里做改动的智能体。 |

最短路径：

1. `git clone --recursive <repo-url> rea-fc`
2. `node scripts/setup.mjs`
3. 把 `out/client-setup.md` 的条目加进 MCP 客户端；`node scripts/rea-fc.mjs emulator provision --rom <rom>` 让模拟器可启动、可按键
4. `node scripts/verify.mjs --live --rom <rom>`

之后按 [workflow](workflow.md) 干活。工具细节查 submodule：`third_party/MesenGM/MCP_SERVER.md`、`third_party/6502bench/docs/sgmanual/`。
