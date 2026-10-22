// host.ts 单测：宿主判别优先级（CODEBUDDY ＞ CLAUDE ＞ 缺省）与审计行 host 取值。
// 一律注入临时配置目录与 mock askFn，不发真实请求；触及 process.env 者即时复原。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SystemOneResult } from "../jev/client.ts";
import type { AskFn } from "../jev/compliance.ts";
import { detectHost } from "./host.ts";
import { handlePre } from "./hook-main.ts";

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

function makeConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-cb-host-"));
  writeFileSync(path.join(dir, "compliance-rules.json"), JSON.stringify(RULES));
  return dir;
}

function askWith(p: number): AskFn {
  return async (): Promise<SystemOneResult> => ({
    model: "test-model",
    answers: { Q001: { noul: p } },
    usage: {},
  });
}

function preInput(): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "delegate", prompt: "修改 /tmp/a.ts 第 3 行" },
    tool_use_id: "tu_host_1",
  };
}

function readAudit(dir: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(dir, "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("① detectHost：两变量皆在 → codebuddy 优先", () => {
  assert.equal(
    detectHost({ CODEBUDDY_PLUGIN_ROOT: "/a", CLAUDE_PLUGIN_ROOT: "/b" }),
    "codebuddy"
  );
});

test("② detectHost：唯 CLAUDE_PLUGIN_ROOT → claude-code", () => {
  assert.equal(detectHost({ CLAUDE_PLUGIN_ROOT: "/b" }), "claude-code");
});

test("③ detectHost：皆无或空白 → 缺省 codebuddy", () => {
  assert.equal(detectHost({}), "codebuddy");
  assert.equal(detectHost({ CODEBUDDY_PLUGIN_ROOT: "", CLAUDE_PLUGIN_ROOT: "   " }), "codebuddy");
  assert.equal(detectHost({ CODEBUDDY_PLUGIN_ROOT: "  ", CLAUDE_PLUGIN_ROOT: "/b" }), "claude-code");
});

test("④ 审计 host：deps.host 注入 claude-code 即落该值", async () => {
  const dir = makeConfig();
  await handlePre(preInput(), { configDir: dir, askFn: askWith(0.9), host: "claude-code" });
  assert.equal(readAudit(dir)[0].host, "claude-code");
});

test("⑤ 审计 host：未注入时随 detectHost() 判宿主", async () => {
  const beforeCb = process.env.CODEBUDDY_PLUGIN_ROOT;
  const beforeClaude = process.env.CLAUDE_PLUGIN_ROOT;
  try {
    delete process.env.CODEBUDDY_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = "/tmp/fake-claude-plugin";
    const dir = makeConfig();
    await handlePre(preInput(), { configDir: dir, askFn: askWith(0.9) });
    assert.equal(readAudit(dir)[0].host, "claude-code");
  } finally {
    if (beforeCb === undefined) delete process.env.CODEBUDDY_PLUGIN_ROOT;
    else process.env.CODEBUDDY_PLUGIN_ROOT = beforeCb;
    if (beforeClaude === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = beforeClaude;
  }
});
