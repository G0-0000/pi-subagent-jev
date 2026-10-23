# CodeBuddy Code 适配

本仓除 pi 扩展外，另含一套 CodeBuddy Code 插件适配：复用同一套规则配置、求值链路与审计格式，
唯宿主钩子面不同。本档述安装、配置复用、环境变量与已知限制。

## 安装

持久安装（校验、加入、启用；幂等可重跑）：

```
bash scripts/install-codebuddy.sh
```

脚本**缺省以项目范围（project scope）安装**——插件唯对本仓库生效。欲对所有项目生效，运行前设
`JEV_PLUGIN_SCOPE=user` 即可。因项目范围绑定当前工作目录，脚本先 `cd` 到仓库根再执行 codebuddy 命令，
故在任意目录下调用本脚本皆可。安装后本地启用态落于 `.codebuddy/`，该目录已入 `.gitignore`，
属本地状态、不入库。

脚本将仓库快照入 `~/.codebuddy/plugins/cache`——编辑仓库后须**重跑本脚本**方使快照更新，
再于 CodeBuddy 内执行 `/reload-plugins`（或重启）生效。插件附赠 `subagent-jev` skill
（`skills/codebuddy/subagent-jev/SKILL.md`），随安装一并入快照。

开发/测试期直载工作区（不入插件缓存）：

```
codebuddy --plugin-dir /path/to/pi-subagent-jev
```

插件清单为 `.codebuddy-plugin/plugin.json`，钩子配置为 `hooks/hooks.json`，入口为可执行档
`bin/jev-hook`（Node，直跑 `.ts`，零 npm 依赖）。钩子匹配 `^(Task|Agent)$`：

- `PreToolUse` → `bin/jev-hook pre`（30s 超时）：派单审核，block 模式命中即
  `permissionDecision: "deny"`。
- `PostToolUse` → `bin/jev-hook post`（15s 超时）：warn 观察模式之提示以
  `additionalContext` 追加于该次派单结果。

二者皆恒 exit 0、stdout 至多一个 JSON 对象；任何错误 fail-open（放行）。

## 配置复用

规则与上游链与 pi 侧同源，缺省目录 `~/.pi/agent/jev-comp`：

- `compliance-rules.json` — 规则档（`_global` / `_questions` / `_all` / 各 agent 组，语义与 pi 侧全同）
- `upstreams.json` — 多上游 failover 链（可选；缺档回单端点链路）
- `audit.jsonl` — 审计行，形状与 pi 侧同，另有 `"host": "codebuddy"` 一键
- `warn/` — warn 模式暂存（一 key 一档，TTL 3600s，容量 100 FIFO）

`JEV_CONFIG_DIR` 可覆写配置目录（测试、多实例或独立规则集用）；未设或空白时回缺省。
钩子乃独立进程、每次触发重读配置，故改档**无须** `/reload`，下次派单即生效。

## Skill

插件附带 `subagent-jev` 技能（`skills/codebuddy/subagent-jev/SKILL.md`）：对 CodeBuddy 言「配置 subagent 规则」或「subagent-jev」即加载，引导建 env 档、写规则档与试规则。配置与 pi 侧同源（`~/.pi/agent/jev-comp`），唯本宿主无 `jev_ask`，探针与规则试测改走脚本：

```
node ${CODEBUDDY_PLUGIN_ROOT}/scripts/try-rules.ts --probe
node ${CODEBUDDY_PLUGIN_ROOT}/scripts/try-rules.ts <agent> "<task>"
```

`--probe` 验端点、key 与模型三通（`--upstream <名>` 可直发单一上游）；agent 形逐问打印概率、阈值、向性、命中、verdict 与拦截文案，缺省干跑、不写运行时档（`--audit` 方追加一行审计）。规则改档即生效（钩子每次新起进程）；插件本体重装或升级后方须 `/reload-plugins`。

## 环境变量

与 pi 侧相同（见 `jev/client.ts` 之解析链）：

- `JEV_AI_API_KEY`、`JEV_AI_BASE_URL`（必配）、`JEV_AI_MODEL`（可选）、`JEV_AI_PROXY`（可选）
- `JEV_AI_ENV_FILE` — env 档路径（缺省 `~/.config/jev-comp/env`，600 权限）

key 绝不入仓、入日志、入错误文本；审计与警告文案皆不含 key 与完整 baseUrl。

## 行为

| 模式 | PreToolUse | PostToolUse |
| --- | --- | --- |
| `block`（缺省） | 命中即 deny，reason 同 pi 扩展之文案 | 无操作 |
| `warn` | 不拦，提示暂存于 `tool_use_id`（缺则 `call_id`） | 取回并删除，附 `additionalContext` |

空任务、非 `Task`/`Agent` 工具、无适用规则、JEV 错误、坏 stdin、缺标识 —— 皆放行。

## 已知限制

- **唯 selfhost 传输**：`_global.transport: "builtin"` 在 CodeBuddy 侧被忽略，仍走自管 curl 链。
- **无思考深度调整**：`_global.thinkingDepth` 不生效。
- **无运行监控**：监控唯 pi 主会话武装，CodeBuddy 侧无 tick。
- **无 `jev_ask` 工具**：批二或将经 MCP 补足。
- `JEV_CONFIG_DIR` 只覆写规则/上游/审计/警告目录；env 档与 `training.jsonl` 仍循 pi 缺省路径。
- `session` 子命令本批为占位（恒放行），主会话治理留待批二。
- Node ≥ 22.6（原生 TS 类型剥离）；本机 v24.19.0 实测。
- failover 冷却表为进程内状态，钩子每次新起进程，故不跨进程冷却（与 pi 侧不同）。
- warn 命中而钩子输入无 `tool_use_id`/`call_id` 时，提示静默丢弃（fail-open）。

## 测试

```
npm test
```

`cb/*.test.ts` 以注入 `askFn` 与临时配置目录覆盖放行、拦截、warn 落取、过期、缺键、
坏 stdin、JEV 错误与缺规则诸径，不发真实请求。
