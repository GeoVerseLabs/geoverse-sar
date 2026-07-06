/**
 * SAR M1 Playground：一个内存 records 域 + 两个入口并排。
 * 左：命令面板（UI 入口，toPaletteItems 驱动表单）；
 * 右：Copilot 面板（AI 入口，toToolSpecs / handleToolCall）；
 * 中：共享引擎状态渲染 + 统一事件流（人机同栈观测）。
 */
import { createKernel, type PaletteItem, type SarEvent } from '@geoverse-sar/kernel';
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
} from '@geoverse-sar/capabilities-records';
import { handleToolCall, toToolSpecs, type ToolSpec } from '@geoverse-sar/skill';

// ---- 装配（客人式：宿主先建引擎，再建 kernel）----

const seed: RecordEntity[] = [
  { id: 'poi-1', x: 60, y: 80, props: { type: 'poi', name: '仓库A' } },
  { id: 'poi-2', x: 180, y: 140, props: { type: 'poi', name: '仓库B' } },
  { id: 'poi-3', x: 300, y: 90, props: { type: 'poi', name: '仓库C' } },
  { id: 'road-1', x: 120, y: 260, props: { type: 'road', name: '干道1' } },
  { id: 'road-2', x: 260, y: 320, props: { type: 'road', name: '干道2' } },
];

const engine = new InMemoryStateEngine(seed);
const view = createMemoryViewService();
const kernel = createKernel<RecordEntity, RecordDiff>({
  engine,
  algebra: new RecordDiffAlgebra(),
  packs: [createRecordsPack()],
  workflows: [createHighlightAndNudgeWorkflow()],
  services: { [VIEW_SERVICE_KEY]: view },
});

// ---- 每能力示例入参（表单占位；同一份服务两面板）----

const EXAMPLES: Record<string, unknown> = {
  'records.query': { propsEquals: { type: 'poi' } },
  'records.add': { records: [{ x: 200, y: 200, props: { type: 'poi', name: '新点' } }] },
  'records.translate': { ids: ['poi-1'], dx: 20, dy: 10 },
  'records.setProps': { ids: ['poi-1'], props: { highlighted: true } },
  'records.remove': { ids: ['poi-1'] },
  'history.undo': {},
  'history.redo': {},
  'view.focus': { ids: ['poi-1', 'poi-2'] },
  'workflow.highlightAndNudge': { propsEquals: { type: 'poi' }, dx: 15, dy: 0 },
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---- 画布渲染 ----

const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;

function render(): void {
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
    ctx.fillText(`${r.id}`, r.x + 12, r.y + 4);
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

// ---- 统一事件流 ----

const logEl = $<HTMLPreElement>('event-log');
function logEvent(e: SarEvent<RecordDiff>): void {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  let line = '';
  switch (e.type) {
    case 'invoke:start':
      line = `[${t}] ▶ ${e.capabilityId} (entry=${e.caller.entry}${e.dryRun ? ', dryRun' : ''})`;
      break;
    case 'invoke:end':
      line = `[${t}] ${e.ok ? '✔' : '✘'} ${e.capabilityId} ${e.durationMs}ms${e.errorCode ? ` [${e.errorCode}]` : ''}`;
      break;
    case 'engine:transaction':
      line = `[${t}] ⛁ ${e.origin} ${e.label ?? ''} (+${e.diff.added.length} -${e.diff.removed.length} ~${e.diff.modified.length})`;
      break;
    case 'workflow:start':
      line = `[${t}] ⚙ 工作流开始 ${e.workflowId}`;
      break;
    case 'workflow:end':
      line = `[${t}] ⚙ 工作流${e.ok ? '完成' : `失败于 ${e.failedStepId ?? '?'}`} ${e.workflowId}`;
      break;
  }
  logEl.textContent = `${line}\n${logEl.textContent ?? ''}`.slice(0, 8000);
  render();
}
kernel.events.on(logEvent);
view.onChange(() => render());

// ---- 命令面板（UI 入口）----

const paletteSelect = $<HTMLSelectElement>('palette-select');
const paletteDesc = $<HTMLParagraphElement>('palette-desc');
const paletteInput = $<HTMLTextAreaElement>('palette-input');
const paletteOut = $<HTMLPreElement>('palette-out');
let paletteItems: PaletteItem[] = [];

function refreshPalette(): void {
  paletteItems = kernel.toPaletteItems();
  paletteSelect.innerHTML = '';
  for (const item of paletteItems) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = `${item.title}  ·  ${item.id}  [${item.kind}]`;
    paletteSelect.appendChild(opt);
  }
  syncPaletteDetail();
}
function syncPaletteDetail(): void {
  const item = paletteItems.find((i) => i.id === paletteSelect.value);
  if (!item) return;
  paletteDesc.textContent = item.description;
  paletteInput.value = JSON.stringify(EXAMPLES[item.id] ?? {}, null, 2);
}
paletteSelect.addEventListener('change', syncPaletteDetail);

$<HTMLButtonElement>('palette-run').addEventListener('click', () => {
  void (async () => {
    try {
      const input = JSON.parse(paletteInput.value || '{}');
      const outcome = await kernel.invoke(paletteSelect.value, input, {
        caller: { entry: 'ui' },
        dryRun: $<HTMLInputElement>('chk-dryrun').checked,
      });
      paletteOut.textContent = JSON.stringify(outcome, null, 2);
    } catch (e) {
      paletteOut.textContent = `入参不是合法 JSON: ${String(e)}`;
    }
    render();
  })();
});

// ---- Copilot 面板（AI 入口）----

const toolSelect = $<HTMLSelectElement>('tool-select');
const toolDesc = $<HTMLParagraphElement>('tool-desc');
const toolInput = $<HTMLTextAreaElement>('tool-input');
const toolOut = $<HTMLPreElement>('tool-out');
let toolSpecs: ToolSpec[] = [];

function refreshTools(): void {
  toolSpecs = toToolSpecs(kernel);
  toolSelect.innerHTML = '';
  for (const spec of toolSpecs) {
    const opt = document.createElement('option');
    opt.value = spec.name;
    opt.textContent = spec.name;
    toolSelect.appendChild(opt);
  }
  syncToolDetail();
}
function syncToolDetail(): void {
  const spec = toolSpecs.find((s) => s.name === toolSelect.value);
  if (!spec) return;
  toolDesc.textContent = spec.description;
  const id = spec.name.replace(/__/g, '.');
  toolInput.value = JSON.stringify(EXAMPLES[id] ?? {}, null, 2);
}
toolSelect.addEventListener('change', syncToolDetail);

$<HTMLButtonElement>('tool-run').addEventListener('click', () => {
  void (async () => {
    try {
      const args = JSON.parse(toolInput.value || '{}');
      const res = await handleToolCall(kernel, toolSelect.value, args, {
        dryRun: $<HTMLInputElement>('chk-dryrun').checked,
      });
      toolOut.textContent = `tool_result${res.is_error ? '（is_error）' : ''}:\n${res.content}\n\noutcome:\n${JSON.stringify(res.outcome, null, 2)}`;
    } catch (e) {
      toolOut.textContent = `入参不是合法 JSON: ${String(e)}`;
    }
    render();
  })();
});

// 演示脚本：模拟一次 Copilot tool-use——先看(query) → 一次调用跑工作流 → 展示宏撤销
$<HTMLButtonElement>('tool-demo').addEventListener('click', () => {
  void (async () => {
    const lines: string[] = [];
    const step = async (name: string, args: unknown) => {
      const res = await handleToolCall(kernel, name, args);
      lines.push(`> ${name} ${JSON.stringify(args)}`);
      lines.push(`  ${res.is_error ? '✘' : '✔'} ${res.content}`);
      toolOut.textContent = lines.join('\n');
      return res;
    };
    await step('records__query', { propsEquals: { type: 'poi' } });
    await step('workflow__highlightAndNudge', { propsEquals: { type: 'poi' }, dx: 15, dy: 0 });
    lines.push(`  （undoDepth=${engine.undoDepth}：整条工作流一个撤销单元，点「撤销」一键全回退）`);
    toolOut.textContent = lines.join('\n');
    render();
  })();
});

// ---- 工具栏 ----

$<HTMLButtonElement>('btn-undo').addEventListener('click', () => {
  engine.undo();
  render();
});
$<HTMLButtonElement>('btn-redo').addEventListener('click', () => {
  engine.redo();
  render();
});

refreshPalette();
refreshTools();
render();
