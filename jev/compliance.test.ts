// compliance.ts 单测：verdict 阈值矩阵、buildState 拼接、auditLine、拦截判定、loadRuleSets、checkDispatch（mock askFn）、
// _all 全局规则组。全部走 mock，不发任何真实 API 调用。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JevError, setAskMeta, type SystemOneResult } from "./client.ts";
import {
  buildState,
  verdict,
  auditLine,
  loadRuleSets,
  checkDispatch,
  type AskFn,
  type AgentRuleSet,
} from "./compliance.ts";
import type { DispatchTrainingLine } from "./traininglog.ts";

// v0.7.0 起内建规则全废（RULE_SETS 为空，配置档为唯一来源）：
// 测试不再依赖内建，改以显式 fixture（原内建 delegate R1-R4 之内容）注入。
const DELEGATE: AgentRuleSet = {
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
};
const DELEGATE_SET = { delegate: DELEGATE };

test("① verdict 全绿：R1/R2 高、R3/R4 低 → pass", () => {
  const r = verdict(DELEGATE.rules, { R1: 0.9, R2: 0.85, R3: 0.05, R4: 0.2 });
  assert.deepEqual(r.rules, { R1: "pass", R2: "pass", R3: "clean", R4: "clean" });
  assert.equal(r.verdict, "pass");
});

test("② verdict 按 blockWhen/threshold：below 低于阈值→fail、above 高于阈值→suspect，恰在阈值取 pass/clean", () => {
  const r = verdict(DELEGATE.rules, { R1: 0.7, R2: 0.3, R3: 0.8, R4: 0.3 });
  assert.deepEqual(r.rules, { R1: "pass", R2: "fail", R3: "clean", R4: "clean" });
  // 任一 fail/suspect → violation
  assert.equal(r.verdict, "violation");
});

test("③ verdict 概率缺失/非有限 → unknown，不参与综合判定", () => {
  const r = verdict(DELEGATE.rules, { R1: 0.9, R2: 0.9, R4: 0.1 }); // R3 缺失
  assert.equal(r.rules.R3, "unknown");
  assert.equal(r.verdict, "pass");
  const r2 = verdict(DELEGATE.rules, { R1: 0.9, R2: 0.9, R3: NaN, R4: 0.1 });
  assert.equal(r2.rules.R3, "unknown");
  assert.equal(r2.verdict, "pass");
});

test("④ verdict above 超阈值 → suspect，综合亦 violation", () => {
  const r = verdict(DELEGATE.rules, { R1: 0.9, R2: 0.9, R3: 0.05, R4: 0.9 });
  assert.deepEqual(r.rules, { R1: "pass", R2: "pass", R3: "clean", R4: "suspect" });
  assert.equal(r.verdict, "violation");
});

test("⑤ buildState 模板拼接：agent 名、agentDesc、任务原文逐字（中文不动）", () => {
  const task = "修改 /home/g0/ttt/foo.md，把第一行改成「你好世界」。";
  const s = buildState("delegate", DELEGATE.agentDesc, task);
  assert.equal(
    s,
    `The following is a task dispatched to a sub-agent named "delegate", ${DELEGATE.agentDesc}. Task text follows.\n${task}`
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
    assert.equal(params.state, buildState("delegate", DELEGATE.agentDesc, TASK));
    for (const [id, q] of Object.entries(params.questions) as [string, any]) {
      assert.equal(q.type, "noul");
      assert.equal(q.instructions, DELEGATE.rules.find((r) => r.id === id)!.instructions);
    }
    assert.equal(Object.keys(params.questions).length, 4);
    return {
      model: "oc/jev-1.13-free",
      answers: { R1: { noul: 0.9 }, R2: { noul: 0.2 }, R3: { noul: 0.05 }, R4: { noul: 0.1 } },
      usage: {},
    };
  };
  const res = await checkDispatch("delegate", TASK, { askFn, ruleSets: DELEGATE_SET });
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

test("⑧ checkDispatch 未命中 agent 且无 _all → null，且不调 askFn", async () => {
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
    ruleSets: DELEGATE_SET,
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
    ruleSets: DELEGATE_SET,
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
    ruleSets: DELEGATE_SET,
  });
  assert.deepEqual(r1!.violations, [
    "R2: 任务无确定内容",
    "R4: 任务要求 agent 自行探索查资料",
  ]);
  assert.deepEqual(r1!.line.blocked, ["R2", "R4"]);

  // 全绿：正例高、反例低 → 无违规，blocked 字段不落
  const r2 = await checkDispatch("delegate", TASK, {
    askFn: ask({ R1: 0.95, R2: 0.9, R3: 0.01, R4: 0.05 }),
    ruleSets: DELEGATE_SET,
  });
  assert.deepEqual(r2!.violations, []);
  assert.equal(r2!.line.blocked, undefined);
});

test("⑫ loadRuleSets：自含问句解析成完整规则、message 缺省兜底、各 agent 组独立载入", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: {
        R1: {
          instructions:
            "Does the task give at least one concrete, explicit file path to create or modify?",
          blockWhen: "below",
          threshold: 0.95,
          message: "R1 改过的消息",
        },
        R9: { instructions: "Is this rule ok?", blockWhen: "above", threshold: 0.5, message: "新规则" },
        W1: { instructions: "Worker question?", blockWhen: "below", threshold: 0.4 },
      },
      delegate: {
        agentDesc: "a file-editing agent without shell access",
        rules: ["R1", "R9"],
      },
      worker: { agentDesc: "a generic worker", rules: ["W1"] },
    })
  );
  const rs = loadRuleSets(p);
  const r1 = rs.agents.delegate.rules.find((r) => r.id === "R1")!;
  assert.equal(r1.threshold, 0.95);
  assert.equal(r1.message, "R1 改过的消息");
  assert.equal(r1.instructions,
    "Does the task give at least one concrete, explicit file path to create or modify?");
  assert.equal(rs.agents.delegate.agentDesc, "a file-editing agent without shell access");
  assert.ok(rs.agents.delegate.rules.some((r) => r.id === "R9" && r.threshold === 0.5));
  assert.equal(rs.agents.worker.agentDesc, "a generic worker");
  assert.equal(rs.agents.worker.rules[0].id, "W1");
  assert.equal(rs.agents.worker.rules[0].threshold, 0.4);
  // 问句未给字段之缺省：blockWhen below、message 兜底
  assert.equal(rs.agents.worker.rules[0].blockWhen, "below");
  assert.equal(rs.agents.worker.rules[0].message, "规则 W1 未通过");
});

test("⑬ loadRuleSets：档不存在／JSON 坏 → 静默返空（agents 空且 all 为 null，fail-open 至尽头）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const none = loadRuleSets(path.join(dir, "nope.json"));
  assert.deepEqual(none.agents, {});
  assert.equal(none.all, null);
  assert.equal(none.global.auditProbabilities, false);
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  const badRes = loadRuleSets(bad);
  assert.deepEqual(badRes.agents, {});
  assert.equal(badRes.all, null);
  assert.equal(badRes.global.auditProbabilities, false);
});

test("⑭ loadRuleSets/_global：不视作 agent，auditProbabilities 解析，缺省 false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const on = path.join(dir, "on.json");
  writeFileSync(
    on,
    JSON.stringify({
      _global: { auditProbabilities: true },
      delegate: { rules: [] },
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
  const res = await checkDispatch("delegate", TASK, { askFn, ruleSets: DELEGATE_SET });
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
  const on = await checkDispatch("delegate", TASK, { askFn, ruleSets: DELEGATE_SET, auditProbabilities: true });
  assert.deepEqual(on!.line.probs, { R1: 0.9, R2: 0.2, R3: 0.05, R4: 0.1 });
  const off = await checkDispatch("delegate", TASK, { askFn, ruleSets: DELEGATE_SET });
  assert.equal(off!.line.probs, undefined);
  assert.ok(!("probs" in off!.line));
});

test("⑲ loadRuleSets：criteria 解析、非法静默弃（fail-open，不致问句整条失效）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: {
        R1: {
          instructions: "Q1?",
          blockWhen: "below",
          threshold: 0.7,
          criteria: { true: "has path", false: "no path" },
        },
        R2: { instructions: "Q2?", blockWhen: "below", threshold: 0.7, criteria: "not-an-object" },
        R9: { instructions: "Q9?", blockWhen: "below", threshold: 0.5, criteria: { true: "only true side" } },
      },
      delegate: { rules: ["R1", "R2", "R9"] },
    })
  );
  const rs = loadRuleSets(p);
  const r1 = rs.agents.delegate.rules.find((r) => r.id === "R1")!;
  assert.deepEqual(r1.criteria, { true: "has path", false: "no path" }); // criteria 原样保留
  const r2 = rs.agents.delegate.rules.find((r) => r.id === "R2")!;
  assert.equal(r2.criteria, undefined); // 非法值静默弃之；问句本身仍有效（criteria 可选）
  assert.equal(r2.instructions, "Q2?");
  const r9 = rs.agents.delegate.rules.find((r) => r.id === "R9")!;
  assert.deepEqual(r9.criteria, { true: "only true side" }); // 单边判据原样保留
  // fixture 未被就地改动
  assert.equal(DELEGATE.rules.find((r) => r.id === "R1")!.criteria, undefined);
});

test("⑳ checkDispatch：配置档 criteria 一路透传至 askFn 载荷", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: {
        R1: {
          instructions: "Does the task name a path?",
          blockWhen: "below",
          threshold: 0.7,
          criteria: { true: "t", false: "f" },
        },
        R2: { instructions: "Second question?", blockWhen: "below", threshold: 0.7 },
      },
      delegate: { rules: ["R1", "R2"] },
    })
  );
  const rs = loadRuleSets(p);
  let asked = 0;
  let qs: Record<string, any> = {};
  const askFn: AskFn = async (params) => {
    asked++;
    qs = params.questions as Record<string, any>;
    return {
      model: "m",
      answers: Object.fromEntries(Object.keys(params.questions).map((k) => [k, { noul: 0.99 }])),
      usage: {},
    };
  };
  const res = await checkDispatch("delegate", TASK, { askFn, ruleSets: rs.agents });
  assert.equal(asked, 1);
  assert.ok(res);
  assert.deepEqual(qs.R1.criteria, { true: "t", false: "f" }); // criteria 透传至载荷
  assert.equal(qs.R2.criteria, undefined); // 未配 criteria 之规则（R2）不带该键
  assert.ok(!("criteria" in qs.R2));
  assert.equal(qs.R2.instructions, "Second question?");
});

test("⑱ checkDispatch：instructions 为空/空白的规则检查时跳过，不发问不拦（防御性，载入侧已拦）", async () => {
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

// ── failover 审计字段 ──

function okWithMeta(upstream: string, attempts: Parameters<typeof setAskMeta>[1]["attempts"]): AskFn {
  return async () => {
    const r: SystemOneResult = {
      model: "model-backup",
      answers: { R1: { noul: 0.9 }, R2: { noul: 0.9 }, R3: { noul: 0.1 }, R4: { noul: 0.1 } },
      usage: {},
    };
    setAskMeta(r, { upstream, attempts });
    return r;
  };
}

test("㉙ checkDispatch：切换发生 → 审计行含 upstream（胜者）与 failover（败级），model 记胜者模型", async () => {
  const res = await checkDispatch(
    "delegate",
    TASK,
    {
      ruleSets: DELEGATE_SET,
      askFn: okWithMeta("backup", [
        { name: "primary", status: 502, kind: "upstream", ms: 12 },
        { name: "middle", kind: "timeout", ms: 1005 },
      ]),
    }
  );
  assert.ok(res);
  assert.equal(res.line.upstream, "backup");
  assert.equal(res.line.model, "model-backup"); // 胜者模型照旧记 model 键
  assert.ok(res.line.failover);
  assert.equal(res.line.failover!.length, 2);
  assert.deepEqual(res.line.failover![0], { name: "primary", status: 502, kind: "upstream", ms: 12 });
  assert.equal(res.line.verdict, "pass");
  assert.deepEqual(res.violations, []);
});

test("㉚ checkDispatch：未切换 → 审计行无 upstream/failover 键", async () => {
  const askFn: AskFn = async () => ({
    model: "m",
    answers: { R1: { noul: 0.9 }, R2: { noul: 0.9 }, R3: { noul: 0.1 }, R4: { noul: 0.1 } },
    usage: {},
  });
  const res = await checkDispatch("delegate", TASK, { askFn, ruleSets: DELEGATE_SET });
  assert.ok(res);
  assert.ok(!("upstream" in res.line));
  assert.ok(!("failover" in res.line));

  // meta 在但未切换（attempts 空）亦不落键
  const res2 = await checkDispatch("delegate", TASK, { askFn: okWithMeta("primary", []), ruleSets: DELEGATE_SET });
  assert.ok(res2);
  assert.ok(!("upstream" in res2!.line));
  assert.ok(!("failover" in res2!.line));
});

test("㉛ checkDispatch：全链败尽 → error 行携 failover attempts（无 upstream），violations 空", async () => {
  const attempts = [
    { name: "primary", status: 502, kind: "upstream", ms: 10 },
    { name: "backup", status: 502, kind: "upstream", ms: 11 },
  ];
  const res = await checkDispatch("delegate", TASK, {
    ruleSets: DELEGATE_SET,
    askFn: async () => {
      throw new JevError("upstream", "上游故障（HTTP 502）", { status: 502, failoverAttempts: attempts });
    },
  });
  assert.ok(res);
  assert.equal(res.line.verdict, "error");
  assert.equal(res.line.error, "upstream: 上游故障（HTTP 502）");
  assert.deepEqual(res.line.failover, attempts);
  assert.ok(!("upstream" in res.line)); // 无胜者，无 upstream 键
  assert.equal(res.line.model, null);
  assert.deepEqual(res.violations, []); // 全链败尽亦 fail-open 放行
});

test("㉜ checkDispatch：冷却跳过成功 → 审计行含 upstream/failover（cooldown 记录逐字）；首配即成仍不落键", async () => {
  const res = await checkDispatch("delegate", TASK, {
    ruleSets: DELEGATE_SET,
    askFn: okWithMeta("backup", [{ name: "primary", kind: "cooldown" }]),
  });
  assert.ok(res);
  assert.equal(res.line.upstream, "backup");
  assert.deepEqual(res.line.failover, [{ name: "primary", kind: "cooldown" }]); // 逐字入行
  assert.equal(res.line.failover![0].status, undefined); // 无请求发生：无 status
  assert.equal(res.line.failover![0].ms, undefined); // 无请求发生：无 ms
  assert.equal(res.line.verdict, "pass");
  assert.deepEqual(res.violations, []);

  // 首配 upstream 即成（attempts 空）→ 审计行仍无 upstream/failover 键
  const first = await checkDispatch("delegate", TASK, { askFn: okWithMeta("primary", []), ruleSets: DELEGATE_SET });
  assert.ok(first);
  assert.ok(!("upstream" in first!.line));
  assert.ok(!("failover" in first!.line));
});

test("㉜b checkDispatch：保底成功 → 审计行含 upstream 与 fallback:true，无 failover 数组", async () => {
  const askFn: AskFn = async () => {
    const r: SystemOneResult = {
      model: "model-A",
      answers: { R1: { noul: 0.9 }, R2: { noul: 0.9 }, R3: { noul: 0.1 }, R4: { noul: 0.1 } },
      usage: {},
    };
    // 全链冷却下保底真发首名而成：attempts 空（单端点链）但 fallback 为真
    setAskMeta(r, { upstream: "A", attempts: [], fallback: true });
    return r;
  };
  const res = await checkDispatch("delegate", TASK, { askFn, ruleSets: DELEGATE_SET });
  assert.ok(res);
  assert.equal(res.line.upstream, "A"); // 保底胜者亦落 upstream 键
  assert.equal(res.line.fallback, true); // 保底成功可见（与首配正常即成相辨）
  assert.ok(!("failover" in res.line)); // attempts 空：不落 failover 数组
  assert.equal(res.line.verdict, "pass");
  assert.deepEqual(res.violations, []);
});

// ── 训练数据记录（trainingLog）──

const TRAIN_ANSWERS: AskFn = async () => ({
  model: "m",
  answers: { R1: { noul: 0.9 }, R2: { noul: 0.2 }, R3: { noul: 0.05 }, R4: { noul: 0.1 } },
  usage: {},
});

test("㉝ checkDispatch trainingLog：缺省/false → 不写训练行", async () => {
  let wrote = 0;
  const writeTraining = () => void wrote++;
  await checkDispatch("delegate", TASK, { askFn: TRAIN_ANSWERS, ruleSets: DELEGATE_SET, writeTraining });
  assert.equal(wrote, 0); // 缺省 false
  await checkDispatch("delegate", TASK, { askFn: TRAIN_ANSWERS, ruleSets: DELEGATE_SET, trainingLog: false, writeTraining });
  assert.equal(wrote, 0);
});

test("㉞ checkDispatch trainingLog：on → 写派单训练行（state 全量、questions 数组、probs 原始、blocked）", async () => {
  const lines: DispatchTrainingLine[] = [];
  const res = await checkDispatch("delegate", TASK, {
    ruleSets: DELEGATE_SET,
    askFn: TRAIN_ANSWERS,
    trainingLog: true,
    writeTraining: (l) => lines.push(l as DispatchTrainingLine),
  });
  assert.ok(res);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.source, "dispatch");
  assert.equal(line.agent, "delegate");
  assert.equal(line.state, buildState("delegate", DELEGATE.agentDesc, TASK)); // 全量 state
  assert.deepEqual(line.questions.map((q) => q.id), ["R1", "R2", "R3", "R4"]);
  assert.equal(line.questions[0].instructions, DELEGATE.rules[0].instructions);
  assert.deepEqual(line.probs, { R1: 0.9, R2: 0.2, R3: 0.05, R4: 0.1 });
  assert.equal(line.verdict, "violation");
  assert.deepEqual(line.blocked, ["R2"]);
  // 训练记录不过 auditProbabilities 门：审计行仍无 probs 键
  assert.equal(res.line.probs, undefined);
  assert.ok(!("probs" in res.line));
});

test("㉟ checkDispatch trainingLog：error 路径（fail-open）不写训练行", async () => {
  let wrote = 0;
  const res = await checkDispatch("delegate", TASK, {
    ruleSets: DELEGATE_SET,
    askFn: async () => {
      throw new JevError("timeout", "请求超时");
    },
    trainingLog: true,
    writeTraining: () => void wrote++,
  });
  assert.ok(res);
  assert.equal(res.line.verdict, "error");
  assert.equal(wrote, 0);
});

test("㊱ checkDispatch trainingLog：writer 抛异常被吞，verdict/violations 不受影响", async () => {
  const res = await checkDispatch("delegate", TASK, {
    ruleSets: DELEGATE_SET,
    askFn: TRAIN_ANSWERS,
    trainingLog: true,
    writeTraining: () => {
      throw new Error("disk full");
    },
  });
  assert.ok(res);
  assert.equal(res.line.verdict, "violation");
  assert.deepEqual(res.violations, ["R2: 任务无确定内容"]);
  assert.deepEqual(res.line.blocked, ["R2"]);
});

test("㊲ checkDispatch trainingLog：questions 携 criteria（配则透传）、probs 不受 auditProbabilities 门限", async () => {
  const ruleSets = {
    reviewer: {
      agentDesc: "a code-review agent",
      rules: [
        {
          id: "C1",
          instructions: "Does the task break backwards compatibility?",
          criteria: { true: "t", false: "f" },
          blockWhen: "above" as const,
          threshold: 0.6,
          message: "C1 违规",
        },
      ],
    },
  };
  const lines: DispatchTrainingLine[] = [];
  const res = await checkDispatch("reviewer", TASK, {
    ruleSets,
    auditProbabilities: true,
    trainingLog: true,
    writeTraining: (l) => lines.push(l as DispatchTrainingLine),
    askFn: async () => ({ model: "m", answers: { C1: { noul: 0.9 } }, usage: {} }),
  });
  assert.ok(res);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].questions[0].criteria, { true: "t", false: "f" });
  assert.deepEqual(lines[0].probs, { C1: 0.9 });
  // auditProbabilities 开时审计行亦带 probs（两开关互不影响）
  assert.deepEqual(res.line.probs, { C1: 0.9 });
});

test("㊳ loadRuleSets/_global：trainingLog 解析，缺省 false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const on = path.join(dir, "on.json");
  writeFileSync(
    on,
    JSON.stringify({ _global: { trainingLog: true }, delegate: { rules: [] } })
  );
  assert.equal(loadRuleSets(on).global.trainingLog, true);
  const off = path.join(dir, "off.json");
  writeFileSync(off, JSON.stringify({ delegate: { rules: [] } }));
  assert.equal(loadRuleSets(off).global.trainingLog, false);
});

test("㊴ checkDispatch trainingLog：noul 非有限数（NaN/Infinity）→ 训练行 probs 排除该规则，规则仍标 unknown（fail-open）", async () => {
  // 训练路径与审计路径同源取值：非有限数不入 probs，训练行不得携带 NaN/Infinity
  const askFn: AskFn = async () => ({
    model: "m",
    answers: { R1: { noul: 0.9 }, R2: { noul: NaN }, R3: { noul: Infinity }, R4: { noul: 0.1 } },
    usage: {},
  });
  const lines: DispatchTrainingLine[] = [];
  const res = await checkDispatch("delegate", TASK, {
    ruleSets: DELEGATE_SET,
    askFn,
    auditProbabilities: true,
    trainingLog: true,
    writeTraining: (l) => lines.push(l as DispatchTrainingLine),
  });
  assert.ok(res);
  assert.equal(lines.length, 1);
  const line = lines[0];
  // 非有限数被排除，训练行不含 NaN/Infinity
  assert.deepEqual(line.probs, { R1: 0.9, R4: 0.1 });
  assert.ok(!("R2" in line.probs) && !("R3" in line.probs));
  // 该规则仍按既有 fail-open 语义标 unknown、不拦
  assert.equal(res.line.rules!.R2, "unknown");
  assert.equal(res.line.rules!.R3, "unknown");
  assert.equal(line.verdict, "pass");
  assert.deepEqual(line.blocked, undefined);
  assert.deepEqual(res.violations, []);
});

// ── 自含问句库（_questions）＋ rules 引用解析 ──

test("㊵ loadRuleSets/_questions：自含问句载入为完整规则，并透传至 askFn 载荷", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: {
        W6: {
          label: "措辞含糊/越界（human note, ignored）",
          instructions: "Does the task contain ambiguous wording or invite scope creep?",
          criteria: { true: "ambiguous", false: "clear" },
          blockWhen: "above",
          threshold: 0.7,
          message: "W6 违规",
        },
      },
      worker: {
        agentDesc: "a worker",
        rules: ["W6"],
      },
    })
  );
  const rs = loadRuleSets(p);
  const w6 = rs.agents.worker.rules.find((r) => r.id === "W6")!;
  assert.equal(w6.instructions, "Does the task contain ambiguous wording or invite scope creep?");
  assert.deepEqual(w6.criteria, { true: "ambiguous", false: "clear" });
  assert.equal(w6.threshold, 0.7);
  assert.equal(w6.blockWhen, "above");
  assert.equal(w6.message, "W6 违规");
  // 求值载荷与规则直写形无异
  let asked: any;
  const res = await checkDispatch("worker", TASK, {
    ruleSets: rs.agents,
    askFn: async (params) => {
      asked = (params.questions as any).W6;
      return { model: "m", answers: { W6: { noul: 0.9 } }, usage: {} };
    },
  });
  assert.equal(asked.instructions, "Does the task contain ambiguous wording or invite scope creep?");
  assert.deepEqual(asked.criteria, { true: "ambiguous", false: "clear" });
  assert.ok(res);
  assert.equal(res.line.rules!.W6, "suspect");
  assert.deepEqual(res.violations, ["W6: W6 违规"]);
});

test("㊶ loadRuleSets：非法问句整条弃（空白 instructions／坏 blockWhen／非有限 threshold），引之则静默无规则", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: {
        Q1: { instructions: "   ", blockWhen: "below", threshold: 0.7 }, // 空白 instructions
        Q2: { instructions: "Q2?", blockWhen: "sideways", threshold: 0.7 }, // 坏 blockWhen
        Q3: { instructions: "Q3?", blockWhen: "below", threshold: NaN }, // 非有限 threshold
        Q4: { instructions: "Q4?", blockWhen: "below" }, // 缺 threshold
        Q5: { blockWhen: "below", threshold: 0.7 }, // 缺 instructions
        Q6: { instructions: "有效", blockWhen: "above", threshold: Infinity }, // 非有限 threshold
        OK: { instructions: "有效问句", blockWhen: "below", threshold: 0.5, message: "M" },
        BAD: "not-an-object",
      },
      worker: { rules: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "OK", "BAD"] },
    })
  );
  const rs = loadRuleSets(p);
  assert.deepEqual(rs.agents.worker.rules.map((r) => r.id), ["OK"]); // 唯有效者存
  assert.equal(rs.agents.worker.rules[0].instructions, "有效问句");
});

test("㊶-补 loadRuleSets：threshold 真为非有限数（JSON.parse 得 Infinity）→ Number.isFinite 守卫弃之", () => {
  // JSON.stringify 会把 NaN/Infinity 序列化为 null，被 typeof !== "number" 守卫拦下，
  // Number.isFinite 分支实则未覆盖。此处直写原始 JSON 文本，用 1e999 让
  // JSON.parse 产出真 Infinity（IEEE 754 上溢），直达 isFinite 守卫。
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    `{ "worker": { "agentDesc": "a worker", "rules": ["OVERFLOW"] },
       "_questions": { "OVERFLOW": { "instructions": "问?", "blockWhen": "below", "threshold": 1e999 } } }`
  );
  const rs = loadRuleSets(p);
  assert.deepEqual(rs.agents.worker.rules, []); // 非有限 threshold → 整条弃；引用之 → 组无规则
});

test("㊷ loadRuleSets：rules 引用项非字符串／未知 id／同组重复 → 皆静默弃（保首个、保序）；rules 非数组 → 无规则", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: {
        A: { instructions: "A?", blockWhen: "below", threshold: 0.5, message: "Ma" },
        B: { instructions: "B?", blockWhen: "below", threshold: 0.5, message: "Mb" },
      },
      worker: {
        rules: ["A", 42, { id: "A" }, "MISSING", "B", "A", "A"], // 非字符串/未知 id/重复项皆弃
      },
      ghost: { agentDesc: "g", rules: "not-an-array" }, // 非数组 → 无规则
    })
  );
  const rs = loadRuleSets(p);
  // 重复引用保首个、保序；唯未知/非字符串项弃之
  assert.deepEqual(rs.agents.worker.rules.map((r) => r.id), ["A", "B"]);
  assert.equal(rs.agents.ghost.agentDesc, "g");
  assert.deepEqual(rs.agents.ghost.rules, []); // 非数组 rules → 无规则
  // 旧版对象形 {id, question} 不再支持：对象项即非字符串 → 弃（上例已覆盖，此处证 agentDesc 同组共存）
});

test("㊸ loadRuleSets：同一规则之内联自含形与 id 引用形两档，解析后逐 agent 逐 rule 六字段全等", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const pick = (rs: ReturnType<typeof loadRuleSets>) =>
    Object.fromEntries(
      Object.entries(rs.agents).map(([agent, set]) => [
        agent,
        {
          agentDesc: set.agentDesc,
          rules: set.rules.map((r) => ({
            instructions: r.instructions,
            criteria: r.criteria,
            blockWhen: r.blockWhen,
            threshold: r.threshold,
            message: r.message,
          })),
        },
      ])
    );
  const inlineP = path.join(dir, "inline.json");
  writeFileSync(
    inlineP,
    JSON.stringify({
      reviewer: {
        agentDesc: "a reviewer",
        rules: ["C1", "C2"],
      },
      _questions: {
        C1: {
          instructions: "Does the task break backwards compatibility?",
          criteria: { true: "t", false: "f" },
          blockWhen: "above",
          threshold: 0.6,
          message: "C1 违规",
        },
        C2: {
          instructions: "Does the task name a concrete file path?",
          blockWhen: "below",
          threshold: 0.7,
          message: "C2 违规",
        },
      },
    })
  );
  const refP = path.join(dir, "ref.json");
  writeFileSync(
    refP,
    JSON.stringify({
      _questions: {
        Q001: {
          label: "向后兼容",
          instructions: "Does the task break backwards compatibility?",
          criteria: { true: "t", false: "f" },
          blockWhen: "above",
          threshold: 0.6,
          message: "C1 违规",
        },
        Q002: {
          instructions: "Does the task name a concrete file path?",
          blockWhen: "below",
          threshold: 0.7,
          message: "C2 违规",
        },
      },
      reviewer: {
        agentDesc: "a reviewer",
        rules: ["Q001", "Q002"],
      },
    })
  );
  assert.deepEqual(pick(loadRuleSets(refP)), pick(loadRuleSets(inlineP)));
});

test("㊹ loadRuleSets：_questions 不视作 agent；非法 _questions 值静默弃（fail-open）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  // 库整体非法（非对象）：问句尽弃，引之 → 组无规则，且不抛
  const p1 = path.join(dir, "q-not-object.json");
  writeFileSync(
    p1,
    JSON.stringify({
      _questions: 42,
      delegate: { rules: ["Q001"] },
    })
  );
  const rs1 = loadRuleSets(p1);
  assert.equal(rs1.agents["_questions"], undefined); // 不视作 agent
  assert.equal(rs1.agents["_global"], undefined); // _global 同例
  assert.equal(rs1.agents["_all"], undefined); // _all 同例
  assert.deepEqual(rs1.agents.delegate.rules, []); // 问句尽弃 → 无规则
  // 库中逐条非法：非对象条目、缺三硬性条件者 → 皆弃；合法者照常载入
  const p2 = path.join(dir, "q-bad-items.json");
  writeFileSync(
    p2,
    JSON.stringify({
      _questions: {
        Q1: "not-an-object",
        Q2: { instructions: 123, blockWhen: "below", threshold: 0.5 },
        Q3: { instructions: "Q3?", label: "only label + 非法 criteria 亦不效救" },
        // criteria 非法仅弃 criteria 本身，问句仍有效（可选字段，同 ⑲）
        Q4: { criteria: "bad", instructions: "有问", blockWhen: "above", threshold: 0.9, message: "M" },
        OK: { instructions: "有效问句", blockWhen: "above", threshold: 0.9, message: "M" },
      },
      worker: { agentDesc: "a worker", rules: ["Q4", "OK"] },
    })
  );
  const rs2 = loadRuleSets(p2);
  assert.equal(rs2.agents["_questions"], undefined);
  assert.deepEqual(rs2.agents.worker.rules.map((r) => r.id), ["Q4", "OK"]); // 非法者弃、引之无规则；合法者存
  assert.equal(rs2.agents.worker.rules[0].criteria, undefined); // 非法 criteria 静默弃，问句仍有效
});

// ── `_all` 全局规则组 ──

test("㊺ loadRuleSets/_all：字符串引用解析为 LoadedRules.all；_all 不视作 agent；_global/_questions 不受影响", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _global: { auditProbabilities: true },
      _questions: {
        G1: {
          instructions: "库中之问",
          blockWhen: "above",
          threshold: 0.5,
          message: "G1 违规",
        },
      },
      _all: {
        agentDesc: "此处不应被读",
        rules: ["G1"],
      },
      worker: { agentDesc: "a worker", rules: ["W1"] },
    })
  );
  const rs = loadRuleSets(p);
  assert.ok(rs.all);
  assert.deepEqual(
    rs.all.rules.map((r) => ({ ...r })),
    [
      {
        id: "G1",
        instructions: "库中之问",
        blockWhen: "above",
        threshold: 0.5,
        message: "G1 违规",
      },
    ]
  );
  assert.equal(rs.agents["_all"], undefined); // 不视作 agent
  assert.equal(rs.global.auditProbabilities, true); // _global 不受影响
  assert.ok("worker" in rs.agents); // 他组照常载入
});

test("㊻ loadRuleSets/_all：缺档无此键 → all 为 null；值非法（字符串/数组/条目坏）→ 静默弃为 null，他组照常", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const none = path.join(dir, "none.json");
  writeFileSync(none, JSON.stringify({ worker: { agentDesc: "a worker", rules: [] } }));
  assert.equal(loadRuleSets(none).all, null);
  assert.equal(loadRuleSets(none).agents["_all"], undefined);

  // 引用项坏 → 静默弃；弃尽 → all 为 null
  const bad = path.join(dir, "bad.json");
  writeFileSync(
    bad,
    JSON.stringify({
      _all: "not-an-object",
      worker: { agentDesc: "a worker", rules: [] },
    })
  );
  const rsBad = loadRuleSets(bad);
  assert.equal(rsBad.all, null);
  assert.ok(rsBad.agents.worker); // 他组照常载入（fail-open）

  const badRefs = path.join(dir, "bad-refs.json");
  writeFileSync(
    badRefs,
    JSON.stringify({
      _questions: { G1: { instructions: "有效", blockWhen: "below", threshold: 0.5, message: "M" } },
      _all: { rules: [42, "MISSING", { id: "X" }, "G1"] }, // 非字符串/未知/对象项皆弃，唯字符串有效引用存
    })
  );
  const rsRefs = loadRuleSets(badRefs);
  assert.ok(rsRefs.all);
  assert.deepEqual(rsRefs.all.rules.map((r) => r.id), ["G1"]);
});

test("㊼ checkDispatch：_all 与 agent 组并成一次请求（全局在前、agent 在后），blocked/violations 携全局 id", async () => {
  const ruleSets = {
    worker: {
      agentDesc: "a worker",
      rules: [{ id: "W1", instructions: "W?", blockWhen: "below" as const, threshold: 0.7, message: "W1 违规" }],
    },
  };
  const allRules: AgentRuleSet = {
    agentDesc: "",
    rules: [
      { id: "G1", instructions: "G1?", blockWhen: "above" as const, threshold: 0.6, message: "G1 违规" },
      { id: "G2", instructions: "G2?", blockWhen: "below" as const, threshold: 0.5, message: "G2 违规" },
    ],
  };
  let keys: string[] = [];
  const askFn: AskFn = async (params) => {
    keys = Object.keys(params.questions);
    return {
      model: "m",
      answers: { G1: { noul: 0.9 }, G2: { noul: 0.1 }, W1: { noul: 0.1 } },
      usage: {},
    };
  };
  const res = await checkDispatch("worker", TASK, { askFn, ruleSets, allRules });
  assert.deepEqual(keys, ["G1", "G2", "W1"]); // 全局在前、agent 在后；一次请求
  assert.ok(res);
  assert.deepEqual(Object.keys(res.line.rules!), ["G1", "G2", "W1"]);
  assert.equal(res.line.verdict, "violation"); // G1 suspect（0.9>0.6）＋ G2 fail（0.1<0.5）＋ W1 fail（0.1<0.7）
  assert.deepEqual(res.violations, ["G1: G1 违规", "G2: G2 违规", "W1: W1 违规"]); // 全局 id 直入违规文案
  assert.deepEqual(res.line.blocked, ["G1", "G2", "W1"]);
});

test("㊽ checkDispatch：同 id 既列 _all 又列组内 → 去重（全局在前），同一问句仅求值一次", async () => {
  // v0.8.0：问句自含后同一 id 即同一问句（同 instructions/threshold/message），
  // 无「agent 胜出」语义 —— 简单去重，重复引用不致重复发问
  const ruleSets = {
    worker: {
      agentDesc: "a worker",
      // ruleSets 类型为 Record<string, AgentRuleSet>（rules: RuleConfig[]）——此处须塞真
      // RuleConfig 而非问句 id 字符串：字符串无 instructions，会被 checkDispatch 之
      // 空白 instructions 过滤器静默弃，agent 侧 G1 副本不存在，去重分支实则未走到。
      // 唯塞与 _all 同 id 之合法 RuleConfig，下方断言才真验「同 id 去重」。
      rules: [
        { id: "G1", instructions: "同一问句", blockWhen: "below" as const, threshold: 0.9, message: "同一违规" },
      ],
    },
  };
  const allRules: AgentRuleSet = {
    agentDesc: "",
    rules: [
      { id: "G1", instructions: "同一问句", blockWhen: "below" as const, threshold: 0.9, message: "同一违规" },
      { id: "G2", instructions: "G2?", blockWhen: "below" as const, threshold: 0.5, message: "G2 违规" },
    ],
  };
  const questions: Record<string, any> = {};
  const askFn: AskFn = async (params) => {
    Object.assign(questions, params.questions);
    return {
      model: "m",
      answers: Object.fromEntries(Object.keys(params.questions).map((k) => [k, { noul: 0.3 }])),
      usage: {},
    };
  };
  const res = await checkDispatch("worker", TASK, { askFn, ruleSets, allRules });
  assert.deepEqual(Object.keys(questions), ["G1", "G2"]); // 去重以全局在前：G1 仍居 _all 序（首位），G2 随后；agent 组重复引用被弃
  assert.equal(Object.keys(questions).length, 2); // G1 仅一份，无重复问句
  assert.equal(questions.G1.instructions, "同一问句");
  assert.ok(res);
  assert.deepEqual(res.violations, ["G1: 同一违规", "G2: G2 违规"]); // G1 仅计一次（0.3<0.9 命中一次）
  assert.deepEqual(res.line.blocked, ["G1", "G2"]);
  assert.deepEqual(Object.keys(res.line.rules!), ["G1", "G2"]);
});

test("㊾ checkDispatch：无专属组之 agent ＋ _all → 受查，agentDesc 写死 a sub-agent（_all.agentDesc 不读）", async () => {
  const allRules: AgentRuleSet = {
    agentDesc: "此处不应被读",
    rules: [{ id: "G1", instructions: "G1?", blockWhen: "below" as const, threshold: 0.7, message: "G1 违规" }],
  };
  let state = "";
  const askFn: AskFn = async (params) => {
    state = params.state;
    return { model: "m", answers: { G1: { noul: 0.9 } }, usage: {} };
  };
  const res = await checkDispatch("some-agent-not-configured", TASK, { askFn, allRules });
  assert.ok(res);
  assert.equal(
    state,
    buildState("some-agent-not-configured", "a sub-agent", TASK) // 硬编码通用述语
  );
  assert.ok(!state.includes("此处不应被读")); // _all.agentDesc 不读
  assert.deepEqual(res.line.rules, { G1: "pass" });
});

test("㊿ checkDispatch：无组无 _all → null；_all 全为空白 instructions → null（防御路径）；agent 组空白但 _all 有效 → 仍查", async () => {
  let called = 0;
  const askFn: AskFn = async () => {
    called++;
    return { model: "m", answers: {}, usage: {} };
  };
  // 无组无 _all：null 且不发请求
  const r1 = await checkDispatch("worker", TASK, { askFn });
  assert.equal(r1, null);
  assert.equal(called, 0);

  // _all 规则 instructions 空白 → 全部无效 → null
  const blankAll: AgentRuleSet = {
    agentDesc: "",
    rules: [{ id: "G1", instructions: "   ", blockWhen: "below", threshold: 0.5, message: "x" }],
  };
  const r2 = await checkDispatch("worker", TASK, { askFn, allRules: blankAll });
  assert.equal(r2, null);
  assert.equal(called, 0);

  // agent 组规则全空白但 _all 有效 → 仍以 _all 之规则发问
  const blankAgent = {
    worker: {
      agentDesc: "a worker",
      rules: [{ id: "W1", instructions: "", blockWhen: "below", threshold: 0.5, message: "x" }],
    },
  };
  const goodAll: AgentRuleSet = {
    agentDesc: "",
    rules: [{ id: "G1", instructions: "G1?", blockWhen: "below", threshold: 0.5, message: "G1 违规" }],
  };
  const r3 = await checkDispatch("worker", TASK, { askFn, ruleSets: blankAgent, allRules: goodAll });
  assert.ok(r3);
  assert.equal(called, 1);
  assert.deepEqual(Object.keys(r3.line.rules!), ["G1"]);
});

test("㊿b checkDispatch：_all 之问句若被弃（非法）→ 引用静默消失，检查时跳过（fail-open，不拦不抛）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: {
        G1: { instructions: "库中之问", blockWhen: "below", threshold: 0.5, message: "G1 违规" },
        // G2 无 instructions → 整条被弃（v0.8.0 自含语义：非法问句在载入侧消失）
        G2: { blockWhen: "below", threshold: 0.5, message: "G2 违规" },
        W1: { instructions: "W?", blockWhen: "below", threshold: 0.7, message: "W1 违规" },
      },
      _all: { rules: ["G1", "G2"] },
      worker: { agentDesc: "a worker", rules: ["W1"] },
    })
  );
  const rs = loadRuleSets(p);
  assert.ok(rs.all);
  assert.deepEqual(rs.all.rules.map((r) => r.id), ["G1"]); // 非法问句整条弃 → 引用静默消失
  const askFn: AskFn = async (params) => {
    assert.deepEqual(Object.keys(params.questions), ["G1", "W1"]); // G2 跳过
    return { model: "m", answers: { G1: { noul: 0.9 }, W1: { noul: 0.9 } }, usage: {} };
  };
  const res = await checkDispatch("worker", TASK, { askFn, ruleSets: rs.agents, allRules: rs.all ?? undefined });
  assert.ok(res);
  assert.deepEqual(Object.keys(res.line.rules!), ["G1", "W1"]);
  assert.deepEqual(res.violations, []);
});

test("㊿c checkDispatch：agent 组注入同 id 而不同文之规则（防御路径）→ 去重保全局版，id 不重复入问句包", async () => {
  // 载入侧同 id 即同一问句，去重无歧义；唯测试可直接注入 ruleSets（防御路径）时
  // 同 id 两版并存 —— 语义定为全局在前去重（保全局版），与载入后引用同 id 之行为一致。
  let called = 0;
  const captured: Record<string, any> = {};
  const askFn: AskFn = async (params) => {
    called++;
    Object.assign(captured, params.questions);
    return { model: "m", answers: {}, usage: {} };
  };
  // agent 组同 id 规则（防御注入）：去重后仅全局版有效 → 仍发问
  const agentSet = {
    worker: {
      agentDesc: "a worker",
      rules: [{ id: "G1", instructions: "agent 版之问", blockWhen: "below" as const, threshold: 0.5, message: "agent 版违规" }],
    },
  };
  const allRules: AgentRuleSet = {
    agentDesc: "",
    rules: [{ id: "G1", instructions: "全局版之问", blockWhen: "below" as const, threshold: 0.9, message: "全局版违规" }],
  };
  const r1 = await checkDispatch("worker", TASK, { askFn, ruleSets: agentSet, allRules });
  assert.ok(r1);
  assert.equal(called, 1); // 去重后 G1 仍有效（全局版），照常发问
  assert.equal(captured.G1.instructions, "全局版之问"); // 全局在前去重，保全局版

  // 另证：id 唯一入问句包，无重复键（对象键天然唯一，此处证 blocked/violations 亦仅一份）
  called = 0;
  for (const k of Object.keys(captured)) delete captured[k];
  const allRules2: AgentRuleSet = {
    agentDesc: "",
    rules: [
      { id: "G1", instructions: "全局版之问", blockWhen: "below" as const, threshold: 0.9, message: "全局版违规" },
      { id: "G2", instructions: "G2?", blockWhen: "below" as const, threshold: 0.5, message: "G2 违规" },
    ],
  };
  const res = await checkDispatch("worker", TASK, {
    askFn: async (params) => {
      called++;
      Object.assign(captured, params.questions);
      return {
        model: "m",
        answers: Object.fromEntries(Object.keys(params.questions).map((k) => [k, { noul: 0.3 }])),
        usage: {},
      };
    },
    ruleSets: agentSet,
    allRules: allRules2,
  });
  assert.ok(res);
  assert.equal(called, 1);
  assert.deepEqual(Object.keys(captured), ["G1", "G2"]); // 去重以全局在前：G1 居 _all 序首位，agent 组重复引用被弃；各仅一份
  assert.equal(captured.G1.instructions, "全局版之问");
  assert.deepEqual(res.violations, ["G1: 全局版违规", "G2: G2 违规"]); // G1 保全局版（0.3<0.9 命中）
  assert.deepEqual(res.line.blocked, ["G1", "G2"]);
});
