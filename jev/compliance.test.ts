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

test("⑫ loadRuleSets：配置档整组载入（新 agent 加入、字段缺省填齐）、新规则 id 追加", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      delegate: {
        agentDesc: "a file-editing agent without shell access",
        rules: [
          {
            id: "R1",
            instructions:
              "Does the task give at least one concrete, explicit file path to create or modify?",
            blockWhen: "below",
            threshold: 0.95,
            message: "R1 改过的消息",
          },
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
  assert.equal(r1.instructions,
    "Does the task give at least one concrete, explicit file path to create or modify?");
  assert.equal(rs.agents.delegate.agentDesc, "a file-editing agent without shell access");
  assert.ok(rs.agents.delegate.rules.some((r) => r.id === "R9" && r.threshold === 0.5));
  assert.equal(rs.agents.worker.agentDesc, "a generic worker");
  assert.equal(rs.agents.worker.rules[0].threshold, 0.4);
  // 未给字段之缺省：blockWhen below、message 兜底
  assert.equal(rs.agents.worker.rules[0].blockWhen, "below");
  assert.equal(rs.agents.worker.rules[0].message, "规则 R1 未通过");
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

test("⑲ loadRuleSets：criteria 覆盖、prev 兜底与非法静默弃", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      delegate: {
        rules: [
          { id: "R1", criteria: { true: "has path", false: "no path" } },
          { id: "R2", criteria: "not-an-object" },
          { id: "R9", criteria: { true: "only true side" } },
        ],
      },
    })
  );
  const rs = loadRuleSets(p);
  const r1 = rs.agents.delegate.rules.find((r) => r.id === "R1")!;
  assert.deepEqual(r1.criteria, { true: "has path", false: "no path" }); // 配置档 criteria 覆盖
  const r2 = rs.agents.delegate.rules.find((r) => r.id === "R2")!;
  assert.equal(r2.criteria, undefined); // 内建无 criteria，且非法值静默弃之 → 仍无
  const r9 = rs.agents.delegate.rules.find((r) => r.id === "R9")!;
  assert.deepEqual(r9.criteria, { true: "only true side" }); // 单边判据原样保留
  // 内建未被就地改动
  assert.equal(DELEGATE.rules.find((r) => r.id === "R1")!.criteria, undefined);
});

test("⑳ checkDispatch：配置档 criteria 一路透传至 askFn 载荷", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      delegate: {
        rules: [
          { id: "R1", instructions: "Does the task name a path?", criteria: { true: "t", false: "f" } },
          { id: "R2", instructions: "Second question?" },
        ],
      },
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

// ── 顶层共享问句库（_questions）＋ 规则 question 引用 ──

test("㊵ loadRuleSets/_questions：规则引 question → 展开为库中 instructions/criteria，并透传至 askFn 载荷", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: {
        Q001: {
          label: "措辞含糊/越界",
          instructions: "Does the task contain ambiguous wording or invite scope creep?",
          criteria: { true: "ambiguous", false: "clear" },
        },
      },
      worker: {
        agentDesc: "a worker",
        rules: [
          {
            id: "W6",
            question: "Q001",
            blockWhen: "above",
            threshold: 0.7,
            message: "W6 违规",
          },
        ],
      },
    })
  );
  const rs = loadRuleSets(p);
  const w6 = rs.agents.worker.rules.find((r) => r.id === "W6")!;
  assert.equal(w6.instructions, "Does the task contain ambiguous wording or invite scope creep?");
  assert.deepEqual(w6.criteria, { true: "ambiguous", false: "clear" });
  assert.equal(w6.threshold, 0.7);
  assert.equal(w6.message, "W6 违规");
  assert.ok(!("question" in w6)); // 展开后不留引用痕
  // 载荷与内联形无异
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

test("㊶ loadRuleSets：question 可解析 → 以库为准，忽略该规则内联之 instructions/criteria（亦不被内建值回填）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: { Q001: { instructions: "库中之问", criteria: { true: "库 true" } } },
      delegate: {
        rules: [
          {
            id: "R1",
            question: "Q001",
            instructions: "内联之问（应被忽略）",
            criteria: { false: "内联 false（应被忽略）" },
            threshold: 0.5,
          },
        ],
      },
    })
  );
  const r1 = loadRuleSets(p).agents.delegate.rules.find((r) => r.id === "R1")!;
  assert.equal(r1.instructions, "库中之问");
  assert.deepEqual(r1.criteria, { true: "库 true" }); // 库中无 false 侧则无 false 侧，不回填内联
  assert.notEqual(r1.instructions, DELEGATE.rules[0].instructions); // 未被内建缺省回填
  assert.equal(r1.threshold, 0.5); // 阈值仍留规则自身
});

test("㊷ loadRuleSets：question 悬空 → 回退内联字段；再无内联则 instructions 空 → 检查时跳过（不拦不抛）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: { Q001: { instructions: "库中之问" } },
      worker: {
        agentDesc: "a worker",
        rules: [
          {
            id: "W1",
            question: "Q404",
            instructions: "内联之问",
            blockWhen: "below",
            threshold: 0.5,
            message: "W1 违规",
          },
          { id: "W2", question: "Q404", blockWhen: "below", threshold: 0.5, message: "W2 违规" },
        ],
      },
    })
  );
  const rs = loadRuleSets(p);
  assert.equal(rs.agents.worker.rules.find((r) => r.id === "W1")!.instructions, "内联之问");
  assert.equal(rs.agents.worker.rules.find((r) => r.id === "W2")!.instructions, ""); // 悬空且无内联 → 空
  // 空 instructions 之规则循既有 fail-open：不发问、不进审计、不拦
  const res = await checkDispatch("worker", TASK, {
    ruleSets: rs.agents,
    askFn: async (params) => {
      assert.deepEqual(Object.keys(params.questions), ["W1"]);
      return { model: "m", answers: { W1: { noul: 0.9 } }, usage: {} };
    },
  });
  assert.ok(res);
  assert.deepEqual(Object.keys(res.line.rules!), ["W1"]);
  assert.deepEqual(res.violations, []);
});

test("㊸ loadRuleSets：同一语义之内联形与引用形两档，解析后逐 agent 逐 rule 六字段全等", () => {
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
  const oldP = path.join(dir, "old.json");
  writeFileSync(
    oldP,
    JSON.stringify({
      reviewer: {
        agentDesc: "a reviewer",
        rules: [
          {
            id: "C1",
            instructions: "Does the task break backwards compatibility?",
            criteria: { true: "t", false: "f" },
            blockWhen: "above",
            threshold: 0.6,
            message: "C1 违规",
          },
          {
            id: "C2",
            instructions: "Does the task name a concrete file path?",
            blockWhen: "below",
            threshold: 0.7,
            message: "C2 违规",
          },
        ],
      },
    })
  );
  const newP = path.join(dir, "new.json");
  writeFileSync(
    newP,
    JSON.stringify({
      _questions: {
        Q001: {
          label: "向后兼容",
          instructions: "Does the task break backwards compatibility?",
          criteria: { true: "t", false: "f" },
        },
        Q002: { instructions: "Does the task name a concrete file path?" },
      },
      reviewer: {
        agentDesc: "a reviewer",
        rules: [
          { id: "C1", question: "Q001", blockWhen: "above", threshold: 0.6, message: "C1 违规" },
          { id: "C2", question: "Q002", blockWhen: "below", threshold: 0.7, message: "C2 违规" },
        ],
      },
    })
  );
  assert.deepEqual(pick(loadRuleSets(newP)), pick(loadRuleSets(oldP)));
});

test("㊹ loadRuleSets：_questions 不视作 agent；非法 _questions 值/条目静默弃（fail-open）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  // 库整体非法（非对象）：问句尽弃，引用悬空 → 回退内联/内建缺省，且不抛
  const p1 = path.join(dir, "q-not-object.json");
  writeFileSync(
    p1,
    JSON.stringify({
      _questions: 42,
      delegate: { rules: [{ id: "R1", question: "Q001" }] },
    })
  );
  const rs1 = loadRuleSets(p1);
  assert.equal(rs1.agents["_questions"], undefined); // 不视作 agent
  assert.equal(rs1.agents["_global"], undefined); // _global 同例
  assert.equal(rs1.agents["_all"], undefined); // _all 同例
  assert.equal(
    rs1.agents.delegate.rules.find((r) => r.id === "R1")!.instructions,
    "" // v0.7.0 起无内建缺省：悬空引用且无内联 → instructions 空 → 检查时跳过
  );
  // 库中逐条非法：非对象条目、instructions 非字符串、空条目、criteria 非法 → 皆弃
  const p2 = path.join(dir, "q-bad-items.json");
  writeFileSync(
    p2,
    JSON.stringify({
      _questions: {
        Q1: "not-an-object",
        Q2: { instructions: 123 },
        Q3: { label: "only label" },
        Q4: { criteria: "bad" },
      },
      worker: {
        agentDesc: "a worker",
        rules: [
          {
            id: "W1",
            question: "Q2",
            instructions: "内联之问",
            blockWhen: "below",
            threshold: 0.5,
            message: "W1 违规",
          },
        ],
      },
    })
  );
  const rs2 = loadRuleSets(p2);
  assert.equal(rs2.agents["_questions"], undefined);
  assert.equal(rs2.agents.worker.rules[0].instructions, "内联之问"); // 问句被弃 → 回退内联
  assert.equal(rs2.agents.worker.rules[0].criteria, undefined);
});

// ── `_all` 全局规则组 ──

test("㊺ loadRuleSets/_all：解析为 LoadedRules.all；_all 不视作 agent；_global/_questions 不受影响", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _global: { auditProbabilities: true },
      _questions: { Q001: { instructions: "库中之问" } },
      _all: {
        agentDesc: "此处不应被读",
        rules: [{ id: "G1", question: "Q001", blockWhen: "above", threshold: 0.5, message: "G1 违规" }],
      },
      worker: { agentDesc: "a worker", rules: [{ id: "W1", instructions: "W?" }] },
    })
  );
  const rs = loadRuleSets(p);
  assert.ok(rs.all);
  assert.deepEqual(
    rs.all.rules.map((r) => ({ ...r })),
    [
      {
        id: "G1",
        instructions: "库中之问", // question 引用已展开
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

  // 条目无 id → 静默弃；弃尽 → all 为 null
  const bad = path.join(dir, "bad.json");
  writeFileSync(
    bad,
    JSON.stringify({
      _all: "not-an-object",
      worker: { agentDesc: "a worker", rules: [{ id: "W1", instructions: "W?" }] },
    })
  );
  const rsBad = loadRuleSets(bad);
  assert.equal(rsBad.all, null);
  assert.ok(rsBad.agents.worker); // 他组照常载入（fail-open）

  const badEntries = path.join(dir, "bad-entries.json");
  writeFileSync(
    badEntries,
    JSON.stringify({
      _all: { rules: ["not-an-object", { instructions: "无 id" }, { id: 42 }, { id: "G1", instructions: "有效" }] },
    })
  );
  const rsEntries = loadRuleSets(badEntries);
  assert.ok(rsEntries.all);
  assert.deepEqual(rsEntries.all.rules.map((r) => r.id), ["G1"]);
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

test("㊽ checkDispatch：id 冲突 → agent 规则整条顶替全局规则（后者弃之，静默）", async () => {
  const ruleSets = {
    worker: {
      agentDesc: "a worker",
      rules: [{ id: "G1", instructions: "agent 版之问", blockWhen: "below" as const, threshold: 0.5, message: "agent 版违规" }],
    },
  };
  const allRules: AgentRuleSet = {
    agentDesc: "",
    rules: [
      { id: "G1", instructions: "全局版之问", blockWhen: "below" as const, threshold: 0.9, message: "全局版违规" },
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
  assert.deepEqual(Object.keys(questions), ["G2", "G1"]); // 未撞之全局规则在前（_all 序），agent 组规则在后（组内序）；G1 仅一份
  assert.equal(questions.G1.instructions, "agent 版之问"); // agent 规则胜出（全局版被弃）
  assert.ok(res);
  assert.deepEqual(res.violations, ["G2: G2 违规", "G1: agent 版违规"]); // G1 用 agent 版之 message/threshold（0.3<0.5 命中）；G2 0.3<0.5 亦命中
  assert.deepEqual(res.line.blocked, ["G2", "G1"]);
  assert.deepEqual(Object.keys(res.line.rules!), ["G2", "G1"]);
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

test("㊿ checkDispatch：无组无 _all → null；_all 全为空白 instructions → null；agent 组空白但 _all 有效 → 仍查", async () => {
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

test("㊿b checkDispatch：_all 之 question 悬空且无内联 → 检查时跳过（fail-open，不拦不抛）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-rules-"));
  const p = path.join(dir, "rules.json");
  writeFileSync(
    p,
    JSON.stringify({
      _questions: { Q001: { instructions: "库中之问" } },
      _all: {
        rules: [
          { id: "G1", question: "Q001", blockWhen: "below", threshold: 0.5, message: "G1 违规" },
          { id: "G2", question: "Q404", blockWhen: "below", threshold: 0.5, message: "G2 违规" },
        ],
      },
      worker: { agentDesc: "a worker", rules: [{ id: "W1", instructions: "W?" }] },
    })
  );
  const rs = loadRuleSets(p);
  assert.ok(rs.all);
  assert.equal(rs.all.rules.find((r) => r.id === "G1")!.instructions, "库中之问"); // 引用可解析
  assert.equal(rs.all.rules.find((r) => r.id === "G2")!.instructions, ""); // 悬空且无内联 → 空
  const askFn: AskFn = async (params) => {
    assert.deepEqual(Object.keys(params.questions), ["G1", "W1"]); // G2 跳过
    return { model: "m", answers: { G1: { noul: 0.9 }, W1: { noul: 0.9 } }, usage: {} };
  };
  const res = await checkDispatch("worker", TASK, { askFn, ruleSets: rs.agents, allRules: rs.all ?? undefined });
  assert.ok(res);
  assert.deepEqual(Object.keys(res.line.rules!), ["G1", "W1"]);
  assert.deepEqual(res.violations, []);
});

test("㊿c checkDispatch：agent 规则同 id 顶替 _all 且 agent 版 instructions 空白 → 全局版整条弃之、id 不入 questions（设计行为，勿『修复』）", async () => {
  // 设计行为：id 冲突先整条顶替（全局版弃之），再空白过滤；故 agent 版空白时该 id 整个消失，
  // 而非回退到全局版之问。勿误判为 bug 而改回「冲突时保留全局版」。
  let called = 0;
  const captured: Record<string, any> = {};
  const askFn: AskFn = async (params) => {
    called++;
    Object.assign(captured, params.questions);
    return { model: "m", answers: {}, usage: {} };
  };
  // agent 规则同 id 而 instructions 空白：顶替＋过滤后无有效规则 → null 且不发请求
  const blankAgent = {
    worker: {
      agentDesc: "a worker",
      rules: [{ id: "G1", instructions: "  ", blockWhen: "below" as const, threshold: 0.5, message: "x" }],
    },
  };
  const allRules: AgentRuleSet = {
    agentDesc: "",
    rules: [{ id: "G1", instructions: "全局版之问", blockWhen: "below" as const, threshold: 0.9, message: "全局版违规" }],
  };
  const r1 = await checkDispatch("worker", TASK, { askFn, ruleSets: blankAgent, allRules });
  assert.equal(r1, null);
  assert.equal(called, 0); // 唯一有效规则被滤空 → checkDispatch 返 null，不问询

  // 另设一条不冲突的全局规则：仅证冲突 id 不入 questions，其余照常
  called = 0;
  const allRules2: AgentRuleSet = {
    agentDesc: "",
    rules: [
      { id: "G1", instructions: "全局版之问", blockWhen: "below" as const, threshold: 0.9, message: "全局版违规" },
      { id: "G2", instructions: "G2?", blockWhen: "below" as const, threshold: 0.5, message: "G2 违规" },
    ],
  };
  const res = await checkDispatch("worker", TASK, { askFn, ruleSets: blankAgent, allRules: allRules2 });
  assert.ok(res);
  assert.equal(called, 1);
  assert.ok(!("G1" in captured)); // 整条顶替＋空白过滤：G1 不应回退到全局版，不入问句包
  assert.equal(captured.G2.instructions, "G2?");
  assert.deepEqual(Object.keys(res.line.rules!), ["G2"]);
});
