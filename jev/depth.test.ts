// 思考深度调整纯逻辑单测，不访问 JEV 端点。
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDepthAdjustment,
  buildDepthQuestion,
  depthVerdict,
  levelToRung,
  parseThinkingDepthConfig,
  splitKnownThinkingSuffix,
  joinThinkingSuffix,
} from "./depth.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkDispatch, loadRuleSets } from "./compliance.ts";

test("四档映射与用户指定的升降档、边界钳制及 off", () => {
  assert.equal(levelToRung("minimal"), 1);
  assert.equal(levelToRung("low"), 1);
  assert.equal(levelToRung("medium"), 2);
  assert.equal(levelToRung("high"), 3);
  assert.equal(levelToRung("xhigh"), 3);
  assert.equal(levelToRung("max"), 4);
  assert.equal(levelToRung("off"), null);
  assert.equal(applyDepthAdjustment("high", 1), "max");
  assert.equal(applyDepthAdjustment("high", -1), "medium");
  assert.equal(applyDepthAdjustment("xhigh", -1), "medium");
  assert.equal(applyDepthAdjustment("minimal", 1), "medium");
  assert.equal(applyDepthAdjustment("low", -1), "low");
  assert.equal(applyDepthAdjustment("max", 1), "max");
  assert.equal(applyDepthAdjustment("off", 1), "off");
  assert.equal(applyDepthAdjustment("minimal", 0), "minimal");
});

test("已知 thinking 后缀仅在末段精确匹配时拆分，拼接先移除旧后缀", () => {
  assert.deepEqual(splitKnownThinkingSuffix("provider/model:high"), { base: "provider/model", level: "high" });
  assert.deepEqual(splitKnownThinkingSuffix("owner/name:tag"), { base: "owner/name:tag" });
  assert.deepEqual(splitKnownThinkingSuffix("model:HIGH"), { base: "model:HIGH" });
  assert.deepEqual(splitKnownThinkingSuffix("model:high:tag"), { base: "model:high:tag" });
  assert.deepEqual(splitKnownThinkingSuffix("model:"), { base: "model:" });
  assert.equal(joinThinkingSuffix("provider/model:xhigh", "medium"), "provider/model:medium");
  assert.equal(joinThinkingSuffix("owner/name:tag", "low"), "owner/name:tag:low");
});

test("D001 choice 阈值包含边界，缺失及非有限概率不调整", () => {
  assert.deepEqual(depthVerdict({ choice: { value: "higher", probabilities: { higher: 0.7 } } }, 0.7), {
    adjust: 1, answer: "higher", prob: 0.7,
  });
  assert.equal(depthVerdict({ choice: { value: "lower", probabilities: { lower: 0.699 } } }, 0.7).adjust, 0);
  assert.equal(depthVerdict({ choice: { value: "lower", probabilities: { lower: 0.8 } } }, 0.7).adjust, -1);
  assert.equal(depthVerdict({ choice: { value: "same", probabilities: { same: 1 } } }, 0.7).adjust, 0);
  assert.deepEqual(depthVerdict({ choice: { value: "higher", probabilities: {} } }, 0.7), {
    adjust: 0, answer: "higher", prob: null,
  });
  assert.equal(depthVerdict({ choice: { value: "higher", probabilities: { higher: NaN } } }, 0.7).adjust, 0);
  assert.equal(depthVerdict(undefined, 0.7).adjust, 0);
});

test("D001 问句含 anchor 与三条固定 criteria", () => {
  const question = buildDepthQuestion("xhigh");
  assert.equal(question.type, "choice");
  assert.ok(question.instructions.includes("`xhigh`"));
  assert.deepEqual(Object.keys(question.criteria ?? {}).sort(), ["higher", "lower", "same"]);
});

test("深度配置默认关闭，非法 anchor 忽略且非法 threshold 回退 0.7", () => {
  assert.deepEqual(parseThinkingDepthConfig(undefined), { enabled: false, threshold: 0.7 });
  assert.deepEqual(parseThinkingDepthConfig({ enabled: true, defaultAnchor: "high", threshold: 0.4 }), {
    enabled: true, defaultAnchor: "high", threshold: 0.4,
  });
  assert.deepEqual(parseThinkingDepthConfig({ enabled: true, defaultAnchor: "bogus", threshold: NaN }), {
    enabled: true, threshold: 0.7,
  });
  assert.equal(parseThinkingDepthConfig({ threshold: -1 }).threshold, 0.7);
  assert.equal(parseThinkingDepthConfig({ threshold: 1.1 }).threshold, 0.7);
  assert.equal(parseThinkingDepthConfig({ threshold: "0.5" }).threshold, 0.7);
});

test("深度配置载入且 D001 单独或与合规问句同批请求", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-depth-"));
  const file = path.join(dir, "rules.json");
  writeFileSync(file, JSON.stringify({
    _global: { thinkingDepth: { enabled: true, defaultAnchor: "high", threshold: 0.7 } },
    _questions: {
      Q1: { instructions: "Is the task clear?", blockWhen: "below", threshold: 0.5, message: "unclear" },
    },
    worker: { agentDesc: "worker", rules: ["Q1"] },
  }));
  const loaded = loadRuleSets(file);
  assert.deepEqual(loaded.global.thinkingDepth, { enabled: true, defaultAnchor: "high", threshold: 0.7 });
  let sent: Record<string, any> = {};
  const answer = { choice: { value: "higher", probabilities: { higher: 0.8 } } };
  const askFn = async (params: any) => {
    sent = params.questions;
    return { model: "mock", answers: { Q1: { noul: 0.9 }, D001: answer }, usage: {} };
  };
  const combined = await checkDispatch("worker", "task", {
    askFn, ruleSets: loaded.agents, allRules: loaded.all ?? undefined,
    depthAnchor: "high", depthThreshold: loaded.global.thinkingDepth.threshold,
  });
  assert.deepEqual(Object.keys(sent), ["Q1", "D001"]);
  assert.equal(combined?.depthAdjust, 1);
  assert.equal(combined?.line.depth?.answer, "higher");
  const depthOnly = await checkDispatch("unconfigured", "task", {
    askFn, ruleSets: {}, depthAnchor: "medium",
  });
  assert.deepEqual(Object.keys(sent), ["D001"]);
  assert.equal(depthOnly?.depthAdjust, 1);
  const missing = await checkDispatch("unconfigured", "task", {
    askFn: async () => ({ model: "mock", answers: {}, usage: {} }),
    ruleSets: {}, depthAnchor: "high",
  });
  assert.equal(missing?.depthAdjust, 0);
  assert.deepEqual(missing?.line.depth, {
    anchor: "high", adjust: 0, answer: null, prob: null, applied: false,
  });
  const failed = await checkDispatch("unconfigured", "task", {
    askFn: async () => { throw new Error("offline"); },
    ruleSets: {}, depthAnchor: "high",
  });
  assert.equal(failed?.line.verdict, "error");
  assert.equal(failed?.depthAdjust, 0);
  assert.equal(failed?.line.depth?.applied, false);
  assert.equal(await checkDispatch("unconfigured", "task", { ruleSets: {}, depthAnchor: "off" }), null);
});

test("规则条目/组/_questions 尽数损坏时深度配置仍独立载入，D001 照常单独成批", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-depth-broken-"));
  const file = path.join(dir, "rules.json");
  writeFileSync(file, JSON.stringify({
    _global: { thinkingDepth: { enabled: true, defaultAnchor: "medium", threshold: 0.6 } },
    // 问句库损坏：非对象（数组）→ 整库弃空
    _questions: [1, "Q1", null],
    // 组损坏：rules 混入非字符串与悬空编号 → 逐项静默弃，组内零规则；mode 非法亦弃
    worker: { agentDesc: "worker", rules: ["Q-missing", 42, null, { id: "Q1" }], mode: "bogus" },
    // 组损坏：整组非对象 → 弃
    badGroup: "not-an-object",
    // `_all` 损坏：rules 非数组 → 视为无
    _all: { rules: "nope" },
  }));
  const loaded = loadRuleSets(file);
  // 深度 standalone：规则全坏亦不影响 thinkingDepth
  assert.deepEqual(loaded.global.thinkingDepth, { enabled: true, defaultAnchor: "medium", threshold: 0.6 });
  assert.deepEqual(loaded.agents.worker?.rules, []);
  assert.equal(loaded.agents.worker?.mode, undefined);
  assert.equal(loaded.agents.badGroup, undefined);
  assert.equal(loaded.all, null);
  // 规则为零但深度有效：D001 单独成批，照常调整
  let sent: Record<string, any> = {};
  const askFn = async (params: any) => {
    sent = params.questions;
    return {
      model: "mock",
      answers: { D001: { choice: { value: "higher", probabilities: { higher: 0.8 } } } },
      usage: {},
    };
  };
  const res = await checkDispatch("worker", "task", {
    askFn,
    ruleSets: loaded.agents,
    allRules: loaded.all ?? undefined,
    depthAnchor: "medium",
    depthThreshold: loaded.global.thinkingDepth.threshold,
  });
  assert.deepEqual(Object.keys(sent), ["D001"]);
  assert.equal(res?.depthAdjust, 1);
});

test("整档缺失/坏 JSON/非对象顶层 → 深度关闭（fail-open，无配置可言）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-depth-garbage-"));
  const missing = path.join(dir, "absent.json");
  assert.equal(loadRuleSets(missing).global.thinkingDepth.enabled, false);
  const badJson = path.join(dir, "bad.json");
  writeFileSync(badJson, '{ "_global": { "thinkingDepth": { "enabled": true }');
  assert.equal(loadRuleSets(badJson).global.thinkingDepth.enabled, false);
  const nonObject = path.join(dir, "str.json");
  writeFileSync(nonObject, JSON.stringify("just a string"));
  assert.equal(loadRuleSets(nonObject).global.thinkingDepth.enabled, false);
});
