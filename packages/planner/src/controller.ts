import type { Planner, PlannerRunOptions } from './planner';
import type { PlannerRunResult } from './types';

/**
 * 无头聊天控制器（M3 UI 绑定）：框架无关的订阅式状态投影。
 * Vue/React/原生 DOM 只需 `subscribe(render)` + `send(text)`——
 * 时间线（含流式正文增量、工具调用轨迹）全部由 PlannerEvent 驱动。
 */
export type ChatItemRole = 'user' | 'assistant' | 'tool' | 'error';

export interface ChatItem {
  role: ChatItemRole;
  text: string;
  /** 工具调用/结果的载荷（JSON 串），UI 折叠展示。 */
  detail?: string;
  isError?: boolean;
  /** 流式接收中（assistant 正文逐段增长）。 */
  streaming?: boolean;
}

export interface ChatState {
  items: ChatItem[];
  busy: boolean;
}

export interface ChatController {
  getState(): ChatState;
  /** 订阅状态变化；返回解绑。订阅即以当前状态回调一次。 */
  subscribe(fn: (s: ChatState) => void): () => void;
  send(
    text: string,
    opts?: Omit<PlannerRunOptions, 'onEvent' | 'signal'>,
  ): Promise<PlannerRunResult | undefined>;
  /** 中止进行中的 run（无进行中则空操作）。 */
  abort(): void;
  /** 清空时间线与会话历史。 */
  clear(): void;
}

export interface CreateChatControllerOptions {
  /**
   * 初始时间线（T6b）：从 workspace conversations 快照恢复 UI 展示。
   * 与 createPlanner 的 history 选项配对使用（items 是展示面、history 是模型上下文）。
   */
  items?: readonly ChatItem[];
}

export function createChatController(
  planner: Planner,
  options: CreateChatControllerOptions = {},
): ChatController {
  const state: ChatState = {
    items: (options.items ?? []).map((i) => ({ ...i, streaming: false })),
    busy: false,
  };
  const listeners = new Set<(s: ChatState) => void>();
  let aborter: AbortController | undefined;

  const notify = (): void => {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch {
        // 订阅者异常不得中断控制器
      }
    }
  };

  async function send(
    text: string,
    opts: Omit<PlannerRunOptions, 'onEvent' | 'signal'> = {},
  ): Promise<PlannerRunResult | undefined> {
    const trimmed = text.trim();
    if (!trimmed || state.busy) return undefined;
    state.busy = true;
    state.items.push({ role: 'user', text: trimmed });
    notify();

    aborter = new AbortController();
    let streamingItem: ChatItem | undefined;
    try {
      const result = await planner.run(trimmed, {
        ...opts,
        signal: aborter.signal,
        onEvent: (e) => {
          if (e.type === 'text:delta') {
            if (!streamingItem) {
              streamingItem = { role: 'assistant', text: '', streaming: true };
              state.items.push(streamingItem);
            }
            streamingItem.text += e.delta;
          } else if (e.type === 'assistant') {
            if (streamingItem) {
              // 流式已逐段落盘：终稿覆盖增量拼接（以模型完整文本为准）
              streamingItem.text = e.text;
              streamingItem.streaming = false;
              streamingItem = undefined;
            } else {
              state.items.push({ role: 'assistant', text: e.text });
            }
          } else if (e.type === 'tool:call') {
            // 新一轮工具调用开始：上一段流式正文（若有）定稿
            if (streamingItem) {
              streamingItem.streaming = false;
              streamingItem = undefined;
            }
            state.items.push({ role: 'tool', text: `→ ${e.name}`, detail: e.argsRaw });
          } else if (e.type === 'tool:result') {
            state.items.push({
              role: 'tool',
              text: `${e.ok ? '✔' : '✘'} ${e.name}`,
              detail: e.content,
              isError: !e.ok,
            });
          }
          notify();
        },
      });
      if (!result.ok && result.stopReason === 'error') {
        state.items.push({
          role: 'error',
          text: result.error ?? '未知错误',
          isError: true,
        });
      } else if (!result.ok && result.stopReason === 'max_rounds') {
        state.items.push({ role: 'error', text: '已达最大工具调用轮数', isError: true });
      }
      return result;
    } finally {
      if (streamingItem) streamingItem.streaming = false;
      state.busy = false;
      aborter = undefined;
      notify();
    }
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    send,
    abort() {
      aborter?.abort();
    },
    clear() {
      state.items.length = 0;
      planner.reset();
      notify();
    },
  };
}
