// warning-store.ts 单测：暂存/破坏性读取/未命中/容量逐出（纯逻辑，无 IO）。
import test from "node:test";
import assert from "node:assert/strict";
import { WarningStore } from "./warning-store.ts";

test("① stash/take 往返：暂存之文本原样取回", () => {
  const s = new WarningStore();
  s.stash("c1", "提示甲");
  s.stash("c2", "提示乙");
  assert.equal(s.take("c1"), "提示甲");
  assert.equal(s.take("c2"), "提示乙");
});

test("② take 破坏性：取走即删，同 id 二次取 undefined", () => {
  const s = new WarningStore();
  s.stash("c1", "提示");
  assert.equal(s.take("c1"), "提示");
  assert.equal(s.take("c1"), undefined);
});

test("③ 未命中 → undefined", () => {
  const s = new WarningStore();
  assert.equal(s.take("ghost"), undefined);
  s.stash("c1", "提示");
  assert.equal(s.take("ghost"), undefined);
  assert.equal(s.take("c1"), "提示"); // 未命中不影响既有暂存
});

test("④ 容量 100：满后插入逐出最旧、最新保留", () => {
  const s = new WarningStore();
  for (let i = 1; i <= 100; i++) s.stash(`c${i}`, `t${i}`);
  // 第 101 条挤掉 c1
  s.stash("c101", "t101");
  assert.equal(s.take("c1"), undefined);
  assert.equal(s.take("c2"), "t2"); // 次旧仍存
  assert.equal(s.take("c101"), "t101");
  // 连续插入持续滚动逐出：此刻余 98 条（c3..c100），再灌 2 条至满（c103/c104），
  // 第 101 条（c105）逐出最旧之 c3
  s.stash("c103", "t103");
  s.stash("c104", "t104");
  assert.equal(s.take("c3"), "t3"); // 未满不逐出
  s.stash("c105", "t105");
  assert.equal(s.take("c3"), undefined); // 满后插入逐出最旧
  assert.equal(s.take("c4"), "t4");
});

test("⑤ 同 id 重复 stash：后写覆盖先写（ Map 语义），不增容量", () => {
  const s = new WarningStore();
  s.stash("c1", "旧");
  s.stash("c1", "新");
  assert.equal(s.take("c1"), "新");
  // 覆盖不改变插入序位置：再灌 99 条后 c1 仍为最旧、被逐出
  for (let i = 2; i <= 100; i++) s.stash(`c${i}`, `t${i}`);
  s.stash("c101", "t101");
  assert.equal(s.take("c1"), undefined);
});
