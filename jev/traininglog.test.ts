// traininglog.ts 单测：派单/ask 训练行构造、最佳努力写入（追加、坏路径静默吞）。
// 不触网络、不发真实请求。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  askTrainingLine,
  dispatchTrainingLine,
  monitorTrainingLine,
  trainingPath,
  writeTrainingLine,
} from "./traininglog.ts";

test("① dispatchTrainingLine：字段齐备、state 全量不截断、blocked 有则落/空则无", () => {
  const state = "The following is a task dispatched to a sub-agent…\n" + "字".repeat(500);
  const line = dispatchTrainingLine({
    agent: "delegate",
    state,
    questions: [
      { id: "R1", instructions: "q1" },
      { id: "R2", instructions: "q2", criteria: { true: "t", false: "f" } },
    ],
    probs: { R1: 0.9, R2: 0.2 },
    verdict: "violation",
    blocked: ["R2"],
  });
  assert.equal(line.source, "dispatch");
  assert.equal(line.agent, "delegate");
  assert.equal(line.state, state); // 全量，未截断
  assert.equal(line.state.length, state.length);
  assert.deepEqual(line.questions[1].criteria, { true: "t", false: "f" });
  assert.deepEqual(line.probs, { R1: 0.9, R2: 0.2 });
  assert.equal(line.verdict, "violation");
  assert.deepEqual(line.blocked, ["R2"]);
  assert.ok(line.ts.length > 0);

  const clean = dispatchTrainingLine({
    agent: "delegate",
    state: "s",
    questions: [],
    probs: {},
    verdict: "pass",
    blocked: [],
  });
  assert.ok(!("blocked" in clean)); // 空 blocked 不落键
});

test("② askTrainingLine：questions/answers 逐字、model 缺省 null、ts 有值", () => {
  const questions = { q1: { type: "noul", instructions: "x" } };
  const answers = { q1: { noul: 0.7 } };
  const line = askTrainingLine({
    model: "oc/jev-1.13-free",
    state: "材料文本",
    questions,
    answers,
  });
  assert.equal(line.source, "ask");
  assert.equal(line.model, "oc/jev-1.13-free");
  assert.equal(line.state, "材料文本");
  assert.deepEqual(line.questions, questions);
  assert.deepEqual(line.answers, answers);
  assert.ok(line.ts.length > 0);

  const noModel = askTrainingLine({ state: "s", questions: {}, answers: {} });
  assert.equal(noModel.model, null); // 缺省记 null
});

test("③ writeTrainingLine：追加一行 JSON（每行一条）、路径可注入", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-train-"));
  const p = path.join(dir, "training.jsonl");
  const first = askTrainingLine({ state: "s1", questions: {}, answers: {} });
  writeTrainingLine(first, p);
  writeTrainingLine(askTrainingLine({ state: "s2", questions: {}, answers: {} }), p);
  const rows = readFileSync(p, "utf8").trim().split("\n");
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0]), first);
  assert.equal(JSON.parse(rows[1]).state, "s2");
});

test("④ writeTrainingLine：坏路径静默吞，不外抛（fail-open，红线三）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-train-"));
  const bad = path.join(dir, "no", "such", "dir", "training.jsonl"); // 父目录不存在
  assert.doesNotThrow(() =>
    writeTrainingLine(askTrainingLine({ state: "s", questions: {}, answers: {} }), bad)
  );
});

test("⑤ trainingPath：默认落 ~/.pi/agent/jev-comp/training.jsonl（与 audit 同族）", () => {
  assert.ok(
    trainingPath().endsWith(path.join(".pi", "agent", "jev-comp", "training.jsonl"))
  );
});

test("⑥ monitorTrainingLine：source=monitor、signal/state/questions/probs/verdict 齐备、ts 有值", () => {
  const questions = [
    { id: "M001", instructions: "stall?", criteria: { true: "t", false: "f" } },
    { id: "M004", instructions: "progress?" },
  ];
  const line = monitorTrainingLine({
    agent: "worker",
    signal: "timeline",
    state: "The following is a runtime monitoring snapshot…",
    questions,
    probs: { M001: 0.2, M004: 0.9 },
    verdict: "alert",
  });
  assert.equal(line.source, "monitor");
  assert.equal(line.agent, "worker");
  assert.equal(line.signal, "timeline");
  assert.equal(line.state, "The following is a runtime monitoring snapshot…");
  assert.deepEqual(line.questions, questions);
  assert.deepEqual(line.probs, { M001: 0.2, M004: 0.9 });
  assert.equal(line.verdict, "alert");
  assert.ok(line.ts.length > 0);
  // 三元 verdict 收窄：alert/ok/unknown 皆合法，越界类型编译期即拒
  const okLine = monitorTrainingLine({
    agent: "worker",
    signal: "candidate",
    state: "s",
    questions: [],
    probs: {},
    verdict: "ok",
  });
  assert.equal(okLine.verdict, "ok");
});
