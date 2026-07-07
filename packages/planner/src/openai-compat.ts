import type {
  AssistantTurn,
  LlmClient,
  LlmCompleteOptions,
  LlmRequest,
  PlannerMessage,
  PlannerToolCall,
} from './types';

/**
 * OpenAI 兼容 chat/completions 客户端（DeepSeek/Kimi/vLLM 等同协议直用）：
 * 零 SDK、浏览器/Node 通用（fetch + ReadableStream）。
 * stream: true 时走 SSE，正文增量经 onTextDelta 逐段回吐（流式进度）。
 */
export interface OpenAiCompatOptions {
  /** 完整补全端点，如 `/api/deepseek/chat/completions` 或 `https://api.deepseek.com/chat/completions`。 */
  url: string;
  model: string;
  /** 额外请求头（如 Authorization——浏览器侧建议由代理注入，别放前端）。 */
  headers?: Record<string, string>;
  /** 默认 true：SSE 流式；置 false 走一次性 JSON。 */
  stream?: boolean;
  /** 注入自定义 fetch（测试/代理）。 */
  fetchImpl?: typeof fetch;
  temperature?: number;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

function toWireMessages(system: string, messages: PlannerMessage[]): WireMessage[] {
  const wire: WireMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      wire.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      wire.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls?.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      });
    } else {
      wire.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId });
    }
  }
  return wire;
}

function toolsPayload(req: LlmRequest): unknown[] {
  return req.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function normalizeCalls(calls: WireToolCall[] | undefined): PlannerToolCall[] {
  return (calls ?? [])
    .filter((c) => c.function?.name)
    .map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function!.name!,
      arguments: c.function!.arguments ?? '',
    }));
}

/** SSE 数据行解析：跨 chunk 断行缓冲，产出每个 `data:` 载荷（不含 [DONE]）。 */
export function createSseLineParser(onPayload: (json: string) => void): {
  push(chunk: string): void;
} {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') onPayload(payload);
      }
    },
  };
}

interface StreamDelta {
  choices?: {
    delta?: { content?: string | null; tool_calls?: (WireToolCall & { index?: number })[] };
  }[];
}

export function createOpenAiCompatClient(options: OpenAiCompatOptions): LlmClient {
  const { url, model, headers = {}, stream = true, temperature } = options;
  const doFetch = options.fetchImpl ?? fetch;

  async function complete(
    req: LlmRequest,
    opts: LlmCompleteOptions = {},
  ): Promise<AssistantTurn> {
    const body = {
      model,
      messages: toWireMessages(req.system, req.messages),
      tools: req.tools.length ? toolsPayload(req) : undefined,
      tool_choice: req.tools.length ? 'auto' : undefined,
      temperature,
      stream,
    };
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
    }

    if (!stream) {
      const data = (await res.json()) as { choices?: { message?: WireMessage }[] };
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('LLM 返回空 choices');
      return { text: msg.content ?? '', toolCalls: normalizeCalls(msg.tool_calls) };
    }

    if (!res.body) throw new Error('流式响应无 body（宿主 fetch 不支持 ReadableStream）');
    let text = '';
    // 工具调用增量按 index 归并：首片携 id/name，后续片只有 arguments 增量
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const parser = createSseLineParser((payload) => {
      let evt: StreamDelta;
      try {
        evt = JSON.parse(payload) as StreamDelta;
      } catch {
        return; // 容忍非 JSON 心跳行
      }
      const delta = evt.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) {
        text += delta.content;
        opts.onTextDelta?.(delta.content);
      }
      for (const c of delta.tool_calls ?? []) {
        const index = c.index ?? 0;
        const entry = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (c.id) entry.id = c.id;
        if (c.function?.name) entry.name += c.function.name;
        if (c.function?.arguments) entry.arguments += c.function.arguments;
        calls.set(index, entry);
      }
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());

    const toolCalls: PlannerToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments }));
    return { text, toolCalls };
  }

  return { complete };
}
