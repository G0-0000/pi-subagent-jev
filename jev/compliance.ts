// JEV 派发合规审计：纯逻辑层（除 loadRuleSets 读配置档外不触 IO，可测）。
// 对命中规则集的 subagent 派单，把任务原文打包为 state，向 System One 一次性求值一批 noul 问：
// 审计侧按阈值矩阵出 verdict 落 audit.jsonl；拦截侧按每规则之 blockWhen/threshold 判命中，
// 命中则把该规则 message 收进 violations，由调用方（扩展壳）据此 block 派单。
// 规则全由配置驱动（v0.7.0 起内建规则全废，配置档为唯一来源）：问句即自含规则（v0.8.0 起），
// `_questions` 每条自带 blockWhen（below/above）与 threshold，各组之 rules 为问句 id 字符串数组，
// verdict 标签与拦截判定均按配置计算，无硬编码规则 id。
// 另有 `_all` 全局规则组：凡派单皆受查（含无专属组之 agent），与 agent 专属组并成一次请求；
// 同一 id 既列 `_all` 又列组内 → 去重（全局在前）——同一 id 即同一问句，无冲突胜负语义。
// 模式（v0.9.0）：`_global.mode` 为全局缺省（唯 "block"|"warn"，非法静默回 "block"），
// 各 agent 组可选 `mode` 覆盖之（组优先于全局）；block（缺省）命中即拦（行为逐字不变），
// warn 只记不拦——违规清单由扩展壳暂存于 toolCallId，事后缀到 tool_result 文本（观察模式）。
// 传输（v0.10.0）：`_global.transport` 选求值传输——"selfhost"（缺省，自管 curl 链，行为不变）｜
// "builtin"（pi 内建 classifier 平台，链路 `_global.builtinChain`，经扩展壳解析后注入 createBuiltinAsk）。
// 任何错误 fail-open：JEV 出错、配置档出错、概率缺失皆放行，绝不外抛。
import {
  ask as defaultAsk,
  getAskMeta,
  JevError,
  type AskParams,
  type SystemOneResult,
} from "./client.ts";
import {
  CooldownTracker,
  loadFailoverConfig,
  type AttemptRecord,
  type FailoverConfig,
} from "./failover.ts";
import {
  dispatchTrainingLine,
  writeTrainingLine,
  type TrainingQuestion,
  type TrainingWriter,
} from "./traininglog.ts";
import { readFileSync } from "node:fs";

/** 规则 id：任意字符串（R1-R4 等仅为配置档惯用编号，代码不限制）。 */
export type RuleId = string;

/**
 * 有效规则（载入侧形状）：v0.8.0 起 `_questions` 每条问句即一条完整自含规则，
 * 各组与 `_all` 之 rules 按问句 id 引用解析成此形状，消费方无须知道引用之存在。
 */
export type RuleConfig = {
  id: RuleId;
  instructions: string;
  /** 答支判据（可选）：true/false 各一句自然语言，划清答支边界以消歧；有则透传 JEV */
  criteria?: { true?: string; false?: string };
  /** 拦截方向："below"=p 低于阈值即拦（正例规则）；"above"=p 高于阈值即拦（反例规则） */
  blockWhen: "below" | "above";
  threshold: number; // 0..1
  message: string; // 命中拦截时返给主 agent 的人话
};

/** 派单处置模式："block"=命中即拦（缺省）；"warn"=只记不拦（观察模式）。 */
export type Mode = "block" | "warn";

/**
 * 传输选择（v0.10.0）："selfhost"＝自管 curl 链（jev/client.ts，缺省，行为逐字不变）；
 * "builtin"＝pi 内建 classifier 平台（ctx.modelRegistry.classify，链路见 builtinChain）。
 * 解析：唯字面 "builtin" 生效，其余（缺省/非法/大小写不符）静默回 "selfhost"（fail-open）。
 */
export type Transport = "selfhost" | "builtin";

/** 内建链路条目：`_global.builtinChain` 之合法项（provider/model 皆非空白字符串；多余键静默弃）。 */
export type BuiltinChainEntry = { provider: string; model: string };

/** 内建链路缺省：typesafe jev-latest 单级（pi 内建 classifier 平台同款端点/模型）。 */
export const DEFAULT_BUILTIN_CHAIN: readonly BuiltinChainEntry[] = [
  { provider: "typesafe", model: "jev-latest" },
];

export type AgentRuleSet = { agentDesc: string; rules: RuleConfig[]; mode?: Mode };

/**
 * 内建默认规则集：v0.7.0 起全废（配置档为规则之唯一来源）。保留导出以兼容既有引用。
 * 配置档缺失/损坏 → 此处为空 → 所有派单不经检查放行（fail-open 推至尽头，有意如此）。
 */
export const RULE_SETS: Record<string, AgentRuleSet> = {};

/** state 模板：模板句＋任务原文（任务原文逐字保留，中文不动）。 */
export function buildState(agent: string, agentDesc: string, task: string): string {
  return `The following is a task dispatched to a sub-agent named "${agent}", ${agentDesc}. Task text follows.\n${task}`;
}

export type RuleLabel = "pass" | "fail" | "suspect" | "clean" | "unknown";
export type OverallVerdict = "pass" | "violation" | "error";

export type VerdictResult = {
  rules: Record<string, RuleLabel>;
  verdict: OverallVerdict;
};

/**
 * 审计标签矩阵（仅供审计记录，不参与拦截判定；blockWhen/threshold 全由配置驱动，无硬编码规则 id）：
 * below 规则：p < threshold → fail，否则 pass；above 规则：p > threshold → suspect，否则 clean。
 * 概率缺失/非有限 → unknown（仅审计记录，永不拦截）。
 * 综合：任一 fail/suspect → violation；否则 pass。
 */
export function verdict(rules: RuleConfig[], probs: Record<string, number>): VerdictResult {
  const labels: Record<string, RuleLabel> = {};
  for (const r of rules) {
    const p = probs[r.id];
    labels[r.id] =
      !(typeof p === "number" && Number.isFinite(p))
        ? "unknown"
        : r.blockWhen === "below"
          ? p < r.threshold
            ? "fail"
            : "pass"
          : p > r.threshold
            ? "suspect"
            : "clean";
  }
  const overall: OverallVerdict = Object.values(labels).some(
    (l) => l === "fail" || l === "suspect"
  )
    ? "violation"
    : "pass";
  return { rules: labels, verdict: overall };
}

export type AuditLineFields = {
  ts?: string;
  agent: string;
  task: string;
  model?: string | null;
  rules?: Record<string, RuleLabel> | null;
  verdict: OverallVerdict;
  latencyMs: number;
  blocked?: string[];
  probs?: Record<string, number>;
  error?: string;
  /** 胜者非首配 upstream 时（真实切换或冷却跳过）：胜出 upstream 名 */
  upstream?: string;
  /** 同上时：历次失败尝试记录（冷却跳过记 kind:"cooldown" 无 status/ms；全链败尽之错误行亦只带此键、无 upstream） */
  failover?: AttemptRecord[];
  /** 保底尝试标记——本次成功之请求系全链冷却下保底真发之首名 */
  fallback?: boolean;
  /** warn 观察模式标记——仅 warn 模式且确有违规之审计行落此键；block/放行/错误诸行永不落 */
  action?: "warn";
};

export type AuditLine = {
  ts: string;
  agent: string;
  task_excerpt: string;
  model: string | null;
  rules: Record<string, RuleLabel> | null;
  verdict: OverallVerdict;
  latency_ms: number;
  blocked?: string[];
  probs?: Record<string, number>;
  error?: string;
  upstream?: string;
  failover?: AttemptRecord[];
  fallback?: boolean;
  action?: "warn";
};

/** 模式解析（纯函数）：组显式 mode 优先，其次全局 mode，皆无 → "block"。 */
export function resolveMode(agent: string, loaded: LoadedRules): Mode {
  return loaded.agents[agent]?.mode ?? loaded.global.mode ?? "block";
}

/** audit.jsonl 单行构造（不含换行符）。task_excerpt 按 Unicode 码点截 ≤200 字。 */
export function auditLine(fields: AuditLineFields): AuditLine {
  const line: AuditLine = {
    ts: fields.ts ?? new Date().toISOString(),
    agent: fields.agent,
    task_excerpt: Array.from(fields.task).slice(0, 200).join(""),
    model: fields.model ?? null,
    rules: fields.rules ?? null,
    verdict: fields.verdict,
    latency_ms: fields.latencyMs,
  };
  if (fields.blocked && fields.blocked.length > 0) line.blocked = fields.blocked;
  if (fields.probs) line.probs = fields.probs;
  if (fields.error !== undefined) line.error = fields.error;
  if (fields.upstream !== undefined) line.upstream = fields.upstream;
  if (fields.failover && fields.failover.length > 0) line.failover = fields.failover;
  if (fields.fallback) line.fallback = true;
  // action 仅在 warn 观察模式且确有违规时由调用方传入；block/放行/错误诸行永不落此键（形状向后兼容）
  if (fields.action === "warn") line.action = "warn";
  return line;
}

/** 问句库单条（_questions 之值）：v0.8.0 起即一条完整自含规则；label 仅供人读，一概忽略。 */
type RawQuestion = {
  label?: unknown;
  instructions?: unknown;
  criteria?: unknown;
  blockWhen?: unknown;
  threshold?: unknown;
  message?: unknown;
};

type RawRuleSet = { agentDesc?: unknown; rules?: unknown; mode?: unknown };

/** loadRuleSets 返回：配置档解析后之 agent 规则组 ＋ `_all` 全局规则组 ＋ 全局开关。 */
export type LoadedRules = {
  agents: Record<string, AgentRuleSet>;
  /** `_all` 全局规则组：顶层无此键 / 值非法 / 无可解析规则 → null（fail-open，静默） */
  all: AgentRuleSet | null;
  global: {
    auditProbabilities: boolean;
    trainingLog: boolean;
    mode: Mode;
    /** 传输选择（v0.10.0）：唯字面 "builtin" 走内建 classifier 平台，其余（缺省/非法）一律 "selfhost" */
    transport: Transport;
    /** 内建链路（transport==="builtin" 时由扩展壳经 findOfType 解析后注入 createBuiltinAsk）：
     *  非法项静默弃，空/缺省回 DEFAULT_BUILTIN_CHAIN（typesafe/jev-latest） */
    builtinChain: BuiltinChainEntry[];
  };
};

/** mode 解析（v0.9.0）：唯字面 "warn" 方为 warn，其余（缺省/非法/大小写不符）一律 "block"（fail-open）。 */
function parseMode(v: unknown): Mode {
  return v === "warn" ? "warn" : "block";
}

/** 组级 mode（可选）：唯 "block"|"warn" 字面有效，其余（缺省/非法）置 undefined → 随 resolveMode 落到全局。 */
function parseGroupMode(v: unknown): Mode | undefined {
  return v === "warn" || v === "block" ? v : undefined;
}

/**
 * 内建链路解析（fail-open）：数组中每项须为对象且 provider/model 皆非空白字符串，
 * 只取此二键（多余键弃之）；非法项静默弃。空数组/非数组/全非法 → 缺省单级链（typesafe/jev-latest）。
 */
function parseBuiltinChain(v: unknown): BuiltinChainEntry[] {
  const out: BuiltinChainEntry[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const o = item as Record<string, unknown>;
      if (typeof o.provider !== "string" || o.provider.trim() === "") continue;
      if (typeof o.model !== "string" || o.model.trim() === "") continue;
      // 存 trim 后之值：带空白之 " typesafe " 若原样入链，findOfType 必静默预败
      out.push({ provider: o.provider.trim(), model: o.model.trim() });
    }
  }
  return out.length > 0 ? out : [...DEFAULT_BUILTIN_CHAIN];
}

/** 配置档顶层保留键：全局开关，不视作 agent 名。 */
const GLOBAL_KEY = "_global";

/** 配置档顶层保留键：自含问句库（v0.8.0 起每条问句即一条完整规则），不视作 agent 名。 */
const QUESTIONS_KEY = "_questions";

/** 配置档顶层保留键：全局规则组（凡派单皆受查），不视作 agent 名；其 agentDesc 不读。 */
const ALL_KEY = "_all";

/** 配置档 criteria 之解析：唯取 true/false 两字符串字段；非法者静默弃之（fail-open），绝不阻断 */
function parseCriteria(v: unknown): { true?: string; false?: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const c: { true?: string; false?: string } = {};
  if (typeof o.true === "string") c.true = o.true;
  if (typeof o.false === "string") c.false = o.false;
  return Object.keys(c).length > 0 ? c : undefined;
}

/**
 * 问句库解析（fail-open）：v0.8.0 起每条问句即一条完整自含规则，唯三项齐备方有效——
 * `instructions` 非空白字符串、`blockWhen` 为 below/above、`threshold` 为有限数；
 * 缺一（含条目非对象、库非对象或为数组）皆静默弃之，绝不致使整档解析失败。
 * `message` 缺省 `规则 <id> 未通过`；`criteria` 非法值静默弃之；`label` 一概忽略（可存不可用）。
 */
function parseQuestions(v: unknown): Map<string, RuleConfig> {
  const out = new Map<string, RuleConfig>();
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [id, item] of Object.entries(v as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as RawQuestion;
    if (typeof o.instructions !== "string" || o.instructions.trim() === "") continue;
    if (o.blockWhen !== "below" && o.blockWhen !== "above") continue;
    if (typeof o.threshold !== "number" || !Number.isFinite(o.threshold)) continue;
    const c = parseCriteria(o.criteria);
    out.set(id, {
      id,
      instructions: o.instructions,
      ...(c ? { criteria: c } : {}),
      blockWhen: o.blockWhen,
      threshold: o.threshold,
      message: typeof o.message === "string" ? o.message : `规则 ${id} 未通过`,
    });
  }
  return out;
}

/**
 * 单个规则组（agent 专属组或 `_all`）之 rules 解析（fail-open）：
 * rules 为问句 id 字符串数组——非字符串项（含旧版 {id,question} 对象形，v0.8.0 起不再支持）、
 * 同 id 重复项（保首个、保序）、问句库中不存在或无效之 id 皆静默弃之；
 * rules 非数组 → 无规则。组整体非对象（含数组、字符串）→ 空数组（静默，绝不抛）。
 */
function parseRuleRefs(cfg: unknown, questions: Map<string, RuleConfig>): RuleConfig[] {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return [];
  const list = (cfg as RawRuleSet).rules;
  if (!Array.isArray(list)) return [];
  const out: RuleConfig[] = [];
  const seen = new Set<RuleId>();
  for (const item of list) {
    if (typeof item !== "string") continue; // 非字符串（含旧版对象形）→ 静默弃
    if (seen.has(item)) continue; // 同组重复引用 → 保首个
    const q = questions.get(item);
    if (!q) continue; // 未知 id（库中无此项或已因非法被弃）→ 静默弃
    seen.add(item);
    out.push(q);
  }
  return out;
}

/**
 * 读配置档（v0.7.0 起配置档为规则之唯一来源，无任何内建缺省）：
 * 每个非保留键之顶层条目解析为一个 agent 规则组（agentDesc 取其字符串值，缺省空串；
 * rules 为问句 id 字符串数组，按 `_questions` 解析成完整规则，非法/未知/重复引用静默弃之）。
 * `_global: { auditProbabilities, trainingLog, mode, transport, builtinChain }` 为全局开关与全局选项
 * （前二者缺省 false；mode 缺省 "block"，非 "warn" 字面一律静默回 "block"；
 * transport 唯字面 "builtin" 生效、其余静默回 "selfhost"；builtinChain 非法项静默弃、空/缺省回缺省单级链）。`_all` 不读 mode（其上无 agentDesc 可言，模式唯组级与全局二者）。
 * `_questions` 为顶层自含问句库：每条 id 即规则 id，自带 instructions/criteria/blockWhen/
 * threshold/message：其中 instructions/blockWhen/threshold 为三项硬性条件，缺一之条目整条弃；唯 message 缺省 `规则 <id> 未通过`。
 * `_all` 为全局规则组：凡派单皆受查（含无专属组之 agent，其 state 述语写死 "a sub-agent"），
 * 与 agent 专属组并成一次请求；同 id 既列 `_all` 又列组内 → 去重（全局在前），
 * 同一 id 即同一问句，无冲突胜负语义；其 agentDesc 不读（恒不生效）。
 * 任何读取/解析错误、以及 `_all`/组/条目之非法形状 → 静默弃之（fail-open），绝不抛：
 * 档缺失/坏 JSON → agents 空且 all 为 null → 所有派单放行。
 */
export function loadRuleSets(path: string): LoadedRules {
  const fallback = (): LoadedRules => ({
    agents: RULE_SETS, // v0.7.0 起恒为空对象（内建已废）
    all: null,
    global: {
      auditProbabilities: false,
      trainingLog: false,
      mode: "block",
      transport: "selfhost",
      builtinChain: [...DEFAULT_BUILTIN_CHAIN],
    },
  });
  let raw: Record<string, RawRuleSet>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return fallback();
    raw = parsed as Record<string, RawRuleSet>;
  } catch {
    return fallback();
  }
  const g = (raw as Record<string, unknown>)[GLOBAL_KEY];
  const gObj = g && typeof g === "object" ? (g as Record<string, unknown>) : undefined;
  const auditProbabilities = gObj?.auditProbabilities === true;
  const trainingLog = gObj?.trainingLog === true;
  const mode = parseMode(gObj?.mode);
  const transport: Transport = gObj?.transport === "builtin" ? "builtin" : "selfhost";
  const builtinChain = parseBuiltinChain(gObj?.builtinChain);
  const questions = parseQuestions((raw as Record<string, unknown>)[QUESTIONS_KEY]);
  const agents: Record<string, AgentRuleSet> = {};
  for (const [agent, cfg] of Object.entries(raw)) {
    if (agent === GLOBAL_KEY || agent === QUESTIONS_KEY || agent === ALL_KEY) continue;
    if (!cfg || typeof cfg !== "object") continue;
    agents[agent] = {
      agentDesc: typeof (cfg as RawRuleSet).agentDesc === "string" ? (cfg as RawRuleSet).agentDesc as string : "",
      rules: parseRuleRefs(cfg, questions),
      ...(parseGroupMode((cfg as RawRuleSet).mode)
        ? { mode: parseGroupMode((cfg as RawRuleSet).mode) }
        : {}),
    };
  }
  // `_all` 全局规则组：值非法（字符串/数组等）→ parseRuleRefs 返空 → 视为无（null）
  const allRules = parseRuleRefs((raw as Record<string, unknown>)[ALL_KEY], questions);
  return {
    agents,
    all: allRules.length > 0 ? { agentDesc: "", rules: allRules } : null,
    global: { auditProbabilities, trainingLog, mode, transport, builtinChain },
  };
}

export type AskFn = (params: AskParams) => Promise<SystemOneResult>;

// failover 配置：模块级懒缓存，随扩展加载读一次（/reload 重导入模块即重置，
// 与 envFileCache / 规则配置同生命周期）；缺档/坏档返 null → 旧单端点链路（fail-open）。
let failoverCache: FailoverConfig | null | undefined;
function getFailover(): FailoverConfig | null {
  if (failoverCache === undefined) failoverCache = loadFailoverConfig();
  return failoverCache;
}

// 冷却表：与 failover 配置同生命周期（/reload 重导入模块即重置），构造时带上链路 cooldownMs——
// 配置之 cooldownMs 自此对派单拦截生效；无链路时用缺省 tracker（旧单端点路径本就不触冷却）。
let trackerCache: CooldownTracker | undefined;
function getTracker(): CooldownTracker {
  if (trackerCache === undefined) {
    const fo = getFailover();
    trackerCache = fo ? new CooldownTracker(undefined, fo.cooldownMs) : new CooldownTracker();
  }
  return trackerCache;
}

export type CheckResult = { line: AuditLine; violations: string[] };

/**
 * warn 观察模式提示文本（纯函数，与 block reason 同族但明确非阻断）：
 * 首行标明 agent 名与观察模式，随后每条违规一行、以 `- ` 前缀（同 block reason 之形）；
 * 无末尾「请修正…」行——未阻断，无可修正之令。
 */
export function formatWarnNotice(agent: string, violations: string[]): string {
  return (
    `派单审核提示（agent=${agent}，warn 观察模式——未阻断，subagent 已照常派发，请主 agent 自行决断）：\n` +
    violations.map((m) => `- ${m}`).join("\n")
  );
}

/**
 * 主流程：agent 无专属组且无 `_all` 全局规则 → null；有则取有效规则（全局在前、agent 组在后，
 * 同 id 去重（全局在前）——问句自含后同一 id 即同一问句；instructions 为空/空白者跳过，
 * 全部无效亦返 null；无专属组之 agent 其 agentDesc 写死 "a sub-agent"，`_all.agentDesc` 不读），
 * buildState ＋ noul 问打包一次请求 ＋ verdict ＋ 逐规则拦截判定 ＋ auditLine。
 * 拦截判定：(blockWhen==="below" && p < threshold) || (blockWhen==="above" && p > threshold)，
 * 命中者以 `${id}: ${message}` 全列入 violations，规则 id 全列入 line.blocked。
 * noul 字段缺失或非有限数：该规则标 unknown、不拦（fail-open，红线三）。
 * opts.auditProbabilities 为 true 时审计行附 probs（规则 id → 原始概率，仅有限值）。
 * opts.mode（v0.9.0，缺省 "block"）：warn 观察模式不改变判定与 violations，仅当确有违规时
 * 审计行另落 `action: "warn"` 一键（block/放行/错误诸行永不落此键，形状向后兼容）。
 * opts.trainingLog 为 true 时（且求值未走 error 路径）另有 opts.writeTraining（缺省落 training.jsonl）
 * 追加一条训练行；写入失败静默吞下。
 * JevError（及任何异常）捕获 → 返 error 行且 violations 为空，fail-open，绝不外抛。
 */
export async function checkDispatch(
  agent: string,
  task: string,
  opts: {
    askFn?: AskFn;
    ruleSets?: Record<string, AgentRuleSet>;
    /** `_all` 全局规则组（缺省无）：凡派单皆附加求值，与 agent 专属组并成一次请求；
     *  同 id 去重（全局在前）——同一 id 即同一问句，无冲突胜负语义 */
    allRules?: AgentRuleSet;
    auditProbabilities?: boolean;
    /** 处置模式（缺省 "block"）：warn 时命中不拦，审计行落 action:"warn"（仅违规行） */
    mode?: Mode;
    /** 训练数据记录开关（缺省 false，不记） */
    trainingLog?: boolean;
    /** 训练行写入器（缺省 writeTrainingLine 落 training.jsonl；测试可注入 mock） */
    writeTraining?: TrainingWriter;
  } = {}
): Promise<CheckResult | null> {
  const ruleSets = opts.ruleSets ?? RULE_SETS;
  const rs = ruleSets[agent];
  const globalRules = opts.allRules?.rules ?? [];
  if (!rs && globalRules.length === 0) return null;
  // 有效规则 = 全局规则（`_all` 序）＋ agent 组规则（组内序，同 id 已列全局者弃之）——
  // 问句自含后同一 id 即同一问句，去重以全局在前为准（与载入后同 id 引用同问句之序一致）
  const globalIds = new Set(globalRules.map((r) => r.id));
  const combined = [...globalRules, ...(rs?.rules ?? []).filter((r) => !globalIds.has(r.id))];
  // instructions 为空/空白的规则无可问之题，检查时跳过（fail-open）
  const rules = combined.filter(
    (r) => typeof r.instructions === "string" && r.instructions.trim() !== ""
  );
  if (rules.length === 0) return null;
  // agentDesc：有专属组取组内值；无专属组（仅 `_all` 生效）写死通用述语，无配置旋钮
  const agentDesc = rs ? rs.agentDesc : "a sub-agent";
  const askFn: AskFn =
    opts.askFn ??
    ((p) =>
      defaultAsk({
        ...p,
        failover: getFailover(),
        tracker: getTracker(),
      }));
  const start = Date.now();
  const state = buildState(agent, agentDesc, task);
  // 训练记录之问句数组（与请求载荷同源；criteria 有则透传）
  const trainingQuestions: TrainingQuestion[] = rules.map((r) => ({
    id: r.id,
    instructions: r.instructions,
    ...(r.criteria ? { criteria: r.criteria } : {}),
  }));
  try {
    const questions = Object.fromEntries(
      rules.map((r) => [
        r.id,
        {
          type: "noul" as const,
          instructions: r.instructions,
          ...(r.criteria ? { criteria: r.criteria } : {}),
        },
      ])
    );
    const res = await askFn({ state, questions });
    const answers = res.answers as Record<string, { noul?: unknown }>;
    // noul 缺失或非有限数：不进 probs → 审计标 unknown、不拦（fail-open，红线三）
    const probs: Record<string, number> = {};
    for (const r of rules) {
      const raw = answers[r.id]?.noul;
      if (typeof raw === "number" && Number.isFinite(raw)) probs[r.id] = raw;
    }
    const v = verdict(rules, probs);
    const meta = getAskMeta(res);
    // attempts 非空（真实切换或冷却跳过）或保底成功（meta.fallback，全链冷却下被迫真发首名）皆须落
    // upstream 键；首配 upstream 正常即成（attempts 空且非保底）不落键，与旧单端点链路无异。
    const routed = !!(meta && (meta.attempts.length > 0 || meta.fallback));
    const blocked: string[] = [];
    const violations: string[] = [];
    for (const r of rules) {
      const p = probs[r.id];
      if (p === undefined) continue; // 概率缺失：该规则不拦（fail-open）
      const hit = r.blockWhen === "below" ? p < r.threshold : p > r.threshold;
      if (hit) {
        blocked.push(r.id);
        violations.push(`${r.id}: ${r.message}`);
      }
    }
    // 训练数据记录（开关开时；error 路径不记）：state 全量 ＋ 问句 ＋ 原始概率 ＋ 判定。
    // 记录失败静默吞下，绝不阻断派单（fail-open，红线三）。
    if (opts.trainingLog) {
      const write: TrainingWriter = opts.writeTraining ?? writeTrainingLine;
      try {
        write(
          dispatchTrainingLine({
            agent,
            state,
            questions: trainingQuestions,
            probs,
            verdict: v.verdict === "violation" ? "violation" : "pass",
            blocked,
          })
        );
      } catch {
        /* 记录失败绝不阻断派单 */
      }
    }
    return {
      line: auditLine({
        agent,
        task,
        model: res.model,
        rules: v.rules,
        verdict: v.verdict,
        latencyMs: Date.now() - start,
        blocked,
        probs: opts.auditProbabilities ? probs : undefined,
        // warn 观察模式：仅确有违规之行落 action 键；block 模式（含缺省）与放行/错误行永不落（形状不变）
        ...(opts.mode === "warn" && blocked.length > 0 ? { action: "warn" as const } : {}),
        ...(routed && meta
          ? {
              upstream: meta.upstream,
              failover: meta.attempts, // 空数组由 auditLine 略去（单端点链保底成功即无 failover 数组）
              ...(meta.fallback ? { fallback: true } : {}),
            }
          : {}),
      }),
      violations,
    };
  } catch (err) {
    const error =
      err instanceof JevError ? `${err.kind}: ${err.message}` : `unexpected: ${String(err)}`;
    // 全链败尽之错误行携带历次尝试（无胜者，故无 upstream 键）
    const failoverAttempts =
      err instanceof JevError && err.failoverAttempts && err.failoverAttempts.length > 0
        ? err.failoverAttempts
        : undefined;
    return {
      line: auditLine({
        agent,
        task,
        model: null,
        rules: null,
        verdict: "error",
        latencyMs: Date.now() - start,
        error,
        ...(failoverAttempts ? { failover: failoverAttempts } : {}),
      }),
      violations: [],
    };
  }
}
