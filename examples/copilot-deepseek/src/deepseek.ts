/** DeepSeek chat completions 极简客户端（OpenAI 兼容，零 SDK 依赖，Node 20+ fetch）。 */

export interface OpenAiFunctionDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAiTool {
  type: 'function';
  function: OpenAiFunctionDef;
}

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

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string;
  usage?: ChatUsage;
}

export interface DeepSeekClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class DeepSeekClient {
  private readonly apiKey: string;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: DeepSeekClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'deepseek-chat';
    this.baseUrl = opts.baseUrl ?? 'https://api.deepseek.com';
  }

  async chat(messages: ChatMessage[], tools?: OpenAiTool[]): Promise<ChatResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices: { message: ChatMessage; finish_reason: string }[];
      usage?: ChatUsage;
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error('DeepSeek API 返回空 choices');
    return { message: choice.message, finishReason: choice.finish_reason, usage: data.usage };
  }
}
