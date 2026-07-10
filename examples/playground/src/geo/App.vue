<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import '@geoverse/core-ol/style.css';
import { GMap } from '@geoverse/core-ol';
import type { SarKernel } from '@geoverse-sar/kernel';
import { idbStore } from '@geoverse-sar/kernel/store-idb';
import { openWorkspace, type Workspace } from '@geoverse-sar/workspace';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  type ChangeSet,
  type EditableFeature,
  type GeoStateEngine,
} from '@geoverse-sar/engine-geo';
import {
  createGeoHighlightAndNudgeWorkflow,
  createGeoPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-geo';
import type { ChatController, ChatItem } from '@geoverse-sar/planner';
import { createDeepSeekChat } from '../chat/llm';
import { createFeatureSync, createGMapViewService } from './map-adapter';

const GEO_SYSTEM_PROMPT = [
  '你是 GeoVerse SAR 运行时的地图助手，管理一批 GeoJSON 要素（经纬度坐标，properties 携属性）。',
  '你只能通过提供的工具读写：先用 features__query 查看，再做写操作；写操作可用 history__undo 撤销。',
  '多步组合操作优先用 workflow__highlightAndNudge（一次调用完成查询→聚焦→高亮→平移，整体一个撤销单元）。',
  '画线/画面用 features__draw；切分（线打断/面按线切）用 features__split；合并（线相接/面并集）用 features__merge。',
  '几何变换：旋转 features__rotate（度，逆时针正）、缩放 features__scale、镜像 features__mirror；缓冲区 features__buffer（点→圆/线→走廊/面→外扩，米级距离用度换算约 0.00001/米）、线平行偏移 features__offset——buffer/offset 产出新要素，原要素保留。',
  '面洞操作：挖洞 features__punchHole（给洞外环顶点）、填洞 features__fillHole、开洞成湾 features__openHole（切割线从外边界进洞）、封湾成洞 features__closeHole（一键无参）。',
  '查询分析：features__query 支持 where 谓词（gt/lt/range/oneOf/contains，and/or 组合）；属性概览 props__schema、校验 features__validate；量算 measure__length/measure__area；空间关系 spatial__distance/spatial__nearest/spatial__within（中心点/bbox 级）。',
  '平移单位是经纬度（度）：市内挪动用 0.001~0.01 量级。视野可用 view__focus / view__zoom；底图可用 view__setBase 切换（gd-vec 矢量 / gd-sat 卫星影像等）。',
  '回答用简体中文，简短说明你调用了什么工具、结果如何。',
].join('\n');

// ---- 装配：真实 geoverse 引擎（editor-core）+ 真实 GMap 视野服务 ----

const pt = (id: string, lon: number, lat: number, props: Record<string, unknown>): EditableFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: props,
});

// 厦门左近（GMap 默认中心 [118.15, 24.56]，高德底图 GCJ:02）
const SEED: EditableFeature[] = [
  pt('wh-1', 118.11, 24.55, { type: 'warehouse', name: '仓库A' }),
  pt('wh-2', 118.15, 24.58, { type: 'warehouse', name: '仓库B' }),
  pt('wh-3', 118.19, 24.53, { type: 'warehouse', name: '仓库C' }),
  pt('shop-1', 118.13, 24.60, { type: 'shop', name: '门店甲' }),
];

const GREETING: ChatItem = {
  role: 'assistant',
  text: '这是真实 geoverse 地图（editor-core 引擎 + GMap 视野）。试试："有哪些 warehouse？"、"沿三个仓库画一条配送路线"、"切换到卫星影像底图"、"撤销"。',
};

const bubbles = ref<ChatItem[]>([GREETING]);
const input = ref('');
const busy = ref(false);
const undoDepth = ref(0);
const listEl = ref<HTMLElement>();

const QUICK = [
  '有哪些 type 为 warehouse 的要素？',
  '把所有 warehouse 高亮并向东移 0.01 度，一次调用完成',
  '沿三个仓库画一条配送路线（线要素，type 设为 route）',
  '切换到卫星影像底图',
  '撤销刚才的操作',
];

let kernel: SarKernel<EditableFeature, ChangeSet>;
let engine: GeoStateEngine;
let controller: ChatController | undefined;
let repaint: () => void = () => {};

// ---- 工作区（T4 openWorkspace）：恢复=快照+journal tail、checkpoint、双开只读 ----
const WORKSPACE_DB = 'sar-playground-geo';
const persist = ref('持久化初始化…');
let ws: Workspace<EditableFeature, ChangeSet> | undefined;

onMounted(async () => {
  const map = new GMap({ target: 'map', center: [118.15, 24.56], zoom: 12, scaleLine: true });
  const view = createGMapViewService(map);
  try {
    ws = await openWorkspace<EditableFeature, ChangeSet>({
      store: idbStore(WORKSPACE_DB),
      engine: (seed) => createGeoEngine({ features: seed ?? SEED }),
      algebra: new ChangeSetAlgebra(),
      packs: [createGeoPack()],
      workflows: [createGeoHighlightAndNudgeWorkflow()],
      services: { [VIEW_SERVICE_KEY]: view },
      engineKind: 'geo',
      lock: WORKSPACE_DB, // 双开同页：后来者只读
    });
  } catch (err) {
    console.error('[SAR] 工作区打开失败：', err);
    persist.value = `打开失败：${String(err)}`;
    return;
  }
  kernel = ws.kernel;
  engine = ws.kernel.engine as GeoStateEngine;
  const auditCount = (await ws.store.read('audit')).length;
  persist.value = ws.readOnly
    ? '🔒 只读（写锁被其他标签页持有）'
    : ws.restored.fromSnapshot || ws.restored.replayed > 0
      ? `已恢复（快照${ws.restored.fromSnapshot ? '✓' : '✗'} + 重放 ${ws.restored.replayed} 条）· 审计 ${auditCount} 条`
      : '新工作区（已持久）';
  const sync = createFeatureSync(map, engine, view);
  repaint = () => {
    sync.repaint();
    undoDepth.value = engine.undoDepth;
  };
  kernel.events.on(() => repaint());
  view.onChange(() => repaint());
  repaint();

  // 无头控制器（M3）：时间线/流式/中止全部由 planner 驱动
  controller = createDeepSeekChat(kernel, GEO_SYSTEM_PROMPT);
  controller.subscribe((s) => {
    bubbles.value = [GREETING, ...s.items.map((i) => ({ ...i }))];
    busy.value = s.busy;
    repaint();
    void scrollToEnd();
  });
});

async function scrollToEnd(): Promise<void> {
  await nextTick();
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
}

async function send(text?: string): Promise<void> {
  const question = (text ?? input.value).trim();
  if (!question || busy.value || !controller) return;
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

/** 保存进度（checkpoint）：落快照 + 截断已归档 journal——更早历史归档不可撤销。 */
async function saveCheckpoint(): Promise<void> {
  if (!ws || ws.readOnly) return;
  try {
    const { checkpointSeq } = await ws.checkpoint();
    persist.value = `💾 已存至位点 ${checkpointSeq}（更早历史已归档）`;
  } catch (err) {
    persist.value = `checkpoint 失败：${String(err)}`;
  }
}

/** 清空工作区：关闭工作区 → 删 IDB → 重载（回到种子态）。 */
async function resetWorkspace(): Promise<void> {
  await ws?.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(WORKSPACE_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  location.reload();
}
</script>

<template>
  <div class="geo-layout">
    <section class="panel chat-panel">
      <h2>💬 地图助手（DeepSeek · entry: ai）</h2>
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
        <input v-model="input" :disabled="busy" placeholder="用自然语言操作地图要素…" />
        <button v-if="busy" type="button" @click="controller?.abort()">中止</button>
        <button v-else type="submit" :disabled="!input.trim()">发送</button>
      </form>
    </section>
    <section class="panel map-panel">
      <h2>
        🗺️ geoverse 真地图（editor-core 引擎 + GMap 视野）
        <span class="toolbar-inline">
          <button @click="undo">⟲ 撤销</button>
          <button @click="redo">⟳ 重做</button>
          <span class="depth">undoDepth = {{ undoDepth }}</span>
          <span class="depth" :title="'工作区 IndexedDB: ' + WORKSPACE_DB">💾 {{ persist }}</span>
          <button title="checkpoint：落快照并归档更早日志" @click="saveCheckpoint">💾 保存进度</button>
          <button title="删除本地工作区数据并回到种子态" @click="resetWorkspace">🗑 清空工作区</button>
        </span>
      </h2>
      <div id="map"></div>
    </section>
  </div>
</template>

<style scoped>
.geo-layout {
  display: grid;
  grid-template-columns: 420px 1fr;
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
.toolbar-inline {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  font-weight: normal;
}
#map {
  flex: 1;
  border-radius: 6px;
  overflow: hidden;
  min-height: 0;
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
  max-width: 90%;
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
.depth {
  font: 12px Consolas, monospace;
  color: #8fa1bd;
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
