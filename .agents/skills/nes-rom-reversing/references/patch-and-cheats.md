# 补丁与金手指速查

规则在 `docs/workflow.md`；这里只放执行时必须逐项过的东西。

## 补丁形态决策

| 形态 | 何时用 | 风险 |
|------|--------|------|
| 窄路径代码钩子 | 目标动作有稳定指令点，且该点不被其它路径共享 | 最低 |
| 独占数据表修改 | 只有目标路径读该表，且冷启动验证通过 | 中 |
| 全局表 / 全局读取覆盖 | 探索或显示型数值 | 高；不得用于实体状态、初始化变量、弹道、物品状态 |

金手指优先能改变 ROM 行为的最小写入；不要对状态变量做持续读取覆盖。

## 补丁命令

```powershell
node scripts/reretro.mjs patch `
  --rom roms/game.nes `
  --out out/game.patched.nes `
  --edit 0x15A2:EA:AD:skip-decrement `
  --ips out/game.ips `
  --bank 0 --bank-cpu-start 0x8000 --bank-size 0x4000
```

字段：

- `--rom` 原 ROM，只读；`--out` 新文件，已存在时需 `--force`，与 `--rom` 相同则直接失败。
- `--edit <offset>:<old>:<new>[:note]`：`offset` 是文件偏移（十进制或 `0x` 十六进制），`old`/`new` 是十六进制字节串；`old` 不匹配即整批失败。
- `--ips` 生成 IPS；IPS 只是交付格式，权威产物是这条命令的重放结果。
- `--bank` / `--bank-cpu-start` / `--bank-size` 把文件偏移标注为 CPU 地址；不在所选 bank 内时显示 `n/a`。
- `--dry-run` 只校验不落盘；`--json` 输出 `edits`、`sha256.before/after`、`verified`、`originalUnchanged`。

## 钩子检查表

- [ ] `JMP` 三字节落在完整指令边界。
- [ ] 代码洞同 bank、连续 `FF`、长度留余量。
- [ ] 没覆盖 bank ID、向量、代码或数据。
- [ ] 被替换指令在代码洞里按原语义执行。
- [ ] 分支偏移按新地址重算。
- [ ] 跳回原指令的下一条。
- [ ] 栈平衡，无未配对 `JSR`/`RTS`。
- [ ] 守卫用控制标志，不硬编码实体编号。
- [ ] 写入宽度正确，无零页回绕与高低字节错位。
- [ ] 下游状态更新没被提前 `RTS` 跳过。

## Game Genie

- 6 位码 = 地址 + 值；8 位码 = 地址 + 值 + 校验值。
- 校验值语义是条件替换：CPU 读到的当前值等于校验值时才替换；不匹配就静默失效。
- 码拦截的是 CPU 读取，不改 ROM 文件；同一 CPU 地址在任何 bank 映射下都被命中。
- 固定 bank（通常 `$C000-$FFFF`）安全；可切换窗口（通常 `$8000-$BFFF`）的码会命中所有 bank 的同偏移，必须带校验值。
- 校验值唯一性证据：

```powershell
node scripts/reretro.mjs cheat check --rom <rom> --address <cpu-address>
```

输出每个 PRG bank 在该偏移的原始字节；只有目标 bank 等于校验值才可用。

- 编解码与位序以 `third_party/MesenGM/Core/Shared/CheatManager.cpp` 为准；`scripts/lib/cheat.mjs` 是同一套位序的可执行副本。
- 生效核验双读：CPU 视图为新值、PRG ROM 视图为原值。
- 清单只在载入 ROM 时应用，改完要重新载入再验。
- 同一地址只放一条码；多字节改动每条各自带校验值。

## 交付

补丁交付：原/新 ROM 路径与 SHA256、修改表、冷启动路径、写入点与值、重复次数、回归结果、回滚、未决。
金手指交付：码与解码结果、逐 bank 原始字节、双读结果、重载步骤、对照组结果、回滚。
