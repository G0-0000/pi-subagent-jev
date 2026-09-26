# pi-subagent-jev

A [pi](https://github.com/earendil-works/pi-coding-agent) package that gates subagent dispatches through a JEV System One decision model, plus general-purpose tools to query that model.

## What's inside

One pi extension (`extensions/pi-subagent-jev.ts`), containing:

- **dispatch compliance gate** — subagent dispatch compliance gate. Hooks the `tool_call` event for `subagent` invocations, sends the task text to the JEV System One endpoint for evaluation, and blocks the dispatch if any configured rule fires. The block reason lists every violation message and is returned to the main agent as an error result, so the subagent is never spawned.
- **thin tools** over the JEV client: `jev_ask` (evaluate a batch of typed questions — `noul` / `choice` / `score` — against a state text) and `jev_models` (list connected models on the endpoint).

## Requirements

- pi coding agent
- A reachable JEV System One endpoint, configured via `JEV_AI_BASE_URL` (required — no built-in default; resolution: explicit `baseUrl` param → env `JEV_AI_BASE_URL` → env file). The bundled `subagent-jev` skill can walk you through recording endpoint/model/rule settings
- API key — resolved in order (see `jev/client.ts`): explicit `apiKey` param → env `JEV_AI_API_KEY` → env file (via `envFile` param → `JEV_AI_ENV_FILE` → default `~/.config/jev-comp/env`, stored with 600 permissions)
- `JEV_AI_PROXY` (optional — routes requests through a proxy when explicitly set and the endpoint is not local)
- Default model: `oc/jev-1.13-free`; request timeout: 30 s

## Install

```
pi install git:github.com/G0-0000/pi-subagent-jev
```

For local development:

```
pi install ~/pi-subagent-jev
```

## Configuration

Compliance rules live in `~/.pi/agent/jev-comp/compliance-rules.json`. See [examples/compliance-rules.sample.json](examples/compliance-rules.sample.json):

Full sample (verbatim from [examples/compliance-rules.sample.json](examples/compliance-rules.sample.json), including an example custom agent `reviewer` with a new rule id):

```json
{
  "_global": { "auditProbabilities": false },
  "delegate": {
    "agentDesc": "a file-editing agent without shell access",
    "rules": [
      {
        "id": "R1",
        "instructions": "Does the task give at least one concrete, explicit file path to create or modify?",
        "blockWhen": "below",
        "threshold": 0.7,
        "message": "任务未给出具体文件路径"
      },
      {
        "id": "R2",
        "instructions": "Does the task provide the definite content or exact edits to apply, so the agent need not draft wording itself nor explore to fill gaps?",
        "blockWhen": "below",
        "threshold": 0.7,
        "message": "任务无确定内容"
      },
      {
        "id": "R3",
        "instructions": "Does the task require the agent to execute shell commands, run builds, tests, scripts, or restart or verify services?",
        "blockWhen": "above",
        "threshold": 0.8,
        "message": "任务要求执行 shell 命令/构建测试，delegate 无 bash 权限"
      },
      {
        "id": "R4",
        "instructions": "Does the task require the agent to investigate, explore, or look up information that is not contained in the task itself?",
        "blockWhen": "above",
        "threshold": 0.8,
        "message": "任务要求 agent 自行探索查资料"
      }
    ]
  },
  "reviewer": {
    "agentDesc": "a code-review agent (example: custom agent with a new rule id)",
    "rules": [
      {
        "id": "C1",
        "instructions": "Does the task ask the agent to change public API signatures or break backwards compatibility?",
        "blockWhen": "above",
        "threshold": 0.6,
        "message": "任务可能破坏向后兼容，需人工确认"
      }
    ]
  }
}
```

Each rule has an `id`, `instructions` (the question asked of JEV), a `blockWhen` (`below` / `above`), a `threshold` (0–1 probability), and a `message` returned on violation. Rules are keyed by subagent name; only dispatches to a named agent are evaluated. Rule ids may be any string — new agents and new rules can be defined purely in the JSON file. Merging semantics (`loadRuleSets` in `jev/compliance.ts`): entries override the built-in `RULE_SETS` by agent → rule id, and every field including `instructions` follows the config file (built-ins only supply defaults for rules absent from the file); unknown agents are added as whole groups; the reserved top-level key `_global` holds global switches (`auditProbabilities`, default false — when true, audit lines also record the raw per-rule probabilities under `probs`) and is never treated as an agent; any read/parse error silently falls back to the built-in defaults (fail-open). The file is read once when the extension loads — after editing, run `/reload` in pi for changes to take effect.

## Audit log

Every evaluation — allowed or blocked — is appended to `~/.pi/agent/jev-comp/audit.jsonl` (one JSON object per line; a `blocked` array is present only when the dispatch was blocked, and the key is omitted otherwise).

## Fail-open

If the JEV endpoint is unreachable or not configured, the API key is missing, or the rules file is malformed, dispatches are **allowed through**. The gate never blocks on its own failure.

## Development

```
npm test
```

Runs the test suite with Node's built-in test runner (`node --test`) — no dependency installation needed (zero npm dependencies).

To recalibrate the judge thresholds, see `scripts/calibrate.ts` (it issues real API requests, so it is not run by the tests).

## License

MIT

## 中文文档

pi-subagent-jev 是一个 [pi](https://github.com/earendil-works/pi-coding-agent) 扩展包：以 JEV System One 决策模型为 subagent 派单设卡，并附查询该模型之通用工具。

### 内容

单扩展 `extensions/pi-subagent-jev.ts`，含：

- **派单合规拦截** — 钩 `subagent` 调用之 `tool_call` 事件，把任务文本送 JEV System One 端点求值，命中任一已配规则即拦截派单；拦截原因逐条列出，作为错误结果返给主 agent，subagent 不被派生。
- **薄工具** — `jev_ask`（对 state 文本求值一批类型化问题：`noul` / `choice` / `score`）与 `jev_models`（列端点已连模型）。

### 环境要求

- pi coding agent
- 可达之 JEV System One 端点，以 `JEV_AI_BASE_URL` 配置（必配——无内建默认；解析序：显式 `baseUrl` 参数 → 环境变量 `JEV_AI_BASE_URL` → env 档）。包内 `subagent-jev` skill 可引导录入端点/模型/规则设置
- API key——解析序（见 `jev/client.ts`）：显式 `apiKey` 参数 → 环境变量 `JEV_AI_API_KEY` → env 档（`envFile` 参数 → `JEV_AI_ENV_FILE` → 默认 `~/.config/jev-comp/env`，600 权限）
- `JEV_AI_PROXY`（可选——显式给值且端点非本地时走代理）
- 默认模型：`oc/jev-1.13-free`；请求超时：30 秒

### 安装

```
pi install git:github.com/G0-0000/pi-subagent-jev
```

本地开发：

```
pi install ~/pi-subagent-jev
```

### 配置

合规规则置于 `~/.pi/agent/jev-comp/compliance-rules.json`，完整样例见 [examples/compliance-rules.sample.json](examples/compliance-rules.sample.json)（含自定义 agent `reviewer` 与新规则 id 之例，JSON 内容同英文版，此处不重复粘贴）。

每规则有 `id`、`instructions`（交 JEV 之问）、`blockWhen`（`below` / `above`）、`threshold`（0–1 概率）与 `message`（命中时返回之文案）。规则按 subagent 名分组；唯派单至具名 agent 方求值。规则 id 可为任意字符串——新 agent、新规则皆可纯由此 JSON 定义。合并语义（`jev/compliance.ts` 之 `loadRuleSets`）：按 agent→规则 id 覆盖内建 `RULE_SETS`，`instructions` 等诸字段皆以配置档为准（内建仅补档中未出现规则之缺省）；未知 agent 整组加入；顶层保留键 `_global` 存全局开关（`auditProbabilities`，默认 false——为 true 时审计行附各规则原始概率于 `probs`），绝不视作 agent 名；任何读取/解析错误静默回内建默认（fail-open）。配置档于扩展加载时读一次——改后须在 pi 内 `/reload` 方生效。

### 审计日志

每次求值——放行或拦截——皆追加于 `~/.pi/agent/jev-comp/audit.jsonl`（每行一 JSON 对象；唯派单被拦时含 `blocked` 数组，否则不书此键）。

### Fail-open

JEV 端点不可达或未配置、API key 缺失、规则档损坏时，派单一律**放行**。此卡绝不因自身故障而拦。

### 开发

```
npm test
```

以 Node 内建测试器（`node --test`）跑测试套件——零 npm 依赖，无需安装。

重校准判定阈值见 `scripts/calibrate.ts`（发真实 API 请求，故不入测试）。

### 许可证

MIT
