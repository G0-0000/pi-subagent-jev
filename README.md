# pi-subagent-jev

A [pi](https://github.com/earendil-works/pi-coding-agent) package that gates subagent dispatches through a JEV System One decision model, plus general-purpose tools to query that model.

> **Currently only supports pi + pi-subagents** — the dispatch gate hooks the `subagent` tool provided by the pi-subagents package.

## Features

- **Dispatch compliance gate** — when the main agent dispatches a subagent, the task text is sent to the JEV System One endpoint for evaluation. If any configured rule fires, the dispatch is blocked: every violation message is returned to the main agent as an error result, and the subagent is never spawned.
- **`jev_ask` / `jev_models` tools** — query the decision model directly. `jev_ask` evaluates a batch of typed questions (`noul` / `choice` / `score`) against a state text; `jev_models` lists the models connected to the endpoint.
- **Bundled `subagent-jev` skill** — walks you through recording endpoint/model settings and per-subagent compliance rules.

## Requirements

- pi coding agent **with the pi-subagents package** (the gate hooks its `subagent` tool)
- A reachable JEV System One endpoint and an API key

## Install

```
pi install git:github.com/G0-0000/pi-subagent-jev
```

Then create the env file `~/.config/jev-comp/env` (permissions 600):

```
JEV_AI_API_KEY=your-key
JEV_AI_BASE_URL=https://your-jev-endpoint
JEV_AI_MODEL=optional-model-override
```

`JEV_AI_API_KEY` and `JEV_AI_BASE_URL` are required; `JEV_AI_MODEL` is optional (default `oc/jev-1.13-free`). Run `/reload` in pi (or restart) to pick it up.

Rather not edit files by hand? Just ask pi to 配置 subagent 规则 — the bundled skill will guide you (see below).

## Usage

### Dispatch gate

Nothing to do — once installed and configured, every subagent dispatch is evaluated automatically. A blocked dispatch returns the violation list to the main agent.

> **Breaking change in v0.8.0** — the rules-file schema changed: each `_questions` entry is now self-contained (`blockWhen` / `threshold` / `message` moved into the question), and each group's `rules` is an array of question-id strings; the v0.7 `{id, question, …}` rule objects no longer load (migrate via the skill). Also, since v0.7.0 the code ships no built-in rules — an install without `compliance-rules.json` performs no checks at all.

Rules live in `~/.pi/agent/jev-comp/compliance-rules.json` (schema sample: [examples/compliance-rules.sample.json](examples/compliance-rules.sample.json)). The top-level `_questions` map holds one **self-contained** entry per question: `{ label?, instructions, criteria?, blockWhen, threshold, message }` — the question text, optional `{true, false}` answer-branch guides, the polarity (`below` / `above`), the 0–1 probability threshold, and the violation message; `label` is a human note the code ignores. Each agent group then simply lists the question ids that apply to it: `"rules": ["Q001", "Q002"]`. A reserved top-level `_all` group lists **global question ids evaluated on every dispatch** — including agents with no group of their own (their state describes them as `a sub-agent`); global and per-group ids are merged and deduped (global first). Convention: prefix global question ids with `G` (e.g. `G001`). The reserved keys `_global` (switches, e.g. `{ "auditProbabilities": true }`), `_questions`, and `_all` are never treated as agent names. Invalid question entries and non-string, unknown, or duplicate refs are silently ignored (fail-open). Each group may also set `"mode": "warn"` (default `"block"`): in **warn mode** a violating dispatch is not blocked — the violation list is appended to the subagent tool result as a trailing notice (the launch notice with run id for async dispatches — timely, the child can still be interrupted; the child's final output for blocking dispatches — post-hoc), so the main agent judges for itself. `_global.mode` sets a global default (e.g. `"warn"` for a trial/observe period); a group's explicit `mode` overrides it; invalid values silently fall back to `block`. **The code ships no built-in rules: with no config file there are no checks at all (fail-open).** The config file is created by the bundled skill (say "配置 subagent 规则") or written by hand — the sample illustrates the schema, it is not a deployment source. After editing, `/reload` in pi.

Every evaluation — allowed or blocked — is appended to `~/.pi/agent/jev-comp/audit.jsonl` (one JSON object per line).

#### Audit fields

Every audit line carries the constant fields `ts`, `agent`, `task_excerpt` (task truncated to 200 characters), `model`, `rules` and `verdict`, plus `latency_ms`. Conditionally: `blocked` (array of violating rule ids — present when rules fired, in either mode), `error` (fail-open error description), `probs` (rule id → raw probability, only when `_global.auditProbabilities` is `true`), `action` (`"warn"` — present only on warn-mode violations), and `upstream` + `failover` (whenever the request was anything other than a plain first-upstream success — a real switch, a cooldown skip, or a fallback to the first upstream; `failover` records carry `status` / `kind` / `ms` for failed attempts and `retryAfterMs` when a 429 reported `Retry-After`, while skipped levels are recorded as `{name, kind: "cooldown"}` with no `status`/`ms`, and a fallback attempt is marked `fallback: true`). A successful fallback carries `upstream` + `fallback: true` and no `failover` array. Rows where the whole chain failed carry the `failover` attempts alongside `error`, without `upstream`. Rows with neither a switch nor a fallback carry none of these keys. API keys are never logged.

A second reserved switch, `_global.trainingLog` (default `false`), records training triples for local decision-model fine-tuning: when `true`, every dispatch evaluation and every `jev_ask` call also appends one line to `~/.pi/agent/jev-comp/training.jsonl` — the full `state`, the `questions` asked, and the probabilities/answers returned — with `source` set to `"dispatch"` or `"ask"` respectively. Best-effort and fail-open; runtime data, never committed.

### Tools

- `jev_ask` — parameters: `state` (the material text to evaluate), `questions` (a map of key → `{type, instructions}`), optional `model`.
- `jev_models` — no parameters; lists the endpoint's connected models.

### Skill

Say "配置 subagent 规则" (or ask to record JEV endpoint/model settings). The skill checks which of the three env keys exist — **without ever reading their values** — asks you for what is missing, and writes the env file / rules file for you.

### Orchestrator main-session extension (opt-in)

The package also ships a second extension, `orchestrator-main`, which governs the main agent session rather than dispatches. It is **disabled by default** and activates only when `~/.pi/agent/jev-comp/orchestrator.json` exists and parses — the file's presence is the on/off switch. All keys are optional:

```json
{
  "personaFile": "~/.config/pi-orchestrator/persona.md",
  "blockedTools": ["bash", "find", "grep", "rg", "ls", "bash_output", "kill", "web_search", "web_fetch", "research_checkpoint", "gbrain_search", "gbrain_capture"],
  "ceiling": { "denyExtensions": false }
}
```

When enabled it does three things: injects the persona file's body (frontmatter stripped, wrapped in `<orchestrator_role>`) into the system prompt; trims and blocks the listed direct-execution tools for the main agent (the `subagent` tool is deliberately never blocked); and registers a capability-ceiling exemption so subagents run with full power. A missing `personaFile` skips only the injection step; a missing or malformed config file disables the whole extension silently (fail-open). Subagent child sessions (`PI_SUBAGENT_CHILD=1`) never get any of these hooks.

> Note: the ceiling exemption resolves `pi-subagents` from the host pi installation (`~/.pi/agent/npm`) via a fallback chain — packages load with separate module roots, and the ceiling registry lives in the host's own pi-subagents instance, so bundling the dependency inside this package would register into the wrong instance.

## Multi-upstream failover (optional)

Create `~/.pi/agent/jev-comp/upstreams.json` (permissions 600; copy from [examples/upstreams.sample.json](examples/upstreams.sample.json), which also shows a secondary `typesafe` upstream) to list ordered upstreams. Each entry is `{name, baseUrl, apiKey, model, proxy?}` — `name` must be non-empty and unique; the optional per-level `proxy` overrides it, and when absent the existing `JEV_AI_PROXY` behavior applies. Top-level `timeoutMs` (default 5000 — used as the per-level `curl --max-time`) and `cooldownMs` (default 30000) must be positive integers.

`ask()` tries them in order — one request per upstream, never retrying the same one, never backing off. Switching to the next upstream happens **only** for: connection failure, timeout, HTTP 5xx, 429, 401, 403, 404, and an unusable 200 body. `402`, `422`, all other 4xx (400/405/408/409/…), `3xx`, and `not_configured` throw immediately with zero requests to later upstreams. Only connection-level failures (network / timeout / 5xx) put an upstream into cooldown; 429 and other 4xx never do. During the `cooldownMs` window the level is skipped with zero HTTP requests and recorded in the audit as `{name, kind: "cooldown"}`; once the window expires the level is retried (the cooldown table is in-memory only — a restart forgets it). When every level is cooling, the first one is still attempted as a fallback — never an empty chain — and that attempt is marked `fallback: true` in the audit; a fallback failure re-arms only that level's own cooldown and never extends another level's. If the file is absent or invalid, or the whole chain fails, behavior falls back to the legacy single-upstream path (fail-open). Read once at extension load; run `/reload` after editing. Runtime data — never committed. See [CONTEXT.md](CONTEXT.md) for the glossary (Upstream / Failover / Cooldown) and [docs/adr/0001-upstream-failover.md](docs/adr/0001-upstream-failover.md) for the design decision.

## Transport: selfhost vs builtin (v0.10.0)

Two evaluation transports are available; `_global.transport` in `compliance-rules.json` selects one (default `"selfhost"`, any other value silently falls back):

- **`selfhost`** (default) — the package's own curl-based client (`jev/client.ts`) with the optional multi-upstream failover chain (`upstreams.json`). Requires `JEV_AI_API_KEY` + `JEV_AI_BASE_URL` as before.
- **`builtin`** — evaluation goes through pi's built-in classifier platform (`ctx.modelRegistry.classify`, requires pi ≥ 0.99). pi resolves credentials itself (`--api-key` → `auth.json` → `models.json` → env), so this package holds no key or baseUrl for it. The upstream chain becomes `_global.builtinChain` — an ordered list of `{provider, model}` entries (default `[{"provider":"typesafe","model":"jev-latest"}]`; e.g. add `{"provider":"opencode","model":"jev-1.13-free"}` as a second level). Each entry is tried exactly once with client-side retries disabled (`maxRetries: 0`); an entry that errors, times out, returns unusable answers, or cannot even be resolved moves on to the next; if the whole chain fails the dispatch is allowed through (fail-open). pi ships the classifier models built-in, but each provider still requires its own credential (e.g. env `TYPESAFE_API_KEY` or `OPENCODE_API_KEY`, or an `auth.json` entry).

Differences from selfhost: the audit `model` field records the winning chain entry as `<provider>/<model>` (not the response-body model id); `usage` is mapped from pi's `{input, output}` counters; in builtin mode `jev_ask`'s `model` parameter is accepted but ignored (each chain entry uses its own model); `jev_models` still queries the selfhost endpoint only.

## Fail-open

If the JEV endpoint is unreachable or not configured, the API key is missing, or the rules file is malformed, dispatches are **allowed through**. The gate never blocks on its own failure.

## Development

```
npm test
```

Zero npm dependencies; runs on Node's built-in test runner. To recalibrate the judge thresholds, see `scripts/calibrate.ts` (it issues real API requests, so it is not run by the tests).

## License

MIT

---

## 中文文档

pi-subagent-jev 是一个 [pi](https://github.com/earendil-works/pi-coding-agent) 扩展包：以 JEV System One 决策模型为 subagent 派单设卡，并附查询该模型之通用工具。

> **目前仅支持 pi + pi-subagents 使用**——派单拦截钩的是 pi-subagents 包提供的 `subagent` 工具。

### 功能介绍

- **派单合规拦截**——主 agent 派发 subagent 时，任务文本送 JEV System One 端点求值。命中任一已配规则即拦截：违规原因逐条列出，作为错误结果返给主 agent，subagent 不被派生。
- **`jev_ask` / `jev_models` 工具**——直查决策模型。`jev_ask` 对 state 文本求值一批类型化问题（`noul` / `choice` / `score`）；`jev_models` 列端点已连模型。
- **附赠 `subagent-jev` skill**——引导录入端点/模型设置与各 subagent 之合规规则。

### 环境要求

- pi coding agent，**并装有 pi-subagents 包**（拦截钩其 `subagent` 工具）
- 可达之 JEV System One 端点与 API key

### 安装

```
pi install git:github.com/G0-0000/pi-subagent-jev
```

继而创建 env 档 `~/.config/jev-comp/env`（权限 600）：

```
JEV_AI_API_KEY=your-key
JEV_AI_BASE_URL=https://your-jev-endpoint
JEV_AI_MODEL=可选之模型覆盖
```

`JEV_AI_API_KEY` 与 `JEV_AI_BASE_URL` 为必配；`JEV_AI_MODEL` 可选（默认 `oc/jev-1.13-free`）。于 pi 内 `/reload`（或重启）生效。

不欲手工编辑？对 pi 言「配置 subagent 规则」即可——包内 skill 自会引导（见下）。

### 使用

#### 派单拦截

无需任何操作——装好配妥后，每次派单自动求值。被拦之派单将违规清单返予主 agent。

> **v0.8.0 破坏性变更**——规则档 schema 已变：`_questions` 每条自含 `blockWhen`/`threshold`/`message`，各组 `rules` 为问句编号字符串数组；v0.7 之 `{id, question, …}` 规则对象不再加载（请经 skill 迁移）。另自 v0.7.0 起代码零内建规则——无 `compliance-rules.json` 之安装零检查。

规则置于 `~/.pi/agent/jev-comp/compliance-rules.json`（schema 样例：[examples/compliance-rules.sample.json](examples/compliance-rules.sample.json)）。顶层 `_questions` 为一问一条的**自含**问句库：每项 `{ label?, instructions, criteria?, blockWhen, threshold, message }`——问句正文、可选 `{true, false}` 答支判据、向性（`below`/`above`）、0–1 概率阈值与违规文案同居一条；`label` 仅供人读、代码忽略。各 agent 组只需列出适用之问句编号：`"rules": ["Q001", "Q002"]`。顶层保留键 `_all` 所列编号为**全局问句——凡派单皆查**，无专属组之 agent 亦然（其 state 述语固定为 `a sub-agent`）；全局与组内编号并集去重（全局在前）。约定全局问句号以 `G` 冠（如 `G001`）。保留键 `_global`（全局开关，如 `{ "auditProbabilities": true }`）、`_questions`、`_all` 皆不视作 agent 名。非法问句条目与非字符串/悬空/重复编号皆静默忽略（fail-open）。各组亦可设 `"mode": "warn"`（缺省 `"block"`）：**warn 模式**下命中规则不阻断——违规清单作为末位提示追加于 subagent 工具结果（异步派单追加于带 run id 的启动回执，及时可见、子 agent 尚可中断；阻塞派单追加于子 agent 最终输出，属事后复核），由主 agent 自决。`_global.mode` 定全局缺省（如观察期置 `"warn"` 试水），组级 `mode` 覆盖之；非法值静默回 `block`。**代码零内建规则：无配置档即零检查（fail-open）。** 配置档经包内 skill（言「配置 subagent 规则」）创建或手书——样例仅示 schema，非部署之源。改后于 pi 内 `/reload`。

每次求值——放行或拦截——皆追加于 `~/.pi/agent/jev-comp/audit.jsonl`（每行一 JSON 对象）。

#### 审计字段

审计行恒有字段 `ts`、`agent`、`task_excerpt`（任务原文按码点截 ≤200 字）、`model`、`rules` 与 `verdict`，另有 `latency_ms`。条件性字段：`blocked`（命中规则之 id 数组——block/warn 两种模式下规则命中即出现）、`error`（fail-open 之错误说明）、`probs`（规则 id → 原始概率，唯 `_global.auditProbabilities` 为 `true` 时附）、`action`（`"warn"`，唯 warn 模式命中时附）、以及 `upstream` ＋ `failover`（凡非「首配 upstream 一举即成」者皆附——真实切换、冷却跳过或保底真发首位皆是；`failover` 记录对真实失败尝试携 `status` / `kind` / `ms`，429 上报 `Retry-After` 时另携 `retryAfterMs`，被跳过之级则记 `{name, kind: "cooldown"}`、无 `status`/`ms`，保底真发之尝试另携 `fallback: true`）。保底成功之行携 `upstream` ＋ `fallback: true`，而无 `failover` 数组。全链败尽之行携 `failover` 历次尝试与 `error`，无 `upstream`。既未切换又非保底之行，诸键皆无。API key 绝不入日志。

另一保留开关 `_global.trainingLog`（缺省 `false`）为本地决策模型微调记录训练三元组：为 `true` 时，每次派单求值与每次 `jev_ask` 调用皆另追加一行于 `~/.pi/agent/jev-comp/training.jsonl`——全量 `state`、所求 `questions` 与返回之概率/答案——`source` 分别为 `"dispatch"` 与 `"ask"`。尽力而为、fail-open；运行时数据，绝不入库。

#### 工具

- `jev_ask`——参数：`state`（待求值之材料文本）、`questions`（键 → `{type, instructions}` 之映射）、可选 `model`。
- `jev_models`——无参数；列端点已连模型。

#### Skill

言「配置 subagent 规则」（或请录 JEV 端点/模型设置）。skill 查三键之有无——**绝不读其值**——问你所缺，代写 env 档与规则档。

#### Orchestrator 主会话扩展（opt-in）

包内另附第二扩展 `orchestrator-main`，所治为主 agent 会话而非派单。**默认不开**——唯 `~/.pi/agent/jev-comp/orchestrator.json` 存在且可解析方启用，档之有无即启停之关。诸键皆可选：

```json
{
  "personaFile": "~/.config/pi-orchestrator/persona.md",
  "blockedTools": ["bash", "find", "grep", "rg", "ls", "bash_output", "kill", "web_search", "web_fetch", "research_checkpoint", "gbrain_search", "gbrain_capture"],
  "ceiling": { "denyExtensions": false }
}
```

启用后行三事：注入 persona 档正文（剥 frontmatter，以 `<orchestrator_role>` 包裹）于系统提示；按清单裁剪并拦截主 agent 之直执行工具（独不拦 `subagent`）；注册子 agent 豁免（capability-ceiling），使子 agent 得全量能力。`personaFile` 所指档不存在时，唯注入一步静默跳过；配置档缺失或损坏则本扩展静默全不启用（fail-open）。子 agent 进程（`PI_SUBAGENT_CHILD=1`）一钩不注。

> 注：ceiling 豁免经 fallback 链自宿主 pi 安装处（`~/.pi/agent/npm`）解析 `pi-subagents`——包之模块根各自隔离，而注册表存于宿主实例；若将依赖打入本包，徒注册于自家实例，宿主读不到。

### 多上游 failover（可选）

创建 `~/.pi/agent/jev-comp/upstreams.json`（权限 600；样例：[examples/upstreams.sample.json](examples/upstreams.sample.json)，内含 `typesafe` 备级示例）即可列出按序上游。每项形 `{name, baseUrl, apiKey, model, proxy?}`——`name` 须非空且唯一；各级可选 `proxy` 覆盖代理，缺省走既有 `JEV_AI_PROXY` 链。顶层 `timeoutMs`（缺省 5000——按级作 `curl --max-time`）与 `cooldownMs`（缺省 30000）须为正整数。

`ask()` 依序尝试——每级恰一发、同一端绝不重发、绝不退避。切换至下一级**仅**发生于：连接败、超时、HTTP 5xx、429、401、403、404 及 200 坏体。`402`、`422`、其余一切 4xx（400/405/408/409/…）、`3xx` 与 `not_configured` 立即抛出，对后续各级零请求。唯连接级败北（network／超时／5xx）会使端点入冷却；429 与其余 4xx 绝不冷却。冷却窗口内该级被跳过——零 HTTP 请求、审计记 `{name, kind: "cooldown"}`；窗口届满即恢复尝试（冷却表仅存内存——重启即忘）。各级皆在冷却时，仍保底真发首位——绝不空链——该次尝试于审计标 `fallback: true`；保底失败只续该级自身之钟，绝不延长他级。档不存在或非法、或全链败尽，均回旧单端点链路（fail-open）。扩展加载时读一次，改后在 pi 内 `/reload`。运行时数据，不入库。术语表（Upstream / Failover / Cooldown）见 [CONTEXT.md](CONTEXT.md)，设计决策见 [docs/adr/0001-upstream-failover.md](docs/adr/0001-upstream-failover.md)。

### 传输双路：selfhost 与 builtin（v0.10.0）

求值传输有二，`compliance-rules.json` 之 `_global.transport` 择之（缺省 `"selfhost"`，非法值静默回缺省）：

- **`selfhost`**（缺省）——本仓自管 curl 链（`jev/client.ts`）＋可选多上游 failover（`upstreams.json`）。仍须 `JEV_AI_API_KEY` ＋ `JEV_AI_BASE_URL`。
- **`builtin`**——求值改走 pi 内建 classifier 平台（`ctx.modelRegistry.classify`，须 pi ≥ 0.99）。凭据由 pi 自解（`--api-key` → `auth.json` → `models.json` → env），本仓不为之持 key/baseUrl。上游链改为 `_global.builtinChain`——`{provider, model}` 条目之有序数组（缺省 `[{"provider":"typesafe","model":"jev-latest"}]`，可加 `{"provider":"opencode","model":"jev-1.13-free"}` 为第二级）。每级恰一发且客户端重试关断（`maxRetries: 0`）；某级出错、超时、答案不可用乃至不可解析，皆切下一级；全链败尽则放行（fail-open）。pi 虽内建 classifier 模型，各家仍须自配凭据（如 env `TYPESAFE_API_KEY`／`OPENCODE_API_KEY`，或 `auth.json` 条目）。

与 selfhost 之异：审计 `model` 字段记胜出条目名 `<provider>/<model>`（非响应体模型 id）；`usage` 由 pi 之 `{input, output}` 映射而来；builtin 模式下 `jev_ask` 之 `model` 参数接受但忽略（各级用自身模型）；`jev_models` 仍唯查 selfhost 端点。

### Fail-open

JEV 端点不可达或未配置、API key 缺失、规则档损坏时，派单一律**放行**。此卡绝不因自身故障而拦。

### 开发

```
npm test
```

零 npm 依赖，Node 内建测试器。重校准判定阈值见 `scripts/calibrate.ts`（发真实 API 请求，故不入测试）。

### 许可证

MIT
