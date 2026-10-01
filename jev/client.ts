// JEV API client（端点由 JEV_AI_BASE_URL 配置，无内建默认）。零 npm 依赖，curl 传输。
// 任何输出 / 错误消息不得包含 API key。env 档（~/.config/jev-comp/env）可配三键：
// JEV_AI_API_KEY / JEV_AI_BASE_URL / JEV_AI_MODEL（model 仅作用于 ask()）。
// 多上游 failover：ask() 可携 failover 配置按序切换上游（每级一发、同端绝不重发、
// 不退避不睡眠；冷却跳过见 jev/failover.ts）。failover 缺席或显式传 baseUrl/apiKey 时行为与旧单端点逐字节一致。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import {
  classifyFailure,
  defaultCooldownTracker,
  loadFailoverConfig,
  type AttemptRecord,
  type CooldownTracker,
  type FailoverConfig,
} from "./failover.ts";

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};
export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria?: Record<string, string>;
  options: Record<string, string | null>;
};
export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria?: Record<string, string>;
  levels: Record<string, string | null>;
};
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type Answer =
  | { noul: number }
  | { choice: { value: string; probabilities: Record<string, number>; confidence: number } }
  | { score: { value: number; probabilities: Record<string, number>; confidence: number } };

export type Usage = { input_tokens?: number; output_tokens?: number; [k: string]: unknown };

export type SystemOneResult = {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
  /** 本次求值之耗时毫秒（整数；自管链各路径皆附，内建链无此字段） */
  ms?: number;
};

export type JevErrorKind =
  | "not_configured"
  | "unauthorized"
  | "payment_required"
  | "invalid_request"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "network"
  | "unknown_upstream"
  | "unexpected";

export class JevError extends Error {
  kind: JevErrorKind;
  status?: number;
  bodySummary?: string;
  retryAfterMs?: number;
  stderr?: string;
  /** failover 全链败尽时携带历次尝试记录（仅链路耗尽时非空） */
  failoverAttempts?: AttemptRecord[];

  constructor(
    kind: JevErrorKind,
    message: string,
    opts: {
      status?: number;
      bodySummary?: string;
      retryAfterMs?: number;
      stderr?: string;
      failoverAttempts?: AttemptRecord[];
    } = {}
  ) {
    super(message);
    this.name = "JevError";
    this.kind = kind;
    this.status = opts.status;
    this.bodySummary = opts.bodySummary;
    this.retryAfterMs = opts.retryAfterMs;
    this.stderr = opts.stderr;
    this.failoverAttempts = opts.failoverAttempts;
  }
}

export type JevConfig = {
  baseUrl?: string;
  apiKey?: string;
  envFile?: string;
  proxy?: string;
  timeoutMs?: number;
};

type ResolvedConfig = {
  baseUrl: string;
  apiKey: string;
  proxy: string;
  timeoutMs: number;
};

/** env 档路径解析序：显式参数 envFile > 进程 env JEV_AI_ENV_FILE > 默认 ~/.config/jev-comp/env。 */
function resolveEnvFilePath(cfg: JevConfig): string {
  return (
    cfg.envFile ??
    process.env.JEV_AI_ENV_FILE ??
    pathMod.join(os.homedir(), ".config", "jev-comp", "env")
  );
}

function resolveConfig(cfg: JevConfig = {}): ResolvedConfig {
  // key 解析序：显式参数 > 进程 env JEV_AI_API_KEY > env 档；全落空 → not_configured。
  // baseUrl 解析序：显式参数 > 进程 env JEV_AI_BASE_URL > env 档；全落空 → not_configured。
  // 红线：key 之值绝不得进入任何错误消息 / 日志 / 返回文本。
  const envFilePath = resolveEnvFilePath(cfg);
  let apiKey = "";
  if (cfg.apiKey !== undefined) {
    apiKey = cfg.apiKey;
  } else if (process.env.JEV_AI_API_KEY) {
    apiKey = process.env.JEV_AI_API_KEY;
  } else {
    apiKey = readEnvFile(envFilePath).JEV_AI_API_KEY || "";
  }
  if (!apiKey) {
    throw new JevError(
      "not_configured",
      "JEV API key 未配置（解析序：显式参数 apiKey → 环境变量 JEV_AI_API_KEY → env 档 JEV_AI_ENV_FILE/~/.config/jev-comp/env，均未得）"
    );
  }
  const rawBaseUrl =
    cfg.baseUrl !== undefined
      ? cfg.baseUrl
      : process.env.JEV_AI_BASE_URL ||
        readEnvFile(envFilePath).JEV_AI_BASE_URL ||
        "";
  if (!rawBaseUrl) {
    throw new JevError(
      "not_configured",
      "JEV_AI_BASE_URL 未配置（解析序：显式参数 baseUrl → 环境变量 JEV_AI_BASE_URL → env 档，均未得）"
    );
  }
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const proxy =
    cfg.proxy !== undefined ? cfg.proxy : process.env.JEV_AI_PROXY || "";
  const timeoutMs = cfg.timeoutMs !== undefined ? cfg.timeoutMs : 30_000;
  return { baseUrl, apiKey, proxy, timeoutMs };
}

/** 解析 env 档内容：识 `export KEY=VALUE` 与 `KEY=VALUE`，去首尾空白与成对引号。 */
function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

// 进程内缓存：同一路径一次 parse 足用。
const envFileCache = new Map<string, Record<string, string>>();

function readEnvFile(filePath: string): Record<string, string> {
  const cached = envFileCache.get(filePath);
  if (cached) return cached;
  let parsed: Record<string, string> = {};
  try {
    parsed = parseEnvFile(fs.readFileSync(filePath, "utf-8"));
  } catch {
    parsed = {}; // 档不存在或不可读 → 空，由调用方落 not_configured
  }
  envFileCache.set(filePath, parsed);
  return parsed;
}

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function summarizeBody(body: string, max = 300): string {
  const s = body.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return parseInt(v, 10) * 1000;
  const t = Date.parse(v);
  if (!Number.isNaN(t)) {
    const ms = t - Date.now();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}

function parseHeadersFile(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return headers;
}

interface CurlResult {
  code: number; // curl exit code
  stdout: string;
  stderr: string;
}

function runCurl(args: string[], input: string | null): Promise<CurlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(new JevError("network", "curl 启动失败", { stderr: err.message }))
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/** 核心传输：调 curl，把 HTTP 状态与 curl 退出码映射为结果或 JevError。不自动重试。 */
async function request(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  cfg: JevConfig
): Promise<unknown> {
  const { baseUrl, apiKey, proxy, timeoutMs } = resolveConfig(cfg);
  const url = baseUrl + path;
  const payload = body === undefined ? null : JSON.stringify(body);

  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "jev-"));
  const bodyPath = pathMod.join(dir, "body");
  const hdrPath = pathMod.join(dir, "headers");
  try {
    const args = [
      "-sS",
      "-o", bodyPath,
      "-D", hdrPath,
      "-w", "%{http_code}",
      "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      ...(apiKey ? ["-H", `Authorization: Bearer ${apiKey}`] : []),
      "-H", "Content-Type: application/json",
      method === "POST" ? "--data" : null,
      method === "POST" ? "@-" : null,
      url,
    ].filter((a): a is string => a !== null);
    if (proxy && !isLocalUrl(url)) {
      args.push("-x", proxy);
    }

    const { code, stdout, stderr } = await runCurl(args, payload);
    const httpCode = parseInt(stdout.trim(), 10);
    let respBody = "";
    let headers: Record<string, string> = {};
    try {
      respBody = fs.readFileSync(bodyPath, "utf-8");
      headers = parseHeadersFile(fs.readFileSync(hdrPath, "utf-8"));
    } catch {
      /* 文件缺失则留空 */
    }

    if (code === 28) {
      throw new JevError("timeout", `请求超时（--max-time ${Math.ceil(timeoutMs / 1000)}s）`);
    }
    if (code !== 0) {
      throw new JevError("network", `curl 退出码 ${code}`, { stderr: stderr.trim() });
    }
    if (Number.isNaN(httpCode)) {
      throw new JevError("unexpected", "curl 未返回 HTTP 状态码", { stderr: stderr.trim() });
    }

    switch (httpCode) {
      case 200:
        break;
      case 401:
        throw new JevError("unauthorized", "认证失败（HTTP 401）", { status: 401 });
      case 402:
        throw new JevError("payment_required", "需要付费（HTTP 402）", { status: 402 });
      case 422:
        throw new JevError("invalid_request", "请求无效（HTTP 422）", {
          status: 422,
          bodySummary: summarizeBody(respBody),
        });
      case 429:
        throw new JevError("rate_limited", "触发限流（HTTP 429）", {
          status: 429,
          retryAfterMs: parseRetryAfter(headers["retry-after"]),
        });
      case 502:
      case 504:
        throw new JevError("upstream", `上游故障（HTTP ${httpCode}）`, { status: httpCode });
      default:
        throw new JevError("unexpected", `非预期 HTTP 状态 ${httpCode}`, {
          status: httpCode,
          bodySummary: summarizeBody(respBody),
        });
    }

    try {
      return JSON.parse(respBody);
    } catch {
      throw new JevError("unexpected", "HTTP 200 但响应体不是合法 JSON", {
        bodySummary: summarizeBody(respBody),
      });
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

export type AskParams = {
  state: string | object | string[];
  questions: Record<string, Question>;
  model?: string;
  /** 多上游链路：null/undefined 走旧单端点链路（fail-open） */
  failover?: FailoverConfig | null;
  /** 冷却跳过表；缺省用进程内共享 defaultCooldownTracker */
  tracker?: CooldownTracker;
  /**
   * 单发直测（quick-probe）：给 upstreams.json 中某 NAME 时，恰发一发至该上游——
   *  bypass 链序、冷却与切换（红线：同端绝不重发）。仅自管链识别，内建链忽略。
   *  与显式 baseUrl/apiKey 同传时后者优先（量具读数不混入他端点）。
   */
  upstream?: string;
  /** upstreams.json 路径覆写（仅供测试；缺省走 failover.ts 之 DEFAULT_UPSTREAMS_PATH） */
  upstreamsPath?: string;
} & JevConfig;

// ── 传输 meta（胜出 upstream 与历次尝试）──
// 机制：不可枚举 symbol 属性。对 AskFn 返回类型 SystemOneResult 形状零改动，
// JSON.stringify / Object.keys 均不可见，旧消费方逐字节不变；compliance 层读之以落 audit。
const ASK_META = Symbol("jev.askMeta");

export type AskMeta = {
  /** 胜出（成功返回）之 upstream 名 */
  upstream: string;
  /** 切换发生时的失败尝试记录（首级即成则空数组） */
  attempts: AttemptRecord[];
  /** 保底尝试标记：全链冷却时被迫真发首名；仅在该情形下出现 */
  fallback?: boolean;
};

/** 写入 ask() 结果上之传输 meta（不可枚举 symbol；compliance 测试与内部使用）。 */
export function setAskMeta(res: SystemOneResult, meta: AskMeta): void {
  try {
    Object.defineProperty(res, ASK_META, {
      value: meta,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    /* 冻结对象等极端情形：meta 缺席无害 */
  }
}

/** 读取 ask() 结果上之传输 meta（无则 undefined——旧链路或未发生）。 */
export function getAskMeta(res: SystemOneResult): AskMeta | undefined {
  return (res as Record<PropertyKey, unknown>)[ASK_META] as AskMeta | undefined;
}

function withAttempts(err: JevError, attempts: AttemptRecord[]): JevError {
  err.failoverAttempts = [...attempts];
  return err;
}

/** System One：对 state 求值一组类型化问题。不自动重试（同一 upstream 之 POST 绝不重发）；
 *  携 failover 链路时按序切换上游，每级一发。 */
export async function ask(params: AskParams): Promise<SystemOneResult> {
  const { state, questions, model, failover, tracker, upstream, upstreamsPath, ...cfg } = params;
  // 显式 baseUrl/apiKey（如校准脚本）绕开链路——量具读数不得混入他端点。
  const chain =
    failover && cfg.baseUrl === undefined && cfg.apiKey === undefined ? failover : null;

  // quick-probe 单发直测：upstream 给名时恰发一发至该上游——bypass 链序、冷却与切换。
  // 零冷却读写（tracker 不触）；未匹配之名报 unknown_upstream（仅列名，绝不泄 baseUrl/apiKey）。
  if (upstream !== undefined && cfg.baseUrl === undefined && cfg.apiKey === undefined) {
    const fo = loadFailoverConfig(upstreamsPath);
    const up = fo?.upstreams.find((u) => u.name === upstream);
    if (!up) {
      const names = fo ? fo.upstreams.map((u) => u.name) : [];
      throw new JevError(
        "unknown_upstream",
        names.length > 0
          ? `upstreams.json 中无名为 "${upstream}" 之上游；可用名：${names.join(", ")}`
          : `upstreams.json 缺失或无效，无法直测上游 "${upstream}"`
      );
    }
    const t0 = Date.now();
    const res = (await request(
      "POST",
      "/v1/systemone",
      { model: model ?? up.model, state, questions },
      {
        baseUrl: up.baseUrl,
        apiKey: up.apiKey,
        proxy: up.proxy, // 缺省 → resolveConfig 走既有 JEV_AI_PROXY 链
        timeoutMs: fo.timeoutMs,
      }
    )) as SystemOneResult;
    if (!res || typeof res !== "object" || !res.answers) {
      throw new JevError("unexpected", "响应缺少 answers 字段");
    }
    res.ms = Math.max(0, Math.round(Date.now() - t0));
    setAskMeta(res, { upstream: up.name, attempts: [] });
    return res;
  }

  if (!chain) {
    // 旧单端点链路（与历版逐字节一致）。
    // model 解析序：显式参数 > 进程 env JEV_AI_MODEL > env 档 > 内建默认（env 档路径与 apiKey 同序）。
    const resolvedModel =
      model ??
      (process.env.JEV_AI_MODEL ||
        readEnvFile(resolveEnvFilePath(cfg)).JEV_AI_MODEL ||
        "oc/jev-1.13-free");
    const t0 = Date.now();
    const res = (await request(
      "POST",
      "/v1/systemone",
      { model: resolvedModel, state, questions },
      cfg
    )) as SystemOneResult;
    if (!res || typeof res !== "object" || !res.answers) {
      throw new JevError("unexpected", "响应缺少 answers 字段");
    }
    res.ms = Math.max(0, Math.round(Date.now() - t0));
    return res;
  }

  // failover 链路：按配置原序走链；冷却中者记 cooldown 跳过（零请求、无 status/ms），
  // 不剔除不隐藏——胜者非首配 upstream 时（真实切换或冷却跳过）meta.attempts 必非空，audit 由此可辨。
  // 全在冷却时保底尝试首名（绝不空链，语义同 eligibleDetailed）；保底真发之首名于其尝试记录标
  // fallback:true（全链冷却时被迫真发者，audit 由此与正常调度相辨）。每级恰一次请求。
  const tr = tracker ?? defaultCooldownTracker;
  const elig = tr.eligibleDetailed(chain.upstreams.map((u) => u.name));
  const eligible = new Set(elig.names);
  const fellBack = elig.fellBack; // 全链冷却保底：唯首名入链，非正常调度
  const attempts: AttemptRecord[] = [];
  let lastErr: JevError = new JevError(
    "unexpected",
    "failover 链路为空（upstreams 校验异常）"
  );
  let attemptedAny = false;
  for (const up of chain.upstreams) {
    if (!eligible.has(up.name)) {
      attempts.push({ name: up.name, kind: "cooldown" }); // 冷却跳过：无请求发生，无 status、无 ms
      continue;
    }
    // 显式 model 参数仅覆盖首个实际尝试之 upstream；余者各用自身 model。
    const useModel = !attemptedAny && model !== undefined ? model : up.model;
    attemptedAny = true;
    const t0 = Date.now();
    try {
      const res = (await request(
        "POST",
        "/v1/systemone",
        { model: useModel, state, questions },
        {
          baseUrl: up.baseUrl,
          apiKey: up.apiKey,
          proxy: up.proxy, // 缺省 → resolveConfig 走既有 JEV_AI_PROXY 链
          timeoutMs: chain.timeoutMs,
        }
      )) as SystemOneResult;
      if (!res || typeof res !== "object" || !res.answers) {
        throw new JevError("unexpected", "响应缺少 answers 字段");
      }
      tr.markSuccess(up.name);
      res.ms = Math.max(0, Math.round(Date.now() - t0));
      setAskMeta(res, {
        upstream: up.name,
        attempts: [...attempts],
        ...(fellBack ? { fallback: true } : {}), // 保底成功亦可见：仅全链冷却被迫真发首名时附键，否则键缺席
      });
      return res;
    } catch (err) {
      const je = err instanceof JevError ? err : new JevError("unexpected", String(err));
      const rec: AttemptRecord = { name: up.name, kind: je.kind, ms: Date.now() - t0 };
      if (fellBack) rec.fallback = true; // 保底真发之首名（全链冷却时被迫），标记以别于正常调度
      if (je.status !== undefined) rec.status = je.status;
      if (je.retryAfterMs !== undefined) rec.retryAfterMs = je.retryAfterMs;
      attempts.push(rec);
      const cls = classifyFailure({ httpStatus: je.status, kind: je.kind });
      tr.markFailure(up.name, cls.cooldownable);
      lastErr = je;
      if (!cls.switchable) throw withAttempts(je, attempts); // 不可切换：立即抛，下一级零请求
      // 可切换：继续下一级（绝不睡眠、绝不重发同端）
    }
  }
  throw withAttempts(lastErr, attempts); // 全链败尽
}

/** 已连接模型列表。 */
export async function listModels(cfg: JevConfig = {}): Promise<unknown> {
  return request("GET", "/v1/models", undefined, cfg);
}
