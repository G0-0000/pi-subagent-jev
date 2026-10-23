#!/usr/bin/env bash
# CodeBuddy Code 插件持久安装脚本（幂等；改码后重跑以更新插件缓存快照）
# 默认项目范围安装（JEV_PLUGIN_SCOPE=user 可改用户范围）；项目范围须在仓库根执行。
set -euo pipefail

SCOPE="${JEV_PLUGIN_SCOPE:-project}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# CodeBuddy CLI 多会话并发时稳定端口池易撞 EADDRINUSE，随机取一端口规避
# 会话内 SERVER__PORT 常被宿主占用，故不复用；如需指定端口用 JEV_INSTALL_PORT
export SERVER__PORT="${JEV_INSTALL_PORT:-$(( (RANDOM % 2000) + 52000 ))}"

if ! command -v codebuddy >/dev/null 2>&1; then
  echo "错误：未找到 codebuddy 命令，请先安装 CodeBuddy Code CLI 并确保其在 PATH 中。" >&2
  exit 1
fi

# 项目范围绑定 cwd，故先切到仓库根再执行 codebuddy 命令
cd "$ROOT"

echo "==> 校验插件清单：$ROOT"
codebuddy plugin validate "$ROOT"

echo "==> 安装/更新插件（幂等，作用域 $SCOPE）：$ROOT"
codebuddy plugin add "$ROOT" --scope "$SCOPE" --yes

PLUGIN_ID="$(codebuddy plugin list | awk '/subagent-jev@/{print $2; exit}')"
if [ -z "$PLUGIN_ID" ]; then
  echo "错误：未能从 codebuddy plugin list 解析出插件 id（subagent-jev@…）。" >&2
  exit 1
fi
echo "==> 插件 id：$PLUGIN_ID"

echo "==> 启用插件（作用域 $SCOPE）"
codebuddy plugin enable "$PLUGIN_ID" --scope "$SCOPE"

SKILL_PATH="$(find "$HOME/.codebuddy/plugins/cache" -path '*/subagent-jev/*/skills/codebuddy/subagent-jev/SKILL.md' -print -quit)"
if [ -z "$SKILL_PATH" ]; then
  echo "错误：安装快照中未找到 subagent-jev skill（skills/codebuddy/subagent-jev/SKILL.md）。" >&2
  exit 1
fi

echo "==> 安装完成"
echo "插件 id：$PLUGIN_ID"
echo "skill 路径：$SKILL_PATH"
echo "作用域：$SCOPE"
echo "请在 CodeBuddy 内执行 /reload-plugins（或重启）使其生效。"
