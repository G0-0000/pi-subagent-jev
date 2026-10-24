// 工具权限自动审批之门（钩子面）：PreToolUse 读 stdin，本地判定优先、模型概率兜底，
// 按配置 mode（observe 只审计 / auto 出决断）输出 allow/ask/deny，末附审计行。
// 逻辑层在 jev/permission.ts（纯逻辑、可测），求值走 jev/client.ts 之 ask()（自管 curl 链）。
//
// 三条不可越之线：
//   1. 宿主 deny 规则命中即沉默（返 {}）——钩子之 allow 可越过 permissions.deny，绝不能以 allow 覆盖用户显式拒绝。
//      宿主 ask 规则命中亦然：用户已明言须问，本门不得代答。
//   2. 任何错误/超时 → 沉默（返 {}），绝不因错误而放行。
//   3. 钩子须在超时内归：链上每级 timeoutMs 压至 2000（最坏三级 6s < 钩子 8s），且绝无重试。
//
// jevWhen（缺省 host-prompt）之下，本地无定论者亦未必问模型：唯宿主真会弹窗者（Bash 命中 stage 3
// 危险正则）方问，余者静默交宿主（审计记 decision:"silent"、reason:"host-would-allow"）。
// 上述 stage 3 正则照录 CodeBuddy；Claude Code 之宿主规则另取 ~/.claude 与 <cwd>/.claude 诸档，
// 其 host-prompt 之下保守地凡本地无定论者皆问（详见 shouldConsultJev）。
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
  hostWouldPrompt,
  loadPermissionConfig,
  meanScore,
  noulProbability,
  scoreProbabilities,
  type Decision,
  type LocalVerdict,
  type PermissionConfig,
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
  /** 环境变量（缺省 process.env；测试注入 CLAUDE_CONFIG_DIR 等） */
  env?: NodeJS.ProcessEnv;
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

/** 自宿主 settings 取 permissions.<key>（数组之字符串项）；任何畸形静默弃之。 */
export function parseRuleList(settings: unknown, key: "deny" | "ask"): string[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  const perms = (settings as Record<string, unknown>).permissions;
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) return [];
  const list = (perms as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is string => typeof r === "string" && r.trim() !== "");
}

/** permissions.deny 之规则。 */
export function parseDenyRules(settings: unknown): string[] {
  return parseRuleList(settings, "deny");
}

/** permissions.ask 之规则（宿主明确须问者，本门亦不得代答）。 */
export function parseAskRules(settings: unknown): string[] {
  return parseRuleList(settings, "ask");
}

/**
 * 宿主 settings 档之路径（序即优先级，前者先）：
 * Claude Code 用户档取 $CLAUDE_CONFIG_DIR/settings.json（未设则 ~/.claude/settings.json），
 * 其后项目档 <cwd>/.claude/settings.json 与项目本地档 <cwd>/.claude/settings.local.json；
 * 余者（CodeBuddy）为用户档 ~/.codebuddy/settings.json 与项目档 <cwd>/.codebuddy/settings.json。
 * 纯函数，不读档。
 */
export function hostSettingsFiles(
  host: string,
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (host === "claude-code") {
    const raw = env.CLAUDE_CONFIG_DIR;
    const configDir =
      typeof raw === "string" && raw.trim() !== "" ? raw.trim() : path.join(home, ".claude");
    return [
      path.join(configDir, "settings.json"),
      path.join(cwd, ".claude", "settings.json"),
      path.join(cwd, ".claude", "settings.local.json"),
    ];
  }
  return [
    path.join(home, ".codebuddy", "settings.json"),
    path.join(cwd, ".codebuddy", "settings.json"),
  ];
}

/** 收集宿主用户档与项目档之 permissions.<key> 规则（前者在前）；解析失败者静默略过。 */
function collectRules(
  host: string,
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv,
  readText: (filePath: string) => string | null,
  key: "deny" | "ask"
): string[] {
  const files = hostSettingsFiles(host, cwd, home, env);
  const out: string[] = [];
  for (const f of files) {
    const raw = readText(f);
    if (raw === null) continue;
    try {
      out.push(...parseRuleList(JSON.parse(raw), key));
    } catch {
      /* 坏档：略过 */
    }
  }
  return out;
}

/**
 * 本地无定论者是否须问模型：
 * jevWhen=always → 皆问（旧行为）；host-prompt → 唯 Bash 且命令命中宿主 stage 3 危险正则者。
 * host-prompt 之下写类工具不问——bypassPermissions 时宿主本不为 Write/Edit/MultiEdit 弹窗，
 * 无由代其决断。前提是宿主跑 bypassPermissions；非然者，宿主自会按本分之规处置。
 *
 * Claude Code 例外：hostWouldPrompt 之正则照录 CodeBuddy 之命令安全检查，于 Claude 不适用；
 * 故其 host-prompt 之下凡本地无定论者皆问模型（保守之策——宿主之 ask 规则已于此前另行筛过，
 * 多问一发不过增一分明审，绝不致误放）。
 */
function shouldConsultJev(
  cfg: PermissionConfig,
  tool: string,
  input: Record<string, unknown>,
  host: string
): boolean {
  if (cfg.jevWhen === "always") return true;
  if (host === "claude-code") return true;
  if (tool.toLowerCase() !== "bash") return false;
  return hostWouldPrompt(typeof input.command === "string" ? input.command : "");
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
 * 关档/不管辖之工具/命中宿主 deny 或 ask 规则 → {}；observe 唯审计；auto 依判定出 allow/ask/deny。
 * 本地无定论者按 jevWhen 决是否问模型：不问者静默（{}），审计记 silent/host-would-allow。
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

    const host = deps.host ?? detectHost();
    const env = deps.env ?? process.env;
    const cwd =
      typeof hook.cwd === "string" && hook.cwd.trim() !== "" ? hook.cwd : process.cwd();
    const home = deps.home ?? os.homedir();
    const toolInput =
      hook.tool_input && typeof hook.tool_input === "object" && !Array.isArray(hook.tool_input)
        ? (hook.tool_input as Record<string, unknown>)
        : {};

    // 宿主明言拒绝或明言须问者：一律沉默（allow 可越过宿主规则，不可越权；宿主自会处置）
    const readText = deps.readText ?? defaultReadText;
    const denyRules = collectRules(host, cwd, home, env, readText, "deny");
    if (denyRulesMatch(tool, toolInput, denyRules, { cwd, home })) return passOutput();
    const askRules = collectRules(host, cwd, home, env, readText, "ask");
    if (denyRulesMatch(tool, toolInput, askRules, { cwd, home })) return passOutput();

    const started = (deps.now ?? Date.now)();
    const local: LocalVerdict = assessLocally({ tool, input: toolInput, cwd, home });
    let decision: Decision;
    let riskMean = Number.NaN;
    let approvalP = Number.NaN;
    let error: string | undefined;
    let reason: string | undefined;

    if (local === "pass" && !shouldConsultJev(cfg, tool, toolInput, host)) {
      // 宿主本不弹窗（bypassPermissions 下唯 stage 3 之高危命令弹）：不问模型，静默交宿主
      decision = "silent";
      reason = "host-would-allow";
    } else if (local === "pass") {
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
      host,
      ...(reason !== undefined ? { reason } : {}),
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
