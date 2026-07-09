import { describe, expect, it } from 'vitest';
import { createOpenAiCompatClient, createSseLineParser } from '../src/index';
import type { LlmRequest } from '../src/index';

const REQ: LlmRequest = {
  system: '你是助手',
  messages: [{ role: 'user', content: '你好' }],
  tools: [
    {
      name: 'records__query',
      description: '查询记录',
      input_schema: { type: 'object', properties: {} },
    },
  ],
};

function sseResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('createOpenAiCompatClient', () => {
  it('非流式：一次性 JSON → AssistantTurn；请求体含 OpenAI 工具规格', async () => {
    let captured: Record<string, unknown> | undefined;
    const client = createOpenAiCompatClient({
      url: 'http://llm.test/chat/completions',
      model: 'test-model',
      stream: false,
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'records__query', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const turn = await client.complete(REQ);
    expect(turn.toolCalls).toEqual([
      { id: 'call_1', name: 'records__query', arguments: '{}' },
    ]);
    expect(captured).toMatchObject({
      model: 'test-model',
      stream: false,
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'records__query' } }],
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ],
    });
  });

  it('SSE 流式：正文增量逐段回调；tool_calls 按 index 跨片归并', async () => {
    const client = createOpenAiCompatClient({
      url: 'http://llm.test/chat/completions',
      model: 'test-model',
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          // 跨 chunk 断行：一行被拆成两个 chunk
          'data: {"choices":[{"delta":{"content":"好',
          '呀"}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"records__tra","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"nslate","arguments":"{\\"ids\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":[\\"p1\\"]}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
    });
    const deltas: string[] = [];
    const turn = await client.complete(REQ, { onTextDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(['你', '好呀']);
    expect(turn.text).toBe('你好呀');
    expect(turn.toolCalls).toEqual([
      { id: 'call_9', name: 'records__translate', arguments: '{"ids":["p1"]}' },
    ]);
  });

  it('HTTP 非 200 → 抛错携状态码与正文片段', async () => {
    const client = createOpenAiCompatClient({
      url: 'http://llm.test/x',
      model: 'm',
      fetchImpl: async () => new Response('{"error":"bad key"}', { status: 401 }),
    });
    await expect(client.complete(REQ)).rejects.toThrow(/401.*bad key/s);
  });
});

describe('createSseLineParser', () => {
  it('容忍 CRLF、注释行、心跳与 [DONE]', () => {
    const out: string[] = [];
    const parser = createSseLineParser((p) => out.push(p));
    parser.push('data: {"a":1}\r\n: keep-alive\r\n\r\ndata: [DONE]\r\ndata: {"b":2}\n');
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});
