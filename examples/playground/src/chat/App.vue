<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { buildDomain, renderDomain } from '../domain';
import { runTurn, SYSTEM_PROMPT, type ChatMessage, type TurnEvent } from './llm';

interface Bubble {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  detail?: string;
  isError?: boolean;
}

const { kernel, engine, view } = buildDomain();
const history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

const bubbles = ref<Bubble[]>([
  {
    role: 'assistant',
    text: '你好！我是 SAR 空间数据助手。试试："现在有哪些 poi？"、"把所有 poi 高亮并右移 15"、"撤销刚才的操作"。',
  },
]);
const input = ref('');
const busy = ref(false);
const undoDepth = ref(0);
const listEl = ref<HTMLElement>();
const canvasEl = ref<HTMLCanvasElement>();

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

async function send(text?: string): Promise<void> {
  const question = (text ?? input.value).trim();
  if (!question || busy.value) return;
  input.value = '';
  busy.value = true;
  bubbles.value.push({ role: 'user', text: question });
  await scrollToEnd();
  try {
    await runTurn(kernel, history, question, (e: TurnEvent) => {
      if (e.kind === 'tool_call') {
        bubbles.value.push({ role: 'tool', text: `→ ${e.name}`, detail: e.args });
      } else if (e.kind === 'tool_result') {
        bubbles.value.push({
          role: 'tool',
          text: `${e.isError ? '✘' : '✔'} ${e.name}`,
          detail: e.content,
          isError: e.isError,
        });
      } else {
        bubbles.value.push({ role: 'assistant', text: e.text });
      }
      repaint();
      void scrollToEnd();
    });
  } catch (err) {
    bubbles.value.push({ role: 'error', text: String(err instanceof Error ? err.message : err) });
  } finally {
    busy.value = false;
    repaint();
    await scrollToEnd();
  }
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
      <h2>💬 AI Chat（DeepSeek · entry: ai）</h2>
      <div ref="listEl" class="messages">
        <div v-for="(b, i) in bubbles" :key="i" class="bubble" :class="[b.role, { err: b.isError }]">
          <div class="text">{{ b.text }}</div>
          <details v-if="b.detail" class="detail">
            <summary>载荷</summary>
            <pre>{{ b.detail }}</pre>
          </details>
        </div>
        <div v-if="busy" class="bubble assistant"><div class="text">思考中…</div></div>
      </div>
      <div class="quick">
        <button v-for="q in QUICK" :key="q" :disabled="busy" @click="send(q)">{{ q }}</button>
      </div>
      <form class="composer" @submit.prevent="send()">
        <input v-model="input" :disabled="busy" placeholder="用自然语言操作空间数据…" />
        <button type="submit" :disabled="busy || !input.trim()">发送</button>
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
        模型经 toToolSpecs 看见能力目录，tool call 走 handleToolCall 回灌同一 invoke 漏斗——与
        <a href="/index.html">两面板页</a>的 UI 入口完全平价。密钥由 vite dev 代理注入，不在前端。
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
