// 多上游 failover 纯逻辑层（零 IO、零 curl，可测）：
//  - loadFailoverConfig：读 upstreams.json（缺档/坏档/空链一律返 null，fail-open 回旧单端点链路）
//  - classifyFailure：把 JevError 之 kind/status 分类为是否切换（switchable）与是否冷却（cooldownable）
//  - CooldownTracker：连接级败北后进程内冷却跳过（内存 Map，重启即忘；注入时钟可测）
// 红线二：同一 upstream 之同一 POST 绝不重发、不退避——本层不睡眠、不重试，唯按序切换。
import { readFileSync } from "node:fs";
import os from "node:os";
import pathMod from "node:path";

/** 单个上游端点：四要素齐备方为合法；proxy 可选（缺省走既有 JEV_AI_PROXY 链）。 */
export type Upstream = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  proxy?: string;
};

/** failover 配置（upstreams.json 解析校验后之形状）。 */
export type FailoverConfig = {
  timeoutMs: number;
  cooldownMs: number;
  upstreams: Upstream[];
};

/** 一次上游尝试之记录（进 audit 行 failover 数组与 JevError.failoverAttempts）。 */
export type AttemptRecord = {
  name: string;
  status?: number;
  kind?: string;
  /** 真实尝试为耗时毫秒；冷却跳过记录（kind:"cooldown"，无请求发生）无 ms 亦无 status */
  ms?: number;
  /** 429 Retry-After 解析值：仅记录上报，绝不等待 */
  retryAfterMs?: number;
};

/** 生效档路径（运行时数据，不入库；代码只读绝不写）。 */
export const DEFAULT_UPSTREAMS_PATH = pathMod.join(
  os.homedir(),
  ".pi",
  "agent",
  "jev-comp",
  "upstreams.json"
);

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 30_000;

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * 读 failover 配置档并校验。任何读取/解析/校验错误、或 upstreams 为空 → 返 null（缺席，fail-open）。
 * 校验：timeoutMs/cooldownMs 缺省 5000/30000，出现则须正整数；upstreams 须非空数组，
 * 每项 name 非空且唯一、baseUrl/apiKey/model 非空（baseUrl 剥末尾斜杠）、proxy 可选字符串。
 */
export function loadFailoverConfig(pathOverride?: string): FailoverConfig | null {
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(pathOverride ?? DEFAULT_UPSTREAMS_PATH, "utf8"));
    } catch {
      return null; // 档不存在或非合法 JSON → 缺席
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const timeoutMs = o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : o.timeoutMs;
    if (!isPositiveInt(timeoutMs)) return null;
    const cooldownMs = o.cooldownMs === undefined ? DEFAULT_COOLDOWN_MS : o.cooldownMs;
    if (!isPositiveInt(cooldownMs)) return null;
    if (!Array.isArray(o.upstreams) || o.upstreams.length === 0) return null;
    const seen = new Set<string>();
    const upstreams: Upstream[] = [];
    for (const item of o.upstreams) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const u = item as Record<string, unknown>;
      if (typeof u.name !== "string" || u.name.trim() === "") return null;
      if (seen.has(u.name)) return null; // name 唯一
      seen.add(u.name);
      if (typeof u.baseUrl !== "string" || u.baseUrl.trim() === "") return null;
      if (typeof u.apiKey !== "string" || u.apiKey === "") return null;
      if (typeof u.model !== "string" || u.model.trim() === "") return null;
      let proxy: string | undefined;
      if (u.proxy !== undefined) {
        if (typeof u.proxy !== "string") return null;
        proxy = u.proxy === "" ? undefined : u.proxy;
      }
      upstreams.push({
        name: u.name,
        baseUrl: u.baseUrl.replace(/\/+$/, ""),
        apiKey: u.apiKey,
        model: u.model,
        ...(proxy !== undefined ? { proxy } : {}),
      });
    }
    return { timeoutMs, cooldownMs, upstreams };
  } catch {
    return null; // 任何意外皆缺席（fail-open）
  }
}

export type FailureClass = { switchable: boolean; cooldownable: boolean };

/**
 * 失败分类（判定唯一权威，client 层据此决定切换/冷却/抛出）：
 *  - switchable=true（按序切下一级）：network、timeout、HTTP 5xx、429、401、403、404、
 *    200 不可用响应体（坏 JSON／缺 answers／NaN 状态码——即 body/status 失败之 unexpected）
 *  - switchable=false（立即抛，下一级零请求）：402、其余 4xx 含 422、3xx、not_configured
 *  - cooldownable=true（唯连接级败北）：network/timeout/5xx；429 与其余 4xx 绝不冷却
 */
export function classifyFailure(f: { httpStatus?: number; kind: string }): FailureClass {
  switch (f.kind) {
    case "network":
    case "timeout":
    case "upstream": // 502/504
      return { switchable: true, cooldownable: true };
    case "rate_limited": // 429
    case "unauthorized": // 401
      return { switchable: true, cooldownable: false };
    case "unexpected": {
      const s = f.httpStatus;
      if (s !== undefined && s >= 500) return { switchable: true, cooldownable: true }; // 500/503 等
      if (s !== undefined && s >= 300 && s < 400) return { switchable: false, cooldownable: false }; // 3xx
      if (s !== undefined && (s === 403 || s === 404))
        return { switchable: true, cooldownable: false }; // 403/404
      if (s !== undefined && s >= 400) return { switchable: false, cooldownable: false }; // 其余 4xx（400/405/408/409/410 等）立即抛，下一级零请求
      return { switchable: true, cooldownable: false }; // 200 坏体／缺 answers／NaN 状态码
    }
    default: // not_configured / payment_required(402) / invalid_request(422) 等
      return { switchable: false, cooldownable: false };
  }
}

/**
 * 进程内冷却跳过表：markFailure 仅对 cooldownable 败北记 untilMs；
 * eligible 按原序过滤冷却中者，全在冷却时保底返回首个（绝不返回空链）。
 * 纯内存 Map，重启即忘；时钟注入可测。
 */
export class CooldownTracker {
  private until = new Map<string, number>();
  private now: () => number;
  private cooldownMs: number;

  constructor(now: () => number = Date.now, cooldownMs: number = DEFAULT_COOLDOWN_MS) {
    this.now = now;
    this.cooldownMs = cooldownMs;
  }

  markFailure(name: string, cooldownable: boolean, nowMs?: number): void {
    if (!cooldownable) return; // 429 与 4xx 绝不冷却
    const t = nowMs ?? this.now();
    this.until.set(name, t + this.cooldownMs);
  }

  markSuccess(name: string): void {
    this.until.delete(name);
  }

  eligible(names: string[], nowMs?: number): string[] {
    const t = nowMs ?? this.now();
    const out = names.filter((n) => (this.until.get(n) ?? 0) <= t);
    if (out.length === 0 && names.length > 0) return [names[0]]; // 全在冷却：保底首名
    return out;
  }
}

/** 进程内共享默认 tracker（与规则配置同生命周期：/reload 重导入模块即重置）。 */
export const defaultCooldownTracker = new CooldownTracker();
