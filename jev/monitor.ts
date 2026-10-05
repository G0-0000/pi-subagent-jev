// 运行监控（advisory runtime monitoring）之纯逻辑层：配置解析、相似度/候选检测、
// state 构造、判定矩阵、告警文案、触发时机与 transcript 文本解析。零 IO
// （除 loadMonitorConfig 读配置档外），可测。
// 与派单审核（checkDispatch）彼此独立：仅观察运行中子 agent，命中仅向主会话注入提醒文本，
// 不打断/不停/不转向/不设新超时；默认关闭（配置档缺/坏/未启用即特性惰然，fail-open）。
// 判定语义：below 规则 p<threshold→hit、above 规则 p>threshold→hit（同派单审核之矩阵），
// 概率缺失/非有限 → 该规则 unknown（不计 hit、不告警）；任一 hit → alert，全 unknown → unknown，否则 ok。
// 证据无脱敏阶段——调用方须保证 preview/task 不含秘密（红线一：秘密绝不入日志）。
import { readFileSync } from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import type { RuleConfig } from "./compliance.ts";
import type { MonitorState } from "./monitor-store.ts";

/** 运行监控配置（monitor.json）：默认全关，显式 opt-in（enabled 唯字面 true 生效）。 */
export type MonitorConfig = {
  enabled: boolean;
  /** bash 启动后首次检查之总耗时阈值（ms） */
  bashFirstCheckMs: number;
  /** bash 通过一次检查后之复询间隔（ms），至其结束 */
  bashRecheckMs: number;
  /** 兜底巡检：最近未获任何检查满此时长即巡检（ms） */
  sweepIntervalMs: number;
  /** 单次求值携带之最近调用条数上限 */
  maxCallsPerEval: number;
  /** 每条调用节录之最大字符数（首尾保留，中段截断） */
  maxCharsPerCall: number;
  /** state 总字符上限（中段截断） */
  maxStateChars: number;
};

/** 配置缺省：全关；3 分钟首查、10 分钟复询、10 分钟巡检；6 条/800 字/8k 字。 */
export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  enabled: false,
  bashFirstCheckMs: 300_000,
  bashRecheckMs: 600_000,
  sweepIntervalMs: 600_000,
  maxCallsPerEval: 6,
  maxCharsPerCall: 800,
  maxStateChars: 8_000,
};

/** 监控配置档默认路径（运行时数据，不入库；显式 path 参数可覆盖，便于测试）。 */
export function defaultMonitorConfigPath(): string {
  return pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "monitor.json");
}

/** 正整数解析：非有限数/非数/≤0 → 回退缺省（逐字段独立回退，fail-open）；
 *  (0,1) 区间 floor 后为 0 亦回退（防 slice(-0) 取全量之边角）。 */
function positiveInt(v: unknown, dflt: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  const n = Math.floor(v);
  return n > 0 ? n : dflt;
}

/**
 * 读监控配置档：档缺失/坏 JSON/顶层非对象 → null（视为禁用，fail-open）；
 * enabled 缺省 false（唯字面 true 启用）；数值字段非法者逐字段回退缺省。
 */
export function loadMonitorConfig(
  path: string = defaultMonitorConfigPath()
): MonitorConfig | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    raw = parsed;
  } catch {
    return null;
  }
  const d = DEFAULT_MONITOR_CONFIG;
  return {
    enabled: raw.enabled === true,
    bashFirstCheckMs: positiveInt(raw.bashFirstCheckMs, d.bashFirstCheckMs),
    bashRecheckMs: positiveInt(raw.bashRecheckMs, d.bashRecheckMs),
    sweepIntervalMs: positiveInt(raw.sweepIntervalMs, d.sweepIntervalMs),
    maxCallsPerEval: positiveInt(raw.maxCallsPerEval, d.maxCallsPerEval),
    maxCharsPerCall: positiveInt(raw.maxCharsPerCall, d.maxCharsPerCall),
    maxStateChars: positiveInt(raw.maxStateChars, d.maxStateChars),
  };
}

/** 控制事件之归一化形状（自 pi.events 之 subagent:control-event 解包而来）。 */
export type ControlEventInfo = {
  runId: string;
  agent: string;
  task: string;
  ts: number;
  currentTool?: string;
  toolCallId?: string;
  reason?: string;
  currentToolDurationMs?: number;
};

/**
 * subagent:control-event 载荷解析（公开形状，pi-subagents 0.76）：
 * 载荷为 `{ event: <ControlEvent>, source, ... }`——ControlEvent 嵌于 `event` 键下
 * （emitAdvisoryControlEvent 之 payload；消费方如 herdr-status 读 data.event.runId），
 * 兼容裸 ControlEvent 直发形（无 event 键则视载荷本身为事件）。
 * runId 非非空字符串 → null（丢弃，fail-open，绝不外抛）。
 */
export function parseControlEvent(raw: unknown): ControlEventInfo | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const inner =
    o.event && typeof o.event === "object" && !Array.isArray(o.event)
      ? (o.event as Record<string, unknown>)
      : o;
  if (typeof inner.runId !== "string" || inner.runId === "") return null;
  const info: ControlEventInfo = {
    runId: inner.runId,
    agent: typeof inner.agent === "string" && inner.agent !== "" ? inner.agent : "unknown",
    task: typeof inner.taskPreview === "string" ? inner.taskPreview : "",
    ts: typeof inner.ts === "number" && Number.isFinite(inner.ts) ? inner.ts : Date.now(),
  };
  if (typeof inner.currentTool === "string") info.currentTool = inner.currentTool;
  if (typeof inner.toolCallId === "string") info.toolCallId = inner.toolCallId;
  if (typeof inner.reason === "string") info.reason = inner.reason;
  if (
    typeof inner.currentToolDurationMs === "number" &&
    Number.isFinite(inner.currentToolDurationMs)
  ) {
    info.currentToolDurationMs = inner.currentToolDurationMs;
  }
  return info;
}

/** 一条工具调用记录（证据单元）：工具名 ＋ 节录 ＋ 是否报错 ＋ 时戳。 */
export type ToolCallRec = { tool: string; preview: string; isError: boolean; ts: number };

/**
 * 相似度归一化（刻意简单、文档化）：小写化 → 绝对路径（/… 与 ~/… 串）归一为 <path> →
 * 数字串归一为 <n> → 折叠连续空白为单空格并去首尾空白。
 * 归一后逐字相等即视为「高度相似」——足以区分「同命令重试」与「换参数/换目标之重试」。
 */
export function normalizePreview(s: string): string {
  return s
    .toLowerCase()
    .replace(/(?:~\/|\/)[\w./-]*/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** 循环/重复失败候选检测之共同窗口：最近至多此条数。 */
const DETECT_WINDOW = 6;
/** 成候选所需之最少重复次数：≥3 以容纳正常的单次/双次重试。 */
const MIN_REPEAT = 3;

/**
 * 无效工具循环检测（纯函数，候选判定）：
 * 最近 ≤6 条中同一 tool 出现 ≥3 次、且其中 ≥3 条归一化 preview 逐字相等
 * （数字/路径/空白差异忽略）→ 候选 true。
 */
export function detectLoop(calls: ToolCallRec[]): boolean {
  const win = calls.slice(-DETECT_WINDOW);
  if (win.length < MIN_REPEAT) return false;
  const counts = new Map<string, number>(); // `${tool}${NUL}${归一化}` → 次数
  for (const c of win) {
    const k = `${c.tool}\0${normalizePreview(c.preview)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const n of counts.values()) if (n >= MIN_REPEAT) return true;
  return false;
}

/**
 * 无变化重复失败检测（纯函数，候选判定）：
 * 自最近一条向前数连续之同 tool 且 isError 调用 ≥3 次、其归一化 preview 全部逐字相等
 * （无任何条件变化之迹象——换参数/换路径之中断或成功夹在中间皆打破连续性）→ 候选 true。
 */
export function detectRepeatFailures(calls: ToolCallRec[]): boolean {
  const win = calls.slice(-DETECT_WINDOW);
  let tool: string | null = null;
  let norm: string | null = null;
  let streak = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    const c = win[i];
    if (!c.isError) break; // 非错误（成功/进行中）打断连续失败
    const n = normalizePreview(c.preview);
    if (tool === null) {
      tool = c.tool;
      norm = n;
      streak = 1;
      continue;
    }
    if (c.tool !== tool || n !== norm) break; // 工具或命令有变：条件已变
    streak++;
  }
  return streak >= MIN_REPEAT;
}

/** 截断标记：节录首尾保留以此相隔。 */
export const TRUNCATION_MARKER = "…[截断]…";

/** 节录：超长保留首尾各半（中段以 TRUNCATION_MARKER 相隔）；maxChars 为 Unicode 码点上限。 */
export function excerpt(s: string, maxChars: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  const budget = Math.max(1, maxChars - Array.from(TRUNCATION_MARKER).length);
  const head = Math.ceil(budget / 2);
  const tail = Math.floor(budget / 2);
  return chars.slice(0, head).join("") + TRUNCATION_MARKER + chars.slice(chars.length - tail).join("");
}

/**
 * 监控 state 构造：英文模板句 ＋ 任务原文 ＋ 最近 ≤maxCallsPerEval 条调用
 * （每条节录 ≤maxCharsPerCall 字、首尾保留），总长 ≤maxStateChars 字（中段截断）。
 * 任务原文逐字保留（中文不动）；无脱敏阶段——调用方须保证输入不含秘密。
 */
export function buildMonitorState(
  agent: string,
  task: string,
  calls: ToolCallRec[],
  cfg: MonitorConfig
): string {
  const recent = calls.slice(-cfg.maxCallsPerEval);
  const callLines = recent.map(
    (c, i) =>
      `#${i + 1} ${c.tool} (${c.isError ? "error" : "ok"}) ${excerpt(c.preview, cfg.maxCharsPerCall)}`
  );
  const body =
    `The following is a runtime monitoring snapshot of a sub-agent named "${agent}". ` +
    `Task text follows.\n${task}\n` +
    `Recent tool calls (oldest first, at most ${cfg.maxCallsPerEval}):\n` +
    (callLines.length > 0 ? callLines.join("\n") : "(no tool calls recorded)");
  return excerpt(body, cfg.maxStateChars);
}

/** 监控信号：三类检测器 ＋ 兜底巡检。 */
export type MonitorSignal = "stall" | "loop" | "repeat_failure" | "no_progress";

/** 信号之中文描述（告警文案用）。 */
export const MONITOR_SIGNAL_LABEL: Record<MonitorSignal, string> = {
  stall: "疑似 bash 停滞",
  loop: "疑似无效工具循环",
  repeat_failure: "疑似无变化重复失败",
  no_progress: "疑似无推进迹象",
};

/** 检测器名（告警文案「规则：」栏）。 */
export const MONITOR_DETECTOR_NAME: Record<MonitorSignal, string> = {
  stall: "bash-stall",
  loop: "tool-loop",
  repeat_failure: "repeat-failure",
  no_progress: "no-progress",
};

/** 信号 → 规则 id（置信度取值与告警文案用；monitorVerdict 之反向映射）。 */
export const MONITOR_RULE_BY_SIGNAL: Record<MonitorSignal, string> = {
  stall: "M001",
  loop: "M002",
  repeat_failure: "M003",
  no_progress: "M004",
};

/** 规则 id → 信号（monitorVerdict 据以把命中规则映射回检测器信号）。 */
export const MONITOR_SIGNAL_BY_RULE: Record<string, MonitorSignal> = {
  M001: "stall",
  M002: "loop",
  M003: "repeat_failure",
  M004: "no_progress",
};

/**
 * 监控问句（内建常量，非配置档来源）：M001-M004，与派单审核之问句互不相干。
 * 判法与派单审核同矩阵：below=p<threshold→hit（正例），above=p>threshold→hit（反例）。
 */
export const MONITOR_QUESTIONS: RuleConfig[] = [
  {
    id: "M001",
    instructions:
      "Considering the command's purpose and the task goal, is it reasonable that this bash command has been running for the elapsed time?",
    criteria: {
      true: "duration matches the command's nature (compile/download/test may legitimately take long)",
      false: "command should return quickly but has been hanging",
    },
    blockWhen: "below",
    threshold: 0.6,
    message: "疑似 bash 停滞",
  },
  {
    id: "M002",
    instructions: "Is the sub-agent repeating similar tool calls without new progress?",
    criteria: {
      true: "similar commands repeat with no new findings",
      false: "limited retries or re-tests are normal",
    },
    blockWhen: "above",
    threshold: 0.7,
    message: "疑似无效工具循环",
  },
  {
    id: "M003",
    instructions: "Is the sub-agent repeating the same failure without changing conditions?",
    criteria: {
      true: "same error repeats and the approach is unchanged",
      false: "planned retries or changed conditions",
    },
    blockWhen: "above",
    threshold: 0.7,
    message: "疑似无变化重复失败",
  },
  {
    id: "M004",
    instructions: "Based on recent activity, is the sub-agent still making progress toward the task goal?",
    criteria: {
      true: "recent calls show substantive progress",
      false: "spinning or treading water",
    },
    blockWhen: "below",
    threshold: 0.6,
    message: "疑似无推进迹象",
  },
];

/** 求值载荷（noul 问句包，与派单审核同形）：由 MONITOR_QUESTIONS 导出，调用方直接可用。 */
export const MONITOR_QUESTION_PAYLOAD: Record<string, unknown> = Object.fromEntries(
  MONITOR_QUESTIONS.map((q) => [
    q.id,
    {
      type: "noul" as const,
      instructions: q.instructions,
      ...(q.criteria ? { criteria: q.criteria } : {}),
    },
  ])
);

/** 训练记录用之问句数组（与请求载荷同源）。 */
export function monitorTrainingQuestions(): { id: string; instructions: string; criteria?: { true?: string; false?: string } }[] {
  return MONITOR_QUESTIONS.map((q) => ({
    id: q.id,
    instructions: q.instructions,
    ...(q.criteria ? { criteria: q.criteria } : {}),
  }));
}

export type MonitorVerdictResult = {
  verdict: "alert" | "ok" | "unknown";
  hits: MonitorSignal[];
};

/**
 * 监控判定矩阵（纯函数）：below 规则 p<threshold→hit、above 规则 p>threshold→hit；
 * 概率缺失/非有限 → 该规则 unknown（不计 hit、不告警，fail-open）。
 * 任一 hit → alert；无 hit 且至少一规则有有效概率 → ok；全部 unknown → unknown。
 */
export function monitorVerdict(
  rules: RuleConfig[],
  probs: Record<string, number>
): MonitorVerdictResult {
  const hits: MonitorSignal[] = [];
  let anyKnown = false;
  for (const r of rules) {
    const p = probs[r.id];
    if (!(typeof p === "number" && Number.isFinite(p))) continue; // 缺失/非有限 → unknown
    anyKnown = true;
    const hit = r.blockWhen === "below" ? p < r.threshold : p > r.threshold;
    if (!hit) continue;
    const sig = MONITOR_SIGNAL_BY_RULE[r.id];
    if (sig && !hits.includes(sig)) hits.push(sig);
  }
  if (hits.length > 0) return { verdict: "alert", hits };
  return { verdict: anyKnown ? "ok" : "unknown", hits };
}

/**
 * 告警文案（规则触发式中文文本）：
 * `JEV 监控告警：<agent> <信号中文描述>（规则：<检测器名>）；证据：<节录>；置信度：<p>；建议：核查是否正常。`
 * 仅文字提醒，主 agent 自决处置。
 */
export function formatAlert(
  agent: string,
  signal: MonitorSignal,
  evidence: string,
  confidence: number
): string {
  const ruleId = MONITOR_RULE_BY_SIGNAL[signal];
  return (
    `JEV 监控告警：${agent} ${MONITOR_SIGNAL_LABEL[signal]}（规则：${ruleId} ${MONITOR_DETECTOR_NAME[signal]}）；` +
    `证据：${evidence}；置信度：${confidence.toFixed(2)}；建议：核查是否正常。`
  );
}

/** 一次待触发之检查（时长线产物；同 tick 多项由调用方合并为一次求值）。 */
export type DueCheck = { kind: "bash_first" | "bash_recheck" | "sweep"; toolCallId?: string };

/**
 * 触发时机（纯函数，时钟外注可测）：
 * - bash_first：某 bash 调用总耗时 ≥ bashFirstCheckMs 且从未检查过；
 * - bash_recheck：某 bash 调用已通过一次检查、距上次检查 ≥ bashRecheckMs 且仍在运行；
 * - sweep：该 run 自最近一次任何检查（从未检查则自 startedAt）起 ≥ sweepIntervalMs。
 */
export function dueChecks(state: MonitorState, now: number, cfg: MonitorConfig): DueCheck[] {
  const out: DueCheck[] = [];
  for (const b of state.bashCalls) {
    if (b.checkedAt === undefined) {
      if (now - b.startedAt >= cfg.bashFirstCheckMs) {
        out.push({ kind: "bash_first", toolCallId: b.toolCallId });
      }
    } else if (now - b.checkedAt >= cfg.bashRecheckMs) {
      out.push({ kind: "bash_recheck", toolCallId: b.toolCallId });
    }
  }
  const anchor = state.lastCheckAt ?? state.startedAt;
  if (now - anchor >= cfg.sweepIntervalMs) out.push({ kind: "sweep" });
  return out;
}

/**
 * fleet transcript 文本解析（公开 RPC status/view=transcript 之文本形，pi-subagents 0.76 形状）：
 * 逐行扫描 `Tool: <name> (<status>)` 起始之工具节——其后诸行（args/output）并为 preview，
 * 至下一条节标题（Tool:/Run:/Child:/Assistant:/Supervisor:/Transcript… 之冒号行）止。
 * status 含 error/fail 即 isError；ts 取行序（合成递增，仅供排序与去重）。
 * 无任何工具节 → 空数组（证据不足，调用方按 unknown/fail-open 处理）。
 */
export function parseFleetTranscript(text: string): ToolCallRec[] {
  const out: ToolCallRec[] = [];
  const lines = text.split(/\r?\n/);
  let cur: { tool: string; isError: boolean; buf: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    out.push({
      tool: cur.tool,
      preview: cur.buf.join("\n").trim(),
      isError: cur.isError,
      ts: out.length,
    });
    cur = null;
  };
  for (const line of lines) {
    const m = /^Tool: (\S+) \(([^)]*)\)\s*$/.exec(line);
    if (m) {
      flush();
      const status = m[2].toLowerCase();
      cur = { tool: m[1], isError: /err|fail/.test(status), buf: [] };
      continue;
    }
    // 节标题行（非工具输出）：结束当前工具节
    if (/^(Run|Child|State|Transcript|Assistant|Supervisor|Resume|Commands|Root status|Live transcript|In-memory|Status|Interrupt|Steer):/.test(line)) {
      flush();
      continue;
    }
    if (cur) cur.buf.push(line);
  }
  flush();
  return out;
}

/**
 * 异步（后台）输出日志之工具行语法（pi-subagents 0.76 实证）：
 * run-child-session.js:374 —— 工具调用起始写一行 `<toolName>: <argsPreview>`（无预览则裸 `<toolName>`）；
 * 工具结果/助手文本经 writeOutputText 逐行原样写入（run-child-session.js:138-143），无错误标记。
 * 故异步形之 isError 恒 false（真实格式无错误标记可凭——弱证据之限，ADR 已载；
 * repeat_failure 检测器于异步形退化不触发）。`Task: ` 行系任务原文逐字写入（首条用户消息），
 * 可抽取补填 store.task。
 */

/** 已知工具名表（保守锚定，大小写不敏感）：唯表内之名命中 `<tool>: ` 行首方视为工具调用，
 * 任意含冒号之散文不误判。 */
export const ASYNC_TOOL_VOCAB: readonly string[] = [
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "subagent",
  "web_search",
  "web_fetch",
  "jev_ask",
];

const ASYNC_TOOL_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]+(\S.*)$/;
const ASYNC_TASK_LINE = /^Task:[ \t]+(\S.*)$/i;

/**
 * 异步输出日志解析：`^<toolname>: <content>` 行（toolname 命中 ASYNC_TOOL_VOCAB，大小写不敏感）
 * 化为 ToolCallRec；isError 恒 false（输出日志无错误标记）；ts 取行序（合成递增）。
 */
export function parseAsyncTranscript(text: string): ToolCallRec[] {
  const vocab = new Set(ASYNC_TOOL_VOCAB);
  const out: ToolCallRec[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // 行首空白容忍：RPC transcript 正文行恒带两空格缩进（fleet-view.js
    // appendTranscriptBody 之 `  ${line}`），剥缩进后方匹配；词表锚定不变，散文不误判。
    const line = rawLine.trimStart();
    const m = ASYNC_TOOL_LINE.exec(line);
    if (!m) continue;
    if (!vocab.has(m[1].toLowerCase())) continue;
    out.push({ tool: m[1].toLowerCase(), preview: m[2].trim(), isError: false, ts: out.length });
  }
  return out;
}

/** 自异步输出日志抽任务原文：首个 `Task: <text>` 行之文本（容忍行首缩进，同正文缩进之实）；无 → null。 */
export function extractAsyncTask(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const m = ASYNC_TASK_LINE.exec(rawLine.trimStart());
    if (m) return m[1].trim();
  }
  return null;
}

export type TranscriptEvidence = { calls: ToolCallRec[]; task: string | null };

/**
 * transcript 证据统一入口：前台 fleet 形（`Tool: <name> (<status>)` 节）优先；
 * 零节则回落异步输出日志形（`<tool>: <content>` 行）；两者俱空 → calls 为空（证据不足）。
 * 异步形命中时顺带抽取 `Task: ` 行任务原文（控制事件未带 taskPreview 时补填）。
 */
export function parseTranscriptEvidence(text: string): TranscriptEvidence {
  const fleet = parseFleetTranscript(text);
  if (fleet.length > 0) return { calls: fleet, task: null };
  const asyncCalls = parseAsyncTranscript(text);
  return { calls: asyncCalls, task: asyncCalls.length > 0 ? extractAsyncTask(text) : null };
}
