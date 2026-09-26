---
name: subagent-jev
description: 为 subagent 配制 JEV 派单合规规则之用。当用户要为某个 subagent（worker/scout 等）新增或调整 JEV 合规规则、录入 JEV 模型/端点设置，或言「配置 subagent 规则」「subagent-jev」时加载。
---

# subagent-jev — JEV 合规规则配置流程

为 pi-subagent-jev 之派单审核配置规则：查环境 → 查模型 → 试连通 → 读 prompt → 定规则 → 测规则 → 写配置。全程恪守红线三条：apiKey 之值不入任何档/日志/错误文本；POST 不自动重试；任何错误 fail-open。

## 前置步 · 查环境
1. 遣 scout 查 pi-subagents 之有无：`pi list` 所列包，或 `~/.pi/agent/settings.json` 之 `packages` 项（本机目录 `~/.pi/agent/npm/node_modules/pi-subagents/` 存在亦是据）。
2. 未装 → 问用户准后遣 worker 行 `pi install pi-subagents`；装毕嘱用户于 pi 内 `/reload`，再续下步。
3. 已装 → 径续。

## 第〇步 · 查模型设置
1. 遣 scout 查 `~/.config/jev-comp/env` 之**键名**（唯查 `JEV_AI_API_KEY`/`JEV_AI_BASE_URL`/`JEV_AI_MODEL` 三键之有无，**绝不读值**）及进程 env 同名变量之有无。
2. 缺 `JEV_AI_BASE_URL` 或 `JEV_AI_MODEL` → 询问用户后遣 delegate 以 `KEY=VALUE` 行写入该 env 档（档权限须 600）。
3. 缺 `JEV_AI_API_KEY` → **嘱用户亲笔自填**，agent 全程不经手其值。
4. 三键俱齐 → 以 `jev_models` 试连通：列得模型即端点与 key 俱通；报错则先排查配置（端点/key/网络），勿续。
5. 连通无碍 → 报现状，问用户：「为哪几个 subagent 定规则？」
6. 可以 `jev_models` 列端点已连模型，供用户拣选 model id。

## 第一步 · 读 prompt
遣 scout 取 `~/.pi/agent/npm/node_modules/pi-subagents/agents/<agent>.md`，析其：职能、工具白名单（有无 bash）、行为契约（如「方向不自决」）、禁忌。注意别名（worker 有别名 developer/coder/implementer/develop）——配置以派单之名为键，约定只用正名。

## 第二步 · 定规则
- 正例（可执行性要素：对象/方案/内容）→ `blockWhen: "below"`，默认阈 0.7
- 反例（越权/破坏/误导措辞）→ `blockWhen: "above"`，默认阈 0.8
- `instructions` 用英文问句（答为 0–1 概率）；`message` 用中文短语
- 规则 id 任意字符串，建议系以前缀字母（如 worker 用 W 系）
- **先呈中文对照表（id/向性/问句中译/阈值/拦截文案）候用户首肯**，再动下一步

## 第三步 · 测规则
以 `jev_ask` 直测 ≥5 个假想任务（1 个合规好任务 ＋ 每反例至少 1 个坏任务）：
- state 形如：`Agent: <名> — <agentDesc>` 换行换行 `Task:` 换行 `<假想任务>`
- questions 即各规则之 noul 问句（键用规则 id）
- 验：好任务全过、坏任务各中其罪；贴线未中者（差 ≤0.05）调阈复测

## 第四步 · 写配置
遣 delegate 将规则组并入 `~/.pi/agent/jev-comp/compliance-rules.json`（顶层键＝agent 名；`_global` 为保留键勿动）。写前先读档，核对既有各组不被破坏。告用户 `/reload` 生效。

## 配置档 schema 速查
顶层键即 agent 名，下书 `agentDesc` 与 `rules` 数组；规则五字段：`id`/`instructions`/`blockWhen`/`threshold`/`message`。`_global.auditProbabilities`（默认 false）开则 audit 行兼记概率原值 `probs`。
- below：概率 < 阈值则拦（正例，求达标有据）；above：概率 > 阈值则拦（反例，求犯忌有凭）
- 拦截文案之首尾（「派单审核未通过…」/「请修正任务描述后重派。」）硬编码于扩展，唯 message 可配

## 校准经验
实测贴线（如 0.77 vs 阈 0.8）即降阈 0.1 复测；好任务之反例值得分常 ≤0.4，降至 0.7 误伤甚微（worker 之 W6 前例：0.8 漏拦「顺带一句」，降 0.7 后 0.77 正入彀中）。
