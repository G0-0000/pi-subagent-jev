// monitor.ts 单测：loadMonitorConfig、normalizePreview、detectLoop、detectRepeatFailures、
// excerpt、buildMonitorState、monitorVerdict、formatAlert、dueChecks、parseFleetTranscript。
// 全部纯逻辑：注入假时钟/概率，不发任何真实 API 调用。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMonitorState,
  dueChecks,
  excerpt,
  formatAlert,
  loadMonitorConfig,
  monitorVerdict,
  normalizePreview,
  detectLoop,
  detectRepeatFailures,
  parseControlEvent,
  parseAsyncTranscript,
  parseTranscriptEvidence,
  extractAsyncTask,
  parseFleetTranscript,
  DEFAULT_MONITOR_CONFIG,
  MONITOR_QUESTIONS,
  type MonitorConfig,
  type ToolCallRec,
} from "./monitor.ts";
import type { MonitorState } from "./monitor-store.ts";

// 小阈值配置，便于截断类断言
const SMALL: MonitorConfig = {
  enabled: true,
  bashFirstCheckMs: 300_000,
  bashRecheckMs: 600_000,
  sweepIntervalMs: 600_000,
  maxCallsPerEval: 3,
  maxCharsPerCall: 40,
  maxStateChars: 200,
};

test("① loadMonitorConfig：合法档全字段解析", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-mon-"));
  const p = path.join(dir, "monitor.json");
  writeFileSync(
    p,
    JSON.stringify({
      enabled: true,
      bashFirstCheckMs: 60_000,
      bashRecheckMs: 120_000,
      sweepIntervalMs: 180_000,
      maxCallsPerEval: 8,
      maxCharsPerCall: 400,
      maxStateChars: 4000,
    })
  );
  const cfg = loadMonitorConfig(p);
  assert.deepEqual(cfg, {
    enabled: true,
    bashFirstCheckMs: 60_000,
    bashRecheckMs: 120_000,
    sweepIntervalMs: 180_000,
    maxCallsPerEval: 8,
    maxCharsPerCall: 400,
    maxStateChars: 4000,
  });
});

test("② loadMonitorConfig：档缺失／坏 JSON／顶层非对象 → null（禁用，fail-open）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-mon-"));
  assert.equal(loadMonitorConfig(path.join(dir, "nope.json")), null);
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.equal(loadMonitorConfig(bad), null);
  const arr = path.join(dir, "arr.json");
  writeFileSync(arr, "[1,2,3]");
  assert.equal(loadMonitorConfig(arr), null);
  const num = path.join(dir, "num.json");
  writeFileSync(num, "42");
  assert.equal(loadMonitorConfig(num), null);
});

test("③ loadMonitorConfig：enabled 缺省 false；非法字段逐字段回退缺省", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-mon-"));
  const p = path.join(dir, "partial.json");
  writeFileSync(
    p,
    JSON.stringify({
      enabled: "yes", // 非字面 true → false
      bashFirstCheckMs: -5, // 非正 → 缺省
      bashRecheckMs: "abc", // 非数 → 缺省
      sweepIntervalMs: NaN, // 非有限 → 缺省
      maxCallsPerEval: 10,
    })
  );
  const cfg = loadMonitorConfig(p)!;
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.bashFirstCheckMs, DEFAULT_MONITOR_CONFIG.bashFirstCheckMs);
  assert.equal(cfg.bashRecheckMs, DEFAULT_MONITOR_CONFIG.bashRecheckMs);
  assert.equal(cfg.sweepIntervalMs, DEFAULT_MONITOR_CONFIG.sweepIntervalMs);
  assert.equal(cfg.maxCallsPerEval, 10); // 合法者不动
  assert.equal(cfg.maxCharsPerCall, DEFAULT_MONITOR_CONFIG.maxCharsPerCall);
});

test("④ normalizePreview：数字/路径/空白/大小写差异归一后相等", () => {
  const a = normalizePreview("  npm  test --run 42 /home/g0/proj/x.ts  ");
  const b = normalizePreview("npm test --run 99 ~/other/y.ts");
  assert.equal(a, b);
  assert.equal(normalizePreview("A  B"), "a b");
  // 不同命令仍不相等
  assert.notEqual(normalizePreview("npm test"), normalizePreview("npm build"));
});

const rec = (tool: string, preview: string, isError = false, ts = 0): ToolCallRec => ({
  tool,
  preview,
  isError,
  ts,
});

test("⑤ detectLoop：同工具同命令 ≥3 次（数字差异忽略）→ 候选；不足 3 或命令实质不同 → 否", () => {
  assert.equal(
    detectLoop([rec("bash", "grep foo /a/1.txt"), rec("bash", "grep foo /a/2.txt"), rec("bash", "grep foo /a/3.txt")]),
    true // 路径数字差异被归一
  );
  assert.equal(
    detectLoop([rec("bash", "ls /a"), rec("bash", "ls /a"), rec("read", "ls /a")]),
    false // 工具不同
  );
  assert.equal(
    detectLoop([rec("bash", "ls /a"), rec("bash", "ls /a")]),
    false // 仅 2 次：正常重试
  );
});

test("⑤b detectLoop：数字差异归一后相等（视为同命令）；步骤数字亦然；非数字文件名差异识破", () => {
  assert.equal(
    detectLoop([rec("bash", "step 1"), rec("bash", "step 2"), rec("bash", "step 3")]),
    true // 数字归一后逐字相等 → 候选
  );
  assert.equal(
    detectLoop([rec("bash", "cat a.ts"), rec("bash", "cat b.ts"), rec("bash", "cat c.ts")]),
    false // 文件名差异（非数字）→ 非循环
  );
});

test("⑥ detectRepeatFailures：同工具同错误 ≥3 次且无条件变化 → 候选；条件有变/成功混杂 → 否", () => {
  assert.equal(
    detectRepeatFailures([
      rec("bash", "npm test", true),
      rec("bash", "npm test", true),
      rec("bash", "npm test", true),
    ]),
    true
  );
  assert.equal(
    detectRepeatFailures([
      rec("bash", "npm test", true),
      rec("bash", "npm test", true),
      rec("bash", "npm test --fix", true), // 条件已变后仅 2 连
      rec("bash", "npm test --fix", true),
    ]),
    false
  );
  assert.equal(
    detectRepeatFailures([
      rec("bash", "npm test", true),
      rec("bash", "npm test", false), // 中间成功
      rec("bash", "npm test", true),
      rec("bash", "npm test", true),
    ]),
    false
  );
  assert.equal(
    detectRepeatFailures([rec("bash", "npm test", true), rec("bash", "npm test", true)]),
    false // 不足 3
  );
});

test("⑦ excerpt：短文本原样；长文本首尾保留、中段截断标记、总长 ≤ 上限", () => {
  assert.equal(excerpt("short", 10), "short");
  const long = "x".repeat(100);
  const e = excerpt(long, 20);
  assert.ok(e.includes("…[截断]…"));
  assert.ok(Array.from(e).length <= 20);
  assert.ok(e.startsWith("x"));
  assert.ok(e.endsWith("x"));
});

test("⑧ buildMonitorState：模板句 ＋ 任务原文逐字（中文不动）＋ 最近调用条数与节录上限", () => {
  const task = "修改 /home/g0/ttt/foo.md 中的错误。";
  const calls = [
    rec("bash", "cat " + "a".repeat(100), false, 1),
    rec("read", "b".repeat(100), true, 2),
    rec("bash", "cc", false, 3),
    rec("edit", "dd", false, 4), // 超出 maxCallsPerEval=3，应被切掉
  ];
  // state 上限放大，使任务原文与 3 条节录俱在（截断语义另见 ⑨）
  const cfg = { ...SMALL, maxStateChars: 4_000 };
  const s = buildMonitorState("worker", task, calls, cfg);
  assert.ok(s.startsWith('The following is a runtime monitoring snapshot of a sub-agent named "worker".'));
  assert.ok(s.includes(task));
  assert.ok(s.includes("#1 read (error)")); // 取最近 3 条（最旧之 bash cat 被切）
  assert.ok(s.includes("#2 bash (ok) cc"));
  assert.ok(s.includes("#3 edit (ok) dd"));
  assert.ok(!s.includes("cat aaaaaaaa")); // 最旧者不入
  for (const line of s.split("\n")) {
    if (line.startsWith("#")) assert.ok(Array.from(line).length <= SMALL.maxCharsPerCall + 20); // 节录受控
  }
  assert.ok(Array.from(s).length <= cfg.maxStateChars);
});

test("⑨ buildMonitorState：无调用记 (no tool calls recorded)；超长在 state 级截断", () => {
  const s = buildMonitorState("a", "短任务", [], SMALL);
  assert.ok(s.includes("(no tool calls recorded)"));
  const big = buildMonitorState("a", "字".repeat(500), [], SMALL);
  assert.ok(Array.from(big).length <= SMALL.maxStateChars);
  assert.ok(big.includes("…[截断]…"));
});

test("⑩ monitorVerdict：below 低于阈 / above 高于阈 → alert 且 hits 携信号", () => {
  // M001 below 0.6、M004 below 0.6；M002/M003 above 0.7
  const r = monitorVerdict(MONITOR_QUESTIONS, { M001: 0.2, M002: 0.9, M003: 0.1, M004: 0.9 });
  assert.equal(r.verdict, "alert");
  assert.deepEqual(r.hits, ["stall", "loop"]); // 规则序 M001→stall、M002→loop
});

test("⑪ monitorVerdict：恰在阈值不命中（below 恰等、above 恰等）→ ok", () => {
  const r = monitorVerdict(MONITOR_QUESTIONS, { M001: 0.6, M002: 0.7, M003: 0.7, M004: 0.6 });
  assert.equal(r.verdict, "ok");
  assert.deepEqual(r.hits, []);
});

test("⑫ monitorVerdict：概率缺失/非有限 → 该规则 unknown 不告警；全部未知 → verdict unknown", () => {
  assert.deepEqual(monitorVerdict(MONITOR_QUESTIONS, {}), { verdict: "unknown", hits: [] });
  assert.deepEqual(monitorVerdict(MONITOR_QUESTIONS, { M001: NaN, M002: Infinity }), {
    verdict: "unknown",
    hits: [],
  });
});

test("⑫b monitorVerdict：部分 unknown 部分 ok → ok；部分 unknown 部分 hit → alert", () => {
  const ok = monitorVerdict(MONITOR_QUESTIONS, { M001: 0.9, M002: 0.1 }); // 余缺失
  assert.equal(ok.verdict, "ok");
  const alert = monitorVerdict(MONITOR_QUESTIONS, { M001: 0.1, M002: NaN }); // M001 命中
  assert.equal(alert.verdict, "alert");
  assert.deepEqual(alert.hits, ["stall"]);
});

test("⑬ formatAlert：规则触发式文案逐字段成形", () => {
  const s = formatAlert("worker", "stall", "bash: npm test …[截断]…", 0.31);
  assert.equal(
    s,
    "JEV 监控告警：worker 疑似 bash 停滞（规则：M001 bash-stall）；证据：bash: npm test …[截断]…；置信度：0.31；建议：核查是否正常。"
  );
});

// dueChecks 用假时钟与手工 MonitorState
function mkState(over: Partial<MonitorState> = {}): MonitorState {
  return {
    agent: "worker",
    task: "t",
    startedAt: 0,
    lastActivityAt: 0,
    bashCalls: [],
    recentCalls: [],
    dedupeKeys: [],
    ...over,
  };
}

test("⑭ dueChecks：bash 首查——总耗时 ≥ bashFirstCheckMs 且未查过才触发", () => {
  const st = mkState({ bashCalls: [{ toolCallId: "c1", startedAt: 0 }] });
  const cfg = { ...SMALL, bashFirstCheckMs: 300_000 };
  assert.deepEqual(dueChecks(st, 299_999, cfg), []); // 未到首查，sweep 亦未到
  assert.deepEqual(dueChecks(st, 300_000, cfg), [{ kind: "bash_first", toolCallId: "c1" }]);
});

test("⑮ dueChecks：复询——已查过者按 checkedAt 距算 bashRecheckMs，未查过者不走复询", () => {
  const st = mkState({
    startedAt: 0,
    lastCheckAt: 0,
    bashCalls: [{ toolCallId: "c1", startedAt: 0, checkedAt: 300_000 }],
  });
  const cfg = { ...SMALL, bashRecheckMs: 600_000, sweepIntervalMs: 10_000_000 };
  assert.deepEqual(dueChecks(st, 899_999, cfg), []);
  assert.deepEqual(dueChecks(st, 900_000, cfg), [{ kind: "bash_recheck", toolCallId: "c1" }]);
});

test("⑯ dueChecks：兜底巡检——从未检查以 startedAt 为锚，已查以 lastCheckAt 为锚", () => {
  const cfg = { ...SMALL, sweepIntervalMs: 600_000 };
  assert.deepEqual(dueChecks(mkState({ startedAt: 0 }), 599_999, cfg), []);
  assert.deepEqual(dueChecks(mkState({ startedAt: 0 }), 600_000, cfg), [{ kind: "sweep" }]);
  const checked = mkState({ startedAt: 0, lastCheckAt: 500_000 });
  assert.deepEqual(dueChecks(checked, 1_099_999, cfg), []);
  assert.deepEqual(dueChecks(checked, 1_100_000, cfg), [{ kind: "sweep" }]);
});

test("⑰ dueChecks：bash 首查与巡检同到 → 多项同列（调用方合并为一次求值）", () => {
  const st = mkState({ startedAt: 0, bashCalls: [{ toolCallId: "c1", startedAt: 0 }] });
  const cfg = { ...SMALL, bashFirstCheckMs: 300_000, sweepIntervalMs: 300_000 };
  const due = dueChecks(st, 300_000, cfg);
  assert.deepEqual(due, [
    { kind: "bash_first", toolCallId: "c1" },
    { kind: "sweep" },
  ]);
});

// pi-subagents 0.76 fleet transcript 文本形 fixture
const TRANSCRIPT = [
  "Run: run-1",
  "State: live foreground",
  "Child: 0 (worker)",
  "Live transcript tail (tail truncated):",
  "Tool: bash (ok)",
  "{\"command\":\"npm test\"}",
  "all tests passed",
  "Tool: read (error)",
  "{\"path\":\"/home/g0/x.ts\"}",
  "ENOENT: no such file",
  "Assistant: 继续排查。",
  "Tool: bash (error)",
  "{\"command\":\"npm test\"}",
  "1 test failed",
].join("\n");

test("⑱ parseFleetTranscript：`Tool: <name> (<status>)` 节解析、状态/预览/错误位正确，节标题切分", () => {
  const calls = parseFleetTranscript(TRANSCRIPT);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { tool: "bash", preview: '{"command":"npm test"}\nall tests passed', isError: false, ts: 0 });
  assert.equal(calls[1].tool, "read");
  assert.equal(calls[1].isError, true);
  assert.ok(calls[1].preview.includes("ENOENT"));
  assert.equal(calls[2].tool, "bash");
  assert.equal(calls[2].isError, true);
  assert.ok(calls[2].preview.includes("1 test failed"));
});

test("⑲ parseFleetTranscript：无工具节/空文本 → 空数组（证据不足）", () => {
  assert.deepEqual(parseFleetTranscript("Run: x\nAssistant: 你好\n"), []);
  assert.deepEqual(parseFleetTranscript(""), []);
});

// ── parseControlEvent：subagent:control-event 载荷解包（P1-1 回归）──

// pi-subagents 0.76 真实嵌套形（async-job-tracker.js / subagent-executor.js 之 payload）：
// { event: <ControlEvent>, source, ... }——事件本体嵌于 event 键。
const NESTED_ASYNC = {
  event: {
    type: "needs_attention",
    from: "active",
    to: "attention",
    ts: 1728000000000,
    agent: "worker",
    runId: "run-9",
    reason: "tool_open_threshold",
    toolCount: 12,
    currentTool: "bash",
    toolCallId: "call-7",
    currentToolDurationMs: 305_000,
    message: "bash open beyond threshold",
  },
  source: "async",
  asyncDir: "/tmp/async-run-9",
  noticeText: "[worker] bash open beyond threshold",
};

const NESTED_FOREGROUND = {
  event: {
    type: "needs_attention",
    to: "attention",
    ts: 1728000001000,
    agent: "coder",
    runId: "run-10",
    reason: "tool_failures",
    toolCount: 20,
    recentFailureSummary: "npm test ×3",
    message: "repeated failures",
  },
  source: "foreground",
  childIntercomTarget: "parent",
  noticeText: "[coder] repeated failures",
};

test("⑳ parseControlEvent：嵌套 event 键之真实载荷（async/foreground 两形）逐字段解包", () => {
  const a = parseControlEvent(NESTED_ASYNC);
  assert.ok(a);
  assert.equal(a.runId, "run-9");
  assert.equal(a.agent, "worker");
  assert.equal(a.reason, "tool_open_threshold");
  assert.equal(a.currentTool, "bash");
  assert.equal(a.toolCallId, "call-7");
  assert.equal(a.currentToolDurationMs, 305_000);
  assert.equal(a.ts, 1728000000000);
  assert.equal(a.task, ""); // 无 taskPreview → 空
  const f = parseControlEvent(NESTED_FOREGROUND);
  assert.ok(f);
  assert.equal(f.runId, "run-10");
  assert.equal(f.agent, "coder");
  assert.equal(f.reason, "tool_failures");
  assert.equal(f.currentTool, undefined); // 未携 currentTool
});

test("㉑ parseControlEvent：裸事件直发形（无 event 键）兼容；runId 缺/非字符串 → null 丢弃", () => {
  const bare = parseControlEvent({
    runId: "run-1",
    agent: "worker",
    ts: 100,
    currentTool: "bash",
  });
  assert.ok(bare);
  assert.equal(bare.runId, "run-1");
  assert.equal(bare.currentTool, "bash");
  assert.equal(parseControlEvent({ event: { agent: "worker" }, source: "async" }), null); // 嵌套但无 runId
  assert.equal(parseControlEvent({ runId: 42 }), null); // runId 非字符串
  assert.equal(parseControlEvent(null), null);
  assert.equal(parseControlEvent("string-payload"), null);
});

test("㉒ loadMonitorConfig：(0,1) 区间 floor 后为 0 → 回退缺省（slice(-0) 防呆）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-mon-"));
  const p = path.join(dir, "edge.json");
  writeFileSync(
    p,
    JSON.stringify({
      enabled: true,
      maxCallsPerEval: 0.5, // floor 后 0 → 回退
      maxCharsPerCall: 0.9,
      bashFirstCheckMs: 1.9, // floor 后 1 → 取 1
    })
  );
  const cfg = loadMonitorConfig(p)!;
  assert.equal(cfg.maxCallsPerEval, DEFAULT_MONITOR_CONFIG.maxCallsPerEval);
  assert.equal(cfg.maxCharsPerCall, DEFAULT_MONITOR_CONFIG.maxCharsPerCall);
  assert.equal(cfg.bashFirstCheckMs, 1); // floor(1.9)=1 > 0 → 取整保留
});

// ── 异步（后台）输出日志形：`<tool>: <content>` 行语法（run-child-session.js:374 实证）──

// 实捕样本（异步 delegate run 之 RPC status view=transcript 原文）
const ASYNC_SAMPLE = [
  "Task: This is a deliberately hanging bash command for a live test of the runtime-monitoring feature in this session. Run exactly one bash command: tail -f /dev/null",
  "The command is expected to never return — that hang is the intended test condition, do not kill it or work around it. Do not modify any files. Reply only if the command exits on its own.",
  "bash: tail -f /dev/null",
].join("\n");

test("㉓ parseAsyncTranscript：实捕样本——`bash: <命令>` 行解析为工具调用，散文行不误判", () => {
  const calls = parseAsyncTranscript(ASYNC_SAMPLE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "bash");
  assert.equal(calls[0].preview, "tail -f /dev/null");
  assert.equal(calls[0].isError, false); // 异步输出日志无错误标记（实证语法）
  // 任务原文两行（Task: 行与其续行）皆散文：不得以冒号误判
  assert.ok(!calls.some((c) => c.tool === "task"));
});

test("㉔ parseAsyncTranscript：大小写不敏感命中词表；词表外冒号行（含看似工具者）一律不弃判", () => {
  const calls = parseAsyncTranscript(
    [
      "Bash: npm test", // 大小写不敏感
      "Read: {\"path\":\"/a.ts\"}",
      "GREP: foo bar", // 词表内
      "Task: do something", // 词表外
      "Run: run-1", // 词表外（fleet 节标题形）
      "Note: please review", // 散文冒号
      "python: script.py", // 词表外工具名——保守不判
      "shell: rm -rf /", // 词表外——不判（误报代价高于漏报）
    ].join("\n")
  );
  assert.deepEqual(
    calls.map((c) => c.tool),
    ["bash", "read", "grep"]
  );
});

test("㉖ parseTranscriptEvidence：真实缩进形——正文行两空格缩进（fleet-view.js appendTranscriptBody 实证），剥缩进解析，散文不误判", () => {
  // 实捕异步 RPC transcript 之真实形：头部行无缩进，正文行恒带两空格缩进
  const indented = [
    "Run: run-async-1",
    "State: live async",
    "Mode: async",
    "Artifacts:",
    "  output: /home/g0/.pi/agent/subagents/runs/run-async-1/output-0.log",
    "Transcript tail from /home/g0/.pi/agent/subagents/runs/run-async-1/output-0.log (tail truncated):",
    "  Task: This is a deliberately hanging bash command for a live test of the runtime-monitoring feature in this session. Run exactly one bash command: tail -f /dev/null",
    "  The command is expected to never return — that hang is the intended test condition, do not kill it or work around it. Do not modify any files. Reply only if the command exits on its own.",
    "  bash: tail -f /dev/null",
  ].join("\n");
  const ev = parseTranscriptEvidence(indented);
  // 根因回归：缩进之 `  bash: …` 行此前锚定行首而漏 → calls=0 静默无求值
  assert.equal(ev.calls.length, 1);
  assert.equal(ev.calls[0].tool, "bash");
  assert.equal(ev.calls[0].preview, "tail -f /dev/null");
  // 缩进 Task 行抽取任务原文
  assert.ok(ev.task!.startsWith("This is a deliberately hanging bash command"));
  // 缩进散文续行不误判；Artifacts 之缩进 `  output: …` 亦不在词表内
  assert.ok(!ev.calls.some((c) => c.tool === "task" || c.tool === "output"));
});

test("㉕ extractAsyncTask / parseTranscriptEvidence：Task 行抽取与双形态回落", () => {
  assert.equal(
    extractAsyncTask(ASYNC_SAMPLE),
    "This is a deliberately hanging bash command for a live test of the runtime-monitoring feature in this session. Run exactly one bash command: tail -f /dev/null"
  );
  assert.equal(extractAsyncTask("无任务行\nbash: ls\n"), null);
  // fleet 形优先：有 Tool: 节则不走异步形、task 不抽取
  const fleet = parseTranscriptEvidence(TRANSCRIPT);
  assert.equal(fleet.calls.length, 3);
  assert.equal(fleet.task, null);
  // 异步形：fleet 零节 → 回落解析且携任务原文
  const asyncEv = parseTranscriptEvidence(ASYNC_SAMPLE);
  assert.equal(asyncEv.calls.length, 1);
  assert.ok(asyncEv.task!.startsWith("This is a deliberately hanging bash command"));
  // 两者俱空 → 证据不足
  assert.deepEqual(parseTranscriptEvidence("Assistant: 尚无活动。\n"), { calls: [], task: null });
});
