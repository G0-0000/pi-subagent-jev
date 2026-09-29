# pi v0.99.0 classifier 平台调研 ＋ 派单路由计划

- 日期：2026-09-30
- 状态：**待首肯**（未动一行代码）
- 调研凭据：线上源码考据 ＋ scout 两番只读核查（本机 pi 实装 0.99.0，`pi --version` 可证）；详档留于本机，未随仓

---

## 1. 调研结论：pi v0.99.0 之 classifier 平台面

### 1.1 内建调用路径（扩展可用）

```ts
const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
const result = await ctx.modelRegistry.classify(jev, { state, questions }, { signal });
```

- key、baseUrl、HTTP、重试全由 pi 运行时解析；auth 链：`--api-key` → `auth.json`（`/login`）→ `models.json` → env `TYPESAFE_API_KEY`。**扩展无须自持凭据**。
- `classify()` 永不 reject；错误归 `stopReason: "error"` + `errorMessage`——与我仓 fail-open 天然契合。
- 端点即 `https://api.typesafe.ai/v1/systemone`（我仓 upstreams.json 第二级同款）。
- 内部 `retryProviderRequest` 默认 `maxRetries ?? 2`——**可否经 options 关闭待验**（关涉红线②「同一 POST 绝不重发」）。

### 1.2 类型与协议

- API 层问题类型三：`choice` / `score` / `bool`；线级 `bool` ↔ `noul` 互映（`system-one-shared` 之 `wireRequest`/`parseAnswers`）。与我仓 `noul` 语义全同，**已校准阈值可直接移植**。
- 结果：`choice→{choice,probabilities,confidence}`、`score→{score,confidence}`、`bool→{probability}`；带 `usage`。

### 1.3 各家继承之 Jev 模型

| Provider | Model IDs | 鉴权 |
|---|---|---|
| typesafe | `jev-latest` | `TYPESAFE_API_KEY` |
| openrouter | `typesafe/jev-1.13`、`~typesafe/jev-latest` | `OPENROUTER_API_KEY` |
| cloudflare-workers-ai | `typesafe/jev` | `CLOUDFLARE_API_KEY`＋`CLOUDFLARE_ACCOUNT_ID` |
| vercel-ai-gateway | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| opencode | `jev-1.13`、`jev-1.13-free` | `OPENCODE_API_KEY` |

我仓首级 9router 之 `oc/jev-1.13-free` 即 OpenCode Zen 系——pi 配 `OPENCODE_API_KEY` 可直发，9router 或可退役（见 §5 开放问题）。

### 1.4 llama.cpp 本地 classifier

任一 llama.cpp chat 模型皆可作 classifier（label-token softmax，`llama-cpp-classify` API，`LLAMA_BASE_URL`）。此乃本地后端之**正路**，异于 laya 当年走 systemone 兼容端点之败案（判定分歧 43–44%，见 `docs/local-model-laya.md`）。备用，非本期。

### 1.5 pi 内建无自用

grep 全包实证：除 `jev-router.ts` 示例外，**pi 内建功能无一调用 classifier**——tool_search 纯 BM25、compaction/MCP/虚拟模型核心皆不用。平台铺好，应用层留给扩展。我仓派单拦截恰是其设想之应用形态。

---

## 2. 与本仓现状之对照

| 面 | 我仓现状（`jev/client.ts`） | pi 内建面 |
|---|---|---|
| 传输 | `spawn curl` 自管 | 运行时 fetch |
| key | 自持解析链（env 档 600） | pi auth 链代管 |
| failover | 自造两级＋冷却＋audit | 无（须我方在上层实现） |
| 重试 | 红线②：绝不重发 | 内建默认重试 2 次（待验可关否） |
| 错误 | fail-open | `stopReason:"error"`，天然 fail-open |
| 协议 | systemone 原生（noul） | 同协议，bool↔noul 互映 |

---

## 3. 方向甲：传输层借力 pi 内建（待首肯）

- **改法**：`checkDispatch` 与 `jev_ask` 之求值改走 `ctx.modelRegistry.classify()`；上游链改为 pi 已认之 opencode `jev-1.13-free` ＋ typesafe `jev-latest` 两级，failover/冷却/audit 语义保留在我方上层（某级 `stopReason:"error"` 即切下一级）。
- **收益**：可删 `client.ts` 之 curl 链与 key 解析链；typesafe key 不必再入我方 env 档（红线①更稳）；协议维护归 pi 官方。
- **不动者**：规则集、`compliance.ts` 判定与 audit 形状、阈值——全部照旧。
- **待验前提**：
  1. `ClassifierOptions`（含 `ProviderRequestOptions`）能否传 `maxRetries: 0` 之类以守红线②——查 `pi-ai` 类型与 `retryProviderRequest` 实装。
  2. 9router 之存废——**待用户答**（见 §5）。

## 4. 方向乙：派单时定模型（路由，本期新需求）

- **概念**：`tool_call` 拦截 subagent 派单时，state 已打包、求值已发——**同一次请求**加问一道 complexity 题（`choice`：standard/complex，仿 `jev-router.ts` 问法），按概率阈值在放行时**为该派单定 model**（如复杂→旗舰模型、寻常→廉价模型）。不增请求、不增时延。
- **与 pi 虚拟模型路由之别**：彼按会话内每请求路由（`route()` 每请求跑）；此按**派单时点**一次性定死，正合用户「指派的时候就定模型」之意。
- **关键待验**：`tool_call` 事件钩子能否**改写工具参数**（注入/覆写 `model`），而非仅 `{block}`——查 pi 扩展事件文档与 `dist/core/extensions` 实装。若不可改写，退路二择：
  - 退路一：仅于 audit/training 落「建议模型」，主 agent 自决（零侵入）。
  - 退路二：不合意则 block ＋ reason 提示重派（体验差，不推荐）。
- **模型池**：候选模型清单与默认映射须用户定（如 9router 上可用模型表）；配置建议入 `compliance-rules.json` 之 `_global` 新区块（如 `"routing": {...}`），不守规则档语义者另立新档亦可——设计时再定。
- **校准**：`scripts/calibrate.ts` 增 complexity 题组，发真实请求校阈值；训练档 `training.jsonl` 已可落新增概率供回溯。

## 5. 开放问题（须定夺后方可动工）

| # | 问题 | 谁定 |
|---|---|---|
| 1 | 9router 之 `oc/jev-1.13-free` 是否纯 OpenCode Zen 转发？有无聚合价值（多 key 轮换/额度）？废 or 留 | **用户** |
| 2 | pi 内建 classify 之重试可否关（守红线②） | 验证（查源码/实测） |
| 3 | `tool_call` 钩子可否改写派单参数 `model` | 验证（查文档/源码） |
| 4 | 路由模型池与阈值初值 | 用户＋校准脚本 |
| 5 | 方向甲是否连同方向乙一起做，还是乙先行 | 用户 |

## 6. 实施步骤（首肯后）

1. 验证 §5-2、§5-3（只读核查，@scout 可查本地源码）。
2. 呈具体改动方案（改哪几个档、要点），再获首肯。
3. 分工实施：@coder 改码（先有此计划＋方案），@reviewer 审查，测试铁律 `npm test` 全绿（新增用例随行）。
4. `scripts/calibrate.ts` 校 complexity 题阈值（真实请求，不进测试）。
5. `/reload` 实测派单路由行为；audit/training 留痕核验。
6. 更新 README/AGENTS.md/CONTEXT.md 相应章节；版本进位按例（tag＋GitHub Release 双管齐下，勿蹈 v0.2.0–v0.3.0 只推 tag 之覆辙）。
