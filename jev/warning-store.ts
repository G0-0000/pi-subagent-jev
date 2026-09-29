// warn 观察模式之违规提示暂存（纯内存，零 IO）：tool_call 钩落、tool_result 钩取。
// 有界容量（100 条）：满则先逐出最旧一条再插入（FIFO 逐出）——
// 防止 tool_result 事件缺失（如主 agent terminate）时暂存无限累积。
// take 为破坏性读取：取走即删，同一 toolCallId 至多追加一次。
export class WarningStore {
  private map = new Map<string, string>();
  private readonly capacity: number;

  constructor(capacity = 100) {
    this.capacity = capacity;
  }

  /** 暂存一条提示；容量已满时先逐出最旧一条（Map 迭代序即插入序）。 */
  stash(callId: string, text: string): void {
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(callId, text);
  }

  /** 破坏性读取：返回并删除；无则 undefined。 */
  take(callId: string): string | undefined {
    const text = this.map.get(callId);
    if (text !== undefined) this.map.delete(callId);
    return text;
  }
}
