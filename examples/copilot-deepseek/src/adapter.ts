/**
 * 入口适配：Claude 形状 ToolSpec（skill 包产出）→ OpenAI 兼容 tools。
 * 内核 provider 无关（RFC-0008）——同一 CapabilityDescriptor 投影，只换传输壳。
 */
import type { SarKernel } from '@geoverse-sar/kernel';
import { handleToolCall, toToolSpecs, type ToolCallResult } from '@geoverse-sar/skill';
import type { OpenAiTool, ToolCall } from './deepseek';

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

/** 执行一次模型发出的 tool call：JSON 参数解析失败也走 is_error 回灌（模型自纠）。 */
export async function executeToolCall(
  kernel: SarKernel,
  call: ToolCall,
): Promise<ToolCallResult> {
  let args: unknown;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch (e) {
    return {
      content: JSON.stringify({
        error: { code: 'invalid_arguments_json', message: String(e) },
      }),
      is_error: true,
      outcome: {
        ok: false,
        capabilityId: call.function.name,
        durationMs: 0,
        error: { code: 'validation_failed', message: 'arguments 不是合法 JSON' },
      },
    };
  }
  return handleToolCall(kernel, call.function.name, args);
}
