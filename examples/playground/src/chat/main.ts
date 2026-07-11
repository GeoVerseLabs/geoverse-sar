/**
 * T6b：chat 页工作区化——顶层 await 异步装配（恢复须先于 UI 挂载），
 * 避免 <script setup> 顶层同步限制（无需 Suspense）。
 * 对话恢复：items（时间线展示面）+ history（模型上下文）两份快照配对。
 */
import { createApp } from 'vue';
import type { ChatItem, PlannerMessage } from '@geoverse-sar/planner';
import { buildWorkspaceDomain } from '../domain';
import App from './App.vue';

const domain = await buildWorkspaceDomain({ name: 'sar-playground-chat' });
const items = (await domain.ws.loadConversation<ChatItem>('chat-items')) ?? [];
const history = (await domain.ws.loadConversation<PlannerMessage>('chat-history')) ?? [];

createApp(App, { domain, items, history }).mount('#app');
