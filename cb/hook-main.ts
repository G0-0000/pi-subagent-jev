// 钩子适配主逻辑（CodeBuddy Code 与 Claude Code 共用）：PreToolUse 派单审核、PostToolUse 交付 warn 提示。
// 复用 jev/compliance.ts 之 loadRuleSets / checkDispatch / resolveMode 与 formatWarnNotice 原样不改；
// 求值走 jev/client.ts 之 ask()（自管 curl 链，多上游 failover 读 <configDir>/upstreams.json）。
// 与 pi 侧共享 ~/.pi/agent/jev-comp（JEV_CONFIG_DIR 可覆写），规则故为单一来源。
// 红线照旧：任何错误 fail-open（返 {}、绝不外抛）、不写 key/baseUrl 于任何输出、stdout 唯一个 JSON。
// 本批不含 builtin 传输、思考深度调整与运行监控（见 docs/codebuddy.md、docs/claude-code.md 已知限制）。
import { appendFileSync } from "node:fs";
import path from "node:path";
import { ask, type SystemOneResult } from "../jev/client.ts";
import {
  checkDispatch,
  formatWarnNotice,
  loadRuleSets,
  resolveMode,
  type AskFn,
} from "../jev/compliance.ts";
import { CooldownTracker, loadFailoverConfig } from "../jev/failover.ts";
import {
  denyPre,
  detectHost,
  parseHookInput,
  passOutput,
  pickCallId,
  readStdin,
  resolveConfigDir,
  type HookInput,
} from "./host.ts";
import { takeWarning, writeWarning } from "./warn-state.ts";

/** 派单工具名：CodeBuddy 文档作 Task，实装为 Agent，二者皆认。 */
const DISPATCH_TOOL_RE = /^(Task|Agent)$/;

/** 派单描述：自 tool_input 取四要素；缺者按契约缺省（agent=unknown、task=""）。 */
export type DispatchSpec = {
  agent: string;
  task: string;
  model?: string;
  runInBackground?: boolean;
};

/** 自钩子输入解析派单描述（畸形 tool_input 视作空对象，不抛）。 */
export function parseDispatch(input: HookInput): DispatchSpec {
  const ti =
    input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
      ? (input.tool_input as Record<string, unknown>)
      : {};
  const agentRaw = ti.subagent_type;
  const agent = typeof agentRaw === "string" && agentRaw !== "" ? agentRaw : "unknown";
  const task = typeof ti.prompt === "string" ? ti.prompt : "";
  const model = typeof ti.model === "string" && ti.model !== "" ? ti.model : undefined;
  const runInBackground =
    typeof ti.run_in_background === "boolean" ? ti.run_in_background : undefined;
  return { agent, task, model, runInBackground };
}

/**
 * block 模式拒绝文案：与 pi 扩展逐字相同（pi 扩展内联书写，无导出之格式器，故此处本地成形）。
 * 首行 agent 名，每条违规一行以 `- ` 前缀，末行固定修正之令。
 */
export function formatBlockReason(agent: string, violations: string[]): string {
  return `派单审核未通过（agent=${agent}）：\n${violations
    .map((m) => `- ${m}`)
    .join("\n")}\n请修正任务描述后重派。`;
}

export type HookDeps = {
  /** 求值函数（缺省走 ask()＋<configDir>/upstreams.json 之 failover 链；测试注入） */
  askFn?: AskFn;
  /** 配置目录（缺省 resolveConfigDir()） */
  configDir?: string;
  /** 时钟（缺省 Date.now；测试注入以验 TTL） */
  now?: () => number;
  /** stdin 读取器（缺省 readStdin；测试注入） */
  stdin?: () => Promise<string>;
  /** 审计行写入器（缺省追加 <configDir>/audit.jsonl；测试可注入） */
  writeAudit?: (configDir: string, line: Record<string, unknown>) => void;
  /** 审计行 host 值（缺省 detectHost()；测试注入以验宿主归属） */
  host?: string;
};

/** 缺省求值函数：读 <configDir>/upstreams.json 组链；缺档/坏档回旧单端点链路（fail-open）。 */
function makeAskFn(configDir: string): AskFn {
  const failover = loadFailoverConfig(path.join(configDir, "upstreams.json"));
  const tracker = failover
    ? new CooldownTracker(undefined, failover.cooldownMs)
    : new CooldownTracker();
  return (p) => ask({ ...p, failover, tracker });
}

function defaultWriteAudit(configDir: string, line: Record<string, unknown>): void {
  appendFileSync(path.join(configDir, "audit.jsonl"), JSON.stringify(line) + "\n");
}

/**
 * PreToolUse：派单审核。
 * 放行/空任务/无规则/无违规 → {}；block 命中 → deny 输出；
 * warn 命中 → 提示落盘（键 tool_use_id，缺则 call_id），仍返 {}。
 * 审计每有求值落一行（host 取 deps.host，缺省 detectHost() 判宿主）；任何异常皆返 {}。
 */
export async function handlePre(
  input: unknown,
  deps: HookDeps = {}
): Promise<Record<string, unknown>> {
  try {
    const hook = asHookInput(input);
    if (!hook) return passOutput();
    if (typeof hook.tool_name === "string" && !DISPATCH_TOOL_RE.test(hook.tool_name)) {
      return passOutput();
    }
    const dispatch = parseDispatch(hook);
    if (dispatch.task.trim() === "") return passOutput();

    const configDir = deps.configDir ?? resolveConfigDir();
    const rules = loadRuleSets(path.join(configDir, "compliance-rules.json"));
    const mode = resolveMode(dispatch.agent, rules);
    const res = await checkDispatch(dispatch.agent, dispatch.task, {
      askFn: deps.askFn ?? makeAskFn(configDir),
      ruleSets: rules.agents,
      allRules: rules.all ?? undefined,
      auditProbabilities: rules.global.auditProbabilities,
      trainingLog: rules.global.trainingLog,
      mode,
    });
    if (!res) return passOutput();

    (deps.writeAudit ?? defaultWriteAudit)(configDir, {
      ...res.line,
      host: deps.host ?? detectHost(),
    });

    if (res.violations.length === 0) return passOutput();
    if (mode === "warn") {
      const key = pickCallId(hook);
      if (key !== undefined) {
        writeWarning(configDir, key, formatWarnNotice(dispatch.agent, res.violations), {
          now: (deps.now ?? Date.now)(),
        });
      }
      return passOutput();
    }
    return denyPre(formatBlockReason(dispatch.agent, res.violations));
  } catch {
    return passOutput();
  }
}

/**
 * PostToolUse：取回并删除该派单之 warn 提示。
 * 有则附 additionalContext，无则 {}；键缺失或任何异常皆 {}。
 */
export function handlePost(
  input: unknown,
  deps: HookDeps = {}
): Record<string, unknown> {
  try {
    const hook = asHookInput(input);
    if (!hook) return passOutput();
    const key = pickCallId(hook);
    if (key === undefined) return passOutput();
    const configDir = deps.configDir ?? resolveConfigDir();
    const text = takeWarning(configDir, key, { now: (deps.now ?? Date.now)() });
    if (text === undefined) return passOutput();
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: text,
      },
    };
  } catch {
    return passOutput();
  }
}

/**
 * 钩子入口：argv[2] 为 pre | post | session。
 * pre/post 读 stdin 后分派；session 本批无语义（批二主会话治理再用），恒返 {}。
 * 一律不外抛；stdout 写出由 bin 层独任。
 */
export async function runHook(
  argv: string[],
  deps: HookDeps = {}
): Promise<Record<string, unknown>> {
  try {
    const mode = argv[2];
    if (mode !== "pre" && mode !== "post") return passOutput();
    const raw = await (deps.stdin ?? readStdin)();
    const hook = parseHookInput(raw);
    if (!hook) return passOutput();
    return mode === "pre" ? await handlePre(hook, deps) : handlePost(hook, deps);
  } catch {
    return passOutput();
  }
}

/** 钩子输入形状守卫：非对象（含 null、数组）→ null。 */
function asHookInput(input: unknown): HookInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as HookInput;
}
