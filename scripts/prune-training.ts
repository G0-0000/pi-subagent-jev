// 训练档甄别器：剔去 ~/.pi/agent/jev-comp/training.jsonl 中以旧版 criteria 或临时 key
// 求值之测试行，唯留依现行生效规则（loadRuleSets 合并后）逐字相符之良性样本。
// 跑法：node scripts/prune-training.ts [--file <path>] [--write]
//   缺省 dry-run，只打印统计、绝不写档；--write 先备份（同目录 .bak-<YYYYMMDD-HHmmss>）再落档。
// 并发风险：训练档可能被活跃 pi 会话并发追加，宜在无活跃会话时运行；本脚本读完至重写之间被
//   追加之行不会被本次重写保留（备份档反含之），且规则档缺/坏时 --write 一律拒绝（见下）。
// 判据（键序无关）：
//   source !== "ask" -> KEEP（一律）
//   source === "ask" 且 questions 为非空对象（或 {id,...} 数组），其每个 [k,v] 满足：
//     k 为现行规则 id；v.instructions 与现行逐字相等；v.criteria 与现行键序无关相等；
//     v 除 type/instructions/criteria 外无其它键        -> KEEP；否则 DROP
// 不可解析之行、非对象之行一律保守保留（宁保守不误删），并单独计数报出。
// 零 npm 依赖；只读运行时数据（不写配置档，不含任何 key 处理）。
import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import { loadRuleSets } from "../jev/compliance.ts";
import { trainingPath } from "../jev/traininglog.ts";

/** 现行规则之甄别依据：指令原文 ＋（若有）答支判据。 */
type RuleEntry = { instructions: string; criteria?: { true?: string; false?: string } };

/** 键序无关的规范化序列化：递归按键名排序后比字符串。 */
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canon(o[k]))
      .join(",") +
    "}"
  );
}

/** 取一行 ask 之 questions 为 { key -> value }（兼容对象与 {id,...} 数组两种形状）。 */
function questionsEntries(questions: unknown): Record<string, unknown> | null {
  if (!questions || typeof questions !== "object") return null;
  if (Array.isArray(questions)) {
    const out: Record<string, unknown> = {};
    for (const e of questions) {
      if (!e || typeof e !== "object" || typeof (e as { id?: unknown }).id !== "string") return null;
      out[(e as { id: string }).id] = e;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  const keys = Object.keys(questions as Record<string, unknown>);
  return keys.length > 0 ? (questions as Record<string, unknown>) : null;
}

/** 单问是否与现行规则吻合（key 为现行 id ＋ instructions 逐字相等 ＋ criteria 键序无关相等 ＋ 无额外键）。 */
function questionMatches(v: unknown, entry: RuleEntry | undefined): boolean {
  if (!entry) return false; // key 非现行规则 id
  if (!v || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  if (q.instructions !== entry.instructions) return false;
  if (canon(q.criteria) !== canon(entry.criteria)) return false;
  for (const k of Object.keys(q)) {
    if (k !== "type" && k !== "instructions" && k !== "criteria") return false;
  }
  return true;
}

/** 截断显示（默认 80 字符）。 */
function cls(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 值的可读显示：字符串直给，缺失/非串另标。 */
function show(v: unknown): string {
  if (v === undefined) return "(缺失)";
  if (typeof v === "string") return cls(v);
  return cls(JSON.stringify(v) ?? String(v));
}

/** 备份档时间戳：YYYYMMDD-HHmmss。 */
function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

// ---- 参数 ----
const argv = process.argv.slice(2);
const write = argv.includes("--write");
let filePath = trainingPath();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--file" || a === "-f") {
    const v = argv[++i];
    if (!v) {
      console.error("错误：--file 须跟一个路径");
      process.exit(2);
    }
    filePath = v;
  } else if (a !== "--write") {
    console.error(`错误：未知参数 ${a}（可用：--file <path>、--write）`);
    process.exit(2);
  }
}
const rulesPath = pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "compliance-rules.json");

// ---- 现行规则：走 loadRuleSets（配置档为唯一来源，v0.7.0 起无内建缺省），不另写 JSON 解析 ----
let rulesParsed = true;
try {
  JSON.parse(readFileSync(rulesPath, "utf8"));
} catch {
  rulesParsed = false; // 档缺/坏时 loadRuleSets 静默回空规则（RULE_SETS 恒空），此时 ask 行会被大量误剔，须显式告警
}
const loaded = loadRuleSets(rulesPath);
const ruleMap = new Map<string, RuleEntry>();
for (const [agent, rs] of Object.entries(loaded.agents)) {
  if (agent === "_global") continue; // 保留键不视作 agent 组（loadRuleSets 亦已跳过，此处双保险）
  for (const r of rs.rules) {
    const entry: RuleEntry = { instructions: r.instructions };
    if (r.criteria !== undefined) entry.criteria = r.criteria;
    ruleMap.set(r.id, entry); // 跨组同 id 复用者内容一致，后者覆盖无碍
  }
}

// ---- 读训练档 ----
let raw: string;
try {
  raw = readFileSync(filePath, "utf8");
} catch (e) {
  console.error(`错误：读训练档失败 ${filePath}：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// ---- 逐行甄别 ----
const keptLines: string[] = []; // KEEP 原文行，保原序
const droppedSamples: { ts: string; keySet: string; line: string }[] = [];
const keptAskRows: { ts: string; keys: string[] }[] = [];
const badLines: { no: number; reason: string }[] = [];
const dropGroups = new Map<string, number>();
const keepAskGroups = new Map<string, number>();
const unknownKeys = new Map<string, number>();
/** 被 DROP 行中「与现行配置不同之 criteria」：规则 id -> 字段 -> 前后文本样本。 */
const criteriaDiffs = new Map<string, Map<string, { oldText: string; newText: string; count: number }>>();

let total = 0;
let blankLines = 0;
let keptDispatch = 0;
let keptAsk = 0;
let droppedAsk = 0;

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const recordCriteriaDiff = (id: string, field: string, oldText: string, newText: string): void => {
  let byField = criteriaDiffs.get(id);
  if (!byField) {
    byField = new Map();
    criteriaDiffs.set(id, byField);
  }
  const prev = byField.get(field);
  if (prev) prev.count++;
  else byField.set(field, { oldText, newText, count: 1 });
};

const rawLines = raw.split("\n");
if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop(); // 结尾换行不视作一行

rawLines.forEach((line, idx) => {
  if (line.trim() === "") {
    blankLines++; // 空行无数据，跳过不落回（计入报告，不静默）
    return;
  }
  total++;
  const lineNo = idx + 1;

  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    badLines.push({ no: lineNo, reason: "JSON 不可解析" });
    keptDispatch++; // 保守保留
    keptLines.push(line);
    return;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    badLines.push({ no: lineNo, reason: "非对象行" });
    keptDispatch++;
    keptLines.push(line);
    return;
  }
  const r = row as Record<string, unknown>;
  if (r.source !== "ask") {
    keptDispatch++;
    keptLines.push(line);
    return;
  }

  const entries = questionsEntries(r.questions);
  let ok = entries !== null;
  if (entries) {
    for (const [k, v] of Object.entries(entries)) {
      if (!questionMatches(v, ruleMap.get(k))) {
        ok = false;
        break;
      }
    }
  }

  const ts = typeof r.ts === "string" ? r.ts : "(无 ts)";
  if (ok && entries) {
    keptAsk++;
    keptLines.push(line);
    const keys = Object.keys(entries).sort();
    bump(keepAskGroups, keys.join(","));
    keptAskRows.push({ ts, keys });
    return;
  }

  droppedAsk++;
  const keys = entries ? Object.keys(entries) : [];
  const keySet = keys.length > 0 ? [...keys].sort().join(",") : "(空/非法 questions)";
  bump(dropGroups, keySet);
  if (droppedSamples.length < 5) droppedSamples.push({ ts, keySet, line });

  // 差异归因：非现行 id（临时 key）、criteria 不同、instructions 不同、多余键
  if (entries) {
    for (const [k, v] of Object.entries(entries)) {
      const entry = ruleMap.get(k);
      if (!entry) {
        bump(unknownKeys, k);
        continue;
      }
      const q = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      const oldC = (q.criteria && typeof q.criteria === "object" ? q.criteria : {}) as Record<
        string,
        unknown
      >;
      const newC = (entry.criteria ?? {}) as { true?: string; false?: string };
      for (const field of ["true", "false"]) {
        if (canon(oldC[field]) !== canon(newC[field])) {
          recordCriteriaDiff(k, field, show(oldC[field]), show(newC[field]));
        }
      }
    }
  }
});

// ---- 报告 ----
const P = (s: string): void => {
  console.log(s);
};

function dumpGroups(title: string, map: Map<string, number>, cap = 20): void {
  P(`---- ${title} ----`);
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) P("  (无)");
  for (const [k, n] of rows.slice(0, cap)) P(`  ${String(n).padStart(4)}  ${k}`);
  if (rows.length > cap) P(`  ... 另有 ${rows.length - cap} 组未列`);
  P("");
}

P(`==== 甄别${write ? "＋落档" : " DRY-RUN（未写入）"} ====`);
P(`规则档：${rulesPath}`);
P(`训练档：${filePath}`);
if (!rulesParsed) P(`警告：规则档缺或不可解析，loadRuleSets 已回空规则（内建已废）——ask 行可能被大量误剔，请先修档再落档`);
P(`现行规则 id（${ruleMap.size}）：${[...ruleMap.keys()].join(", ")}`);
P("");
P("---- 总量 ----");
P(`总行数        : ${total}`);
P(`空行（跳过）  : ${blankLines}`);
P(`不可解析/非对象行: ${badLines.length}`);
P(`keptDispatch  : ${keptDispatch}`);
P(`keptAsk       : ${keptAsk}`);
P(`droppedAsk    : ${droppedAsk}`);
P(`KEEP 合计     : ${keptLines.length}`);
P("");

dumpGroups(`KEEP(ask) 按 key 集合分组（共 ${keepAskGroups.size} 组）`, keepAskGroups);
dumpGroups(`DROP(ask) 按 key 集合分组（共 ${dropGroups.size} 组）`, dropGroups);
dumpGroups(`DROP(ask) 中之非现行规则 id（临时 key，共 ${unknownKeys.size} 个）`, unknownKeys);

P(`---- DROP 行中 criteria 与现行配置不同者（共 ${criteriaDiffs.size} 个规则 id） ----`);
if (criteriaDiffs.size === 0) P("  (无)");
for (const [id, byField] of [...criteriaDiffs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const n = Math.max(...[...byField.values()].map((d) => d.count));
  P(`  ${id}  ${n} 行`);
  for (const [field, d] of byField) {
    P(`      ${field}  旧: ${d.oldText}`);
    P(`      ${" ".repeat(field.length)}  新: ${d.newText}`);
  }
}
P("");

P("---- KEEP(ask) 逐条（ts 与 key 集合） ----");
if (keptAskRows.length === 0) P("  (无)");
for (const k of keptAskRows) P(`  ${k.ts}  [${k.keys.join(" ")}]`);
P("");

P("---- DROP 样例行（最多 5 条，各截断 200 字符） ----");
if (droppedSamples.length === 0) P("  (无)");
for (const d of droppedSamples) {
  P(`  ts=${d.ts} keySet=${d.keySet}`);
  P(`    ${d.line.slice(0, 200)}`);
}
P("");

P("---- 不可解析/非对象行（行号，最多 20 条） ----");
if (badLines.length === 0) P("  (无)");
for (const b of badLines.slice(0, 20)) P(`  第 ${b.no} 行：${b.reason}（保守保留）`);
if (badLines.length > 20) P(`  ... 另有 ${badLines.length - 20} 行未列`);
P("");

// ---- 落档 ----
if (write) {
  // 硬闸：规则档缺/坏时 loadRuleSets 静默回空规则（RULE_SETS 恒空、v0.7.0 起无内建缺省），此时落档
  // 会把由配置档供给之 worker/scout/librarian 等 ask 行几乎全灭，故拒绝落档（dry-run 不受影响）。
  if (!rulesParsed) {
    console.error(
      "错误：规则档缺或不可解析，已拒绝落档。\n" +
        `  规则档：${rulesPath}\n` +
        "  loadRuleSets 已回空规则（内建已废、无内建缺省），此时落档会把 worker/scout/" +
        "librarian 等由配置档供给之 ask 行大量误剔。\n" +
        "  请先修复规则档再重跑；仅查看统计请用 dry-run（不加 --write）。"
    );
    process.exit(1);
  }
  const bak = `${filePath}.bak-${stamp()}`;
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    copyFileSync(filePath, bak);
    const out = keptLines.map((l) => l + "\n").join("");
    writeFileSync(tmp, out, "utf8"); // 先写同目录临时档，再 rename 覆盖，避免截断式写档中途损原档
    renameSync(tmp, filePath);
    P("---- 已落档 ----");
    P(`备份：${bak}`);
    P(
      `写入 ${filePath}：${keptLines.length} 行、${Buffer.byteLength(out, "utf8")} 字节` +
        `（KEEP 行原文逐字节照抄、保原序、末尾换行）`
    );
  } catch (e) {
    try {
      unlinkSync(tmp); // 失败路径尽力清理临时档，勿留残档
    } catch {
      /* 临时档不存在或不可删，忽略 */
    }
    console.error(`错误：落档失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else {
  P("（dry-run：未写入任何档）");
}
