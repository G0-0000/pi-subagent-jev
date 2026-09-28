# AGENTS.md — pi-subagent-jev 项目工作规约

面向 agent 之项目规约。在本项目内改动前先读此档。

## 项目概述

pi package（名 **pi-subagent-jev**），扩展二枚：**`extensions/pi-subagent-jev.ts`**（`jev_ask`/`jev_models` 工具 ＋ 派单拦截）与 **`extensions/orchestrator-main.ts`**（opt-in 主会话治理，见下节）：
- **派单拦截** — subagent 派单合规**拦截**：钩 pi 的 `tool_call` 事件，对命中规则集的 subagent 派单把任务原文打包为 state，向 JEV System One 一次性求值；命中规则即返回 `{ block: true, reason }`，reason 格式为：
  `派单审核未通过（agent=<名>）：` 首行，随后每条违规一行、以 `- ` 前缀（形如 `- R1: 任务未给出具体文件路径`），末行固定 `请修正任务描述后重派。`；整个 reason 作为错误结果返给主 agent，subagent 不被派生。
- **通用工具** — `jev_ask`（对 state 文本求值一批类型化问题：`noul` / `choice` / `score`）与 `jev_models`（列端点已连模型）。

逻辑层在 `jev/`：
- `jev/client.ts` — JEV API 传输层（零 npm 依赖，`spawn curl`；端点由 `JEV_AI_BASE_URL` 必配、无内建默认，路径 `/v1/systemone` 与 `/v1/models`；错误映射为 `JevError`；`ask()` 可携 failover 链路按序切换上游）
- `jev/failover.ts` — 多上游 failover 纯逻辑层（`upstreams.json` 解析校验 `loadFailoverConfig`、失败分类 `classifyFailure`、进程内冷却表 `CooldownTracker`；零 IO 零 curl，可测）
- `jev/compliance.ts` — 规则集（`RULE_SETS`）、state 拼装（`buildState`）、阈值矩阵与 verdict、audit 行构造、配置档合并（`loadRuleSets`）、主流程 `checkDispatch`

## 结构图

```
pi-subagent-jev/
├── extensions/
│   ├── pi-subagent-jev.ts     # 扩展一：jev_ask / jev_models 工具 ＋ 派单拦截
│   └── orchestrator-main.ts   # 扩展二（opt-in）：主会话 persona 注入＋直执行工具裁剪＋子 agent 豁免
├── jev/
│   ├── client.ts              # API 传输层（curl、错误映射、key 解析、failover 链路）
│   ├── client.test.ts
│   ├── failover.ts            # failover 纯逻辑（解析校验/失败分类/冷却表）
│   ├── failover.test.ts
│   ├── compliance.ts          # 规则/判定/audit 行（纯逻辑，可测）
│   └── compliance.test.ts
├── docs/
│   └── adr/0001-upstream-failover.md
├── scripts/
│   ├── calibrate.ts           # 阈值校准脚本（发真实请求，不进测试）
│   └── calibration-20260925.jsonl
├── examples/
│   ├── compliance-rules.sample.json
│   └── upstreams.sample.json
├── skills/
│   └── subagent-jev/SKILL.md
├── README.md
├── AGENTS.md
├── CONTEXT.md                 # 术语表（Upstream / Failover / Cooldown）
├── LICENSE
├── package.json
└── .gitignore
```

## orchestrator-main 扩展（opt-in）

第二扩展，治主 agent 会话而非派单，与派单拦截之 `tool_call` 面不相交（彼唯拦 `subagent`）。**默认全不启用**——唯 `~/.pi/agent/jev-comp/orchestrator.json` 存在且可解析方启用（档之有无即启停；坏档静默不启用，fail-open）。三键皆可选：`personaFile`（persona 档路径，默认 `~/.config/pi-orchestrator/persona.md`；所指档不存在则唯注入一步静默跳过）、`blockedTools`（裁剪拦截清单，默认内建十二项，独不拦 `subagent`）、`ceiling`（默认 `{denyExtensions:false}`，经 `pi-subagents/capability-ceiling` 惰性注册子 agent 豁免）。主/子判别唯 `PI_SUBAGENT_CHILD === "1"`。capability-ceiling 之加载经 fallback 链（先直 import，败则以宿主 npm 目录 `~/.pi/agent/npm` 为基准 createRequire 解析）——包模块根隔离，注册表须取宿主实例故。运行时配置与审计皆不入库，与 jev 同例。

## 红线三条（贯穿一切改动）
1. **key 绝不入仓/入日志/入错误文本** — key 之值不得出现在仓库内任何文件、日志、错误消息或返回文本中；仓外运行时配置档（env 档、upstreams.json，皆 600 权限）持有 key 乃既定先例（env 档先例），不在禁列
2. **同一 upstream 之同一 POST 绝不重发、不退避**；连接败/超时/5xx/429/401/403/404/坏体则按序切换至下一 upstream，每级一发；429 仅解析并上报 `retryAfterMs`（来自 `Retry-After` 头）并解析入 audit，但不睡眠、不退避；全链败则 fail-open（`JevError.failoverAttempts` 携历次尝试，verdict:"error" 放行）
3. **任何错误 fail-open** — JEV 出错、配置档出错、概率缺失或 noul 字段缺失/非有限数皆放行（后者曾为漏洞，已修复：该规则标 `unknown` 不拦），绝不阻断派发、绝不外抛。`checkDispatch` 捕获一切异常返 `verdict:"error"` 行且 violations 为空

## 测试铁律
- `npm test`（即 `node --test jev/*.test.ts`，72 条）**全绿方可提交**
- 测试不发真实 JEV 端点请求：`client.test.ts` 起本地 127.0.0.1 随机端口 mock HTTP server、真发 curl；`failover.test.ts` 纯逻辑＋注入时钟；`compliance.test.ts` 注入 `askFn`。`scripts/calibrate.ts` 是唯一发真实请求的脚本，不进测试

## 配置与运行时
- 规则配置表生效档：`~/.pi/agent/jev-comp/compliance-rules.json`（仓库内 `examples/compliance-rules.sample.json` 为样例；**改默认阈值时两边同步**——`jev/compliance.ts` 内建 `RULE_SETS` 与样例 JSON）。配置表在扩展加载时**读一次**，改后须在 pi 内 `/reload` 方生效
- 规则全由配置驱动：规则 id 为任意字符串（不限于 R1-R4），每规则自带 `instructions`/`blockWhen`（below/above）/`threshold`/`message`，另可选 `criteria`（true/false 答支判据，透传 JEV 消歧；非法值静默弃之，fail-open）与 `question`（引顶层问句库编号，可选）；verdict 标签与拦截判定均按配置计算，无硬编码规则 id
- 顶层共享问句库 `_questions`（形如 `"Q001": { "label"?, "instructions"?, "criteria"? }`）：**同文之条引同一编号，改则一处生效**。规则给 `question` 且该编号在库中可解析 → 以库中 `instructions`/`criteria` 为准，**忽略该规则内联之两者**；编号悬空或库中无此项 → 回退该规则内联字段（再无内联则 `instructions` 为空，循既有「空/空白 instructions 之规则在检查时跳过」之 fail-open，**绝不抛错**）。`label` 仅供人读、一概忽略（可存不可用）。展开**于合并之后**进行（以免仅给 `question` 之规则被内建值回填）；展开后内部规则对象仍持 `instructions`/`criteria`，`checkDispatch`、audit、训练记录之形状一律同旧
- 审计日志：`~/.pi/agent/jev-comp/audit.jsonl`（每次求值一行；**命中拦截时**含 `blocked` 数组，无命中则不写此键）。顶层开关 `_global: { "auditProbabilities": true }` 时审计行附 `probs`（规则 id → 原始概率，仅有限值）；缺省/false 不附。**仅切换发生或保底成功时**审计行另附 `upstream`（胜出端点名）与 `failover`（历次失败/冷却尝试 `{name,status?,kind?,ms,retryAfterMs?,fallback?}` 数组；无尝试则不落此键）；保底成功（全链冷却下被迫真发首名）另附 `fallback: true`；未切换且非保底之行无上述诸键；全链败尽之错误行只带 `failover`（无胜者）
- 训练记录：`_global: { "trainingLog": true }`（缺省 false）时，每次派单求值与每次 `jev_ask` 调用另追加一行于 `~/.pi/agent/jev-comp/training.jsonl`（state ＋ questions ＋ 概率/答案，`source` 为 `"dispatch"`/`"ask"`）；写入失败静默吞（fail-open），运行时数据不入库。另有 `scripts/prune-training.ts`（缺省 dry-run，`--write` 落档并自动备份）——按现行规则档甄别训练档，剔去以旧版 criteria 或临时 key 求值之测试行，唯留逐字相符者；`dispatch` 行一律保留
- key 解析链（`jev/client.ts`）：显式参数 `apiKey` → 进程 env `JEV_AI_API_KEY` → env 档（`envFile` 参数 → `JEV_AI_ENV_FILE` → 默认 `~/.config/jev-comp/env`，600 权限）。env 档可配三键：`JEV_AI_API_KEY`/`JEV_AI_BASE_URL`/`JEV_AI_MODEL`（后者仅作用于 `ask()`）。env 档于进程内有缓存（`envFileCache`，键为档路径，无失效机制），运行期改档须 `/reload` 方生效——`/reload` 重导入扩展模块、缓存随实例重置（2026-09-27 实证）。model 解析序：显式参数 `model` → 进程 env `JEV_AI_MODEL` → env 档 → 内建默认 `oc/jev-1.13-free`。另有 `JEV_AI_BASE_URL`（**必配**，无内建默认；解析序：显式参数 `baseUrl` → 进程 env → env 档，全落空则 `ask()`/`listModels()` 报 `not_configured`，派单拦截 fail-open 放行）与 `JEV_AI_PROXY`（显式给值且端点非本地时走代理）。
- 配置档合并语义（`jev/compliance.ts` 之 `loadRuleSets`，返回 `{ agents, global }`）：按 agent→rule id 覆盖内建 `RULE_SETS`；**`instructions` 亦以配置档为准，内建仅作 JSON 中未出现规则之缺省**；JSON 中新 id 追加于已知规则之后；JSON 中未知 agent 整组加入；顶层保留键 `_global`（全局开关）与 `_questions`（共享问句库）均不视作 agent 名；规则之 `question` 引用于合并后展开（语义见上），展开后内部形状同旧；任何读取/解析错误静默回内建默认（fail-open）。最终 `instructions` 为空/空白的规则在检查时跳过（fail-open）；`criteria` 同按 agent→rule id 覆盖合并，非法值静默弃之
- 二者皆**运行时数据，不入库**（仓库存样例与代码，不存实际配置与审计留痕）
- **多上游 failover（可选）**：生效档 `~/.pi/agent/jev-comp/upstreams.json`（仓库内 `examples/upstreams.sample.json` 为样例；代码只读绝不写，运行时数据不入库）。档不存在或任何解析/校验错误 → 返 null，走旧单端点链路（fail-open）。扩展加载时读一次（`jev/compliance.ts` 模块级懒缓存，`/reload` 重导入即重置）。顶层 `timeoutMs`（缺省 5000，curl `--max-time` 按秒取整）与 `cooldownMs`（缺省 30000）须为正整数；`upstreams` 须非空数组，每项 `{name, baseUrl, apiKey, model, proxy?}`：name 非空且唯一、baseUrl/apiKey/model 非空、baseUrl 末尾斜杠剥除、proxy 可选（缺省走既有 `JEV_AI_PROXY` 链）。`ask()` 按序尝试：首级用显式 `model` 参数（若传）否则各 upstream 自身 model；显式传 `baseUrl`/`apiKey`（如校准脚本）绕开链路。切换分类与冷却语义见 `jev/failover.ts` 档头注释；决策记录见 `docs/adr/0001-upstream-failover.md`

## 部署
- 本机安装命令：`pi install ~/pi-subagent-jev`（local source，直指项目目录）；实际注册于 `~/.pi/agent/settings.json` 之 `packages` 项（登记为相对路径 `"../../pi-subagent-jev"`，`pi list` 可见）
- 改码后在 pi 内 `/reload` 生效

## 注释与提交
- 注释与 commit message 用简体中文；代码标识符、错误信息保持原文（英文 instructions、错误 kind 等照旧）

## 参考
- `jev/compliance.ts` 档头注释 — 判定流程与拦截语义之权威简述
- `docs/local-model-laya.md` — 本地 laya 兼容端点作 JEV 后端之实测（2026-09-27）：API 形状兼容、时延低，但 72 对求值判定分歧 43–44%，不可作 `checkDispatch` 后端，仅宜短裸问粗筛（须另校阈值）
