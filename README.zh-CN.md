# subagent-jev

[English](README.md) | [简体中文](README.zh-CN.md)

JEV System One 子 agent 派单合规门，支持 **CodeBuddy Code**、**Claude Code** 与 **pi**。子 agent 启动前先审核任务，命中规则可拦截或警告；任何异常一律放行。

- 主仓：<https://cnb.cool/G0-0000/subagents-jev>
- 插件名：`subagent-jev`（pi 包名：`pi-subagent-jev`）

## 功能

- **派单审核**——按可配置的 JEV 问句审查每次 subagent 任务；命中即拦截并列出原因，亦可切 `warn` 模式只提醒。
- **工具权限门（可选，CodeBuddy Code 与 Claude Code）**——以本地确定性判定＋ JEV risk/approval 两问，自动放行、询问或拒绝 Bash / Write / Edit / MultiEdit。
- **内置配置 skill**——装好后让 agent 代配，无须手写规则。
- **安全默认**——规则存于仓外，凭据不入日志，任何错误 fail-open。
- **pi 专属**——`jev_ask`、思考深度调整与运行监控仍仅在 pi 包中提供。

## 安装

先克隆：

```bash
git clone https://cnb.cool/G0-0000/subagents-jev.git ~/subagents-jev
```

| 宿主 | 安装 |
|---|---|
| **CodeBuddy Code** | 官方市场上架后：`/plugin install subagent-jev@codebuddy-plugins-official`。自源码安装：`cd ~/subagents-jev && bash scripts/install-codebuddy.sh` |
| **Claude Code** | `claude --plugin-dir ~/subagents-jev` |
| **pi** | `pi install ~/subagents-jev` |

装后重载：CodeBuddy Code 用 `/reload-plugins`，Claude Code 重启，pi 用 `/reload`。

## 用 agent 配置

安装后，直接对 agent 说：

> 使用 `subagent-jev` skill 为我配置 subagent 合规规则。

skill 会：

1. 询问为哪个 subagent（或全局 `_all`）配置。
2. 检查 JEV 端点与 key 是否存在，但不读取 key 值。
3. 请你亲自填写 `~/.config/jev-comp/env`（权限 600）。
4. 写入 `~/.pi/agent/jev-comp/compliance-rules.json`（或 `JEV_CONFIG_DIR`）。
5. 先测试候选规则，再启用。

**切勿把 API key 粘贴到对话。** 按 skill 指引，直接写入 env 档。

若愿手配，最少只需：

```text
~/.config/jev-comp/env
JEV_AI_API_KEY=...
JEV_AI_BASE_URL=https://your-jev-endpoint
JEV_AI_MODEL=optional
```

无规则档即零检查，派单照常放行。

## 工具权限门（可选）

CodeBuddy Code 与 Claude Code 还可于 **Bash / Write / Edit / MultiEdit** 执行前审核。**默认关闭。**

创建 `~/.pi/agent/jev-comp/auto-approve.json`（或 `JEV_CONFIG_DIR` 下同名档）：

```json
{
  "enabled": true,
  "mode": "observe",
  "tools": ["Bash", "Write", "Edit", "MultiEdit"]
}
```

先以 `mode: "observe"` 只写 `audit.jsonl`（`kind: "permission"`）；查看判定合意后，再改 `"auto"`，方输出 `allow` / `ask` / `deny`。宿主 `permissions.deny` 与 `permissions.ask` 恒优先；任何错误皆交还宿主。

Claude Code 之 `host-prompt` 现对每个本地无定论调用皆问 JEV（其弹窗正则原为 CodeBuddy 专用）。详见 [Claude 说明](docs/claude-code.md)。

样例：[examples/auto-approve.sample.json](examples/auto-approve.sample.json)。

## 使用

- 正常派发 subagent 任务；命中规则即拦截，`warn` 模式则仅附提醒。
- CodeBuddy Code / Claude Code 之工具权限门另审 Bash / Write / Edit / MultiEdit；见上节「工具权限门」。
- pi 专属工具与进阶模式见完整参考。

## 文档

- [完整参考](docs/reference.md)——配置 schema、审计、failover、传输、监控
- [CodeBuddy 适配](docs/codebuddy.md)
- [Claude Code 适配](docs/claude-code.md)
- [设计决策](docs/adr/)
- [样例](examples/)

## 许可

MIT
