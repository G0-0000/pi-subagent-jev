// 工具权限自动审批之门（纯逻辑层）：本地确定性判定、概率阈值判定、审计行、宿主 deny 规则匹配。
// 零网络、零子进程；唯 loadPermissionConfig 读一次配置档。钩子面见 cb/permission-main.ts。
//
// 立场（关键）：绝不以命令原文之子串匹配作判据——宿主旧判定的误报正源于此
// （rg -e "rm -rf" src/ 被当作删除命令）。本层先按 shell 运算符（&& || ; | 换行）切段（引号内不切），
// 再逐段引号感知分词，取命令之 basename 落确定性名单；路径参数一律展开 ~ 后解析为绝对路径，
// 与 cwd/home 相较。凡不可静态判定者（$ 变量、反引号、越界路径、危险命令、通配删除）一律 ask，
// 不作推测性放行。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── 配置 ──

export type PermissionMode = "observe" | "auto";
export type DestructiveAction = "ask" | "deny";

export type PermissionConfig = {
  enabled: boolean;
  /** observe：只落审计、不改宿主行为；auto：按判定输出 allow/ask/deny */
  mode: PermissionMode;
  /** 本门管辖之工具名（大小写不敏感） */
  tools: string[];
  risk: { askScore: number; denyScore: number };
  approval: { askP: number };
  /** riskMean 达 denyScore 时之处置：ask（交人）或 deny（拒之） */
  destructiveAction: DestructiveAction;
};

/** 缺省工具集：宿主会为人审弹窗之写/执行类工具（唯 hooks.json matcher 所列者；WebFetch 不在其列）。 */
export const DEFAULT_PERMISSION_TOOLS = ["Bash", "Write", "Edit", "MultiEdit"];

/** 缺省配置：关闭。每次返回新对象，免跨调用共享可变态。 */
export function defaultPermissionConfig(): PermissionConfig {
  return {
    enabled: false,
    mode: "observe",
    tools: [...DEFAULT_PERMISSION_TOOLS],
    risk: { askScore: 1.5, denyScore: 2.5 },
    approval: { askP: 0.75 },
    destructiveAction: "ask",
  };
}

/** 配置档缺省路径：<JEV_CONFIG_DIR|~/.pi/agent/jev-comp>/auto-approve.json（与 cb/host.ts 同源）。 */
export function defaultPermissionConfigPath(
  env: Record<string, string | undefined> = process.env
): string {
  const dir =
    typeof env.JEV_CONFIG_DIR === "string" && env.JEV_CONFIG_DIR.trim() !== ""
      ? env.JEV_CONFIG_DIR
      : path.join(os.homedir(), ".pi", "agent", "jev-comp");
  return path.join(dir, "auto-approve.json");
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isScore(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 3;
}

function isProbability(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 1;
}

/**
 * 读配置档：档缺/不可读/非 JSON/非对象 → 全缺省（enabled:false）。逐字段校验，坏值静默回该字段缺省，
 * 绝不因一处坏值废全档（与 compliance-rules 之 fail-open 同例）。
 */
export function loadPermissionConfig(
  pathOverride?: string,
  env: Record<string, string | undefined> = process.env
): PermissionConfig {
  const cfg = defaultPermissionConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(pathOverride ?? defaultPermissionConfigPath(env), "utf-8"));
  } catch {
    return cfg;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cfg;
  const o = raw as Record<string, unknown>;

  if (typeof o.enabled === "boolean") cfg.enabled = o.enabled;
  if (o.mode === "observe" || o.mode === "auto") cfg.mode = o.mode;

  if (Array.isArray(o.tools)) {
    const tools = o.tools.filter((t): t is string => typeof t === "string" && t.trim() !== "");
    if (tools.length > 0) cfg.tools = tools.map((t) => t.trim());
  }

  const risk = o.risk && typeof o.risk === "object" ? (o.risk as Record<string, unknown>) : null;
  if (risk) {
    if (isScore(risk.askScore)) cfg.risk.askScore = risk.askScore;
    if (isScore(risk.denyScore)) cfg.risk.denyScore = risk.denyScore;
  }

  const approval =
    o.approval && typeof o.approval === "object" ? (o.approval as Record<string, unknown>) : null;
  if (approval && isProbability(approval.askP)) cfg.approval.askP = approval.askP;

  if (o.destructiveAction === "ask" || o.destructiveAction === "deny") {
    cfg.destructiveAction = o.destructiveAction;
  }
  return cfg;
}

// ── 概率 → 分值 ──

/**
 * score 答案之均值：sum(档位 × 概率)，档位取自概率表之键（"0".."3"）。
 * 非数字键或非有限概率一概跳过；一档都不剩 → NaN（调用方据此静默，不作推测）。
 */
export function meanScore(probabilities: Record<string, number> | undefined | null): number {
  if (!probabilities || typeof probabilities !== "object") return Number.NaN;
  let sum = 0;
  let n = 0;
  for (const [k, p] of Object.entries(probabilities)) {
    const level = Number(k);
    if (!Number.isFinite(level) || !isFiniteNumber(p)) continue;
    sum += level * p;
    n += 1;
  }
  return n === 0 ? Number.NaN : sum;
}

/** 自答案对象取 score 之概率表：兼容嵌套 {score:{probabilities}} 与平铺 {probabilities}。 */
export function scoreProbabilities(answer: unknown): Record<string, number> | undefined {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  const o = answer as Record<string, unknown>;
  const inner =
    o.score && typeof o.score === "object" && !Array.isArray(o.score)
      ? (o.score as Record<string, unknown>)
      : o;
  const probs = inner.probabilities;
  return probs && typeof probs === "object" && !Array.isArray(probs)
    ? (probs as Record<string, number>)
    : undefined;
}

/** 自答案对象取 noul 之概率（有限数方取，否则 undefined）。 */
export function noulProbability(answer: unknown): number | undefined {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  const v = (answer as Record<string, unknown>).noul;
  return isFiniteNumber(v) ? v : undefined;
}

// ── 本地确定性判定 ──

/** allow：本地即判安全，无须求值；ask：本地即判须人审；pass：本地无定论，交模型。 */
export type LocalVerdict = "allow" | "ask" | "pass";

/**
 * 只读命令（皆在路径参数不出 cwd/home 之前提下方 allow）。
 * 入名单者须无「嵌套执行」与「越界写档」之途：sed 故不入——GNU sed 之 e 命令与 s///e 旗标执行
 * 任意命令，w/r 命令写读任意档。awk/rg/sort 之同类逃逸另于 isReadOnly 单判；
 * find 亦不入（-delete/-exec 之害须另设排除方可用，不值其繁）。
 */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "rg", "grep", "fd", "tree", "jq", "awk", "sort",
  "uniq", "cut", "tr", "diff", "comm", "stat", "file", "du", "df", "which", "pwd", "echo",
  "printf", "true", "basename", "dirname", "realpath", "make", "tsc",
]);
/** git 之只读子命令（branch/remote 唯列示形，另判）。 */
const GIT_READ_ONLY = new Set([
  "status", "diff", "log", "show", "rev-parse", "blame", "describe", "shortlog", "ls-files", "grep",
]);
/** git branch / remote 之列示旗标：余者（-d/-D/-m、add/remove/set-url 等）皆写。 */
const GIT_BRANCH_LIST = /^(-[alrv]+|--list|--all|--remotes|--show-current|--contains|--merged|--no-merged)$/;
const GIT_REMOTE_LIST = /^(-v|--verbose|show)$/;
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const PKG_RUN_SAFE = new Set(["build", "lint"]);
const CARGO_READ_ONLY = new Set(["test", "check", "clippy", "build"]);
const GO_READ_ONLY = new Set(["test", "build", "vet"]);
const SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash"]);
const FETCHERS = new Set(["curl", "wget"]);
/** 壳之 -c 递归上限：再深则不可判，一律 pass。 */
const MAX_SHELL_DEPTH = 2;

/** 无论参数如何皆须人审之命令。 */
const ALWAYS_ASK = new Set([
  "shutdown", "reboot", "poweroff", "halt", "init", "sudo", "su", "mount", "umount",
  "systemctl", "crontab", "useradd", "userdel", "iptables",
]);

/** 写类工具（须审其文件路径）。 */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit"]);

/** 宿主本就不弹窗之工具：径直 allow。 */
const PASS_THROUGH_ALLOW = new Set(["read", "glob", "grep", "webfetch", "websearch"]);

/** 输出重定向之安全汇集处（写之亦无害）。 */
const SAFE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

type Ctx = { cwd: string; home: string };

/**
 * 展开 ~ 并解析为绝对路径（相对路径以 cwd 为基）；不可静态判定者返 null。
 * 唯 `~`、`~/…` 与 `~<当前用户>/…` 可展开；他形（~user、~+、~-）壳会展开至别处
 * （如 ~root 即 /root），静态不可判，调用方一律 ask。
 */
function expandPath(spec: string, ctx: Ctx): string | null {
  const user = path.basename(ctx.home);
  if (spec === "~") return path.resolve(ctx.home);
  if (spec.startsWith("~/")) return path.resolve(ctx.home, spec.slice(2));
  if (spec === "~" + user) return path.resolve(ctx.home);
  if (spec.startsWith("~" + user + "/")) return path.resolve(ctx.home, spec.slice(user.length + 2));
  if (spec.startsWith("~")) return null;
  return path.resolve(ctx.cwd, spec);
}

/** child 是否在 parent 之内（含相等）。上跳唯认「..」与「../…」，如「..x」「...」之目录名不算越界。 */
function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + path.sep)) return false;
  return !path.isAbsolute(rel);
}

function underRoots(p: string, ctx: Ctx): boolean {
  return isUnder(p, ctx.cwd) || isUnder(p, ctx.home);
}

/** 形如路径之参数（旗标除外）：绝对、~ 起首、./ ../ 起首，或含分隔符。 */
function looksLikePath(tok: string): boolean {
  if (tok === "" || tok.startsWith("-")) return false;
  return (
    tok.startsWith("/") ||
    tok.startsWith("~") ||
    tok.startsWith("./") ||
    tok.startsWith("../") ||
    tok.includes("/")
  );
}

/**
 * 按 shell 运算符切段：&& || ; | 换行（引号内不切）。& 仅在非重定向时视作运算符
 * （2>&1 / &> 之 & 属重定向，不切）。未闭合引号不报错，余文归本段。
 */
export function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        cur += ch + command[++i];
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += ch + command[++i];
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|") {
      if (ch === "|" && command[i + 1] === "|") i += 1;
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        i += 1;
        out.push(cur);
        cur = "";
        continue;
      }
      const prev = i > 0 ? command[i - 1] : "";
      const next = command[i + 1] ?? "";
      if (prev === ">" || prev === "<" || next === ">") {
        cur += ch; // 重定向之 &（2>&1、&>file）
        continue;
      }
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 引号感知分词：去引号、去转义；引号内之空白不切。 */
export function tokenizeSegment(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        cur += segment[++i];
        has = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
      has = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** 去前导 VAR=value 赋值。 */
function stripAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  return tokens.slice(i);
}

function subcommand(words: string[]): string {
  return (words[1] ?? "").toLowerCase();
}

function hasFlag(words: string[], re: RegExp): boolean {
  return words.slice(1).some((w) => re.test(w));
}

/** awk 之逃逸途：system()／管道／重定向写档／@include，及自档载入程序之 -f/-i/-l（含长形）。 */
function awkEscapes(words: string[]): boolean {
  return words.some(
    (w) =>
      w.includes("system(") ||
      w.includes("|") ||
      w.includes(">") ||
      w.includes("@include") ||
      /^-(f|i|l)|^--(file|include|load)/.test(w)
  );
}

/**
 * git 是否只读：-c／--config-env／--paginate 皆可令 git 执行外部程序（别名、pager），一律不认；
 * --output=PATH 直接写任意档（diff/log/show 皆有此旗标，且整只为一词、路径扫描看不出），亦不认；
 * grep 之 -O/--open-files-in-pager 同样执行外部程序，一并排除。
 * branch／remote 唯列示形为只读（-d/-D/-m、add/remove/set-url 等皆写）。
 */
function isReadOnlyGit(words: string[]): boolean {
  const before = words.slice(1);
  if (before.some((w) => w === "-c" || w.startsWith("--config-env") || w === "--paginate")) {
    return false;
  }
  if (hasFlag(words, /^--output(=|$)/)) return false;
  if (subcommand(words) === "grep" && hasFlag(words, /^-O|^--open-files-in-pager/)) return false;
  const sub = subcommand(words);
  if (sub === "branch") return words.slice(2).every((w) => GIT_BRANCH_LIST.test(w));
  if (sub === "remote") return words.slice(2).every((w) => GIT_REMOTE_LIST.test(w));
  return GIT_READ_ONLY.has(sub);
}

/** 只读判定（仅就命令 basename 与参数而言；路径越界另由调用方先判）。 */
function isReadOnly(cmd: string, words: string[]): boolean {
  if (cmd === "git") return isReadOnlyGit(words);
  if (PKG_MANAGERS.has(cmd)) {
    const sub = subcommand(words);
    if (sub === "test" || sub === "ci") return true;
    return sub === "run" && PKG_RUN_SAFE.has((words[2] ?? "").toLowerCase());
  }
  if (cmd === "node") return words[1] === "--test";
  if (cmd === "python" || cmd === "python3") {
    return words[1] === "-m" && words[2] === "pytest";
  }
  if (cmd === "cargo") return CARGO_READ_ONLY.has(subcommand(words));
  if (cmd === "go") return GO_READ_ONLY.has(subcommand(words));
  // 就地改写或可执行外部程序者一律不认只读
  if (cmd === "sort" && hasFlag(words, /^-o|^--output|^--compress-program/)) return false;
  if (cmd === "rg" && hasFlag(words, /^--pre(=|$)/)) return false;
  if (cmd === "fd" && hasFlag(words, /^-(x|X)$|^--exec(-batch)?$/)) return false;
  if (cmd === "awk" && awkEscapes(words)) return false;
  // jq 之程序在引号内，> 不属壳重定向、径由重定向分析看不出：程序里凡有 > 皆不认只读
  if (cmd === "jq" && words.some((w) => w.includes(">"))) return false;
  // tree 之 -o FILE 写档（连写形 -o/tmp/x 唯作一词，路径扫描看不出）
  if (cmd === "tree" && hasFlag(words, /^-o/)) return false;
  return READ_ONLY_COMMANDS.has(cmd);
}

/** 危险命令判定（ask 之确定性底线）。 */
function isDestructive(cmd: string, words: string[], ctx: Ctx): boolean {
  if (ALWAYS_ASK.has(cmd) || cmd.startsWith("mkfs")) return true;
  if (cmd === "dd" && words.some((w) => w.startsWith("of=/dev/"))) return true;
  if (cmd === "kill" && words.includes("-9") && words.includes("-1")) return true;
  if ((cmd === "chmod" || cmd === "chown") && hasFlag(words, /^-[A-Za-z]*R|^--recursive$/)) {
    const targets = words.slice(1).filter((w) => !w.startsWith("-"));
    for (const t of targets) {
      const p = expandPath(t, ctx);
      if (p === null || p === path.parse(p).root || p === ctx.home) return true;
    }
  }
  return false;
}

/** rm 之递归/强删：目标为根、家目录、当前目录或越界，或含通配 → ask。 */
function isDangerousRm(cmd: string, words: string[], ctx: Ctx): boolean {
  if (cmd !== "rm") return false;
  const rest = words.slice(1);
  const flags = rest.filter((w) => w.startsWith("-"));
  const recursive = flags.some((f) => /^-[A-Za-z]*[rR]/.test(f) || f === "--recursive");
  const force = flags.some((f) => /^-[A-Za-z]*f/.test(f) || f === "--force");
  if (!recursive && !force) return false;
  const targets = rest.filter((w) => !w.startsWith("-"));
  if (targets.length === 0) return false;
  for (const t of targets) {
    if (/[?*]|\[/.test(t)) return true; // 通配：范围不可静态确定
    const p = expandPath(t, ctx);
    if (p === null) return true; // ~user 等：静态不可判
    if (p === ctx.cwd || p === ctx.home || p === path.parse(p).root) return true;
    if (!underRoots(p, ctx)) return true;
  }
  return false;
}

const REDIRECT_RE = /^(\d*|&)?(>>?)(.*)$/;

/**
 * 输出重定向：目标越 cwd/home 即 ask（/dev/null 等安全汇集处除外；&1 之类 fd 复制不算路径）。
 * 返回判定与被消费之 token 下标（这些下标由通用路径扫描跳过，免重复判、免误判 /dev/null）。
 */
function analyzeRedirects(words: string[], ctx: Ctx): { verdict: LocalVerdict; skip: Set<number> } {
  const skip = new Set<number>();
  let verdict: LocalVerdict = "allow";
  for (let i = 0; i < words.length; i++) {
    const m = REDIRECT_RE.exec(words[i]!);
    if (!m) continue;
    skip.add(i);
    let target = m[3] ?? "";
    if (target === "") {
      target = words[i + 1] ?? "";
      if (i + 1 < words.length) skip.add(i + 1);
    }
    if (target === "" || target.startsWith("&")) continue; // 2>&1 之类：fd 复制
    if (SAFE_SINKS.has(target)) continue;
    const p = expandPath(target, ctx);
    if (p === null || !underRoots(p, ctx)) verdict = "ask";
  }
  return { verdict, skip };
}

/** 单段判定：危险 > 重定向 > 路径越界 > 壳 -c 递归 > 只读名单。 */
function assessSegment(tokens: string[], ctx: Ctx, depth: number): LocalVerdict {
  const words = stripAssignments(tokens);
  if (words.length === 0) return "allow";
  const cmd = path.basename(words[0]!);

  // 命令替换（反引号、$(…)）静态不可判，一律问人；未解析变量唯于路径参数中判
  //（awk 之 $1 之类非路径参数不在此列——过宽即失自动放行之义）
  if (words.some((w) => w.includes("`") || w.includes("$("))) return "ask";
  if (words.some((w) => looksLikePath(w) && w.includes("$"))) return "ask";

  if (isDestructive(cmd, words, ctx)) return "ask";
  if (isDangerousRm(cmd, words, ctx)) return "ask";

  const redirect = analyzeRedirects(words, ctx);
  if (redirect.verdict === "ask") return "ask";

  for (let i = 0; i < words.length; i++) {
    if (redirect.skip.has(i)) continue;
    const w = words[i]!;
    if (!looksLikePath(w)) continue;
    const p = expandPath(w, ctx);
    if (p === null || !underRoots(p, ctx)) return "ask";
  }

  if (SHELLS.has(cmd)) {
    // 壳之 -c 值即完整命令行：递归再判（深限 MAX_SHELL_DEPTH）；不可判者 pass，绝不 allow
    const script = shellScriptOf(words);
    if (script === null || depth >= MAX_SHELL_DEPTH) return "pass";
    return assessCommand(script, ctx, depth + 1);
  }

  return isReadOnly(cmd, words) ? "allow" : "pass";
}

/**
 * 自 shell 段取 -c 之脚本：形如「-c script」「-cscript」「-lc script」。
 * 无 -c 或无值 → null（调用方视作普通 shell 命令，pass）。
 */
function shellScriptOf(words: string[]): string | null {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (!w.startsWith("-") || w.startsWith("--")) continue;
    const idx = w.indexOf("c");
    if (idx < 1) continue;
    const rest = w.slice(idx + 1);
    return rest !== "" ? rest : (words[i + 1] ?? null);
  }
  return null;
}

/** 整条命令之判定：切段 → 取回即喂壳之拦截 → 逐段判。任段 ask 即 ask，否则任段 pass 即 pass。 */
function assessCommand(command: string, ctx: Ctx, depth: number): LocalVerdict {
  const segs = splitShellSegments(command)
    .map(tokenizeSegment)
    .filter((t) => t.length > 0);
  if (segs.length === 0) return "pass";
  const cmds = segs.map((t) => path.basename(stripAssignments(t)[0] ?? ""));
  // 取回即喂壳（curl|sh、wget|bash）：典型投放执行
  for (let i = 0; i < cmds.length; i++) {
    if (!SHELLS.has(cmds[i]!)) continue;
    for (let j = 0; j < i; j++) if (FETCHERS.has(cmds[j]!)) return "ask";
  }
  const verdicts = segs.map((t) => assessSegment(t, ctx, depth));
  if (verdicts.includes("ask")) return "ask";
  return verdicts.includes("pass") ? "pass" : "allow";
}

/** 秘密路径：任何时候写之皆须人审（纵在 home 内）。 */
function isSensitivePath(p: string, ctx: Ctx): boolean {
  const base = path.basename(p);
  if (/^\.env/.test(base) || /\.pem$/i.test(base) || /\.key$/i.test(base) || /^id_rsa/.test(base)) {
    return true;
  }
  const rel = path.relative(ctx.home, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const norm = rel.split(path.sep).join("/");
  if (norm === ".ssh" || norm.startsWith(".ssh/")) return true;
  if (norm === ".gnupg" || norm.startsWith(".gnupg/")) return true;
  if (norm === ".aws" || norm.startsWith(".aws/")) return true;
  if (norm === ".config/jev-comp" || norm.startsWith(".config/jev-comp/")) return true;
  if (path.posix.dirname(norm) === ".codebuddy" && /^settings.*\.json$/.test(base)) return true;
  return false;
}

/**
 * 本地确定性判定。
 * Bash：逐段判；任一段 ask 即 ask，否则任一段 pass 即 pass，全 allow 方 allow。
 * Write/Edit/MultiEdit：路径在 cwd/home 内且非秘密路径 → allow，否则 ask。
 * Read/Glob/Grep/WebFetch/WebSearch → allow（宿主本不弹窗）；他工具 → pass。
 */
export function assessLocally(args: {
  tool: unknown;
  input: unknown;
  cwd?: string;
  home?: string;
}): LocalVerdict {
  const tool = typeof args.tool === "string" ? args.tool : "";
  const name = tool.toLowerCase();
  const ctx: Ctx = {
    cwd: path.resolve(typeof args.cwd === "string" && args.cwd !== "" ? args.cwd : process.cwd()),
    home: path.resolve(typeof args.home === "string" && args.home !== "" ? args.home : os.homedir()),
  };
  const input =
    args.input && typeof args.input === "object" && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>)
      : {};

  if (name === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (command.trim() === "") return "pass";
    return assessCommand(command, ctx, 0);
  }

  if (WRITE_TOOLS.has(name)) {
    const filePath =
      typeof input.file_path === "string"
        ? input.file_path
        : typeof input.path === "string"
          ? input.path
          : undefined;
    if (filePath === undefined || filePath === "") return "pass";
    const p = expandPath(filePath, ctx);
    if (p === null || isSensitivePath(p, ctx)) return "ask";
    return underRoots(p, ctx) ? "allow" : "ask";
  }

  if (PASS_THROUGH_ALLOW.has(name)) return "allow";
  return "pass";
}

// ── 判定矩阵 ──

/** allow/ask/deny：本门之决断；silent：无决断，宿主照旧弹窗（fail-open 之形）。 */
export type Decision = "allow" | "ask" | "deny" | "silent";

/**
 * 决断矩阵：
 *  本地 allow/ask 直接采用；本地 pass 则看模型概率——
 *  risk 达 denyScore → destructiveAction；达 askScore → ask；approval 达 askP → ask；余者 allow。
 *  risk 与 approval **须俱为有限数**方出决断：任一缺失/非有限即 silent（宁放宿主弹窗，
 *  绝不据半份证据放行——半份常是响应截断或解析坏之征兆）。
 */
export function decidePermission(args: {
  local: LocalVerdict;
  riskMean: number;
  approvalP: number;
  cfg: PermissionConfig;
}): Decision {
  const { local, cfg } = args;
  if (local === "allow") return "allow";
  if (local === "ask") return "ask";
  const risk = args.riskMean;
  const approval = args.approvalP;
  if (!isFiniteNumber(risk) || !isFiniteNumber(approval)) return "silent";
  if (risk >= cfg.risk.denyScore) return cfg.destructiveAction;
  if (risk >= cfg.risk.askScore) return "ask";
  if (approval >= cfg.approval.askP) return "ask";
  return "allow";
}

// ── 审计 ──

/**
 * 秘密遮蔽：API key、bearer token 与 Authorization 头之值不得入审计档。
 * bearer 下界取 12 字（16 起则 12–15 字之 token 漏网）；Authorization 头之值不论长短整段遮蔽。
 */
function maskSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(
      /(\bauthorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;]+(?:\s+[^\s"',;]+)?)/gi,
      "$1***"
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1***")
    .replace(/\s+/g, " ")
    .trim();
}

/** 审计行（单行 JSON 字符串）：ts/host/kind/tool/decision/risk/approval/latency_ms/excerpt。 */
export function buildPermissionAudit(fields: {
  tool: string;
  decision: Decision;
  riskMean: number;
  approvalP: number;
  ms: number;
  excerpt: string;
  ts?: string;
  host?: string;
}): string {
  return JSON.stringify({
    ts: fields.ts ?? new Date().toISOString(),
    host: fields.host ?? "codebuddy",
    kind: "permission",
    tool: fields.tool,
    decision: fields.decision,
    risk: isFiniteNumber(fields.riskMean) ? Number(fields.riskMean.toFixed(3)) : null,
    approval: isFiniteNumber(fields.approvalP) ? Number(fields.approvalP.toFixed(3)) : null,
    latency_ms: Math.max(0, Math.round(fields.ms)),
    excerpt: maskSecrets(fields.excerpt).slice(0, 200),
  });
}

// ── 宿主 deny 规则匹配 ──
// 宿主明言 deny 之调用，本门须保持沉默——钩子之 allow 可越过 permissions.deny，
// 故绝不能以 allow 覆盖用户显式拒绝。规则形如 「Bash(cmd:*)」「Write(/etc/**)」「Bash」。

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.*+?^$|()\[\]{}\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

/** 归一命令文本：去首尾空白、去前导 VAR=value 赋值。 */
function normalizeCommandText(text: string): string {
  let s = text.trim();
  for (;;) {
    const next = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
    if (next === s) return s;
    s = next.trim();
  }
}

/** 命令之候选形：整条（归一后）与按 shell 运算符切段（各归一后）——复合命令须逐段比。 */
function bashCandidates(command: string): string[] {
  const out = new Set<string>();
  const whole = normalizeCommandText(command);
  if (whole !== "") out.add(whole);
  for (const seg of splitShellSegments(command)) {
    const n = normalizeCommandText(seg);
    if (n !== "") out.add(n);
  }
  return [...out];
}

function matchBashRule(pattern: string, command: string): boolean {
  const matches = (c: string): boolean => {
    if (pattern.endsWith(":*")) return c.startsWith(pattern.slice(0, -2));
    if (pattern.includes("*") || pattern.includes("?")) return globToRegExp(pattern).test(c);
    return c === pattern;
  };
  return bashCandidates(command).some(matches);
}

function matchPathRule(pattern: string, rawPath: string, ctx: Ctx): boolean {
  const abs = expandPath(rawPath, ctx);
  if (abs === null) return true; // ~user 等：静态不可判，保守视为命中
  const candidates = new Set<string>([rawPath, abs]);
  const re = globToRegExp(pattern);
  for (const c of candidates) {
    if (c === pattern || re.test(c)) return true;
  }
  return false;
}

/**
 * 是否命中宿主 deny 规则。规则解析：「Tool(arg)」或「Tool」；Tool 名大小写不敏感。
 * Bash 之 arg 支持「前缀:*」与通配，比之于归一后之整条命令与各切段（去空白、去 VAR=value 前缀）；
 * Write/Edit/MultiEdit 之 arg 按路径通配（原文与绝对化形皆比）。工具同名而无参数者视为全匹配；
 * 字符串而形不可解析者亦视为命中——本门唯沉默，宿主照旧弹窗，宁过勿漏（宁沉默，勿越权放行）。
 */
export function denyRulesMatch(
  tool: string,
  input: unknown,
  denyRules: string[],
  opts: { cwd?: string; home?: string } = {}
): boolean {
  if (!Array.isArray(denyRules) || denyRules.length === 0) return false;
  const name = String(tool ?? "").toLowerCase();
  const ctx: Ctx = {
    cwd: path.resolve(opts.cwd ?? process.cwd()),
    home: path.resolve(opts.home ?? os.homedir()),
  };
  const inputObj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  for (const rule of denyRules) {
    if (typeof rule !== "string") continue;
    const m = /^\s*([A-Za-z0-9_.:-]+)\s*(?:\((.*)\))?\s*$/.exec(rule);
    if (!m) return true; // 形不可解析：保守视为命中（本门沉默，宿主照旧弹窗）
    if (m[1]!.toLowerCase() !== name) continue;
    const arg = m[2];
    if (arg === undefined) return true;
    if (name === "bash") {
      const command = typeof inputObj.command === "string" ? inputObj.command : "";
      if (matchBashRule(arg, command)) return true;
      continue;
    }
    const filePath =
      typeof inputObj.file_path === "string"
        ? inputObj.file_path
        : typeof inputObj.path === "string"
          ? inputObj.path
          : "";
    if (filePath === "") return true; // 工具同名而参数无从比：保守视为匹配
    if (matchPathRule(arg, filePath, ctx)) return true;
  }
  return false;
}
