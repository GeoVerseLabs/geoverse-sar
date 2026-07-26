/**
 * 声明式外部能力清单（阶段四 U5-C，RFC-0012 §三）：长尾只读 HTTP/OGC 包装
 * 零代码接入——JSON manifest → read 能力。与 L2 合成同一血统的哲学：
 * **清单是声明式数据、只有取值引用、不图灵完备**（无条件/无循环——schema 上就不存在；
 * 出现此类需求即拒绝，改走 MCP-in 桥或真代码）。
 *
 * 安全边界：url 只认 http/https；外部访问经注入的 fetch 服务（MANIFEST_FETCH_SERVICE_KEY）
 * ——「外访必须经 services」规范条款在此起效（可测、可换、可探针）；
 * effects 固定 `{ external:'read', approval:'never', idempotency:'keyed' }`——
 * manifest 通道只做只读（声明式写外部的爆炸半径不值得）。
 */
import { z } from 'zod';
import type { Capability } from './capability';
import { toValidationIssues } from './schema-utils';

export const MANIFEST_FETCH_SERVICE_KEY = 'runtime.fetch';

/** 注入的外访服务面（浏览器/Node 的全局 fetch 都结构兼容）。 */
export type ManifestFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const paramSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().optional(),
  required: z.boolean().default(true),
});

export const capabilityManifestSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .refine((v) => !v.includes('__'), { message: 'id 不得含 __（工具名双射）' }),
  title: z.string().min(1),
  description: z.string().min(15, 'description ≥15 字（模型"何时该调"的唯一依据）'),
  /** http/https 端点；可含 {param} 占位（路径取值替换，URL 编码）。 */
  url: z.string().regex(/^https?:\/\//, 'url 只认 http/https'),
  method: z.enum(['GET']).default('GET'),
  /** 入参声明：字段名 → 类型；未出现在 url 占位里的参数进查询串。 */
  params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), paramSchema).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  /** 响应 JSON 的取值路径（点分；缺省取整个响应体）。 */
  outputPick: z
    .string()
    .regex(/^[A-Za-z0-9_.[\]]*$/)
    .optional(),
  tags: z.array(z.string()).default([]),
});
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

function pick(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const seg of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function zodOf(p: z.infer<typeof paramSchema>): z.ZodType {
  const base =
    p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : z.string();
  const described = p.description ? base.describe(p.description) : base;
  return p.required ? described : described.optional();
}

/**
 * 载入清单 → 能力数组（载入时逐条 Zod 校验；坏清单**载入即拒**，附结构化 issues——
 * 坏声明不进目录）。同一份清单载入两次产出等价能力（幂等：无内部状态）。
 */
export function capabilitiesFromManifest(manifests: unknown[]): Capability[] {
  return manifests.map((raw, index) => {
    const parsed = capabilityManifestSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = toValidationIssues(parsed.error)
        .map((i) => `${i.path || '(根)'}: ${i.message}`)
        .join('；');
      throw new Error(`清单 #${index} 非法：${issues}`);
    }
    const m = parsed.data;
    const inputShape: Record<string, z.ZodType> = {};
    for (const [name, p] of Object.entries(m.params)) inputShape[name] = zodOf(p);
    const inputSchema = z.object(inputShape);
    const outputSchema = z.object({
      data: z.unknown().describe('外部响应（经 outputPick 取值后的 JSON）'),
    });

    return {
      id: m.id,
      title: m.title,
      description: `${m.description}（声明式清单能力：外部只读 HTTP，经注入的 fetch 服务执行）`,
      category: 'manifest',
      kind: 'read',
      tags: ['manifest', ...m.tags],
      since: '2026-07-27',
      effects: { external: 'read', approval: 'never', idempotency: 'keyed' },
      requires: [MANIFEST_FETCH_SERVICE_KEY],
      inputSchema,
      outputSchema,
      handler: async (ctx, input) => {
        const doFetch = ctx.services.require<ManifestFetch>(MANIFEST_FETCH_SERVICE_KEY);
        const values = input as Record<string, unknown>;
        let url = m.url;
        const used = new Set<string>();
        url = url.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => {
          used.add(name);
          const v = values[name];
          if (v === undefined) throw new Error(`url 占位缺参: {${name}}`);
          return encodeURIComponent(String(v));
        });
        const query = Object.entries(values)
          .filter(([k, v]) => !used.has(k) && v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&');
        if (query) url += (url.includes('?') ? '&' : '?') + query;

        const res = await doFetch(url, { method: m.method, headers: m.headers });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`外部端点 ${res.status}: ${body.slice(0, 200)}`);
        }
        const json = await res.json();
        return { output: { data: pick(json, m.outputPick) } };
      },
    } satisfies Capability;
  });
}
