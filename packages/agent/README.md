# @geoverse-sar/agent

自治 Agent 入口（RFC-0008 M4）：**observe→plan→act** 循环。治理不在循环里自建——权限由内核单漏斗强制、审计由中间件同栈入账、取消经 AbortSignal 贯穿；本包只加**审批门**（dryRun 预览 + approve 回调）与**步数预算**。

```shell
pnpm add @geoverse-sar/agent @geoverse-sar/planner @geoverse-sar/skill @geoverse-sar/kernel
```

依赖方向（ESLint 强制）：agent 只准依赖 `kernel` / `skill` / `planner`——动作经 `handleToolCall` 回灌单一 invoke 漏斗（`caller.entry='agent'`），不碰引擎/能力实现。

## createAgent——observe→plan→act

```ts
import { createAgent, createLlmPolicy } from '@geoverse-sar/agent';
import { createOpenAiCompatClient } from '@geoverse-sar/planner';

const agent = createAgent(kernel, {
  policy: createLlmPolicy(kernel, {
    client: createOpenAiCompatClient({ url, model: 'deepseek-chat', headers }),
    system: '业务口吻/单位约定…',
  }),
  maxSteps: 6,
  caller: {
    entry: 'agent',
    id: 'agent-1',
    grantedPermissions: ['records:read', 'records:write'],
  },
  approve: (action, preview) => confirmWithHuman(action, preview.diff), // 写动作 dryRun 预览过审
});

const result = await agent.run('把所有 poi 高亮并右移 15', {
  signal: aborter.signal,
  onEvent: (e) => {
    /* observe | decide | act:result | blocked | end */
  },
});
// result: { ok, stopReason: 'done'|'max_steps'|'aborted'|'policy_error', steps, trace, summary }
```

每步循环：**observe**（实体计数 + undoDepth + 权限裁剪后的能力目录 + 上一步各动作结果；宿主注册 kernel `createRuntimePack()` 时优先经 `invoke('runtime.stats')` 取数——同漏斗可审计、为远程化铺路，未注册或调用失败回退进程内对象戳探）→ **plan**（`AgentPolicy.decide` 出动作或收束）→ **act**（逐动作回灌漏斗，失败结果带 hint 回到下一步观察——策略自纠闭环）。

## AgentPolicy——策略端口

```ts
interface AgentPolicy {
  decide(observation: AgentObservation): Promise<AgentDecision>;
  // AgentDecision = { kind:'act', actions:[{capabilityId, input}] } | { kind:'done', summary }
}
```

LLM / 规则 / 脚本皆可——非确定性隔离在端口之外，循环骨架（预算/审批/中止/审计归因）保持可单测。内置 `createLlmPolicy(kernel, { client })`：观察 JSON → 单轮补全 → tool_calls 映射为动作、纯文本视为收束（复用 planner 的 `LlmClient` 端口与 skill 的工具投影）。

## 治理四件套（M4）

| 机制   | 落点                                | 行为                                                                                     |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| 权限   | `caller.grantedPermissions`（内核） | 目录裁剪（策略看不见）+ invoke 强制（硬调也 `permission_denied`），同一 `isGranted` 判定 |
| 审批门 | `approve` 回调（本包）              | 写动作先 `dryRun` 出「将改什么」的 diff，审过才落地；拒绝 → `blocked`，策略下一步可见    |
| 审计   | `createAuditLog`（kernel 中间件）   | agent 的每次调用（含 dryRun 预览）同栈入账，`entry='agent'` + `callerId` 归因            |
| 中止   | `AbortSignal`                       | 循环步间 + invoke 写路由前双重检查，中止后无半途落地                                     |

**持久化/回放**：搭配 kernel 的 `createJournal` / `replayJournal`——agent 会话录成事务日志，在同 seed 新内核上重放出相同终态与撤销粒度（宏撤销折叠在录制时已发生）。

可运行示例：playground `/agent.html`（DeepSeek 策略 + 审批开关 + 审计面板）。
