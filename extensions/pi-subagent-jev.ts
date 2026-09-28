// pi-subagent-jev 单扩展：jev_ask / jev_models 工具 ＋ subagent 派单合规拦截。
// 工具部分：对一份 state 并行求值类型化问题（jev_ask）、列端点已连模型（jev_models）。
// 拦截部分：钩 tool_call 事件拦截他扩展注册的 subagent 工具。
//   拦截式：await 审核结果，命中违规即返 { block: true, reason }，subagent 不召唤，
//   reason 作为错误结果返给主 agent；不命中则放行。审核结果一律追加 ~/.pi/agent/jev-comp/audit.jsonl。
// fail-open：JEV 出错、配置档（~/.pi/agent/jev-comp/compliance-rules.json）出错、任何异常皆放行。
// key 由 jev/client.ts 默认链自取（进程环境 JEV_AI_API_KEY），本文件不含任何 key。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync } from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import { ask, listModels, JevError } from "../jev/client.ts";
import { checkDispatch, loadRuleSets } from "../jev/compliance.ts";
import { askTrainingLine, writeTrainingLine } from "../jev/traininglog.ts";

const AUDIT_PATH = pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "audit.jsonl");
const RULES_PATH = pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "compliance-rules.json");

export default function (pi: ExtensionAPI) {
  // 规则配置在扩展加载时读一次（改后 /reload 生效）；trainingLog 开关即取自此处
  const config = loadRuleSets(RULES_PATH);

  pi.registerTool({
    name: "jev_ask",
    label: "Jev Ask",
    description:
      "对一份 state 并行求值一组类型化问题（noul/choice/score），返回 {model, answers, usage}。questions 形如 {key:{type:'noul',instructions:'...'}}。",
    parameters: Type.Object({
      state: Type.String({ description: "待求值的材料文本" }),
      questions: Type.Record(Type.String(), Type.Unknown(), {
        description: "问题 map，key 自取；每题为 {type:'noul'|'choice'|'score', instructions, ...}",
      }),
      model: Type.Optional(Type.String({ description: "模型 ID，默认 oc/jev-1.13-free" })),
    }),
    async execute(_id, params) {
      try {
        const result = await ask({
          state: params.state,
          questions: params.questions as Parameters<typeof ask>[0]["questions"],
          model: params.model,
        });
        // 训练数据记录（开关开时）：state ＋ 问句 ＋ 返回答案逐字留存。
        // 记录失败静默吞下，绝不影响工具结果（fail-open，红线三）。
        if (config.global.trainingLog) {
          try {
            writeTrainingLine(
              askTrainingLine({
                model: result.model,
                state: params.state,
                questions: params.questions,
                answers: result.answers,
              })
            );
          } catch {
            /* 记录失败绝不阻断求值 */
          }
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: {},
        };
      } catch (err) {
        if (err instanceof JevError) {
          const extra = [
            err.bodySummary ? `body: ${err.bodySummary}` : null,
            err.retryAfterMs !== undefined ? `retryAfterMs: ${err.retryAfterMs}` : null,
          ]
            .filter(Boolean)
            .join("；");
          return {
            content: [{ type: "text", text: `JevError ${err.kind}: ${err.message}${extra ? `（${extra}）` : ""}` }],
            details: {},
          };
        }
        return {
          content: [{ type: "text", text: `JevError unexpected: ${String(err)}` }],
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "jev_models",
    label: "Jev Models",
    description: "列出 JEV 端点已连接的模型。",
    parameters: Type.Object({}),
    async execute() {
      try {
        const result = await listModels();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: {},
        };
      } catch (err) {
        if (err instanceof JevError) {
          const extra = err.bodySummary ? `（body: ${err.bodySummary}）` : "";
          return {
            content: [{ type: "text", text: `JevError ${err.kind}: ${err.message}${extra}` }],
            details: {},
          };
        }
        return {
          content: [{ type: "text", text: `JevError unexpected: ${String(err)}` }],
          details: {},
        };
      }
    },
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    const agent = input.agent;
    const task = input.task;
    if (typeof agent !== "string" || typeof task !== "string") return;
    if (!(agent in config.agents)) return;
    try {
      const res = await checkDispatch(agent, task, {
        ruleSets: config.agents,
        auditProbabilities: config.global.auditProbabilities,
        trainingLog: config.global.trainingLog,
      });
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
