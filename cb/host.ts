// CodeBuddy Code 宿主适配层：配置目录解析、stdin JSON 读取、钩子输出构造。
// 配置目录与 pi 扩展共用（缺省 ~/.pi/agent/jev-comp），规则与上游链故为单一来源；
// JEV_CONFIG_DIR 可覆写（测试与多实例用），未设或空白时回缺省。
// 本层不做任何判定，唯宿主面之薄封装；一切错误由调用方 fail-open 处置。
import os from "node:os";
import path from "node:path";

/** 缺省运行时配置目录（与 pi 扩展一致）。 */
export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "jev-comp");

/** 配置目录解析：JEV_CONFIG_DIR 非空白者优先，否则缺省。 */
export function resolveConfigDir(
  env: Record<string, string | undefined> = process.env
): string {
  const v = env.JEV_CONFIG_DIR;
  return typeof v === "string" && v.trim() !== "" ? v : DEFAULT_CONFIG_DIR;
}

/**
 * 钩子 stdin 之形状（CodeBuddy Code 所给）。
 * 字段名保持宿主原文；类型放宽为 unknown，解析侧逐项校验（畸形输入不抛）。
 */
export type HookInput = {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  permission_mode?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  call_id?: unknown;
  tool_use_id?: unknown;
  tool_response?: unknown;
};

/** stdin 原文解析为钩子输入：非 JSON、非对象、数组皆返 null（调用方据此放行）。 */
export function parseHookInput(raw: string): HookInput | null {
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    return o as HookInput;
  } catch {
    return null;
  }
}

/** 派单标识：优先 tool_use_id，其次 call_id；非空字符串方取，其余弃之。 */
export function pickCallId(input: HookInput): string | undefined {
  for (const v of [input.tool_use_id, input.call_id]) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/**
 * 读 stdin 全部内容。
 * TTY（无管道输入）与读取错误皆回空串——钩子进程绝不因 stdin 悬停。
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      resolve("");
      return;
    }
    let buf = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buf += chunk;
    });
    stdin.on("end", () => resolve(buf));
    stdin.on("error", () => resolve(buf));
  });
}

/** PreToolUse 拒绝输出：CodeBuddy 以 permissionDecision=deny 阻断该次工具调用。 */
export function denyPre(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** PostToolUse 附加上下文输出：警告文本追加于该次工具结果之后。 */
export function contextPost(text: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: text,
    },
  };
}

/** 放行输出：空对象即不干预（CodeBuddy 视为继续）。 */
export function passOutput(): Record<string, unknown> {
  return {};
}

/** 唯一 stdout 写出点：每次进程至多一个 JSON 对象。 */
export function emitOutput(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
