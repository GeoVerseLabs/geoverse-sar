/**
 * 远程模式页（T13/R7）：本页**不装配任何内核**——只有一个 createRemoteClient。
 * 目录/调用/事件全部来自远端工作区（examples/remote-server，端口 8130）；
 * 身份由服务端从 token 换算注入（换 token 重连即换目录与审计归因）。
 */
import {
  createRemoteClient,
  type RemoteSarClient,
} from '@geoverse-sar/kernel/client-remote';
import type { CapabilityDescriptor, SarEvent } from '@geoverse-sar/kernel';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusEl = $<HTMLSpanElement>('conn-status');
const urlEl = $<HTMLInputElement>('url');
const tokenEl = $<HTMLSelectElement>('token');
const capSelect = $<HTMLSelectElement>('cap-select');
const capDesc = $<HTMLParagraphElement>('cap-desc');
const capInput = $<HTMLTextAreaElement>('cap-input');
const dryRunEl = $<HTMLInputElement>('chk-dryrun');
const invokeBtn = $<HTMLButtonElement>('btn-invoke');
const outcomeEl = $<HTMLPreElement>('outcome');
const entitiesEl = $<HTMLPreElement>('entities');
const logEl = $<HTMLPreElement>('event-log');

const EXAMPLES: Record<string, unknown> = {
  'records.query': { propsEquals: { type: 'poi' } },
  'records.add': { records: [{ x: 200, y: 200, props: { type: 'poi', name: '新点' } }] },
  'records.translate': { ids: ['poi-1'], dx: 20, dy: 10 },
  'records.setProps': { ids: ['poi-1'], props: { highlighted: true } },
  'records.remove': { ids: ['poi-1'] },
  'history.undo': {},
  'history.redo': {},
  'runtime.stats': {},
  'workflow.highlightAndNudge': { propsEquals: { type: 'poi' }, dx: 15, dy: 0 },
};

let client: RemoteSarClient | undefined;
let catalog: CapabilityDescriptor[] = [];

function logLine(text: string): void {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logEl.textContent += `[${t}] ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function onEvent(e: SarEvent): void {
  if (e.type === 'invoke:start') {
    logLine(
      `▶ ${e.capabilityId} · entry=${e.caller.entry}${e.dryRun ? ' · dryRun' : ''}`,
    );
  } else if (e.type === 'invoke:end') {
    logLine(
      `${e.ok ? '✔' : '✘'} ${e.capabilityId} · ${e.durationMs}ms${e.errorCode ? ` · ${e.errorCode}` : ''}`,
    );
  } else if (e.type === 'engine:transaction') {
    logLine(`⚙ 事务 · ${e.label ?? e.origin}`);
    void refreshEntities();
  } else {
    logLine(`• ${e.type}`);
  }
}

async function refreshEntities(): Promise<void> {
  if (!client) return;
  const out = await client.invoke('records.query', {});
  if (out.ok) entitiesEl.textContent = JSON.stringify(out.output, null, 2);
}

function renderCatalog(): void {
  capSelect.innerHTML = '';
  for (const d of catalog) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.id} · ${d.title}（${d.kind}）`;
    capSelect.appendChild(opt);
  }
  capSelect.disabled = catalog.length === 0;
  invokeBtn.disabled = catalog.length === 0;
  syncSelected();
}

function syncSelected(): void {
  const d = catalog.find((c) => c.id === capSelect.value);
  capDesc.textContent = d?.description ?? '';
  capInput.value = JSON.stringify(EXAMPLES[capSelect.value] ?? {}, null, 2);
}
capSelect.addEventListener('change', syncSelected);

$<HTMLButtonElement>('btn-connect').addEventListener('click', () => {
  void (async () => {
    client?.close();
    logEl.textContent = '';
    outcomeEl.textContent = '';
    entitiesEl.textContent = '';
    statusEl.textContent = '连接中…';
    const c = createRemoteClient(urlEl.value.trim(), tokenEl.value, {
      onSocketDown: (reason) => {
        statusEl.textContent = `⚠ 事件流断开（${reason}）——服务未启动或 token 无效`;
      },
    });
    try {
      c.onEvent(onEvent);
      await c.eventsReady();
      catalog = await c.catalog();
      client = c;
      statusEl.textContent = `✅ 已连接 · ${catalog.length} 能力 · token=${tokenEl.value}`;
      renderCatalog();
      await refreshEntities();
    } catch (e) {
      c.close();
      statusEl.textContent = `❌ 连接失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  })();
});

invokeBtn.addEventListener('click', () => {
  void (async () => {
    if (!client) return;
    let input: unknown;
    try {
      input = capInput.value.trim() ? JSON.parse(capInput.value) : undefined;
    } catch {
      outcomeEl.textContent = '入参不是合法 JSON';
      return;
    }
    const out = await client.invoke(capSelect.value, input, {
      dryRun: dryRunEl.checked,
    });
    outcomeEl.textContent = JSON.stringify(out, null, 2);
  })();
});
