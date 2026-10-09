# AGENTS.md — pi-subagent-jev 项目工作规约

面向 agent 之项目规约。在本项目内改动前先读此档。

## 项目概述

pi package（名 **pi-subagent-jev**），扩展二枚：**`extensions/pi-subagent-jev.ts`**（`jev_ask` 工具 ＋ 派单拦截）与 **`extensions/orchestrator-main.ts`**（opt-in 主会话治理，见下节）：
- **派单拦截** — subagent 派单合规审查：钩 pi 的 `tool_call` 事件，对命中规则集之派单（`_all` 全局组在配则凡派单皆中，含无专属组之 agent）把任务原文打包为 state，向 JEV System One 一次性求值；命中规则后按处置模式（`mode`）分流——`block`（缺省）即返回 `{ block: true, reason }`，`warn`（v0.9.0）不阻断、以 `toolCallId` 暂存违规清单，另由 `tool_result` 钩追加于该次 subagent 工具结果之末。block reason 格式为：
  `派单审核未通过（agent=<名>）：` 首行，随后每条违规一行、以 `- ` 前缀（形如 `- Q001: 任务未给出具体文件路径`），末行固定 `请修正任务描述后重派。`；整个 reason 作为错误结果返给主 agent，subagent 不被派生。
- **通用工具** — `jev_ask`（对 state 文本求值一批类型化问题：`noul` / `choice` / `score`）。
- **运行监控（opt-in，v0.12.0）** — 观察运行中子 agent 之疑似 bash 停滞／无效工具循环／无变化重复失败，命中仅向主会话注入提醒文本（`pi.sendMessage(triggerTurn)`），不打断／不停／不转向。默认关闭，`~/.pi/agent/jev-comp/monitor.json` 存在且 `enabled:true` 方启用，与派单审核彼此独立；详见下节与 `docs/adr/0005-runtime-monitoring.md`。
- **思考深度调整（opt-in）** — 派单未显式指定 `model` 时，预检解析 agent 的 thinking 锚，以同一 JEV 批次之 D001 判定是否升/降一档；默认关闭，配置于 `_global.thinkingDepth`，任一错误 fail-open。

逻辑层在 `jev/`：
- `jev/client.ts` — JEV API 传输层（零 npm 依赖，`spawn curl`；端点由 `JEV_AI_BASE_URL` 必配、无内建默认，路径 `/v1/systemone` 与 `/v1/models`；错误映射为 `JevError`；`ask()` 可携 failover 链路按序切换上游）
- `jev/failover.ts` — 多上游 failover 纯逻辑层（`upstreams.json` 解析校验 `loadFailoverConfig`、失败分类 `classifyFailure`、进程内冷却表 `CooldownTracker`；零 IO 零 curl，可测）
- `jev/compliance.ts` — 配置档解析（问句自含判法、组为编号引用，`loadRuleSets`/`resolveMode`）、state 拼装（`buildState`）、阈值矩阵与 verdict、audit 行构造、警告文案（`formatWarnNotice`）、主流程 `checkDispatch`（`RULE_SETS` 自 v0.7 为空、仅余导出）
- `jev/warning-store.ts` — warn 模式暂存（toolCallId → 警告文本，有界 Map 容量 100 FIFO；纯逻辑，可测）
- `jev/monitor.ts` — 运行监控纯逻辑层（配置解析、循环/重复失败候选检测、state 拼装截断、判定矩阵、告警文案、触发时机 `dueChecks`、控制事件解包 `parseControlEvent`、前台/异步 transcript 双形解析；零 IO 除配置档，可测）
- `jev/depth.ts` — 思考深度梯级、后缀解析、内建 D001 与判定（纯逻辑，可测）
- `jev/monitor-store.ts` — 监控状态暂存（runId → MonitorState：bash 计时、调用环形缓冲、去重窗；有界 Map 容量 100 FIFO；纯逻辑，可测）
- `jev/traininglog.ts` — 训练记录行构造与最佳努力追加（source：`dispatch`/`ask`/`monitor`）

## 结构图

```
pi-subagent-jev/
├── extensions/
│   ├── pi-subagent-jev.ts     # 扩展一：jev_ask 工具 ＋ 派单拦截
│   └── orchestrator-main.ts   # 扩展二（opt-in）：主会话 persona 注入＋直执行工具裁剪＋子 agent 豁免
├── jev/
│   ├── client.ts              # API 传输层（curl、错误映射、key 解析、failover 链路）
│   ├── client.test.ts
│   ├── builtin-transport.ts   # builtin 传输（pi 内建 classifier 平台）纯逻辑层：按序链试/noul↔bool 出入站映射/预败判级，注入 classifyFn 可测
│   ├── builtin-transport.test.ts
│   ├── failover.ts            # failover 纯逻辑（解析校验/失败分类/冷却表）
│   ├── failover.test.ts
│   ├── compliance.ts          # 规则/判定/audit 行（纯逻辑，可测）
│   ├── warning-store.ts       # warn 模式 toolCallId 暂存（纯逻辑，可测）
│   ├── monitor.ts             # 运行监控纯逻辑层（可测）
│   ├── monitor-store.ts       # 监控状态暂存（纯逻辑，可测）
│   ├── depth.ts               # 思考深度调整纯逻辑（梯级、D001、后缀解析）
│   ├── depth.test.ts
│   ├── traininglog.ts         # 训练记录（dispatch/ask/monitor 三源）
│   ├── compliance.test.ts
│   ├── warning-store.test.ts
│   ├── monitor.test.ts
│   └── monitor-store.test.ts
├── docs/
│   └── adr/                     # 0001-upstream-failover.md、0002-global-rules-and-config-only.md、0003-self-contained-questions.md、0004-warn-advisory-mode.md、0005-runtime-monitoring.md
├── scripts/
│   ├── calibrate.ts           # 阈值校准脚本（发真实请求，不进测试）
│   └── calibration-20260925.jsonl
├── examples/
│   ├── compliance-rules.sample.json
│   ├── upstreams.sample.json
│   └── monitor.sample.json
├── skills/
│   └── subagent-jev/SKILL.md
├── README.md
├── AGENTS.md
├── CONTEXT.md                 # 术语表（Upstream / Failover / Cooldown / 全局规则 _all / 问句自含 / Warn 模式）
├── LICENSE
├── package.json
└── .gitignore
```

## orchestrator-main 扩展（opt-in）

第二扩展，治主 agent 会话而非派单，与派单拦截之 `tool_call` 面不相交（彼唯拦 `subagent`）。**默认全不启用**——唯 `~/.pi/agent/jev-comp/orchestrator.json` 存在且可解析方启用（档之有无即启停；坏档静默不启用，fail-open）。三键皆可选：`personaFile`（persona 档路径，默认 `~/.config/pi-orchestrator/persona.md`；所指档不存在则唯注入一步静默跳过）、`blockedTools`（裁剪拦截清单，默认内建十二项，独不拦 `subagent`）、`ceiling`（默认 `{denyExtensions:false}`，经 `pi-subagents/capability-ceiling` 惰性注册子 agent 豁免）。主/子判别双原语：`PI_SUBAGENT_CHILD === "1"`（异步子进程）＋子会话档径之形（`run-<N>/session.jsonl` 或 `forks/<名>.jsonl`，治同进程之前台/fork 子会话）。capability-ceiling 之加载经 fallback 链（先直 import，败则以宿主 npm 目录 `~/.pi/agent/npm` 为基准 createRequire 解析）——包模块根隔离，注册表须取宿主实例故。运行时配置与审计皆不入库，与 jev 同例。

## 运行监控（opt-in，v0.12.0）

治运行中子 agent，与派单审核（派前）互不干扰，信号面亦不相交（彼钩 `tool_call`，此订 `subagent:control-event` ＋ RPC status）。**默认关闭**——唯 `~/.pi/agent/jev-comp/monitor.json` 存在、可解析且 `enabled:true` 方启用（坏档静默不启用，fail-open；仓内 `examples/monitor.sample.json` 仅示 schema）。配置键：`bashFirstCheckMs`（300000，bash 启动后首查总耗时阈值）／`bashRecheckMs`（600000，检查后复询间隔）／`sweepIntervalMs`（600000，兜底巡检：最近未获任何检查满此时长）／`maxCallsPerEval`（6）／`maxCharsPerCall`（800）／`maxStateChars`（8000），非法值逐字段回退缺省。三检测器＋兜底：bash 停滞／无效工具循环／无变化重复失败／无进展巡检；问句为内建常量 M001–M004（英文 instructions＋criteria，阈值 0.6/0.7/0.7/0.6，below/above/above/below），**不经 compliance-rules.json**。触发两线：事件线（`tool_failures` 与缓冲候选检测，信号＋窗口去重）＋时长线（30s tick 驱动 `dueChecks`，同 tick 每 run 合并一次求值；bash 检查「成败皆记」，证据有无皆转复询节奏）。命中以 `pi.sendMessage({triggerTurn:true})` 注入主会话，文案规则触发式（agent＋检测器＋证据节录＋置信度＋核查建议）；**仅提醒，绝不处置**。证据取公开接口（控制事件＋RPC `status` view transcript，前台 fleet 形／异步缩进文本形双解析），不读私有 transcript、不改 pi-subagents；证据不足→`unknown` 不告警。**监控唯主会话武装**（`PI_SUBAGENT_CHILD=1` 加载时即拒，前台/fork 子会话经 `session_start` 档径判别后 disarm；判别异常 fail-safe 向不武装）。**异步子之 bash 最早 240 秒方得见**（首个控制事件 `tool_open_threshold`/`time_threshold`，事件不重发）；异步形无错误标记可凭，M003 于异步恒不命中（弱证据之限）。求值复用 `ask()`（failover 链、每级一发、全链败 fail-open）；trainingLog 开时落 `source:"monitor"` 训练行。决策见 `docs/adr/0005-runtime-monitoring.md`。

## 红线三条（贯穿一切改动）
1. **key 绝不入仓/入日志/入错误文本** — key 之值不得出现在仓库内任何文件、日志、错误消息或返回文本中；仓外运行时配置档（env 档、upstreams.json，皆 600 权限）持有 key 乃既定先例（env 档先例），不在禁列
2. **同一 upstream 之同一 POST 绝不重发、不退避**；连接败/超时/5xx/429/401/403/404/坏体则按序切换至下一 upstream，每级一发；429 仅解析并上报 `retryAfterMs`（来自 `Retry-After` 头）并解析入 audit，但不睡眠、不退避；全链败则 fail-open（`JevError.failoverAttempts` 携历次尝试，verdict:"error" 放行）
3. **任何错误 fail-open** — JEV 出错、配置档出错、概率缺失或 noul 字段缺失/非有限数皆放行（后者曾为漏洞，已修复：该规则标 `unknown` 不拦），绝不阻断派发、绝不外抛。`checkDispatch` 捕获一切异常返 `verdict:"error"` 行且 violations 为空

## 测试铁律
- `npm test`（即 `node --test jev/*.test.ts`，当前 188 条）**全绿方可提交**
- 测试不发真实 JEV 端点请求：`client.test.ts` 起本地 127.0.0.1 随机端口 mock HTTP server、真发 curl；`failover.test.ts` 纯逻辑＋注入时钟；`compliance.test.ts` 注入 `askFn`；`monitor*.test.ts` 注入概率＋假时钟。`scripts/calibrate.ts` 是唯一发真实请求的脚本，不进测试

## 配置与运行时
- 规则配置表生效档：`~/.pi/agent/jev-comp/compliance-rules.json`（**v0.7.0 起代码零内建规则，此档为规则唯一来源**——档缺/坏即零拦截全放行；监控问句 M001–M004 为内建常量、不在此档；档经 subagent-jev skill 创建或用户手书，仓内 `examples/compliance-rules.sample.json` 仅示 schema、非部署之源；**v0.8.0 起 schema：问句自含判法，各组 `rules` 为问句编号字符串数组**）。配置表在扩展加载时**读一次**，改后须在 pi 内 `/reload` 方生效
- 问句即规则（v0.8.0）：`_questions` 每条自含 `instructions`／可选 `criteria`（true/false 答支判据，透传 JEV 消歧，非法值静默弃之）／`blockWhen`（below/above）／`threshold`／`message`；各 agent 组与 `_all` 的 `rules` 为问句编号字符串数组（如 `["Q001"]`）。verdict 标签与拦截判定均按配置计算，无硬编码编号
- 处置模式（v0.9.0）：`_global.mode`（缺省 `block`）与各组可选 `mode`，取值唯 `block`/`warn`，非法值静默回 `block`；有效模式归并 `resolveMode`＝组级显式 ＞ 全局 ＞ block。warn 命中**不阻断**：`tool_call` 以 `toolCallId` 暂存违规清单（`WarningStore` 容量 100 FIFO），`tool_result` 钩取回、追加于该次 `subagent` 工具结果 content 之末（异步派单随启动回执、阻塞派单随最终输出，皆同条到达；追加于末以保启动回执首行 `Async: <agent> [<id>]` 不被扰）。无专属组之 agent 随全局模式；无规则命中则模式无影响。警告收集与 `tool_result` 钩任何错误皆 fail-open（不得扭曲真工具结果）
- 顶层问句库 `_questions`（形如 `"Q001": { "label"?, "instructions", "criteria"?, "blockWhen", "threshold", "message" }`）：一问一条、自含判法，**同文之条共用一编号，改则一处生效**。`label` 仅供人读、一概忽略。条目须 `instructions` 非空白、`blockWhen` 为 below/above、`threshold` 为有限数，否则加载时整条静默弃之（fail-open，**绝不抛错**）。编号约定：agent 专属问以 `Q` 冠（只增不退）、全局问以 `G` 冠
- 审计日志：`~/.pi/agent/jev-comp/audit.jsonl`（每次求值一行；**规则命中时**——block/warn 皆然——含 `blocked` 数组，无命中则不写此键；warn 模式之行另附 `action: "warn"`，block/pass/error 行形状不变）。顶层开关 `_global: { "auditProbabilities": true }` 时审计行附 `probs`（规则 id → 原始概率，仅有限值）；缺省/false 不附。**仅切换发生或保底成功时**审计行另附 `upstream`（胜出端点名）与 `failover`（历次失败/冷却尝试 `{name,status?,kind?,ms,retryAfterMs?,fallback?}` 数组；无尝试则不落此键）；保底成功（全链冷却下被迫真发首名）另附 `fallback: true`；未切换且非保底之行无上述诸键；全链败尽之错误行只带 `failover`（无胜者）
- 训练记录：`_global: { "trainingLog": true }`（缺省 false）时，每次派单求值与每次 `jev_ask` 调用另追加一行于 `~/.pi/agent/jev-comp/training.jsonl`（state ＋ questions ＋ 概率/答案，`source` 为 `"dispatch"`/`"ask"`/`"monitor"`）；写入失败静默吞（fail-open），运行时数据不入库。另有 `scripts/prune-training.ts`（缺省 dry-run，`--write` 落档并自动备份）——按现行规则档甄别训练档，剔去以旧版 criteria 或临时 key 求值之测试行，唯留逐字相符者；`dispatch` 行一律保留
- key 解析链（`jev/client.ts`）：显式参数 `apiKey` → 进程 env `JEV_AI_API_KEY` → env 档（`envFile` 参数 → `JEV_AI_ENV_FILE` → 默认 `~/.config/jev-comp/env`，600 权限）。env 档可配三键：`JEV_AI_API_KEY`/`JEV_AI_BASE_URL`/`JEV_AI_MODEL`（后者仅作用于 `ask()`）。env 档于进程内有缓存（`envFileCache`，键为档路径，无失效机制），运行期改档须 `/reload` 方生效——`/reload` 重导入扩展模块、缓存随实例重置（2026-09-27 实证）。model 解析序：显式参数 `model` → 进程 env `JEV_AI_MODEL` → env 档 → 内建默认 `oc/jev-1.13-free`。另有 `JEV_AI_BASE_URL`（**必配**，无内建默认；解析序：显式参数 `baseUrl` → 进程 env → env 档，全落空则 `ask()` 报 `not_configured`，派单拦截 fail-open 放行）与 `JEV_AI_PROXY`（显式给值且端点非本地时走代理）。
- **思考深度调整（opt-in）**：`_global.thinkingDepth` 缺省 `{enabled:false, defaultAnchor?:<合法 thinking level>, threshold:0.7}`；仅 enabled 且未显式派单 `model` 时，经 `pi-subagents/preflight` 取 thinking 锚（缺失则用 defaultAnchor，`off`/未知跳过），将内建 D001 choice 与合规问句合并为单次 JEV 请求。lower/higher 概率 `>= threshold` 方升/降一档；四档 minimal/low、medium、high/xhigh、max，边界钳制；需改写时将规范 level 写入 `model` 后缀。配置坏值静默回默认；任何错误 fail-open。
- **传输双路（可选，v0.10.0）**：`_global.transport`（缺省 `"selfhost"`，唯字面 `"builtin"` 生效、其余静默回缺省）择求值传输，随规则档加载时读一次。`builtin` 时经 pi 内建 classifier 平台（`ctx.modelRegistry.classify`，须 pi ≥ 0.99）求值——凭据 pi 代管（`--api-key`→`auth.json`→`models.json`→env），本仓零 key；链路为 `_global.builtinChain`（`{provider,model}` 有序数组，非法项静默弃，空/缺省回 `[{provider:"typesafe",model:"jev-latest"}]`），每级恒 `maxRetries:0` 守红线②；级败（异常／stopReason 非 stop／答案缺失或 noul 概率非有限／条目未解析预败零请求）即切下一级，全链败尽 fail-open。audit `model` 记胜出条目名 `<provider>/<model>`（非响应体模型 id）；builtin 下 jev_ask 之 model 参数接受但忽略。逻辑层在 `jev/builtin-transport.ts`（纯逻辑、注入 classifyFn 可测、零依赖 pi）
- 配置档解析语义（`jev/compliance.ts` 之 `loadRuleSets`，返回 `{ agents, all, global }`）：**v0.7.0 起内建规则全废（`RULE_SETS` 为空），规则唯存配置档；v0.8.0 起组唯编号引用，旧 `{id, question, …}` 规形不再加载**；顶层保留键三——`_global`（全局开关）、`_questions`（自含问句库）、**`_all`（全局引用组）**，均不视作 agent 名。`_all` 之 `rules` 所列问句凡派单皆受查（含无专属组之 agent，其 state 述语写死 `"a sub-agent"`，`_all.agentDesc` 不读），与 agent 专属编号并集**去重**（全局在前，一次请求）；组内非字符串项、悬空编号、重复编号皆静默忽略。任何读取/解析错误静默回空默认（fail-open）
- 二者皆**运行时数据，不入库**（仓库存样例与代码，不存实际配置与审计留痕）
- **多上游 failover（可选）**：生效档 `~/.pi/agent/jev-comp/upstreams.json`（仓库内 `examples/upstreams.sample.json` 为样例；代码只读绝不写，运行时数据不入库）。档不存在或任何解析/校验错误 → 返 null，走旧单端点链路（fail-open）。扩展加载时读一次（`jev/compliance.ts` 模块级懒缓存，`/reload` 重导入即重置）。顶层 `timeoutMs`（缺省 5000，curl `--max-time` 按秒取整）与 `cooldownMs`（缺省 30000）须为正整数；`upstreams` 须非空数组，每项 `{name, baseUrl, apiKey, model, proxy?}`：name 非空且唯一、baseUrl/apiKey/model 非空、baseUrl 末尾斜杠剥除、proxy 可选（缺省走既有 `JEV_AI_PROXY` 链）。`ask()` 按序尝试：首级用显式 `model` 参数（若传）否则各 upstream 自身 model；显式传 `baseUrl`/`apiKey`（如校准脚本）绕开链路。切换分类与冷却语义见 `jev/failover.ts` 档头注释（链上只一 upstream 时，其入冷却即全链冷却、每次皆保底真发，故冷却仅余 audit 意义）；决策记录见 `docs/adr/0001-upstream-failover.md`

## 部署
- 本机安装命令：`pi install ~/pi-subagent-jev`（local source，直指项目目录）；实际注册于 `~/.pi/agent/settings.json` 之 `packages` 项（登记为相对路径 `"../../pi-subagent-jev"`，`pi list` 可见）
- 改码后在 pi 内 `/reload` 生效

## 注释与提交
- 注释与 commit message 用简体中文；代码标识符、错误信息保持原文（英文 instructions、错误 kind 等照旧）

## 参考
- `jev/compliance.ts` 档头注释 — 判定流程与拦截语义之权威简述
- `docs/local-model-laya.md` — 本地 laya 兼容端点作 JEV 后端之实测（2026-09-27）：API 形状兼容、时延低，但 72 对求值判定分歧 43–44%，不可作 `checkDispatch` 后端，仅宜短裸问粗筛（须另校阈值）
