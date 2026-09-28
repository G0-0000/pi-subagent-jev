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

Rules live in `~/.pi/agent/jev-comp/compliance-rules.json` (full sample: [examples/compliance-rules.sample.json](examples/compliance-rules.sample.json)). Each rule has an `id`, `instructions` (the question asked of JEV), an optional `criteria` (`{true, false}` natural-language answer-branch guides passed through to JEV to disambiguate borderline questions), a `blockWhen` (`below` / `above`), a `threshold` (0–1 probability), and a `message` (returned on violation). Rules are keyed by subagent name; only dispatches to a named agent are evaluated. A reserved top-level key `_global` holds global switches (e.g. `{ "auditProbabilities": true }`) and is not treated as an agent name. After editing, `/reload` in pi.

Every evaluation — allowed or blocked — is appended to `~/.pi/agent/jev-comp/audit.jsonl` (one JSON object per line).

#### Audit fields

Every audit line carries the constant fields `ts`, `agent`, `task_excerpt` (task truncated to 200 characters), `model`, `rules` and `verdict`, plus `latency_ms`. Conditionally: `blocked` (array of violating rule messages — only when the dispatch was blocked), `error` (fail-open error description), `probs` (rule id → raw probability, only when `_global.auditProbabilities` is `true`), and `upstream` + `failover` (only when a non-first configured upstream answered — a real switch or a cooldown skip; `failover` records carry `status` / `kind` / `ms` for failed attempts and `retryAfterMs` when a 429 reported `Retry-After`, while skipped levels are recorded as `{name, kind: "cooldown"}` with no `status`/`ms`). Rows where the whole chain failed carry the `failover` attempts alongside `error`, without `upstream`. API keys are never logged.

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

`ask()` tries them in order — one request per upstream, never retrying the same one, never backing off. Switching to the next upstream happens **only** for: connection failure, timeout, HTTP 5xx, 429, 401, 403, 404, and an unusable 200 body. `402`, `422`, all other 4xx (400/405/408/409/…), `3xx`, and `not_configured` throw immediately with zero requests to later upstreams. Only connection-level failures (network / timeout / 5xx) put an upstream into cooldown; 429 and other 4xx never do. During the `cooldownMs` window the level is skipped with zero HTTP requests and recorded in the audit as `{name, kind: "cooldown"}`; once the window expires the level is retried (the cooldown table is in-memory only — a restart forgets it). If the file is absent or invalid, or the whole chain fails, behavior falls back to the legacy single-upstream path (fail-open). Read once at extension load; run `/reload` after editing. Runtime data — never committed. See [CONTEXT.md](CONTEXT.md) for the glossary (Upstream / Failover / Cooldown) and [docs/adr/0001-upstream-failover.md](docs/adr/0001-upstream-failover.md) for the design decision.

## Fail-open

If the JEV endpoint is unreachable or not configured, the API key is missing, or the rules file is malformed, dispatches are **allowed through**. The gate never blocks on its own failure.

## Development

```
npm test
```

Zero npm dependencies; runs on Node's built-in test runner (89 tests). To recalibrate the judge thresholds, see `scripts/calibrate.ts` (it issues real API requests, so it is not run by the tests).

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

规则置于 `~/.pi/agent/jev-comp/compliance-rules.json`（完整样例：[examples/compliance-rules.sample.json](examples/compliance-rules.sample.json)）。每规则有 `id`、`instructions`（交 JEV 之问）、可选 `criteria`（`{true, false}` 答支判据，透传 JEV 以消歧含糊之问）、`blockWhen`（`below` / `above`）、`threshold`（0–1 概率）与 `message`（命中时返回之文案）。规则按 subagent 名分组；唯派单至具名 agent 方求值。顶层保留键 `_global` 存放全局开关（如 `{ "auditProbabilities": true }`），不视作 agent 名。改后于 pi 内 `/reload`。

每次求值——放行或拦截——皆追加于 `~/.pi/agent/jev-comp/audit.jsonl`（每行一 JSON 对象）。

#### 审计字段

审计行恒有字段 `ts`、`agent`、`task_excerpt`（任务原文按码点截 ≤200 字）、`model`、`rules` 与 `verdict`，另有 `latency_ms`。条件性字段：`blocked`（命中拦截之规则文案数组——唯派单被拦时出现）、`error`（fail-open 之错误说明）、`probs`（规则 id → 原始概率，唯 `_global.auditProbabilities` 为 `true` 时附）、以及 `upstream` ＋ `failover`（唯胜者非首配 upstream 时附——真实切换或冷却跳过皆然；`failover` 记录对真实失败尝试携 `status` / `kind` / `ms`，429 上报 `Retry-After` 时另携 `retryAfterMs`，被跳过之级则记 `{name, kind: "cooldown"}`、无 `status`/`ms`）。全链败尽之行携 `failover` 历次尝试与 `error`，无 `upstream`。API key 绝不入日志。

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

`ask()` 依序尝试——每级恰一发、同一端绝不重发、绝不退避。切换至下一级**仅**发生于：连接败、超时、HTTP 5xx、429、401、403、404 及 200 坏体。`402`、`422`、其余一切 4xx（400/405/408/409/…）、`3xx` 与 `not_configured` 立即抛出，对后续各级零请求。唯连接级败北（network／超时／5xx）会使端点入冷却；429 与其余 4xx 绝不冷却。冷却窗口内该级被跳过——零 HTTP 请求、审计记 `{name, kind: "cooldown"}`；窗口届满即恢复尝试（冷却表仅存内存——重启即忘）。档不存在或非法、或全链败尽，均回旧单端点链路（fail-open）。扩展加载时读一次，改后在 pi 内 `/reload`。运行时数据，不入库。术语表（Upstream / Failover / Cooldown）见 [CONTEXT.md](CONTEXT.md)，设计决策见 [docs/adr/0001-upstream-failover.md](docs/adr/0001-upstream-failover.md)。

### Fail-open

JEV 端点不可达或未配置、API key 缺失、规则档损坏时，派单一律**放行**。此卡绝不因自身故障而拦。

### 开发

```
npm test
```

零 npm 依赖，Node 内建测试器（89 条测试）。重校准判定阈值见 `scripts/calibrate.ts`（发真实 API 请求，故不入测试）。

### 许可证

MIT
