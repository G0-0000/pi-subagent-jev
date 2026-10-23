// cb/permission-main.ts 单测：关档沉默、observe 只审计、auto 之 allow/ask/deny、
// 宿主 deny 规则优先、求值败沉默、非管辖工具沉默、坏 stdin 沉默。
// 一律注入 mock askFn、临时配置目录与审计写入器，不发任何真实 JEV 请求。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SystemOneResult } from "../jev/client.ts";
import type { AskFn } from "../jev/compliance.ts";
import { buildPermissionState, handlePermission, parseDenyRules, runPermissionHook } from "./permission-main.ts";

const CWD = "/home/g0/proj";
const HOME = "/home/g0";

function makeConfig(cfg: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-perm-cb-"));
  writeFileSync(path.join(dir, "auto-approve.json"), JSON.stringify(cfg));
  return dir;
}

function answers(risk: Record<string, number> | undefined, approval?: number): SystemOneResult {
  return {
    model: "mock",
    answers: {
      ...(risk ? { risk: { score: { type: "score", probabilities: risk } } } : {}),
      ...(approval !== undefined ? { approval: { noul: approval } } : {}),
    },
    usage: {},
  };
}

function askWith(risk: Record<string, number>, approval: number): AskFn {
  return async () => answers(risk, approval);
}

function hookInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    cwd: CWD,
    tool_use_id: "tu_1",
    ...over,
  };
}

function decisionOf(out: Record<string, unknown>): string | undefined {
  const h = out.hookSpecificOutput as Record<string, unknown> | undefined;
  return h ? (h.permissionDecision as string | undefined) : undefined;
}

function run(
  input: Record<string, unknown>,
  dir: string,
  opts: { askFn?: AskFn; audit?: string[]; readText?: (p: string) => string | null; home?: string } = {}
): Promise<Record<string, unknown>> {
  const audit = opts.audit ?? [];
  return handlePermission(input, {
    configDir: dir,
    home: opts.home ?? HOME,
    askFn: opts.askFn,
    now: () => 1000,
    writeAudit: (_d, line) => audit.push(line),
    host: "codebuddy",
    readText: opts.readText ?? (() => null),
  });
}

test("① 关档（无 auto-approve.json）→ 沉默、不审计", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-perm-cb-"));
  const audit: string[] = [];
  try {
    const out = await run(hookInput(), dir, { audit, askFn: askWith({ "0": 1 }, 0) });
    assert.deepEqual(out, {});
    assert.equal(audit.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("② enabled:false → 沉默、不审计", async () => {
  const dir = makeConfig({ enabled: false, mode: "auto" });
  const audit: string[] = [];
  try {
    assert.deepEqual(await run(hookInput(), dir, { audit }), {});
    assert.equal(audit.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("③ 非管辖工具 → 沉默；大小写不敏感之 tools 匹配生效", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto", tools: ["bash", "Write"] });
  try {
    assert.deepEqual(await run(hookInput({ tool_name: "Read" }), dir), {});
    assert.equal(decisionOf(await run(hookInput({ tool_name: "Bash" }), dir)), "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("④ observe：本地 allow 亦只审计、不改宿主行为；审计行记 would-be decision", async () => {
  const dir = makeConfig({ enabled: true, mode: "observe" });
  const audit: string[] = [];
  try {
    assert.deepEqual(await run(hookInput(), dir, { audit }), {});
    assert.equal(audit.length, 1);
    const line = JSON.parse(audit[0]!) as Record<string, unknown>;
    assert.equal(line.kind, "permission");
    assert.equal(line.decision, "allow");
    assert.equal(line.tool, "Bash");
    assert.equal(line.host, "codebuddy");
    assert.equal(line.excerpt, "npm test");
    assert.equal(line.latency_ms, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑤ auto：本地 allow → allow；本地 ask（sudo）→ ask；不调用 askFn", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  let called = 0;
  const askFn: AskFn = async () => {
    called += 1;
    return answers({ "0": 1 }, 0);
  };
  try {
    assert.equal(decisionOf(await run(hookInput(), dir, { askFn })), "allow");
    assert.equal(
      decisionOf(
        await run(hookInput({ tool_input: { command: "sudo shutdown -h now" } }), dir, { askFn })
      ),
      "ask"
    );
    assert.equal(called, 0, "本地有定论者不得耗一次求值");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑥ auto：本地 pass 时求值，risk 2.62/0.91 → ask；risk 0.1/0.2 → allow；risk 2.9 且 destructiveAction:deny → deny", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  const denyDir = makeConfig({ enabled: true, mode: "auto", destructiveAction: "deny" });
  const rm = hookInput({ tool_input: { command: "rm -rf ~/ttt" } });
  try {
    assert.equal(decisionOf(await run(rm, dir, { askFn: askWith({ "0": 0.02, "1": 0.06, "2": 0.24, "3": 0.68 }, 0.91) })), "ask");
    assert.equal(decisionOf(await run(rm, dir, { askFn: askWith({ "0": 0.8, "1": 0.15, "2": 0.04, "3": 0.01 }, 0.2) })), "allow");
    assert.equal(decisionOf(await run(rm, denyDir, { askFn: askWith({ "0": 0, "1": 0, "2": 0.1, "3": 0.9 }, 0.95) })), "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(denyDir, { recursive: true, force: true });
  }
});

test("⑦ 求值败 → 沉默（绝不据错误放行），审计行附 error 且 decision silent", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  const audit: string[] = [];
  const askFn: AskFn = async () => {
    throw new Error("offline");
  };
  try {
    const out = await run(hookInput({ tool_input: { command: "rm -rf ~/ttt" } }), dir, { audit, askFn });
    assert.deepEqual(out, {});
    const line = JSON.parse(audit[0]!) as Record<string, unknown>;
    assert.equal(line.decision, "silent");
    assert.equal(line.error, "Error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑧ 概率缺失 → silent（宿主照旧弹窗），不臆造 allow", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  const audit: string[] = [];
  const askFn: AskFn = async () => answers(undefined, undefined);
  try {
    assert.deepEqual(await run(hookInput({ tool_input: { command: "rm -rf ~/ttt" } }), dir, { audit, askFn }), {});
    assert.equal((JSON.parse(audit[0]!) as Record<string, unknown>).decision, "silent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑨ 宿主 deny 规则命中 → 沉默且不求值（allow 不得越过 permissions.deny）", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  let called = 0;
  const askFn: AskFn = async () => {
    called += 1;
    return answers({ "0": 1 }, 0);
  };
  const settings = JSON.stringify({ permissions: { deny: ["Bash(npm:*)"] } });
  try {
    const out = await run(hookInput(), dir, {
      askFn,
      readText: (p) => (p.endsWith(path.join(".codebuddy", "settings.json")) ? settings : null),
    });
    assert.deepEqual(out, {});
    assert.equal(called, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑩ parseDenyRules：取 permissions.deny 之字符串项，畸形静默弃", () => {
  assert.deepEqual(parseDenyRules({ permissions: { deny: ["Bash(rm:*)", "", 3, null] } }), ["Bash(rm:*)"]);
  assert.deepEqual(parseDenyRules({ permissions: { deny: "Bash(rm:*)" } }), []);
  assert.deepEqual(parseDenyRules({}), []);
  assert.deepEqual(parseDenyRules(null), []);
  assert.deepEqual(parseDenyRules([]), []);
});

test("⑪ state 拼装：工具名、参照路径（有则）、参数原文、工作目录；参数超 2000 字截断", async () => {
  const state = buildPermissionState({
    tool: "Write",
    input: { file_path: "/home/g0/proj/a.ts", content: "x".repeat(3000) },
    cwd: CWD,
  });
  assert.ok(state.startsWith("Tool: Write\nReference: /home/g0/proj/a.ts\nCommand or arguments:\n"));
  assert.ok(state.endsWith("\nWorking directory: " + CWD));
  assert.ok(state.length < 2000 + 200);

  const noRef = buildPermissionState({ tool: "Bash", input: { command: "npm test" }, cwd: CWD });
  assert.ok(!noRef.includes("Reference:"));
  assert.ok(noRef.includes('"command":"npm test"'));
});

test("⑫ runPermissionHook：坏 stdin/非 JSON/缺 argv 皆沉默；perm 分支入 handlePermission", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  try {
    assert.deepEqual(await runPermissionHook(["node", "jev-hook", "pre"], { stdin: async () => "{}" }), {});
    assert.deepEqual(
      await runPermissionHook(["node", "jev-hook", "perm"], { stdin: async () => "not json", configDir: dir }),
      {}
    );
    const out = await runPermissionHook(["node", "jev-hook", "perm"], {
      stdin: async () => JSON.stringify(hookInput()),
      configDir: dir,
      home: HOME,
      readText: () => null,
      writeAudit: () => undefined,
    });
    assert.equal(decisionOf(out), "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑬ 半份概率（唯 risk 或唯 approval）→ silent：绝不据半份证据放行", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  const audit: string[] = [];
  const riskOnly: AskFn = async () => answers({ "0": 0.9, "1": 0.1 }, undefined);
  const approvalOnly: AskFn = async () => answers(undefined, 0.1);
  try {
    const input = hookInput({ tool_input: { command: "rm -rf ~/ttt" } });
    assert.deepEqual(await run(input, dir, { audit, askFn: riskOnly }), {});
    assert.deepEqual(await run(input, dir, { audit, askFn: approvalOnly }), {});
    assert.equal(audit.length, 2);
    for (const line of audit) {
      assert.equal((JSON.parse(line) as Record<string, unknown>).decision, "silent");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
