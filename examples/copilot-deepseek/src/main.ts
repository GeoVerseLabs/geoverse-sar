/**
 * SAR × 真实 LLM（DeepSeek）演示：AI Copilot 作为同一 Runtime 的一个入口。
 * 模型经 OpenAI 兼容 tool-use 循环调用内核能力（toToolSpecs 投影 + handleToolCall 回灌）。
 *
 *   pnpm --filter @geoverse-sar/copilot-deepseek demo   # 脚本化实测（带断言）
 *   pnpm --filter @geoverse-sar/copilot-deepseek chat   # 交互 REPL
 */
import { createInterface } from 'node:readline/promises';
import { createKernel, type SarKernel } from '@geoverse-sar/kernel';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import {
  createHighlightAndNudgeWorkflow,
  createMemoryViewService,
  createRecordsPack,
  VIEW_SERVICE_KEY,
} from '@geoverse-sar/capabilities-records';
import { DeepSeekClient, type ChatMessage } from './deepseek';
import { executeToolCall, toOpenAiTools } from './adapter';
import { loadEnv } from './env';

// ---- 装配（与 playground 同一域）----

const seed: RecordEntity[] = [
  { id: 'poi-1', x: 60, y: 80, props: { type: 'poi', name: '仓库A' } },
  { id: 'poi-2', x: 180, y: 140, props: { type: 'poi', name: '仓库B' } },
  { id: 'poi-3', x: 300, y: 90, props: { type: 'poi', name: '仓库C' } },
  { id: 'road-1', x: 120, y: 260, props: { type: 'road', name: '干道1' } },
];

function buildKernel(): { kernel: SarKernel<RecordEntity, RecordDiff>; engine: InMemoryStateEngine } {
  const engine = new InMemoryStateEngine(seed);
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
  });
  kernel.events.on((e) => {
    if (e.type === 'invoke:end') {
      console.log(`    ⛁ ${e.ok ? '✔' : '✘'} ${e.capabilityId} (${e.durationMs}ms, entry=${e.caller.entry})`);
    }
  });
  return { kernel, engine };
}

const SYSTEM_PROMPT = [
  '你是 GeoVerse SAR 运行时的空间数据助手，管理一批平面点记录（字段：id、x、y、props）。',
  '你只能通过提供的工具读写数据：先用 records__query 查看，再做写操作；写操作可用 history__undo 撤销。',
  '多步组合操作优先用 workflow__highlightAndNudge（一次调用完成查询→聚焦→高亮→平移，且整体只占一个撤销单元）。',
  '回答用简体中文，简短说明你调用了什么工具、结果如何。',
].join('\n');

// ---- tool-use 循环 ----

async function runTurn(
  client: DeepSeekClient,
  kernel: SarKernel<RecordEntity, RecordDiff>,
  messages: ChatMessage[],
  userText: string,
): Promise<string> {
  const tools = toOpenAiTools(kernel);
  messages.push({ role: 'user', content: userText });

  for (let i = 0; i < 8; i++) {
    const { message } = await client.chat(messages, tools);
    messages.push(message);
    if (!message.tool_calls?.length) {
      return message.content ?? '';
    }
    for (const call of message.tool_calls) {
      console.log(`  → tool_call ${call.function.name} ${call.function.arguments}`);
      const result = await executeToolCall(kernel, call);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.is_error ? `ERROR: ${result.content}` : result.content,
      });
    }
  }
  return '（达到最大工具调用轮数）';
}

function dumpState(engine: InMemoryStateEngine): void {
  for (const r of engine.snapshot().entities.values()) {
    console.log(
      `    ${r.id}: (${r.x}, ${r.y}) ${JSON.stringify(r.props)}`,
    );
  }
  console.log(`    undoDepth=${engine.undoDepth}`);
}

// ---- demo：脚本化实测（带断言，可作回归）----

async function demo(client: DeepSeekClient): Promise<void> {
  const { kernel, engine } = buildKernel();
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  let failed = 0;
  const check = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
    if (!cond) failed++;
  };

  console.log(`\n=== 演示 1：只读查询（模型自行选择 records__query）===`);
  const a1 = await runTurn(client, kernel, messages, '现在有多少条 type 为 poi 的记录？分别叫什么名字？');
  console.log(`  🤖 ${a1}`);
  check(engine.undoDepth === 0, '只读回合不产生撤销单元');
  check(/3|三/.test(a1) && a1.includes('仓库'), '答案包含正确数量与名称');

  console.log(`\n=== 演示 2：多步工作流（一次调用 + 宏撤销）===`);
  const a2 = await runTurn(
    client,
    kernel,
    messages,
    '把所有 type 为 poi 的记录打上高亮并整体向右平移 15，请用一次工具调用完成。',
  );
  console.log(`  🤖 ${a2}`);
  const p1 = engine.snapshot().entities.get('poi-1')!;
  check(p1.x === 75 && p1.props.highlighted === true, 'poi-1 已右移 15 且高亮');
  check(engine.undoDepth === 1, '宏撤销折叠：整条工作流一个撤销单元');
  console.log('  当前状态：');
  dumpState(engine);

  console.log(`\n=== 演示 3：出错自纠（引用不存在的记录 → is_error 回灌）===`);
  const a3 = await runTurn(
    client,
    kernel,
    messages,
    '把 id 为 ghost-99 的记录向上移动 10；如果它不存在，直接告诉我，不要做别的修改。',
  );
  console.log(`  🤖 ${a3}`);
  check(engine.undoDepth === 1, '失败操作零污染（撤销栈未变）');

  console.log(`\n=== 演示 4：撤销（history__undo 作为能力）===`);
  const a4 = await runTurn(client, kernel, messages, '撤销刚才的高亮和平移。');
  console.log(`  🤖 ${a4}`);
  const p1b = engine.snapshot().entities.get('poi-1')!;
  check(
    p1b.x === 60 && p1b.props.highlighted === undefined,
    '一次 undo 全回退（位置 + 高亮）',
  );
  console.log('  回退后状态：');
  dumpState(engine);

  console.log(
    failed === 0
      ? '\n🎉 真实 LLM 实测全部断言通过：DeepSeek 经同一 Runtime 漏斗完成查询/工作流/自纠/撤销'
      : `\n⚠ ${failed} 项断言未过（LLM 行为非确定，可重跑；断言失败不代表内核缺陷）`,
  );
  if (failed > 0) process.exitCode = 1;
}

// ---- 交互 REPL ----

async function repl(client: DeepSeekClient): Promise<void> {
  const { kernel, engine } = buildKernel();
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('SAR × DeepSeek Copilot（输入 /state 看状态，/quit 退出）\n');
  for (;;) {
    const line = (await rl.question('你> ')).trim();
    if (!line) continue;
    if (line === '/quit') break;
    if (line === '/state') {
      dumpState(engine);
      continue;
    }
    const answer = await runTurn(client, kernel, messages, line);
    console.log(`🤖 ${answer}\n`);
  }
  rl.close();
}

// ---- 入口 ----

const apiKey = loadEnv('DEEPSEEK_API_KEY');
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY：请设置环境变量或在仓根创建 .env（见 .env.example）');
  process.exit(1);
}
const client = new DeepSeekClient({ apiKey, model: loadEnv('DEEPSEEK_MODEL') ?? 'deepseek-chat' });
console.log(`模型: ${client.model} · 能力目录: 9 项（含工作流即工具）`);

if (process.argv.includes('--demo')) {
  await demo(client);
} else {
  await repl(client);
}
