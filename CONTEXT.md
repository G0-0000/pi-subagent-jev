# CONTEXT.md — 术语表

- **Upstream** — name/baseUrl/apiKey/model 齐备之完整端点。
- **Failover** — 按序切换、每级一发、同端不重发。
- **Cooldown** — 连接级败北后进程内冷却跳过、重启即忘。
- **全局规则（`_all`）** — 配置档顶层保留键（同 `_global`/`_questions`，不视作 agent 名），`rules` 为问句编号数组，所列问句凡派单皆受查（含未配置专属组之 agent，述语写死 `"a sub-agent"`）；与各 agent 组之编号并集去重（全局在前），全局问句号以 G 冠之。
- **问句自含（v0.8.0）** — `_questions` 每条 = 一问＋其判法（instructions/criteria/blockWhen/threshold/message 同居）；agent 组与 `_all` 的 `rules` 唯列问句编号，无内联规则形、无同问异阈。
- **Warn 观察模式（v0.9.0）** — 模式 `"block"`（缺省，硬拦）／`"warn"`（命中不阻断，违规清单经 `tool_result` 钩追加于该次 subagent 工具结果之末：异步随启动回执、阻塞随最终输出；audit 行另加 `action:"warn"`）。`_global.mode` 为全局缺省，组级 `mode` 覆盖之（resolveMode：组＞全局＞block）。
- **传输双路（v0.10.0）** — `_global.transport`：`"selfhost"`（缺省，自管 curl 链＋upstreams.json failover）／`"builtin"`（经 pi ≥0.99 内建 classifier 平台 `ctx.modelRegistry.classify` 求值，凭据 pi 代管、本仓零 key；链路改由 `_global.builtinChain` `{provider,model}` 数组定义，缺省 typesafe/jev-latest；每级恒 `maxRetries:0`，非法值静默回 selfhost）。
- **思考深度锚（Anchor）** — preflight contract 解析得到的 agent thinking level；缺失时可用 `_global.thinkingDepth.defaultAnchor`，`off` 不参与调整。
- **档梯（Rung Ladder）** — 深度映射 minimal/low → rung 1、medium → rung 2、high/xhigh → rung 3、max → rung 4；单次仅 ±1，边界钳制不变。

## 运行监控（术语）

- **运行监控（Runtime Monitoring）** — 对运行中子 agent 之观察性检测：仅向主 agent 提醒，不打断／不停／不转向／不设新超时／不自动修复。默认关闭、显式 opt-in，与派单审核（`checkDispatch`）彼此独立。
- **检测器（Detector）** — 三类之一：bash 停滞、无效工具循环、无变化重复失败；另有兜底「无进展巡检」。任务跑偏不在其列。
- **触发线（Trigger Line）** — 求值之两种时机：事件线（循环／重复失败迹象即问，同迹象同窗口去重）与时长线（bash 启动满 3 分钟首查、合格每 10 分钟复询至其结束；派单最近未获任何检查满 10 分钟则兜底巡检）。同一 tick 多项触发合并为一次求值，同单不近距复问。
- **未知（Unknown）** — 公共信号不足以确证时之判定：不告警、不改派单。监控一切错误 fail-open（JEV 出错、信号缺失皆静默放行）。
- **监控告警（Monitor Alert）** — 注入主会话之提醒文本：`pi.sendMessage(triggerTurn)`，规则触发式，含 agent 名＋触发的检测器＋证据节录＋置信度＋「核查是否正常」建议。建议仅文字，主 agent 自决处置。

## 文档分工

- **README** — 用户亲读之文档：安装指引、完整字段语义、audit 字段、mode/transport/failover 诸节之权威所在；面向开源用户，英中双语（英在前）。schema 之唯一权威，他处不复述。
- **Skill（`skills/subagent-jev/`）** — agent 读之配置向导：用户初装插件或改配时加载，司初始化／格式说明／配置规则／注意事项四模块；正文唯作向导与指针（缩略步骤＋链 README 与 examples 模板），不预设用户之 subagent 班子（不遣特定 agent），重料下沉 `references/`。
