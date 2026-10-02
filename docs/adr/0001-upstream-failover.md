# ADR 0001：多上游 failover（upstreams.json 按序切换链路）

- 日期：2026-09-28
- 状态：已采纳（v0.4.0）

## 背景

拦截链此前只赖单一 JEV 端点（9router，经 env 档 `JEV_AI_BASE_URL`）。2026-09-27 事故（project-memory #499）实证：端点一断，拦截器「在线但失效」——audit 行尽是 `verdict:"error"`、not_configured，fail-open 全放行，合规卡悄然瘫痪，且无第二级可退。

对照实测（`~/ttt/测试数据/typesafe-compare/`，最新报告 `compare-upstreams-20260928-latest.md`）：typesafe（`https://api.typesafe.ai`，model `jev-latest`）与 9router（model `oc/jev-1.13-free`）19 案 × 15 规则 = 72 对求值，mean|Δ| = 0.006、median 0、max 0.07，判定分歧仅 2 处（delegate/B-违规R3/R2：0.69 vs 0.74；librarian/L-BAD-L3/L1：0.71 vs 0.69，均为贴线阈值交叉，同模型噪声级）。求值出错 0 次。laya 本地端因 72 对分歧 43–44%（project-memory #507）排除在外。typesafe 侧模型定 `jev-latest` 而非 `jev-1.13.0`：后者虽被端点接受却不在 `/v1/models` 官方列表（官方唯 `jev-latest`/`jev-preview`）。

## 决策

1. **链路落传输层**（`jev/client.ts`），不落拦截层——`ask()` 携可选 `failover` 配置按序迭代上游；`scripts/calibrate.ts`（显式传 baseUrl/apiKey 或不带 failover）一律不受链路影响，量具读数不得混入他端点。
2. **切换分类**（`jev/failover.ts` 之 `classifyFailure`，唯一权威）：network/timeout/5xx/429/401/403/404/200 不可用响应体 → 按序切下一级；402/其余 4xx 含 422/3xx/not_configured → 立即抛、下一级零请求。
3. **红线二修订**：由「POST 不自动重试」精化为「同一 upstream 之同一 POST 绝不重发、不退避；切换按序每级一发；Retry-After 仅解析入 audit 不睡眠；全链败则 fail-open」。无重试之精神不变——变化仅在失败后允许**换端点**再试一发。
4. **单一阈值集**：两端点判定高度一致（mean|Δ| 0.006），不引入 per-upstream 阈值，沿用同一生效规则表。
5. **冷却仅进程内**（`CooldownTracker`，内存 Map）：唯连接级败北（network/timeout/5xx）冷却跳过，重启即忘；429 与 4xx 绝不冷却。

## 后果

- 两端点模型若日后 diverge（分歧显著上升），per-upstream 阈值须回炉（届时另立 ADR）。
- 冷却不持久、不跨进程：pi 重启后首击仍会撞冷却中的死端点一次（可接受——每级恰一发，代价一次失败时延）。
- `upstreams.json` 为运行时档不入库；仓内唯样例 `examples/upstreams.sample.json`。

## 附注（2026-09-28 运行时演练勘误）

- audit 行之 `model` 字段取自上游响应体 `res.model`（`jev/compliance.ts`），非请求/配置 model 名。TypeSafe 端点对请求名 `jev-latest` 自报响应体 `"model":"jev-1.13.0"`（校准数据 38/38 行）——证实 `jev-latest` 现指向同一服役模型，audit 记 `jev-1.13.0` 与配置 `jev-latest` 并不矛盾。
- 冷却中被跳过之首配 upstream 记入 audit `failover` 数组为 `{ name, kind: "cooldown" }`（无 status、无 ms，零请求）；胜者非首配 upstream 时 audit 行落 `upstream`/`failover` 键（胜者即成时仍不落），故「冷却跳过」与「旧单端点链路」在审计上可辨。
- 全链冷却保底（2026-09-29）：`eligible()` 于全冷却时保底返首位，该次真发之尝试于 audit 标 `fallback: true`；成功保底之行携 `upstream` ＋ `fallback: true`、无 `failover` 数组（故「保底成功」与「首配一举即成」在审计上互辨）。保底失败只续该首级自身之钟，**不延长他级冷却**——曾有审查报「一次可恢复 5xx 实付 2×cooldownMs、链长 N 则 N×cooldownMs」，经以真实模块可执行复演证否。
