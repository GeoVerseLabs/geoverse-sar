/**
 * 内建 runtime 能力包（目标架构 R3，N3 远程化前置）：
 * 把"观察 runtime 元数据 / 保存进度"从进程内对象戳探升格为**能力**——
 * agent/远程入口经同一漏斗调用即可，不再直读 engine（R6 据此切换观察面）。
 * stats 是 runtime 元数据而非领域知识，不违反内核零领域（RFC-0008）。
 */
import { z } from 'zod';
import { defineCapability, type CapabilityPack } from './capability';

/** T4 openWorkspace 注入的 checkpoint 服务键（缺失时 invoke 报 service_missing）。 */
export const CHECKPOINT_SERVICE_KEY = 'runtime.checkpoint';

export interface CheckpointService {
  /** 落快照并截断已归档 journal，返回 checkpoint 位点。 */
  checkpoint(): Promise<{ checkpointSeq: number }>;
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

export interface CreateRuntimePackOptions {
  /** 是否包含 runtime.checkpoint（默认 true；无持久化宿主可关掉免 doctor 告警）。 */
  checkpoint?: boolean;
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

  return {
    id: 'runtime',
    capabilities: options.checkpoint === false ? [stats] : [stats, checkpoint],
  };
}
