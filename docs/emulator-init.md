# 模拟器初始化

调试桥能应答 `initialize` 与 `tools/list`，**不等于**模拟器能启动、能载入 ROM、能收按键。桥在 Mesen 关闭时也能应答（工具清单来自本机缓存），所以「握手通过」这条证据只覆盖桥，不覆盖模拟器本身。本文补齐两者之间的台阶：把一台干净机器上的模拟器配置到「能启动、能载入、能按键」，并给出每一步的判据。

适用对象是 `third_party/MesenGM` 的 `Mesen.exe` + `MCPServer.exe` 组合。行为以 pin 的源码为准（`UI/Program.cs`、`UI/Config/ConfigManager.cs`、`UI/Config/InputConfig.cs`、`UI/UI.csproj`），本文不复述工具参数。

## 四个判据

模拟器侧能不能开始取证，由四项事实决定。任意一项不成立时，后面所有 ROM 结论都只能是 `推测`。

| 判据 | 成立条件 | 不成立时的表现 |
|------|---------|---------------|
| profile 目录 | 已确定，且就是模拟器真正会用的那个 | 配置写到了另一个目录，改了半天没生效 |
| `settings.json` | 存在且能解析 | 每次启动进首次运行向导；或读回的值与写入的不一致 |
| 原生库 | `MesenCore`、`libSkiaSharp`、`libHarfBuzzSharp` 都在 profile 目录里 | 进程启动后立刻退出，stderr 是 `DllNotFoundException` |
| 手柄端口 | `Nes.Port1`/`Nes.Port2` 的 `Type` 不是 `None` | 桥拒绝 `set_input`，报「Controller 0 is not available」 |

一条命令看完四项：

```powershell
node scripts/rea-fc.mjs emulator inspect --rom <rom>
```

`--live` 追加一次 `clear_input`，用桥自己返回的 `available_controllers` 复核端口；退出码 `0` 全通过、`2` 有缺项、`1` 连模拟器可执行文件都没定位到。

## 步骤

### 步骤 1：定位可执行文件与 profile 目录

```powershell
node scripts/rea-fc.mjs emulator inspect --json
```

模拟器的 profile 目录按下列顺序决定，顺序本身是可判定的规则：

| 次序 | 条件 | 采用 |
|------|------|------|
| 1 | 可执行文件同级有 `settings.json` | 可执行文件目录（便携） |
| 2 | `%USERPROFILE%\Documents\MesenCE\settings.json` 存在 | 该目录 |
| 3 | `%USERPROFILE%\Documents\Mesen2\settings.json` 存在且上一级没有 | 该目录（旧版目录） |
| 4 | 以上都没有 | `%USERPROFILE%\Documents\MesenCE` |

`inspect` 会直接给出本次判定的目录与依据。**写配置前先确认这一行**：写错目录的表现是「改了配置、重启后行为没变」，很容易被误判成配置项不起作用。

### 步骤 2：让 profile 可启动

三个子步骤按顺序做，前一个不成立时不要继续。

1. **看进程能不能活下来。** 命令行直接启动，工作目录设为可执行文件所在目录：

   ```powershell
   & "<mesen-dir>\Mesen.exe" "<rom>"
   ```

   进程启动后立刻消失，按 stderr 判因，不要按界面现象猜：

   | stderr 片段 | 判据 | 处置 |
   |---|---|---|
   | `DllNotFoundException` 且路径指向 profile 目录 | 该目录缺原生库 | 见子步骤 2 |
   | 无输出、进程退出 | 首次运行向导在无显示环境下中断 | 见子步骤 3 |
   | `Unhandled exception ... SkiaSharp` | 同上，绘图后端在向导之前就需要原生库 | 同上 |

2. **补齐原生库。** 这些库由模拟器从 profile 目录加载，不是从可执行文件目录加载；可执行文件目录通常已经有它们，复制即可。从源码构建的产物可能整包都不含这些库：构建脚本在编译前打包依赖归档，首次构建时输出目录里还没有这几个文件，复制失败被忽略，归档里就少了它们。判据是可执行文件目录里有、profile 目录里没有。

   `node scripts/rea-fc.mjs emulator provision` 会做这次复制；重建工具后仍缺，说明构建产物本身不完整，重新构建后再跑一次。

3. **写最小的 `settings.json`。** 该文件存在就不会进首次运行向导，其余配置项缺失时按默认值补齐。判据是重启后进程存活、且没有弹出需要人点的窗口。

   文件可能带 UTF-8 BOM——模拟器自己写出时会带，读回时按 BOM 检测处理。手工解析这份文件时先去掉 BOM，否则严格的 JSON 解析器会报 `Unexpected token`，而这个报错并不代表配置坏了。

### 步骤 3：配置手柄端口

端口默认是 `None`，向导之外的路径（手写的 `settings.json`、便携目录）不会自动初始化它。判据是 `inspect` 显示的 `Port1=NesController`，或 `--live` 返回的 `available_controllers` 非空。

`emulator provision` 只替换 `None` 与缺失的端口，已配置的设备保持原样，其余配置项原样保留并写回。

### 步骤 4：启动并载入 ROM

- 用命令行把 ROM 作为参数传进去；工作目录设为可执行文件所在目录，否则相对路径与默认目录会落到别处。
- 模拟器是单实例的：已有进程在跑时再启动，新进程会把参数交给已有实例，不要据此判断「载入失败」。
- 用桥载入时走 `load_rom`（绝对路径）；`load_rom` 与界面载入互斥，两者都会替换当前 ROM 并影响同一实例上的其他客户端。
- 载入后复核 `get_rom_info`：`format` 不是 `Unknown`、`rom_path` 是目标 ROM、`memory_types` 里能看到本次要用的内存区 ID。

### 步骤 5：核验输入与推帧

| 检查 | 调用 | 判据 |
|------|------|------|
| 输入可用 | `clear_input`（控制器 0） | 返回的 `available_controllers` 非空 |
| 按键生效 | `set_input` + `run_frames` + `get_screen` | 画面随按键改变；只有 `set_input` 成功不算证据 |
| 推帧有效 | `run_frames` | `frames_elapsed` 等于请求值 |

`run_frames` 可能返回 `timed_out` 且 `frames_elapsed` 为 `0`：请求在服务端 7 秒预算内没等到恢复运行，帧一帧都没走。此时按键仍处于按下状态，紧接着的 `clear_input` 会把这次按键吞掉，表现为「按了没反应」。处理方式是原样重试同一次请求，拿到帧数后再释放按键；不要因为一次 0 帧就判定游戏不响应输入。

### 步骤 6：一条命令补齐（可选）

```powershell
node scripts/rea-fc.mjs emulator provision --rom <rom>
```

写 `settings.json`、补端口、按需复制原生库，输出下一步命令。只改可执行文件所在目录与 profile 目录下的配置与库文件；不写 ROM、不写存档、不碰 submodule 的跟踪文件。

## 失败对照

| 症状 | 先查 | 处置 |
|------|------|------|
| 桥握手绿、模拟器起不来 | profile 目录与原生库 | `emulator inspect`；`emulator provision` |
| 改了配置、重启无变化 | 写入的目录是否等于判定的 profile 目录 | 按步骤 1 重判 |
| `set_input` 报「Controller 0 is not available」 | `Nes.Port1` 的 `Type` | `emulator provision`，重启模拟器 |
| 按键成功但画面不动 | 是否在同一次调用里推了帧；`run_frames` 是否 0 帧超时 | 重试推帧，见步骤 5 |
| 工具调用超时 | 模拟器停在自己的调试器或模态窗口 | 恢复执行、关掉对话框后重试 |
| 载入后 `rom_path` 是别的 ROM | 同一实例上的其他客户端切换过 ROM | 重新 `load_rom` 或界面载入，再复核 |

## 与其它层的关系

- 本文只解决「模拟器能用」。桥的工具面与握手归 `node scripts/verify.mjs`；分层诊断归 `node scripts/rea-fc.mjs doctor`。
- `verify` 与 `doctor` 都包含模拟器层：`emulator-setup`（profile、配置文件、原生库、端口）与 `input-probe`（实时端口）。握手通过而模拟器层降级，是「桥绿但取不到证据」的典型状态。
- 任一层降级时，ROM 行为结论一律标 `推测`；补齐并重跑核验后才可以升级为 `实锤`。
- 环境事实会随会话失效：换模拟器构建、换 profile 目录、重启模拟器后都要重新核验，不能沿用上一轮的结论。
