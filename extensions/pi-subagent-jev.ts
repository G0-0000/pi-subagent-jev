// pi-subagent-jev 单扩展：jev_ask / jev_models 工具 ＋ subagent 派单合规拦截。
// 工具部分：对一份 state 并行求值类型化问题（jev_ask）、列端点已连模型（jev_models）。
// 拦截部分：钩 tool_call 事件拦截他扩展注册的 subagent 工具。
//   拦截式：await 审核结果，命中违规即返 { block: true, reason }，subagent 不召唤，
//   reason 作为错误结果返给主 agent；不命中则放行。审核结果一律追加 ~/.pi/agent/jev-comp/audit.jsonl。
// 观察式（v0.9.0，可选模式）：mode "warn" 时命中不拦、派单照常进行，违规清单暂存于
//   toolCallId（WarningStore），并在该派单之 tool_result 事件上追加一段提示文本（fail-open）。
// fail-open：JEV 出错、配置档（~/.pi/agent/jev-comp/compliance-rules.json）出错、任何异常皆放行。
// 传输（v0.10.0，可选）：_global.transport === "builtin" 时求值（checkDispatch 与 jev_ask）改走
// pi 内建 classifier 平台（ctx.modelRegistry.classify，链路 _global.builtinChain 经 findOfType 解析，
// 见 jev/builtin-transport.ts）；缺省 "selfhost" 走自管 curl 链，路径逐字不变；接线异常落回自管链。
// key 由 jev/client.ts 默认链自取（进程环境 JEV_AI_API_KEY），本文件不含任何 key。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync } from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import { ask, listModels, JevError } from "../jev/client.ts";
import { checkDispatch, formatWarnNotice, loadRuleSets, resolveMode } from "../jev/compliance.ts";
import {
  createBuiltinAsk,
  type BuiltinAskFn,
  type BuiltinClassifyFn,
} from "../jev/builtin-transport.ts";
import { WarningStore } from "../jev/warning-store.ts";
import { askTrainingLine, writeTrainingLine } from "../jev/traininglog.ts";

const AUDIT_PATH = pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "audit.jsonl");
const RULES_PATH = pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "compliance-rules.json");

// warn 观察模式之违规暂存（toolCallId → 提示文本）：tool_call 落、tool_result 取，
// 有界（100 条，满则逐出最旧）；与规则配置同生命周期（/reload 重导入即重置）。
const pendingWarnings = new WarningStore();

// jev_ask 缺省探针载荷（state/questions 可全省，单给 upstream 名即可快测一上游）：
// 一则具体小修任务 ＋ 一个 noul 问句，足以观察端点连通与判定行为。
const DEFAULT_PROBE_STATE =
  "Fix the typo in README.md line 12 where 'teh' should be 'the'.";
const DEFAULT_PROBE_QUESTIONS = {
  T1: { type: "noul" as const, instructions: "Does the task name a concrete file path?" },
};

export default function (pi: ExtensionAPI) {
  // 规则配置在扩展加载时读一次（改后 /reload 生效）；trainingLog 开关即取自此处
  const config = loadRuleSets(RULES_PATH);

  // 内建传输（可选，_global.transport === "builtin" 时启用）：求值改走 pi 内建 classifier 平台
  // （ctx.modelRegistry.classify——key/baseUrl/HTTP 由 pi 运行时解析，扩展不自持凭据）。
  // 链路条目经 findOfType("classifier", provider, model) 解析（ctx 仅在钩子/工具处理器内可得，
  // 故每次调用现解析；同步查表，代价可略），未解析成模型之条目为预败尝试；
  // 接线任何异常 → undefined → 落回自管 curl 链（fail-open，绝不因接线失败拦派单）。
  const useBuiltin = config.global.transport === "builtin";

  /** 由 ctx 解析内建链路并构造 askFn；未启用或接线异常 → undefined（走既有自管链）。 */
  function buildBuiltinAsk(ctx: ExtensionContext): BuiltinAskFn | undefined {
    if (!useBuiltin) return undefined;
    try {
      // 直接透传 pi 之 classify（永不 reject，错误在 stopReason/errorMessage——与本仓 fail-open 契合）；
      // options 恒携 maxRetries: 0（红线②，classify 内部 retryProviderRequest 以 options.maxRetries ?? 2 单发）。
      const classifyFn: BuiltinClassifyFn = (model, context, options) =>
        ctx.modelRegistry.classify(
          model as Parameters<ExtensionContext["modelRegistry"]["classify"]>[0],
          context as Parameters<ExtensionContext["modelRegistry"]["classify"]>[1],
          options
        );
      const entries = config.global.builtinChain.map((e) => ({
        name: `${e.provider}/${e.model}`,
        model: ctx.modelRegistry.findOfType("classifier", e.provider, e.model) ?? null,
      }));
      return createBuiltinAsk(classifyFn, entries);
    } catch {
      return undefined;
    }
  }

  pi.registerTool({
    name: "jev_ask",
    label: "Jev Ask",
    description:
      "对一份 state 并行求值一组类型化问题（noul/choice/score），返回 {model, answers, usage, ms}。questions 形如 {key:{type:'noul',instructions:'...'}}。state/questions 皆有内建缺省探针载荷，全省时可直接快测；upstream 给 upstreams.json 中之名即单发直测该上游（bypass 链序/冷却/切换）。",
    parameters: Type.Object({
      state: Type.Optional(Type.String({ description: "待求值的材料文本（缺省用内建探针载荷）" })),
      questions: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: "问题 map，key 自取；每题为 {type:'noul'|'choice'|'score', instructions, ...}（缺省用内建探针载荷）",
      })),
      model: Type.Optional(Type.String({ description: "模型 ID，默认 oc/jev-1.13-free（transport=builtin 时忽略，链路由规则配置 _global.builtinChain 定）" })),
      upstream: Type.Optional(Type.String({ description: "upstreams.json 中之名，单发直测该上游（transport=builtin 时接受但忽略）；名不存则报错并列出可用名" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const effState = params.state ?? DEFAULT_PROBE_STATE;
        const effQuestions =
          (params.questions as Parameters<typeof ask>[0]["questions"] | undefined) ??
          DEFAULT_PROBE_QUESTIONS;
        const req = {
          state: effState,
          questions: effQuestions,
          model: params.model,
          // 取消信号（有则）随求值透传：内建链由 builtin-transport 并入 classifyFn options；
          // selfhost 链不识别此键、忽略之（请求形状不受影响）
          ...(signal ? { signal } : {}),
        };
        // transport==="builtin" → 内建 askFn（model 参数于内建链忽略，链路条目各用自身模型）；
        // 其余（含接线异常落回 undefined）走既有自管 curl 链，路径逐字不变
        const builtinAsk = buildBuiltinAsk(ctx);
        // upstream 仅自管链识别：builtin 链接受但忽略（同 model 参数之待遇）
        const result = builtinAsk
          ? await builtinAsk(req)
          : await ask(params.upstream ? { ...req, upstream: params.upstream } : req);
        // 训练数据记录（开关开时）：state ＋ 问句 ＋ 返回答案逐字留存。
        // 记录失败静默吞下，绝不影响工具结果（fail-open，红线三）。
        if (config.global.trainingLog) {
          try {
            writeTrainingLine(
              askTrainingLine({
                model: result.model,
                state: effState,
                questions: effQuestions,
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

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    const agent = input.agent;
    const task = input.task;
    if (typeof agent !== "string" || typeof task !== "string") return;
    // 无专属组之 agent 亦受查：配置档有 `_all` 全局规则时凡派单皆审（fail-open：无规则则放行）
    if (!(agent in config.agents) && !(config.all && config.all.rules.length > 0)) return;
    try {
      // 处置模式：组级显式 ＞ 全局 ＞ block（纯函数归并，加载侧已保证值合法）
      const mode = resolveMode(agent, config);
      const res = await checkDispatch(agent, task, {
        askFn: buildBuiltinAsk(ctx),
        ruleSets: config.agents,
        allRules: config.all ?? undefined,
        auditProbabilities: config.global.auditProbabilities,
        trainingLog: config.global.trainingLog,
        mode,
      });
      if (!res) return;
      appendFileSync(AUDIT_PATH, JSON.stringify(res.line) + "\n");
      if (res.violations.length > 0) {
        // warn 观察模式：不拦、派单照常；违规提示暂存于 toolCallId，待 tool_result 追加（观察事后可循）。
        if (mode === "warn") {
          pendingWarnings.stash(event.toolCallId, formatWarnNotice(agent, res.violations));
          return;
        }
        return {
          block: true,
          reason: `派单审核未通过（agent=${agent}）：\n${res.violations
            .map((m) => `- ${m}`)
            .join("\n")}\n请修正任务描述后重派。`,
        };
      }
    } catch {
      /* fail-open：任何异常放行（含暂存失败——观察模式绝不阻断派单） */
    }
  });

  // tool_result 钩（v0.9.0）：warn 观察模式之违规提示在此追加到派单结果尾部。
  // 自足 try/catch：任何异常皆返 undefined、真实结果原样不动（fail-open）。
  // 注意：被拦截的派单不产生 tool_result，故此处只会遇到 warn 放行之派单。
  pi.on("tool_result", async (event) => {
    try {
      if (event.toolName !== "subagent") return;
      const w = pendingWarnings.take(event.toolCallId);
      if (w === undefined) return;
      // content 非数组（形状未知）→ 不碰真实结果（fail-open，不猜）
      if (!Array.isArray(event.content)) return;
      return { content: [...event.content, { type: "text", text: "\n\n" + w }] };
    } catch {
      return undefined;
    }
  });
}
