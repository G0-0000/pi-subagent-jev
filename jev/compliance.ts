// JEV 派发合规审计：纯逻辑层（除 loadRuleSets 读配置档外不触 IO，可测）。
// 对命中规则集的 subagent 派单，把任务原文打包为 state，向 System One 一次性求值四问：
// 审计侧按阈值矩阵出 verdict 落 audit.jsonl；拦截侧按每规则之 blockWhen/threshold 判命中，
// 命中则把该规则 message 收进 violations，由调用方（扩展壳）据此 block 派单。
// 规则全由配置驱动：规则 id 为任意字符串，每规则自带 blockWhen（below/above）与 threshold，
// verdict 标签与拦截判定均按配置计算，无硬编码规则 id。
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

/** 规则 id：任意字符串（R1-R4 仅为内建默认，配置档可自定义新 id）。 */
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

/** 内建默认规则集（仅作配置档之缺省；可被配置档覆盖或扩展新 agent/新规则）。 */
export const RULE_SETS: Record<string, AgentRuleSet> = {
  delegate: {
    agentDesc: "a file-editing agent without shell access",
    rules: [
      {
        id: "R1",
        instructions:
          "Does the task give at least one concrete, explicit file path to create or modify?",
        blockWhen: "below",
        threshold: 0.7,
        message: "任务未给出具体文件路径",
      },
      {
        id: "R2",
        instructions:
          "Does the task provide the definite content or exact edits to apply, so the agent need not draft wording itself nor explore to fill gaps?",
        blockWhen: "below",
        threshold: 0.7,
        message: "任务无确定内容",
      },
      {
        id: "R3",
        instructions:
          "Does the task require the agent to execute shell commands, run builds, tests, scripts, or restart or verify services?",
        blockWhen: "above",
        threshold: 0.8,
        message: "任务要求执行 shell 命令/构建测试，delegate 无 bash 权限",
      },
      {
        id: "R4",
        instructions:
          "Does the task require the agent to investigate, explore, or look up information that is not contained in the task itself?",
        blockWhen: "above",
        threshold: 0.8,
        message: "任务要求 agent 自行探索查资料",
      },
    ],
  },
};

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

/** loadRuleSets 返回：合并后规则集 ＋ 全局开关。 */
export type LoadedRules = {
  agents: Record<string, AgentRuleSet>;
  global: { auditProbabilities: boolean; trainingLog: boolean };
};

/** 配置档顶层保留键：全局开关，不视作 agent 名。 */
const GLOBAL_KEY = "_global";

/** 配置档顶层保留键：共享问句库（规则以 question 引用其编号），不视作 agent 名。 */
const QUESTIONS_KEY = "_questions";

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
 * 读配置档并按 agent→rule id 合并覆盖内建 RULE_SETS：
 * 已知 agent 之已知规则按字段覆盖（instructions 亦以配置档为准，内建仅作缺省），
 * JSON 中新 id 追加其后；JSON 中未知 agent 整组加入。
 * `_global: { auditProbabilities }` 为全局开关（缺省 false），控制审计行是否附 probs。
 * `_global: { trainingLog }` 为训练数据记录开关（缺省 false），控制是否追加 training.jsonl。
 * `_questions` 为顶层共享问句库（同 `_global` 不视作 agent 名）：规则给 `question` 且编号可解析者，
 * 以库中 instructions/criteria 为准并忽略该规则内联之两者；编号悬空或库中无此项则回退内联字段，
 * 再无则 instructions 为空 → 检查时跳过（fail-open）。同文之条引同一编号，改则一处生效。
 * 任何读取/解析错误 → 静默返内建默认（fail-open）。
 */
export function loadRuleSets(path: string): LoadedRules {
  const fallback = (): LoadedRules => ({
    agents: RULE_SETS,
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
  for (const [agent, rs] of Object.entries(RULE_SETS)) {
    merged[agent] = { agentDesc: rs.agentDesc, rules: rs.rules.map((r) => ({ ...r })) };
  }
  for (const [agent, cfg] of Object.entries(raw)) {
    if (agent === GLOBAL_KEY || agent === QUESTIONS_KEY) continue;
    if (!cfg || typeof cfg !== "object") continue;
    const base = merged[agent];
    const order: RuleId[] = [];
    const byId = new Map<RuleId, RuleConfig>();
    for (const r of base?.rules ?? []) {
      order.push(r.id);
      byId.set(r.id, { ...r });
    }
    const list: RawRule[] = Array.isArray(cfg.rules) ? (cfg.rules as RawRule[]) : [];
    // 该 agent 内规则之 question 引用：同一 id 之后续条目若未再给 question 即视为解除引用
    const refById = new Map<RuleId, string>();
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
    // 问句展开（须在合并之后：仅给 question 之规则不得被内建 instructions/criteria 回填至生效）
    for (const [id, qid] of refById) {
      const q = questions.get(qid);
      if (!q) continue; // 编号悬空/库中无此项 → 回退该规则内联（或内建缺省）字段
      const rule = byId.get(id);
      if (!rule) continue;
      rule.instructions = q.instructions ?? "";
      if (q.criteria) rule.criteria = q.criteria;
      else delete rule.criteria;
    }
    merged[agent] = {
      agentDesc: typeof cfg.agentDesc === "string" ? cfg.agentDesc : base?.agentDesc ?? "",
      rules: order.map((id) => byId.get(id)!),
    };
  }
  return { agents: merged, global: { auditProbabilities, trainingLog } };
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
 * 主流程：agent 不在规则集 → null；在则取该 agent 有效规则（instructions 为空/空白者跳过，
 * 全部无效亦返 null），buildState ＋ noul 问打包一次请求 ＋ verdict ＋ 逐规则拦截判定 ＋ auditLine。
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
    auditProbabilities?: boolean;
    /** 训练数据记录开关（缺省 false，不记） */
    trainingLog?: boolean;
    /** 训练行写入器（缺省 writeTrainingLine 落 training.jsonl；测试可注入 mock） */
    writeTraining?: TrainingWriter;
  } = {}
): Promise<CheckResult | null> {
  const ruleSets = opts.ruleSets ?? RULE_SETS;
  const rs = ruleSets[agent];
  if (!rs) return null;
  // instructions 为空/空白的规则无可问之题，检查时跳过（fail-open）
  const rules = rs.rules.filter(
    (r) => typeof r.instructions === "string" && r.instructions.trim() !== ""
  );
  if (rules.length === 0) return null;
  const askFn: AskFn =
    opts.askFn ??
    ((p) =>
      defaultAsk({
        ...p,
        failover: getFailover(),
        tracker: getTracker(),
      }));
  const start = Date.now();
  const state = buildState(agent, rs.agentDesc, task);
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
