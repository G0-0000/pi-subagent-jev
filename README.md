# subagent-jev

[English](README.md) | [简体中文](README.zh-CN.md)

JEV System One compliance gate for subagent dispatches on **CodeBuddy Code**, **Claude Code**, and **pi**. It checks a task before a subagent starts, blocks or warns on configured violations, and fails open on errors.

- Canonical repository: <https://cnb.cool/G0-0000/subagents-jev>
- Plugin id: `subagent-jev` (pi package: `pi-subagent-jev`)

## Features

- **Dispatch gate** — audit every subagent task against configurable JEV questions; block with reasons or keep an advisory `warn` mode.
- **CodeBuddy Code permissions (opt-in)** — auto-approve, ask, or deny Bash / Write / Edit / MultiEdit using local checks plus JEV risk/approval questions.
- **Bundled setup skill** — install and configure with your agent; no hand-written rules required.
- **Shared, safe defaults** — rules live outside the repository, credentials are never logged, and every error fails open.
- **pi extras** — `jev_ask`, thinking-depth adjustment, and runtime monitoring remain available in the pi package.

## Install

Clone once:

```bash
git clone https://cnb.cool/G0-0000/subagents-jev.git ~/subagents-jev
```

| Host | Install |
|---|---|
| **CodeBuddy Code** | After marketplace listing: `/plugin install subagent-jev@codebuddy-plugins-official`. From source: `cd ~/subagents-jev && bash scripts/install-codebuddy.sh` |
| **Claude Code** | `claude --plugin-dir ~/subagents-jev` |
| **pi** | `pi install ~/subagents-jev` |

Reload after installing: `/reload-plugins` in CodeBuddy Code, restart Claude Code, `/reload` in pi.

## Configure with your agent

After installation, ask your agent:

> Use the `subagent-jev` skill to configure compliance rules for my subagents.

The skill will:

1. Ask which subagent (or global `_all`) to configure.
2. Check whether the JEV endpoint and key exist, without reading the key value.
3. Ask you to fill `~/.config/jev-comp/env` yourself (mode 600).
4. Write `~/.pi/agent/jev-comp/compliance-rules.json` (or `JEV_CONFIG_DIR`).
5. Test candidate rules before enabling them.

**Never paste an API key into chat.** Enter it directly in the env file when the skill asks.

Manual minimum, if you prefer:

```text
~/.config/jev-comp/env
JEV_AI_API_KEY=...
JEV_AI_BASE_URL=https://your-jev-endpoint
JEV_AI_MODEL=optional
```

No rules file means no checks; the gate fails open.

## Use

- Dispatch a normal subagent task; configured violations are blocked, or warned in `warn` mode.
- CodeBuddy permission automation stays off until enabled in `auto-approve.json` under the config dir (`~/.pi/agent/jev-comp`, or `JEV_CONFIG_DIR`). With the default `jevWhen: "host-prompt"`, JEV is consulted only for calls the host would actually prompt for; everything else is left to the host.
- For pi-only tools and advanced modes, see the full reference.

## Documentation

- [Full reference](docs/reference.md) — configuration schema, audit, failover, transports, monitoring
- [CodeBuddy adapter](docs/codebuddy.md)
- [Claude Code adapter](docs/claude-code.md)
- [Design decisions](docs/adr/)
- [Examples](examples/)

## License

MIT
