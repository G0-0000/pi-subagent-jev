// 派发合规拦截薄壳：钩 tool_call 事件拦截他扩展注册的 subagent 工具。
// 拦截式：await 审核结果，命中违规即返 { block: true, reason }，subagent 不召唤，
// reason 作为错误结果返给主 agent；不命中则放行。审核结果一律追加 ~/.pi/agent/jev/audit.jsonl。
// fail-open：JEV 出错、配置档（~/.pi/agent/jev/compliance-rules.json）出错、任何异常皆放行。
// key 由 jev/client.ts 默认链自取（进程环境 JEV_AI_API_KEY），本文件不含任何 key。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import { checkDispatch, loadRuleSets } from "../jev/compliance.ts";

const AUDIT_PATH = pathMod.join(os.homedir(), ".pi", "agent", "jev", "audit.jsonl");
const RULES_PATH = pathMod.join(os.homedir(), ".pi", "agent", "jev", "compliance-rules.json");

export default function (pi: ExtensionAPI) {
  const ruleSets = loadRuleSets(RULES_PATH);
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    const agent = input.agent;
    const task = input.task;
    if (typeof agent !== "string" || typeof task !== "string") return;
    if (!(agent in ruleSets)) return;
    try {
      const res = await checkDispatch(agent, task, { ruleSets });
      if (!res) return;
      appendFileSync(AUDIT_PATH, JSON.stringify(res.line) + "\n");
      if (res.violations.length > 0) {
        return {
          block: true,
          reason: `派单审核未通过（agent=${agent}）：\n${res.violations
            .map((m) => `- ${m}`)
            .join("\n")}\n请修正任务描述后重派。`,
        };
      }
    } catch {
      /* fail-open：任何异常放行 */
    }
  });
}
