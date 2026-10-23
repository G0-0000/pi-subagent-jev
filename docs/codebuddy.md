# CodeBuddy Code 适配

本仓除 pi 扩展外，另含一套 CodeBuddy Code 插件适配：复用同一套规则配置、求值链路与审计格式，
唯宿主钩子面不同。本档述安装、配置复用、环境变量与已知限制。

## 安装

持久安装（校验、加入、启用；幂等可重跑）：

```
bash scripts/install-codebuddy.sh
```

脚本**缺省以项目范围（project scope）安装**——插件唯对本仓库生效。欲对所有项目生效，运行前设
`JEV_PLUGIN_SCOPE=user` 即可。因项目范围绑定当前工作目录，脚本先 `cd` 到仓库根再执行 codebuddy 命令，
故在任意目录下调用本脚本皆可。安装后本地启用态落于 `.codebuddy/`，该目录已入 `.gitignore`，
属本地状态、不入库。

脚本将仓库快照入 `~/.codebuddy/plugins/cache`——编辑仓库后须**重跑本脚本**方使快照更新，
再于 CodeBuddy 内执行 `/reload-plugins`（或重启）生效。插件附赠 `subagent-jev` skill
（`skills/codebuddy/subagent-jev/SKILL.md`），随安装一并入快照。

开发/测试期直载工作区（不入插件缓存）：

```
codebuddy --plugin-dir /path/to/pi-subagent-jev
```

插件清单为 `.codebuddy-plugin/plugin.json`，钩子配置为 `hooks/hooks.json`，入口为可执行档
`bin/jev-hook`（Node，直跑 `.ts`，零 npm 依赖）。两条钩子匹配各管一面：

- `^(Task|Agent)$` — `PreToolUse` → `bin/jev-hook pre`（30s 超时）：派单审核，block 模式命中即
  `permissionDecision: "deny"`；`PostToolUse` → `bin/jev-hook post`（15s 超时）：warn 观察模式之提示以
  `additionalContext` 追加于该次派单结果。
- `^(Bash|Write|Edit|MultiEdit)$` — `PreToolUse` → `bin/jev-hook perm`（8s 超时）：工具权限自动审批门
  （见下节）。

诸钩子皆恒 exit 0、stdout 至多一个 JSON 对象；任何错误 fail-open（放行）。

## 配置复用

规则与上游链与 pi 侧同源，缺省目录 `~/.pi/agent/jev-comp`：

- `compliance-rules.json` — 规则档（`_global` / `_questions` / `_all` / 各 agent 组，语义与 pi 侧全同）
- `auto-approve.json` — 工具权限自动审批门之配置（可选；缺档即关，见下节）
- `upstreams.json` — 多上游 failover 链（可选；缺档回单端点链路）
- `audit.jsonl` — 审计行，形状与 pi 侧同，另有 `"host": "codebuddy"` 一键
- `warn/` — warn 模式暂存（一 key 一档，TTL 3600s，容量 100 FIFO）

`JEV_CONFIG_DIR` 可覆写配置目录（测试、多实例或独立规则集用）；未设或空白时回缺省。
钩子乃独立进程、每次触发重读配置，故改档**无须** `/reload`，下次派单即生效。

## 工具权限自动审批门（perm）

治「每个写/执行类工具都要人确认一遍」之烦：于 `Bash`/`Write`/`Edit`/`MultiEdit` 之 PreToolUse 上
先作本地确定性判定，无定论者再问 JEV 之 risk（四档打分）与 approval 两问，按 `mode` 输出
`permissionDecision: allow | ask | deny`。逻辑层 `jev/permission.ts`（纯逻辑、可测），钩子面
`cb/permission-main.ts`，入口 `bin/jev-hook perm`（超时 8s）。

配置档 `<configDir>/auto-approve.json`（仓内 `examples/auto-approve.sample.json` 仅示 schema）：

| 键 | 缺省 | 义 |
| --- | --- | --- |
| `enabled` | false | 总开关；档缺/坏/缺此键即关（fail-open） |
| `mode` | observe | observe 只落审计、不改宿主行为；auto 始出决断 |
| `tools` | Bash/Write/Edit/MultiEdit | 管辖之工具名（大小写不敏感；唯钩子 matcher 所列者可管） |
| `risk.askScore` / `risk.denyScore` | 1.5 / 2.5 | risk 均值之阈值（档位 0..3） |
| `approval.askP` | 0.75 | 「须人审」概率阈值 |
| `destructiveAction` | ask | risk 达 denyScore 时之处置：ask 或 deny |

**宜先以 observe 跑一段**，看 `audit.jsonl` 中 `kind:"permission"` 行之 `decision` 合意，再改 `auto`。
改档即生效（钩子每触发重读）。

判定三层，本地优先、模型兜底：

1. **宿主 deny 规则**（`~/.codebuddy/settings.json` 与 `<cwd>/.codebuddy/settings.json` 之
   `permissions.deny`）命中即沉默（返 `{}`）。缘由：钩子之 allow **先于**宿主一切权限规则（含
   `permissions.deny`），凡用户显式拒绝者，本门绝不以 allow 覆盖。Bash 规则比之于归一后之整条
   命令与各切段（去空白、去 `VAR=value` 前缀，按 `&& || ; |` 切段）；规则形不可解析者亦视为
   命中——本门唯沉默，宿主照旧弹窗，宁过勿漏。
2. **本地确定性判定**（`jev/permission.ts`）：Bash 命令按 `&& || ; |` 与换行切段（引号内不切），
   逐段引号感知分词，取命令 basename 落名单；只读名单（ls/cat/rg/grep/fd/jq/awk/sort/
   git status|diff|log|show|rev-parse|branch（唯列示）/remote（唯列示）/npm|pnpm|yarn test|ci|
   run build|run lint/node --test/python -m pytest/cargo test|check|clippy|build/go test|build|vet/
   make/tsc 等）且诸路径参数皆在 cwd 或家目录内 → allow。**sed 不入名单**——GNU sed 之 `e` 命令、
   `s///e` 旗标执行命令，`w`/`r` 命令读写任意档；awk 之 `system(`／管道／`>` 重定向／`-f` 载入
   程序、rg 之 `--pre`、sort 之 `--compress-program`、fd 之 `-x/-X` 同属嵌套执行或写档，另判不认
   只读；`bash|sh|zsh -c` 之脚本递归再判（深限 2 层，越限或不可解析者 pass，绝不 allow）。
   危险命令（sudo/su/shutdown/reboot/mkfs*/dd of=/dev/、systemctl/crontab/管道注入 curl|sh、
   rm -r 指根或家目录或当前目录或越界或通配、chmod|chown -R 指根或家目录、越界路径、`~user`/`~+`/
   `~-` 之不可静态展开者、`$` 变量与反引号）→ ask。写类工具按 `file_path` 判：cwd 或家目录内
   → allow，越界 → ask；`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/jev-comp`、
   `~/.codebuddy/settings*.json`、`.env*`、`*.pem`、`*.key`、`id_rsa*` 纵在家目录内亦 ask。
   **绝不以命令原文之子串匹配**判险——`rg -e "rm -rf" src/` 之误报由此杜绝（此为宿主旧判定之弊）。
3. **模型兜底**：本地无定论者，以 jev-guard（MIT，leepokai）之 risk 与 approval 两问求值，问句逐字
   沿用（见 `jev/guard-questions.ts`）。risk 均值达 denyScore → `destructiveAction`；达 askScore
   或 approval 达 askP → ask；余者 allow。risk 与 approval **须俱为有限数**方出决断，任一缺失或
   求值失败 → 沉默（宿主照旧弹窗），绝不据半份证据与错误放行。

求值时每级上游 `timeoutMs` 压至 2000（三级最坏 6s < 钩子 8s），且无重试（红线②照旧）。

审计：每次判定落一行于 `<configDir>/audit.jsonl`，键为
`ts / host / kind:"permission" / tool / decision / risk / approval / latency_ms / excerpt`；
`excerpt` 截 200 字，并遮蔽 `sk-*`、12 字以上之 bearer token 与 `Authorization` 头之值（不论
长短）；求值失败之行列 `decision:"silent"` 并附 `error`。审计写入前尽力建目录（0700），写入失败
静默吞（不影响工具调用）。

**已知之限**：本地名单只识常见命令，未列者落模型（多耗一次求值，不失安全）；`user_requested` 与
`from_untrusted` 两问已备而**未接线**（须用户近期消息与不可信内容之上下文，本批尚无）。

## Skill

插件附带 `subagent-jev` 技能（`skills/codebuddy/subagent-jev/SKILL.md`）：对 CodeBuddy 言「配置 subagent 规则」或「subagent-jev」即加载，引导建 env 档、写规则档与试规则。配置与 pi 侧同源（`~/.pi/agent/jev-comp`），唯本宿主无 `jev_ask`，探针与规则试测改走脚本：

```
node ${CODEBUDDY_PLUGIN_ROOT}/scripts/try-rules.ts --probe
node ${CODEBUDDY_PLUGIN_ROOT}/scripts/try-rules.ts <agent> "<task>"
```

`--probe` 验端点、key 与模型三通（`--upstream <名>` 可直发单一上游）；agent 形逐问打印概率、阈值、向性、命中、verdict 与拦截文案，缺省干跑、不写运行时档（`--audit` 方追加一行审计）。规则改档即生效（钩子每次新起进程）；插件本体重装或升级后方须 `/reload-plugins`。

## 环境变量

与 pi 侧相同（见 `jev/client.ts` 之解析链）：

- `JEV_AI_API_KEY`、`JEV_AI_BASE_URL`（必配）、`JEV_AI_MODEL`（可选）、`JEV_AI_PROXY`（可选）
- `JEV_AI_ENV_FILE` — env 档路径（缺省 `~/.config/jev-comp/env`，600 权限）

key 绝不入仓、入日志、入错误文本；审计与警告文案皆不含 key 与完整 baseUrl。

## 行为

| 模式 | PreToolUse | PostToolUse |
| --- | --- | --- |
| `block`（缺省） | 命中即 deny，reason 同 pi 扩展之文案 | 无操作 |
| `warn` | 不拦，提示暂存于 `tool_use_id`（缺则 `call_id`） | 取回并删除，附 `additionalContext` |

空任务、非 `Task`/`Agent` 工具、无适用规则、JEV 错误、坏 stdin、缺标识 —— 皆放行。

## 已知限制

- **唯 selfhost 传输**：`_global.transport: "builtin"` 在 CodeBuddy 侧被忽略，仍走自管 curl 链。
- **无思考深度调整**：`_global.thinkingDepth` 不生效。
- **无运行监控**：监控唯 pi 主会话武装，CodeBuddy 侧无 tick。
- **无 `jev_ask` 工具**：批二或将经 MCP 补足。
- `JEV_CONFIG_DIR` 只覆写规则/上游/审计/警告目录；env 档与 `training.jsonl` 仍循 pi 缺省路径。
- `session` 子命令本批为占位（恒放行），主会话治理留待批二。
- Node ≥ 22.6（原生 TS 类型剥离）；本机 v24.19.0 实测。
- failover 冷却表为进程内状态，钩子每次新起进程，故不跨进程冷却（与 pi 侧不同）。
- warn 命中而钩子输入无 `tool_use_id`/`call_id` 时，提示静默丢弃（fail-open）。
- 权限门之 `allow` 可越过宿主 `permissions.deny`（宿主语义），故其必先自审 deny 规则、命中即沉默
  （见「工具权限自动审批门」节）；此为本门之根本约束，改动 matcher 或输出语义时不可废。
- 权限门之求值预算：每级上游 2000ms、无重试；链上三级以上者总耗时或近钩子 8s 之限，届时宿主
  fail-closed（拦下该调用）——宁可拦下，不失安全。
- **信任边界**：本门以工作区内容为可信——`npm/pnpm/yarn test|build|run`、`cargo build`、`make` 皆执行
  项目自定之脚本，故仓内被提交或新写入之恶意 `package.json`／构建档可借此执行，本门不审其内容。

## 测试

```
npm test
```

`cb/*.test.ts` 以注入 `askFn` 与临时配置目录覆盖放行、拦截、warn 落取、过期、缺键、
坏 stdin、JEV 错误与缺规则诸径；`jev/permission.test.ts` 以纯逻辑覆盖本地判定（含实测五命令与
`rg -e "rm -rf"` 之误报回归）、配置逐字段回退、阈值矩阵与 deny 规则匹配，
`cb/permission-main.test.ts` 覆盖 observe/auto、宿主 deny 优先、求值败沉默。都不发真实请求。
