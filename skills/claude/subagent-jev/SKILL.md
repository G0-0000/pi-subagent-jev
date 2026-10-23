---
name: subagent-jev
description: 为 Claude Code 之 subagent 配制 JEV 派单合规规则之用。当用户要为某个 subagent（worker/scout 等）新增或调整 JEV 合规规则、录入 JEV 模型/端点设置，或言「配置 subagent 规则」「subagent-jev」时加载。
---

# subagent-jev — JEV 合规规则配置向导（Claude Code）

本 skill 于用户初装 Claude Code 插件或后续改配时加载，司四事：初始化、释配置档格式、定规则、示注意事项。红线三条贯穿全程：apiKey 之值不入任何档/日志/错误文本；POST 不自动重试；任何错误 fail-open。完整文档以 README 与 `docs/claude-code.md` 为权威，本档唯作向导，不复述全文。**须知**：本宿主适配复用 CodeBuddy Code 之适配层，尚缺真实 Claude Code CLI 之端到端验证——首次实机使用宜真派一单，察钩子是否如期触发。

## 一、初始化

起手势：查 `~/.pi/agent/jev-comp/compliance-rules.json`（`JEV_CONFIG_DIR` 另指者从其径）之有无。**有** → 已初始化，径问用户「为哪个 subagent 配规则？」入第三模块。**无** → 依次行下四步：

1. **装插件**——`claude --plugin-dir ~/pi-subagent-jev`；插件之装卸/更新经 `/plugin` 管理，或重启 Claude Code。派单拦截钩 `Agent` 工具（PreToolUse 审核、PostToolUse 交付 warn 提示）；`Agent` 为正名（v2.1.63 起），`Task` 存为别名，钩子二者皆认。
2. **配模型**——唯 selfhost 自管端点（本宿主无 builtin 传输）：建 env 档 `~/.config/jev-comp/env`（权限 600），三键 `JEV_AI_API_KEY`（**嘱用户亲笔自填**，agent 全程不经手其值）／`JEV_AI_BASE_URL`（必配）／`JEV_AI_MODEL`（可选）。详见 README「Install」与「Transport」节。
3. **试连通**——`node ${CLAUDE_PLUGIN_ROOT}/scripts/try-rules.ts --probe`（插件根变量未注入者，以插件目录实路径代之）：探针每上游至多一发（有 failover 链者按链逐级，配 `--upstream <名>` 则只直发该上游一发，绕链序与冷却），验端点、key、模型三者俱通，并报耗时。报错先排查配置，勿续。
4. **生效**——规则档改毕即生效，无须重载（钩子为独立进程、每次派单重读配置）；唯插件本体重装/升级后须 `/plugin` 重载或重启 Claude Code。

（可选：多上游 failover 档 `~/.pi/agent/jev-comp/upstreams.json` 聚多枚 key，宜用户手书，本 skill 不代写。样例见 `examples/upstreams.sample.json`。）

## 二、配置文件格式说明

规则档与 pi 侧单一来源：`~/.pi/agent/jev-comp/compliance-rules.json`——代码零内建规则，档缺/坏即零检查全放行。`JEV_CONFIG_DIR` 可覆写此目录（规则、上游链、审计、warn 暂存随之），唯 env 档与 `training.jsonl` 仍循 pi 缺省路径。骨架速查：

- 顶层三保留键——`_global`（全局开关）、`_questions`（问句库）、`_all`（全局引用组），皆不视作 agent 名
- `_questions`：一问一条、自含判法 `{label?, instructions, criteria?, blockWhen, threshold, message}`；`label` 仅供人读
- 各 agent 组（顶层键＝agent 名）：`{agentDesc, mode?, rules}`，`rules` 为问句编号字符串数组
- `_all`：形同组而无 `agentDesc`，所列编号凡派单皆查（含无专属组之 agent），与组引并集去重、全局在前
- 向性：`below`＝概率低于阈则拦（正例，求达标有据）；`above`＝概率高于阈则拦（反例，求犯忌有凭）
- 本宿主忽略 `_global.transport`（恒 selfhost）与 `_global.thinkingDepth`；亦无 `monitor.json` 运行监控

**配置模板**：`examples/compliance-rules.sample.json`（仅示 schema，非部署之源）。完整字段语义、audit 字段、mode/failover 诸节悉见 README 对应章节——彼为权威，本档不复述。

## 三、配置规则

1. **问用户**：为哪个 subagent 配规则，抑配全局 `_all`（凡派单皆查，含无专属组之 agent——此点须向用户言明）。
2. **读 prompt**：取该 agent 之定义档——用户级 `~/.claude/agents/<agent>.md`、项目级 `.claude/agents/<agent>.md`、插件 `agents/<agent>.md`，孰在生效即取孰（同名并存者依宿主优先级）。无档之内建 agent，则据 Claude Code 文档之 agent 说明拟 `agentDesc`。析其职能、工具白名单（有无 bash）、行为契约、禁忌，录为组之 `agentDesc`——务使描述与定义符实。
3. **定规则**，立则三纲：
   - **能复用则复用**——语义与判法皆同者引同一编号，改则一处生效；同问须异判法（异阈/异文案）即非同问，当分立两条
   - **能拆则拆**——一条规则唯问一事（标的、改动、决策、措辞各为一问），勿揉「任务合规与否」之大问
   - **问句从简，criteria 详述**——`instructions` 唯朴素一问；答支边界、豁免清单、误判场景皆挪 `criteria` 双支详陈（`false` 支列举常见误判场景最见效）
   正例（可执行性要素：对象/方案/内容）→ `blockWhen: "below"`，默认阈 0.7；反例（越权/破坏/误导措辞）→ `blockWhen: "above"`，默认阈 0.8。`instructions` 用英文问句，`message` 用中文短语。编号约定：agent 专属问以 `Q` 冠（只增不退），全局问以 `G` 冠。
   **先呈中文对照表（id/向性/问句中译/阈值/拦截文案）候用户首肯**，再动下一步。
4. **测规则**——以探针脚本直测，不必真派单：

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/try-rules.ts <agent> "<假想任务>"
   ```

   缺省干跑，不写 audit.jsonl／training.jsonl（`--audit` 方追加一行审计）；输出逐问之概率、阈值、向性、是否命中、末裁（verdict）与拦截文案，命中之处与真派单所报理由一致。测 ≥6 个假想任务：1 个合规好任务＋每反例至少 1 个坏任务＋贴线案例（「看似犯忌实则合法」如已批准之破坏操作；「隐蔽违规」如「你自己掂量」式决策下放）。应中者 >0.8、应放行者 <0.2；自行调优至多 3 轮，逾则列分数与残差请用户裁。须知 criteria 须补问句未载之边界，纯复述问句者无效。
   （真派一单亦可验：block 命中即拒，reason 逐条列出违规；唯真派单徒耗子 agent 之实际动作，试测仍以脚本为便。）
5. **写配置**：改前先读档，核对既有各组不被破坏；同义且同判之问引同一编号，勿另起一条；写毕告用户即时生效，无须重载。

## 四、注意事项

- **key 安全**：apiKey 之值绝不入任何档/日志/错误文本；env 档与 upstreams.json 皆须 600 权限；`JEV_AI_API_KEY` 由用户亲笔自填，agent 全程不经手其值（查配置唯查键名之有无，**绝不读值**）。
- **fail-open**：端点不可达、key 缺失、规则档损坏，派单一律放行；非法问句条目、非字符串/悬空/重复编号、非法 mode 值皆静默忽略——**配置笔误不报错，唯表现为「不拦」**，改档后宜以测试任务一验。然钩子未加载（适配未验之隐忧）亦同此相：不拦在先，当先核插件与钩子，勿遽疑规则。
- **生效时机**：改档即生效（钩子每次新起进程、重读配置）；唯插件更新须重载——`/plugin` 或重启 Claude Code。
- **warn 模式之慎**：`mode: "warn"` 命中不拦，唯以 `additionalContext` 附于该次派单结果；写权 agent 之活干完方见警告，属事后复核——观察期外宜回 `block`。
- **trainingLog**：`_global.trainingLog: true` 时真派单之求值另记入 `~/.pi/agent/jev-comp/training.jsonl`（`JEV_CONFIG_DIR` 不覆写此径）；试跑器干跑、不写训练行，测规则无污染之虞。真派单所留样本可循 `scripts/prune-training.ts` 剔除（缺省 dry-run，`--write` 方落档并自动备份）。
- **审计**：每次求值落一行于 `~/.pi/agent/jev-comp/audit.jsonl`，宿主判别凭插件根环境变量，Claude Code 记 `"host": "claude-code"`；规则命中时含 `blocked` 数组（warn 行另附 `action: "warn"`）。
- **拦截文案**：首尾（「派单审核未通过（agent=…）：」／「请修正任务描述后重派。」）硬编码于适配层，唯各条 `message` 可配。
- **编号之约**：Q 冠 agent 专属、G 冠全局，只增不退；删问句须并删各组引用，悬空编号虽静默忽略，亦当清之。
- **本宿主不及 pi 者**：无 `jev_ask`、无 builtin 传输、无思考深度调整、无运行监控——用户询及，答以 pi 侧方有。
