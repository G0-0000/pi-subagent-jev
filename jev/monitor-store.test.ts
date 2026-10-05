// monitor-store.ts 单测：state 取或建、noteActivity 工具边界语义、bash 计时、
// addCall 环形缓冲与去重、markChecked、claim 窗口去重、FIFO 容量、drop。纯逻辑，零 IO。
import test from "node:test";
import assert from "node:assert/strict";
import { MonitorStore } from "./monitor-store.ts";
import { dueChecks, type MonitorConfig } from "./monitor.ts";

const CFG: MonitorConfig = {
  enabled: true,
  bashFirstCheckMs: 300_000,
  bashRecheckMs: 600_000,
  sweepIntervalMs: 600_000,
  maxCallsPerEval: 6,
  maxCharsPerCall: 800,
  maxStateChars: 8_000,
};

const rec = (tool: string, preview: string, isError = false, ts = 0) => ({
  tool,
  preview,
  isError,
  ts,
});

test("① state：取或建——首建记 agent/task/startedAt，已存者不动其 agent/task", () => {
  const s = new MonitorStore();
  const st = s.state("r1", "worker", "做某事", 100);
  assert.equal(st.agent, "worker");
  assert.equal(st.task, "做某事");
  assert.equal(st.startedAt, 100);
  const again = s.state("r1", "other", "别的", 200);
  assert.equal(again.agent, "worker"); // 已存不改
  assert.equal(again.task, "做某事");
  assert.equal(again, st); // 同一对象
});

test("② state：容量 100 满则逐出最旧（FIFO）", () => {
  const s = new MonitorStore(3);
  s.state("a", "x", "", 1);
  s.state("b", "x", "", 2);
  s.state("c", "x", "", 3);
  s.state("d", "x", "", 4); // 满：逐出 a
  const ids = [...s.entries()].map(([k]) => k);
  assert.deepEqual(ids, ["b", "c", "d"]);
});

test("③ noteActivity：非 bash 之 currentTool 清空运行中 bash 计时（工具边界）", () => {
  const s = new MonitorStore();
  s.noteActivity("r1", "worker", "", "bash", "c1", 100);
  assert.equal(s.state("r1", "u", "", 0).bashCalls.length, 1);
  s.noteActivity("r1", "worker", "", "read", undefined, 200);
  assert.equal(s.state("r1", "u", "", 0).bashCalls.length, 0);
  assert.equal(s.state("r1", "u", "", 0).lastActivityAt, 200);
});

test("④ noteActivity：bash 新 toolCallId 替换在跑者；lastActivityAt 取最大", () => {
  const s = new MonitorStore();
  s.noteActivity("r1", "worker", "", "bash", "c1", 100);
  s.noteActivity("r1", "worker", "", "bash", "c1", 150); // 同调用：不另起
  assert.deepEqual(s.state("r1", "u", "", 0).bashCalls.map((b) => b.toolCallId), ["c1"]);
  s.noteActivity("r1", "worker", "", "bash", "c2", 200); // 新调用：替换
  assert.deepEqual(s.state("r1", "u", "", 0).bashCalls.map((b) => b.toolCallId), ["c2"]);
  assert.equal(s.state("r1", "u", "", 0).lastActivityAt, 200);
});

test("⑤ noteBashStart：回推 startedAt 取较小者；无计时则补记", () => {
  const s = new MonitorStore();
  s.noteActivity("r1", "worker", "", "bash", "c1", 300);
  s.noteBashStart("r1", "c1", 100); // 控制事件携 duration 回推
  assert.equal(s.state("r1", "u", "", 0).bashCalls[0].startedAt, 100);
  s.noteBashStart("r1", "c1", 150); // 较晚者不弃前
  assert.equal(s.state("r1", "u", "", 0).bashCalls[0].startedAt, 100);
  s.noteBashStart("r1", "c9", 50);
  assert.equal(s.state("r1", "u", "", 0).bashCalls.length, 2);
});

test("⑥ markBashChecked：记 checkedAt（指定与未指定 toolCallId 两路）", () => {
  const s = new MonitorStore();
  s.noteActivity("r1", "worker", "", "bash", "c1", 100);
  s.markBashChecked("r1", "c1", 400);
  assert.equal(s.state("r1", "u", "", 0).bashCalls[0].checkedAt, 400);
  s.markBashChecked("r1", undefined, 500);
  assert.equal(s.state("r1", "u", "", 0).bashCalls[0].checkedAt, 500);
});

test("⑦ addCall：环形缓冲 32 满则逐出最旧；与最新一条全同者跳过（transcript 尾重叠去重）", () => {
  const s = new MonitorStore();
  for (let i = 0; i < 35; i++) s.addCall("r1", rec("bash", `cmd ${i}`, false, i));
  const st = s.state("r1", "u", "", 0);
  assert.equal(st.recentCalls.length, 32); // 满而有序
  assert.equal(st.recentCalls[0].preview, "cmd 3"); // 最旧 3 条被逐出
  s.addCall("r1", rec("bash", "cmd 34", false, 34)); // 与最新全同 → 跳过
  assert.equal(s.state("r1", "u", "", 0).recentCalls.length, 32);
  s.addCall("r1", rec("bash", "cmd 34", true, 34)); // isError 异 → 入（满则逐出最旧）
  const after = s.state("r1", "u", "", 0).recentCalls;
  assert.equal(after.length, 32);
  assert.equal(after[after.length - 1].isError, true);
});

test("⑧ addCall：lastActivityAt 取最大", () => {
  const s = new MonitorStore();
  s.state("r1", "u", "", 100);
  s.addCall("r1", rec("read", "x", false, 50)); // 较早 ts 不回退
  assert.equal(s.state("r1", "u", "", 0).lastActivityAt, 100);
  s.addCall("r1", rec("read", "y", false, 300));
  assert.equal(s.state("r1", "u", "", 0).lastActivityAt, 300);
});

test("⑨ markChecked / drop：记 lastCheckAt；drop 删除", () => {
  const s = new MonitorStore();
  s.state("r1", "u", "", 100);
  s.markChecked("r1", 400);
  assert.equal(s.state("r1", "u", "", 0).lastCheckAt, 400);
  s.drop("r1");
  const st = s.state("r1", "u", "", 0); // 重建
  assert.equal(st.lastCheckAt, undefined);
  assert.equal(st.startedAt, 0);
});

test("⑩ claim：同 key 窗口内不重触发、过窗可再触发、异 key 互不影响", () => {
  const s = new MonitorStore();
  assert.equal(s.claim("r1", "repeat_failure:0", 100, 600_000), true);
  assert.equal(s.claim("r1", "repeat_failure:0", 200, 600_000), false); // 窗口内
  assert.equal(s.claim("r1", "repeat_failure:0", 700_000, 600_000), true); // 已过窗
  assert.equal(s.claim("r1", "loop:1", 200, 600_000), true); // 异 key
});

test("⑪ claim：去重键容量 50 满则逐出最旧（被逐出之旧键可再 claim）", () => {
  const s = new MonitorStore();
  for (let i = 0; i < 50; i++) assert.equal(s.claim("r1", `k${i}`, 0, 1_000_000), true);
  s.claim("r1", "k50", 0, 1_000_000); // 满：逐出 k0
  const st = s.state("r1", "u", "", 0);
  assert.equal(st.dedupeKeys.length, 50);
  assert.ok(!st.dedupeKeys.some((d) => d.key === "k0"));
  assert.equal(s.claim("r1", "k0", 10, 1_000_000), true); // 旧键已逐出，可再触发
});

test("⑫ 集成：noteActivity + noteBashStart + dueChecks 假时钟走完首查→复询之时间线", () => {
  const s = new MonitorStore();
  // t=300000：控制事件 bash c1 已运行 3 分钟（duration 回推起点 0）
  s.noteActivity("r1", "worker", "", "bash", "c1", 300_000);
  s.noteBashStart("r1", "c1", 0);
  let st = s.state("r1", "u", "", 0);
  assert.deepEqual(dueChecks(st, 299_999, CFG), []); // 未到首查
  // startedAt=300000（noteActivity 建表）→ 首查到点而 sweep 未到
  assert.deepEqual(dueChecks(st, 300_000, CFG), [{ kind: "bash_first", toolCallId: "c1" }]);
  s.markChecked("r1", 300_000);
  s.markBashChecked("r1", "c1", 300_000);
  st = s.state("r1", "u", "", 0);
  assert.deepEqual(dueChecks(st, 899_999, CFG), []);
  assert.deepEqual(dueChecks(st, 900_000, CFG), [
    { kind: "bash_recheck", toolCallId: "c1" },
    { kind: "sweep" },
  ]);
  // bash 结束（边界事件 currentTool=read）→ 不再首查/复询；唯剩巡检
  //（久无活动且证据枯竭之 run 由 evaluate 按 sweepIntervalMs 剪枝）
  s.noteActivity("r1", "worker", "", "read", undefined, 900_000);
  st = s.state("r1", "u", "", 0);
  assert.deepEqual(dueChecks(st, 900_001, CFG), [{ kind: "sweep" }]);
});

test("⑬ 成败皆记：bash 首查于求值入口记 checkedAt（证据有无皆然），首查不重演、复询按 bashRecheckMs", () => {
  const s = new MonitorStore();
  s.noteActivity("r1", "worker", "t", "bash", "c1", 0);
  s.noteBashStart("r1", "c1", 0);
  let st = s.state("r1", "u", "", 0);
  assert.deepEqual(dueChecks(st, CFG.bashFirstCheckMs, CFG), [{ kind: "bash_first", toolCallId: "c1" }]);
  // 求值入口即记（不等证据）——复刻接线 evaluate 之 markBashChecked(runId, toolCallId, now) 时机
  s.markBashChecked("r1", "c1", CFG.bashFirstCheckMs);
  s.markChecked("r1", CFG.bashFirstCheckMs);
  // 证据为空（零调用入缓冲）：首查仍不重演
  st = s.state("r1", "u", "", 0);
  assert.deepEqual(dueChecks(st, CFG.bashFirstCheckMs + 30_000, CFG), []);
  // 直至 bashRecheckMs 届满方出复询（同刻巡检到点亦随行——dueChecks 之既有语义）
  const due2 = dueChecks(st, CFG.bashFirstCheckMs + CFG.bashRecheckMs, CFG);
  assert.ok(due2.some((d) => d.kind === "bash_recheck" && d.toolCallId === "c1"));
  assert.ok(!due2.some((d) => d.kind === "bash_first")); // 首查不重演为要
});
