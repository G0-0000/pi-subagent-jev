// builtin-transport.ts 单测：注入 fake classifyFn，全走本地假件，不发任何真实请求。
// 覆盖：单级成功与 meta、noul→bool 出站映射、choice options→criteria 与 score levels→criteria 出站映射、
// bool 答案映回 {noul}、choice/score 答案归一为我方嵌套契约、usage 映射（pi {input,output,…}→{input_tokens,output_tokens}）、
// maxRetries:0 恒透传与 signal 透传（红线②）、首败后切换、未解析条目预败、全败 JevError（failoverAttempts）、
// 空链即抛、stopReason stop 但答案缺失/非法按失败计、classifyFn 契约外抛异常按失败计。
import test from "node:test";
import assert from "node:assert/strict";
import {
  createBuiltinAsk,
  type BuiltinChainEntry,
  type BuiltinClassifyFn,
  type BuiltinClassifyResult,
} from "./builtin-transport.ts";
import { getAskMeta, JevError } from "./client.ts";

const QUESTIONS = {
  Q1: {
    type: "noul" as const,
    instructions: "Is the task concrete?",
    criteria: { true: "has a path", false: "vague" },
  },
  C1: {
    type: "choice" as const,
    instructions: "Pick one.",
    criteria: { a: "alpha" },
    options: { a: null },
  },
};

/** 各级成功之全量答案（Q1 noul ＋ C1 choice）。 */
const OK_ANSWERS = {
  Q1: { type: "bool", probability: 0.87 },
  C1: { type: "choice", choice: "a", probabilities: { a: 0.9 }, confidence: 0.8 },
};

/** fake classifyFn：按序弹出脚本步骤（结果或 Error），并记录每次调用的入参。 */
function fakeClassify(script: Array<BuiltinClassifyResult | Error>) {
  const calls: Array<{
    model: unknown;
    context: { state: unknown; questions: Record<string, unknown> };
    options: unknown;
  }> = [];
  const fn: BuiltinClassifyFn = async (model, context, options) => {
    calls.push({ model, context, options });
    const step = script.shift();
    if (!step) throw new Error("script exhausted");
    if (step instanceof Error) throw step;
    return step;
  };
  return { fn, calls };
}

test("① 单级成功：答案归一为我方契约（bool→{noul}、choice 平铺→嵌套）、usage 映射、model 记胜出条目名、meta.upstream 记胜者且 attempts 空", async () => {
  const { fn, calls } = fakeClassify([
    { stopReason: "stop", answers: OK_ANSWERS, usage: { input: 3, output: 1 } },
  ]);
  const ask = createBuiltinAsk(fn, [{ name: "typesafe/jev-latest", model: { id: "jev-latest" } }]);
  // model 参数接受但忽略（不出站、不影响行为）
  const res = await ask({ state: "STATE", questions: QUESTIONS, model: "oc/jev-1.13-free" });
  assert.deepEqual(res.answers.Q1, { noul: 0.87 });
  // choice 由 pi 之平铺形状归一为我方嵌套契约（形状同自管链裸响应）
  assert.deepEqual(res.answers.C1, {
    choice: { value: "a", probabilities: { a: 0.9 }, confidence: 0.8 },
  });
  assert.equal(res.model, "typesafe/jev-latest");
  assert.deepEqual(res.usage, { input_tokens: 3, output_tokens: 1 }); // pi usage → 我方 Usage
  const meta = getAskMeta(res);
  assert.ok(meta);
  assert.equal(meta!.upstream, "typesafe/jev-latest");
  assert.deepEqual(meta!.attempts, []);
  assert.equal(meta!.fallback, undefined); // 首级即成：无保底键（与 selfhost 首级成功同形）
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.context.state, "STATE");
  assert.deepEqual(calls[0]!.model, { id: "jev-latest" }); // 链路条目之已解析模型对象原样传入 classifyFn
  const q = calls[0]!.context.questions as Record<string, Record<string, unknown>>;
  assert.equal(q.Q1!.type, "bool"); // noul→bool
  assert.equal(q.Q1!.instructions, QUESTIONS.Q1.instructions);
  assert.deepEqual(q.Q1!.criteria, QUESTIONS.Q1.criteria);
  // choice 出站：options 映为 pi criteria（描述 null 以键本身充当；criteria 判据并入）
  assert.deepEqual(q.C1, { type: "choice", instructions: "Pick one.", criteria: { a: "alpha" } });
});

test("② maxRetries:0 恒透传（红线②：同一 POST 绝不重发）", async () => {
  const { fn, calls } = fakeClassify([
    { stopReason: "error", errorMessage: "Provider is not configured", answers: {} },
    { stopReason: "stop", answers: OK_ANSWERS },
  ]);
  const ask = createBuiltinAsk(fn, [
    { name: "opencode/jev-1.13-free", model: { id: "jev-1.13-free" } },
    { name: "typesafe/jev-latest", model: { id: "jev-latest" } },
  ]);
  await ask({ state: "S", questions: QUESTIONS });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.options, { maxRetries: 0 });
  assert.deepEqual(calls[1]!.options, { maxRetries: 0 });
});

test("③ 首败后切换：attempts 记首败 {name, kind:'error', ms}，meta.upstream 记胜者", async () => {
  const { fn, calls } = fakeClassify([
    { stopReason: "error", errorMessage: "boom", answers: {} },
    { stopReason: "stop", answers: { ...OK_ANSWERS, Q1: { type: "bool", probability: 0.2 } } },
  ]);
  const ask = createBuiltinAsk(fn, [
    { name: "a/one", model: { id: "one" } },
    { name: "b/two", model: { id: "two" } },
  ]);
  const res = await ask({ state: "S", questions: QUESTIONS });
  assert.equal(res.model, "b/two");
  assert.deepEqual(res.answers.Q1, { noul: 0.2 });
  const meta = getAskMeta(res)!;
  assert.equal(meta.upstream, "b/two");
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0]!.name, "a/one");
  assert.equal(meta.attempts[0]!.kind, "error");
  assert.ok(typeof meta.attempts[0]!.ms === "number" && meta.attempts[0]!.ms >= 0);
  assert.equal(calls.length, 2);
});

test("④ 全败 fail-open：抛 JevError kind upstream、failoverAttempts 每级一条（checkDispatch 捕获后落 error 行放行）", async () => {
  const { fn } = fakeClassify([
    { stopReason: "error", errorMessage: "boom-1", answers: {} },
    { stopReason: "aborted", answers: {} },
  ]);
  const ask = createBuiltinAsk(fn, [
    { name: "a/one", model: { id: "one" } },
    { name: "b/two", model: { id: "two" } },
  ]);
  await assert.rejects(
    ask({ state: "S", questions: QUESTIONS }),
    (err: unknown) => {
      assert.ok(err instanceof JevError);
      const je = err as JevError;
      assert.equal(je.kind, "upstream");
      assert.match(je.message, /^builtin classifier chain exhausted: /);
      assert.ok(je.message.includes("stopReason aborted")); // 末级败因（无 errorMessage 之兜底文案）
      assert.equal(je.failoverAttempts!.length, 2);
      assert.deepEqual(je.failoverAttempts!.map((a) => a.name), ["a/one", "b/two"]);
      assert.ok(je.failoverAttempts!.every((a) => a.kind === "error"));
      return true;
    }
  );
});

test("⑤ 未解析条目（model:null）预败：不发 classifyFn（ms:0），后续级仍可成功", async () => {
  const { fn, calls } = fakeClassify([{ stopReason: "stop", answers: OK_ANSWERS }]);
  const chain: BuiltinChainEntry[] = [
    { name: "bad/typo", model: null },
    { name: "good/one", model: { id: "one" } },
  ];
  const ask = createBuiltinAsk(fn, chain);
  const res = await ask({ state: "S", questions: QUESTIONS });
  assert.equal(res.model, "good/one");
  assert.equal(calls.length, 1); // 预败级零请求
  assert.equal(calls[0]!.model, chain[1]!.model);
  const meta = getAskMeta(res)!;
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0]!.name, "bad/typo");
  assert.equal(meta.attempts[0]!.kind, "error");
  assert.equal(meta.attempts[0]!.ms, 0);
});

test("⑥ 空链：立即抛 JevError（failoverAttempts 空），classifyFn 未被调", async () => {
  let called = 0;
  const fn: BuiltinClassifyFn = async () => {
    called += 1;
    return { stopReason: "stop", answers: {} };
  };
  const ask = createBuiltinAsk(fn, []);
  await assert.rejects(
    ask({ state: "S", questions: QUESTIONS }),
    (err: unknown) => err instanceof JevError && (err as JevError).failoverAttempts!.length === 0
  );
  assert.equal(called, 0);
});

test("⑦ stopReason stop 但答案缺失/非法 → 按失败计切下一级；noul 概率缺失/非有限、choice 缺 choice/probabilities/confidence 亦然", async () => {
  const c1 = OK_ANSWERS.C1;
  const badScripts: Array<Record<string, unknown>> = [
    {}, // 全缺
    { C1: c1 }, // Q1 缺
    { Q1: { type: "bool", probability: Number.NaN }, C1: c1 }, // 概率非有限
    { Q1: { type: "bool" }, C1: c1 }, // 概率缺失
    { Q1: { type: "bool", probability: 0.5 }, C1: { type: "choice", choice: "a" } }, // choice 无 probabilities → 归一失败
    { Q1: { type: "bool", probability: 0.5 }, C1: { type: "choice", probabilities: { a: 0.9 }, confidence: 0.8 } }, // 无 choice 键
    { Q1: { type: "bool", probability: 0.5 }, C1: { type: "choice", choice: "a", probabilities: { a: 0.9 } } }, // 无 confidence
    { Q1: { type: "bool", probability: 0.5 }, C1: { type: "choice", choice: "a", probabilities: "junk", confidence: 0.8 } }, // probabilities 非表
  ];
  for (const bad of badScripts) {
    const { fn, calls } = fakeClassify([
      { stopReason: "stop", answers: bad },
      { stopReason: "stop", answers: OK_ANSWERS },
    ]);
    const ask = createBuiltinAsk(fn, [
      { name: "a/one", model: { id: "one" } },
      { name: "b/two", model: { id: "two" } },
    ]);
    const res = await ask({ state: "S", questions: QUESTIONS });
    assert.equal(res.model, "b/two", JSON.stringify(bad));
    assert.equal(calls.length, 2);
    assert.equal(getAskMeta(res)!.attempts[0]!.name, "a/one");
  }
});

test("⑧ classifyFn 契约外抛异常 → 按失败尝试记（切下一级，fail-open）", async () => {
  const { fn, calls } = fakeClassify([
    new Error("registry blew up"),
    { stopReason: "stop", answers: { ...OK_ANSWERS, Q1: { type: "bool", probability: 0.9 } } },
  ]);
  const ask = createBuiltinAsk(fn, [
    { name: "a/one", model: { id: "one" } },
    { name: "b/two", model: { id: "two" } },
  ]);
  const res = await ask({ state: "S", questions: QUESTIONS });
  assert.equal(res.model, "b/two");
  assert.equal(calls.length, 2);
  const meta = getAskMeta(res)!;
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0]!.name, "a/one");
});

test("⑨ usage 缺省 {}；answers 非对象（undefined）→ 按失败计（全败抛 JevError）", async () => {
  const { fn } = fakeClassify([
    { stopReason: "stop", answers: undefined as unknown as Record<string, unknown> },
  ]);
  const ask = createBuiltinAsk(fn, [{ name: "a/one", model: { id: "one" } }]);
  await assert.rejects(
    ask({ state: "S", questions: QUESTIONS }),
    (err: unknown) => err instanceof JevError
  );

  const { fn: fn2 } = fakeClassify([{ stopReason: "stop", answers: OK_ANSWERS }]);
  const res = await createBuiltinAsk(fn2, [{ name: "a/one", model: { id: "one" } }])({
    state: "S",
    questions: QUESTIONS,
  });
  assert.deepEqual(res.usage, {}); // 缺省空 usage
});

test("⑩ score 答案归一：pi 平铺 {type:'score', score, confidence} → {score:{value, probabilities:{}, confidence}}；score/confidence 缺失或非有限、type 缺失按失败计", async () => {
  const QUESTIONS2 = {
    ...QUESTIONS,
    S1: { type: "score" as const, instructions: "Rate severity.", levels: { "1": "low", "2": "high" } },
  };
  const okAnswers = { ...OK_ANSWERS, S1: { type: "score", score: 2.4, confidence: 0.58 } };
  const { fn } = fakeClassify([{ stopReason: "stop", answers: okAnswers }]);
  const res = await createBuiltinAsk(fn, [{ name: "a/one", model: { id: "one" } }])({
    state: "S",
    questions: QUESTIONS2,
  });
  assert.deepEqual(res.answers.S1, { score: { value: 2.4, probabilities: {}, confidence: 0.58 } });

  const badScores: Array<Record<string, unknown>> = [
    { type: "score", confidence: 0.58 }, // score 缺失
    { type: "score", score: Number.NaN, confidence: 0.58 }, // score 非有限
    { type: "score", score: 2.4 }, // confidence 缺失
    { score: 2.4, confidence: 0.58 }, // type 缺失（无法辨认为 score 答案）
  ];
  for (const s1 of badScores) {
    const { fn: fnBad, calls } = fakeClassify([
      { stopReason: "stop", answers: { ...OK_ANSWERS, S1: s1 } },
      { stopReason: "stop", answers: okAnswers },
    ]);
    const res = await createBuiltinAsk(fnBad, [
      { name: "a/one", model: { id: "one" } },
      { name: "b/two", model: { id: "two" } },
    ])({ state: "S", questions: QUESTIONS2 });
    assert.equal(res.model, "b/two", JSON.stringify(s1));
    assert.equal(calls.length, 2);
  }
});

test("⑪ usage 映射：pi {input, output, …} → {input_tokens, output_tokens}（仅取二有限数键）；缺失/非法 → {}", async () => {
  // pi 全量 usage：多余键（cacheRead/cacheWrite/totalTokens/cost）不随行
  const { fn } = fakeClassify([
    {
      stopReason: "stop",
      answers: OK_ANSWERS,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 15,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
      },
    },
  ]);
  const res = await createBuiltinAsk(fn, [{ name: "a/one", model: { id: "one" } }])({
    state: "S",
    questions: QUESTIONS,
  });
  assert.deepEqual(res.usage, { input_tokens: 10, output_tokens: 5 });

  // 非对象 usage → {}；单键非有限 → 仅取有效键
  const { fn: fn2 } = fakeClassify([
    { stopReason: "stop", answers: OK_ANSWERS, usage: "junk" },
  ]);
  const res2 = await createBuiltinAsk(fn2, [{ name: "a/one", model: { id: "one" } }])({
    state: "S",
    questions: QUESTIONS,
  });
  assert.deepEqual(res2.usage, {});

  const { fn: fn3 } = fakeClassify([
    { stopReason: "stop", answers: OK_ANSWERS, usage: { input: "3", output: 2 } },
  ]);
  const res3 = await createBuiltinAsk(fn3, [{ name: "a/one", model: { id: "one" } }])({
    state: "S",
    questions: QUESTIONS,
  });
  assert.deepEqual(res3.usage, { output_tokens: 2 });
});

test("⑫ 出站映射：choice options→criteria（null/空白描述以键充当、criteria 判据并入）、score levels→criteria（string[] 按档位序）", async () => {
  const QUESTIONS2 = {
    R: {
      type: "choice" as const,
      instructions: "Route it.",
      criteria: { pass: "nothing to do" },
      options: { pass: null, review: "needs human eyes", block: "" },
    },
    S: {
      type: "score" as const,
      instructions: "Rate severity.",
      criteria: { "2": "medium pain" },
      levels: { "1": null, "2": "medium", "3": "high" },
    },
  };
  const answers = {
    R: { type: "choice", choice: "review", probabilities: { review: 0.9 }, confidence: 0.8 },
    S: { type: "score", score: 2, confidence: 0.6 },
  };
  const { fn, calls } = fakeClassify([{ stopReason: "stop", answers }]);
  await createBuiltinAsk(fn, [{ name: "a/one", model: { id: "one" } }])({
    state: "S",
    questions: QUESTIONS2,
  });
  const q = calls[0]!.context.questions as Record<string, Record<string, unknown>>;
  // choice：pass 描述 null → criteria 判据充当；block 描述空白 → 键本身；review → 描述原样
  assert.deepEqual(q.R, {
    type: "choice",
    instructions: "Route it.",
    criteria: { pass: "nothing to do", review: "needs human eyes", block: "block" },
  });
  // score：levels 映为 string[]（按档位序）；"2" 之描述与 criteria 判据并作一句
  assert.deepEqual(q.S, {
    type: "score",
    instructions: "Rate severity.",
    criteria: ["1", "medium；medium pain", "high"],
  });
  assert.ok(!("options" in q.R!) && !("levels" in q.S!)); // 我方字段名不出站
});

test("⑬ signal 透传：params.signal 有则随 classifyFn options 携行（{maxRetries:0, signal}）；无则 options 仅 {maxRetries:0}", async () => {
  const ac = new AbortController();
  const { fn, calls } = fakeClassify([{ stopReason: "stop", answers: OK_ANSWERS }]);
  const ask = createBuiltinAsk(fn, [{ name: "a/one", model: { id: "one" } }]);
  await ask({ state: "S", questions: QUESTIONS, signal: ac.signal });
  assert.deepEqual(calls[0]!.options, { maxRetries: 0, signal: ac.signal });

  // 无 signal：options 形状不变（红线②单发语义照旧）
  const { fn: fn2, calls: calls2 } = fakeClassify([{ stopReason: "stop", answers: OK_ANSWERS }]);
  await createBuiltinAsk(fn2, [{ name: "a/one", model: { id: "one" } }])({
    state: "S",
    questions: QUESTIONS,
  });
  assert.deepEqual(calls2[0]!.options, { maxRetries: 0 });
});
