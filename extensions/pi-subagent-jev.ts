// pi-subagent-jev 单扩展：jev_ask 工具 ＋ subagent 派单合规拦截。
// 工具部分：对一份 state 并行求值类型化问题（jev_ask）。
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
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ask, JevError } from "../jev/client.ts";
import { checkDispatch, formatWarnNotice, loadRuleSets, resolveMode } from "../jev/compliance.ts";
import {
  createBuiltinAsk,
  type BuiltinAskFn,
  type BuiltinClassifyFn,
} from "../jev/builtin-transport.ts";
import { WarningStore } from "../jev/warning-store.ts";
import { askTrainingLine, monitorTrainingLine, writeTrainingLine } from "../jev/traininglog.ts";
import {
  buildMonitorState,
  detectLoop,
  detectRepeatFailures,
  dueChecks,
  excerpt,
  formatAlert,
  loadMonitorConfig,
  monitorTrainingQuestions,
  monitorVerdict,
  parseControlEvent,
  parseTranscriptEvidence,
  MONITOR_QUESTIONS,
  MONITOR_QUESTION_PAYLOAD,
  MONITOR_RULE_BY_SIGNAL,
  parseFleetTranscript,
  type MonitorConfig,
} from "../jev/monitor.ts";
import { MonitorStore } from "../jev/monitor-store.ts";
import { CooldownTracker, loadFailoverConfig } from "../jev/failover.ts";
import { applyDepthAdjustment, isThinkingLevel, joinThinkingSuffix, levelToRung, type ThinkingLevel } from "../jev/depth.ts";

const AUDIT_PATH = pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "audit.jsonl");
const RULES_PATH = pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "compliance-rules.json");
const MONITOR_PATH = pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "monitor.json");

interface PreflightModule {
  resolveSubagentLaunchContract(input: Record<string, unknown>): Promise<unknown>;
}

async function importPreflight(): Promise<PreflightModule> {
  try {
    return await import("pi-subagents/preflight") as PreflightModule;
  } catch {
    const hostRequire = createRequire(pathMod.join(os.homedir(), ".pi", "agent", "npm", "noop.js"));
    const resolved = hostRequire.resolve("pi-subagents/preflight");
    return await import(pathToFileURL(resolved).href) as PreflightModule;
  }
}

// 运行监控（advisory，opt-in）：时长线轮询之 tick 间隔（恒小于配置诸阈值，30s 一拍）。
const MONITOR_TICK_MS = 30_000;
// RPC status/transcript 之等待上限：超时即证据不足（fail-open，不告警）。
const MONITOR_RPC_TIMEOUT_MS = 10_000;
// 运行监控事件线去重窗口：同信号同窗口（bashRecheckMs 粒度之窗口、两倍窗宽内不重触发）。
const MONITOR_DEDUPE_WINDOW_MS = 1_200_000;

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

/**
 * 主/子判别双原语（与 orchestrator-main 同一判别，此处小量复制、互不依赖）：
 * ① PI_SUBAGENT_CHILD === "1" —— 仅异步 subagent-runner 子进程模块顶层设置，主进程永不置 1；
 * ② 子会话档径 —— 前台/后台 fresh 子会话档恒为 <...>/<runId>/run-<N>/session.jsonl，
 * fork 子会话档恒为 <...>/<父档基名>/forks/<名>.jsonl；主会话档为扁平 <...>.jsonl，两形皆不中。
 * 误中方向 fail-safe 向「不武装监控」——绝不影响派单门与 jev_ask。
 */
function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

function isChildSessionFile(sessionFile: string | null | undefined): boolean {
  if (!sessionFile) return false;
  return /[\\/][^/\\]+[\\/]run-\d+[\\/]session\.jsonl$/.test(sessionFile)
      || /[\\/]forks[\\/][^/\\]+\.jsonl$/.test(sessionFile);
}

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

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    const agent = input.agent;
    const task = input.task;
    if (typeof agent !== "string" || typeof task !== "string") return;
    const hasComplianceRules = !!(config.agents[agent]?.rules.length || config.all?.rules.length);
    const depthConfig = config.global.thinkingDepth;
    let depthAnchor: ThinkingLevel | undefined;
    let contractModel: string | undefined;
    // 显式 model 参数优先，当前版本不调整；预检失败仅跳过深度功能，合规审核照常。
    if (depthConfig.enabled && input.model === undefined) {
      try {
        const preflight = await importPreflight();
        const preflightInput: Record<string, unknown> = { agent, task, cwd: ctx.cwd };
        try {
          const availableModels = ctx.modelRegistry.getAvailable();
          if (availableModels) preflightInput.availableModels = availableModels;
        } catch {
          /* host model registry 不可用时按要求省略 */
        }
        const result = await preflight.resolveSubagentLaunchContract(preflightInput) as {
          ok?: boolean;
          contract?: { model?: unknown; thinking?: unknown };
        };
        const contractThinking = result?.contract?.thinking;
        const level = contractThinking == null
          ? depthConfig.defaultAnchor
          : isThinkingLevel(contractThinking)
            ? contractThinking
            : undefined;
        if (level && level !== "off" && levelToRung(level) !== null && result?.ok) {
          depthAnchor = level;
          if (typeof result.contract?.model === "string") contractModel = result.contract.model;
        }
      } catch {
        /* fail-open：预检不可用时只跳过深度调整 */
      }
    }
    if (!hasComplianceRules && !depthAnchor) return;
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
        ...(depthAnchor ? { depthAnchor, depthThreshold: depthConfig.threshold } : {}),
      });
      if (!res) return;
      let adjustedModel: string | undefined;
      if (res.violations.length === 0 && res.depthAdjust && res.depthAdjust !== 0 && depthAnchor && contractModel) {
        try {
          const level = applyDepthAdjustment(depthAnchor, res.depthAdjust);
          if (level !== depthAnchor) {
            adjustedModel = joinThinkingSuffix(contractModel, level);
            if (res.line.depth) res.line.depth.applied = true;
          }
        } catch {
          /* fail-open：模型改写失败不影响派单 */
        }
      }
      appendFileSync(AUDIT_PATH, JSON.stringify(res.line) + "\n");
      if (adjustedModel) input.model = adjustedModel;
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

  // ── 运行监控（advisory runtime monitoring，opt-in，默认关）──
  // 仅观察运行中子 agent（bash 停滞/无效循环/重复失败/无推进兜底），命中仅注入提醒文本
  // （pi.sendMessage triggerTurn），不打断/不停/不转向；绝不在派单路径上。
  // 信号唯公开接口：pi.events 之 subagent:control-event ＋ RPC status/view=transcript 文本。
  // 一切错误 fail-open（JEV 出错、信号缺失、RPC 不可用 → 不告警、绝不外抛）。
  const monitorCfg = loadMonitorConfig(MONITOR_PATH);
  // 监控仅主会话武装：异步子进程（PI_SUBAGENT_CHILD=1）于加载时即拒；
  // 同进程之前台/fork 子会话经 setupMonitor 内之 session_start 档径判别。
  if (monitorCfg && monitorCfg.enabled && !isSubagentChild()) setupMonitor(pi, monitorCfg);

  function setupMonitor(pi: ExtensionAPI, mcfg: MonitorConfig): void {
    const store = new MonitorStore();
    // 传输复用 ask() 自管 curl 链（每级一发、同端不重发、全链败尽 fail-open，红线②）
    const failover = loadFailoverConfig();
    const tracker = failover ? new CooldownTracker(undefined, failover.cooldownMs) : undefined;
    const events = pi.events;
    const unsubs: Array<() => void> = [];
    let armed = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    // ── 武装闸：监控仅主会话 ──
    // 异步子进程经 isSubagentChild 于加载时即拒（见 setupMonitor 调用处）；同进程之前台/fork
    // 子会话须经 session_start 之 ctx.sessionManager.getSessionFile() 档径判别（双原语之二）。
    // 判别不出/异常 → 不武装：误中方向 fail-safe 向「不武装」——宁漏不误，绝不影响子会话之
    // 派单门与 jev_ask（此扩展于子进程加载乃为派单门，监控只是主会话之附加）。
    pi.on("session_start", (_event, ctx) => {
      try {
        if (isChildSessionFile(ctx.sessionManager.getSessionFile())) disarmMonitor();
        else armMonitor();
      } catch {
        /* fail-open：判别异常 → 不武装 */
      }
    });

    /** 武装（幂等）：订控制/终态事件、起轮询器、注册关停清理。 */
    function armMonitor(): void {
      if (armed) return;
      armed = true;

    // 控制事件线：needs_attention/tool_open_threshold（currentTool=bash → 停滞计时）、
    // tool_failures（重复失败迹象，去重后触发求值）与工具边界（currentTool 变化 → bash 计时开合）。
    // 载荷形状（pi-subagents 0.76）：{ event: <ControlEvent>, source, ... }——事件本体嵌于 event 键，
    // 由 parseControlEvent 解包（兼容裸事件直发形）。
    unsubs.push(
      events.on("subagent:control-event", (raw) => {
        try {
          onControlEvent(raw);
        } catch {
          /* fail-open：控制事件任何解析错误静默 */
        }
      })
    );

    // 终态事件：run 完结（前台/后台/进程终了）即剪枝，免死 run 滞留。
    // 三事件之 runId 皆在载荷顶层（pi-subagents shared/types.js 之事件常量）。
    for (const channel of [
      "subagent:async-complete",
      "subagent:process-terminal",
      "subagent:foreground-complete",
    ]) {
      unsubs.push(
        events.on(channel, (raw) => {
          try {
            const runId = (raw as { runId?: unknown } | null)?.runId;
            if (typeof runId === "string" && runId !== "") store.drop(runId);
          } catch {
            /* fail-open */
          }
        })
      );
    }

    function onControlEvent(raw: unknown): void {
      const info = parseControlEvent(raw);
      if (!info) return;
      const { runId, agent, task, ts: now, currentTool, toolCallId, reason } = info;
      store.noteActivity(runId, agent, task, currentTool, toolCallId, now);
      // bash 停滞时长线：控制事件携 currentToolDurationMs 时回推计时起点
      if (currentTool === "bash") {
        const dur = Math.max(0, info.currentToolDurationMs ?? 0);
        store.noteBashStart(runId, toolCallId ?? `bash:${now}`, now - dur);
      }
      // 事件线：重复失败迹象——同信号同窗口去重后触发一次求值
      if (reason === "tool_failures") {
        const window = Math.floor(now / mcfg.bashRecheckMs);
        if (store.claim(runId, `repeat_failure:${window}`, now, MONITOR_DEDUPE_WINDOW_MS)) {
          void evaluate(runId, "repeat_failure").catch(() => {});
        }
      }
    }

    // 时长线：真实时钟驱动 dueChecks（bash 首查/复询 + 兜底巡检），
    // 同一 tick 每 run 之多触发合并为一次求值。
    timer = setInterval(() => {
      void tick().catch(() => {});
    }, MONITOR_TICK_MS);
    timer.unref?.();

    // 会话关停：清轮询器、退订全部事件监听——/reload 重导入不留陈旧 poller。
    pi.on("session_shutdown", () => {
      try {
        if (timer) clearInterval(timer);
        timer = null;
        for (const off of unsubs) off();
      } catch {
        /* fail-open */
      }
    });
    } // armMonitor 结束

    /** 解除武装（幂等）：清轮询器、退订全部事件监听（fork/前台子会话判别命中时）。 */
    function disarmMonitor(): void {
      if (!armed) return;
      armed = false;
      try {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        for (const off of unsubs) off();
        unsubs.length = 0;
      } catch {
        /* fail-open */
      }
    }

    let tickInFlight = false;
    async function tick(): Promise<void> {
      if (tickInFlight) return; // 上轮未竟则跳过本轮：tick 不自叠
      tickInFlight = true;
      try {
        const now = Date.now();
        const entries = [...store.entries()];
        for (const [runId, st] of entries) {
          const due = dueChecks(st, now, mcfg);
          let toolCallId: string | undefined;
          if (due.length > 0) {
            toolCallId = due[0].toolCallId; // bash 首查/复询携带 toolCallId；同 tick 合并一次求值
          } else {
            // 事件线（缓冲候选）：代码侧检测器见循环/重复失败迹象 → 同信号同窗口去重后触发求值；
            // 判定仍归 JEV（四问全量），检测器只决定去不去问。
            const sig = detectLoop(st.recentCalls)
              ? "loop"
              : detectRepeatFailures(st.recentCalls)
                ? "repeat_failure"
                : null;
            if (sig === null) continue;
            const window = Math.floor(now / mcfg.bashRecheckMs);
            if (!store.claim(runId, `${sig}:${window}`, now, MONITOR_DEDUPE_WINDOW_MS)) continue;
          }
          await evaluate(runId, due.length > 0 ? "timeline" : "candidate", toolCallId).catch(() => {});
        }
      } finally {
        tickInFlight = false;
      }
    }

    /** RPC status/view=transcript 取最近工具证据（公开接口；后台子 agent 为弱文本尾——ADR 之限）。 */
    function fetchTranscript(runId: string): Promise<string | null> {
      return new Promise((resolve) => {
        let settled = false;
        const done = (v: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(rpcTimer);
          off();
          resolve(v);
        };
        const requestId = `jev-mon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const off = events.on(`subagents:rpc:v1:reply:${requestId}`, (raw) => {
          try {
            const r = (raw ?? {}) as { success?: boolean; data?: unknown };
            if (r.success !== true) return done(null);
            const d = r.data as { text?: unknown } | string | null;
            if (typeof d === "string") return done(d);
            if (d && typeof d === "object" && typeof (d as { text?: unknown }).text === "string") {
              return done((d as { text: string }).text);
            }
            done(null); // 形状不可用 → 证据不足（fail-open）
          } catch {
            done(null);
          }
        });
        const rpcTimer = setTimeout(() => done(null), MONITOR_RPC_TIMEOUT_MS);
        try {
          events.emit("subagents:rpc:v1:request", {
            version: 1,
            requestId,
            method: "status",
            params: { runId, view: "transcript", lines: 80 },
            source: { extension: "pi-subagent-jev" },
          });
        } catch {
          done(null);
        }
      });
    }

    /**
     * 求值：buildMonitorState → ask()（四问 M001-M004 一批）→ monitorVerdict →
     * alert 则逐信号 pi.sendMessage(formatAlert, triggerTurn)；trainingLog 开时另落监控训练行。
     * 证据不足（transcript 无任何工具节、RPC 不可用）→ unknown → 不告警。
     * 全程 try/catch fail-open，绝不外抛、绝不阻断派单。
     */
    async function evaluate(
      runId: string,
      trigger: string,
      toolCallId?: string
    ): Promise<void> {
      try {
        const now0 = Date.now();
        store.markChecked(runId, now0); // 成败皆记：证据不可用时不在每 tick 复问
        // 成败皆记（二）：bash 检查于求值入口即记 checkedAt——证据有无皆然；
        // 免无证据（RPC 不可用/transcript 未出）时 bash 首查每 tick 重触发（churn 之防）。
        store.markBashChecked(runId, toolCallId, now0);
        const st = store.state(runId, "unknown", "", now0);
        const text = await fetchTranscript(runId);
        if (text === null) return; // 证据不足 → unknown → 不告警
        // 前台 fleet 形优先，零节回落异步输出日志形（`<tool>: <content>` 行）；
        // 两者俱空方为证据不足。异步形命中时 `Task: ` 行任务原文可补填 store.task。
        const evidence = parseTranscriptEvidence(text);
        const calls = evidence.calls;
        if (calls.length === 0) {
          // 证据枯竭且 run 久无活动、无运行中 bash → 剪枝，免死 run 被反复巡检
          if (st.bashCalls.length === 0 && now0 - st.lastActivityAt > mcfg.sweepIntervalMs) {
            store.drop(runId);
          }
          return;
        }
        if (evidence.task !== null) {
          const stNow = store.state(runId, "unknown", "", now0);
          if (stNow.task === "") stNow.task = evidence.task;
        }
        for (const c of calls) store.addCall(runId, c);
        const all = store.state(runId, "unknown", "", now0).recentCalls;
        const agent = st.agent === "unknown" ? runId : st.agent;
        const state = buildMonitorState(agent, st.task, all, mcfg);
        const res = await ask({
          state,
          questions: MONITOR_QUESTION_PAYLOAD as Parameters<typeof ask>[0]["questions"],
          failover: failover ?? null,
          tracker,
        });
        const answers = (res.answers ?? {}) as Record<string, { noul?: unknown }>;
        const probs: Record<string, number> = {};
        for (const q of MONITOR_QUESTIONS) {
          const v = answers[q.id]?.noul;
          if (typeof v === "number" && Number.isFinite(v)) probs[q.id] = v;
        }
        const mv = monitorVerdict(MONITOR_QUESTIONS, probs);
        // 训练数据记录（开关开时）：state ＋ 问句 ＋ 原始概率 ＋ 判定；失败静默吞下。
        if (config.global.trainingLog) {
          try {
            writeTrainingLine(
              monitorTrainingLine({
                agent,
                signal: trigger,
                state,
                questions: monitorTrainingQuestions(),
                probs,
                verdict: mv.verdict,
              })
            );
          } catch {
            /* 记录失败绝不阻断监控 */
          }
        }
        if (mv.verdict !== "alert") return;
        const evidenceText = excerpt(
          all
            .slice(-mcfg.maxCallsPerEval)
            .map((c) => `${c.tool}${c.isError ? " (error)" : ""}: ${c.preview}`)
            .join(" | "),
          300
        );
        for (const sig of mv.hits) {
          const p = probs[MONITOR_RULE_BY_SIGNAL[sig]];
          if (!(typeof p === "number" && Number.isFinite(p))) continue;
          // 仅注入提醒文本：不打断/不停/不转向；注入失败静默（fail-open）
          await pi.sendMessage(
            {
              customType: "jev-monitor-alert",
              content: [{ type: "text", text: formatAlert(agent, sig, evidenceText, p) }],
            },
            { triggerTurn: true }
          ).catch(() => {});
        }
      } catch {
        /* fail-open：监控求值任何异常静默放行 */
      }
    }
  }
}
