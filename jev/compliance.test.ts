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

test("① verdict 全绿：R1/R2 高、R3/R4 低 → compliant", () => {
  const r = verdict({ R1: 0.9, R2: 0.85, R3: 0.05, R4: 0.2 });
  assert.deepEqual(r.rules, { R1: "pass", R2: "pass", R3: "clean", R4: "clean" });
  assert.equal(r.verdict, "compliant");
});

test("② verdict 阈值边界 0.7/0.3：恰在边界取 pass/violation/clean", () => {
  const r = verdict({ R1: 0.7, R2: 0.3, R3: 0.7, R4: 0.3 });
  assert.deepEqual(r.rules, { R1: "pass", R2: "fail", R3: "violation", R4: "clean" });
  // 任一 fail/violation → violation（优先于 suspect）
  assert.equal(r.verdict, "violation");
});

test("③ verdict 边界外侧：0.71 pass、0.69 suspect；0.31/0.29 反例", () => {
  assert.equal(verdict({ R1: 0.71, R2: 0.71, R3: 0.29, R4: 0.29 }).verdict, "compliant");
  const r = verdict({ R1: 0.69, R2: 0.9, R3: 0.31, R4: 0.1 });
  assert.deepEqual(r.rules, { R1: "suspect", R2: "pass", R3: "suspect", R4: "clean" });
  assert.equal(r.verdict, "suspect");
});

test("④ verdict 混合 suspect：无 fail/violation 但有 suspect → suspect", () => {
  const r = verdict({ R1: 0.5, R2: 0.8, R3: 0.1, R4: 0.5 });
  assert.deepEqual(r.rules, { R1: "suspect", R2: "pass", R3: "clean", R4: "suspect" });
  assert.equal(r.verdict, "suspect");
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
    verdict: "compliant",
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
  assert.equal(line.verdict, "violation"); // R2 fail 优先
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

test("⑫ loadRuleSets：覆盖内建阈值/消息、instructions 以内建为准、未知 agent 整组加入", () => {
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
  const r1 = rs.delegate.rules.find((r) => r.id === "R1")!;
  assert.equal(r1.threshold, 0.95);
  assert.equal(r1.message, "R1 改过的消息");
  assert.equal(r1.instructions, RULE_SETS.delegate.rules.find((r) => r.id === "R1")!.instructions);
  assert.equal(rs.delegate.agentDesc, RULE_SETS.delegate.agentDesc);
  assert.ok(rs.delegate.rules.some((r) => r.id === "R9" && r.threshold === 0.5));
  assert.equal(rs.worker.agentDesc, "a generic worker");
  assert.equal(rs.worker.rules[0].threshold, 0.4);
  // 内建未被就地改动
  assert.equal(RULE_SETS.delegate.rules.find((r) => r.id === "R1")!.threshold, 0.7);
});

test("⑬ loadRuleSets：档不存在／JSON 坏 → 静默返内建默认（fail-open）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  assert.equal(loadRuleSets(path.join(dir, "nope.json")), RULE_SETS);
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.equal(loadRuleSets(bad), RULE_SETS);
});
