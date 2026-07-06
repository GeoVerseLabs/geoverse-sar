/**
 * SAR Playground 主页：一个内存 records 域 + 两个入口并排。
 * 左：命令面板（UI 入口，toPaletteItems 驱动表单）；
 * 右：Copilot 面板（AI 入口，toToolSpecs / handleToolCall，手动 tool call）；
 * 中：共享引擎状态渲染 + 统一事件流（人机同栈观测）。
 * 真实 LLM 对话见 /chat.html（同一 Runtime，DeepSeek 经 dev 代理）。
 */
import type { PaletteItem, SarEvent } from '@geoverse-sar/kernel';
import { handleToolCall, toToolSpecs, type ToolSpec } from '@geoverse-sar/skill';
import { buildDomain, renderDomain, type RecordDiff } from './domain';

const { kernel, engine, view } = buildDomain();

// ---- 每能力示例入参（表单占位）----

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
const canvas = $<HTMLCanvasElement>('canvas');
const render = (): void => renderDomain(canvas, engine, view);

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

// ---- Copilot 面板（AI 入口，手动 tool call）----

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
