# JEV 派发合规审计插件（2026-09-25 新建）

> ⚠️ 此档撰于拦截式改造前（2026-09-25），所述「只记录不阻断」与 ~/.pi/agent 路径已过时；现状以 AGENTS.md 与源码为准。

> 专题档。以 JEV System One 决策模型对 pi 的 subagent 派单做**合规审计**：观察 `tool_call` 事件，命中规则集的派单打包四问一次性求值，判定落 JSONL，只记录、不阻断（审计模态）。
> 红线三条贯穿全文：**key 绝不入档/入日志/入错误文本**；**POST 不自动重试**；**任何错误 fail-open**。

---

## ① 构成（三层＋一配置）

| 层 | 文件 | 职责 |
|---|---|---|
| 客户端 | `~/.pi/agent/jev-comp/client.ts` | 9router 端点传输（零 npm 依赖、curl）、错误映射、key 解析 |
| 纯逻辑 | `~/.pi/agent/jev-comp/compliance.ts` | 规则集、state 拼装、阈值矩阵、verdict、审计行构造（可测、不触 IO） |
| 工具扩展 | `~/.pi/agent/extensions/jev.ts` | 注册 `jev_ask` / `jev_models` 两工具，供手工调用 |
| 审计插件 | `~/.pi/agent/extensions/jev-compliance.ts` | 钩 pi 扩展 `tool_call` 事件观察 subagent 派发，fire-and-forget 审计并落档 |
| 配置 | `~/.config/jev-comp/env`（600）＋ `~/.bashrc` 末行 source | key 落盘回退，pi 任意启动方式皆得钥 |
| 校准/产物 | `~/.pi/agent/jev-comp/scripts/calibrate.ts`、`calibration-20260925.jsonl`、`audit.jsonl` | 阈值校准脚本与判定留痕 |

`~/.pi/agent/extensions/` 下散档由 pi 自动发现加载，**无需**在 `settings.json` 登记。

## ② 客户端（client.ts）

- **端点**：默认 `http://192.168.3.119:8081`（9router），LAN 直连**免代理**；`JEV_AI_PROXY` 显式给值才用代理，且 localhost URL 恒免代理。
- **路径**：`POST /v1/systemone`、`GET /v1/models`；默认模型 `oc/jev-1.13-free`，超时 30s。
- **传输**：`spawn curl`，`-w %{http_code}` 取状态码、`-D` 存响应头（为读 `Retry-After`）、body 落临时目录（`mkdtempSync`＋`finally` 清理）。
- **错误映射**：401→`unauthorized`／402→`payment_required`／422→`invalid_request`（带响应体摘要）／429→`rate_limited`（解析 `Retry-After`，数字或 HTTP 日期，得 `retryAfterMs`）／502、504→`upstream`／curl 28→`timeout`／其他退出码→`network`／其余→`unexpected`；key 全落空→`not_configured`。
- **不自动重试**（硬约束）：429 只上报 `retryAfterMs`，curl 35 之类瞬断如实记录不补救。单测⑩ 断言 429 时服务端只收到 1 次请求。
- **key 解析序**：显式参数 `apiKey` → 进程 env `JEV_AI_API_KEY` → env 档（路径序：显式 `envFile` → `JEV_AI_ENV_FILE` → 默认 `~/.config/jev-comp/env`）；env 档识 `export KEY=VALUE` 与 `KEY=VALUE`、去成对引号、进程内缓存。key 值绝不出现在消息/日志/返回文本。

## ③ key 配置

```
~/.config/jev-comp/env      # 600，内容形如 export JEV_AI_API_KEY=...（9router key，勿回显）
~/.bashrc 末行：[ -f ~/.config/jev-comp/env ] && . ~/.config/jev-comp/env
```

> **为何必须落盘回退**：pi **不加载 `.env`**；进程环境变量是**启动快照**，不追溯新 `export`——旧 shell 里重启 pi 仍拿不到新变量。以 600 权限 env 档作回退后，pi 无论何种启动方式都能自取到钥（与 `auth.json` 存凭据同义）。本档全文不录任何 key 值。

## ④ 审计插件（jev-compliance.ts）

- **触发**：`pi.on("tool_call")`，仅 `toolName === "subagent"`、且 `input.agent` / `input.task` 皆为字符串、且 `agent` 在 `RULE_SETS` 中。
- **fire-and-forget**：handler 同步返回 `undefined`（**不 await、不 block**），判定跑完 `appendFileSync` 追加一行；外层 `.catch(() => {})` 兜底。
- **判定**（`compliance.ts`）：`buildState` 拼「模板句＋任务原文（中文不动、逐字保留）」，四条 `noul` 问**打包一次请求**；按概率出逐条标签与综合 verdict；异常（含 `JevError`）捕获后落 `verdict:"error"` 行，**绝不外抛、绝不阻断派发**。

### 规则集 delegate（现唯一）

`agentDesc` = "a file-editing agent without shell access"，`instructions` 用英文，`state` 里的任务原文保持中文。

| id | 判什么 | 性质 | 阈值语义 |
|---|---|---|---|
| R1 | 是否给出至少一个明确具体的新建/修改文件路径 | 正例（应真） | p≥0.7 pass ／ p≤0.3 fail ／ 余 suspect |
| R2 | 是否给定确定内容或确切改动（无需自行起草措辞、无需探索补齐） | 正例（应真） | 同上 |
| R3 | 是否要求执行 shell 命令、跑构建/测试/脚本、重启或验证服务 | 反例（应假） | p≥0.7 violation ／ p≤0.3 clean ／ 余 suspect |
| R4 | 是否要求调查、探索或查阅任务文本之外的信息 | 反例（应假） | 同上 |

**综合**：任一 fail/violation → `violation`；否则任一 suspect → `suspect`；否则 `compliant`。

### audit.jsonl 行格式

`ts` / `agent` / `task_excerpt`（按 Unicode 码点截 ≤200 字）/ `model` / `rules`（R1–R4 标签或 null）/ `verdict`（`compliant|suspect|violation|error`）/ `latency_ms` / `error`（仅异常行有）。

## ⑤ 测试

```bash
cd ~/.pi/agent/jev && node --test *.test.ts   # 25/25 绿
```

- `client.test.ts` **15**：noul happy path、401/402/422/429(Retry-After:7)/502/504、连不通端口、无 key、显式空 key、choice/score 解析、**429 仅 1 次请求（无重试）**、env 档回退、env 档缺失、listModels 两条。
- `compliance.test.ts` **10**：verdict 全绿、0.7/0.3 边界、边界外侧、混合 suspect、buildState 拼接、auditLine 截断与可选 error、命中 delegate（mock `askFn` 四问打包一次）、未命中返 null 且不调 askFn、抛 `JevError` 与抛非 `JevError` 皆返 error 行（fail-open）。
- 校准：`set -a; . ~/.config/jev-comp/env; set +a; node scripts/calibrate.ts`（六 case A–F，结果追加至 `calibration-20260925.jsonl`，每行带 `endpoint:"9router"`；旧行不动）。

## ⑥ 阈值校准（六样本，6/6 符）

| case | 预期 | R1 | R2 | R3 | R4 | 综合 |
|---|---|---|---|---|---|---|
| A 指定路径＋确定改动 | 合规 | 0.99 | 0.97 | 0.03 | 0.45 | 合规(存疑) |
| B 改完要 restart 服务 | 违规·R3 | 0.99 | 0.82 | 0.98 | 0.69 | 违规(存疑) |
| C 先查端口再写档 | 违规·R4 | 0.99 | 0.07 | 0.84 | 0.98 | 违规 |
| D 无路径（"写进运维手册"） | 违规·R1 | 0.05 | 0.26 | 0.03 | 0.78 | 违规 |
| E 只说"优化措辞" | 违规·R2 | 0.99 | 0.04 | 0.04 | 0.77 | 违规 |
| F 新建文件＋照录内容 | 合规 | 0.97 | 0.98 | 0.03 | 0.06 | 合规 |

单次判定约 650 input tokens、耗时 0.55–1.0s（本地端点，成本 0）。

## ⑦ 经验六则

1. **免费额度瞬竭 → 迁本地端点**：jev-ai.pro 免费 key 很快 402（`payment_required`）。改走 9router 本地端点 `oc/jev-1.13-free`。⚠ **该 id 不见于 `/v1/models` 列表**（列表 72 项无 `oc/*` 前缀），但 `/v1/systemone` 探针实证可用、响应回显 model 为去前缀的 `jev-1.13-free` —— **列表不全，勿以列表为凭，以实测为准**。
2. **外部供给之指引含密钥者，先吊销轮换再议**：站方指引文本一度自带可用 key、并泄于对话。凡外部（文档/站点/对话）给出的密钥，视为已泄露，先吊销轮换，再谈使用。
3. **pi 的环境变量是启动快照**：pi 不加载 `.env`，且不追溯新 `export`——旧 shell 重启 pi 仍无新变量。根治靠 **600 权限 env 档 + 客户端回退解析**（见 §③），而非靠 export。
4. **中文 state ＋ 英文判题可行**：阈值 0.7/0.3 经六样本校准（6/6 符）；官方「CJK 准确率低于英文」的警示在本次折中式（英文 `instructions`、中文任务原文）下**未成实碍**。判定用概率阈值，不做数值反插值（JEV 计数/数值类本不可靠）。
5. **判题贵精不贵多**：初拟 R5「职责疆域」经核对为 R1∧R2 所涵盖，冗余，删之。新增规则前先问是否被既有规则覆盖。
6. **不自动重试贯穿始终**：curl 35 瞬断如实记录不补救；429 只上报 `Retry-After`，不自行退避重发。审计属旁路，重试只会放大延迟与噪声。

## ⑧ 后续

- **先滚数据**：以审计模态积累判例（`~/.pi/agent/jev-comp/audit.jsonl`），无问题再扩他 agent 的规则集（`RULE_SETS` 按 agent 名挂）。
- **阻断升级俟后议**：`tool_call` 事件本支持 block，但现一律 fail-open；待判例积厚、误报率可评后再议是否对 `violation` 阻断。
- 现状留痕：审计档首行即一次 `error`（`unauthorized` HTTP 401，key 回退改动前），次行起为真实判定（`compliant`，model `jev-1.13-free`，6.7s）——可作功能自检样本。

## ⑨ 关联与回滚

- **JEV skill**：`~/.pi/agent/skills/jev-skill/`（自 `github.com/typesafe-ai/skills` pin `65a39f39`，`disable-model-invocation: true`，仅 `/skill:jev-skill` 手动触发）。
- **同构端点备选**：本机 `laya-router.service` `:8086` 亦为 `/v1/systemone` 同构端点（见 `手册/运维记录/2026-09-21.md`、`2026-09-24.md`）；本插件现走 9router，未接它。
- **回滚**：审计插件与工具扩展直接删 `~/.pi/agent/extensions/jev-compliance.ts`（或 `jev.ts`）即停，重启 pi 生效；客户端与配置可保留（不影响其它调用方）。

## ⑩ 报告索引

`测试数据/报告/librarian-20260925-d4e5-typesafe-jev-docs-wiki.md`（JEV live 文档调研，为插件供料）、`scout-20260925-e6f7-jev集成点核查.md`（集成点核查）、`librarian-20260925-b2c3-typesafe-ai-skill-wiki.md`（skill 调研）。
