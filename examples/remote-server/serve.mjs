/**
 * SAR 远程工作区演示服务（T13/R7，目标架构 §3.4）。
 *
 * 先构建再启动（包间经 dist 解析）：
 *   pnpm build
 *   pnpm --filter @geoverse-sar-examples/remote-server start   # 或 pnpm playground:server
 *
 * 端口 8130，工作区 `main`（内存 records 域，带种子数据）。
 * token → CallerInfo 映射（身份在服务端注入，客户端无处伪造）：
 *   demo-ui → { entry: 'ui', id: 'remote-ui' }
 *   demo-ai → { entry: 'ai', id: 'remote-ai' }
 * playground /remote.html 用 createRemoteClient 连接本服务。
 */
import { createKernel, createRuntimePack } from '@geoverse-sar/kernel';
import { InMemoryStateEngine, RecordDiffAlgebra } from '@geoverse-sar/engine-memory';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import { createSarServer } from '@geoverse-sar/server';

const seed = [
  { id: 'poi-1', x: 120, y: 140, props: { type: 'poi', name: '灯塔' } },
  { id: 'poi-2', x: 260, y: 200, props: { type: 'poi', name: '码头' } },
  { id: 'poi-3', x: 180, y: 320, props: { type: 'depot', name: '仓库' } },
];

const kernel = createKernel({
  engine: new InMemoryStateEngine(seed),
  algebra: new RecordDiffAlgebra(),
  packs: [createRecordsPack(), createRuntimePack({ checkpoint: false })],
});

const server = createSarServer({
  workspaces: { main: kernel },
  tokens: {
    'demo-ui': { entry: 'ui', id: 'remote-ui' },
    'demo-ai': { entry: 'ai', id: 'remote-ai' },
  },
});

const { port } = await server.listen(8130);
console.log(`SAR 远程工作区已就绪: http://127.0.0.1:${port}/workspaces/main`);
console.log('tokens: demo-ui（UI 入口）/ demo-ai（AI 入口）');
console.log('playground: pnpm playground:dev 后打开 http://localhost:8090/remote.html');

process.on('SIGINT', async () => {
  await server.close();
  kernel.dispose();
  process.exit(0);
});
