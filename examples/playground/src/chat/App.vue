<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import type { ChatItem, PlannerMessage } from '@geoverse-sar/planner';
import { renderDomain, type WorkspaceDomain } from '../domain';
import { createDeepSeekChat, SYSTEM_PROMPT } from './llm';

// T6b：装配移到 main.ts 顶层 await（工作区恢复先于挂载），本组件吃 props
const props = defineProps<{
  domain: WorkspaceDomain;
  items: ChatItem[];
  history: PlannerMessage[];
}>();
const { kernel, engine, view, ws } = props.domain;
const { controller, planner } = createDeepSeekChat(kernel, SYSTEM_PROMPT, {
  items: props.items,
  history: props.history,
});

const GREETING: ChatItem = {
  role: 'assistant',
  text: '你好！我是 SAR 空间数据助手。试试："现在有哪些 poi？"、"把所有 poi 高亮并右移 15"、"撤销刚才的操作"。',
};

const bubbles = ref<ChatItem[]>([GREETING]);
const input = ref('');
const busy = ref(false);
const undoDepth = ref(0);
const listEl = ref<HTMLElement>();
const canvasEl = ref<HTMLCanvasElement>();
const wsStatus = ws.readOnly
  ? '🔒 只读（另一标签页持有写锁）'
  : `💾 已持久 · 恢复 ${props.items.length} 条消息${ws.restored.fromSnapshot ? '（快照）' : ''}${ws.restored.replayed ? ` + 重放 ${ws.restored.replayed} 事务` : ''}`;

const QUICK = [
  '现在有哪些 type 为 poi 的记录？',
  '把所有 poi 高亮并整体右移 15，一次调用完成',
  '撤销刚才的操作',
];

function repaint(): void {
  if (canvasEl.value) renderDomain(canvasEl.value, engine, view);
  undoDepth.value = engine.undoDepth;
}

async function scrollToEnd(): Promise<void> {
  await nextTick();
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
}

// 无头控制器 → Vue：时间线（含流式增量）浅拷贝进 ref 触发响应
controller.subscribe((s) => {
  bubbles.value = [GREETING, ...s.items.map((i) => ({ ...i }))];
  busy.value = s.busy;
  repaint();
  void scrollToEnd();
  // T6b：run 落定即存对话快照（items=展示面、history=模型上下文；只读模式不写）
  if (!s.busy && !ws.readOnly) {
    void ws.saveConversation('chat-items', s.items.map((i) => ({ ...i })));
    void ws.saveConversation('chat-history', [...planner.history]);
  }
});

function clearConversation(): void {
  controller.clear();
  if (!ws.readOnly) {
    void ws.saveConversation('chat-items', []);
    void ws.saveConversation('chat-history', []);
  }
}

async function send(text?: string): Promise<void> {
  const question = (text ?? input.value).trim();
  if (!question || busy.value) return;
  input.value = '';
  await controller.send(question);
}

function undo(): void {
  engine.undo();
  repaint();
}
function redo(): void {
  engine.redo();
  repaint();
}

onMounted(() => {
  kernel.events.on(() => repaint());
  view.onChange(() => repaint());
  repaint();
});
</script>

<template>
  <div class="chat-layout">
    <section class="panel chat-panel">
      <h2>
        💬 AI Chat（DeepSeek · entry: ai）
        <span class="ws-status">{{ wsStatus }}</span>
        <button class="clear-btn" title="清空时间线与会话历史（含快照）" @click="clearConversation">🗑 清空对话</button>
      </h2>
      <div ref="listEl" class="messages">
        <div v-for="(b, i) in bubbles" :key="i" class="bubble" :class="[b.role, { err: b.isError }]">
          <div class="text">{{ b.text }}<span v-if="b.streaming" class="cursor">▌</span></div>
          <details v-if="b.detail" class="detail">
            <summary>载荷</summary>
            <pre>{{ b.detail }}</pre>
          </details>
        </div>
        <div v-if="busy && !bubbles.at(-1)?.streaming" class="bubble assistant"><div class="text">思考中…</div></div>
      </div>
      <div class="quick">
        <button v-for="q in QUICK" :key="q" :disabled="busy" @click="send(q)">{{ q }}</button>
      </div>
      <form class="composer" @submit.prevent="send()">
        <input v-model="input" :disabled="busy" placeholder="用自然语言操作空间数据…" />
        <button v-if="busy" type="button" @click="controller.abort()">中止</button>
        <button v-else type="submit" :disabled="!input.trim()">发送</button>
      </form>
    </section>
    <section class="panel state-panel">
      <h2>🗺️ 共享状态（同一 Runtime）</h2>
      <canvas ref="canvasEl" width="420" height="420"></canvas>
      <div class="toolbar">
        <button @click="undo">⟲ 撤销</button>
        <button @click="redo">⟳ 重做</button>
        <span class="depth">undoDepth = {{ undoDepth }}</span>
      </div>
      <p class="hint">
        本页由 @geoverse-sar/planner 驱动（M3）：describeAll 投影能力目录 → LLM 流式补全 →
        tool call 回灌同一 invoke 漏斗——与<a href="/index.html">两面板页</a>的 UI 入口完全平价。
        密钥由 vite dev 代理注入，不在前端。
      </p>
    </section>
  </div>
</template>

<style scoped>
.chat-layout {
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
  gap: 8px;
}
.ws-status {
  font: 11px Consolas, monospace;
  color: #7f8ca3;
  font-weight: normal;
  flex: 1;
}
.clear-btn {
  font-size: 11px;
  padding: 2px 6px;
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
  max-width: 86%;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble.user {
  align-self: flex-end;
  background: #22304a;
}
.bubble.assistant {
  align-self: flex-start;
  background: #1d2534;
  border: 1px solid #2a3346;
}
.bubble.tool {
  align-self: flex-start;
  background: #101722;
  border: 1px dashed #2a3346;
  color: #8fa1bd;
  font-family: Consolas, monospace;
  font-size: 12px;
}
.bubble.tool.err {
  border-color: #a04455;
  color: #ff9aa8;
}
.bubble.error {
  align-self: center;
  background: #3a1c24;
  color: #ff9aa8;
}
.cursor {
  animation: blink 1s steps(1) infinite;
  color: #5aa7ff;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
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
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.depth {
  font: 12px Consolas, monospace;
  color: #8fa1bd;
}
.hint {
  font-size: 12px;
  color: #7f8ca3;
  line-height: 1.6;
  margin: 0;
}
.hint a {
  color: #5aa7ff;
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
