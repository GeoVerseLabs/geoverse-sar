/**
 * 浏览器侧 DeepSeek 客户端：只打 dev 代理 `/api/deepseek/*`，
 * Authorization 由 vite 代理注入（见 vite.config.ts）——密钥不进前端。
 */
import type { SarKernel } from '@geoverse-sar/kernel';
import { handleToolCall, toToolSpecs } from '@geoverse-sar/skill';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function toOpenAiTools(kernel: SarKernel): OpenAiTool[] {
  return toToolSpecs(kernel).map((spec) => ({
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.input_schema,
    },
  }));
}

async function chatCompletion(
  messages: ChatMessage[],
  tools: OpenAiTool[],
  model = 'deepseek-chat',
): Promise<ChatMessage> {
  const res = await fetch('/api/deepseek/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      res.status === 401
        ? 'DeepSeek 鉴权失败：请确认仓根 .env 的 DEEPSEEK_API_KEY（需 dev server 代理）'
        : `DeepSeek API ${res.status}: ${body.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as { choices: { message: ChatMessage }[] };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('DeepSeek 返回空 choices');
  return msg;
}

/** UI 时间线事件：一次 runTurn 内按发生顺序回调。 */
export type TurnEvent =
  | { kind: 'tool_call'; name: string; args: string }
  | { kind: 'tool_result'; name: string; content: string; isError: boolean }
  | { kind: 'assistant'; text: string };

/** tool-use 循环：模型 ↔ 单一 invoke 漏斗（caller.entry='ai'），最多 8 轮。 */
export async function runTurn(
  kernel: SarKernel,
  messages: ChatMessage[],
  userText: string,
  onEvent: (e: TurnEvent) => void,
): Promise<void> {
  const tools = toOpenAiTools(kernel);
  messages.push({ role: 'user', content: userText });

  for (let i = 0; i < 8; i++) {
    const message = await chatCompletion(messages, tools);
    messages.push(message);
    if (!message.tool_calls?.length) {
      onEvent({ kind: 'assistant', text: message.content ?? '' });
      return;
    }
    for (const call of message.tool_calls) {
      onEvent({ kind: 'tool_call', name: call.function.name, args: call.function.arguments });
      let args: unknown = {};
      let parseError: string | undefined;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (e) {
        parseError = String(e);
      }
      const result = parseError
        ? { content: JSON.stringify({ error: { code: 'invalid_arguments_json', message: parseError } }), is_error: true }
        : await handleToolCall(kernel, call.function.name, args);
      onEvent({
        kind: 'tool_result',
        name: call.function.name,
        content: result.content,
        isError: result.is_error,
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.is_error ? `ERROR: ${result.content}` : result.content,
      });
    }
  }
  onEvent({ kind: 'assistant', text: '（达到最大工具调用轮数）' });
}

export const SYSTEM_PROMPT = [
  '你是 GeoVerse SAR 运行时的空间数据助手，管理一批平面点记录（字段：id、x、y、props）。',
  '你只能通过提供的工具读写数据：先用 records__query 查看，再做写操作；写操作可用 history__undo 撤销。',
  '多步组合操作优先用 workflow__highlightAndNudge（一次调用完成查询→聚焦→高亮→平移，且整体只占一个撤销单元）。',
  '回答用简体中文，简短说明你调用了什么工具、结果如何。',
].join('\n');
