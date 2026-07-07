import { describe, expect, it } from 'vitest';
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
import { createChatController, createPlanner } from '../src/index';
import type {
  AssistantTurn,
  LlmClient,
  LlmCompleteOptions,
  LlmRequest,
  PlannerEvent,
} from '../src/index';

const rec = (id: string, x: number, y: number, props: Record<string, unknown> = {}): RecordEntity => ({
  id,
  x,
  y,
  props,
});

function makeKernel(): { kernel: SarKernel<RecordEntity, RecordDiff>; engine: InMemoryStateEngine } {
  const engine = new InMemoryStateEngine([
    rec('p1', 0, 0, { type: 'poi' }),
    rec('p2', 10, 0, { type: 'poi' }),
  ]);
  const kernel = createKernel<RecordEntity, RecordDiff>({
    engine,
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
    workflows: [createHighlightAndNudgeWorkflow()],
    services: { [VIEW_SERVICE_KEY]: createMemoryViewService() },
  });
  return { kernel, engine };
}

/** 脚本化假 LLM：按序吐预设回合（LLM 非确定性被隔离在 LlmClient 端口之外）。 */
function scriptedClient(turns: AssistantTurn[]): LlmClient & { requests: LlmRequest[] } {
  let i = 0;
  const requests: LlmRequest[] = [];
  return {
    requests,
    async complete(req, opts?: LlmCompleteOptions) {
      requests.push(req);
      if (opts?.signal?.aborted) throw new Error('aborted');
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      if (turn.text && opts?.onTextDelta) {
        // 模拟流式：正文按两段吐
        const mid = Math.ceil(turn.text.length / 2);
        opts.onTextDelta(turn.text.slice(0, mid));
        opts.onTextDelta(turn.text.slice(mid));
      }
      return turn;
    },
  };
}

describe('createPlanner（NL→能力路由，内核 NL-free）', () => {
  it('工具调用回合→单一 invoke 漏斗真执行→末回合正文收束；事件按序流出', async () => {
    const { kernel, engine } = makeKernel();
    const client = scriptedClient([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'records__translate', arguments: '{"ids":["p1"],"dx":5,"dy":0}' },
        ],
      },
      { text: '已把 p1 向东移动 5。', toolCalls: [] },
    ]);
    const planner = createPlanner(kernel, { client });
    const events: PlannerEvent[] = [];
    const result = await planner.run('把 p1 向东挪 5', { onEvent: (e) => events.push(e) });

    expect(result).toMatchObject({
      ok: true,
      stopReason: 'completed',
      rounds: 2,
      toolCallCount: 1,
      text: '已把 p1 向东移动 5。',
    });
    // 路由真实生效：引擎状态已变、可撤销
    expect(engine.snapshot().entities.get('p1')!.x).toBe(5);
    expect(engine.undoDepth).toBe(1);

    // 目录 = describeAll 投影（9 能力）
    expect(client.requests[0].tools).toHaveLength(9);
    // 事件顺序：round:start → tool:call → tool:result → round:start → 流式增量 → assistant → run:end
    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual([
      'round:start',
      'tool:call',
      'tool:result',
      'round:start',
      'text:delta',
      'text:delta',
      'assistant',
      'run:end',
    ]);
    const call = events.find((e) => e.type === 'tool:call')!;
    expect(call).toMatchObject({ capabilityId: 'records.translate', args: { ids: ['p1'] } });
    // 流式增量拼起来 = 终稿
    const deltas = events.filter((e) => e.type === 'text:delta');
    expect(deltas.map((d) => (d as { delta: string }).delta).join('')).toBe('已把 p1 向东移动 5。');
  });

  it('失败工具结果以 ERROR + hint 回灌（模型自纠通道）；参数非法 JSON 不打崩 run', async () => {
    const { kernel } = makeKernel();
    const client = scriptedClient([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'records__nope', arguments: '{}' },
          { id: 'c2', name: 'records__translate', arguments: '{broken' },
        ],
      },
      { text: '两次调用都失败了。', toolCalls: [] },
    ]);
    const planner = createPlanner(kernel, { client });
    const events: PlannerEvent[] = [];
    const result = await planner.run('乱调一通', { onEvent: (e) => events.push(e) });

    expect(result.ok).toBe(true);
    const results = events.filter((e) => e.type === 'tool:result');
    expect(results).toHaveLength(2);
    expect(results.every((r) => (r as { ok: boolean }).ok === false)).toBe(true);
    // 未注册能力：explainError hint 已回灌（含相似建议的可操作提示）
    expect((results[0] as { content: string }).content).toContain('hint');
    // 历史里 tool 消息带 ERROR 前缀
    const toolMsgs = planner.history.filter((m) => m.role === 'tool');
    expect(toolMsgs.every((m) => m.content.startsWith('ERROR:'))).toBe(true);
  });

  it('maxRounds 用尽 → stopReason=max_rounds；abort → stopReason=aborted', async () => {
    const { kernel } = makeKernel();
    const looping = scriptedClient([
      { text: '', toolCalls: [{ id: 'c', name: 'records__query', arguments: '{}' }] },
    ]);
    const planner = createPlanner(kernel, { client: looping, maxRounds: 3 });
    const result = await planner.run('无限查询');
    expect(result).toMatchObject({ ok: false, stopReason: 'max_rounds', rounds: 3, toolCallCount: 3 });

    const aborter = new AbortController();
    aborter.abort();
    const p2 = createPlanner(kernel, { client: looping });
    const r2 = await p2.run('已中止', { signal: aborter.signal });
    expect(r2.stopReason).toBe('aborted');
  });

  it('dryRun 透传：写调用返回 diff 但引擎不动', async () => {
    const { kernel, engine } = makeKernel();
    const client = scriptedClient([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'records__translate', arguments: '{"ids":["p1"],"dx":5,"dy":0}' },
        ],
      },
      { text: '预览完成。', toolCalls: [] },
    ]);
    const planner = createPlanner(kernel, { client });
    const result = await planner.run('预览平移', { dryRun: true });
    expect(result.ok).toBe(true);
    expect(engine.snapshot().entities.get('p1')!.x).toBe(0);
    expect(engine.undoDepth).toBe(0);
  });

  it('history 跨 run 持续、reset 清空；client 抛错 → stopReason=error', async () => {
    const { kernel } = makeKernel();
    const client = scriptedClient([{ text: '好的。', toolCalls: [] }]);
    const planner = createPlanner(kernel, { client });
    await planner.run('第一问');
    await planner.run('第二问');
    expect(planner.history.filter((m) => m.role === 'user')).toHaveLength(2);
    planner.reset();
    expect(planner.history).toHaveLength(0);

    const failing: LlmClient = {
      complete: async () => {
        throw new Error('网络故障');
      },
    };
    const p2 = createPlanner(kernel, { client: failing });
    const r = await p2.run('会失败');
    expect(r).toMatchObject({ ok: false, stopReason: 'error', error: '网络故障' });
  });
});

describe('createChatController（无头 UI 绑定）', () => {
  it('send 驱动时间线：user→流式 assistant（增量→定稿）→busy 归位；订阅即回放当前态', async () => {
    const { kernel } = makeKernel();
    const client = scriptedClient([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'records__setProps', arguments: '{"ids":["p1"],"props":{"highlighted":true}}' },
        ],
      },
      { text: '已高亮 p1。', toolCalls: [] },
    ]);
    const controller = createChatController(createPlanner(kernel, { client }));

    let notified = 0;
    const off = controller.subscribe(() => {
      notified += 1;
    });
    expect(notified).toBe(1); // 订阅即回调一次

    const result = await controller.send('高亮 p1');
    expect(result?.ok).toBe(true);
    const s = controller.getState();
    expect(s.busy).toBe(false);
    const roles = s.items.map((i) => i.role);
    expect(roles).toEqual(['user', 'tool', 'tool', 'assistant']);
    const assistant = s.items.at(-1)!;
    expect(assistant).toMatchObject({ text: '已高亮 p1。', streaming: false });
    expect(notified).toBeGreaterThan(2);

    off();
    controller.clear();
    expect(controller.getState().items).toHaveLength(0);

    // busy 防重入：send 空文本/进行中直接忽略
    expect(await controller.send('   ')).toBeUndefined();
  });

  it('planner error 落为 error 时间线项', async () => {
    const { kernel } = makeKernel();
    const failing: LlmClient = {
      complete: async () => {
        throw new Error('鉴权失败');
      },
    };
    const controller = createChatController(createPlanner(kernel, { client: failing }));
    await controller.send('会失败');
    const last = controller.getState().items.at(-1)!;
    expect(last).toMatchObject({ role: 'error', isError: true });
    expect(last.text).toContain('鉴权失败');
  });
});
