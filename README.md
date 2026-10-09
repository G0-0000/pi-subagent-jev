# pi-subagent-jev

A [pi](https://github.com/earendil-works/pi-coding-agent) package that gates subagent dispatches through a JEV System One decision model, plus general-purpose tools to query that model.

> **Currently only supports pi + pi-subagents** — the dispatch gate hooks the `subagent` tool provided by the pi-subagents package.

## Features

- **Dispatch compliance gate** — when the main agent dispatches a subagent, the task text is sent to the JEV System One endpoint for evaluation. If any configured rule fires, the dispatch is blocked: every violation message is returned to the main agent as an error result, and the subagent is never spawned.
- **`jev_ask` tool** — query the decision model directly. `jev_ask` evaluates a batch of typed questions (`noul` / `choice` / `score`) against a state text.
- **Bundled `subagent-jev` skill** — walks you through recording endpoint/model settings and per-subagent compliance rules.
- **Runtime monitoring (opt-in)** — watches running subagents for suspected bash stalls, unproductive tool loops, and repeated failures, and nudges the main agent with advisory alerts. Never interrupts; off by default.

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

A second reserved switch, `_global.trainingLog` (default `false`), records training triples for local decision-model fine-tuning: when `true`, every dispatch evaluation and every `jev_ask` call also appends one line to `~/.pi/agent/jev-comp/training.jsonl` — the full `state`, the `questions` asked, and the probabilities/answers returned — with `source` set to `"dispatch"`, `"ask"`, or `"monitor"` (runtime-monitoring evaluations, when enabled) respectively. Best-effort and fail-open; runtime data, never committed.

### Thinking-depth adjustment (opt-in)

Set `_global.thinkingDepth` in `compliance-rules.json` to enable automatic one-rung adjustment when dispatching without an explicit `model`:

```json
"thinkingDepth": { "enabled": true, "defaultAnchor": "high", "threshold": 0.7 }
```

The extension resolves the subagent's configured thinking level through `pi-subagents/preflight`; `defaultAnchor` is used only if the contract has no level. `off` and unknown levels skip this feature. Built-in choice question D001 is added to the same JEV batch as any compliance questions (no extra request). The ladder is **minimal/low → medium → high/xhigh → max**. A confident `lower`/`higher` answer at or above `threshold` moves one rung; `same` leaves it unchanged. At either edge, adjustment is clamped (no change). A changed level is encoded as the model suffix (for example, `provider/model:max`). Explicit dispatch `model` arguments are untouched. When D001 was evaluated, the audit line includes `depth` with anchor, adjustment, answer, probability, and whether a rewrite was applied. Any preflight, JEV, or adjustment error fails open; the feature is off by default.

### Tools

- `jev_ask` — parameters: `state` (the material text to evaluate), `questions` (a map of key → `{type, instructions}`), optional `model`. Both `state` and `questions` are optional and fall back to a built-in probe payload (a small typo-fix task plus one `noul` question), so passing only `upstream` suffices for a quick probe. Optional `upstream` (a NAME from `upstreams.json`) sends exactly one request straight to that named upstream — bypassing failover chain order, cooldown, and switching — for quick single-upstream testing (in builtin transport mode the parameter is accepted but ignored). The result carries an `ms` field with the elapsed milliseconds.

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

When enabled it does three things: injects the persona file's body (frontmatter stripped, wrapped in `<orchestrator_role>`) into the system prompt; trims and blocks the listed direct-execution tools for the main agent (the `subagent` tool is deliberately never blocked); and registers a capability-ceiling exemption so subagents run with full power. A missing `personaFile` skips only the injection step; a missing or malformed config file disables the whole extension silently (fail-open). Subagent child sessions — identified by `PI_SUBAGENT_CHILD=1` (async runner processes) or by the child session-file shape `run-<N>/session.jsonl` / `forks/<name>.jsonl` (foreground/fork children running in the main process) — never get any of these hooks.

> Note: the ceiling exemption resolves `pi-subagents` from the host pi installation (`~/.pi/agent/npm`) via a fallback chain — packages load with separate module roots, and the ceiling registry lives in the host's own pi-subagents instance, so bundling the dependency inside this package would register into the wrong instance.

### Runtime monitoring (opt-in, v0.12.0)

The dispatch gate judges a task **before** dispatch; runtime monitoring watches the subagent **while it runs**. It is **disabled by default** and activates only when `~/.pi/agent/jev-comp/monitor.json` exists, parses, and sets `"enabled": true` (schema sample: [examples/monitor.sample.json](examples/monitor.sample.json); a malformed file disables the feature silently). All keys are optional and fall back individually:

```json
{
  "enabled": true,
  "bashFirstCheckMs": 300000,
  "bashRecheckMs": 600000,
  "sweepIntervalMs": 600000,
  "maxCallsPerEval": 6,
  "maxCharsPerCall": 800,
  "maxStateChars": 8000
}
```

Three detectors plus a fallback sweep: **bash stall** (a bash call still running past `bashFirstCheckMs` of total elapsed time; if judged reasonable it is re-asked every `bashRecheckMs` until it ends), **unproductive tool loop**, **repeated failure without changed conditions** (event-line candidates, deduped per signal and window), and a **no-progress sweep** for any run that has had no check for `sweepIntervalMs`. Triggers firing in the same tick merge into one evaluation per run. Four built-in questions (M001–M004, with answer-branch criteria; thresholds 0.6/0.7/0.7/0.6) are evaluated through the same `ask()` transport — including the failover chain, one request per upstream, fail-open on total failure — they are **not** part of `compliance-rules.json`.

On a hit, an advisory alert is injected into the main session (`pi.sendMessage(..., { triggerTurn: true })`): agent name, the detector that fired, an evidence excerpt, the confidence, and a suggestion to check — **it never interrupts, stops, or steers the child**; the main agent decides. Evidence comes only from public pi-subagents surfaces (the `subagent:control-event` bus and the in-process status RPC); private transcript files are never read, and pi-subagents and agent profiles are never modified. Insufficient evidence yields `unknown` — no alert. With `_global.trainingLog` on, monitor evaluations also append `source: "monitor"` lines to `training.jsonl`. Note: for async (background) children the tool-call evidence is weaker (text tail only), so loop/failure detection is best-effort there. See [docs/adr/0005-runtime-monitoring.md](docs/adr/0005-runtime-monitoring.md) for the design decision.

## Multi-upstream failover (optional)

Create `~/.pi/agent/jev-comp/upstreams.json` (permissions 600; copy from [examples/upstreams.sample.json](examples/upstreams.sample.json), which also shows a secondary `typesafe` upstream) to list ordered upstreams. Each entry is `{name, baseUrl, apiKey, model, proxy?}` — `name` must be non-empty and unique; the optional per-level `proxy` overrides it, and when absent the existing `JEV_AI_PROXY` behavior applies. Top-level `timeoutMs` (default 5000 — used as the per-level `curl --max-time`) and `cooldownMs` (default 30000) must be positive integers.

`ask()` tries them in order — one request per upstream, never retrying the same one, never backing off. Switching to the next upstream happens **only** for: connection failure, timeout, HTTP 5xx, 429, 401, 403, 404, and an unusable 200 body. `402`, `422`, all other 4xx (400/405/408/409/…), `3xx`, and `not_configured` throw immediately with zero requests to later upstreams. Only connection-level failures (network / timeout / 5xx) put an upstream into cooldown; 429 and other 4xx never do. During the `cooldownMs` window the level is skipped with zero HTTP requests and recorded in the audit as `{name, kind: "cooldown"}`; once the window expires the level is retried (the cooldown table is in-memory only — a restart forgets it). When every level is cooling, the first one is still attempted as a fallback — never an empty chain — and that attempt is marked `fallback: true` in the audit; a fallback failure re-arms only that level's own cooldown and never extends another level's. If the file is absent or invalid, or the whole chain fails, behavior falls back to the legacy single-upstream path (fail-open). Read once at extension load; run `/reload` after editing. Runtime data — never committed. See [CONTEXT.md](CONTEXT.md) for the glossary (Upstream / Failover / Cooldown) and [docs/adr/0001-upstream-failover.md](docs/adr/0001-upstream-failover.md) for the design decision.

## Transport: selfhost vs builtin (v0.10.0)

Two evaluation transports are available; `_global.transport` in `compliance-rules.json` selects one (default `"selfhost"`, any other value silently falls back):

- **`selfhost`** (default) — the package's own curl-based client (`jev/client.ts`) with the optional multi-upstream failover chain (`upstreams.json`). Requires `JEV_AI_API_KEY` + `JEV_AI_BASE_URL` as before.
- **`builtin`** — evaluation goes through pi's built-in classifier platform (`ctx.modelRegistry.classify`, requires pi ≥ 0.99). pi resolves credentials itself (`--api-key` → `auth.json` → `models.json` → env), so this package holds no key or baseUrl for it. The upstream chain becomes `_global.builtinChain` — an ordered list of `{provider, model}` entries (default `[{"provider":"typesafe","model":"jev-latest"}]`; e.g. add `{"provider":"opencode","model":"jev-1.13-free"}` as a second level). Each entry is tried exactly once with client-side retries disabled (`maxRetries: 0`); an entry that errors, times out, returns unusable answers, or cannot even be resolved moves on to the next; if the whole chain fails the dispatch is allowed through (fail-open). pi ships the classifier models built-in, but each provider still requires its own credential (e.g. env `TYPESAFE_API_KEY` or `OPENCODE_API_KEY`, or an `auth.json` entry).

Differences from selfhost: the audit `model` field records the winning chain entry as `<provider>/<model>` (not the response-body model id); `usage` is mapped from pi's `{input, output}` counters; in builtin mode `jev_ask`'s `model` parameter is accepted but ignored (each chain entry uses its own model).

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
- **`jev_ask` 工具**——直查决策模型。`jev_ask` 对 state 文本求值一批类型化问题（`noul` / `choice` / `score`）。
- **附赠 `subagent-jev` skill**——引导录入端点/模型设置与各 subagent 之合规规则。
- **运行监控（opt-in）**——观察运行中 subagent 之疑似 bash 停滞、无效工具循环与无变化重复失败，命中则向主 agent 注提醒。绝不打断；默认关闭。

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

另一保留开关 `_global.trainingLog`（缺省 `false`）为本地决策模型微调记录训练三元组：为 `true` 时，每次派单求值与每次 `jev_ask` 调用皆另追加一行于 `~/.pi/agent/jev-comp/training.jsonl`——全量 `state`、所求 `questions` 与返回之概率/答案——`source` 分别为 `"dispatch"`、`"ask"` 与 `"monitor"`（运行监控求值，启用时）。尽力而为、fail-open；运行时数据，绝不入库。

#### 思考深度调整（opt-in）

于 `compliance-rules.json` 之 `_global` 增设 `"thinkingDepth": { "enabled": true, "defaultAnchor": "high", "threshold": 0.7 }`，即可为**未显式指定 `model`** 的派单启用自动调档；缺省关闭。扩展经 `pi-subagents/preflight` 解析 agent 配置之 thinking level；仅在 contract 无级别时用 `defaultAnchor`。锚为 `off` 或未知则跳过。内建 choice 问句 D001 与合规问句合并为**同一批 JEV 请求**，无额外往返。

档梯为 **minimal/low → medium → high/xhigh → max**。D001 判为 `lower`/`higher` 且对应概率 `>= threshold` 时升/降一档；`same` 不变。两端钳制（无档可调即不变）；实际改动以模型后缀写入，如 `provider/model:max`。显式派单 `model` 不触碰。D001 已求值时，audit 行附 `depth`（锚、调整、答案、概率与是否已改写）。预检、JEV 或调整任一错误皆 fail-open，派单照常。

#### 工具

- `jev_ask`——参数：`state`（待求值之材料文本）、`questions`（键 → `{type, instructions}` 之映射）、可选 `model`。`state` 与 `questions` 皆可省，缺省用内建探针载荷（一则小改错任务＋一个 `noul` 问句），故单给 `upstream` 即可快测。可选 `upstream`（`upstreams.json` 中之名）单发直测该上游——bypass failover 链序、冷却与切换；builtin 传输下接受但忽略。结果附 `ms` 字段（耗时毫秒）。

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

启用后行三事：注入 persona 档正文（剥 frontmatter，以 `<orchestrator_role>` 包裹）于系统提示；按清单裁剪并拦截主 agent 之直执行工具（独不拦 `subagent`）；注册子 agent 豁免（capability-ceiling），使子 agent 得全量能力。`personaFile` 所指档不存在时，唯注入一步静默跳过；配置档缺失或损坏则本扩展静默全不启用（fail-open）。子 agent——异步子进程以 `PI_SUBAGENT_CHILD=1` 判别，同进程之前台/fork 子会话以档径 `run-<N>/session.jsonl` 或 `forks/<名>.jsonl` 判别——一钩不注。

> 注：ceiling 豁免经 fallback 链自宿主 pi 安装处（`~/.pi/agent/npm`）解析 `pi-subagents`——包之模块根各自隔离，而注册表存于宿主实例；若将依赖打入本包，徒注册于自家实例，宿主读不到。

#### 运行监控（opt-in，v0.12.0）

派单拦截所审者，派单**之前**；运行监控所察者，子 agent **运行途中**。**默认不开**——唯 `~/.pi/agent/jev-comp/monitor.json` 存在、可解析且 `"enabled": true` 方启用（schema 样例：[examples/monitor.sample.json](examples/monitor.sample.json)；坏档静默不启用）。诸键皆可选、逐字段回退缺省：

```json
{
  "enabled": true,
  "bashFirstCheckMs": 300000,
  "bashRecheckMs": 600000,
  "sweepIntervalMs": 600000,
  "maxCallsPerEval": 6,
  "maxCharsPerCall": 800,
  "maxStateChars": 8000
}
```

三检测器＋兜底巡检：**bash 停滞**（bash 调用总耗时逾 `bashFirstCheckMs` 首查；判为合理则每 `bashRecheckMs` 复询至其结束）、**无效工具循环**、**无变化重复失败**（事件线候选，按信号＋窗口去重），以及**无进展巡检**（最近未获任何检查满 `sweepIntervalMs` 之 run）。同一 tick 多项触发合并为每 run 一次求值。四枚内建问句（M001–M004，含答支判据；阈值 0.6/0.7/0.7/0.6）经同一 `ask()` 传输求值——failover 链、每级一发、全链败 fail-open——**不入** `compliance-rules.json`。

命中则以 `pi.sendMessage(..., { triggerTurn: true })` 注入主会话：agent 名、触发之检测器、证据节录、置信度与核查建议——**绝不打断、不停、不转向**，主 agent 自决。证据唯取 pi-subagents 公开面（`subagent:control-event` 总线与进程内 status RPC）；不读私有 transcript 档、不改 pi-subagents 与 agent 配置。证据不足判 `unknown`——不告警。`_global.trainingLog` 开时，监控求值亦落 `source: "monitor"` 行于 `training.jsonl`。注意：异步（后台）子 agent 之工具级证据较弱（唯文本尾部），循环/失败检测在彼为尽力而为。设计决策见 [docs/adr/0005-runtime-monitoring.md](docs/adr/0005-runtime-monitoring.md)。

### 多上游 failover（可选）

创建 `~/.pi/agent/jev-comp/upstreams.json`（权限 600；样例：[examples/upstreams.sample.json](examples/upstreams.sample.json)，内含 `typesafe` 备级示例）即可列出按序上游。每项形 `{name, baseUrl, apiKey, model, proxy?}`——`name` 须非空且唯一；各级可选 `proxy` 覆盖代理，缺省走既有 `JEV_AI_PROXY` 链。顶层 `timeoutMs`（缺省 5000——按级作 `curl --max-time`）与 `cooldownMs`（缺省 30000）须为正整数。

`ask()` 依序尝试——每级恰一发、同一端绝不重发、绝不退避。切换至下一级**仅**发生于：连接败、超时、HTTP 5xx、429、401、403、404 及 200 坏体。`402`、`422`、其余一切 4xx（400/405/408/409/…）、`3xx` 与 `not_configured` 立即抛出，对后续各级零请求。唯连接级败北（network／超时／5xx）会使端点入冷却；429 与其余 4xx 绝不冷却。冷却窗口内该级被跳过——零 HTTP 请求、审计记 `{name, kind: "cooldown"}`；窗口届满即恢复尝试（冷却表仅存内存——重启即忘）。各级皆在冷却时，仍保底真发首位——绝不空链——该次尝试于审计标 `fallback: true`；保底失败只续该级自身之钟，绝不延长他级。档不存在或非法、或全链败尽，均回旧单端点链路（fail-open）。扩展加载时读一次，改后在 pi 内 `/reload`。运行时数据，不入库。术语表（Upstream / Failover / Cooldown）见 [CONTEXT.md](CONTEXT.md)，设计决策见 [docs/adr/0001-upstream-failover.md](docs/adr/0001-upstream-failover.md)。

### 传输双路：selfhost 与 builtin（v0.10.0）

求值传输有二，`compliance-rules.json` 之 `_global.transport` 择之（缺省 `"selfhost"`，非法值静默回缺省）：

- **`selfhost`**（缺省）——本仓自管 curl 链（`jev/client.ts`）＋可选多上游 failover（`upstreams.json`）。仍须 `JEV_AI_API_KEY` ＋ `JEV_AI_BASE_URL`。
- **`builtin`**——求值改走 pi 内建 classifier 平台（`ctx.modelRegistry.classify`，须 pi ≥ 0.99）。凭据由 pi 自解（`--api-key` → `auth.json` → `models.json` → env），本仓不为之持 key/baseUrl。上游链改为 `_global.builtinChain`——`{provider, model}` 条目之有序数组（缺省 `[{"provider":"typesafe","model":"jev-latest"}]`，可加 `{"provider":"opencode","model":"jev-1.13-free"}` 为第二级）。每级恰一发且客户端重试关断（`maxRetries: 0`）；某级出错、超时、答案不可用乃至不可解析，皆切下一级；全链败尽则放行（fail-open）。pi 虽内建 classifier 模型，各家仍须自配凭据（如 env `TYPESAFE_API_KEY`／`OPENCODE_API_KEY`，或 `auth.json` 条目）。

与 selfhost 之异：审计 `model` 字段记胜出条目名 `<provider>/<model>`（非响应体模型 id）；`usage` 由 pi 之 `{input, output}` 映射而来；builtin 模式下 `jev_ask` 之 `model` 参数接受但忽略（各级用自身模型）。

### Fail-open

JEV 端点不可达或未配置、API key 缺失、规则档损坏时，派单一律**放行**。此卡绝不因自身故障而拦。

### 开发

```
npm test
```

零 npm 依赖，Node 内建测试器。重校准判定阈值见 `scripts/calibrate.ts`（发真实 API 请求，故不入测试）。

### 许可证

MIT
