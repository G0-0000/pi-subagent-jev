# Claude Code 适配

本仓另可供 Claude Code 作插件用，复用 CodeBuddy Code 之适配层（`cb/`），
规则、求值链路与审计格式皆同，唯宿主钩子入口变量不同。本档述安装、配置复用与已知限制。

## 安装

```
claude --plugin-dir /path/to/pi-subagent-jev
```

插件清单为 `.claude-plugin/plugin.json`，钩子配置与 CodeBuddy Code 共用 `hooks/hooks.json`，
入口为 `bin/jev-hook`。钩子命令取 `${CLAUDE_PLUGIN_ROOT}/bin/jev-hook`（CodeBuddy ≥2.172.1 与 Claude Code 皆替换或注入该变量），
故同一档可服务两宿主。匹配 `^(Task|Agent)$`：派单工具正名今为 `Agent`（v2.1.63 起），`Task` 存为别名，二者皆中。`PreToolUse` 审核派单，block 命中即
`permissionDecision: "deny"`；`PostToolUse` 以 `additionalContext` 交付 warn 提示。

## 配置复用

规则与上游链单一来源，缺省 `~/.pi/agent/jev-comp`（`JEV_CONFIG_DIR` 可覆写）：

- `compliance-rules.json` — 规则档；`upstreams.json` — 多上游 failover 链（可选）
- `audit.jsonl` — 审计行，另有 `"host": "claude-code"` 一键（由 `CODEBUDDY_PLUGIN_ROOT`／`CLAUDE_PLUGIN_ROOT` 判别）
- `warn/` — warn 模式暂存（TTL 3600s，容量 100 FIFO）

钩子乃独立进程、每次触发重读配置，改档无须重载。环境变量同 pi 侧（见 `docs/codebuddy.md`）。

## Skill

插件附带 `subagent-jev` 技能（`skills/claude/subagent-jev/SKILL.md`）：对 Claude Code 言「配置 subagent 规则」或「subagent-jev」即加载，引导建 env 档、写规则档与试规则。配置与 pi 侧同源（`~/.pi/agent/jev-comp`，`JEV_CONFIG_DIR` 可覆写），唯本宿主无 `jev_ask`，探针与规则试测改走脚本：

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/try-rules.ts --probe
node ${CLAUDE_PLUGIN_ROOT}/scripts/try-rules.ts <agent> "<task>"
```

`--probe` 验端点、key 与模型三通（`--upstream <名>` 可直发单一上游）；agent 形逐问打印概率、阈值、向性、命中、verdict 与拦截文案，缺省干跑、不写运行时档（`--audit` 方追加一行审计）。规则改档即生效（钩子每次新起进程）；插件装卸、重装或升级经 `/plugin` 管理或重启 CLI。

## 已知限制

- **唯 selfhost 传输**：`_global.transport: "builtin"` 被忽略，仍走自管 curl 链。
- **无思考深度调整**、**无运行监控**、**无 `jev_ask` 工具**。
- failover 冷却表为进程内状态，钩子每次新起进程，故不跨进程冷却。

## 验证状态

**未经真实 Claude Code CLI 端到端验证**——实现时本机未装 CLI，唯依官方钩子协议书写，
以 `npm test` 之 `cb/*.test.ts` 单测覆盖宿主判别与审计归属。首次实机使用请留意
钩子是否如期触发。
