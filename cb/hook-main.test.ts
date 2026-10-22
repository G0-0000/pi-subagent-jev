// hook-main.ts 单测：放行/拦截/warn 落取/TTL/缺键/坏 stdin/JEV 错误/缺配置/fail-open。
// 一律注入 mock askFn 与临时配置目录，不发任何真实 JEV 请求。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JevError, type SystemOneResult } from "../jev/client.ts";
import { formatWarnNotice, type AskFn } from "../jev/compliance.ts";
import { formatBlockReason, handlePost, handlePre, parseDispatch, runHook } from "./hook-main.ts";
import { WARN_TTL_MS } from "./warn-state.ts";

const RULES = {
  _questions: {
    Q001: {
      instructions: "Does the task give concrete content?",
      blockWhen: "below",
      threshold: 0.7,
      message: "任务未给出具体内容",
    },
  },
  delegate: { agentDesc: "a file-editing agent", rules: ["Q001"] },
};

const WARN_RULES = {
  _global: { mode: "warn" },
  ...RULES,
};

function makeConfig(rules: unknown = RULES): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-cb-"));
  writeFileSync(path.join(dir, "compliance-rules.json"), JSON.stringify(rules));
  return dir;
}

function askWith(p: number): AskFn {
  return async (): Promise<SystemOneResult> => ({
    model: "test-model",
    answers: { Q001: { noul: p } },
    usage: {},
  });
}

function preInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "delegate",
      description: "改一行",
      prompt: "修改 /tmp/a.ts 第 3 行",
    },
    tool_use_id: "tu_1",
    call_id: "call_1",
    ...over,
  };
}

function readAudit(dir: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(dir, "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("① 放行：概率达标 → 空对象，审计落 pass 行含 host", async () => {
  const dir = makeConfig();
  // 显式注入 host，免依赖宿主环境变量之有无
  const out = await handlePre(preInput(), { configDir: dir, askFn: askWith(0.9), host: "codebuddy" });
  assert.deepEqual(out, {});
  const lines = readAudit(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].verdict, "pass");
  assert.equal(lines[0].host, "codebuddy");
  assert.equal((lines[0].rules as Record<string, string>).Q001, "pass");
});

test("② 拦截：命中 → deny，文案与 pi 扩展逐字同形", async () => {
  const dir = makeConfig();
  const out = await handlePre(preInput(), { configDir: dir, askFn: askWith(0.1) });
  const hso = out.hookSpecificOutput as Record<string, unknown>;
  assert.equal(hso.hookEventName, "PreToolUse");
  assert.equal(hso.permissionDecision, "deny");
  assert.equal(
    hso.permissionDecisionReason,
    "派单审核未通过（agent=delegate）：\n- Q001: 任务未给出具体内容\n请修正任务描述后重派。"
  );
  assert.equal(hso.permissionDecisionReason, formatBlockReason("delegate", ["Q001: 任务未给出具体内容"]));
  const lines = readAudit(dir);
  assert.equal(lines[0].verdict, "violation");
  assert.deepEqual(lines[0].blocked, ["Q001"]);
  assert.equal(lines[0].action, undefined);
});

test("③ warn：不拦、暂存于 tool_use_id，PostToolUse 取回并二次删除", async () => {
  const dir = makeConfig(WARN_RULES);
  const out = await handlePre(preInput(), { configDir: dir, askFn: askWith(0.1), now: () => 1000 });
  assert.deepEqual(out, {});
  const warning = formatWarnNotice("delegate", ["Q001: 任务未给出具体内容"]);
  const post = handlePost(preInput(), { configDir: dir, now: () => 1001 });
  const hso = post.hookSpecificOutput as Record<string, unknown>;
  assert.equal(hso.hookEventName, "PostToolUse");
  assert.equal(hso.additionalContext, warning);
  assert.equal(readAudit(dir)[0].action, "warn");
  // 二次取已删
  assert.deepEqual(handlePost(preInput(), { configDir: dir, now: () => 1001 }), {});
});

test("④ warn 过期：逾 TTL 之提示不再交付", async () => {
  const dir = makeConfig(WARN_RULES);
  await handlePre(preInput(), { configDir: dir, askFn: askWith(0.1), now: () => 1000 });
  const post = handlePost(preInput(), { configDir: dir, now: () => 1000 + WARN_TTL_MS });
  assert.deepEqual(post, {});
});

test("⑤ 缺标识：warn 仍放行，post 无键 → 空对象；call_id 可兜底", async () => {
  const dir = makeConfig(WARN_RULES);
  const noIds = preInput({ tool_use_id: undefined, call_id: undefined });
  assert.deepEqual(await handlePre(noIds, { configDir: dir, askFn: askWith(0.1) }), {});
  assert.deepEqual(handlePost(noIds, { configDir: dir }), {});

  const callOnly = preInput({ tool_use_id: undefined, call_id: "call_9" });
  await handlePre(callOnly, { configDir: dir, askFn: askWith(0.1), now: () => 5 });
  const post = handlePost(callOnly, { configDir: dir, now: () => 5 });
  assert.ok(typeof (post.hookSpecificOutput as Record<string, unknown>).additionalContext === "string");
});

test("⑥ 坏 stdin / 空 stdin / 未知模式：runHook 皆返空对象", async () => {
  const dir = makeConfig();
  const deps = { configDir: dir, askFn: askWith(0.1) };
  assert.deepEqual(await runHook(["node", "jev-hook", "pre"], { ...deps, stdin: async () => "not json" }), {});
  assert.deepEqual(await runHook(["node", "jev-hook", "pre"], { ...deps, stdin: async () => "" }), {});
  assert.deepEqual(await runHook(["node", "jev-hook", "session"], { ...deps, stdin: async () => { throw new Error("不应读 stdin"); } }), {});
  assert.deepEqual(await runHook(["node", "jev-hook", "bogus"], deps), {});
  assert.equal(existsSync(path.join(dir, "audit.jsonl")), false);
});

test("⑦ runHook pre 全链路：stdin JSON → deny", async () => {
  const dir = makeConfig();
  const out = await runHook(["node", "jev-hook", "pre"], {
    configDir: dir,
    askFn: askWith(0.1),
    stdin: async () => JSON.stringify(preInput()),
  });
  assert.equal((out.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
});

test("⑧ JEV 错误：fail-open 放行，审计落 error 行", async () => {
  const dir = makeConfig();
  const failing: AskFn = async () => {
    throw new JevError("network", "connect failed");
  };
  const out = await handlePre(preInput(), { configDir: dir, askFn: failing });
  assert.deepEqual(out, {});
  const lines = readAudit(dir);
  assert.equal(lines[0].verdict, "error");
  assert.match(String(lines[0].error), /network/);
});

test("⑨ 规则档缺失：零拦截零审计", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-cb-empty-"));
  const out = await handlePre(preInput(), { configDir: dir, askFn: askWith(0.1) });
  assert.deepEqual(out, {});
  assert.equal(existsSync(path.join(dir, "audit.jsonl")), false);
});

test("⑩ 空任务与非派单工具：不审核、不落审计", async () => {
  const dir = makeConfig();
  const emptyTask = preInput({ tool_input: { subagent_type: "delegate", prompt: "   " } });
  assert.deepEqual(await handlePre(emptyTask, { configDir: dir, askFn: askWith(0.1) }), {});
  const otherTool = preInput({ tool_name: "Bash" });
  assert.deepEqual(await handlePre(otherTool, { configDir: dir, askFn: askWith(0.1) }), {});
  assert.equal(existsSync(path.join(dir, "audit.jsonl")), false);
});

test("⑪ parseDispatch：Task/Agent 两形同取，缺字段按契约缺省", () => {
  assert.deepEqual(parseDispatch(preInput() as never), {
    agent: "delegate",
    task: "修改 /tmp/a.ts 第 3 行",
    model: undefined,
    runInBackground: undefined,
  });
  assert.deepEqual(parseDispatch({ tool_input: { prompt: "t", model: "m", run_in_background: true } }), {
    agent: "unknown",
    task: "t",
    model: "m",
    runInBackground: true,
  });
  assert.deepEqual(parseDispatch({}), { agent: "unknown", task: "", model: undefined, runInBackground: undefined });
});
