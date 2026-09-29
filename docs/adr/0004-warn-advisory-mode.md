# Warn 观察模式（advisory mode）

派单闸初版唯硬拦一途：命中规则即 `{block:true}`，subagent 不派生。2026-09 议增 advisory 模式，为新用户「试水」与未校准规则留观察期（治理类工具通行之 enforce / observe 两档）。

## 决策

- 配置两层：`_global.mode`（缺省 `"block"`）与各组可选 `mode`，取值唯 `"block" | "warn"`（非法值静默回 block）；有效模式＝组级显式 ＞ 全局 ＞ block，归并为纯函数 `resolveMode`。两层同做，归并仅一行。
- **block**：今日之硬拦，形状不变（默认值，向后逐字节兼容）。
- **warn**：`tool_call` 命中时不阻断，以 `toolCallId` 暂存违规清单（有界 Map，容量 100 FIFO）；新注册 `tool_result` 钩按 id 取回，将警告作为末位 text 段追加于该次 `subagent` 工具结果——异步派单随「已启动/run id」回执同条到达（及时、可 interrupt），阻塞派单随子 agent 最终输出同条到达（事后复核）。
- 审计：warn 命中之行仍记 `verdict:"violation"` 与 `blocked` 编号，另加 `action:"warn"`；block/pass/error 行形状不变。

## Considered Options

- **只做全局或只做组级**：归并成本约零（一行三元），两层俱留——全局养「一键观察期」，组级养细配。
- **warn 按派单 async/block 分流（阻塞强制仍拦）**：须解析显式 `async`＋`asyncByDefault` 配置＋`clarify`，复杂易错；而一套机制下警告到达时机本随派单态自明，无须代码特判。文档明诫「阻塞 warn 乃事后之鉴」即可。
- **警告另发 `pi.sendMessage`**：不如并入同一条工具结果干净（异步完成通知走 pi-subagents 私有 sendMessage 链，外部 `tool_result` 钩触不到，强行订阅私有事件频道属 hack）。
- **警告前置**：否决——异步回执首行 `Async: <agent> [<id>]` 系约定头行，前置恐妨解析；末位追加自带分隔，安全且醒目。

## Consequences

- 默认行为零变化；warn 为纯增量。
- warn 下破坏性操作可能已执行（阻塞尤甚）——模式选择由配置者自负，文档建议只读类组先用。
- `tool_result` 为 pi 0.99.0 既有钩子，升级 pi 后须复核。
