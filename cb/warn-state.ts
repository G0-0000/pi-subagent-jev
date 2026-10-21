// warn 观察模式之违规提示暂存（文件版，CodeBuddy 钩子跨进程必用）。
// 钩子乃独立进程：PreToolUse 落、PostToolUse 取，故暂存须落盘而非内存。
// 一格一键：键（tool_use_id，缺则 call_id）经 sha256 命名，档内另存原键以校验。
// 有界：TTL 3600s（过期为死）、容量 100（写入前先删最旧，FIFO 逐出）。
// take 为破坏性读取：取走即删，同一键至多交付一次；坏档静默弃（fail-open）。
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** 暂存生存期（毫秒）：逾期视为死条目。 */
export const WARN_TTL_MS = 3_600_000;

/** 容量上限：目录内至多此数条目。 */
export const WARN_CAPACITY = 100;

/** 单条暂存：key 为派单标识，text 为警告文案，ts 为写入时刻（毫秒）。 */
export type WarnEntry = { key: string; text: string; ts: number };

/** 暂存目录：<configDir>/warn。 */
export function warnDir(configDir: string): string {
  return path.join(configDir, "warn");
}

/** 键 → 档名：sha256 截 32 位十六进制，免键内特殊字符之扰。 */
function fileFor(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `w-${hash}.json`;
}

/** 过期判定：ts 非有限数视为过期；age >= ttl 即过期。 */
export function isExpired(ts: number, now: number, ttlMs: number = WARN_TTL_MS): boolean {
  if (!Number.isFinite(ts)) return true;
  return now - ts >= ttlMs;
}

/** 解析单条暂存：形状不符或坏 JSON 返 null。 */
export function parseWarnEntry(raw: string): WarnEntry | null {
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const { key, text, ts } = o as Record<string, unknown>;
    if (typeof key !== "string" || typeof text !== "string") return null;
    if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
    return { key, text, ts };
  } catch {
    return null;
  }
}

/** 现存条目（档名＋写入时刻；坏档 ts 记 NaN，随过期清出）。 */
export type StoredEntry = { file: string; ts: number };

/**
 * 纯函数：算写入前应删之档。
 * 先删一切过期者，再按 ts 升序删最旧，使「存活数 + 本次新增 1」不超过容量。
 * 同一键覆写亦按新增计（多删一条无妨，宁紧勿胀）。
 */
export function prunePlan(
  entries: StoredEntry[],
  now: number,
  ttlMs: number = WARN_TTL_MS,
  capacity: number = WARN_CAPACITY
): string[] {
  const expired = entries.filter((e) => isExpired(e.ts, now, ttlMs)).map((e) => e.file);
  const alive = entries
    .filter((e) => !isExpired(e.ts, now, ttlMs))
    .sort((a, b) => a.ts - b.ts);
  const keepMax = Math.max(0, capacity - 1);
  const overflow = Math.max(0, alive.length - keepMax);
  return [...expired, ...alive.slice(0, overflow).map((e) => e.file)];
}

function listEntries(dir: string): StoredEntry[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith("w-") && f.endsWith(".json"))
      .map((file) => {
        let ts = Number.NaN;
        try {
          ts = parseWarnEntry(readFileSync(path.join(dir, file), "utf8"))?.ts ?? Number.NaN;
        } catch {
          /* 坏档：ts 记 NaN，随后清出 */
        }
        return { file, ts };
      });
  } catch {
    return [];
  }
}

export type WarnStoreOptions = { now?: number; ttlMs?: number; capacity?: number };

/** 落一条暂存：先建目录、按需清过期与逐出，再写本键档（0600）。失败由调用方 fail-open。 */
export function writeWarning(
  configDir: string,
  key: string,
  text: string,
  opts: WarnStoreOptions = {}
): void {
  const now = opts.now ?? Date.now();
  const dir = warnDir(configDir);
  mkdirSync(dir, { recursive: true });
  // 并发写入可暂超容量 100（各进程只扫得己见之条目），由 TTL 清扫兜底收敛
  for (const file of prunePlan(
    listEntries(dir),
    now,
    opts.ttlMs ?? WARN_TTL_MS,
    opts.capacity ?? WARN_CAPACITY
  )) {
    try {
      unlinkSync(path.join(dir, file));
    } catch {
      /* 逐出失败无碍本条写入 */
    }
  }
  const entry: WarnEntry = { key, text, ts: now };
  writeFileSync(path.join(dir, fileFor(key)), JSON.stringify(entry), { mode: 0o600 });
}

/** 破坏性读取：取走即删；无档、坏档、键不符、过期皆回 undefined。 */
export function takeWarning(
  configDir: string,
  key: string,
  opts: WarnStoreOptions = {}
): string | undefined {
  const file = path.join(warnDir(configDir), fileFor(key));
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    unlinkSync(file);
  } catch {
    // unlink 成功者方得交付：并发下已被他者先删走（ENOENT）或任何删错误，皆回 undefined，绝不重复交付
    return undefined;
  }
  const entry = parseWarnEntry(raw);
  if (!entry || entry.key !== key) return undefined;
  if (isExpired(entry.ts, opts.now ?? Date.now(), opts.ttlMs ?? WARN_TTL_MS)) return undefined;
  return entry.text;
}
