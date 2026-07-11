/**
 * T6b：agent 页工作区化——顶层 await 异步装配 + createApprovalGate（F2）：
 * 审批请求先落 store 再等决策；上一会话崩溃遗留的 pending 在启动时读出交 UI 补决策。
 */
import { createApp } from 'vue';
import { createAuditLog } from '@geoverse-sar/kernel';
import { createApprovalGate } from '@geoverse-sar/workspace';
import { buildWorkspaceDomain } from '../domain';
import App from './App.vue';

const audit = createAuditLog({ maxEntries: 200 });
const domain = await buildWorkspaceDomain({
  name: 'sar-playground-agent',
  middleware: [audit.middleware],
});
const gate = createApprovalGate(domain.ws.store);
const leftover = await gate.pending(); // 上一会话遗留的待决审批

createApp(App, { domain, audit, gate, leftover }).mount('#app');
