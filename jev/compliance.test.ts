// compliance.ts 单测：verdict 阈值矩阵、buildState 拼接、auditLine、拦截判定、loadRuleSets、checkDispatch（mock askFn）。
// 全部走 mock，不发任何真实 API 调用。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JevError } from "./client.ts";
import {
  RULE_SETS,
  buildState,
  verdict,
  auditLine,
  loadRuleSets,
  checkDispatch,
  type AskFn,
} from "./compliance.ts";

test("① verdict 全绿：R1/R2 高、R3/R4 低 → pass", () => {
  const r = verdict(RULE_SETS.delegate.rules, { R1: 0.9, R2: 0.85, R3: 0.05, R4: 0.2 });
  assert.deepEqual(r.rules, { R1: "pass", R2: "pass", R3: "clean", R4: "clean" });
  assert.equal(r.verdict, "pass");
});

test("② verdict 按 blockWhen/threshold：below 低于阈值→fail、above 高于阈值→suspect，恰在阈值取 pass/clean", () => {
  const r = verdict(RULE_SETS.delegate.rules, { R1: 0.7, R2: 0.3, R3: 0.8, R4: 0.3 });
  assert.deepEqual(r.rules, { R1: "pass", R2: "fail", R3: "clean", R4: "clean" });
  // 任一 fail/suspect → violation
  assert.equal(r.verdict, "violation");
});

test("③ verdict 概率缺失/非有限 → unknown，不参与综合判定", () => {
  const r = verdict(RULE_SETS.delegate.rules, { R1: 0.9, R2: 0.9, R4: 0.1 }); // R3 缺失
  assert.equal(r.rules.R3, "unknown");
  assert.equal(r.verdict, "pass");
  const r2 = verdict(RULE_SETS.delegate.rules, { R1: 0.9, R2: 0.9, R3: NaN, R4: 0.1 });
  assert.equal(r2.rules.R3, "unknown");
  assert.equal(r2.verdict, "pass");
});

test("④ verdict above 超阈值 → suspect，综合亦 violation", () => {
  const r = verdict(RULE_SETS.delegate.rules, { R1: 0.9, R2: 0.9, R3: 0.05, R4: 0.9 });
  assert.deepEqual(r.rules, { R1: "pass", R2: "pass", R3: "clean", R4: "suspect" });
  assert.equal(r.verdict, "violation");
});

test("⑤ buildState 模板拼接：agent 名、agentDesc、任务原文逐字（中文不动）", () => {
  const task = "修改 /home/g0/ttt/foo.md，把第一行改成「你好世界」。";
  const s = buildState("delegate", RULE_SETS.delegate.agentDesc, task);
  assert.equal(
    s,
    `The following is a task dispatched to a sub-agent named "delegate", ${RULE_SETS.delegate.agentDesc}. Task text follows.\n${task}`
  );
  assert.ok(s.includes("你好世界"));
});

test("⑥ auditLine：task_excerpt ≤200 字（码点截断）、error 字段可选", () => {
  const longTask = "字".repeat(250);
  const line = auditLine({
    agent: "delegate",
    task: longTask,
    model: "oc/jev-1.13-free",
    rules: { R1: "pass", R2: "pass", R3: "clean", R4: "clean" },
    verdict: "pass",
    latencyMs: 123,
  });
  assert.equal(Array.from(line.task_excerpt).length, 200);
  assert.equal(line.model, "oc/jev-1.13-free");
  assert.equal(line.latency_ms, 123);
  assert.equal(line.error, undefined);
  assert.ok(line.ts.length > 0);

  const errLine = auditLine({
    agent: "delegate",
    task: "x",
    verdict: "error",
    latencyMs: 5,
    error: "timeout: 请求超时",
  });
  assert.equal(errLine.error, "timeout: 请求超时");
  assert.equal(errLine.rules, null);
  assert.equal(errLine.model, null);
});

test("⑦ checkDispatch 命中 delegate：mock askFn 四问打包一次、verdict 与 audit 行正确", async () => {
  let calls = 0;
  const askFn = async (params: Parameters<typeof checkDispatch> extends never ? never : any) => {
    calls++;
    assert.equal(params.state, buildState("delegate", RULE_SETS.delegate.agentDesc, TASK));
    for (const [id, q] of Object.entries(params.questions) as [string, any]) {
      assert.equal(q.type, "noul");
      assert.equal(q.instructions, RULE_SETS.delegate.rules.find((r) => r.id === id)!.instructions);
    }
    assert.equal(Object.keys(params.questions).length, 4);
    return {
      model: "oc/jev-1.13-free",
      answers: { R1: { noul: 0.9 }, R2: { noul: 0.2 }, R3: { noul: 0.05 }, R4: { noul: 0.1 } },
      usage: {},
    };
  };
  const res = await checkDispatch("delegate", TASK, { askFn });
  assert.equal(calls, 1);
  assert.ok(res);
  const line = res.line;
  assert.deepEqual(line.rules, { R1: "pass", R2: "fail", R3: "clean", R4: "clean" });
  assert.equal(line.verdict, "violation"); // R2 fail
  assert.equal(line.agent, "delegate");
  assert.equal(line.model, "oc/jev-1.13-free");
  assert.equal(line.task_excerpt, TASK);
  assert.equal(typeof line.latency_ms, "number");
  assert.ok(Array.from(line.task_excerpt).length <= 200);
  // 拦截判定：R2=0.2 < 0.7 命中 below；R3/R4 未超 0.8 不命中 above
  assert.deepEqual(res.violations, ["R2: 任务无确定内容"]);
  assert.deepEqual(line.blocked, ["R2"]);
});

const TASK = "在 /home/g0/ttt/bar.md 中追加一行「done」。";

test("⑧ checkDispatch 未命中 agent → null，且不调 askFn", async () => {
  let called = false;
  const res = await checkDispatch("worker", TASK, {
    askFn: async () => {
      called = true;
      throw new Error("不应被调用");
    },
  });
  assert.equal(res, null);
  assert.equal(called, false);
});

test("⑨ checkDispatch askFn 抛 JevError → 返 error 行、violations 空、不抛（fail-open）", async () => {
  const res = await checkDispatch("delegate", TASK, {
    askFn: async () => {
      throw new JevError("timeout", "请求超时（--max-time 30s）");
    },
  });
  assert.ok(res);
  const line = res.line;
  assert.equal(line.verdict, "error");
  assert.equal(line.error, "timeout: 请求超时（--max-time 30s）");
  assert.equal(line.rules, null);
  assert.equal(line.model, null);
  assert.equal(line.agent, "delegate");
  assert.ok(Array.from(line.task_excerpt).length <= 200);
  assert.deepEqual(res.violations, []); // 基础设施故障绝不拦截
});

test("⑩ checkDispatch askFn 抛非 JevError → 亦返 error 行而不抛", async () => {
  const res = await checkDispatch("delegate", TASK, {
    askFn: async () => {
      throw new Error("boom");
    },
  });
  assert.ok(res);
  assert.equal(res.line.verdict, "error");
  assert.ok(res.line.error!.startsWith("unexpected: "));
  assert.deepEqual(res.violations, []);
});

test("⑪ 拦截判定边界：below 恰在阈值不拦、above 恰在阈值不拦；多条全列", async () => {
  const ask = (probs: Record<string, number>): AskFn => async () => ({
    model: "m",
    answers: Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, { noul: v }])),
    usage: {},
  });
  // R1=0.7 恰在阈值（below 不拦）、R2=0.69 拦、R3=0.8 恰在阈值（above 不拦）、R4=0.81 拦
  const r1 = await checkDispatch("delegate", TASK, {
    askFn: ask({ R1: 0.7, R2: 0.69, R3: 0.8, R4: 0.81 }),
  });
  assert.deepEqual(r1!.violations, [
    "R2: 任务无确定内容",
    "R4: 任务要求 agent 自行探索查资料",
  ]);
  assert.deepEqual(r1!.line.blocked, ["R2", "R4"]);

  // 全绿：正例高、反例低 → 无违规，blocked 字段不落
  const r2 = await checkDispatch("delegate", TASK, {
    askFn: ask({ R1: 0.95, R2: 0.9, R3: 0.01, R4: 0.05 }),
  });
  assert.deepEqual(r2!.violations, []);
  assert.equal(r2!.line.blocked, undefined);
});

test("⑫ loadRuleSets：覆盖内建字段（instructions 亦以配置档为准）、新 agent 整组加入", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      delegate: {
        rules: [
          { id: "R1", threshold: 0.95, message: "R1 改过的消息", instructions: "恶意覆盖" },
          { id: "R9", blockWhen: "above", threshold: 0.5, message: "新规则" },
        ],
      },
      worker: { agentDesc: "a generic worker", rules: [{ id: "R1", threshold: 0.4 }] },
    })
  );
  const rs = loadRuleSets(p);
  const r1 = rs.agents.delegate.rules.find((r) => r.id === "R1")!;
  assert.equal(r1.threshold, 0.95);
  assert.equal(r1.message, "R1 改过的消息");
  assert.equal(r1.instructions, "恶意覆盖"); // 配置档 instructions 覆盖内建
  assert.equal(rs.agents.delegate.agentDesc, RULE_SETS.delegate.agentDesc);
  assert.ok(rs.agents.delegate.rules.some((r) => r.id === "R9" && r.threshold === 0.5));
  assert.equal(rs.agents.worker.agentDesc, "a generic worker");
  assert.equal(rs.agents.worker.rules[0].threshold, 0.4);
  // 内建未被就地改动
  assert.equal(RULE_SETS.delegate.rules.find((r) => r.id === "R1")!.threshold, 0.7);
});

test("⑬ loadRuleSets：档不存在／JSON 坏 → 静默返内建默认（fail-open）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const none = loadRuleSets(path.join(dir, "nope.json"));
  assert.equal(none.agents, RULE_SETS);
  assert.equal(none.global.auditProbabilities, false);
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  const badRes = loadRuleSets(bad);
  assert.equal(badRes.agents, RULE_SETS);
  assert.equal(badRes.global.auditProbabilities, false);
});

test("⑭ loadRuleSets/_global：不视作 agent，auditProbabilities 解析，缺省 false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const on = path.join(dir, "on.json");
  writeFileSync(
    on,
    JSON.stringify({
      _global: { auditProbabilities: true },
      delegate: { rules: [{ id: "R1", threshold: 0.9 }] },
    })
  );
  const rsOn = loadRuleSets(on);
  assert.equal(rsOn.global.auditProbabilities, true);
  assert.equal(rsOn.agents["_global"], undefined); // 不视作 agent
  assert.ok("delegate" in rsOn.agents);

  const off = path.join(dir, "off.json");
  writeFileSync(off, JSON.stringify({ delegate: { rules: [] } }));
  const rsOff = loadRuleSets(off);
  assert.equal(rsOff.global.auditProbabilities, false);
  assert.equal(rsOff.agents["_global"], undefined);
});

test("⑮ checkDispatch：JSON 新 agent＋新规则 id 命中阈值即拦", async () => {
  const ruleSets = {
    reviewer: {
      agentDesc: "a code-review agent",
      rules: [
        {
          id: "C1",
          instructions: "Does the task break backwards compatibility?",
          blockWhen: "above" as const,
          threshold: 0.6,
          message: "自定义违规",
        },
      ],
    },
  };
  let asked = 0;
  const askFn: AskFn = async (params) => {
    asked++;
    assert.deepEqual(Object.keys(params.questions), ["C1"]);
    assert.equal(params.questions.C1.instructions, "Does the task break backwards compatibility?");
    return {
      model: "m",
      answers: { C1: { noul: 0.9 } },
      usage: {},
    };
  };
  const res = await checkDispatch("reviewer", TASK, { askFn, ruleSets });
  assert.equal(asked, 1);
  assert.ok(res);
  assert.equal(res.line.rules!.C1, "suspect");
  assert.equal(res.line.verdict, "violation");
  assert.deepEqual(res.violations, ["C1: 自定义违规"]);
  assert.deepEqual(res.line.blocked, ["C1"]);
});

test("⑯ checkDispatch：noul 字段缺失 → 该规则跳过不拦，审计标 unknown（fail-open）", async () => {
  const askFn: AskFn = async () => ({
    model: "m",
    // R1 之 noul 字段整体缺失；R2 之 noul 非数字
    answers: { R2: { noul: 0.9 }, R3: { noul: 0.1 }, R4: { noul: "oops" } } as never,
    usage: {},
  });
  const res = await checkDispatch("delegate", TASK, { askFn });
  assert.ok(res);
  assert.equal(res.line.rules!.R1, "unknown");
  assert.equal(res.line.rules!.R2, "pass");
  assert.equal(res.line.rules!.R4, "unknown");
  assert.equal(res.line.verdict, "pass"); // unknown 不参与综合
  assert.deepEqual(res.violations, []);
  assert.equal(res.line.blocked, undefined);
});

test("⑰ checkDispatch auditProbabilities：true → line.probs 含原始数值；缺省/false → 无 probs 键", async () => {
  const askFn: AskFn = async () => ({
    model: "m",
    answers: { R1: { noul: 0.9 }, R2: { noul: 0.2 }, R3: { noul: 0.05 }, R4: { noul: 0.1 } },
    usage: {},
  });
  const on = await checkDispatch("delegate", TASK, { askFn, auditProbabilities: true });
  assert.deepEqual(on!.line.probs, { R1: 0.9, R2: 0.2, R3: 0.05, R4: 0.1 });
  const off = await checkDispatch("delegate", TASK, { askFn });
  assert.equal(off!.line.probs, undefined);
  assert.ok(!("probs" in off!.line));
});

test("⑱ checkDispatch：instructions 为空/空白的规则检查时跳过，不发问不拦", async () => {
  const ruleSets = {
    worker: {
      agentDesc: "a worker",
      rules: [
        { id: "X1", instructions: "   ", blockWhen: "below" as const, threshold: 0.5, message: "空白问题" },
        { id: "X2", instructions: "Is this ok?", blockWhen: "below" as const, threshold: 0.5, message: "X2 违规" },
      ],
    },
  };
  const askFn: AskFn = async (params) => {
    assert.deepEqual(Object.keys(params.questions), ["X2"]); // X1 不发问
    return { model: "m", answers: { X2: { noul: 0.9 } }, usage: {} };
  };
  const res = await checkDispatch("worker", TASK, { askFn, ruleSets });
  assert.ok(res);
  assert.deepEqual(Object.keys(res.line.rules!), ["X2"]); // X1 不进审计
  assert.equal(res.line.verdict, "pass");
  assert.deepEqual(res.violations, []);
});
