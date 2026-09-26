# AGENTS.md — pi-subagent-jev 项目工作规约

面向 agent 之项目规约。在本项目内改动前先读此档。

## 项目概述

pi package（名 **pi-subagent-jev**），单扩展 **`extensions/pi-subagent-jev.ts`**（含 `jev_ask`/`jev_models` 工具 ＋ 派单拦截）：

- **派单拦截** — subagent 派单合规**拦截**：钩 pi 的 `tool_call` 事件，对命中规则集的 subagent 派单把任务原文打包为 state，向 JEV System One 一次性求值；命中规则即返回 `{ block: true, reason }`，reason 格式为：
  `派单审核未通过（agent=<名>）：` 首行，随后每条违规一行、以 `- ` 前缀（形如 `- R1: 任务未给出具体文件路径`），末行固定 `请修正任务描述后重派。`；整个 reason 作为错误结果返给主 agent，subagent 不被派生。
- **通用工具** — `jev_ask`（对 state 文本求值一批类型化问题：`noul` / `choice` / `score`）与 `jev_models`（列端点已连模型）。

逻辑层在 `jev/`：

- `jev/client.ts` — JEV API 传输层（零 npm 依赖，`spawn curl`；默认端点为私有 JEV 端点（见 `client.ts` 内默认值）之 `/v1/systemone` 与 `/v1/models`；错误映射为 `JevError`）
- `jev/compliance.ts` — 规则集（`RULE_SETS`）、state 拼装（`buildState`）、阈值矩阵与 verdict、audit 行构造、配置档合并（`loadRuleSets`）、主流程 `checkDispatch`

## 结构图

```
pi-subagent-jev/
├── extensions/
│   └── pi-subagent-jev.ts     # 单扩展：jev_ask / jev_models 工具 ＋ 派单拦截
├── jev/
│   ├── client.ts              # API 传输层（curl、错误映射、key 解析）
│   ├── client.test.ts
│   ├── compliance.ts          # 规则/判定/audit 行（纯逻辑，可测）
│   └── compliance.test.ts
├── scripts/
│   ├── calibrate.ts           # 阈值校准脚本（发真实请求，不进测试）
│   └── calibration-20260925.jsonl
├── examples/
│   └── compliance-rules.sample.json
├── docs/
│   ├── JEV-派发合规审计插件.md  # 旧专题档（拦截式改造前所撰，档首有过时提示）
│   ├── package-json-legacy.txt
│   └── README-jev-legacy.md
├── README.md
├── AGENTS.md
├── LICENSE
├── package.json
└── .gitignore
```

## 红线三条（贯穿一切改动）

1. **key 绝不入档/入日志/入错误文本** — `JEV_AI_API_KEY` 之值不得出现在任何文件、日志、错误消息或返回文本中。
2. **POST 不自动重试** — 429 仅解析并上报 `retryAfterMs`（来自 `Retry-After` 头），curl 瞬断如实记录不补救，绝不退避重发。
3. **任何错误 fail-open** — JEV 出错、配置档出错、概率缺失皆放行，绝不阻断派发、绝不外抛。`checkDispatch` 捕获一切异常返 `verdict:"error"` 行且 violations 为空。

## 测试铁律

- `npm test`（即 `node --test jev/*.test.ts`，28 条）**全绿方可提交**。
- 测试不发真实 JEV 端点请求：`client.test.ts` 起本地 127.0.0.1 随机端口 mock HTTP server、真发 curl；`compliance.test.ts` 注入 `askFn`。`scripts/calibrate.ts` 是唯一发真实请求的脚本，不进测试。

## 配置与运行时

- 规则配置表生效档：`~/.pi/agent/jev-comp/compliance-rules.json`（仓库内 `examples/compliance-rules.sample.json` 为样例；**改默认阈值时两边同步**——`jev/compliance.ts` 内建 `RULE_SETS` 与样例 JSON）。
- 审计日志：`~/.pi/agent/jev-comp/audit.jsonl`（每次求值一行；**命中拦截时**含 `blocked` 数组，无命中则不写此键）。
- key 解析链（`jev/client.ts`）：显式参数 `apiKey` → 进程 env `JEV_AI_API_KEY` → env 档（`envFile` 参数 → `JEV_AI_ENV_FILE` → 默认 `~/.config/jev-comp/env`，600 权限）。另有 `JEV_AI_BASE_URL`（覆盖端点）与 `JEV_AI_PROXY`（显式给值且端点非本地时走代理）。
- 配置档合并语义（`jev/compliance.ts` 之 `loadRuleSets`）：按 agent→rule id 覆盖内建 `RULE_SETS`；**`instructions` 始终以内建为准，配置档中所写会被忽略**；JSON 中新 id 追加于已知规则之后；JSON 中未知 agent 整组加入；任何读取/解析错误静默回内建默认（fail-open）。
- 二者皆**运行时数据，不入库**（仓库存样例与代码，不存实际配置与审计留痕）。

## 部署

- 本机安装命令：`pi install ~/pi-subagent-jev`（local source，直指项目目录）；实际注册于 `~/.pi/agent/settings.json` 之 `packages` 项（登记为相对路径 `"../../pi-subagent-jev"`，`pi list` 可见）。
- 改码后在 pi 内 `/reload` 生效。

## 注释与提交

- 注释与 commit message 用简体中文；代码标识符、错误信息保持原文（英文 instructions、错误 kind 等照旧）。

## 路线图

- 日后于项目内添 skill，用于配置相关 subagent 之权限与模型地址。
- 开源发布前处理 `client.ts` 默认端点（现指 LAN 私有 JEV 端点，硬编码于 `client.ts` 内）。

## 参考

- `docs/JEV-派发合规审计插件.md` — 拦截式改造前所撰专题档（档首有过时提示），其「经验六则」与红线表述、客户端细节仍有效。
- `jev/compliance.ts` 档头注释 — 判定流程与拦截语义之权威简述。
