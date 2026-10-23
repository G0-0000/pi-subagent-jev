// 规则试跑器：离线预览「某 agent 接到某任务」会否被拦截，另可作 JEV 连通性探针。
// 两种模式：
//   node scripts/try-rules.ts --probe [--upstream <名>]
//       按 failover 链逐级各至多一发（--upstream 则只发该级），打印概率与耗时后报 OK；走既有 ask() 链路，
//       failover 链与 env 档 key 解析与扩展同源。
//   node scripts/try-rules.ts <agent> "<任务原文>" [--audit]
//       按扩展同一套解析（`_all` 全局规则在前 ＋ agent 组，同 id 去重）与同一套阈值矩阵
//       （compliance.ts 之 verdict）判定，打印概率表、有效模式与拦截文案；
//       缺省为干跑，不写 audit.jsonl / training.jsonl，唯 --audit 追加一行审计。
// 配置目录同 cb/host.ts：JEV_CONFIG_DIR 非空白者优先，否则 ~/.pi/agent/jev-comp。
// 与扩展之别仅一处——upstreams.json 亦随该目录解析，JEV_CONFIG_DIR 显式设定时整档隔离（便于测试）。
// 退出码：0＝检查完成（判定违规亦 0，本器唯报告不代决）；1＝参数、配置或求值错误。错误皆简体中文、走 stderr。
// 本器绝不打印 key 与 baseUrl。
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { resolveConfigDir } from "../cb/host.ts";
import {
  auditLine,
  buildState,
  loadRuleSets,
  resolveMode,
  verdict,
  type LoadedRules,
  type RuleConfig,
} from "../jev/compliance.ts";
import { ask, getAskMeta, JevError, type Question, type SystemOneResult } from "../jev/client.ts";
import { CooldownTracker, loadFailoverConfig } from "../jev/failover.ts";

const USAGE = `规则试跑器 —— 离线预览某 agent 之派单会否被拦截，或探 JEV 连通性。

用法：
  node scripts/try-rules.ts --probe [--upstream <名>]
  node scripts/try-rules.ts <agent> "<任务原文>" [--audit]
  node scripts/try-rules.ts --help

模式与选项：
  --probe          探针请求（有 failover 链者按链逐级、每级至多一发），打印概率与耗时，末尾报 OK。
  --upstream <名>  仅配 --probe：直发 upstreams.json 中该上游，绕开链序、冷却与切换。
  <agent> "<任务>" 离线试跑：按组规则 ＋ _all 全局规则一次求值，打印概率表、有效模式与拦截文案。
  --audit          仅配试跑模式：追加一行审计于 <配置目录>/audit.jsonl；缺省不写任何运行时档。

配置目录：JEV_CONFIG_DIR 非空白者优先，否则 ~/.pi/agent/jev-comp。
退出码：0＝检查完成（判定违规亦为 0）；1＝参数、配置或求值错误。`;

/** 探针任务原文与问句（内建常量，不经配置档）。 */
const PROBE_STATE =
  "Fix the typo in README.md line 12 where 'teh' should be 'the'.";
const PROBE_QUESTIONS: Record<string, Question> = {
  T1: { type: "noul", instructions: "Does the task name a concrete file path?" },
};

type Args = {
  help: boolean;
  probe: boolean;
  audit: boolean;
  upstream?: string;
  positionals: string[];
};

/** 参数解析：未知选项、缺值皆即时报错；位置参数留给调用方校验。 */
function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, probe: false, audit: false, positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--probe") {
      args.probe = true;
    } else if (a === "--audit") {
      args.audit = true;
    } else if (a === "--upstream") {
      const v = argv[++i];
      if (v === undefined || v.trim() === "" || v.startsWith("-")) {
        fatal("--upstream 缺少上游名");
      }
      args.upstream = v;
    } else if (a.startsWith("-")) {
      fatal(`未知选项：${a}（--help 查看用法）`);
    } else {
      args.positionals.push(a);
    }
  }
  return args;
}

/** 错误出口：简体中文一句于 stderr，exit 1。 */
function fatal(msg: string): never {
  process.stderr.write(`错误：${msg}\n`);
  process.exit(1);
}

/** JevError 之可读化（只取 kind/status/message/body 摘要与上游名，key 与 baseUrl 一概不入）。 */
function describeError(err: unknown): string {
  if (!(err instanceof JevError)) return String(err);
  const parts = [`kind=${err.kind}`];
  if (err.status !== undefined) parts.push(`status=${err.status}`);
  parts.push(err.message);
  if (err.bodySummary) parts.push(`body=${err.bodySummary}`);
  if (err.failoverAttempts && err.failoverAttempts.length > 0) {
    parts.push(
      `failover=${err.failoverAttempts
        .map((a) =>
          a.kind === "cooldown"
            ? `${a.name}(cooldown)`
            : `${a.name}:${a.status ?? a.kind ?? "-"}`
        )
        .join(" → ")}`
    );
  }
  return parts.join(" ");
}

/** 取指定问句之 noul 概率；缺失或非有限数一概不收（与 compliance 侧同法，缺席即 unknown）。 */
function noulProbs(res: SystemOneResult, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const a = res.answers?.[id];
    if (a && typeof a === "object" && "noul" in a && typeof a.noul === "number" && Number.isFinite(a.noul)) {
      out[id] = a.noul;
    }
  }
  return out;
}

/** 求值链路所需之 failover 配置与冷却表（随 JEV 配置目录解析，缺档则走单端点链路）。 */
function buildTransport(configDir: string): {
  upstreamsPath: string;
  failover: ReturnType<typeof loadFailoverConfig>;
  tracker: CooldownTracker | undefined;
} {
  const upstreamsPath = path.join(configDir, "upstreams.json");
  const failover = loadFailoverConfig(upstreamsPath);
  return {
    upstreamsPath,
    failover,
    tracker: failover ? new CooldownTracker(undefined, failover.cooldownMs) : undefined,
  };
}

/** 连通性探针：每上游至多一发，成功则打印概率与耗时并以 OK 收尾。 */
async function runProbe(upstream: string | undefined): Promise<number> {
  const configDir = resolveConfigDir();
  const { upstreamsPath, failover, tracker } = buildTransport(configDir);
  const t0 = Date.now();
  try {
    const res = await ask({
      state: PROBE_STATE,
      questions: PROBE_QUESTIONS,
      failover,
      tracker,
      upstream,
      upstreamsPath,
    });
    const p = noulProbs(res, ["T1"]).T1;
    if (p === undefined) {
      process.stderr.write("错误：响应缺少 T1 之 noul 概率（字段缺失或非有限数）。\n");
      return 1;
    }
    console.log(`T1 概率：${p.toFixed(3)}`);
    console.log(`耗时：${Date.now() - t0}ms`);
    console.log("OK");
    return 0;
  } catch (err) {
    process.stderr.write(`错误：JEV 探针失败——${describeError(err)}\n`);
    return 1;
  }
}

/**
 * 有效规则：`_all` 全局规则（全局在前）＋ agent 组（同 id 已列全局者弃之），
 * 与 checkDispatch 逐字同法；instructions 空白者无可问之题，跳过。
 * agentDesc：有专属组取组内值，无专属组（仅 `_all` 生效）写死 "a sub-agent"。
 */
function effectiveRules(
  agent: string,
  loaded: LoadedRules
): { rules: RuleConfig[]; agentDesc: string } {
  const rs = loaded.agents[agent];
  const globalRules = loaded.all?.rules ?? [];
  const globalIds = new Set(globalRules.map((r) => r.id));
  const combined = [...globalRules, ...(rs?.rules ?? []).filter((r) => !globalIds.has(r.id))];
  return {
    rules: combined.filter(
      (r) => typeof r.instructions === "string" && r.instructions.trim() !== ""
    ),
    agentDesc: rs ? rs.agentDesc : "a sub-agent",
  };
}

/** 概率表渲染：id | probability | threshold | blockWhen | hit | message（末列不补齐）。 */
function renderTable(rules: RuleConfig[], probs: Record<string, number>): string {
  const header = ["id", "probability", "threshold", "blockWhen", "hit", "message"];
  const rows = rules.map((r) => {
    const p = probs[r.id];
    const hit =
      p === undefined ? "—" : (r.blockWhen === "below" ? p < r.threshold : p > r.threshold) ? "是" : "否";
    return [r.id, p === undefined ? "—" : p.toFixed(3), String(r.threshold), r.blockWhen, hit, r.message];
  });
  const widths = header.map((h, i) =>
    Math.max(...[h, ...rows.map((row) => row[i])].map((s) => Array.from(s).length))
  );
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) =>
        i === cells.length - 1 ? c : c + " ".repeat(widths[i] - Array.from(c).length)
      )
      .join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  return [fmt(header), sep, ...rows.map(fmt)].join("\n");
}

/** 违规项：概率有限且越过阈值者（同 checkDispatch 之拦截判定）。 */
function collectViolations(rules: RuleConfig[], probs: Record<string, number>): RuleConfig[] {
  return rules.filter((r) => {
    const p = probs[r.id];
    if (p === undefined) return false; // 概率缺失：不拦（fail-open）
    return r.blockWhen === "below" ? p < r.threshold : p > r.threshold;
  });
}

/** 审计行落盘（仅 --audit）：形状与扩展成功路径同源，经 auditLine() 构造。 */
function writeAuditLine(configDir: string, line: ReturnType<typeof auditLine>): void {
  try {
    appendFileSync(path.join(configDir, "audit.jsonl"), JSON.stringify(line) + "\n");
  } catch (err) {
    process.stderr.write(`提示：审计行写入失败（已忽略）——${String(err)}\n`);
  }
}

/** 离线规则试跑：解析 → 一次求值 → 概率表 → 判定与拦截文案。 */
async function runCheck(agent: string, task: string, audit: boolean): Promise<number> {
  const configDir = resolveConfigDir();
  const rulesPath = path.join(configDir, "compliance-rules.json");
  const loaded = loadRuleSets(rulesPath);
  const { rules, agentDesc } = effectiveRules(agent, loaded);
  const mode = resolveMode(agent, loaded);

  console.log(`配置档：${rulesPath}${existsSync(rulesPath) ? "" : "（不存在，视作无规则）"}`);
  console.log(`agent：${agent}；有效模式：${mode}`);

  if (rules.length === 0) {
    console.log("无适用规则（无专属组，`_all` 亦无有效引用）——该派单将直接放行。");
    return 0;
  }
  if (loaded.global.transport === "builtin") {
    process.stderr.write("提示：配置档 transport=builtin，本脚本仅支持 selfhost 传输，按 selfhost 求值。\n");
  }

  const { upstreamsPath, failover, tracker } = buildTransport(configDir);
  const state = buildState(agent, agentDesc, task);
  const questions = Object.fromEntries(
    rules.map((r) => [
      r.id,
      {
        type: "noul" as const,
        instructions: r.instructions,
        ...(r.criteria ? { criteria: r.criteria } : {}),
      },
    ])
  );

  const start = Date.now();
  let res: SystemOneResult;
  try {
    res = await ask({ state, questions, failover, tracker, upstreamsPath });
  } catch (err) {
    process.stderr.write(`错误：JEV 求值失败——${describeError(err)}\n`);
    return 1;
  }
  const latencyMs = Date.now() - start;

  const probs = noulProbs(res, rules.map((r) => r.id));
  const v = verdict(rules, probs);
  const violations = collectViolations(rules, probs);

  console.log("");
  console.log(renderTable(rules, probs));
  console.log("");

  if (violations.length > 0) {
    // 与扩展之 block reason 逐字同形（首行、逐条 - 前缀、末行）
    console.log(`派单审核未通过（agent=${agent}）：`);
    for (const r of violations) console.log(`- ${r.id}: ${r.message}`);
    console.log("请修正任务描述后重派。");
    if (mode === "warn") {
      console.log("有效模式为 warn：实际派单不被阻断，上列违规清单将作为提示附于该次派单的工具结果之末。");
    }
  } else {
    console.log("判定：通过（无误拦之规则命中）。");
  }

  if (audit) {
    const meta = getAskMeta(res);
    const routed = !!(meta && (meta.attempts.length > 0 || meta.fallback));
    writeAuditLine(
      configDir,
      auditLine({
        agent,
        task,
        model: res.model,
        rules: v.rules,
        verdict: v.verdict,
        latencyMs,
        blocked: violations.map((r) => r.id),
        probs: loaded.global.auditProbabilities ? probs : undefined,
        ...(mode === "warn" && violations.length > 0 ? { action: "warn" as const } : {}),
        ...(routed && meta
          ? {
              upstream: meta.upstream,
              failover: meta.attempts,
              ...(meta.fallback ? { fallback: true } : {}),
            }
          : {}),
      })
    );
    console.log(`已追加审计行：${path.join(configDir, "audit.jsonl")}`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help || (args.positionals.length === 0 && !args.probe)) {
    console.log(USAGE);
    return 0;
  }

  if (args.probe) {
    if (args.positionals.length > 0) {
      fatal("--probe 不接受位置参数（用法见 --help）");
    }
    if (args.audit) {
      fatal("--audit 仅用于规则试跑模式，不配 --probe");
    }
    return runProbe(args.upstream);
  }

  if (args.upstream !== undefined) {
    fatal("--upstream 仅用于 --probe 模式");
  }
  if (args.positionals.length !== 2) {
    process.stderr.write(USAGE + "\n");
    fatal("试跑模式须恰给两个位置参数：<agent> 与 <任务原文>");
  }
  const [agent, task] = args.positionals;
  if (agent.trim() === "") fatal("<agent> 不得为空白");
  if (task.trim() === "") fatal("<任务原文> 不得为空白");
  return runCheck(agent, task, args.audit);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  fatal(describeError(err));
}
