# 自检与错误分析

两套互补机制：**doctor 管"装配对不对"**（配置期可发现的问题，启动时跑一次），**ErrorMonitor/explainError 管"运行中错在哪"**（失败聚合与自纠提示）。

## runDoctor：装配体检

```ts
import { runDoctor, formatDoctorReport } from '@geoverse-sar/kernel';

const report = runDoctor(kernel);
if (!report.ok) console.error(formatDoctorReport(report));  // 建议启动期直接 fail-fast
```

`DoctorReport = { ok, errors, warnings, checks[], summary }`；`ok` 只看 error 级（warn 不拦）。doctor 自身永不抛异常。

| 检查项 | 级别 | 查什么 |
|---|---|---|
| `capability.id` | error | id 字符集合法（`[A-Za-z0-9._-]`）、不含 `__`（破坏工具名双射） |
| `capability.tool-name-clash` | error | 两个能力派生出相同 AI 工具名 |
| `capability.schema` | error | Zod→JSON Schema 可派生（在启动期暴露而非首次 tools/list 时） |
| `capability.description` | warn | 描述 ≥15 字——它是模型"何时该调"的唯一依据 |
| `capability.kind` | warn | read/action 却声明 undoable=true |
| `capability.requires` | error | 声明依赖的服务未注册（否则 invoke 必失败） |
| `workflow.step-ref` / `step-id` | error | 步骤引用未注册能力 / 步骤 id 重复 |
| `workflow.macro` | warn | macro 工作流无 write 步（建议 `undo:'none'`） |
| `engine.snapshot` / `transaction-hook` | error | 端口契约冒烟：快照形状、事务钩子可解绑 |
| `algebra.merge-empty` | warn | `merge([])` 抛异常（空工作流 commit 会踩） |
| `permissions.trim-preview` | warn | 传 `{ caller }` 时：该调用方看不见哪些能力 |

playground 主页的「🩺 体检」按钮就是 `formatDoctorReport(runDoctor(kernel))` 直出。

## createErrorMonitor：失败聚合（中间件）

```ts
import { createErrorMonitor } from '@geoverse-sar/kernel';

const monitor = createErrorMonitor({ maxRecent: 50 });
const kernel = createKernel({ ..., middleware: [monitor.middleware] });

// 运行一段时间后：
const r = monitor.report();
r.failureRate;       // 失败率
r.byCapability;      // 哪个能力最常失败（含错误码分布）
r.topIssuePaths;     // "模型总在哪个参数出错"（如 records.translate#dx）
r.recent;            // 最近失败明细（含 entry 来源、issues、耗时）
```

未注册能力的调用（模型幻觉工具名的高频场景）**同样过漏斗**、被监控与事件流看见。

## explainError：错误 → 可操作提示

```ts
import { explainError, suggestCapabilityIds } from '@geoverse-sar/kernel';

const outcome = await kernel.invoke('records.trnslate', {});
explainError(outcome, { registry: kernel.registry });
// "能力 records.trnslate 不存在。 是否想调用: records.translate / ...？"
```

`@geoverse-sar/skill` 的 `handleToolCall` 已内置：失败 `content` 自动带 `hint` 回灌模型。

## 错误码表（InvokeOutcome.error.code）

| code | 含义 | 该谁修 |
|---|---|---|
| `validation_failed` | 入参过不了 schema（附结构化 `issues`） | 调用方（模型自纠/表单校验） |
| `capability_not_found` | 能力不存在（hint 附相似建议） | 调用方 |
| `permission_denied` | 权限不足——重试不会成功 | 配置（grant） |
| `service_missing` | 能力 `requires` 的服务未注册 | **宿主装配**（doctor 可提前发现） |
| `handler_error` | handler 抛异常 / 出参违约 | 能力作者或数据状态 |
| `engine_rejected` | 引擎校验拒绝（id 冲突/目标不存在） | 调用方先查后写 |
| `tx_group_not_found` | 事务组已结束或不存在 | 编排方 |
| `workflow_aborted` | 工作流整组中止（无半成品） | 看 `failedStepId` 定位 |
| `aborted` | AbortSignal 取消（写路由前兜底，状态未变） | 调用方按需重发 |

## 平稳度约定（内核既有行为，一并知晓）

- 事件监听器抛异常被吞掉，不中断 invoke 主流程。
- 工作流任一步失败整组 abort，引擎零污染。
- `plan` 抛异常 → dispatch 拒绝且状态零污染。
- dispose 幂等，只解绑自己挂的订阅（客人式）。
