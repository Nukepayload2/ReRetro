# Mesen 调试桥工具面

pinned 的 MesenGM（见 `third_party/pins.json`）注册 16 个工具，实现在 `third_party/MesenGM/UI/Debugger/Utilities/McpDebugService.cs`；说明见 `third_party/MesenGM/MCP_SERVER.md`，参数细节见 `third_party/MesenGM/MCPServer/skills/mesengm-mcp/references/tool-details.md`。工具名与语义以那两份与运行时返回为准。

工具清单由 Mesen 在启动时写入本机缓存，桥在没有 Mesen 时靠缓存离线应答 `tools/list`。新机器先打开一次 Mesen；本机若用自己构建的开发版 Mesen，工具面可能多于这 16 个。

## 读状态

| 工具 | 用途 | 注意 |
|------|------|------|
| `debugger_status` | 模拟器与调试器状态 | 握手成功不代表 ROM 在跑；区分 `execution_stopped` 与 `emulation_paused` |
| `get_rom_info` | `console_type`、`rom_path`、`format`、`cpu_types`、`memory_types`（ID、名称、大小） | 没有 `rom_loaded` 字段：`format` 为 `Unknown` 表示没有 ROM；内存区 ID 一律取自本次返回 |
| `get_cpu_state` | CPU 寄存器或当前 PC | NES/SNES/GB 为结构化寄存器，其它 CPU 可能只有 PC |
| `get_ppu_state` | 扫描线、周期、帧状态 | 仅 NES/SNES/GB |
| `get_screen` | 最近一帧 PNG | 停机时看到的是最后完成帧，不是实时解码结果 |

## 内存

| 工具 | 用途 | 注意 |
|------|------|------|
| `get_memory_range` | 读最多 4096 字节，参数 `memory_type`、`start_address`、`length`、`format` | 单次上限内拆分；不构成跨调用原子快照 |
| `search_memory` | 按字节模式搜索，`??` 为单字节通配 | 优先于整段 dump |
| `set_memory` | 写最多 4096 字节 | 走批量内存写路径，不模拟 CPU 写副作用；不替代对 mapper/APU/PPU 寄存器的写入 |

## 执行控制与断点

| 工具 | 用途 | 注意 |
|------|------|------|
| `set_breakpoints` | 整体替换断点列表 | 会清掉其它客户端的断点；空数组即清空；没有读断点列表的工具 |
| `pause` / `resume` / `step` | 单步与继续 | `step` 返回时执行未必已完成，先看 `debugger_status` |

## 轨迹与反汇编

| 工具 | 用途 | 注意 |
|------|------|------|
| `get_disassembly` | 地址附近的指令 | 只做就近指令边界核对，不替代 SourceGen |
| `get_trace_tail` | 最近执行轨迹 | 空轨迹不证明没执行过；该工具集没有轨迹配置工具 |
| `get_debug_events` | 最近的调试事件 | 计数恒为 0 时改用帧轮询，并在交付里注明证据类型 |

## 导出

| 工具 | 用途 | 注意 |
|------|------|------|
| `save_rom` | 把模拟器当前 ROM（含内存改动）导出为 ROM 或 IPS | 不是存档工具；导出前确认目标路径与意图 |

## 界面侧动作

pinned 版本没有载入 ROM、存档/读档、手柄输入覆盖、按帧推进、关闭 ROM 的工具，这些都在 Mesen 界面里做：

- 载入 ROM、套用 IPS/UPS/BPS：Mesen 的打开/补丁流程。
- 存档、读档、快进：Mesen 的存档功能，用于导航和 A/B；不能单独证明补丁有效。
- 手柄输入：键盘/手柄直连；没有输入覆盖时要显式记录按了哪些键。
- 逐帧推进：Mesen 调试器的帧步进，配合 `get_cpu_state` 与 `get_memory_range` 做帧轮询。
- 金手指清单：Mesen 的 cheats 界面，改完重新载入 ROM 才生效。

## 语义要点

- 读多个相关变量时，先在 Mesen 里暂停，再连续读；跨调用读数不是同一瞬间。
- 内存编辑后先读回确认；`save_rom` 是导出，不是验证。
- 工具报错先读错误本体：桥未连上、Mesen 停在模态窗口、参数用了不存在的内存区，三者处理不同。
- 一次工具调用失败不等于补丁失效；先确认调用本身成功。
