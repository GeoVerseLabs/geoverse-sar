import type { SarClient } from '@geoverse-sar/kernel';
import { toCapabilityId, toToolSpecsOf } from '@geoverse-sar/skill';
import type { LlmClient } from '@geoverse-sar/planner';
import type { AgentDecision, AgentObservation, AgentPolicy } from './types';

export interface CreateLlmPolicyOptions {
  client: LlmClient;
  /** 业务口吻/约束追加到默认系统提示后。 */
  system?: string;
}

const POLICY_SYSTEM = [
  '你是自治空间应用 Agent 的决策策略。每一步你会收到一份 JSON 观察（目标、当前实体数、上一步各动作结果）。',
  '决策方式：需要继续行动就调用工具（可一次多个）；目标已达成（或确认无法达成）就**不调用任何工具**，直接用一段话总结收束。',
  '规则：先查后写；上一步失败的动作读它的 error/hint 修正后再试，不要原样重发；不确定实体是否存在时先查询。',
].join('\n');

/**
 * LLM 策略（plan 环节）：观察 → 单轮补全 → tool_calls 映射为动作 / 纯文本视为收束。
 * 目录=client.catalog 的工具投影（与 planner 同源；T12/R6 起走切面——与 agent 循环
 * 用同一 client 时，策略看见的恰是行动身份能调的）；迭代由 agent 循环驱动，
 * 这里每次 decide 只打一轮——预算与治理都留在循环侧。
 */
export function createLlmPolicy(
  sar: SarClient,
  options: CreateLlmPolicyOptions,
): AgentPolicy {
  const { client, system } = options;
  return {
    async decide(observation: AgentObservation): Promise<AgentDecision> {
      // catalog 已随工具规格给到模型，观察里去重以省 token
      const { catalog: _catalog, ...rest } = observation;
      const turn = await client.complete({
        system: system ? `${POLICY_SYSTEM}\n${system}` : POLICY_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `观察（第 ${observation.step}/${observation.maxSteps} 步）：\n${JSON.stringify(rest, null, 2)}`,
          },
        ],
        tools: toToolSpecsOf(await sar.catalog()),
      });
      if (turn.toolCalls.length === 0) {
        return { kind: 'done', summary: turn.text || '（策略未给出总结）' };
      }
      return {
        kind: 'act',
        note: turn.text || undefined,
        actions: turn.toolCalls.map((c) => {
          let input: unknown = {};
          try {
            input = c.arguments ? JSON.parse(c.arguments) : {};
          } catch {
            // 参数坏 JSON：交给漏斗按 validation 失败回报，策略下一步观察到即自纠
            input = c.arguments;
          }
          return { capabilityId: toCapabilityId(c.name), input };
        }),
      };
    },
  };
}
