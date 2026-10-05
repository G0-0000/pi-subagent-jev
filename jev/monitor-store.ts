// 运行监控之运行态暂存（纯内存，零 IO）：runId → MonitorState
// （bash 计时、最近工具调用环形缓冲、最近检查时戳、事件线去重键）。
// 有界容量（100 条，满则逐出最旧，FIFO）——与 warning-store.ts 同款，防运行态无限累积。
// 仅观察用：一切读取异常由调用方按 fail-open 处理，本类不抛。
import type { ToolCallRec } from "./monitor.ts";

/** 一条运行中之 bash 调用计时：checkedAt 为已通过一次检查之时戳（undefined=未检查）。 */
export type BashTimer = { toolCallId: string; startedAt: number; checkedAt?: number };

/** 单 run 之监控运行态。 */
export type MonitorState = {
  agent: string;
  task: string;
  /** run 首次入表之时戳（sweep 之锚：从未检查则自 startedAt 起算） */
  startedAt: number;
  /** 最近一次任何活动（控制事件/工具调用）之时戳 */
  lastActivityAt: number;
  /** 最近一次任何检查（求值尝试）之时戳；无 → sweep 以 startedAt 为锚 */
  lastCheckAt?: number;
  /** 运行中之 bash 调用（寥寥数条；非 bash 活动即清空） */
  bashCalls: BashTimer[];
  /** 最近工具调用环形缓冲（FIFO 有界，跨次求值累积） */
  recentCalls: ToolCallRec[];
  /** 事件线去重键（信号+窗口），{key, ts}，FIFO 有界 */
  dedupeKeys: { key: string; ts: number }[];
};

/** 环形缓冲容量：跨次求值累积之最近调用上限（超出逐出最旧）。 */
const RECENT_CALLS_CAPACITY = 32;
/** 去重键容量：同 run 事件线去重键之上限（超出逐出最旧）。 */
const DEDUPE_CAPACITY = 50;

export class MonitorStore {
  private map = new Map<string, MonitorState>();
  private readonly capacity: number;

  constructor(capacity = 100) {
    this.capacity = capacity;
  }

  private evictIfFull(): void {
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** 取或建（首建记 agent/task/startedAt/lastActivityAt；已存者不动其 agent/task）。 */
  state(runId: string, agent: string, task: string, now: number): MonitorState {
    const existing = this.map.get(runId);
    if (existing) return existing;
    this.evictIfFull();
    const st: MonitorState = {
      agent,
      task,
      startedAt: now,
      lastActivityAt: now,
      bashCalls: [],
      recentCalls: [],
      dedupeKeys: [],
    };
    this.map.set(runId, st);
    return st;
  }

  /**
   * 控制事件活动线：更新 lastActivityAt 与 agent/task（后者以首个非空值入表）；
   * 工具边界语义——currentTool 非 bash → 运行中 bash 计时全清（已结束）；
   * currentTool 为 bash 且 toolCallId 异于在跑者 → 旧者结束、新起计时。
   */
  noteActivity(
    runId: string,
    agent: string,
    task: string,
    currentTool: string | undefined,
    toolCallId: string | undefined,
    now: number
  ): MonitorState {
    const st = this.state(runId, agent, task, now);
    if (st.agent === "unknown" && agent !== "unknown") st.agent = agent;
    if (st.task === "" && task !== "") st.task = task;
    st.lastActivityAt = Math.max(st.lastActivityAt, now);
    if (currentTool !== "bash") {
      st.bashCalls = [];
      return st;
    }
    const id = toolCallId ?? `bash:${now}`;
    if (!st.bashCalls.some((b) => b.toolCallId === id)) {
      st.bashCalls = st.bashCalls.filter((b) => b.toolCallId === id);
      st.bashCalls.push({ toolCallId: id, startedAt: now });
    }
    return st;
  }

  /** 记 bash 计时起点（控制事件携 currentToolDurationMs 时以之回推 startedAt）。 */
  noteBashStart(runId: string, toolCallId: string, startedAt: number): void {
    const st = this.map.get(runId);
    if (!st) return;
    const b = st.bashCalls.find((x) => x.toolCallId === toolCallId);
    if (b) b.startedAt = Math.min(b.startedAt, startedAt);
    else st.bashCalls.push({ toolCallId, startedAt });
  }

  /** 记一次 bash 检查已通过（checkedAt=now，供 bash_recheck 之距算）。 */
  markBashChecked(runId: string, toolCallId: string | undefined, now: number): void {
    const st = this.map.get(runId);
    if (!st) return;
    for (const b of st.bashCalls) {
      if (toolCallId === undefined || b.toolCallId === toolCallId) b.checkedAt = now;
    }
  }

  /** 追加一条工具调用记录（自动建表；与最新一条同 tool/preview/isError 者跳过——transcript 尾跨次求值重叠）；满则逐出最旧。 */
  addCall(runId: string, rec: ToolCallRec): void {
    const st = this.state(runId, "unknown", "", rec.ts);
    st.lastActivityAt = Math.max(st.lastActivityAt, rec.ts);
    const newest = st.recentCalls[st.recentCalls.length - 1];
    if (newest && newest.tool === rec.tool && newest.preview === rec.preview && newest.isError === rec.isError) {
      return;
    }
    if (st.recentCalls.length >= RECENT_CALLS_CAPACITY) st.recentCalls.shift();
    st.recentCalls.push(rec);
  }

  /** 记一次求值尝试（sweep 之锚；成败皆记，免得证据不可用时每 tick 复问）。 */
  markChecked(runId: string, now: number): void {
    const st = this.map.get(runId);
    if (!st) return;
    st.lastCheckAt = now;
  }

  /**
   * 事件线去重：同 key 且距上次登记 < windowMs → false（已受理，跳过重触发）；
   * 否则登记并返 true。键容量有界，满则逐出最旧。
   */
  claim(runId: string, key: string, now: number, windowMs: number): boolean {
    const st = this.state(runId, "unknown", "", now);
    const hit = st.dedupeKeys.find((d) => d.key === key);
    if (hit && now - hit.ts < windowMs) return false;
    if (st.dedupeKeys.length >= DEDUPE_CAPACITY) st.dedupeKeys.shift();
    st.dedupeKeys.push({ key, ts: now });
    return true;
  }

  /** 遍历（时长线 sweep 驱动用）。 */
  entries(): IterableIterator<[string, MonitorState]> {
    return this.map.entries();
  }

  /** 删除（run 结束/证据枯竭时剪枝）。 */
  drop(runId: string): void {
    this.map.delete(runId);
  }
}
