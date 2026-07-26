/**
 * U5-D prompt profile：包作者用法要点在构造期拼进 system。
 * 断言面：注入内容出现在发给 LLM 的 system；不传 profiles 时 system 逐字节不变
 * （回归零影响）；边界超限 fail-fast（usageNotes>800 / few-shot>3）。
 */
import { describe, expect, it } from 'vitest';
import {
  clientOf,
  createKernel,
  type PackPromptProfile,
  type SarKernel,
} from '@geoverse-sar/kernel';
import { AI_CALLER } from '@geoverse-sar/skill';
import {
  InMemoryStateEngine,
  RecordDiffAlgebra,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';
import { createRecordsPack } from '@geoverse-sar/capabilities-records';
import { createPlanner, renderPromptProfiles } from '../src/index';
import type { AssistantTurn, LlmClient, LlmRequest } from '../src/index';

function makeKernel(): SarKernel<RecordEntity, RecordDiff> {
  return createKernel<RecordEntity, RecordDiff>({
    engine: new InMemoryStateEngine([]),
    algebra: new RecordDiffAlgebra(),
    packs: [createRecordsPack()],
  });
}

function scriptedClient(turns: AssistantTurn[]): LlmClient & { requests: LlmRequest[] } {
  let i = 0;
  const requests: LlmRequest[] = [];
  return {
    requests,
    async complete(req) {
      requests.push(req);
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return turn;
    },
  };
}

const PROFILE: PackPromptProfile = {
  packId: 'records',
  usageNotes: '写操作前先用 records.query 确认目标存在；坐标单位是米。',
  fewShot: [
    {
      capabilityId: 'records.translate',
      input: { ids: ['p1'], dx: 5, dy: 0 },
      note: '东移 5 米',
    },
  ],
};

describe('prompt profile（U5-D）', () => {
  it('构造期注入：system 含用法要点与 few-shot；目录/schema 不复述', async () => {
    const kernel = makeKernel();
    const client = scriptedClient([{ text: '好的。', toolCalls: [] }]);
    const planner = createPlanner(clientOf(kernel, AI_CALLER), {
      client,
      profiles: [PROFILE],
    });
    await planner.run('你好');

    const system = client.requests[0].system ?? '';
    expect(system).toContain('【能力包用法提示 · records】');
    expect(system).toContain('坐标单位是米');
    expect(system).toContain('records.translate');
    expect(system).toContain('"dx":5');
  });

  it('不传 profiles 时 system 逐字节不变（回归零影响）', async () => {
    const kernel = makeKernel();
    const bare = scriptedClient([{ text: 'ok', toolCalls: [] }]);
    const withEmpty = scriptedClient([{ text: 'ok', toolCalls: [] }]);
    await createPlanner(clientOf(kernel, AI_CALLER), { client: bare }).run('hi');
    await createPlanner(clientOf(kernel, AI_CALLER), {
      client: withEmpty,
      profiles: [],
    }).run('hi');
    expect(withEmpty.requests[0].system).toBe(bare.requests[0].system);
  });

  it('边界 fail-fast：usageNotes>800 字 / few-shot>3 条构造即抛', () => {
    expect(() =>
      renderPromptProfiles([{ packId: 'p', usageNotes: 'x'.repeat(801) }]),
    ).toThrow(/usageNotes 超限/);
    const shot = { capabilityId: 'a.b', input: {} };
    expect(() =>
      renderPromptProfiles([{ packId: 'p', fewShot: [shot, shot, shot, shot] }]),
    ).toThrow(/few-shot 超限/);
    expect(renderPromptProfiles([])).toBe('');
  });
});
