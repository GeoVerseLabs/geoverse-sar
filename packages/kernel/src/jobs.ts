/**
 * Job 模型（阶段四 U4-C，ADR-0017）：继 TransactionGroup 之后的第二个运行时抽象——
 * 分钟级异步工作（大批量 geoprocessing、外部长任务）塞不进同步 invoke，改为：
 * 宿主经 JobManager 启动作业立即拿 jobId；`jobs.list/status/cancel` 走目录查询与取消；
 * 事件流新增 `job:progress` 帧。
 *
 * **红线二（回漏斗纪律）**：JobManager **不持有引擎/dispatcher 引用**——作业闭包若要
 * 落地状态，必须经 SarClient.invoke 走单漏斗（可审计/可回放/过审批门），否则回放
 * 等价与审计完整性被击穿。这是结构性约束（manager 面上无处直改状态），测试钉死。
 */
import type { EventBus } from './eventbus';

export const JOBS_SERVICE_KEY = 'runtime.jobs';

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRecord {
  jobId: string;
  title: string;
  status: JobStatus;
  /** 0~100。 */
  progress: number;
  note?: string;
  /** 成功终局的产出（JSON 可序列化由作业作者保证）。 */
  result?: unknown;
  error?: string;
}

export interface JobContext {
  /** 取消信号：作业应协作检查；jobs.cancel / manager.cancel 触发。 */
  signal: AbortSignal;
  /** 进度上报（0~100 夹取）：每次上报发一帧 job:progress。 */
  progress(pct: number, note?: string): void;
}

export interface JobManager {
  /** 启动作业：立即返回 jobId，run 异步执行（终局同样发 job:progress 帧）。 */
  start(title: string, run: (ctx: JobContext) => Promise<unknown>): string;
  get(jobId: string): JobRecord | undefined;
  list(): JobRecord[];
  /** 协作取消：向作业发 abort；作业须自行尊重 signal。已终局的作业返回 false。 */
  cancel(jobId: string): boolean;
  /** 等待作业终局（测试/编排用）；未知 jobId 直接返回 undefined。 */
  settled(jobId: string): Promise<JobRecord | undefined>;
}

export function createJobManager(events?: Pick<EventBus, 'emit'>): JobManager {
  let seq = 0;
  const records = new Map<string, JobRecord>();
  const controllers = new Map<string, AbortController>();
  const settlers = new Map<string, Promise<void>>();

  const emit = (r: JobRecord): void => {
    events?.emit({
      type: 'job:progress',
      jobId: r.jobId,
      title: r.title,
      status: r.status,
      progress: r.progress,
      ...(r.note ? { note: r.note } : {}),
    });
  };

  return {
    start(title, run) {
      const jobId = `job_${++seq}`;
      const controller = new AbortController();
      const record: JobRecord = { jobId, title, status: 'running', progress: 0 };
      records.set(jobId, record);
      controllers.set(jobId, controller);
      emit(record);

      const ctx: JobContext = {
        signal: controller.signal,
        progress(pct, note) {
          if (record.status !== 'running') return;
          record.progress = Math.max(0, Math.min(100, pct));
          if (note !== undefined) record.note = note;
          emit(record);
        },
      };

      const done = run(ctx)
        .then((result) => {
          if (record.status !== 'running') return;
          record.status = 'succeeded';
          record.progress = 100;
          record.result = result;
          emit(record);
        })
        .catch((e) => {
          if (record.status !== 'running') return;
          record.status = controller.signal.aborted ? 'cancelled' : 'failed';
          record.error = e instanceof Error ? e.message : String(e);
          emit(record);
        });
      settlers.set(jobId, done);
      return jobId;
    },
    get(jobId) {
      const r = records.get(jobId);
      return r ? { ...r } : undefined;
    },
    list() {
      return [...records.values()].map((r) => ({ ...r }));
    },
    cancel(jobId) {
      const r = records.get(jobId);
      if (!r || r.status !== 'running') return false;
      controllers.get(jobId)?.abort();
      return true;
    },
    async settled(jobId) {
      await settlers.get(jobId);
      return this.get(jobId);
    },
  };
}
