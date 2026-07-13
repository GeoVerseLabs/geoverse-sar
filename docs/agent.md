# agent：自治 Agent 与治理（M4）

M4 把「自治 Agent 作入口」跑通，并补齐治理面。原则不变：**治理长在内核，不长在循环里**——agent 循环只负责 observe→plan→act 的骨架，权限/审计/取消全部由既有单漏斗承担，任何入口（program/ui/ai/mcp/agent）一视同仁。

```
目标 ──▶ agent 循环（@geoverse-sar/agent）
           observe：实体计数 + undoDepth + 权限裁剪后的目录 + 上一步动作结果
                    （注册 runtimePack 时走 invoke('runtime.stats') 同漏斗可审计，
                      未注册/失败回退进程内对象戳探）
           plan   ：AgentPolicy.decide（LLM/规则/脚本——非确定性隔离在端口外）
           act    ：审批门（写动作 dryRun 预览）→ handleToolCall → 单一 invoke 漏斗
                                                    │ caller.entry='agent'
                    权限强制 · 审计入账 · AbortSignal 兜底 ◀┘（内核，人机同栈）
```

## 快速上手

```ts
import { createAgent, createLlmPolicy } from '@geoverse-sar/agent';
import { createOpenAiCompatClient } from '@geoverse-sar/planner';
import {
  createAuditLog,
  createJournal,
  replayJournal,
  createKernel,
} from '@geoverse-sar/kernel';

const audit = createAuditLog();
const kernel = createKernel({ engine, algebra, packs, middleware: [audit.middleware] });

// T12 起 agent 依赖 SarClient 切面：身份在 client 构造处绑定（循环内无处伪造）；
// 策略共用同一 client——看见的恰是行动身份能调的
const sar = clientOf(kernel, { entry: 'agent', id: 'agent-1' });
const agent = createAgent(sar, {
  policy: createLlmPolicy(sar, { client: createOpenAiCompatClient({ url, model }) }),
  maxSteps: 6,
  approve: (action, { diff }) => human.confirm(action.capabilityId, diff),
});
const result = await agent.run('把所有 poi 高亮并右移 15', { signal, onEvent });
```

## 治理机制逐个看

### 1. AbortSignal（取消贯穿）

`kernel.invoke(id, input, { signal })`：handler 执行前与**写路由前**各检查一次——async handler 期间外部取消，变更不落地（错误码 `aborted`）。`handleToolCall` / planner / agent 全线透传；handler 也能经 `ctx.signal` 协作取消长操作。

### 2. 权限强制（白名单双重生效）

`caller.grantedPermissions` 同一份判定用在两处：`describeAll` 目录裁剪（策略/模型**看不见**未授权能力）+ invoke 强制（硬调也 `permission_denied`）。"看不见"与"调不到"不会脱节。

### 3. 审计（createAuditLog 中间件）

与 ErrorMonitor 互补：ErrorMonitor 只聚合失败，审计记录**每一次** invoke——`{ 谁(entry/callerId), 何时, 调了什么, 入参, ok/errorCode, dryRun, hasDiff, 耗时 }`。环形上限、过滤查询、JSON 持久化往返（`toJSON`/`load`）。挂中间件即全入口同栈入账，agent 的 dryRun 预览也可见。

### 4. 审批门（effect-aware approve + dryRun 预览）

审批判据是能力的**效应元数据**（G1-2），不是 `kind`：`effects.approval !== 'never'` 即过门——写默认 `policy`（过门）、read/多数 action 默认 `never`（不过门），而声明 `effects.approval: 'always'` 的**危险 action**（外部写/不可逆，如「发布/发送」）也会过门（修复了旧 `kind==='write'` 判据漏掉危险 action 的问题）。

过门时对**可逆且无外部副作用**的能力先 `dryRun` 拿「将改什么」的 diff 交 `approve(action, { diff, runId })`；对 `external!=='none'` 或 `state==='irreversible'` 的能力**跳过 dryRun 预览**（预览下 handler 仍执行、只拦状态写入——避免"预览就触发外部/不可逆副作用"），审批仍生效但 `diff` 为 `undefined`（人只看动作意图）。拒绝 → 动作 `blocked`（未执行、状态不动），策略下一步观察到会换方案或收束。观察面的 `catalog` 每项带 `effects`，规则/LLM 策略可据此提前判断风险。

### 5. 持久化/回放（createJournal / replayJournal）

订阅引擎事务流，把 dispatch/undo/redo 按序录成 JSON 日志；`replayJournal` 在**同一初始状态**的新内核上逐条重放（`ReplayDiffCommand`）。要点：**宏撤销折叠在录制时已发生**——工作流/事务组跑完只出一条合并事务，重放天然复现相同终态**与撤销粒度**；undo/redo 也入日志，撤销栈行为完整复刻。约束：TDiff 须 JSON 可序列化（RecordDiff / ChangeSet 均满足）。

## 测试策略

循环骨架用**脚本化 Policy**钉死（观察反馈闭环 / 审批拦截 / 权限双重生效 / abort / max_steps / policy_error）；LLM 策略用脚本化 `LlmClient` 钉死 tool_calls→动作映射；真实 LLM 只做端到端冒烟。可运行样板：playground `/agent.html`。
