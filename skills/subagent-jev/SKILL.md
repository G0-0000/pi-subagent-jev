---
name: subagent-jev
description: 为 subagent 配制 JEV 派单合规规则之用。当用户要为某个 subagent（worker/scout 等）新增或调整 JEV 合规规则、录入 JEV 模型/端点设置，或言「配置 subagent 规则」「subagent-jev」时加载。
---

# subagent-jev — JEV 合规规则配置向导

本 skill 于用户初装插件或后续改配时加载，司四事：初始化、释配置档格式、定规则、示注意事项。红线三条贯穿全程：apiKey 之值不入任何档/日志/错误文本；POST 不自动重试；任何错误 fail-open。完整文档以 README 为权威，本档唯作向导，不复述全文。

## 一、初始化

起手势：查 `~/.pi/agent/jev-comp/compliance-rules.json` 之有无。**有** → 已初始化，径问用户「为哪个 subagent 配规则？」入第三模块。**无** → 依次行下四步：

1. **装 pi-subagents**——派单拦截钩其 `subagent` 工具，未装先装（`pi install pi-subagents`），装毕 `/reload`。
2. **配模型**——二选一：
   - 插件自管端点：建 env 档 `~/.config/jev-comp/env`（权限 600），三键 `JEV_AI_API_KEY`（**嘱用户亲笔自填**，agent 全程不经手其值）／`JEV_AI_BASE_URL`（必配）／`JEV_AI_MODEL`（可选）；
   - 走 pi 内建 classifier（须 pi ≥ 0.99）：凭据 pi 代管、插件零 key，链路于规则档 `_global.builtinChain` 配置。
   详见 README「Install」与「Transport: selfhost vs builtin」节。
3. **试连通**——以一记最小 `jev_ask` 试之（state 一句琐文如「测试」，questions 一记 noul 如 `{probe: {type:"noul", instructions:"Is this a test?"}}`）：返得概率即端点、key、模型三俱通；报错先排查配置，勿续。可以 `jev_models` 列端点已连模型，供用户拣选 model id。
4. **生效**——于 pi 内 `/reload`。

（可选：多上游 failover 档 `~/.pi/agent/jev-comp/upstreams.json` 聚多枚 key，宜用户手书，本 skill 不代写。样例见 `examples/upstreams.sample.json`，详见 README「多上游 failover」节。）

## 二、配置文件格式说明

规则档唯一来源：`~/.pi/agent/jev-comp/compliance-rules.json`——代码零内建规则，档缺/坏即零检查全放行。骨架速查：

- 顶层三保留键——`_global`（全局开关）、`_questions`（问句库）、`_all`（全局引用组），皆不视作 agent 名
- `_questions`：一问一条、自含判法 `{label?, instructions, criteria?, blockWhen, threshold, message}`；`label` 仅供人读
- 各 agent 组（顶层键＝agent 名）：`{agentDesc, mode?, rules}`，`rules` 为问句编号字符串数组
- `_all`：形同组而无 `agentDesc`，所列编号凡派单皆查（含无专属组之 agent），与组引并集去重、全局在前
- 向性：`below`＝概率低于阈则拦（正例，求达标有据）；`above`＝概率高于阈则拦（反例，求犯忌有凭）

**配置模板**：`examples/compliance-rules.sample.json`（仅示 schema，非部署之源）。完整字段语义、audit 字段、mode/transport/failover 诸节悉见 README 对应章节——彼为权威，本档不复述。

## 三、配置规则

1. **问用户**：为哪个 subagent 配规则，抑配全局 `_all`（凡派单皆查，含无专属组之 agent——此点须向用户言明）。
2. **读 prompt**：取该 agent 之定义档——**用户级 `~/.agents/<agent>.md` 优先**，无则回落包内 `agents/<agent>.md`（同名用户级档遮蔽包内 builtin；正名精确匹配先于别名解析——若用户级已建同名正名档，该名即为独立 agent，非他者之别名）。析其职能、工具白名单（有无 bash）、行为契约、禁忌，录为组之 `agentDesc`——务使档中描述与定义符实。
3. **定规则**，立则三纲：
   - **能复用则复用**——语义与判法皆同者引同一编号，改则一处生效；同问须异判法（异阈/异文案）即非同问，当分立两条
   - **能拆则拆**——一条规则唯问一事（标的、改动、决策、措辞各为一问），勿揉「任务合规与否」之大问
   - **问句从简，criteria 详述**——`instructions` 唯朴素一问；答支边界、豁免清单、误判场景皆挪 `criteria` 双支详陈（`false` 支列举常见误判场景最见效）
   正例（可执行性要素：对象/方案/内容）→ `blockWhen: "below"`，默认阈 0.7；反例（越权/破坏/误导措辞）→ `blockWhen: "above"`，默认阈 0.8。`instructions` 用英文问句，`message` 用中文短语。编号约定：agent 专属问以 `Q` 冠（只增不退），全局问以 `G` 冠。
   **先呈中文对照表（id/向性/问句中译/阈值/拦截文案）候用户首肯**，再动下一步。
4. **测规则**：以 `jev_ask` 测 ≥6 个假想任务（合规好任务＋每反例至少一坏任务＋贴线案例），裸问与带 criteria 同批对比；应中者 >0.8、应放行者 <0.2；自行调优至多 3 轮，逾则请用户裁。**细则与校准经验见 [references/calibration.md](references/calibration.md)。**
5. **写配置**：改前先读档，核对既有各组不被破坏；同义且同判之问引同一编号，勿另起一条；写毕告用户 `/reload` 生效。

## 四、注意事项

- **key 安全**：apiKey 之值绝不入任何档/日志/错误文本；env 档与 upstreams.json 皆须 600 权限；`JEV_AI_API_KEY` 由用户亲笔自填，agent 全程不经手其值（查配置唯查键名之有无，**绝不读值**）。
- **fail-open**：端点不可达、key 缺失、规则档损坏，派单一律放行；非法问句条目、非字符串/悬空/重复编号、非法 mode 值皆静默忽略——**配置笔误不报错，唯表现为「不拦」**，改档后宜以测试任务一验。
- **改档须 `/reload`**：规则档、env 档、upstreams.json 皆扩展加载时读一次，改后不 reload 不生效。
- **warn 模式之慎**：`mode: "warn"` 命中不拦，唯追加警告于工具结果之末；写权 agent 之阻塞派单活已干完，警告属事后复核——观察期外宜回 `block`。
- **trainingLog**：`_global.trainingLog: true` 时测试求值亦记入 `training.jsonl`，测试毕宜跑 `scripts/prune-training.ts` 剔除测试行（详见 calibration.md）。
- **拦截文案**：首尾（「派单审核未通过…」/「请修正任务描述后重派。」）硬编码于扩展，唯各条 `message` 可配。
- **编号之约**：Q 冠 agent 专属、G 冠全局，只增不退；删问句须并删各组引用，悬空编号虽静默忽略，亦当清之。
