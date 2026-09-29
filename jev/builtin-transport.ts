// JEV 内建传输（v0.10.0）：经 pi 内建 classifier 平台（ctx.modelRegistry.classify）对 state 求值一批
// 类型化问句，作为自管 curl 链（jev/client.ts ask）之可选替代（_global.transport === "builtin" 时启用）。
// 本模块纯逻辑：classifyFn 由调用方注入、链路条目已由调用方（扩展壳）解析为 {name, model} 传入——
// 不 import pi、不触 IO、不发真实请求，可测（jev/builtin-transport.test.ts 以 fake classifyFn 覆盖）。
//
// 链路语义（与 jev/client.ts ask 之 failover 同族，唯失败判据不同）：
//   - 按配置原序逐级尝试，每级恰一次请求；
//   - 每次尝试皆携 { maxRetries: 0 }（pi 侧 classifySystemOne 以 options.maxRetries ?? 2 传入
//     retryProviderRequest，0 即单发）——红线②：同一 POST 绝不重发、不退避不睡眠；
//   - 级败判据：classifyFn 抛异常、stopReason 非 "stop"（error/aborted）、答案缺失或非法
//     （请求中任一问句无答案，或任一答案归一后缺字段/非有限数）→ 切下一级；
//   - 未解析成模型之条目（model 为 null/undefined）为预败尝试：不发请求（kind:"error"、ms:0）；
//   - 全链败尽抛 JevError（kind:"upstream"，failoverAttempts 携历次尝试），由 checkDispatch 捕获
//     落 error 行放行——红线③ fail-open，绝不阻断派单。
// 成功结果形状与 jev/client.ts ask() 一致（SystemOneResult），并经 setAskMeta 附传输 meta：
//   upstream＝胜出条目名（"<provider>/<model>"）、attempts＝胜者之前之历次失败——
//   首级即成则 attempts 为空，audit 行与 selfhost 首级成功逐字节相同（upstream/failover 键皆不落）。
//
// 三型问句之形状映射（pi-ai classifier 线级形状 ≠ 我方自管链形状，双向皆映，见 pi-ai types.d.ts）：
//   出站：noul→bool（instructions/criteria 原样随行）；choice 之 options（＋每选项 criteria 判据）
//   映为 pi 之 criteria: Record<string,string>——pi 之 choice 无独立 options 槽位，criteria 键即
//   选项 id（答案概率按键分布，pi 内建 jev/auto 同款用法）；score 之 levels 映为 pi 之
//   criteria: string[]（按档位序之刻度描述）。描述缺省（null/空白）以键本身充当，保选项集完整。
//   入站：bool 答案 {type:"bool", probability} 映回我方 {noul: probability}（checkDispatch 读
//   answers[id].noul 之约定不受影响）；choice/score 答案由 pi 之平铺形状归一为我方嵌套契约
//   {choice:{value,probabilities,confidence}} / {score:{value,probabilities,confidence}}（与自管链
//   裸响应同形；pi 之 score 答案无 probabilities，以空表充当）；usage 由 pi 之 {input,output,…}
//   映为我方 {input_tokens,output_tokens}（与自管链 usage 同形）。任一答案缺字段/非法 → 整批无效。
// signal：params.signal（有则）随 options 透传 classifyFn（jev_ask 之取消信号；派单拦截无信号）。
// model 字段：成功结果之 model 记胜出条目名（"<provider>/<model>"），自辨链路级次。
// model 参数：接受但忽略——链路条目各用自身已解析模型（selfhost 链「显式 model 参覆首级」之例
// 不适用于内建链；jev_ask 之 model 参数于 builtin 模式下无效）。
import {
  JevError,
  setAskMeta,
  type Answer,
  type AskParams,
  type Question,
  type SystemOneResult,
  type Usage,
} from "./client.ts";
import type { AttemptRecord } from "./failover.ts";

/** pi classify 之结果最小面（结构类型，不 import pi-ai）：classify 永不 reject，错误在 stopReason/errorMessage。 */
export type BuiltinClassifyResult = {
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  answers: Record<string, unknown>;
  model?: string;
  usage?: unknown;
};

/** 传给 classifyFn 之 options 最小面：红线②之 maxRetries: 0 恒携；signal 有则透传。 */
export type BuiltinClassifyOptions = { maxRetries?: number; signal?: AbortSignal };

/** classifyFn 注入面：model 为已解析之 pi classifier 模型对象（本模块不触其形状，恒真值——假值条目不达此）。 */
export type BuiltinClassifyFn = (
  model: unknown,
  context: { state: unknown; questions: Record<string, unknown> },
  options?: BuiltinClassifyOptions
) => Promise<BuiltinClassifyResult>;

/** 链路条目：name 供尝试记录与 audit（形如 "<provider>/<model>"）；model 为已解析模型对象，未解析为 null。 */
export type BuiltinChainEntry = { name: string; model: unknown };

export type BuiltinAskParams = Pick<AskParams, "state" | "questions" | "model"> & {
  /** 取消信号（有则随 options 透传 classifyFn；派单拦截路径无信号、不传）。 */
  signal?: AbortSignal;
};
export type BuiltinAskFn = (params: BuiltinAskParams) => Promise<SystemOneResult>;

/**
 * 选项/档位之 pi criteria 文本拼装：描述（可 null/空白）与我方 criteria 判据（有则）并作一句；
 * 皆缺以键本身充当（保选项集/档位集完整——pi 之 criteria 键即选项 id）。
 */
function criteriaText(key: string, desc: unknown, extra: unknown): string {
  const parts = [desc, extra].filter((s): s is string => typeof s === "string" && s.trim() !== "");
  return parts.length > 0 ? parts.join("；") : key;
}

/** 出站问句映射：noul→bool（instructions/criteria 原样随行）；choice/score 映为 pi 之 criteria 形状（见档头）。 */
function toWireQuestions(questions: Record<string, Question>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      out[id] = {
        type: "bool",
        instructions: q.instructions,
        ...(q.criteria ? { criteria: q.criteria } : {}),
      };
    } else if (q.type === "choice") {
      const criteria: Record<string, string> = {};
      for (const [key, desc] of Object.entries(q.options)) {
        criteria[key] = criteriaText(key, desc, q.criteria?.[key]);
      }
      out[id] = { type: "choice", instructions: q.instructions, criteria };
    } else {
      const criteria = Object.entries(q.levels).map(([key, desc]) =>
        criteriaText(key, desc, q.criteria?.[key])
      );
      out[id] = { type: "score", instructions: q.instructions, criteria };
    }
  }
  return out;
}

/** 概率表守卫：对象且每个值皆为有限数（与 pi 侧 parseAnswers 之判据同；空表亦许）。 */
function isProbabilityRecord(v: unknown): v is Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n));
}

/** usage 映射：pi 之 {input, output, …} → 我方 Usage {input_tokens, output_tokens}（与自管链同形，
 *  仅取二有限数键，pi 其余字段——cacheRead/cacheWrite/totalTokens/cost——不随行）；缺失/非法 → {}。 */
function fromWireUsage(raw: unknown): Usage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const u = raw as Record<string, unknown>;
  const out: Usage = {};
  if (typeof u.input === "number" && Number.isFinite(u.input)) out.input_tokens = u.input;
  if (typeof u.output === "number" && Number.isFinite(u.output)) out.output_tokens = u.output;
  return out;
}

/**
 * 入站答案映射＋整批校验（请求中每个问句 id 必须有答案，缺一即整批无效 → 该尝试按失败计）：
 * noul 问取 bool 答案之 probability（必为有限数）映为 {noul}；choice/score 答案由 pi 之平铺形状
 * 归一为我方嵌套契约（type/主字段/probabilities（score 以空表充当）/confidence 缺一即整批无效）。
 * 无效返 undefined。
 */
function fromWireAnswers(
  raw: unknown,
  questions: Record<string, Question>
): Record<string, Answer> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = src[id];
    if (!a || typeof a !== "object" || Array.isArray(a)) return undefined;
    const o = a as Record<string, unknown>;
    if (q.type === "noul") {
      if (typeof o.probability !== "number" || !Number.isFinite(o.probability)) return undefined;
      out[id] = { noul: o.probability };
    } else if (q.type === "choice") {
      // pi 平铺 {type:"choice", choice, probabilities, confidence} → 我方 {choice:{value,…}}
      if (o.type !== "choice" || typeof o.choice !== "string") return undefined;
      if (!isProbabilityRecord(o.probabilities)) return undefined;
      if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence)) return undefined;
      const choice = o.choice;
      const probabilities = o.probabilities;
      const confidence = o.confidence;
      out[id] = { choice: { value: choice, probabilities, confidence } };
    } else {
      // pi 平铺 {type:"score", score, confidence}（pi 不产出 probabilities）→
      // 我方 {score:{value,…}}，probabilities 以空表充当（我方契约有此槽位）
      if (o.type !== "score" || typeof o.score !== "number" || !Number.isFinite(o.score))
        return undefined;
      if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence)) return undefined;
      const score = o.score;
      const confidence = o.confidence;
      out[id] = { score: { value: score, probabilities: {}, confidence } };
    }
  }
  return out;
}

/**
 * 内建 askFn 工厂：链路条目按序尝试（每级一发、maxRetries:0、败即切下一级），
 * 成功结果附传输 meta（upstream/attempts），全链败尽抛 JevError（failoverAttempts）。
 * 链路语义、三型问句之形状映射、model 字段与 model 参数之约定见档头。
 */
export function createBuiltinAsk(
  classifyFn: BuiltinClassifyFn,
  chain: readonly BuiltinChainEntry[]
): BuiltinAskFn {
  return async function ask(params: BuiltinAskParams): Promise<SystemOneResult> {
    const { state, questions, signal } = params; // model 参数接受但忽略（见档头）；signal 有则透传
    const wireQuestions = toWireQuestions(questions);
    const attempts: AttemptRecord[] = [];
    let lastMessage = "builtin chain is empty";
    for (const entry of chain) {
      if (!entry.model) {
        // 未能解析成 classifier 模型之条目：预败尝试（零请求、零时延——绝不给同一 POST 第二发）
        attempts.push({ name: entry.name, kind: "error", ms: 0 });
        lastMessage = "chain entry did not resolve to a classifier model";
        continue;
      }
      const t0 = Date.now();
      let res: BuiltinClassifyResult;
      try {
        res = await classifyFn(
          entry.model,
          { state, questions: wireQuestions },
          { maxRetries: 0, ...(signal ? { signal } : {}) }
        );
      } catch (err) {
        // classify 契约永不 reject；万一 reject 亦按失败尝试记（切下一级，fail-open）
        attempts.push({ name: entry.name, kind: "error", ms: Date.now() - t0 });
        lastMessage = err instanceof Error ? err.message : String(err);
        continue;
      }
      const answers =
        res && res.stopReason === "stop" ? fromWireAnswers(res.answers, questions) : undefined;
      if (answers) {
        const out: SystemOneResult = {
          model: entry.name,
          answers,
          usage: fromWireUsage(res.usage),
        };
        setAskMeta(out, { upstream: entry.name, attempts: [...attempts] });
        return out;
      }
      attempts.push({ name: entry.name, kind: "error", ms: Date.now() - t0 });
      lastMessage =
        res?.errorMessage || (res ? `stopReason ${res.stopReason}` : "no result from classifyFn");
    }
    throw new JevError("upstream", `builtin classifier chain exhausted: ${lastMessage}`, {
      failoverAttempts: attempts,
    });
  };
}
