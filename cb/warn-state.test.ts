// warn-state.ts 单测：落盘/破坏性读取/TTL 过期/容量 FIFO/纯函数剪枝（临时目录，零真实配置）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WARN_TTL_MS,
  isExpired,
  parseWarnEntry,
  prunePlan,
  takeWarning,
  warnDir,
  writeWarning,
} from "./warn-state.ts";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "jev-warn-"));
}

test("① write/take 往返：取回原文并删档，二次取无", () => {
  const dir = tempDir();
  writeWarning(dir, "tu_1", "提示甲", { now: 1000 });
  assert.equal(takeWarning(dir, "tu_1", { now: 1000 }), "提示甲");
  assert.equal(takeWarning(dir, "tu_1", { now: 1000 }), undefined);
  assert.deepEqual(readdirSync(warnDir(dir)), []);
});

test("② 过期：age 达 TTL 即死，取回 undefined 且档已清", () => {
  const dir = tempDir();
  writeWarning(dir, "tu_1", "提示", { now: 1000 });
  assert.equal(takeWarning(dir, "tu_1", { now: 1000 + WARN_TTL_MS }), undefined);
  assert.deepEqual(readdirSync(warnDir(dir)), []);
  // 边界前一刻仍活
  writeWarning(dir, "tu_2", "提示乙", { now: 1000 });
  assert.equal(takeWarning(dir, "tu_2", { now: 1000 + WARN_TTL_MS - 1 }), "提示乙");
});

test("③ 未命中键 → undefined，不影响他键", () => {
  const dir = tempDir();
  writeWarning(dir, "tu_1", "甲", { now: 1 });
  assert.equal(takeWarning(dir, "ghost", { now: 1 }), undefined);
  assert.equal(takeWarning(dir, "tu_1", { now: 1 }), "甲");
});

test("④ 容量确界：容量 3 时写第 4 条逐出最旧", () => {
  const dir = tempDir();
  writeWarning(dir, "k1", "1", { now: 1, capacity: 3 });
  writeWarning(dir, "k2", "2", { now: 2, capacity: 3 });
  writeWarning(dir, "k3", "3", { now: 3, capacity: 3 });
  writeWarning(dir, "k4", "4", { now: 4, capacity: 3 });
  assert.equal(takeWarning(dir, "k1", { now: 4 }), undefined);
  assert.equal(takeWarning(dir, "k2", { now: 4 }), "2");
  assert.equal(takeWarning(dir, "k4", { now: 4 }), "4");
});

test("⑤ 同键覆写：不增条目，取最新文案", () => {
  const dir = tempDir();
  writeWarning(dir, "k1", "旧", { now: 1 });
  writeWarning(dir, "k1", "新", { now: 2 });
  assert.equal(readdirSync(warnDir(dir)).length, 1);
  assert.equal(takeWarning(dir, "k1", { now: 2 }), "新");
});

test("⑥ isExpired 边界：ts 非有限数视作过期", () => {
  assert.equal(isExpired(1000, 1000, 3600), false);
  assert.equal(isExpired(1000, 4599, 3600), false);
  assert.equal(isExpired(1000, 4600, 3600), true);
  assert.equal(isExpired(Number.NaN, 1, 3600), true);
});

test("⑦ parseWarnEntry：坏 JSON/缺键/坏 ts 皆 null", () => {
  assert.equal(parseWarnEntry("not json"), null);
  assert.equal(parseWarnEntry("[]"), null);
  assert.equal(parseWarnEntry("{}"), null);
  assert.equal(parseWarnEntry(JSON.stringify({ key: "k", text: "t" })), null);
  assert.equal(parseWarnEntry(JSON.stringify({ key: "k", text: "t", ts: "1" })), null);
  assert.deepEqual(parseWarnEntry(JSON.stringify({ key: "k", text: "t", ts: 1 })), {
    key: "k",
    text: "t",
    ts: 1,
  });
});

test("⑧ prunePlan：先清过期，再按 ts 升序删至容量留位", () => {
  const entries = [
    { file: "a.json", ts: 1 },
    { file: "b.json", ts: 2 },
    { file: "c.json", ts: 3 },
    { file: "d.json", ts: Number.NaN },
  ];
  // 容量 3、写入前须留一位：现存有效 3 条 → 删最旧 1 条；d 过期亦删
  assert.deepEqual(prunePlan(entries, 10, 3600, 3), ["d.json", "a.json"]);
  // 容量充裕时只清过期
  assert.deepEqual(prunePlan(entries, 10, 3600, 100), ["d.json"]);
});
