# 本地 laya 端点适配性实测（2026-09-27）

本文记录将 JEV 求值后端指向本地 laya 兼容端点（System One 形状）之实测结论，供评估 `JEV_AI_BASE_URL` 切换时参考。**核心结论：laya 可用于连通性验证与低时延粗筛，不可替代生产判定后端。**

## 端点形状
- `GET /v1/models` 返回 `{models:[{name,description,release_date}]}`（非 OpenAI 之 `{data:[...]}`）。
- `POST /v1/systemone` 请求体与 JEV 兼容；除 `noul` 外每问另含 `confidence`、`action.act_probability`，顶层另含 `model`/`family`/`route`，`usage.output_tokens` 恒为 0。`checkDispatch` 唯取 `answers[id].noul`（有限数校验如故），多余字段无碍。
- 模型别名：`auto`/`laya`/`jev-latest`（english 族，约 421M ModernBERT-large）、`laya-multilingual`（multilingual 族 mmBERT）。
- 本地端无需鉴权；切换方式即改 `JEV_AI_BASE_URL`（必要时连同 `oc/jev-1.13-free` 类的 model id 改为 `auto` 等别名，`/reload` 生效）。

## auto 路由
`auto` 按**整包文字**（state＋questions 之全串）之主导脚本路由：汉字主导→multilingual（`route:"dominant script is han"`），英文词主导→english（`route:"english words n/m"`）。本插件 `buildState` 之英文脚手架＋英文 instructions/criteria 使**中文任务仍落 english 族**；是否进 multilingual 不取决于任务语言，而取决于整包占比。

## 对照数据
19 测例 × 15 条生产规则（四组：delegate/worker/scout/librarian，criteria 透传）= 72 对求值/轮；同构两版测例各跑一轮：

| 指标 | 中文任务文轮（auto→english） | 全英文同构轮（19/19 路由 english 确认） |
|---|---|---|
| 判定分歧 | 32/72（44%，误拦16 : 漏拦16） | 31/72（43%，误拦15 : 16） |
| mean\|p_laya − p_prod\| | 0.426 | 0.387 |
| mean\|p_laya − 0.5\| | 0.177 | 0.169 |
| 9router 高置信（≥.85/≤.15）时 laya 落反向 | ~55% | ~50% |
| laya 服务端 latency_ms 均值（每问组一次 POST） | ~56ms | ~51ms（生产模型每案耗时约 550ms 量级；端到端总耗时两案集均值 575–616ms/案） |

- **概率压缩**：laya 输出系统性压向 0.5，与生产模型无稳定映射——恒等与 1−p 两基线拟合皆近抛硬币，**不可经语义翻转或重定阈值补救**。
- **规则级偏置**：凡带长 criteria、需语义权衡之条（认具体路径 R1/L1/S1、辨「顺带/while you're at it」W6/L4、度破坏之确认语境 W5、定决策 S3/L3/W4）偏差最大；短裸问一致性较好。
- 锚点二例：合规照录「新建档」/R1（生产 .97/.99 当放）laya 0.33/0.56 两判拦；纯验证「跑 npm test 勿改文件」/W5（生产 .02/.02 当放）laya 0.88/0.87 两判拦——对「delete/破坏」类表面词有报警癖，above 条直接挪用生产阈值必致大面积误拦。
- 无 criteria 之短裸问（如 L2「是否要求跑命令/改码/运维」）：两轮各仅 1/5 分歧、meanΔ≈0——laya 能答「字面有没有」，答不了「按详尽定义算不算」。
- multilingual 族：强指同一锚点给 0.64；全中文 state 经 auto 进该族给 0.84——较 english 准，但 0.64 仍低于 below@0.7 阈而误拦，亦不堪值勤。

## 对本插件之含义
1. **`checkDispatch` 判定后端勿指向 laya**：43–44% 之 block 分歧将使派单拦截近随机。
2. 红线 fail-open 保证后端劣化不外抛、不阻断（error/unknown 放行），但错误概率造成的**误拦**（`{block:true}`）仍直接伤派发体验，fail-open 不救误拦。
3. 若仅以 laya 充短裸问之**粗筛**（非最终判定），above 类阈值须按 laya 自身分布另行校准；破坏类等高风险 above 条不宜交它。
4. 双端点对照之法可仿 `scripts/calibrate.ts`：同一 state/questions 分打两个 baseUrl，按规则 `blockWhen`/`threshold` 比较两侧 block 判定与概率差。
