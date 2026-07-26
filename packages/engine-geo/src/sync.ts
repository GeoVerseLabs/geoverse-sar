/**
 * 同步收编桥（阶段四 U3-B，RFC-0010 §四）：把 geoverse editor-core 的 `sync/` 既有栈
 * （SyncClient 累积 pending ChangeSet / 乐观锁 baseVersions / 409 三路合并 rebase）
 * 包成 SAR 可注入的服务——**桥只做搬运与结构化上抛，合并/锁语义全在 editor-core**；
 * engine-geo 出现与 sync/ 平行的合并/锁逻辑即违规（刹车点）。
 *
 * SyncClient 自行订阅 EditEngine 事务（apply/redo 入、undo 出），故桥的创建就是
 * 接线的全部；`source.commit` 能力经服务键调用 `commit()`。
 */
import {
  localWinsResolver,
  MemoryEditBackend,
  remoteWinsResolver,
  SyncClient,
  type CommitOutcome,
  type ConflictResolver,
  type EditSubmission,
  type EditTransport,
  type MergeEntry,
  type SubmitResponse,
  type SyncClientOptions,
  type ThreeWayMergeResult,
} from '@geoverse/editor-core';
import type { GeoStateEngine } from './engine';

// 再导出（几何桥纪律的同款延伸）：能力包/宿主经 engine-geo 消费 sync 面，
// 不直连 @geoverse/*（ESLint 依赖门执行）。MemoryEditBackend 供测试/演示。
export {
  localWinsResolver,
  MemoryEditBackend,
  remoteWinsResolver,
  type CommitOutcome,
  type ConflictResolver,
  type EditSubmission,
  type EditTransport,
  type MergeEntry,
  type SubmitResponse,
  type ThreeWayMergeResult,
};

/** capabilities-geo 的 source.commit 经此服务键取桥（宿主 createKernel services 注入）。 */
export const GEO_SYNC_SERVICE_KEY = 'geo.sync';

export interface SyncBridge {
  /** 未提交 ChangeSet 数（apply/redo 入、undo 出的净值）。 */
  pendingCount(): number;
  /** 打包提交（乐观锁 baseVersions；409 按 options 走三路合并/二路采纳）。 */
  commit(): Promise<CommitOutcome>;
  /** 解绑事务订阅（客人式：不碰引擎）。 */
  dispose(): void;
}

export type CreateSyncBridgeOptions = SyncClientOptions;

export function createSyncBridge(
  engine: GeoStateEngine,
  transport: EditTransport,
  options: CreateSyncBridgeOptions = {},
): SyncBridge {
  const client = new SyncClient(engine.editEngine, transport, options);
  return {
    pendingCount: () => client.pendingCount,
    commit: () => client.commit(),
    dispose: () => client.dispose(),
  };
}
