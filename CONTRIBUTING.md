# Contributing

本仓库的规则是「可复核」：改动要能被另一个执行者用命令重放。提交前自检：

```powershell
node scripts/reretro.mjs test
node scripts/check-docs.mjs
```

## 改动类型与最低验证

| 改动 | 最低验证 |
|------|----------|
| `scripts/lib/` 纯函数 | 对应单元测试，含往返、边界与错误分支 |
| CLI 脚本 | 端到端测试（临时目录里跑一次真实命令） |
| 文档 | 链接可达、`check-docs` 通过、与代码行为一致 |
| submodule pin | 更新 `pins.json`、重跑 `check-docs`、重新构建并 `verify` |
| 构建/定位逻辑 | 在干净 clone 上跑一次 `setup.mjs`（至少 `--dry-run`） |

## 约定

- 不引入运行时第三方依赖。
- 不写本机绝对路径；机器专属输出只进 `out/`。
- 断言标注三态：有运行结果支撑的写「实锤」，只读过源码或文档的写「推测」，没验证的写「猜测」。
- 提交信息用 Conventional Commit 风格。
- 上游行为问题提给上游仓，不在本仓库内置 fork。

细节见 [AGENTS.md](AGENTS.md)。
