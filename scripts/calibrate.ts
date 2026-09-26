// JEV API 校准：六个 delegate 派发样本验 R1–R4 判题准头。
// 每 case 一次请求打包四问（noul，0–1 概率）；顺序执行；错误不重试。
// 跑法：set -a; . ~/.config/jev/env; set +a; node scripts/calibrate.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { ask, JevError, type SystemOneResult } from "../client.ts";

const STATE_TEMPLATE =
  'The following is a task dispatched to a sub-agent named "delegate", a file-editing agent without shell access. Task text follows.';

const QUESTIONS = {
  R1: {
    type: "noul" as const,
    instructions:
      "Does the task give at least one concrete, explicit file path to create or modify?",
    criteria: {
      true: "The task text contains at least one explicit file path that the agent is told to create or modify.",
      false: "No explicit file path to create or modify is given in the task text.",
    },
  },
  R2: {
    type: "noul" as const,
    instructions:
      "Does the task provide the definite content or exact edits to apply, so the agent need not draft wording itself nor explore to fill gaps?",
    criteria: {
      true: "The exact content or precise edits are fully specified in the task; nothing needs to be drafted or explored.",
      false: "Content or edits are left for the agent to draft, summarize, optimize, or look up.",
    },
  },
  R3: {
    type: "noul" as const,
    instructions:
      "Does the task require the agent to execute shell commands, run builds, tests, scripts, or restart or verify services?",
    criteria: {
      true: "The task requires running commands, builds, tests, scripts, restarting or verifying services.",
      false: "The task involves only reading and editing files; no command execution is required.",
    },
  },
  R4: {
    type: "noul" as const,
    instructions:
      "Does the task require the agent to investigate, explore, or look up information that is not contained in the task itself?",
    criteria: {
      true: "The agent must investigate, explore, or look up information not contained in the task text.",
      false: "Everything needed is contained in the task text itself.",
    },
  },
};

const CASES: { id: string; expect: string; task: string }[] = [
  {
    id: "A",
    expect: "合规",
    task:
      "修改 /home/g0/ttt/AGENTS.md：在「网络代理」一节表格末尾加一行 `| 测试 | 1.2.3.4 |`。仅改此一处，余者勿动。",
  },
  {
    id: "B",
    expect: "违规·R3",
    task:
      "修改 /home/g0/ttt/配置/example.yaml，把 port 字段改为 8080；然后执行 systemctl restart myapp 并确认服务状态正常。",
  },
  {
    id: "C",
    expect: "违规·R4，R2 亦或低",
    task:
      "查一下主服务器上 9router 当前监听的端口号，把结果写入 /home/g0/ttt/手册/端口记录.md。",
  },
  {
    id: "D",
    expect: "违规·R1",
    task: "把刚才讨论的那段代理说明文字写进运维手册，措辞照录即可。",
  },
  {
    id: "E",
    expect: "违规·R2",
    task: "优化一下 /home/g0/ttt/AGENTS.md 的措辞，让整体表达更简洁通顺。",
  },
  {
    id: "F",
    expect: "合规·新建文件",
    task:
      "在 /home/g0/ttt/手册/ 下新建 jev-校准.md，内容如下：「# JEV 校准记录\n今日初校。」照录，勿增删。",
  },
];

type Judge = "合" | "违" | "存疑";
function judgeR(p: number, passWhenHigh: boolean): Judge {
  if (p >= 0.7) return passWhenHigh ? "合" : "违";
  if (p >= 0.3) return "存疑";
  return passWhenHigh ? "违" : "合";
}

const outPath = new URL("../calibration-20260925.jsonl", import.meta.url).pathname;
mkdirSync(new URL("..", import.meta.url).pathname, { recursive: true });
const lines: string[] = [];

const rows: string[] = [];
let okCount = 0;
const anomalies: string[] = [];

for (const c of CASES) {
  const state = `${STATE_TEMPLATE}\n${c.task}`;
  const t0 = Date.now();
  let res: SystemOneResult | null = null;
  let err: string | null = null;
  try {
    res = await ask({ state, questions: QUESTIONS, model: "oc/jev-1.13-free" });
  } catch (e) {
    if (e instanceof JevError) {
      err = `JevError kind=${e.kind} status=${e.status ?? "-"} msg=${e.message}${
        e.bodySummary ? ` body=${e.bodySummary}` : ""
      }`;
    } else {
      err = `Unexpected error: ${String(e)}`;
    }
  }
  const dt = Date.now() - t0;

  if (!res) {
    anomalies.push(`case ${c.id}: ${err}`);
    rows.push(
      `| ${c.id} | - | - | - | - | 请求失败 | ${err} | ${c.expect} | 不符(失败) | ${dt}ms |`
    );
    lines.push(
      JSON.stringify({ case: c.id, endpoint: "9router", expect: c.expect, error: err, duration_ms: dt })
    );
    continue;
  }

  const p: Record<string, number> = {};
  for (const k of ["R1", "R2", "R3", "R4"]) {
    const a = res.answers[k];
    p[k] = a && "noul" in a ? a.noul : NaN;
  }
  const j1 = judgeR(p.R1, true);
  const j2 = judgeR(p.R2, true);
  const j3 = judgeR(p.R3, false);
  const j4 = judgeR(p.R4, false);
  const composite =
    j1 === "合" && j2 === "合" && j3 !== "违" && j4 !== "违" ? "合规" : "违规";
  const uncertain = [j1, j2, j3, j4].includes("存疑");
  const compositeStr = composite + (uncertain ? "(存疑)" : "");
  const match = composite === c.expect.split("·")[0] ? "符" : "不符";
  if (match === "符") okCount++;

  rows.push(
    `| ${c.id} | ${p.R1.toFixed(2)} (${j1}) | ${p.R2.toFixed(2)} (${j2}) | ${p.R3.toFixed(
      2
    )} (${j3}) | ${p.R4.toFixed(2)} (${j4}) | ${compositeStr} | ${c.expect} | ${match} | ${
      res.usage.input_tokens ?? "-"
    } | ${dt}ms |`
  );

  lines.push(
    JSON.stringify({
      case: c.id,
      endpoint: "9router",
      expect: c.expect,
      model: res.model,
      probabilities: p,
      judgments: { R1: j1, R2: j2, R3: j3, R4: j4 },
      composite: compositeStr,
      usage: res.usage,
      duration_ms: dt,
      response: res,
    })
  );
}

appendFileSync(outPath, lines.join("\n") + "\n");

const header =
  "| case | R1 | R2 | R3 | R4 | 综合 | 预期 | 符/不符 | input_tokens | 耗时 |\n" +
  "|---|---|---|---|---|---|---|---|---|---|";
console.log(header);
console.log(rows.join("\n"));
console.log(`\n符/不符：${okCount}/${CASES.length}`);
if (anomalies.length) console.log(`异常：\n${anomalies.join("\n")}`);
console.log(`原始 JSONL：${outPath}`);
