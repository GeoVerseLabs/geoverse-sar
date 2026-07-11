/**
 * 能力摄取管线原型（RFC-0009 T17，dev-time codegen）：
 * 目标仓 API 签名 → Zod schema → description →「能力文件 + 测试骨架」源码串。
 *
 * 边界（RFC-0009 §二）：这是 **dev-time** 工具——产物经 doctor 体检 + 人审 + commit
 * 进仓，SAR 运行时只消费注册结果，不做热代码。签名提取（ts-morph/typedoc 扫
 * `@sar-capability` 注解）是本管线的预期前端，原型阶段由调用方手工/脚本喂
 * `ApiSignature`——本模块钉死的是「类型→schema→描述→产物」这三段的确定性映射。
 */
import type { DraftLlm } from './types';

export interface ApiParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'object' | 'unknown';
  optional?: boolean;
  /** JSDoc @param 文本——会进 .describe()（模型可读的取值约定）。 */
  doc?: string;
}

export interface ApiSignature {
  /** 源函数名（如 translateFeatures）。 */
  name: string;
  params: ApiParam[];
  /** JSDoc 主体——description 的素材。 */
  doc?: string;
  /** 是否改状态（决定 kind write/read）；缺省按名称启发式。 */
  mutates?: boolean;
}

export interface IngestOptions {
  /** 能力 id 前缀（如 'records'），产出 `${prefix}.${name}`。 */
  idPrefix: string;
  category?: string;
  /** 提供则用 LLM 把 JSDoc 润成"何时该调"式 description；缺省确定性拼接。 */
  llm?: DraftLlm;
}

export interface IngestedCapability {
  id: string;
  kind: 'read' | 'write';
  description: string;
  /** 能力模块源码（zod schema + defineCapability 骨架，handler 留 TODO）。 */
  source: string;
  /** vitest 测试骨架。 */
  testSource: string;
}

const ZOD_BY_TYPE: Record<ApiParam['type'], string> = {
  string: 'z.string()',
  number: 'z.number()',
  boolean: 'z.boolean()',
  'string[]': 'z.array(z.string())',
  'number[]': 'z.array(z.number())',
  object: 'z.record(z.string(), z.unknown())',
  unknown: 'z.unknown()',
};

const READ_PREFIXES = ['get', 'list', 'query', 'find', 'search', 'measure', 'is', 'has'];

function inferKind(sig: ApiSignature): 'read' | 'write' {
  if (sig.mutates !== undefined) return sig.mutates ? 'write' : 'read';
  const lower = sig.name.toLowerCase();
  return READ_PREFIXES.some((p) => lower.startsWith(p)) ? 'read' : 'write';
}

function zodField(p: ApiParam): string {
  let expr = ZOD_BY_TYPE[p.type];
  if (p.doc) expr += `.describe(${JSON.stringify(p.doc)})`;
  if (p.optional) expr += '.optional()';
  return `  ${p.name}: ${expr},`;
}

async function buildDescription(sig: ApiSignature, llm?: DraftLlm): Promise<string> {
  const base = sig.doc?.trim() || `调用宿主 API ${sig.name}。`;
  if (!llm) return base;
  const polished = await llm.complete(
    [
      '把下面的 API 文档改写成 AI 工具目录里的 description：一句话说清「何时该调 + 做什么」，',
      '简体中文，只输出改写结果本身。',
      `函数：${sig.name}(${sig.params.map((p) => p.name).join(', ')})`,
      `文档：${base}`,
    ].join('\n'),
  );
  return polished.trim() || base;
}

/** 单个签名 → 能力文件 + 测试骨架（确定性；LLM 只参与 description 润色）。 */
export async function ingestCapability(
  sig: ApiSignature,
  opts: IngestOptions,
): Promise<IngestedCapability> {
  const id = `${opts.idPrefix}.${sig.name}`;
  const kind = inferKind(sig);
  const description = await buildDescription(sig, opts.llm);
  const category = opts.category ?? opts.idPrefix;
  const constName = sig.name;

  const source = [
    `import { z } from 'zod';`,
    `import { defineCapability } from '@geoverse-sar/kernel';`,
    ``,
    `const input = z.object({`,
    ...sig.params.map(zodField),
    `});`,
    ``,
    `export const ${constName} = defineCapability({`,
    `  id: ${JSON.stringify(id)},`,
    `  title: ${JSON.stringify(sig.name)},`,
    `  description: ${JSON.stringify(description)},`,
    `  category: ${JSON.stringify(category)},`,
    `  kind: ${JSON.stringify(kind)},`,
    `  inputSchema: input,`,
    `  outputSchema: z.unknown(),`,
    `  handler: async (ctx, input) => {`,
    `    // TODO: 桥接宿主 API ${sig.name}（write 能力返回 { output, commands } 走引擎）`,
    `    throw new Error('not implemented');`,
    `  },`,
    `});`,
    ``,
  ].join('\n');

  const testSource = [
    `import { describe, expect, it } from 'vitest';`,
    `import { ${constName} } from '../src/${sig.name}';`,
    ``,
    `describe(${JSON.stringify(id)}, () => {`,
    `  it('schema 拒绝缺参', () => {`,
    `    expect(${constName}.inputSchema.safeParse({}).success).toBe(${sig.params.every((p) => p.optional)});`,
    `  });`,
    `  // TODO: handler 行为断言（dryRun diff / 输出形状）`,
    `});`,
    ``,
  ].join('\n');

  return { id, kind, description, source, testSource };
}
