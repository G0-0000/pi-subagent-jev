# 运行监控（advisory runtime monitoring）

派单闸所管者，派单**之前**也；子 agent 既派，运行中疑似卡死（bash 久悬）、空转（无效工具循环）、无变化重复失败，则派单闸无由见之。2026-10 议增运行监控，于运行途中察此三类迹象，仅提醒主 agent，不代处置。

## 决策

- **仅观察、仅提醒**：命中则向主会话注入规则触发式告警（agent 名＋检测器＋证据＋置信度＋「核查是否正常」建议），主 agent 自决。不打断／不停／不转向／不设新超时／不自动修复。
- **信号唯公开接口**：`pi.events` 之 `subagent:control-event`（needs_attention／tool_open_threshold／tool_failures）＋ RPC `status`（fleet／asyncSnapshot／transcript 文本）。不改 pi-subagents，不为子 agent 加 `subagent_command`，不构造私有 transcript 路径。
- **证据不足即未知**：公共信号不足以确证 → 标「未知」、不告警；后台工具级序列为弱证据。监控一切错误 fail-open（JEV 出错、信号缺失皆静默放行）。
- **触发两线**：事件线（循环／重复失败迹象即问，同迹象同窗口去重）＋时长线（bash 启动满 3 分钟按总耗时首查、合格每 10 分钟复询至其结束；派单最近未获任何检查满 10 分钟兜底巡检）。同一 tick 多项触发合并为一次求值。
- **传输复用 `ask()`**：每级一发、同端不重发、全链败尽 fail-open，与派单审核同红线。

## Considered Options

- **读私有 child transcript（`*_transcript.jsonl`）**：可得更完整之逐工具序列（含 argsPayload、isError），唯其格式属 pi-subagents 实现细节、无兼容承诺，且须自算 session/async 目录。弃之——宁受后台弱证据之限，不绑私有路径。
- **自动处置（interrupt／stop／cancel）**：违「仅观察」之旨，且误报代价高（长编译、合法重试、候 supervisor 输入皆易误判）。告警交主 agent 定夺，上下文在其手。
- **为子 agent 加 `subagent_command` 以启 `command.status`**：须改 12 份 agent profile，且 child-safe fanout 下 yield/cancel 被禁；首版不动 profile。
- **纯事件驱动**：控制事件边沿触发且去重（`claimControlNotification`），非心跳；纯事件不足持续采样，故辅以时长线之有界轮询。

## Consequences

- 默认关闭，行为零变化；opt-in 方启用。
- 后台子 agent 之工具级序列为弱证据，空转／重复失败之检出不及前台；此限由公开接口之界使然，文档明载。
- 依赖 pi-subagents 之 `subagent:control-event` 与 RPC `status` 形状，其版本演进须复核。
