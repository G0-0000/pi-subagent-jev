// JEV 派发合规审计：纯逻辑层（除 loadRuleSets 读配置档外不触 IO，可测）。
// 对命中规则集的 subagent 派单，把任务原文打包为 state，向 System One 一次性求值四问：
// 审计侧按阈值矩阵出 verdict 落 audit.jsonl；拦截侧按每规则之 blockWhen/threshold 判命中，
// 命中则把该规则 message 收进 violations，由调用方（扩展壳）据此 block 派单。
// R1/R2 为正例规则（below：p 低于阈值即拦），R3/R4 为反例规则（above：p 高于阈值即拦）。
// 任何错误 fail-open：JEV 出错、配置档出错、概率缺失皆放行，绝不外抛。
import { ask as defaultAsk, JevError, type AskParams, type SystemOneResult } from "./client.ts";
import { readFileSync } from "node:fs";

export type RuleId = "R1" | "R2" | "R3" | "R4";

export type RuleConfig = {
  id: RuleId;
  instructions: string;
  /** 拦截方向："below"=p 低于阈值即拦（正例规则）；"above"=p 高于阈值即拦（反例规则） */
  blockWhen: "below" | "above";
  threshold: number; // 0..1
  message: string; // 命中拦截时返给主 agent 的人话
};

export type AgentRuleSet = { agentDesc: string; rules: RuleConfig[] };

/** 各 agent 的审计规则集。R1/R2 为正例规则（应真），R3/R4 为反例规则（应假）。 */
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

export type RuleLabel = "pass" | "fail" | "suspect" | "violation" | "clean";
export type OverallVerdict = "compliant" | "suspect" | "violation" | "error";

export type VerdictResult = {
  rules: Record<RuleId, RuleLabel>;
  verdict: OverallVerdict;
};

/**
 * 阈值矩阵（仅供审计记录，不参与拦截判定）：
 * 正例规则 R1/R2：p ≥ 0.7 → pass，p ≤ 0.3 → fail，余 suspect。
 * 反例规则 R3/R4：p ≥ 0.7 → violation，p ≤ 0.3 → clean，余 suspect。
 * 综合：任一 fail/violation → violation；否则任一 suspect → suspect；否则 compliant。
 */
export function verdict(probs: Record<RuleId, number>): VerdictResult {
  const rules = {} as Record<RuleId, RuleLabel>;
  const positive: RuleId[] = ["R1", "R2"];
  const negative: RuleId[] = ["R3", "R4"];
  for (const id of positive) {
    const p = probs[id];
    rules[id] = p >= 0.7 ? "pass" : p <= 0.3 ? "fail" : "suspect";
  }
  for (const id of negative) {
    const p = probs[id];
    rules[id] = p >= 0.7 ? "violation" : p <= 0.3 ? "clean" : "suspect";
  }
  let overall: OverallVerdict;
  if (positive.concat(negative).some((id) => rules[id] === "fail" || rules[id] === "violation")) {
    overall = "violation";
  } else if (positive.concat(negative).some((id) => rules[id] === "suspect")) {
    overall = "suspect";
  } else {
    overall = "compliant";
  }
  return { rules, verdict: overall };
}

export type AuditLineFields = {
  ts?: string;
  agent: string;
  task: string;
  model?: string | null;
  rules?: Record<RuleId, RuleLabel> | null;
  verdict: OverallVerdict;
  latencyMs: number;
  blocked?: string[];
  error?: string;
};

export type AuditLine = {
  ts: string;
  agent: string;
  task_excerpt: string;
  model: string | null;
  rules: Record<RuleId, RuleLabel> | null;
  verdict: OverallVerdict;
  latency_ms: number;
  blocked?: string[];
  error?: string;
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
  if (fields.error !== undefined) line.error = fields.error;
  return line;
}

/** 配置档中单个规则条目：只需给可调项，instructions 以内建为准。 */
type RawRule = {
  id?: unknown;
  instructions?: unknown;
  blockWhen?: unknown;
  threshold?: unknown;
  message?: unknown;
};

type RawRuleSet = { agentDesc?: unknown; rules?: unknown };

/**
 * 读配置档并按 agent→rule id 合并覆盖内建 RULE_SETS：
 * 已知 agent 之已知规则按字段覆盖（instructions 始终以内建为准），JSON 中新 id 追加其后；
 * JSON 中未知 agent 整组加入。任何读取/解析错误 → 静默返内建默认（fail-open）。
 */
export function loadRuleSets(path: string): Record<string, AgentRuleSet> {
  let raw: Record<string, RawRuleSet>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return RULE_SETS;
    raw = parsed as Record<string, RawRuleSet>;
  } catch {
    return RULE_SETS;
  }
  const merged: Record<string, AgentRuleSet> = {};
  for (const [agent, rs] of Object.entries(RULE_SETS)) {
    merged[agent] = { agentDesc: rs.agentDesc, rules: rs.rules.map((r) => ({ ...r })) };
  }
  for (const [agent, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== "object") continue;
    const base = merged[agent];
    const order: RuleId[] = [];
    const byId = new Map<RuleId, RuleConfig>();
    for (const r of base?.rules ?? []) {
      order.push(r.id);
      byId.set(r.id, { ...r });
    }
    const list: RawRule[] = Array.isArray(cfg.rules) ? (cfg.rules as RawRule[]) : [];
    for (const item of list) {
      if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
      const id = item.id as RuleId;
      const prev = byId.get(id);
      const next: RuleConfig = {
        id,
        instructions:
          prev?.instructions ?? (typeof item.instructions === "string" ? item.instructions : ""),
        blockWhen:
          item.blockWhen === "below" || item.blockWhen === "above"
            ? item.blockWhen
            : prev?.blockWhen ?? "below",
        threshold: typeof item.threshold === "number" ? item.threshold : prev?.threshold ?? 0.7,
        message:
          typeof item.message === "string" ? item.message : prev?.message ?? `规则 ${id} 未通过`,
      };
      if (!byId.has(id)) order.push(id);
      byId.set(id, next);
    }
    merged[agent] = {
      agentDesc: typeof cfg.agentDesc === "string" ? cfg.agentDesc : base?.agentDesc ?? "",
      rules: order.map((id) => byId.get(id)!),
    };
  }
  return merged;
}

export type AskFn = (params: AskParams) => Promise<SystemOneResult>;

export type CheckResult = { line: AuditLine; violations: string[] };

/**
 * 主流程：agent 不在规则集 → null；
 * 在则 buildState ＋四问（noul）打包一次请求 ＋ verdict ＋ 逐规则拦截判定 ＋ auditLine。
 * 拦截判定：(blockWhen==="below" && p < threshold) || (blockWhen==="above" && p > threshold)，
 * 命中者以 `${id}: ${message}` 全列入 violations，规则 id 全列入 line.blocked。
 * JevError（及任何异常）捕获 → 返 error 行且 violations 为空，fail-open，绝不外抛。
 */
export async function checkDispatch(
  agent: string,
  task: string,
  opts: { askFn?: AskFn; ruleSets?: Record<string, AgentRuleSet> } = {}
): Promise<CheckResult | null> {
  const ruleSets = opts.ruleSets ?? RULE_SETS;
  const rs = ruleSets[agent];
  if (!rs) return null;
  const askFn = opts.askFn ?? defaultAsk;
  const start = Date.now();
  try {
    const questions = Object.fromEntries(
      rs.rules.map((r) => [r.id, { type: "noul" as const, instructions: r.instructions }])
    );
    const res = await askFn({
      state: buildState(agent, rs.agentDesc, task),
      questions,
    });
    const answers = res.answers as Record<string, { noul: number }>;
    const probs = Object.fromEntries(
      rs.rules.map((r) => [r.id, Number(answers[r.id]?.noul ?? 0)])
    ) as Record<RuleId, number>;
    const v = verdict(probs);
    const blocked: string[] = [];
    const violations: string[] = [];
    for (const r of rs.rules) {
      const p = probs[r.id];
      if (!Number.isFinite(p)) continue; // 概率缺失：该规则不拦（fail-open）
      const hit = r.blockWhen === "below" ? p < r.threshold : p > r.threshold;
      if (hit) {
        blocked.push(r.id);
        violations.push(`${r.id}: ${r.message}`);
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
      }),
      violations,
    };
  } catch (err) {
    const error =
      err instanceof JevError ? `${err.kind}: ${err.message}` : `unexpected: ${String(err)}`;
    return {
      line: auditLine({
        agent,
        task,
        model: null,
        rules: null,
        verdict: "error",
        latencyMs: Date.now() - start,
        error,
      }),
      violations: [],
    };
  }
}
