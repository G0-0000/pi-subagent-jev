# CONTEXT.md — 术语表

- **Upstream** — name/baseUrl/apiKey/model 齐备之完整端点。
- **Failover** — 按序切换、每级一发、同端不重发。
- **Cooldown** — 连接级败北后进程内冷却跳过、重启即忘。
- **全局规则（`_all`）** — 配置档顶层保留键（同 `_global`/`_questions`，不视作 agent 名），`rules` 为问句编号数组，所列问句凡派单皆受查（含未配置专属组之 agent，述语写死 `"a sub-agent"`）；与各 agent 组之编号并集去重（全局在前），全局问句号以 G 冠之。
- **问句自含（v0.8.0）** — `_questions` 每条 = 一问＋其判法（instructions/criteria/blockWhen/threshold/message 同居）；agent 组与 `_all` 的 `rules` 唯列问句编号，无内联规则形、无同问异阈。
