// JEV System One 决策工具薄壳：jev_ask / jev_models
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, listModels, JevError } from "../jev/client.ts";

export default function (pi: ExtensionAPI) {
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
      model: Type.Optional(Type.String({ description: "模型 ID，默认 jev-latest" })),
    }),
    async execute(_id, params) {
      try {
        const result = await ask({
          state: params.state,
          questions: params.questions as Parameters<typeof ask>[0]["questions"],
          model: params.model,
        });
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
}
