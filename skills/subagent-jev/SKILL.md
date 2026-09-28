---
name: subagent-jev
description: 为 subagent 配制 JEV 派单合规规则之用。当用户要为某个 subagent（worker/scout 等）新增或调整 JEV 合规规则、录入 JEV 模型/端点设置，或言「配置 subagent 规则」「subagent-jev」时加载。
---

# subagent-jev — JEV 合规规则配置流程

为 pi-subagent-jev 之派单审核配置规则：查已配（`compliance-rules.json` 之有无）→（未配方）查环境 → 查模型 → 试连通 → 读 prompt → 定规则 → 测规则 → 写配置。全程恪守红线三条：apiKey 之值不入任何档/日志/错误文本；POST 不自动重试；任何错误 fail-open。

## 起手势 · 查已配
1. 查 `~/.pi/agent/jev-comp/compliance-rules.json` 之有无。
2. **有** → 此前已配置过（pi-subagents 与模型设置俱在），径问用户：「为哪几个 subagent 定规则？」随即入第一步。唯后续 `jev_ask`/`jev_models` 报错时，回退行下二步排查。
3. **无** → 依次行下二步（前置步、第〇步）。

## 前置步 · 查环境
1. 遣 scout 查 pi-subagents 之有无：`pi list` 所列包，或 `~/.pi/agent/settings.json` 之 `packages` 项（本机目录 `~/.pi/agent/npm/node_modules/pi-subagents/` 存在亦是据）。
2. 未装 → 问用户准后遣 worker 行 `pi install pi-subagents`；装毕嘱用户于 pi 内 `/reload`，再续下步。
3. 已装 → 径续。

## 第〇步 · 查模型设置
1. 遣 scout 查 `~/.config/jev-comp/env` 之**键名**（唯查 `JEV_AI_API_KEY`/`JEV_AI_BASE_URL`/`JEV_AI_MODEL` 三键之有无，**绝不读值**）及进程 env 同名变量之有无。
2. 缺 `JEV_AI_BASE_URL` 或 `JEV_AI_MODEL` → 询问用户后遣 delegate 以 `KEY=VALUE` 行写入该 env 档（档权限须 600）。
3. 缺 `JEV_AI_API_KEY` → **嘱用户亲笔自填**，agent 全程不经手其值。
4. 三键俱齐 → 本次有键新写入/修改者，以一记最小 `jev_ask` 试之（state 一句琐文如「测试」，questions 一记 noul 如 `{probe: {type:"noul", instructions:"Is this a test?"}}`，model 用所配之值或缺省走解析链）：返得概率即端点、key、模型三俱通；报错则先排查配置，勿续。三键本已俱齐则免试径续。
5. 连通无碍 → 报现状，问用户：「为哪几个 subagent 定规则？」
6. 可以 `jev_models` 列端点已连模型，供用户拣选 model id。

## 第一步 · 读 prompt
遣 scout 取该 agent 之定义档：**先查用户级 `~/.agents/<agent>.md`**，无则回落包内 `<pi-subagents 包>/agents/<agent>.md`。缘由：pi-subagents 硬编码扫描 `$HOME/.agents` 为用户级 agent 源，同名者遮蔽包内 builtin——勿径取包内档，包内未必是实际生效者。包之加载路径以 `pi list`／`~/.pi/agent/settings.json` 为准（未必是 `~/.pi/agent/npm/...`）。
析其：职能、工具白名单（有无 bash）、行为契约（如「方向不自决」）、禁忌。**正名精确匹配先于别名解析**——若用户级已建同名正名档，该名即为独立 agent，不再是他者之别名；故配置规则键、派单名皆以正名。
（注意：`coder` 在包内是 worker 之别名，然若用户级另建 `coder.md`，则为一独立 agent，非别名。）

## 第二步 · 定规则
- **立则三纲**（2026-09-27 librarian 组实践定论）：
  1. **能复用则复用**——跨 agent 同义之条（标的/决策/措辞之类）当逐字同文，优化时各组同步改；唯「改动/越权」之条因各 agent 工具白名单与写面各异不可强求（scout S2 原样套 librarian，「回写大脑」虚高 .91 误拦之鉴）。**复用前必以对方组测例互验，两侧全中方同文**；现成同文模板：标的条见 scout S1、决策条见 scout S3、措辞条见 worker W6（今 coder C4、librarian L4、reviewer RV3 皆与之同文）
  2. **能拆则拆**——一条规则唯问一事（标的、改动、决策、措辞各为一问），勿揉「任务合规与否」之大问；拆细则罪名单明、拦截文案知所中、阈值可分调
  3. **问句从简，criteria 详述**——instructions 唯朴素一问（如 "Does the task name a concrete question or topic to investigate?"），答支边界、豁免清单、误判场景皆挪 criteria 双支详陈

- 正例（可执行性要素：对象/方案/内容）→ `blockWhen: "below"`，默认阈 0.7
- 反例（越权/破坏/误导措辞）→ `blockWhen: "above"`，默认阈 0.8
- `instructions` 用英文问句（答为 0–1 概率）；`message` 用中文短语
- `criteria` 可选：`true`/`false` 各一句英文判据，划清答支边界（实测可移概率 0.4–0.7）。写法要诀：**须提供问句未载之边界信息**——纯复述问句定义者无效（分数纹丝不动，W5 首稿之鉴）；`false` 支列举常见误判场景最见效（如「执行已定方案之战术裁量不算决策」「删 node_modules/dist 之类可逆日常操作不算破坏」「任务文中已带批准语不算无确认」）。问句含糊、裸问置信度飘忽或贴线时用之
- 规则 id 任意字符串，建议系以前缀字母（如 worker 用 W 系）
- **先呈中文对照表（id/向性/问句中译/阈值/拦截文案）候用户首肯**，再动下一步

## 第三步 · 测规则（裸问 vs criteria 对比测试）
以 `jev_ask` 直测 ≥6 个假想任务：1 个合规好任务 ＋ 每反例至少 1 个坏任务 ＋ **贴线案例**（反例规则必备两类：「看似犯忌实则合法」如已批准之破坏操作、删 node_modules 之可逆日常操作；「隐蔽违规」如 "use your judgment" 式决策下放——裸问虚高/漏拦多在此类现形）：
- state 形如：`Agent: <名> — <agentDesc>` 换行换行 `Task:` 换行 `<假想任务>`
- **同批测例跑两遍**：裸问一遍、带 criteria 一遍（同一次调用内以键名后缀区分，如 `W2n`/`W2c`），逐规则对比分数
- 验：好任务全过、坏任务各中其罪、贴线案例各归其位；贴线未中者（差 ≤0.05）调阈复测
- **取舍：criteria 无实质改善之规则勿加**（判定无翻转、分数裕度无增者，纯增噪声）；判定虽不变但拉开贴线距离、压虚实高者，亦算优化可加
- **优化目标**：务求判之决断而非贴线——应中者概率 **>0.8**、应放行者 **<0.2**；贴线者（如 0.75 之于阈 0.7）当续加 criteria 或微调阈以拉开裕度
- **优化轮次上限**：自行往复调优**至多 3 轮**；3 轮未达上述目标者**即停**，列各规则之分数与残差请用户裁，勿无限反复
- **测试行勿混入训练档**：`_global.trainingLog` 为 `true` 时，测试求值亦记入 `training.jsonl`。测试毕宜跑仓库之 `scripts/prune-training.ts`（缺省 dry-run，`--write` 方落档并自动备份）——按现行规则档甄别，剔去以旧版 criteria 或临时 key 求值之行，唯留逐字相符之良性样本；`dispatch` 行一律保留

## 第四步 · 写配置
遣 delegate 将规则组并入 `~/.pi/agent/jev-comp/compliance-rules.json`（顶层键＝agent 名；`_global` 为保留键勿动）。写前先读档，核对既有各组不被破坏。告用户 `/reload` 生效。

## 配置档 schema 速查
顶层键即 agent 名，下书 `agentDesc` 与 `rules` 数组；规则字段：`id`/`instructions`/`blockWhen`/`threshold`/`message`，另可选 `criteria`（`{true, false}` 答支判据，直透 JEV 以消歧）。`_global.auditProbabilities`（默认 false）开则 audit 行兼记概率原值 `probs`。
- below：概率 < 阈值则拦（正例，求达标有据）；above：概率 > 阈值则拦（反例，求犯忌有凭）
- 拦截文案之首尾（「派单审核未通过…」/「请修正任务描述后重派。」）硬编码于扩展，唯 message 可配

## 校准经验
实测贴线（如 0.77 vs 阈 0.8）即降阈 0.1 复测；好任务之反例值得分常 ≤0.4，降至 0.7 误伤甚微（worker 之 W6 前例：0.8 漏拦「顺带一句」，降 0.7 后 0.77 正入彀中）。
问句含糊而裸问得分虚高者，加 criteria 划定答支边界有奇效（实测「登录那块有无锚点」裸问 0.76 → 加 criteria 坠至 0.06）；唯 criteria 乃强先验非铁律，不能逆转问句本义（如 "critical" 之类强词仍掣肘）。
2026-09-27 worker 四规则对比实测，criteria 治三类病灶：正例盲区（纯验证任务「跑 npm test」裸问 0.62 误拦 → 加 criteria 升 0.95 放行）、反例虚高（业主已批准之删分支裸问 0.69 贴阈 → 压至 0.09）、反例漏拦（「措辞你自己掂量」裸问 0.76 漏拦 → 升 0.93 正入彀中）。
2026-09-29 立优化标尺：应中者 >0.8、应放行者 <0.2 为裕度之的；自行优化至多 3 轮，逾则停而请裁（防无限调优）。又：措辞条同文一经复用即成跨组契约，改则各组同步且必两侧互验。
