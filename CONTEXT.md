# CONTEXT.md — 术语表

- **Upstream** — name/baseUrl/apiKey/model 齐备之完整端点。
- **Failover** — 按序切换、每级一发、同端不重发。
- **Cooldown** — 连接级败北后进程内冷却跳过、重启即忘。
- **全局规则（`_all`）** — 配置档顶层保留键（同 `_global`/`_questions`，不视作 agent 名），其规则凡派单皆受查（含未配置专属组之 agent）；与各 agent 专属组禁同 id（约定全局规则号、问句号皆以 G 冠之），撞则 agent 专属静默优先（fail-open）。
