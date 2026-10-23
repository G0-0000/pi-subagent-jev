// 工具权限自动审批之门（钩子面）：PreToolUse 读 stdin，本地判定优先、模型概率兜底，
// 按配置 mode（observe 只审计 / auto 出决断）输出 allow/ask/deny，末附审计行。
// 逻辑层在 jev/permission.ts（纯逻辑、可测），求值走 jev/client.ts 之 ask()（自管 curl 链）。
//
// 三条不可越之线：
//   1. 宿主 deny 规则命中即沉默（返 {}）——钩子之 allow 可越过 permissions.deny，绝不能以 allow 覆盖用户显式拒绝。
//   2. 任何错误/超时 → 沉默（返 {}），绝不因错误而放行。
//   3. 钩子须在超时内归：链上每级 timeoutMs 压至 2000（最坏三级 6s < 钩子 8s），且绝无重试。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ask, type SystemOneResult } from "../jev/client.ts";
import type { AskFn } from "../jev/compliance.ts";
import { CooldownTracker, loadFailoverConfig } from "../jev/failover.ts";
import { ACTION_QUESTIONS } from "../jev/guard-questions.ts";
import {
  assessLocally,
  buildPermissionAudit,
  decidePermission,
  denyRulesMatch,
  loadPermissionConfig,
  meanScore,
  noulProbability,
  scoreProbabilities,
  type Decision,
  type LocalVerdict,
} from "../jev/permission.ts";
import {
  allowPre,
  askPre,
  denyPre,
  detectHost,
  parseHookInput,
  passOutput,
  readStdin,
  resolveConfigDir,
  type HookInput,
} from "./host.ts";

/** 每级上游之求值上限：三级 6s，留 2s 余地给钩子 8s 之限。 */
export const PERMISSION_TIMEOUT_MS = 2_000;
/** 入 state 之参数节录上限（字）。 */
const MAX_STATE_INPUT_CHARS = 2_000;

export type PermissionDeps = {
  /** 求值函数（缺省走 ask()＋<configDir>/upstreams.json 之链，timeoutMs 压至 2000；测试注入） */
  askFn?: AskFn;
  /** 配置目录（缺省 resolveConfigDir()） */
  configDir?: string;
  /** 时钟（缺省 Date.now；测试注入） */
  now?: () => number;
  /** stdin 读取器（缺省 readStdin） */
  stdin?: () => Promise<string>;
  /** 审计行写入器（缺省追加 <configDir>/audit.jsonl；测试注入） */
  writeAudit?: (configDir: string, line: string) => void;
  /** 审计行 host 值（缺省 detectHost()） */
  host?: string;
  /** 家目录（缺省 os.homedir()；测试注入） */
  home?: string;
  /** 读宿主 settings 档（缺省读档，缺失返 null；测试注入） */
  readText?: (filePath: string) => string | null;
};

function defaultReadText(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * 缺省审计写入：先尽力建目录（0700），再追加。建目录失败不外抛——追加自会抛，由调用方静默；
 * 此举免「目录未建则审计永远无声消失」（observe 模式无从核对之弊）。
 */
export function defaultWriteAudit(configDir: string, line: string): void {
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  } catch {
    /* 建目录失败：下之追加自会失败，由调用方静默 */
  }
  appendFileSync(path.join(configDir, "audit.jsonl"), line + "\n");
}

/** 缺省求值函数：读 <configDir>/upstreams.json 组链，逐级 timeoutMs 压至 2000（不改档、只改副本）。 */
function makeAskFn(configDir: string): AskFn {
  const fo = loadFailoverConfig(path.join(configDir, "upstreams.json"));
  const chain = fo ? { ...fo, timeoutMs: PERMISSION_TIMEOUT_MS } : null;
  const tracker = chain ? new CooldownTracker(undefined, chain.cooldownMs) : new CooldownTracker();
  return (p) =>
    chain
      ? ask({ ...p, failover: chain, tracker })
      : ask({ ...p, timeoutMs: PERMISSION_TIMEOUT_MS });
}

/** 自宿主 settings 取 permissions.deny（数组之字符串项）；任何畸形静默弃之。 */
export function parseDenyRules(settings: unknown): string[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  const perms = (settings as Record<string, unknown>).permissions;
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) return [];
  const deny = (perms as Record<string, unknown>).deny;
  if (!Array.isArray(deny)) return [];
  return deny.filter((r): r is string => typeof r === "string" && r.trim() !== "");
}

/** 收集用户档与项目档之 deny 规则（前者在前）；解析失败者静默略过。 */
function collectDenyRules(
  cwd: string,
  home: string,
  readText: (filePath: string) => string | null
): string[] {
  const files = [
    path.join(home, ".codebuddy", "settings.json"),
    path.join(cwd, ".codebuddy", "settings.json"),
  ];
  const out: string[] = [];
  for (const f of files) {
    const raw = readText(f);
    if (raw === null) continue;
    try {
      out.push(...parseDenyRules(JSON.parse(raw)));
    } catch {
      /* 坏档：略过 */
    }
  }
  return out;
}

/** 参数节录（供 state 与审计）：命令或文件路径直取，余者 JSON 化；空白归一、截断。 */
function excerptOf(tool: string, input: Record<string, unknown>, max: number): string {
  const name = tool.toLowerCase();
  if (name === "bash" && typeof input.command === "string") return input.command.slice(0, max);
  if (typeof input.file_path === "string") return input.file_path.slice(0, max);
  try {
    return JSON.stringify(input).slice(0, max);
  } catch {
    return "";
  }
}

/** 求值 state：工具名、参照路径、参数原文、工作目录（依 jev-guard 之 state 惯例）。 */
export function buildPermissionState(args: {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
}): string {
  const reference =
    typeof args.input.file_path === "string"
      ? args.input.file_path
      : typeof args.input.path === "string"
        ? args.input.path
        : "";
  let argsText: string;
  try {
    argsText = JSON.stringify(args.input);
  } catch {
    argsText = String(args.input);
  }
  return [
    "Tool: " + args.tool,
    ...(reference !== "" ? ["Reference: " + reference] : []),
    "Command or arguments:",
    argsText.slice(0, MAX_STATE_INPUT_CHARS),
    "Working directory: " + args.cwd,
  ].join("\n");
}

/** 文案：本地判定者不带概率（未求值），模型判定者附 risk/approval 读数。 */
function describe(decision: Decision, riskMean: number, approvalP: number): string {
  const parts: string[] = [];
  if (Number.isFinite(riskMean)) parts.push("risk " + riskMean.toFixed(2) + "/3");
  if (Number.isFinite(approvalP)) parts.push("approval p=" + approvalP.toFixed(2));
  const stat = parts.length > 0 ? "（" + parts.join("，") + "）" : "（本地判定）";
  if (decision === "allow") return "JEV 权限门：已放行" + stat + "。";
  if (decision === "ask") return "JEV 权限门：此调用须你确认" + stat + "。";
  if (decision === "deny") return "JEV 权限门：已拒绝" + stat + "（达 destructive 阈值）。";
  return "";
}

/** 决断 → 钩子输出。silent 与错误同归：返 {}，宿主照旧弹窗。 */
function emitDecision(decision: Decision, reason: string): Record<string, unknown> {
  if (decision === "allow") return allowPre(reason);
  if (decision === "ask") return askPre(reason);
  if (decision === "deny") return denyPre(reason);
  return passOutput();
}

/**
 * PreToolUse 权限门主流程。
 * 关档/不管辖之工具/命中宿主 deny 规则 → {}；observe 唯审计；auto 依判定出 allow/ask/deny。
 * 任何异常 → {}（绝不因此放行）。
 */
export async function handlePermission(
  input: unknown,
  deps: PermissionDeps = {}
): Promise<Record<string, unknown>> {
  try {
    const hook = asHookInput(input);
    if (!hook) return passOutput();
    const tool = typeof hook.tool_name === "string" ? hook.tool_name.trim() : "";
    if (tool === "") return passOutput();

    const configDir = deps.configDir ?? resolveConfigDir();
    const cfg = loadPermissionConfig(path.join(configDir, "auto-approve.json"));
    if (!cfg.enabled) return passOutput();
    const name = tool.toLowerCase();
    if (!cfg.tools.some((t) => t.toLowerCase() === name)) return passOutput();

    const cwd =
      typeof hook.cwd === "string" && hook.cwd.trim() !== "" ? hook.cwd : process.cwd();
    const home = deps.home ?? os.homedir();
    const toolInput =
      hook.tool_input && typeof hook.tool_input === "object" && !Array.isArray(hook.tool_input)
        ? (hook.tool_input as Record<string, unknown>)
        : {};

    // 宿主明言拒绝者：一律沉默（allow 可越过 permissions.deny，不可越权）
    const denyRules = collectDenyRules(cwd, home, deps.readText ?? defaultReadText);
    if (denyRulesMatch(tool, toolInput, denyRules, { cwd, home })) return passOutput();

    const started = (deps.now ?? Date.now)();
    const local: LocalVerdict = assessLocally({ tool, input: toolInput, cwd, home });
    let decision: Decision;
    let riskMean = Number.NaN;
    let approvalP = Number.NaN;
    let error: string | undefined;

    if (local === "pass") {
      try {
        const res: SystemOneResult = await (deps.askFn ?? makeAskFn(configDir))({
          state: buildPermissionState({ tool, input: toolInput, cwd }),
          questions: { risk: ACTION_QUESTIONS.risk, approval: ACTION_QUESTIONS.approval },
        });
        riskMean = meanScore(scoreProbabilities(res?.answers?.risk));
        const p = noulProbability(res?.answers?.approval);
        if (p !== undefined) approvalP = p;
        decision = decidePermission({ local, riskMean, approvalP, cfg });
      } catch (err) {
        // 求值败：无概率即无决断（silent），绝不据错误放行
        error = err instanceof Error ? err.name : "error";
        decision = "silent";
      }
    } else {
      decision = decidePermission({ local, riskMean, approvalP, cfg });
    }

    const line = buildPermissionAudit({
      tool,
      decision,
      riskMean,
      approvalP,
      ms: (deps.now ?? Date.now)() - started,
      excerpt: excerptOf(tool, toolInput, 200),
      host: deps.host ?? detectHost(),
    });
    if (error !== undefined) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        parsed.error = error;
        (deps.writeAudit ?? defaultWriteAudit)(configDir, JSON.stringify(parsed));
      } catch {
        /* 审计失败静默 */
      }
    } else {
      try {
        (deps.writeAudit ?? defaultWriteAudit)(configDir, line);
      } catch {
        /* 审计失败静默 */
      }
    }

    if (cfg.mode !== "auto") return passOutput(); // observe：只留痕，不改宿主行为
    return emitDecision(decision, describe(decision, riskMean, approvalP));
  } catch {
    return passOutput();
  }
}

/**
 * 钩子入口：argv[2] === "perm"。读 stdin 后判定；一律不外抛，stdout 写出由 bin 层独任。
 */
export async function runPermissionHook(
  argv: string[],
  deps: PermissionDeps = {}
): Promise<Record<string, unknown>> {
  try {
    if (argv[2] !== "perm") return passOutput();
    const raw = await (deps.stdin ?? readStdin)();
    const hook = parseHookInput(raw);
    if (!hook) return passOutput();
    return await handlePermission(hook, deps);
  } catch {
    return passOutput();
  }
}

/** 钩子输入形状守卫：非对象（含 null、数组）→ null。 */
function asHookInput(input: unknown): HookInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as HookInput;
}
