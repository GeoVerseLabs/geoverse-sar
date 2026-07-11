/**
 * LLM 起草（L2 第二步）：高频序列 + 能力目录 → Workflow 草稿（纯 JSON）。
 * LLM 只产**数据**；草稿经 zod 严格校验，解析不过即失败（不猜不修）。
 */
import { z } from 'zod';
import type { CapabilityDescriptor } from '@geoverse-sar/kernel';
import type { DraftLlm, MinedSequence, WorkflowDraft } from './types';

const draftSchema = z.object({
  id: z.string().regex(/^workflow\.[A-Za-z][\w-]*$/, 'id 须形如 workflow.xxx'),
  title: z.string().min(1),
  description: z.string().min(10, 'description 要写"何时该调"'),
  inputFields: z.record(z.string(), z.enum(['string', 'number', 'boolean'])).optional(),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        capability: z.string().min(1),
        input: z.unknown().optional(),
      }),
    )
    .min(1),
});

export function buildDraftPrompt(
  catalog: readonly CapabilityDescriptor[],
  sequence: MinedSequence,
): string {
  const inSeq = new Set(sequence.capabilityIds);
  const caps = catalog
    .filter((d) => inSeq.has(d.id))
    .map(
      (d) =>
        `- ${d.id}（${d.kind}）：${d.description}\n  入参 schema：${JSON.stringify(d.inputJsonSchema)}`,
    )
    .join('\n');
  return [
    '你在为一个空间应用运行时（SAR）把高频出现的能力调用序列固化成可注册的 Workflow。',
    '只输出一个严格 JSON 对象（不要 markdown 代码块、不要注释），形如：',
    '{"id":"workflow.xxx","title":"...","description":"何时该调 + 做什么","inputFields":{"字段":"number"},"steps":[{"id":"s1","capability":"能力id","input":{...}}]}',
    '规则：',
    '- steps 顺序沿用给定序列；每步 input 按该能力的 schema 构造。',
    '- input 里可用字符串 "$input.字段" 引用工作流入参（字段须在 inputFields 声明），',
    '  "$steps.步骤id.字段" 引用前面步骤的输出字段；路径段 "*" 做数组投影',
    '  （如 "$steps.find.records.*.id" 取查询结果的 id 数组）。',
    '- 把会被复用时想改的量提为 inputFields（如平移量、过滤值）；固定不变的直接写字面量。',
    '- description 必须说清何时该调用这个工作流。',
    '',
    `高频序列（出现 ${sequence.count} 次）：${sequence.capabilityIds.join(' → ')}`,
    '',
    '相关能力目录：',
    caps,
  ].join('\n');
}

/** 提取首个 JSON 对象（防御模型包了 ```json 围栏或前后缀话）。 */
function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return text;
  return text.slice(start, end + 1);
}

export async function draftWorkflow(
  llm: DraftLlm,
  catalog: readonly CapabilityDescriptor[],
  sequence: MinedSequence,
): Promise<WorkflowDraft> {
  const raw = await llm.complete(buildDraftPrompt(catalog, sequence));
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    throw new Error(`LLM 草稿不是合法 JSON: ${String(err)}`);
  }
  const result = draftSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`LLM 草稿不符合 WorkflowDraft 形状: ${issues}`);
  }
  return result.data;
}
