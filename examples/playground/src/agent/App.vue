<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { clientOf, type AuditEntry, type AuditLog } from '@geoverse-sar/kernel';
import type { ApprovalGate, PendingApproval } from '@geoverse-sar/workspace';
import { createOpenAiCompatClient } from '@geoverse-sar/planner';
import { createAgent, createLlmPolicy, type AgentEvent } from '@geoverse-sar/agent';
import { renderDomain, type WorkspaceDomain } from '../domain';

const AGENT_SYSTEM = [
  '领域：平面点记录（id、x、y、props），坐标是画布像素（0~420）。',
  '多步组合优先 workflow__highlightAndNudge；出错可用 history__undo 回退。',
].join('\n');

interface TraceItem {
  kind: 'observe' | 'decide' | 'act' | 'blocked' | 'end' | 'user' | 'error';
  text: string;
  detail?: string;
  isError?: boolean;
}

// T6b：装配移到 main.ts 顶层 await；审批门=createApprovalGate（pending 落 store，重启可恢复）
const props = defineProps<{
  domain: WorkspaceDomain;
  audit: AuditLog;
  gate: ApprovalGate;
  leftover: PendingApproval[];
}>();
const { kernel, engine, view, ws } = props.domain;
const { audit, gate } = props;

const client = createOpenAiCompatClient({
  url: '/api/deepseek/chat/completions',
  model: 'deepseek-chat',
});
// T12：agent 依赖 SarClient 切面——身份构造绑定；策略共用同一 client（看见的恰是能调的）
const sar = clientOf(kernel, { entry: 'agent', id: 'playground-agent' });
const agent = createAgent(sar, {
  policy: createLlmPolicy(sar, { client, system: AGENT_SYSTEM }),
  maxSteps: 6,
  // 审批门走持久化 gate：请求先落 store 再等决策——运转中崩溃/刷新，pending 下次启动仍在
  approve: (action, preview) => (autoApprove.value ? true : gate.approve(action, preview)),
});

// 待决审批卡片（含上一会话遗留）；gate.onRequest 推新请求进来
const pending = ref<PendingApproval[]>([...props.leftover]);
gate.onRequest((p) => {
  pending.value = [...pending.value, p];
});

/**
 * 决策：进行中的请求由 gate 的 deferred 放行/拦截（agent 循环继续跑）；
 * 上一会话遗留（无等待者）批准后按 T5 语义 continuation=凭记录重新 invoke。
 */
async function decide(p: PendingApproval, approved: boolean): Promise<void> {
  const isLeftover = props.leftover.some((l) => l.id === p.id);
  await gate.decide(p.id, approved);
  pending.value = pending.value.filter((x) => x.id !== p.id);
  if (approved && isLeftover) {
    const out = await sar.invoke(p.capabilityId, p.input);
    trace.value.push({
      kind: 'act',
      text: `${out.ok ? '✔' : '✘'} 遗留审批补执行：${p.capabilityId}`,
      detail: JSON.stringify(out.ok ? out.output : out.error, null, 2),
      isError: !out.ok,
    });
  } else if (!approved && isLeftover) {
    trace.value.push({ kind: 'blocked', text: `🚫 遗留审批已拒绝：${p.capabilityId}` });
  }
  repaint();
  void scrollToEnd();
}

const wsStatus = ws.readOnly
  ? '🔒 只读（另一标签页持有写锁）'
  : `💾 已持久${ws.restored.fromSnapshot ? ' · 快照恢复' : ''}${ws.restored.replayed ? ` · 重放 ${ws.restored.replayed} 事务` : ''}${props.leftover.length ? ` · 遗留审批 ${props.leftover.length} 条` : ''}`;

const goal = ref('');
const busy = ref(false);
const autoApprove = ref(true);
const trace = ref<TraceItem[]>([
  {
    kind: 'end',
    text: '给我一个目标，我会自主 observe→plan→act 完成它。试试："把所有 poi 高亮并整体右移 30"、"新增一个名为 仓库D 的 poi 然后聚焦它"。',
  },
]);
const auditRows = ref<AuditEntry[]>([]);
const undoDepth = ref(0);
const listEl = ref<HTMLElement>();
const canvasEl = ref<HTMLCanvasElement>();
let aborter: AbortController | undefined;

const QUICK = [
  '把所有 poi 高亮并整体右移 30',
  '新增一个名为 仓库D 的 poi（x=350, y=200）并聚焦它',
  '把干道1 和 干道2 删掉',
  '撤销全部改动，恢复原样',
];

function repaint(): void {
  if (canvasEl.value) renderDomain(canvasEl.value, engine, view);
  undoDepth.value = engine.undoDepth;
  auditRows.value = [...audit.entries()].reverse().slice(0, 12);
}

async function scrollToEnd(): Promise<void> {
  await nextTick();
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
}

function onAgentEvent(e: AgentEvent): void {
  if (e.type === 'observe') {
    trace.value.push({
      kind: 'observe',
      text: `👁 观察（第 ${e.step} 步）：${e.observation.entityCount} 个实体，undoDepth=${e.observation.undoDepth}`,
      detail: JSON.stringify(e.observation.lastResults, null, 2),
    });
  } else if (e.type === 'decide') {
    trace.value.push(
      e.decision.kind === 'done'
        ? { kind: 'decide', text: `🧠 决策：收束 — ${e.decision.summary}` }
        : {
            kind: 'decide',
            text: `🧠 决策：执行 ${e.decision.actions.map((a) => a.capabilityId).join('、')}`,
            detail: JSON.stringify(e.decision.actions, null, 2),
          },
    );
  } else if (e.type === 'act:result') {
    trace.value.push({
      kind: 'act',
      text: `${e.result.ok ? '✔' : e.result.blocked ? '🚫' : '✘'} ${e.result.capabilityId}`,
      detail: JSON.stringify(e.result.ok ? e.result.output : e.result.error, null, 2),
      isError: !e.result.ok && !e.result.blocked,
    });
  } else if (e.type === 'blocked') {
    trace.value.push({ kind: 'blocked', text: `🚫 审批门拦下：${e.action.capabilityId}（${e.reason}）` });
  } else if (e.type === 'end') {
    trace.value.push({
      kind: 'end',
      text: `🏁 结束（${e.stopReason}，${e.steps} 步）${e.summary ? `：${e.summary}` : ''}`,
      isError: !e.ok,
    });
  }
  repaint();
  void scrollToEnd();
}

async function run(text?: string): Promise<void> {
  const target = (text ?? goal.value).trim();
  if (!target || busy.value) return;
  goal.value = '';
  busy.value = true;
  aborter = new AbortController();
  trace.value.push({ kind: 'user', text: `🎯 ${target}` });
  await scrollToEnd();
  try {
    await agent.run(target, { signal: aborter.signal, onEvent: onAgentEvent });
  } catch (err) {
    trace.value.push({ kind: 'error', text: String(err instanceof Error ? err.message : err), isError: true });
  } finally {
    busy.value = false;
    aborter = undefined;
    repaint();
    await scrollToEnd();
  }
}

function abort(): void {
  aborter?.abort();
}

onMounted(() => {
  kernel.events.on(() => repaint());
  view.onChange(() => repaint());
  repaint();
});
</script>

<template>
  <div class="agent-layout">
    <section class="panel trace-panel">
      <h2>
        🤖 自治 Agent（entry: agent · DeepSeek 策略）
        <span class="ws-status">{{ wsStatus }}</span>
        <label class="approve-toggle">
          <input v-model="autoApprove" type="checkbox" />
          自动审批写操作
        </label>
      </h2>
      <div v-if="pending.length" class="approvals">
        <div v-for="p in pending" :key="p.id" class="approval-card">
          <div class="approval-head">
            ⏳ 待审批：<b>{{ p.capabilityId }}</b>
            <span class="approval-time">{{ p.requestedAt }}</span>
          </div>
          <details class="detail">
            <summary>dryRun diff 预览 / 入参</summary>
            <pre>{{ JSON.stringify({ input: p.input, diff: p.diff }, null, 2) }}</pre>
          </details>
          <div class="approval-actions">
            <button class="ok" @click="decide(p, true)">✅ 批准</button>
            <button class="no" @click="decide(p, false)">🚫 拒绝</button>
          </div>
        </div>
      </div>
      <div ref="listEl" class="messages">
        <div v-for="(t, i) in trace" :key="i" class="bubble" :class="[t.kind, { err: t.isError }]">
          <div class="text">{{ t.text }}</div>
          <details v-if="t.detail" class="detail">
            <summary>载荷</summary>
            <pre>{{ t.detail }}</pre>
          </details>
        </div>
        <div v-if="busy" class="bubble end"><div class="text">运转中…</div></div>
      </div>
      <div class="quick">
        <button v-for="q in QUICK" :key="q" :disabled="busy" @click="run(q)">{{ q }}</button>
      </div>
      <form class="composer" @submit.prevent="run()">
        <input v-model="goal" :disabled="busy" placeholder="给 Agent 一个目标…" />
        <button v-if="busy" type="button" @click="abort()">中止</button>
        <button v-else type="submit" :disabled="!goal.trim()">执行</button>
      </form>
    </section>
    <section class="panel state-panel">
      <h2>
        🗺️ 共享状态
        <span class="depth">undoDepth = {{ undoDepth }}</span>
      </h2>
      <canvas ref="canvasEl" width="420" height="420"></canvas>
      <h2>🧾 审计（同栈入账，最近 12 条）</h2>
      <div class="audit">
        <table>
          <thead>
            <tr><th>#</th><th>能力</th><th>入口</th><th>结果</th><th>ms</th></tr>
          </thead>
          <tbody>
            <tr v-for="a in auditRows" :key="a.seq" :class="{ bad: !a.ok }">
              <td>{{ a.seq }}</td>
              <td>{{ a.capabilityId }}{{ a.dryRun ? '（dryRun）' : '' }}</td>
              <td>{{ a.entry }}</td>
              <td>{{ a.ok ? '✔' : a.errorCode }}</td>
              <td>{{ a.durationMs }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="hint">
        治理三件套都在起作用：<b>审批门</b>（取消勾选后，写操作先 dryRun 出 diff 落 store 等你放行——
        运转中刷新/崩溃，待决审批下次启动仍在，批准即补执行）、
        <b>审计</b>（agent 与 dryRun 预览同栈入账）、<b>中止</b>（AbortSignal 贯穿 invoke，写路由前兜底）。
        实体状态经 openWorkspace 落 IndexedDB，刷新不丢。
      </p>
    </section>
  </div>
</template>

<style scoped>
.agent-layout {
  display: grid;
  grid-template-columns: 1fr 460px;
  gap: 12px;
  padding: 12px 16px;
  height: calc(100vh - 60px);
  box-sizing: border-box;
}
.panel {
  background: #171d29;
  border: 1px solid #2a3346;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
h2 {
  font-size: 14px;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.approve-toggle {
  font-weight: normal;
  font-size: 12px;
  color: #8fa1bd;
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.ws-status {
  font: 11px Consolas, monospace;
  color: #7f8ca3;
  font-weight: normal;
  flex: 1;
}
.approvals {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.approval-card {
  border: 1px solid #a08a44;
  background: #2a2412;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
}
.approval-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.approval-time {
  color: #7f8ca3;
  font-size: 11px;
  flex: 1;
  text-align: right;
}
.approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.approval-actions .ok {
  border-color: #3f7d4e;
}
.approval-actions .no {
  border-color: #a04455;
}
.messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
}
.bubble {
  max-width: 92%;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  background: #1d2534;
  border: 1px solid #2a3346;
  align-self: flex-start;
}
.bubble.user {
  align-self: flex-end;
  background: #22304a;
}
.bubble.observe,
.bubble.act {
  background: #101722;
  border-style: dashed;
  color: #8fa1bd;
  font-family: Consolas, monospace;
  font-size: 12px;
}
.bubble.blocked {
  border-color: #a08a44;
  color: #ffd97a;
}
.bubble.err {
  border-color: #a04455;
  color: #ff9aa8;
}
.detail summary {
  cursor: pointer;
  font-size: 11px;
  color: #5f6f8c;
}
.detail pre {
  margin: 4px 0 0;
  max-height: 140px;
  overflow: auto;
  font-size: 11px;
}
.quick {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.quick button {
  font-size: 12px;
  padding: 4px 8px;
}
.composer {
  display: flex;
  gap: 8px;
}
.composer input {
  flex: 1;
}
canvas {
  background: #0b0e14;
  border: 1px solid #222b3d;
  border-radius: 6px;
  width: 100%;
}
.audit {
  overflow-y: auto;
  max-height: 200px;
}
.audit table {
  width: 100%;
  border-collapse: collapse;
  font: 11px Consolas, monospace;
  color: #8fa1bd;
}
.audit th,
.audit td {
  border-bottom: 1px solid #222b3d;
  padding: 3px 6px;
  text-align: left;
}
.audit tr.bad td {
  color: #ff9aa8;
}
.depth {
  font: 12px Consolas, monospace;
  color: #8fa1bd;
  font-weight: normal;
}
.hint {
  font-size: 12px;
  color: #7f8ca3;
  line-height: 1.6;
  margin: 0;
}
input,
button {
  font: 13px/1.5 Consolas, monospace;
  background: #10141c;
  color: #dce3ee;
  border: 1px solid #2a3346;
  border-radius: 6px;
  padding: 6px 8px;
}
button {
  cursor: pointer;
  background: #22304a;
}
button:hover:not(:disabled) {
  background: #2c3d5e;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
