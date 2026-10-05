// 训练数据记录：为本地决策模型微调留痕，记 state ＋ questions ＋ teacher 概率/答案。
// 开关为 compliance-rules.json 之 _global.trainingLog（缺省 false，判定见 compliance.ts）。
// 本模块只做纯行构造 ＋ 最佳努力追加：任何写入失败静默吞下，绝不外抛（fail-open，红线三），
// 绝不阻断派单或求值。记录内容不含任何 API key（红线一）。
import { appendFileSync } from "node:fs";
import os from "node:os";
import pathMod from "node:path";

/** 训练记录里的一问：id ＋ 问题原文 ＋ 可选答支判据（与请求载荷同形）。 */
export type TrainingQuestion = {
  id: string;
  instructions: string;
  criteria?: { true?: string; false?: string };
};

/** 派单合规路径之训练行（source="dispatch"）。state 为 buildState 全量原文，不截断。 */
export type DispatchTrainingLine = {
  ts: string;
  source: "dispatch";
  agent: string;
  state: string;
  questions: TrainingQuestion[];
  probs: Record<string, number>;
  verdict: "pass" | "violation";
  blocked?: string[];
};

/** 运行监控路径之训练行（source="monitor"）：state 为 buildMonitorState 全量，signal 为触发之检测器信号。 */
export type MonitorTrainingLine = {
  ts: string;
  source: "monitor";
  agent: string;
  signal: string;
  state: string;
  questions: TrainingQuestion[];
  probs: Record<string, number>;
  verdict: "alert" | "ok" | "unknown";
};

/** jev_ask 工具路径之训练行（source="ask"）。questions/answers 逐字留存请求与返回。 */
export type AskTrainingLine = {
  ts: string;
  source: "ask";
  model: string | null;
  state: unknown;
  questions: Record<string, unknown>;
  answers: Record<string, unknown>;
};

export type TrainingLine = DispatchTrainingLine | AskTrainingLine | MonitorTrainingLine;

/** 训练档默认路径（运行时数据，与 audit.jsonl 同族，绝不入库）。 */
export function trainingPath(): string {
  return pathMod.join(os.homedir(), ".pi", "agent", "jev-comp", "training.jsonl");
}

/** 派单合规训练行构造（不含换行符）。blocked 为空/缺席时不落该键。 */
export function dispatchTrainingLine(fields: {
  ts?: string;
  agent: string;
  state: string;
  questions: TrainingQuestion[];
  probs: Record<string, number>;
  verdict: "pass" | "violation";
  blocked?: string[];
}): DispatchTrainingLine {
  const line: DispatchTrainingLine = {
    ts: fields.ts ?? new Date().toISOString(),
    source: "dispatch",
    agent: fields.agent,
    state: fields.state,
    questions: fields.questions,
    probs: fields.probs,
    verdict: fields.verdict,
  };
  if (fields.blocked && fields.blocked.length > 0) line.blocked = fields.blocked;
  return line;
}

/** 运行监控训练行构造（不含换行符）。 */
export function monitorTrainingLine(fields: {
  ts?: string;
  agent: string;
  signal: string;
  state: string;
  questions: TrainingQuestion[];
  probs: Record<string, number>;
  verdict: "alert" | "ok" | "unknown";
}): MonitorTrainingLine {
  return {
    ts: fields.ts ?? new Date().toISOString(),
    source: "monitor",
    agent: fields.agent,
    signal: fields.signal,
    state: fields.state,
    questions: fields.questions,
    probs: fields.probs,
    verdict: fields.verdict,
  };
}

/** jev_ask 训练行构造（不含换行符）。model 缺省记 null。 */
export function askTrainingLine(fields: {
  ts?: string;
  model?: string | null;
  state: unknown;
  questions: Record<string, unknown>;
  answers: Record<string, unknown>;
}): AskTrainingLine {
  return {
    ts: fields.ts ?? new Date().toISOString(),
    source: "ask",
    model: fields.model ?? null,
    state: fields.state,
    questions: fields.questions,
    answers: fields.answers,
  };
}

/** 训练行写入器签名（可注入，便于测试 mock）。 */
export type TrainingWriter = (line: TrainingLine) => void;

/** 最佳努力追加一行（append）。任何失败静默吞下，绝不外抛（fail-open，红线三）。 */
export function writeTrainingLine(line: TrainingLine, filePath: string = trainingPath()): void {
  try {
    appendFileSync(filePath, JSON.stringify(line) + "\n");
  } catch {
    /* 记录失败绝不阻断派单/求值 */
  }
}
