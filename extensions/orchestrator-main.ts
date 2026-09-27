/**
 * Orchestrator 主会话扩展（opt-in 版）
 *
 * 三职责：
 *   ① 注入 —— 将 persona 档正文（剥 YAML frontmatter）以 <orchestrator_role>
 *      包裹追加至系统提示末尾；
 *   ② 裁剪/拦截 —— 按 blockedTools 裁剪主会话活动工具并同步拦截其调用
 *      （独不拦 subagent，派单之门常开）；
 *   ③ 子 agent 豁免 —— session_start 里惰性挂 pi-subagents/capability-ceiling。
 *
 * opt-in 语义：默认全不启用。唯 ~/.pi/agent/jev-comp/orchestrator.json
 * 存在且可解析方启用——档之有无即功能之启停；档坏/读败静默不启用
 * （fail-open，与 jev 铁律同宗）。personaFile 所指档不存在时，唯注入一步
 * 静默跳过，裁剪与豁免照启。
 *
 * 主/子判别与 pi-subagents 上游同构：唯一原语 PI_SUBAGENT_CHILD === "1"
 *（pi-subagents 包根 index.ts 亦以此为准）。子 agent 进程一钩不注。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ── 配置（opt-in） ──

const CONFIG_FILE = join(homedir(), ".pi", "agent", "jev-comp", "orchestrator.json");

// persona 档缺省位置（XDG 风通用路径；本机可于配置档以 personaFile 指回己档）
const DEFAULT_PERSONA_FILE = join(homedir(), ".config", "pi-orchestrator", "persona.md");

// 默认裁剪清单：主 agent 之直执行/直检索工具；独不含 subagent
const DEFAULT_BLOCKED_TOOLS = [
  "bash",
  "find",
  "grep",
  "rg",
  "ls",
  "bash_output",
  "kill",
  "web_search",
  "web_fetch",
  "research_checkpoint",
  "gbrain_search",
  "gbrain_capture",
];

interface OrchestratorConfig {
  personaFile: string;
  blockedTools: Set<string>;
  ceiling: Record<string, unknown>;
}

// 配置档内路径得用 ~ 指家目录
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// 读配置档：无档/读败/解析败/非对象皆返 null（静默不启用，fail-open）。
// 各键皆可选，缺省回内建默认；非法字段静默弃之回默认。
function loadConfig(): OrchestratorConfig | null {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const personaFile =
    typeof obj.personaFile === "string" && obj.personaFile.trim() !== ""
      ? expandHome(obj.personaFile)
      : DEFAULT_PERSONA_FILE;

  const blockedTools =
    Array.isArray(obj.blockedTools) && obj.blockedTools.every((t) => typeof t === "string")
      ? new Set<string>(obj.blockedTools as string[])
      : new Set<string>(DEFAULT_BLOCKED_TOOLS);

  const ceiling =
    typeof obj.ceiling === "object" && obj.ceiling !== null && !Array.isArray(obj.ceiling)
      ? (obj.ceiling as Record<string, unknown>)
      : { denyExtensions: false };

  return { personaFile, blockedTools, ceiling };
}

const BEGIN_MARKER = "<orchestrator_role>";
const END_MARKER = "</orchestrator_role>";

interface CachedBody {
  mtime: number;
  body: string;
}

let cache: CachedBody | null = null;

// 主/子判别：与 pi-subagents 上游同构，唯一原语即 PI_SUBAGENT_CHILD。
// 该变量仅由 subagent-runner 子进程模块顶层设置，主进程永不置 1。
function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

// capability-ceiling 模块之型（自立接口，不赖类型解析，免触模块根隔离）
interface CapabilityCeilingModule {
  registerSubagentCapabilityCeiling: (entry: {
    sessionId: string;
    source: string;
    ceiling: { denyExtensions: boolean };
  }) => void;
}

// 加载宿主之 pi-subagents/capability-ceiling。pi 各包模块根隔离，自仓目录
// 解析不到宿主依赖；而 ceiling 注册乃纯内存注册表，须取宿主实例本体——
// 仓内自给依赖徒注册于自家实例，宿主读不到。故先直 import（ambient 或可
// 解析情形），败则以宿主 npm 目录为基准 createRequire 解析取绝对路径再
// import；两路皆败则抛，由调用方 catch 兜底（fail-open，唯失豁免）。
async function importCapabilityCeiling(): Promise<CapabilityCeilingModule> {
  try {
    return (await import("pi-subagents/capability-ceiling")) as CapabilityCeilingModule;
  } catch {
    const hostRequire = createRequire(join(homedir(), ".pi", "agent", "npm", "noop.js"));
    const resolved = hostRequire.resolve("pi-subagents/capability-ceiling");
    return (await import(pathToFileURL(resolved).href)) as CapabilityCeilingModule;
  }
}

function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return raw.trim();
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex === -1) {
    return raw.trim();
  }
  return lines.slice(endIndex + 1).join("\n").trim();
}

// 读 persona 正文（mtimeMs 缓存；ENOENT 静默返 null——唯注入一步跳过）
function loadPersonaBody(personaFile: string): string | null {
  try {
    const stats = statSync(personaFile);
    if (cache && cache.mtime === stats.mtimeMs) {
      return cache.body;
    }
    const raw = readFileSync(personaFile, "utf-8");
    const body = stripFrontmatter(raw);
    cache = { mtime: stats.mtimeMs, body };
    return body;
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = null;
      return null;
    }
    throw err;
  }
}

export default function (pi: ExtensionAPI) {
  // ── 子 agent 之道：显式空分支，一钩不注 ──
  if (isSubagentChild()) return;

  // ── opt-in 之门：无配置档/坏档则全不启用，一钩不注 ──
  const config = loadConfig();
  if (!config) return;

  // ── 主 agent 之道 ──

  // 取当前活动工具，以配置清单滤除禁用项；仅在长度缩减时设置，
  // 沿用原顺序保留其余工具，不引入另一份名单、不重新启用其他工具。
  const pruneActiveTools = () => {
    const active = pi.getActiveTools();
    const filtered = active.filter((name: string) => !config.blockedTools.has(name));
    if (filtered.length < active.length) {
      pi.setActiveTools(filtered);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (isSubagentChild()) return; // 纵深防御

    // ① 注册子 agent 豁免（纯内存注册表，与请求前缀无涉）。
    //    惰性 import：pi-subagents 失联仅失豁免，不殃及注入与剪枝。
    //    pi-subagents 解析 ceiling 恒以 getSessionFile() 优先为 key，故仅注册档案路径。
    try {
      const { registerSubagentCapabilityCeiling } = await importCapabilityCeiling();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) {
        registerSubagentCapabilityCeiling({
          sessionId: sessionFile,
          source: "orchestrator-ceiling",
          ceiling: config.ceiling as { denyExtensions: boolean },
        });
      }
    } catch (err) {
      if (ctx.hasUI) {
        ctx.ui.notify(`⚠️ 子 agent 豁免注册失败：${String(err)}`, "warning");
      }
    }

    // ② 剪枝（唯一触请求前缀者，殿后）
    pruneActiveTools();

    // ③ 通报
    if (ctx.hasUI) {
      ctx.ui.notify(
        "🔒 Orchestrator — parent: read+subagent only, children: full power",
        "info",
      );
    }
  });

  // 每轮起始：幂等维持裁剪 + 注入 orchestrator 行为 prompt
  pi.on("before_agent_start", async (event) => {
    if (isSubagentChild()) return; // 纵深防御

    // 幂等剪枝：防止后续工具注册重新带回禁用项
    pruneActiveTools();

    // 注入 persona 正文（mtimeMs 缓存；ENOENT 静默跳过本轮）
    const body = loadPersonaBody(config.personaFile);
    if (!body) return;

    // 防止同一轮/同一次系统提示里重复追加
    if (event.systemPrompt?.includes(BEGIN_MARKER)) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${BEGIN_MARKER}\n${body}\n${END_MARKER}`,
    };
  });

  pi.on("tool_call", (event, ctx) => {
    if (isSubagentChild()) return; // 纵深防御
    if (config.blockedTools.has(event.toolName)) {
      if (ctx.hasUI) {
        ctx.ui.notify(`🔒 "${event.toolName}" blocked — use subagent`, "info");
      }
      return {
        block: true,
        reason: `🔒 Orchestrator: "${event.toolName}" blocked. Delegate to subagent.`,
      };
    }
  });
}
