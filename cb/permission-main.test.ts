// cb/permission-main.ts 单测：关档沉默、observe 只审计、auto 之 allow/ask/deny、
// 宿主 deny 规则优先、求值败沉默、非管辖工具沉默、坏 stdin 沉默。
// 一律注入 mock askFn、临时配置目录与审计写入器，不发任何真实 JEV 请求。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SystemOneResult } from "../jev/client.ts";
import type { AskFn } from "../jev/compliance.ts";
import {
  buildPermissionState,
  defaultWriteAudit,
  handlePermission,
  hostSettingsFiles,
  parseAskRules,
  parseDenyRules,
  runPermissionHook,
} from "./permission-main.ts";

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
  opts: {
    askFn?: AskFn;
    audit?: string[];
    readText?: (p: string) => string | null;
    home?: string;
    host?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<Record<string, unknown>> {
  const audit = opts.audit ?? [];
  return handlePermission(input, {
    configDir: dir,
    home: opts.home ?? HOME,
    askFn: opts.askFn,
    now: () => 1000,
    writeAudit: (_d, line) => audit.push(line),
    host: opts.host ?? "codebuddy",
    readText: opts.readText ?? (() => null),
    env: opts.env ?? {},
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
  // ask 规则同形解析，各取各键
  assert.deepEqual(parseAskRules({ permissions: { ask: ["Bash(git push:*)", 1] } }), ["Bash(git push:*)"]);
  assert.deepEqual(parseAskRules({ permissions: { deny: ["Bash(rm:*)"] } }), []);
  assert.deepEqual(parseAskRules(null), []);
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

test("⑭ defaultWriteAudit：配置目录缺时自建（0700），审计行追加于 audit.jsonl", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jev-perm-cb-"));
  const dir = path.join(root, "nested", "jev-comp");
  try {
    assert.equal(existsSync(dir), false);
    defaultWriteAudit(dir, '{"kind":"permission","decision":"allow"}');
    assert.equal(statSync(dir).mode & 0o777, 0o700, "自建目录须为 0700");
    defaultWriteAudit(dir, '{"kind":"permission","decision":"ask"}');
    const lines = readFileSync(path.join(dir, "audit.jsonl"), "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]!) as Record<string, unknown>).decision, "allow");
    assert.equal((JSON.parse(lines[1]!) as Record<string, unknown>).decision, "ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑮ host-prompt：本地 pass 而宿主不弹 → 沉默、绝不求值（审计记 silent/host-would-allow）", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  const audit: string[] = [];
  // 若被调用即抛：审计行会带 error，可据以验「未求值」
  const askFn: AskFn = async () => {
    throw new Error("host-prompt 之下不应求值");
  };
  try {
    // python3 script.py：本地无定论（不在只读名单），宿主 stage 3 不弹
    assert.deepEqual(
      await run(hookInput({ tool_input: { command: "python3 script.py" } }), dir, { audit, askFn }),
      {}
    );
    const bashLine = JSON.parse(audit[0]!) as Record<string, unknown>;
    assert.equal(bashLine.decision, "silent");
    assert.equal(bashLine.reason, "host-would-allow");
    assert.equal(bashLine.error, undefined, "不得代为求值");
    // 写类工具本地无定论（无 file_path）亦然：bypassPermissions 下宿主不为 Write 弹窗
    assert.deepEqual(await run(hookInput({ tool_name: "Write", tool_input: {} }), dir, { audit, askFn }), {});
    const writeLine = JSON.parse(audit[1]!) as Record<string, unknown>;
    assert.equal(writeLine.reason, "host-would-allow");
    assert.equal(writeLine.error, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑯ host-prompt：本地 pass 且宿主会弹（rm -rf build）→ 照常求值", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  let called = 0;
  const askFn: AskFn = async () => {
    called += 1;
    return answers({ "0": 1 }, 0);
  };
  try {
    const out = await run(hookInput({ tool_input: { command: "rm -rf build" } }), dir, { askFn });
    assert.equal(called, 1);
    assert.equal(decisionOf(out), "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑰ jevWhen=always：本地 pass 即问模型，纵宿主不弹", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto", jevWhen: "always" });
  let called = 0;
  const askFn: AskFn = async () => {
    called += 1;
    return answers({ "0": 1 }, 0);
  };
  try {
    const out = await run(hookInput({ tool_input: { command: "python3 script.py" } }), dir, { askFn });
    assert.equal(called, 1);
    assert.equal(decisionOf(out), "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑱ 宿主 permissions.ask 规则命中 → 沉默且不求值（不许代答）", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  let called = 0;
  const askFn: AskFn = async () => {
    called += 1;
    return answers({ "0": 1 }, 0);
  };
  const settings = JSON.stringify({ permissions: { ask: ["Bash(npm:*)"] } });
  const readText = (p: string): string | null =>
    p.endsWith(path.join(".codebuddy", "settings.json")) ? settings : null;
  try {
    // 基线：无 ask 规则时本地 allow
    assert.equal(decisionOf(await run(hookInput(), dir, { askFn })), "allow");
    // 有 ask 规则：沉默，交宿主弹窗
    assert.deepEqual(await run(hookInput(), dir, { askFn, readText }), {});
    assert.equal(called, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑲ hostSettingsFiles：Claude Code 三档（尊重 CLAUDE_CONFIG_DIR），CodeBuddy 二档", () => {
  const claudeProject = path.join(CWD, ".claude", "settings.json");
  const claudeLocal = path.join(CWD, ".claude", "settings.local.json");
  assert.deepEqual(hostSettingsFiles("claude-code", CWD, HOME, {}), [
    path.join(HOME, ".claude", "settings.json"),
    claudeProject,
    claudeLocal,
  ]);
  assert.deepEqual(hostSettingsFiles("claude-code", CWD, HOME, { CLAUDE_CONFIG_DIR: "/tmp/cc" }), [
    path.join("/tmp/cc", "settings.json"),
    claudeProject,
    claudeLocal,
  ]);
  // 空白值视为未设，回 ~/.claude
  assert.equal(
    hostSettingsFiles("claude-code", CWD, HOME, { CLAUDE_CONFIG_DIR: "   " })[0],
    path.join(HOME, ".claude", "settings.json")
  );
  assert.deepEqual(hostSettingsFiles("codebuddy", CWD, HOME, {}), [
    path.join(HOME, ".codebuddy", "settings.json"),
    path.join(CWD, ".codebuddy", "settings.json"),
  ]);
});

test("⑳ Claude Code：用户档与项目档之 deny 规则命中 → 沉默且不求值", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  let called = 0;
  const askFn: AskFn = async () => {
    called += 1;
    return answers({ "0": 1 }, 0);
  };
  const settings = JSON.stringify({ permissions: { deny: ["Bash(npm:*)"] } });
  const userFile = path.join(HOME, ".claude", "settings.json");
  const projectFile = path.join(CWD, ".claude", "settings.json");
  try {
    assert.deepEqual(
      await run(hookInput(), dir, {
        host: "claude-code",
        askFn,
        readText: (p) => (p === userFile ? settings : null),
      }),
      {}
    );
    assert.deepEqual(
      await run(hookInput(), dir, {
        host: "claude-code",
        askFn,
        readText: (p) => (p === projectFile ? settings : null),
      }),
      {}
    );
    assert.equal(called, 0, "宿主 deny 命中者不得求值");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("㉑ Claude Code：项目本地档 settings.local.json 之 ask 规则命中 → 沉默且不求值", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  let called = 0;
  const askFn: AskFn = async () => {
    called += 1;
    return answers({ "0": 1 }, 0);
  };
  const localFile = path.join(CWD, ".claude", "settings.local.json");
  const settings = JSON.stringify({ permissions: { ask: ["Bash(npm:*)"] } });
  try {
    assert.deepEqual(
      await run(hookInput(), dir, {
        host: "claude-code",
        askFn,
        readText: (p) => (p === localFile ? settings : null),
      }),
      {}
    );
    assert.equal(called, 0, "宿主 ask 命中者不得代答");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("㉒ Claude Code + host-prompt：本地 pass 即问模型（CodeBuddy 正则会漏判）", async () => {
  const dir = makeConfig({ enabled: true, mode: "auto" });
  const audit: string[] = [];
  let called = 0;
  const askFn: AskFn = async () => {
    called += 1;
    return answers({ "0": 0.9, "1": 0.1 }, 0.1);
  };
  try {
    // python3 script.py：CodeBuddy host-prompt 之下静默（见⑮），Claude 之下须求值
    const out = await run(hookInput({ tool_input: { command: "python3 script.py" } }), dir, {
      host: "claude-code",
      audit,
      askFn,
    });
    assert.equal(called, 1);
    assert.equal(decisionOf(out), "allow");
    const line = JSON.parse(audit[0]!) as Record<string, unknown>;
    assert.equal(line.host, "claude-code");
    assert.equal(line.decision, "allow");
    assert.equal(line.risk, 0.1);
    assert.equal(line.approval, 0.1);
    assert.equal(line.reason, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


