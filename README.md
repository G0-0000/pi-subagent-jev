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

Rules live in `~/.pi/agent/jev-comp/compliance-rules.json` (full sample: [examples/compliance-rules.sample.json](examples/compliance-rules.sample.json)). Each rule has an `id`, `instructions` (the question asked of JEV), a `blockWhen` (`below` / `above`), a `threshold` (0–1 probability), and a `message` (returned on violation). Rules are keyed by subagent name; only dispatches to a named agent are evaluated. After editing, `/reload` in pi.

Every evaluation — allowed or blocked — is appended to `~/.pi/agent/jev-comp/audit.jsonl` (one JSON object per line; a `blocked` array appears only when the dispatch was blocked).

### Tools

- `jev_ask` — parameters: `state` (the material text to evaluate), `questions` (a map of key → `{type, instructions}`), optional `model`.
- `jev_models` — no parameters; lists the endpoint's connected models.

### Skill

Say "配置 subagent 规则" (or ask to record JEV endpoint/model settings). The skill checks which of the three env keys exist — **without ever reading their values** — asks you for what is missing, and writes the env file / rules file for you.

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

规则置于 `~/.pi/agent/jev-comp/compliance-rules.json`（完整样例：[examples/compliance-rules.sample.json](examples/compliance-rules.sample.json)）。每规则有 `id`、`instructions`（交 JEV 之问）、`blockWhen`（`below` / `above`）、`threshold`（0–1 概率）与 `message`（命中时返回之文案）。规则按 subagent 名分组；唯派单至具名 agent 方求值。改后于 pi 内 `/reload`。

每次求值——放行或拦截——皆追加于 `~/.pi/agent/jev-comp/audit.jsonl`（每行一 JSON 对象；唯拦截时含 `blocked` 数组）。

#### 工具

- `jev_ask`——参数：`state`（待求值之材料文本）、`questions`（键 → `{type, instructions}` 之映射）、可选 `model`。
- `jev_models`——无参数；列端点已连模型。

#### Skill

言「配置 subagent 规则」（或请录 JEV 端点/模型设置）。skill 查三键之有无——**绝不读其值**——问你所缺，代写 env 档与规则档。

### Fail-open

JEV 端点不可达或未配置、API key 缺失、规则档损坏时，派单一律**放行**。此卡绝不因自身故障而拦。

### 开发

```
npm test
```

零 npm 依赖，Node 内建测试器。重校准判定阈值见 `scripts/calibrate.ts`（发真实 API 请求，故不入测试）。

### 许可证

MIT
