# CONTEXT.md — 术语表

- **Upstream** — name/baseUrl/apiKey/model 齐备之完整端点。
- **Failover** — 按序切换、每级一发、同端不重发。
- **Cooldown** — 连接级败北后进程内冷却跳过、重启即忘。
- **全局规则（`_all`）** — 配置档顶层保留键（同 `_global`/`_questions`，不视作 agent 名），`rules` 为问句编号数组，所列问句凡派单皆受查（含未配置专属组之 agent，述语写死 `"a sub-agent"`）；与各 agent 组之编号并集去重（全局在前），全局问句号以 G 冠之。
- **问句自含（v0.8.0）** — `_questions` 每条 = 一问＋其判法（instructions/criteria/blockWhen/threshold/message 同居）；agent 组与 `_all` 的 `rules` 唯列问句编号，无内联规则形、无同问异阈。
- **Warn 观察模式（v0.9.0）** — 模式 `"block"`（缺省，硬拦）／`"warn"`（命中不阻断，违规清单经 `tool_result` 钩追加于该次 subagent 工具结果之末：异步随启动回执、阻塞随最终输出；audit 行另加 `action:"warn"`）。`_global.mode` 为全局缺省，组级 `mode` 覆盖之（resolveMode：组＞全局＞block）。
