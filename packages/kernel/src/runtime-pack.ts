/**
 * 内建 runtime 能力包（目标架构 R3，N3 远程化前置）：
 * 把"观察 runtime 元数据 / 保存进度"从进程内对象戳探升格为**能力**——
 * agent/远程入口经同一漏斗调用即可，不再直读 engine（R6 据此切换观察面）。
 * stats 是 runtime 元数据而非领域知识，不违反内核零领域（RFC-0008）。
 */
import { z } from 'zod';
import { defineCapability, type CapabilityPack } from './capability';
import { JOBS_SERVICE_KEY, type JobManager } from './jobs';
import type { CapabilityDescriptor, DescribeFilter } from './registry';

/** T4 openWorkspace 注入的 checkpoint 服务键（缺失时 invoke 报 service_missing）。 */
export const CHECKPOINT_SERVICE_KEY = 'runtime.checkpoint';

export interface CheckpointService {
  /** 落快照并截断已归档 journal，返回 checkpoint 位点。 */
  checkpoint(): Promise<{ checkpointSeq: number }>;
}

/** createKernel 自动注入的目录发现服务键（catalog.search 依赖；宿主同键可覆写）。 */
export const CATALOG_SERVICE_KEY = 'runtime.catalog';

export interface CatalogService {
  /** 关键词发现（registry.discover 的服务化投影；filter.caller 生效=权限裁剪一致）。 */
  discover(query: string, filter?: DescribeFilter): CapabilityDescriptor[];
}

const statsInput = z.object({});
const statsOutput = z.object({
  entityCount: z.number(),
  undoDepth: z.number().nullable(),
  redoDepth: z.number().nullable(),
  canUndo: z.boolean().nullable(),
  canRedo: z.boolean().nullable(),
});

const checkpointInput = z.object({});
const checkpointOutput = z.object({ checkpointSeq: z.number() });

const searchInput = z.object({
  query: z
    .string()
    .min(1)
    .describe('关键词：匹配能力 id / 标题 / 描述 / tags（大小写不敏感）'),
  category: z.string().optional().describe('限定能力分类（如 query/edit/runtime）'),
  kind: z.enum(['read', 'write', 'action']).optional().describe('限定能力三态'),
  limit: z.number().int().min(1).max(50).default(10).describe('最多返回条数'),
});
const searchOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      kind: z.string(),
      category: z.string(),
      tags: z.array(z.string()).optional(),
      deprecated: z.union([z.boolean(), z.string()]).optional(),
    }),
  ),
  total: z.number().describe('命中总数（可能大于返回条数）'),
});

const jobRecordSchema = z.object({
  jobId: z.string(),
  title: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  progress: z.number(),
  note: z.string().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export interface CreateRuntimePackOptions {
  /** 是否包含 runtime.checkpoint（默认 true；无持久化宿主可关掉免 doctor 告警）。 */
  checkpoint?: boolean;
  /** 是否包含 catalog.search（默认 true；目录规模化的检索面，U0-6）。 */
  search?: boolean;
  /** 是否包含 jobs.list/status/cancel（默认 true；异步作业面，U4-C）。 */
  jobs?: boolean;
}

export function createRuntimePack<TEntity, TDiff>(
  options: CreateRuntimePackOptions = {},
): CapabilityPack<TEntity, TDiff> {
  const stats = defineCapability<
    z.infer<typeof statsInput>,
    z.infer<typeof statsOutput>,
    TEntity,
    TDiff
  >({
    id: 'runtime.stats',
    title: '运行时状态',
    description:
      '查看 runtime 当前元数据：实体总数、撤销/重做栈深、能否撤销重做。' +
      '想了解工作现场概况或决定是否可撤销时先调它；只读。',
    category: 'runtime',
    kind: 'read',
    tags: ['runtime', 'observe'],
    inputSchema: statsInput,
    outputSchema: statsOutput,
    handler: async (ctx) => {
      const undoDepth = ctx.engine.undoDepth ?? null;
      const redoDepth = ctx.engine.redoDepth ?? null;
      return {
        output: {
          entityCount: ctx.state.count?.() ?? ctx.state.ids().length,
          undoDepth,
          redoDepth,
          canUndo: undoDepth === null ? null : undoDepth > 0,
          canRedo: redoDepth === null ? null : redoDepth > 0,
        },
      };
    },
  });

  const checkpoint = defineCapability<
    z.infer<typeof checkpointInput>,
    z.infer<typeof checkpointOutput>,
    TEntity,
    TDiff
  >({
    id: 'runtime.checkpoint',
    title: '保存进度',
    description:
      '把当前工作区落成快照并归档更早的事务日志（checkpoint）。' +
      '完成一批重要修改后调用可加速下次恢复；注意更早历史将不可撤销。',
    category: 'runtime',
    kind: 'action',
    tags: ['runtime', 'persist'],
    requires: [CHECKPOINT_SERVICE_KEY],
    inputSchema: checkpointInput,
    outputSchema: checkpointOutput,
    handler: async (ctx) => {
      const svc = ctx.services.require<CheckpointService>(CHECKPOINT_SERVICE_KEY);
      return { output: await svc.checkpoint() };
    },
  });

  const search = defineCapability<
    z.infer<typeof searchInput>,
    z.infer<typeof searchOutput>,
    TEntity,
    TDiff
  >({
    id: 'catalog.search',
    title: '搜索能力目录',
    description:
      '按关键词在能力目录里查找可用工具（匹配 id/标题/描述/tags，可按分类与三态过滤）。' +
      '当不确定有哪些工具、或目录太大记不全时先调它再决定调用什么；只读。' +
      '结果已按你的权限裁剪——搜不到的能力也调不了。',
    category: 'runtime',
    kind: 'read',
    tags: ['runtime', 'catalog', 'discover'],
    since: '2026-07-26',
    requires: [CATALOG_SERVICE_KEY],
    inputSchema: searchInput,
    outputSchema: searchOutput,
    handler: async (ctx, input) => {
      const catalog = ctx.services.require<CatalogService>(CATALOG_SERVICE_KEY);
      // 权限裁剪与 describeAll/invoke 同一判定：caller 看不见的能力搜不出（结构性保证）
      const hits = catalog.discover(input.query, {
        caller: ctx.caller,
        category: input.category,
        kind: input.kind,
      });
      return {
        output: {
          items: hits.slice(0, input.limit).map((d) => ({
            id: d.id,
            title: d.title,
            description: d.description,
            kind: d.kind,
            category: d.category,
            ...(d.tags ? { tags: [...d.tags] } : {}),
            ...(d.deprecated !== undefined ? { deprecated: d.deprecated } : {}),
          })),
          total: hits.length,
        },
      };
    },
  });

  const jobsList = defineCapability<
    Record<string, never>,
    { jobs: z.infer<typeof jobRecordSchema>[] },
    TEntity,
    TDiff
  >({
    id: 'jobs.list',
    title: '作业列表',
    description: '列出全部异步作业（运行中与已终局）及其进度。只读。',
    category: 'runtime',
    kind: 'read',
    tags: ['runtime', 'jobs'],
    since: '2026-07-27',
    requires: [JOBS_SERVICE_KEY],
    inputSchema: z.object({}),
    outputSchema: z.object({ jobs: z.array(jobRecordSchema) }),
    handler: async (ctx) => {
      const jobs = ctx.services.require<JobManager>(JOBS_SERVICE_KEY);
      return { output: { jobs: jobs.list() } };
    },
  });

  const jobsStatus = defineCapability<
    { jobId: string },
    z.infer<typeof jobRecordSchema>,
    TEntity,
    TDiff
  >({
    id: 'jobs.status',
    title: '作业状态',
    description: '查询单个异步作业的状态/进度/产出（succeeded 时含 result）。只读。',
    category: 'runtime',
    kind: 'read',
    tags: ['runtime', 'jobs'],
    since: '2026-07-27',
    requires: [JOBS_SERVICE_KEY],
    inputSchema: z.object({ jobId: z.string() }),
    outputSchema: jobRecordSchema,
    handler: async (ctx, input) => {
      const jobs = ctx.services.require<JobManager>(JOBS_SERVICE_KEY);
      const record = jobs.get(input.jobId);
      if (!record) throw new Error(`作业不存在: ${input.jobId}（jobs.list 查看全部）`);
      return { output: record };
    },
  });

  const jobsCancel = defineCapability<
    { jobId: string },
    { cancelled: boolean },
    TEntity,
    TDiff
  >({
    id: 'jobs.cancel',
    title: '取消作业',
    description:
      '向运行中的异步作业发取消信号（协作式：作业须尊重 signal）。已终局的作业返回 cancelled=false。',
    category: 'runtime',
    kind: 'action',
    tags: ['runtime', 'jobs'],
    since: '2026-07-27',
    requires: [JOBS_SERVICE_KEY],
    inputSchema: z.object({ jobId: z.string() }),
    outputSchema: z.object({ cancelled: z.boolean() }),
    handler: async (ctx, input) => {
      const jobs = ctx.services.require<JobManager>(JOBS_SERVICE_KEY);
      return { output: { cancelled: jobs.cancel(input.jobId) } };
    },
  });

  const capabilities: CapabilityPack<TEntity, TDiff>['capabilities'] = [stats];
  if (options.checkpoint !== false) capabilities.push(checkpoint);
  if (options.search !== false) capabilities.push(search);
  if (options.jobs !== false) capabilities.push(jobsList, jobsStatus, jobsCancel);
  return { id: 'runtime', capabilities };
}
