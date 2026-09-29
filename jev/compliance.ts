// JEV 派发合规审计：纯逻辑层（除 loadRuleSets 读配置档外不触 IO，可测）。
// 对命中规则集的 subagent 派单，把任务原文打包为 state，向 System One 一次性求值一批 noul 问：
// 审计侧按阈值矩阵出 verdict 落 audit.jsonl；拦截侧按每规则之 blockWhen/threshold 判命中，
// 命中则把该规则 message 收进 violations，由调用方（扩展壳）据此 block 派单。
// 规则全由配置驱动（v0.7.0 起内建规则全废，配置档为唯一来源）：规则 id 为任意字符串，
// 每规则自带 blockWhen（below/above）与 threshold，verdict 标签与拦截判定均按配置计算，无硬编码规则 id。
// 另有 `_all` 全局规则组：凡派单皆受查（含无专属组之 agent），与 agent 专属组并成一次请求，
// id 冲突时 agent 规则整条胜出（静默，全局 id 按约定 G 前缀，代码不强制）。
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
 * 有效规则（载入侧形状，与旧版逐字相同）：`instructions`/`criteria` 或来自规则内联字段，
 * 或来自其 `question` 所引之顶层问句库 `_questions`（载入时即展开，故消费方无须知道引用之存在）。
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

export type AgentRuleSet = { agentDesc: string; rules: RuleConfig[] };

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
};

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
  return line;
}

/**
 * 配置档中单个规则条目：字段皆可覆盖；instructions 亦以配置档为准，内建仅作缺省。
 * `question` 为问句库编号之引用（可选）：可解析则以库中 instructions/criteria 为准，
 * 忽略本规则内联之两者；悬空则回退本规则内联字段。
 */
type RawRule = {
  id?: unknown;
  question?: unknown;
  instructions?: unknown;
  criteria?: unknown;
  blockWhen?: unknown;
  threshold?: unknown;
  message?: unknown;
};

/** 问句库单条（_questions 之值）：label 仅供人读，一概忽略。 */
type RawQuestion = { instructions?: unknown; criteria?: unknown; label?: unknown };

/** 问句展开后之有效问句：语义同规则内联之 instructions/criteria。 */
type Question = { instructions?: string; criteria?: { true?: string; false?: string } };

type RawRuleSet = { agentDesc?: unknown; rules?: unknown };

/** loadRuleSets 返回：配置档解析后之 agent 规则组 ＋ `_all` 全局规则组 ＋ 全局开关。 */
export type LoadedRules = {
  agents: Record<string, AgentRuleSet>;
  /** `_all` 全局规则组：顶层无此键 / 值非法 / 无可解析规则 → null（fail-open，静默） */
  all: AgentRuleSet | null;
  global: { auditProbabilities: boolean; trainingLog: boolean };
};

/** 配置档顶层保留键：全局开关，不视作 agent 名。 */
const GLOBAL_KEY = "_global";

/** 配置档顶层保留键：共享问句库（规则以 question 引用其编号），不视作 agent 名。 */
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
 * 问句库解析（fail-open）：库非对象或为数组、条目非对象、instructions 非字符串、criteria 非法
 * 皆静默弃之，绝不致使整档解析失败。完全空白（既无 instructions 亦无 criteria）之条目亦弃。
 * label 一概忽略（可存不可用）。
 */
function parseQuestions(v: unknown): Map<string, Question> {
  const out = new Map<string, Question>();
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as RawQuestion;
    const q: Question = {};
    if (typeof o.instructions === "string") q.instructions = o.instructions;
    const c = parseCriteria(o.criteria);
    if (c) q.criteria = c;
    if (q.instructions === undefined && q.criteria === undefined) continue;
    out.set(key, q);
  }
  return out;
}

/**
 * 单个规则组（agent 专属组或 `_all`）之规则数组解析（fail-open）：
 * 非法条目（缺 id/非对象）静默弃之；同 id 后条覆盖前条之已给字段；
 * question 引用于此展开（可解析以库为准，悬空回退内联字段，再无则 instructions 空 → 检查时跳过）。
 * 组整体非对象（含数组、字符串）→ 空数组（静默，绝不抛）。
 */
function parseRuleList(cfg: unknown, questions: Map<string, Question>): RuleConfig[] {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return [];
  const order: RuleId[] = [];
  const byId = new Map<RuleId, RuleConfig>();
  const refById = new Map<RuleId, string>();
  const list: RawRule[] = Array.isArray((cfg as RawRuleSet).rules)
    ? ((cfg as RawRuleSet).rules as RawRule[])
    : [];
  for (const item of list) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
    const id = item.id as RuleId;
    const prev = byId.get(id);
    const next: RuleConfig = {
      id,
      instructions:
        typeof item.instructions === "string" ? item.instructions : prev?.instructions ?? "",
      criteria: parseCriteria(item.criteria) ?? prev?.criteria,
      blockWhen:
        item.blockWhen === "below" || item.blockWhen === "above"
          ? item.blockWhen
          : prev?.blockWhen ?? "below",
      threshold: typeof item.threshold === "number" ? item.threshold : prev?.threshold ?? 0.7,
      message:
        typeof item.message === "string" ? item.message : prev?.message ?? `规则 ${id} 未通过`,
    };
    if (typeof item.question === "string") refById.set(id, item.question);
    else refById.delete(id);
    if (!byId.has(id)) order.push(id);
    byId.set(id, next);
  }
  // 问句展开（同组内解析后进行：仅给 question 之规则以库中内容为准，不被组内他条回填）
  for (const [id, qid] of refById) {
    const q = questions.get(qid);
    if (!q) continue; // 编号悬空/库中无此项 → 回退该规则内联字段
    const rule = byId.get(id);
    if (!rule) continue;
    rule.instructions = q.instructions ?? "";
    if (q.criteria) rule.criteria = q.criteria;
    else delete rule.criteria;
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * 读配置档（v0.7.0 起配置档为规则之唯一来源，无任何内建缺省）：
 * 每个非保留键之顶层条目解析为一个 agent 规则组（agentDesc 取其字符串值，缺省空串；
 * 规则字段缺省：blockWhen below / threshold 0.7 / message `规则 <id> 未通过` / instructions 空）。
 * `_global: { auditProbabilities, trainingLog }` 为全局开关（皆缺省 false）。
 * `_questions` 为顶层共享问句库：规则给 `question` 且编号可解析者，以库中 instructions/criteria
 * 为准并忽略该规则内联之两者；编号悬空或库中无此项则回退内联字段，再无则 instructions 空 →
 * 检查时跳过（fail-open）。同文之条引同一编号，改则一处生效。
 * `_all` 为全局规则组：凡派单皆受查（含无专属组之 agent，其 state 述语写死 "a sub-agent"），
 * 与 agent 专属组并成一次请求，id 冲突时 agent 规则整条胜出；其 agentDesc 不读（恒不生效）。
 * 任何读取/解析错误、以及 `_all`/组/条目之非法形状 → 静默弃之（fail-open），绝不抛：
 * 档缺失/坏 JSON → agents 空且 all 为 null → 所有派单放行。
 */
export function loadRuleSets(path: string): LoadedRules {
  const fallback = (): LoadedRules => ({
    agents: RULE_SETS, // v0.7.0 起恒为空对象（内建已废）
    all: null,
    global: { auditProbabilities: false, trainingLog: false },
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
  const questions = parseQuestions((raw as Record<string, unknown>)[QUESTIONS_KEY]);
  const merged: Record<string, AgentRuleSet> = {};
  for (const [agent, cfg] of Object.entries(raw)) {
    if (agent === GLOBAL_KEY || agent === QUESTIONS_KEY || agent === ALL_KEY) continue;
    if (!cfg || typeof cfg !== "object") continue;
    merged[agent] = {
      agentDesc: typeof (cfg as RawRuleSet).agentDesc === "string" ? (cfg as RawRuleSet).agentDesc as string : "",
      rules: parseRuleList(cfg, questions),
    };
  }
  // `_all` 全局规则组：值非法（字符串/数组等）→ parseRuleList 返空 → 视为无（null）
  const allRules = parseRuleList((raw as Record<string, unknown>)[ALL_KEY], questions);
  return {
    agents: merged,
    all: allRules.length > 0 ? { agentDesc: "", rules: allRules } : null,
    global: { auditProbabilities, trainingLog },
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
 * 主流程：agent 无专属组且无 `_all` 全局规则 → null；有则取有效规则（全局在前、agent 组在后，
 * id 冲突时 agent 规则整条顶替全局规则；instructions 为空/空白者跳过，全部无效亦返 null；
 * 无专属组之 agent 其 agentDesc 写死 "a sub-agent"，`_all.agentDesc` 不读），
 * buildState ＋ noul 问打包一次请求 ＋ verdict ＋ 逐规则拦截判定 ＋ auditLine。
 * 拦截判定：(blockWhen==="below" && p < threshold) || (blockWhen==="above" && p > threshold)，
 * 命中者以 `${id}: ${message}` 全列入 violations，规则 id 全列入 line.blocked。
 * noul 字段缺失或非有限数：该规则标 unknown、不拦（fail-open，红线三）。
 * opts.auditProbabilities 为 true 时审计行附 probs（规则 id → 原始概率，仅有限值）。
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
     *  id 冲突时 agent 规则整条胜出、全局规则弃之（静默，无 error 无 audit 注记） */
    allRules?: AgentRuleSet;
    auditProbabilities?: boolean;
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
  // 有效规则 = 全局规则（`_all` 序，被 agent 同 id 规则顶替者弃之）＋ agent 组规则（组内序）；
  // 约定 id 组内唯一（questions map 以规则 id 为键），同 id 冲突由 agent 规则静默胜出
  const agentIds = new Set((rs?.rules ?? []).map((r) => r.id));
  const combined = [...globalRules.filter((r) => !agentIds.has(r.id)), ...(rs?.rules ?? [])];
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
