# pi-subagent-jev

A [pi](https://github.com/earendil-works/pi-coding-agent) package that gates subagent dispatches through a JEV System One decision model, plus general-purpose tools to query that model.

## What's inside

One pi extension (`extensions/pi-subagent-jev.ts`), containing:

- **dispatch compliance gate** — subagent dispatch compliance gate. Hooks the `tool_call` event for `subagent` invocations, sends the task text to the JEV System One endpoint for evaluation, and blocks the dispatch if any configured rule fires. The block reason lists every violation message and is returned to the main agent as an error result, so the subagent is never spawned.
- **thin tools** over the JEV client: `jev_ask` (evaluate a batch of typed questions — `noul` / `choice` / `score` — against a state text) and `jev_models` (list connected models on the endpoint).

## Requirements

- pi coding agent
- A reachable JEV System One endpoint (default: `http://192.168.3.119:8081`)
- Environment variable `JEV_AI_API_KEY` (required — the endpoint needs authentication)
- `JEV_AI_BASE_URL` (optional — overrides the endpoint)

## Install

```
pi install git:github.com/<owner>/pi-subagent-jev
```

For local development:

```
pi install ./pi-subagent-jev
```

## Configuration

Compliance rules live in `~/.pi/agent/jev-comp/compliance-rules.json`. See [examples/compliance-rules.sample.json](examples/compliance-rules.sample.json):

```json
{
  "delegate": {
    "agentDesc": "a file-editing agent without shell access",
    "rules": [
      { "id": "R1", "blockWhen": "below", "threshold": 0.7, "message": "任务未给出具体文件路径" },
      { "id": "R3", "blockWhen": "above", "threshold": 0.8, "message": "任务要求执行 shell 命令" }
    ]
  }
}
```

Each rule has an id, a `blockWhen` (`below` / `above`), a `threshold` (0–1 probability), and a `message` returned on violation. Rules are keyed by subagent name; only dispatches to a named agent are evaluated. After editing the file, run `/reload` in pi for changes to take effect.

## Audit log

Every evaluation — allowed or blocked — is appended to `~/.pi/agent/jev-comp/audit.jsonl` (one JSON object per line, including a `blocked` field).

## Fail-open

If the JEV endpoint is unreachable, the API key is missing, or the rules file is malformed, dispatches are **allowed through**. The gate never blocks on its own failure.

## Development

```
npm test
```

Runs the test suite with Node's built-in test runner (`node --test`) — no dependency installation needed (zero npm dependencies).

To recalibrate the judge thresholds, see `scripts/calibrate.ts` (it issues real API requests, so it is not run by the tests).

## License

MIT

## 中文简介

pi-subagent-jev 是一个 pi 扩展包，含单扩展 `extensions/pi-subagent-jev.ts`（含 `jev_ask`/`jev_models` 工具 ＋ 派单拦截）：派单拦截在主 agent 派发 subagent 任务时，把任务文本交 JEV System One 决策模型求值，命中违规规则（如任务未给文件路径、要求无权限的 shell 操作）即拦截派单，违规原因逐条返给主 agent；`jev_ask` / `jev_models` 工具直接查询该决策模型。规则配置于 `~/.pi/agent/jev-comp/compliance-rules.json`，全部审核记录写入 `~/.pi/agent/jev-comp/audit.jsonl`；端点不可达或配置出错时一律放行（fail-open）。
