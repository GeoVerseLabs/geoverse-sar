/**
 * DeepSeek × planner 组装（M3）：
 * NL→能力路由 / tool-use 循环 / 流式增量 / 时间线状态全部下沉进
 * `@geoverse-sar/planner`（createPlanner + createChatController）——本文件只剩装配。
 * 浏览器只打 dev 代理 `/api/deepseek/*`，Authorization 由 vite 代理注入（密钥不进前端）。
 */
import { clientOf, type SarKernel } from '@geoverse-sar/kernel';
import {
  createChatController,
  createOpenAiCompatClient,
  createPlanner,
  type ChatController,
} from '@geoverse-sar/planner';

export function createDeepSeekChat(kernel: SarKernel, system: string): ChatController {
  const client = createOpenAiCompatClient({
    url: '/api/deepseek/chat/completions',
    model: 'deepseek-chat',
  });
  // T12：planner 依赖 SarClient 切面——身份（entry='ai'）在此绑定，循环内无处伪造
  return createChatController(
    createPlanner(clientOf(kernel, { entry: 'ai' }), { client, system }),
  );
}

export const SYSTEM_PROMPT = [
  '你是 GeoVerse SAR 运行时的空间数据助手，管理一批平面点记录（字段：id、x、y、props）。',
  '你只能通过提供的工具读写数据：先用 records__query 查看，再做写操作；写操作可用 history__undo 撤销。',
  '多步组合操作优先用 workflow__highlightAndNudge（一次调用完成查询→聚焦→高亮→平移，且整体只占一个撤销单元）。',
  '回答用简体中文，简短说明你调用了什么工具、结果如何。',
].join('\n');
