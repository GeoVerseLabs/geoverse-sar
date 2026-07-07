/** 共享域装配：index（两面板）/ chat / agent 子页用同一套 seed 与 kernel 组装。 */
import { createKernel, type Middleware, type SarKernel } from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import {
  createHighlightAndNudgeWorkflow,
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
  type ViewService,
} from '@geoverse-sar/capabilities-records';

export type { RecordDiff, RecordEntity };

export const SEED: RecordEntity[] = [
  { id: 'poi-1', x: 60, y: 80, props: { type: 'poi', name: '仓库A' } },
  { id: 'poi-2', x: 180, y: 140, props: { type: 'poi', name: '仓库B' } },
  { id: 'poi-3', x: 300, y: 90, props: { type: 'poi', name: '仓库C' } },
  { id: 'road-1', x: 120, y: 260, props: { type: 'road', name: '干道1' } },
  { id: 'road-2', x: 260, y: 320, props: { type: 'road', name: '干道2' } },
];

export interface Domain {
  kernel: SarKernel<RecordEntity, RecordDiff>;
  engine: InMemoryStateEngine;
  view: ViewService;
}

export function buildDomain(opts: { middleware?: Middleware[] } = {}): Domain {
  const engine = new InMemoryStateEngine(SEED);
  const view = createMemoryViewService();
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: view },
    middleware: opts.middleware,
  });
  return { kernel, engine, view };
}

/** canvas 渲染（两页面共用）。 */
export function renderDomain(
  canvas: HTMLCanvasElement,
  engine: InMemoryStateEngine,
  view: ViewService,
): void {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1a2233';
  for (let i = 0; i <= canvas.width; i += 40) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(canvas.width, i);
    ctx.stroke();
  }
  const focused = new Set(view.current()?.focusedIds ?? []);
  for (const r of engine.snapshot().entities.values()) {
    const highlighted = r.props.highlighted === true;
    ctx.beginPath();
    ctx.arc(r.x, r.y, highlighted ? 9 : 6, 0, Math.PI * 2);
    ctx.fillStyle = highlighted ? '#ffb84d' : r.props.type === 'poi' ? '#5aa7ff' : '#67d98b';
    ctx.fill();
    if (focused.has(r.id)) {
      ctx.beginPath();
      ctx.arc(r.x, r.y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = '#ff5aa7';
      ctx.stroke();
    }
    ctx.fillStyle = '#8fa1bd';
    ctx.font = '11px Consolas';
    ctx.fillText(r.id, r.x + 12, r.y + 4);
  }
  const c = view.current()?.center;
  if (c) {
    ctx.strokeStyle = '#ff5aa7';
    ctx.beginPath();
    ctx.moveTo(c.x - 8, c.y);
    ctx.lineTo(c.x + 8, c.y);
    ctx.moveTo(c.x, c.y - 8);
    ctx.lineTo(c.x, c.y + 8);
    ctx.stroke();
  }
}
