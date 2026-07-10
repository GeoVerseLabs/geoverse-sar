/**
 * openWorkspace（目标架构 R4）——「一次持续工作现场」的聚合根：
 * kernel + store + 录制 + 恢复 + checkpoint 策略 + 单写者锁 + close。
 *
 * 打开（恢复）算法（§3.2）：
 *   meta ← getSnapshot('workspace')；seed ← getSnapshot('entities')
 *   engine ← engineFactory(seed)（undo 栈为空——checkpoint 即撤销地平线）
 *   tail ← read('journal', { fromSeq: meta.checkpointSeq + 1 })，校验 seq 连续
 *   replayJournal(kernel, tail) → 终态与撤销粒度精确复现，随后继续录制
 *
 * 撤销地平线（对目标架构 §六 的落地决策）：恢复后可撤销的只有 checkpoint 之后
 * 重放的事务——引擎端口无法在不应用 diff 的前提下重建更早的撤销栈（tail 中还混有
 * undo/redo 条目）。keepTail 仅作归档余量（取证），不承诺"重启可撤销更早历史"；
 * UI 应提示「更早历史已归档」。
 *
 * checkpoint 位点的并发安全：journal 条目的 store seq = 开录基准 base + 条目内存序号
 * （同一流只有本录制器在写）。checkpoint 在**同一 tick** 捕获 engine.snapshot() 与
 * journal.size → checkpointSeq = base + size，之后 flush/落盘——期间新事务 seq 必然
 * 大于位点，恢复时重放不会双重应用。
 */
import {
  CHECKPOINT_SERVICE_KEY,
  createAuditLog,
  createJournal,
  createKernel,
  createRuntimePack,
  replayJournal,
  type AuditLog,
  type CapabilityPack,
  type DiffAlgebra,
  type Journal,
  type JournalEntry,
  type Middleware,
  type SarKernel,
  type SarStore,
  type StateEngine,
  type Workflow,
} from '@geoverse-sar/kernel';

export interface WorkspaceMeta {
  formatVersion: 1;
  engineKind: string;
  checkpointSeq: number;
}

export interface WorkspacePersistOptions {
  /** 录制事务日志到 store（默认 true；关掉则失去恢复能力，仅快照可用）。 */
  journal?: boolean;
  /** 审计流化到 store（默认 true）。 */
  audit?: boolean;
  /**
   * 自动 checkpoint：每 everyTx 个事务触发（默认 200；0/false 关闭）。
   * keepTail：截断时在位点前多保留的归档条目数（默认 0；不改变撤销地平线）。
   */
  checkpoint?: { everyTx?: number | false; keepTail?: number };
  /** close 时自动 checkpoint（默认 true；只读模式下自动跳过）。 */
  checkpointOnClose?: boolean;
}

export type EngineFactory<TEntity, TDiff> = (
  seed?: TEntity[],
) => StateEngine<TEntity, TDiff>;

export interface OpenWorkspaceOptions<TEntity, TDiff> {
  store: SarStore;
  /**
   * 引擎**工厂**（恢复时用快照 seed 重建——宿主给工厂即自愿把重建权交给 workspace）；
   * 传已建实例则禁用恢复，退化为纯录制（ADR-0013 客人式语义保留）。
   */
  engine: EngineFactory<TEntity, TDiff> | StateEngine<TEntity, TDiff>;
  algebra: DiffAlgebra<TEntity, TDiff>;
  packs?: CapabilityPack<TEntity, TDiff>[];
  workflows?: Workflow[];
  services?: Record<string, unknown>;
  middleware?: Middleware[];
  /** 首次创建（store 无快照）时的种子实体。 */
  seed?: TEntity[];
  /** 引擎标识，写进 meta；重开时不匹配即拒绝（默认 'generic'）。 */
  engineKind?: string;
  persist?: WorkspacePersistOptions;
  /** 注册内建 runtime 能力包（stats + checkpoint；默认 true）。 */
  runtimePack?: boolean;
  /**
   * 单写者锁名（浏览器 Web Locks；同名工作区双开时后来者进只读模式）。
   * 缺省不加锁；Node 环境无 navigator.locks 时忽略（部署层保证单写者）。
   */
  lock?: string;
  /** close 时是否连带关闭 store（默认 true；宿主自管 store 生命周期时传 false）。 */
  closeStore?: boolean;
  onWarn?: (message: string) => void;
}

export interface RestoreInfo {
  fromSnapshot: boolean;
  replayed: number;
}

export interface Workspace<TEntity, TDiff> {
  readonly kernel: SarKernel<TEntity, TDiff>;
  readonly store: SarStore;
  readonly journal?: Journal<TDiff>;
  readonly audit?: AuditLog;
  readonly restored: RestoreInfo;
  /** 未拿到写锁（同名工作区已被别的实例持有）→ 只读：写/action 一律拒绝。 */
  readonly readOnly: boolean;
  /** 手动落快照并截断已归档 journal（也注册为能力 runtime.checkpoint）。 */
  checkpoint(): Promise<{ checkpointSeq: number }>;
  /** 对话历史快照（planner/agent 的 history 按会话 id 存取）。 */
  saveConversation(id: string, messages: unknown[]): Promise<void>;
  loadConversation<T = unknown>(id: string): Promise<T[] | undefined>;
  /** flush + （可配）checkpoint + 释放锁 + dispose + 关闭 store（幂等）。 */
  close(): Promise<void>;
}

const JOURNAL_STREAM = 'journal';
const AUDIT_STREAM = 'audit';
const META_KEY = 'workspace';
const ENTITIES_KEY = 'entities';
const conversationKey = (id: string) => `conversation:${id}`;

/** Web Locks 单写者：拿到锁返回释放函数；拿不到返回 null（进只读）。 */
async function acquireLock(name: string): Promise<(() => void) | null | undefined> {
  const locks = (
    globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined
  )?.locks;
  if (!locks) return undefined; // 环境无 Web Locks（Node）：不加锁
  return new Promise((resolve) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve(() => release());
        return held; // 回调不返回，锁一直持有到 close
      })
      .catch(() => resolve(null));
  });
}

function assertSeqContinuity(tail: { seq: number }[], checkpointSeq: number): void {
  let expected = checkpointSeq + 1;
  for (const row of tail) {
    if (row.seq !== expected) {
      throw new Error(
        `工作区 journal 断档：期待 seq=${expected}，实得 ${row.seq}——存储可能损坏，` +
          `请用最近一次完整 checkpoint 恢复（快照永远是完整可用的兜底）`,
      );
    }
    expected += 1;
  }
}

export async function openWorkspace<TEntity, TDiff>(
  options: OpenWorkspaceOptions<TEntity, TDiff>,
): Promise<Workspace<TEntity, TDiff>> {
  const { store } = options;
  const warn = options.onWarn ?? ((msg: string) => console.warn(msg));
  const engineKind = options.engineKind ?? 'generic';
  const persist = options.persist ?? {};
  const journalOn = persist.journal !== false;
  const auditOn = persist.audit !== false;
  const everyTx = persist.checkpoint?.everyTx ?? 200;
  const keepTail = persist.checkpoint?.keepTail ?? 0;
  const isFactory = typeof options.engine === 'function';

  // ---- 锁（只读判定要先于一切写路径） ----
  let releaseLock: (() => void) | undefined;
  let readOnly = false;
  if (options.lock) {
    const acquired = await acquireLock(options.lock);
    if (acquired === null) {
      readOnly = true;
      warn(`工作区锁 "${options.lock}" 已被其他实例持有——本实例进入只读模式`);
    } else if (acquired) {
      releaseLock = acquired;
    }
  }

  // ---- 恢复：meta / 快照 / journal tail ----
  const meta = await store.getSnapshot<WorkspaceMeta>(META_KEY);
  if (meta) {
    if (meta.formatVersion !== 1) {
      throw new Error(
        `工作区格式版本不支持（存储为 v${String(meta.formatVersion)}，本运行时支持 v1）——请先迁移`,
      );
    }
    if (meta.engineKind !== engineKind) {
      throw new Error(
        `工作区引擎类型不匹配：存储为 "${meta.engineKind}"，本次打开为 "${engineKind}"`,
      );
    }
  }

  let engine: StateEngine<TEntity, TDiff>;
  let restored: RestoreInfo = { fromSnapshot: false, replayed: 0 };
  let checkpointSeqBase = meta?.checkpointSeq ?? 0;

  if (isFactory) {
    const factory = options.engine as EngineFactory<TEntity, TDiff>;
    const snapshotSeed = meta
      ? await store.getSnapshot<TEntity[]>(ENTITIES_KEY)
      : undefined;
    engine = factory(snapshotSeed ?? options.seed);
    restored = { fromSnapshot: snapshotSeed !== undefined, replayed: 0 };
  } else {
    engine = options.engine as StateEngine<TEntity, TDiff>;
    if (meta || (await store.read(JOURNAL_STREAM, { limit: 1 })).length > 0) {
      warn('workspace: 传入引擎实例已禁用恢复（纯录制模式）——store 中的既有历史被忽略');
    }
    checkpointSeqBase = await store.append(JOURNAL_STREAM, []); // 从当前位点续录
  }

  // ---- 组装 kernel（audit 中间件与只读守卫须在 createKernel 前就位） ----
  const guards: Middleware[] = [];
  if (readOnly) {
    guards.push(async (mctx, next) => {
      if (mctx.kind === 'read') return next();
      return {
        ok: false,
        capabilityId: mctx.capabilityId,
        error: {
          code: 'permission_denied',
          message: '工作区处于只读模式（写锁被其他实例持有），写/action 操作被拒绝',
        },
        durationMs: 0,
      };
    });
  }
  const audit =
    auditOn && !readOnly
      ? createAuditLog({ sink: { store, stream: AUDIT_STREAM } })
      : undefined;
  const auditRo = auditOn && readOnly ? createAuditLog() : undefined; // 只读实例审计留内存，不写共享流

  let checkpointImpl: () => Promise<{ checkpointSeq: number }> = async () => {
    throw new Error('workspace 尚未初始化完成');
  };
  const packs = [...(options.packs ?? [])];
  const services: Record<string, unknown> = { ...(options.services ?? {}) };
  if (options.runtimePack !== false) {
    packs.push(createRuntimePack<TEntity, TDiff>());
    services[CHECKPOINT_SERVICE_KEY] = {
      checkpoint: () => checkpointImpl(),
    };
  }

  const kernel = createKernel<TEntity, TDiff>({
    engine,
    algebra: options.algebra,
    packs,
    workflows: options.workflows,
    services,
    // 审计在最外层：只读守卫的拒绝也要入账
    middleware: [
      ...(audit ? [audit.middleware] : []),
      ...(auditRo ? [auditRo.middleware] : []),
      ...guards,
      ...(options.middleware ?? []),
    ],
    ownsEngine: isFactory, // 工厂建的引擎由 workspace 代管销毁
  });

  // ---- 重放 tail（先重放后开录；只读实例也重放——看得到现场，改不了） ----
  if (isFactory) {
    const tail = await store.read(JOURNAL_STREAM, { fromSeq: checkpointSeqBase + 1 });
    if (tail.length > 0) {
      assertSeqContinuity(tail, checkpointSeqBase);
      const res = replayJournal(
        kernel,
        tail.map((r) => r.record as JournalEntry<TDiff>),
      );
      if (!res.ok) {
        throw new Error(
          `工作区恢复失败（journal 重放第 ${res.applied + 1} 条中断）：${res.error}`,
        );
      }
      restored = { ...restored, replayed: res.applied };
    }
  }

  // ---- 开录 + 首次建 meta ----
  const journal =
    journalOn && !readOnly
      ? createJournal(kernel, { sink: { store, stream: JOURNAL_STREAM } })
      : undefined;
  // 开录基准：此刻 store 的 lastSeq——之后第 n 条内存条目的 store seq = base + n
  const journalBase = journalOn && !readOnly ? await store.append(JOURNAL_STREAM, []) : 0;
  if (!meta && !readOnly) {
    await store.putSnapshot(META_KEY, {
      formatVersion: 1,
      engineKind,
      checkpointSeq: checkpointSeqBase,
    } satisfies WorkspaceMeta);
  }

  // ---- checkpoint（串行化；同 tick 捕获快照与位点） ----
  let checkpointChain: Promise<unknown> = Promise.resolve();
  let closed = false;
  checkpointImpl = () => {
    if (readOnly) return Promise.reject(new Error('只读模式不可 checkpoint'));
    if (closed) return Promise.reject(new Error('workspace 已关闭'));
    const run = checkpointChain.then(async () => {
      // 同一 tick：实体快照与 journal 内存条目数一致（journal 在事务事件里同步入账）
      const entities = [...kernel.engine.snapshot().entities.values()];
      const checkpointSeq = journal
        ? journalBase + journal.size
        : await store.append(JOURNAL_STREAM, []);
      await journal?.flush();
      // 先写新快照与新 meta，成功后才截断——中途崩溃最多留下冗余 journal，不丢数据
      await store.putSnapshot(ENTITIES_KEY, entities);
      await store.putSnapshot(META_KEY, {
        formatVersion: 1,
        engineKind,
        checkpointSeq,
      } satisfies WorkspaceMeta);
      await store.truncate(JOURNAL_STREAM, checkpointSeq - keepTail);
      return { checkpointSeq };
    });
    checkpointChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ---- 自动 checkpoint（恢复重放之后才挂计数器） ----
  let txSinceCheckpoint = 0;
  let offAutoCheckpoint: (() => void) | undefined;
  if (journal && everyTx && everyTx > 0) {
    offAutoCheckpoint = kernel.events.on((e) => {
      if (e.type !== 'engine:transaction') return;
      txSinceCheckpoint += 1;
      if (txSinceCheckpoint >= everyTx) {
        txSinceCheckpoint = 0;
        checkpointImpl().catch((err) => warn(`自动 checkpoint 失败：${String(err)}`));
      }
    });
  }

  return {
    kernel,
    store,
    journal,
    audit: audit ?? auditRo,
    restored,
    readOnly,
    checkpoint: () => checkpointImpl(),
    async saveConversation(id, messages) {
      if (readOnly) throw new Error('只读模式不可保存对话');
      await store.putSnapshot(conversationKey(id), messages);
    },
    async loadConversation<T = unknown>(id: string) {
      return store.getSnapshot<T[]>(conversationKey(id));
    },
    async close() {
      if (closed) return;
      offAutoCheckpoint?.();
      if (!readOnly && journal && persist.checkpointOnClose !== false) {
        try {
          await checkpointImpl();
        } catch (err) {
          warn(`close 前 checkpoint 失败（journal 已保留，可恢复）：${String(err)}`);
        }
      }
      closed = true;
      journal?.stop();
      await journal?.flush();
      await audit?.flush();
      releaseLock?.();
      kernel.dispose(); // 工厂建的引擎在此销毁（ownsEngine）；实例引擎不动
      if (options.closeStore !== false) await store.close();
    },
  };
}
