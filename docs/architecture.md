# 架构与技术明细

> 本页是 SAR 的**工程事实**汇总：分层与依赖方向、单一漏斗的精确管线、各端口契约、持久化与远程化的实现语义、结构性不变量与错误码表。所有描述与源码逐点对齐（文档即验收）；设计动机见内部 vault 的 RFC-0008/0009 与 ADR-0010~0013，本页只陈述"是什么、怎么运作"。

## 一、分层总览

```
入口层（零领域逻辑：把目录投影出去，把调用路由回来）
  program（kernel.invoke）· ui（toPaletteItems）· ai（skill）
  · planner（NL→能力路由）· agent（observe→plan→act）· mcp（tools/list·call）
  · 远程（server ⇄ createRemoteClient，wire = InvokeOutcome）
        │            caller.entry 区分来源；事件流人机同栈
        ▼
切面：SarClient —— catalog（异步）+ invoke + onEvent 的可序列化最小子集
      caller 在构造处绑定（本地 clientOf / 远程 token 换算注入），方法参数无处伪造身份
        ▼
组装层  workspace（openWorkspace：恢复/checkpoint/锁/close）
        server（Node-only HTTP+WS 薄层）· evolution（自进化工具）· otel（可观测出口）
        ▼
@geoverse-sar/kernel（纯机制内核，只依赖 zod）
  Capability / Registry     read | write | action 三态，Zod 自描述
  Dispatcher 单漏斗          中间件 → 取消 → 权限 → 服务 → 校验 → handler → 写路由 → 事件
  Workflow + TransactionGroup 步间数据流 + 宏撤销
  治理                       权限 · 审计 · journal 回放 · AbortSignal · guardrails
  自检/调优                  runDoctor · ErrorMonitor · explainError · createTuningReport
  存储端口                   SarStore（追加流 + 快照；store-idb / store-file 子导出）
        │      内核唯一认识的状态抽象：StateEngine<TEntity, TDiff> + DiffAlgebra
        ▼
引擎层  engine-memory（参考实现）· engine-geo（零改动包裹 @geoverse/editor-core EditEngine）
能力层  capabilities-records（内存记录域）· capabilities-geo（GeoJSON 要素域，30+ 能力）
```

两条铁律（ESLint 依赖方向门强制，违则 lint 红）：

1. **kernel 禁止 import 任何 geoverse 包 / 地图库 / 同仓其它包**——"内核是运行时而非 SDK 封装"的可证伪判据。`engine-geo` / `capabilities-geo` 是唯二可碰 geoverse 的适配层。
2. **依赖只能由外向内**：入口层 → 能力层/组装层 → 引擎层 → kernel。planner 只准 kernel+skill、agent 只准 kernel+skill+planner、workspace/evolution/server/otel 只准 kernel。

## 二、包清单（13 包）

| 包                     | 层   | 职责                                                                                        | 环境                                                    |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `kernel`               | 内核 | 能力/单漏斗/工作流/宏撤销/权限/审计/journal/doctor/调优/存储端口/SarClient                  | 浏览器 + Node（`store-file`、`client-remote` 为子导出） |
| `engine-memory`        | 引擎 | 参考引擎 + `RecordDiffAlgebra`（fast-check 代数律测试）                                     | 通用                                                    |
| `engine-geo`           | 引擎 | 包裹 `@geoverse/editor-core` `EditEngine`（零改动）+ 双通道 `ChangeSetAlgebra` + 几何算子桥 | 通用                                                    |
| `capabilities-records` | 能力 | 记录域 8 能力 + 宏撤销工作流                                                                | 通用                                                    |
| `capabilities-geo`     | 能力 | GeoJSON 域 30+ 能力：draw/split/merge、变换组、洞族、查询分析、空间观察器                   | 通用                                                    |
| `workspace`            | 组装 | `openWorkspace` 生命周期：恢复/checkpoint/单写者锁/close + durable run + 审批持久化         | 通用                                                    |
| `server`               | 组装 | HTTP+WS 薄层：wire=InvokeOutcome、token→CallerInfo、EventBus→WS                             | **Node-only**                                           |
| `evolution`            | 组装 | L2 workflow 合成闭环、知识端口（kb）、能力摄取原型                                          | 通用                                                    |
| `otel`                 | 组装 | OpenTelemetry 出口：invoke 中间件 span + 事件桥（BYO SDK）                                  | 通用                                                    |
| `skill`                | 入口 | AI 工具面：`toToolSpecs`/`handleToolCall` 及 SarClient 孪生（逐字节平价）                   | 通用                                                    |
| `planner`              | 入口 | NL→能力路由 tool-use 循环、SSE 流式 `LlmClient`、无头聊天控制器                             | 通用                                                    |
| `agent`                | 入口 | observe→plan→act 循环、`AgentPolicy` 端口、审批门                                           | 通用                                                    |
| `mcp`                  | 入口 | MCP Server：`tools/list` ≡ 描述符投影、`tools/call` → 同一漏斗                              | 通用                                                    |

## 三、核心数据形状

**Capability ≡ AI 工具定义。** 能力用 Zod 自描述，描述符由 `z.toJSONSchema` 派生一份，同时背起 UI 命令面板（`toPaletteItems`）、AI 工具目录（`toToolSpecs`）与 MCP `tools/list`：

```ts
interface Capability<I, O, TEntity, TDiff> {
  id: string; // ≡ tool name（Claude 工具名不含 '.'，skill 层做 records.query ↔ records__query 双射）
  title: string;
  description: string; // 逐字进 AI 工具目录——写"何时该调"
  category: string;
  kind: 'read' | 'write' | 'action'; // 目录路由三态；效应判据在 effects（G1-2）
  effects?: Partial<EffectDescriptor>; // { state, external, approval, idempotency }——覆盖 kind 缺省；描述符恒携带解析后完整值
  inputSchema: z.ZodType<I>; // 派生 inputJsonSchema ≡ input_schema
  outputSchema: z.ZodType<O>;
  permissions?: readonly string[]; // 白名单键：目录裁剪 + invoke 强制同一判定
  requires?: readonly string[]; // 依赖的宿主服务键：dispatcher 前置校验（缺失 → service_missing）
  undoable?: boolean;
  handler(ctx: CapabilityContext, input: I): Promise<CapabilityResult>;
}
```

handler 返回三种形状之一：`{ output }`（无写）/ `{ output, commands, label? }`（命令走引擎）/ `{ output, diff, label? }`（现成 diff 经 `ReplayDiffCommand` 走引擎）。

**效应元数据（G1-2）**：`kind`（read/write/action）只管**目录路由**（三态心智）；`effects: { state, external, approval, idempotency }` 才是**预览/审批/重试/补偿**的判据——`kind==='action'` 的危险操作（外部写、不可逆）由此能被审批门识别。能力可声明 `effects`（`Partial`，覆盖 `resolveEffects(kind)` 的缺省：read→approval never、write→approval policy、action→approval never），描述符恒携带解析后的完整 effects（"每个能力都有效应元数据"缺省即成立）。agent 审批门从 `kind==='write'` 升级为 `effects.approval !== 'never'`；且对 `external!=='none'` 或 `state==='irreversible'` 的能力**跳过 dryRun 预览**（预览下 handler 仍执行，只拦状态写入——避免"预览就触发外部/不可逆副作用"），审批仍生效但不出 diff。otel span 带 `sar.effect_state`/`sar.effect_external`/`sar.effect_approval`。

**InvokeOutcome——归一出参，也是远程 wire 格式。** 一切入口（含 HTTP）拿到同构结果：

```ts
interface InvokeOutcome<O, TDiff> {
  ok: boolean;
  capabilityId: string;
  output?: O;
  diff?: TDiff; // 写落地或 dryRun 预览
  issues?: ValidationIssue[]; // zod 校验失败的结构化明细（AI 自纠素材）
  error?: { code: SarErrorCode; message: string };
  durationMs: number;
  dryRun?: boolean;
}
```

**CallerInfo——身份与权限的唯一载体：**

```ts
interface CallerInfo {
  entry: 'program' | 'ui' | 'ai' | 'mcp' | 'agent';
  id?: string; // 审计归因主体
  grantedPermissions?: readonly string[]; // undefined=宿主全授；数组=白名单裁剪
}
```

**SarEvent——统一事件流（人机同栈）**，五种帧：`invoke:start`、`invoke:end`、`engine:transaction`（origin=dispatch/undo/redo + diff）、`workflow:start`、`workflow:end`。远程模式下 WS 帧就是它的 JSON 序列化，序列与本地订阅逐帧一致。

## 四、单一漏斗：`dispatcher.invoke` 的精确管线

一次 `invoke(id, input, { caller, dryRun, txGroupId, signal, traceId, runId })` 按以下顺序执行——**顺序本身是契约**：

> **执行身份（G1-1，Execution Contract Freeze）**：每次 invoke 关联一个 `traceId`（缺省生成，前缀 `tr_`）与可选 `runId`（`run_`）、`mode`（`execute`/`preview`）。`traceId` = 一次顶层操作；**一条工作流全程共享一个 traceId，内部步骤（含以能力形式调用/嵌套）继承它**——"这个长任务调了哪些步骤/等哪个审批/写了哪些事务"可用单一标识回答。身份随 `InvokeOptions → MiddlewareContext → CapabilityContext → InvokeOutcome` 传播，并进 `SarEvent`（invoke/workflow/dispatch 事务）、`AuditEntry`（可按 `traceId`/`runId` 过滤取全）、`Journal`（写路由 dispatch 事务携带；undo/redo 不带）、OTel span（`sar.trace_id`/`sar.run_id`/`sar.mode`）。远程经 wire 透传（请求体 `traceId`/`runId`，**caller 仍只由 token 注入**——身份关联位 ≠ 权限位）。agent 一次 `run()` 的全部 invoke 共享一个 runId；durable 运行的 runId 即工作流执行 runId（崩溃恢复后仍可重建时间线）。

```
emit invoke:start
  → 中间件洋葱（audit / ErrorMonitor / guardrails / otel …包裹以下全部）
      → 能力不存在？→ capability_not_found（未注册也走完整漏斗——中间件可见、事件成对，
        模型幻觉工具名因此可被 ErrorMonitor 统计）
      → signal 已中止？→ aborted（handler 前第一次检查）
      → 权限：isGranted(cap.permissions, caller) → 否则 permission_denied
      → 服务：cap.requires 逐键查 services → 缺失 service_missing
      → 入参校验：inputSchema.safeParse → 失败 validation_failed + 结构化 issues
      → handler(ctx, parsed)（async；ctx.state 是读一致视图：
        txGroup 激活时=叠加已缓冲 diff 的投影态，否则=引擎快照拷贝）
      → 出参校验：outputSchema.safeParse → 失败 handler_error（能力作者契约兜底）
      → signal 再检查（async handler 期间可能已中止）→ aborted，半途取消不落地
      → 写路由（见下）
emit invoke:end
```

**写路由**四分支：

| 条件                   | 行为                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 无 commands/diff       | 直接返回 `{ ok, output }`（read/action 路径）                                                                                    |
| `dryRun: true`         | 在临时 TransactionGroup 里对（可选事务组投影之上的）当前态逐命令 `plan`，合并出 diff 返回——**不 dispatch、不入缓冲、状态零变化** |
| `txGroupId` 指向活动组 | 逐命令 `stage` 进宏事务组（只 plan 不 apply）；任一命令 plan 抛异常 → **abort 整组**（workflow_aborted）                         |
| 常规                   | 隐式 TransactionGroup：一次 invoke 的多命令也折叠成**一个撤销单元**，commit 走 `engine.dispatch`                                 |

异常纪律：handler 抛错被捕获为 `handler_error` outcome——**dispatcher 对能力级失败从不抛异常**，永远返回归一出参（这是远程 wire "200 + ok:false" 语义的根据）。

## 五、通用 diff 端口：内核唯一认识的状态抽象

```ts
interface StateEngine<TEntity, TDiff> {
  dispatch(
    cmd: Command<TEntity, TDiff>,
  ): { ok: true; diff: TDiff } | { ok: false; error: string };
  undo(): boolean;
  redo(): boolean;
  snapshot(): { entities: ReadonlyMap<string, TEntity> };
  onTransaction(
    fn: (e: {
      origin: 'dispatch' | 'undo' | 'redo';
      diff: TDiff;
      label?: string;
    }) => void,
  ): () => void;
  readonly undoDepth?: number; // 可选：runtime.stats 观察面据此上报，未暴露报 null
  readonly redoDepth?: number;
}
interface DiffAlgebra<TEntity, TDiff> {
  merge(diffs: TDiff[], label?: string): TDiff; // 宏撤销的折叠
  invert(diff: TDiff): TDiff; // undo
  apply(base: EntityStore<TEntity>, diff: TDiff): void; // 前滚/投影
}
interface Command<TEntity, TDiff> {
  // 纯 planner：算 diff、不改状态
  readonly label?: string;
  plan(state: ReadonlyEntityState<TEntity>): TDiff;
}
```

关键不变量：**写路径同步收口在 `engine.dispatch` 内**——async 边界在能力 handler，不在 diff 应用；plan→校验→apply→入撤销栈→emit 是一个同步序列，原子性由此保住。`createKernel({ engine, algebra })` 是客人式生命周期：收宿主已建好的引擎，`dispose()` 默认不销毁宿主资源（仅 `ownsEngine: true` 代管）。

## 六、TransactionGroup：宏撤销的实现

工作流/多命令折叠成一个撤销单元的机制，引擎零改动：

- **stage(cmd)**：在"基态快照 + 已缓冲 diff"的**投影上下文**上执行 `cmd.plan`——第 N 步能看见第 N-1 步的结果（含跨步引用缓冲期新增的实体 id），但引擎真实状态未动。
- **commit()**：`algebra.merge(stagedDiffs)` 预合并 → 包成一个 `ReplayDiffCommand` → **一次** `engine.dispatch`。引擎只看到一条事务 → `undoDepth` 只 +1，一次 undo 全回退。空组 commit 返回 `undefined`（不产生事务）。
- **abort()**：丢弃全部缓冲，引擎状态从未被碰过。
- 折叠语义矩阵（engine-memory 的代数实现，测试钉死）：add→modify 折叠进 added、modified 折叠首 before/末 after、add→remove 相消。

`dryRun` 复用同一机制：临时组只 plan 不 commit，天然得到"将改什么"的合并 diff。

## 七、Workflow：声明式组合 + 工作流即工具

```ts
interface Workflow<I, O> {
  id: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<I>;
  steps: {
    id: string;
    capability: string;
    input?: unknown | ((scope: { input: I; steps: Record<string, unknown> }) => unknown);
    when?: (scope) => boolean;
  }[];
  undo: 'macro' | 'per-step' | 'none';
  output?: (scope) => O; // 缺省返回 scope.steps
}
```

- **注册即能力**：`workflows.register(wf)` 同时把它投影成同 id 的 Capability——AI/UI 一次调用跑多步；`undo:'macro'` 全程共享一个 TransactionGroup。
- **组合与原子能力同契约（Gate 0）**：投影 handler 把 `CapabilityContext` 的 `dryRun`/`signal`/`txGroupId` 全量透传给 `run(id, input, { … })`——
  - `dryRun`：全步 stage 进预览事务组（步间投影可见），终局取合并 diff 后 abort，引擎零写入、撤销栈不长；结果交外层写路由的 dryRun 分支（与原子能力同出口形状）。**预览不再被内部真实写入击穿**。
  - `signal`：步间检查 + 逐步透传，中止错误码 `aborted`。
  - 嵌套：工作流作为另一工作流的步骤时，写步并入外层事务组、不自 commit——外层原子性支配，组合仍是单一撤销单元。
- **durable run（F1）**：`run(id, input, { onStep, resume })`——`onStep` 每步成功后 await（持久化边界，workspace 的 `createDurableRunner` 据此逐步落 store）；`resume` 预填已完成步输出跳过执行。**macro + resume 直接拒绝**：缓冲 diff 未落地，断点续跑破坏原子性，正确语义是整体重跑。
- 步失败 → macro 组 abort、`workflow:end ok:false` 带 failedStepId。

## 八、权限与身份：从"约定"到"结构"

- 同一判定 `isGranted` 在两处生效：`describeAll({ caller })` **裁剪目录**（模型看不见）+ `invoke` **强制兜底**（硬调也 permission_denied）——"看不见 ≡ 调不到"不会脱节。
- **SarClient 切面**把 caller 从方法参数移到构造处：

```ts
interface SarClient<TDiff> {
  catalog(filter?): Promise<CapabilityDescriptor[]>; // 异步化：远程要过网络
  invoke<O>(id, input?, opts?: { dryRun?; signal? }): Promise<InvokeOutcome<O, TDiff>>;
  onEvent(fn): () => void;
}
```

本地 `clientOf(kernel, caller)`；远程由服务端从 Bearer token 换算注入。入口层（planner/agent/UI）一律吃 SarClient——**客户端结构性无法伪造身份**，权限裁剪与审计归因随身份自动成立。`SarKernel` 保持全功能不删减（进程内高级用法 `beginGroup`、直接引擎访问不受影响），SarClient 只是子集投影。

- 输入级防线 `createGuardrails({ maxWritesPerRun, bboxFence, propertyPolicy })`（中间件）：写预算（dryRun 不计）、坐标围栏（深扫 `[x,y]` 数组与 `{x,y}` 对象）、受保护字段（深层键名匹配即拒）；read 不拦，拒绝走 `permission_denied` 同栈入审计。启发式预检，明示不替代权限与领域校验。

## 九、观测、取证与治理

| 机制                              | 形态            | 语义                                                                                                                                                                             |
| --------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAuditLog`                  | 中间件          | **取证面**：每次 invoke 按 entry/callerId 归因入账（入参快照/结果/dryRun/hasDiff/耗时）；环形缓存查询 + 可选 `sink` 逐条落 SarStore；`captureInput:false` 可关敏感入参           |
| `createJournal` / `replayJournal` | 事件订阅        | **恢复面**：录引擎事务流（dispatch/undo/redo 的 diff），同 seed 新内核重放出**相同终态与撤销粒度**——宏撤销折叠在录制时已发生；journal 只含 diff，能力包/提示词升级不影响历史回放 |
| `createErrorMonitor`              | 中间件          | 失败聚合：失败率/按能力/按错误码/校验失败参数路径 Top（含 capability_not_found——幻觉工具名可统计）                                                                               |
| `runDoctor`                       | 离线            | 装配体检 11 类：目录/工具名双射/schema 派生/requires 服务/工作流引用/端口冒烟；自身永不抛                                                                                        |
| `explainError`                    | 纯函数          | 错误 → 可操作提示（含相似能力建议，registry 或 catalog 数组皆可作源）；skill 失败 content 自动带 hint 回灌模型自纠                                                               |
| `createTuningReport`              | 离线            | L1 执行器：schema/description/usage 三类修订建议（带 evidence）+ 成功轨迹 few-shot 素材；确定性零 LLM                                                                            |
| `@geoverse-sar/otel`              | 中间件 + 事件桥 | **观测面**：invoke → span（包裹整个漏斗，天然精确关联）、workflow 开合、事务（含 undo/redo）；只依赖 `@opentelemetry/api`                                                        |
| `AbortSignal`                     | invoke 选项     | handler 前 + 写路由前**双检查**（错误码 `aborted`）；async handler 期间中止保证不落地；skill/planner/agent/server 全线透传                                                       |

sink 双写纪律：journal/audit 落 store 的写失败**吞错不断主流程**（经 onError 通知），退出前 `flush()` 等待落定。

## 十、持久化与工作区

**SarStore 端口**——runtime 持久数据只有两种形状：

```ts
interface SarStore {
  append(stream, records): Promise<number>;  // seq 按流从 1 单调分配，truncate 后不回退不复用
  read(stream, { fromSeq?, limit? }): Promise<{ seq; record }[]>;
  truncate(stream, uptoSeq): Promise<void>;  // checkpoint 后回收 journal
  putSnapshot(key, data): Promise<void>;     // 整体替换语义
  getSnapshot<T>(key): Promise<T | undefined>;
  close(): Promise<void>;
}
```

三适配器同一契约（同一测试套件 `describe.each` 钉死）：`memoryStore`（主入口）、`idbStore`（子导出 `kernel/store-idb`，append 与 seq 同事务）、`fileStore`（子导出 `kernel/store-file`，JSONL + meta；崩溃一致性=末尾残行丢弃并物理截掉、完整行损坏抛错指路快照、快照/截断走 tmp+rename 原子替换、fsync 可配）。记录须 JSON 可序列化（`jsonClone` 统一值语义）。

**openWorkspace 恢复算法**（workspace 包，只依赖 kernel，引擎经**工厂**入参注入）：

1. 读 meta（`formatVersion` / `engineKind` / `checkpointSeq`）——不匹配拒绝打开并给迁移提示；
2. 实体快照作 seed 经引擎工厂重建（传实例而非工厂 = 禁用恢复、退化纯录制并告警）；
3. journal tail 逐条 **seq 连续性校验**（`tail[0].seq === checkpointSeq + 1` 且逐条 +1；断档=存储损坏，报错指路快照兜底）；
4. `replayJournal` 复现终态与撤销粒度 → 挂 sink 继续录制。

**checkpoint**：快照与位点（开录基准 + journal 内存条目数）**同一 tick 捕获**（防并发写撕裂）；先写新快照与新 meta 成功后才 truncate——中途崩溃最多留冗余 journal，不丢数据。自动 checkpoint 默认 everyTx=200，close 默认 checkpoint。**撤销地平线 = checkpoint**：恢复后最多撤到最老未截断的 journal 条目（端口无法不应用 diff 重建更早撤销栈；keepTail 仅归档余量），UI 应明示"更早历史已归档"。

**并发**：浏览器同名工作区双开经 Web Locks 单写者——后来者 `readOnly`（写/action 经中间件 permission_denied 拒绝，审计在守卫外层、拒绝也入账）。

**durable run 与审批（F1/F2）**：`createDurableRunner` 把 WorkflowRunState 逐步落 store，崩溃遗留 `pendingRuns()` 枚举、per-step 跳步续跑（macro 整体重跑）；`createApprovalGate` 审批请求先落 store 再等决策——重启后遗留 pending 仍可决策，批准的动作由宿主凭 `{capabilityId, input}` **重新 invoke**（continuation = 重新调用）。

## 十一、远程化：同一切面跨网络

**server 薄层不发明协议**——wire 就是 dispatcher 的归一出参：

```
POST /workspaces/:id/invoke      body { id, input?, dryRun?, traceId?, runId? } → InvokeOutcome JSON
GET  /workspaces/:id/catalog     ?kind=&category=&tag=        → CapabilityDescriptor[]
WS   /workspaces/:id/events      ?token=                      ← SarEvent 帧（EventBus 直桥）
POST /workspaces/:id/checkpoint  （invoke('runtime.checkpoint') 语法糖）→ InvokeOutcome JSON
```

- `Authorization: Bearer <token>`（WS 用 `?token=`）→ 映射表换算 CallerInfo → 逐请求 `clientOf(kernel, caller)`。请求体带任何 caller 字段**不被读取**。
- HTTP 状态码只表达传输层：401 未认证 / 404 无工作区 / 400 坏 JSON / 405 方法不符 / 426 events 需 WS。能力级失败永远 200 + `ok:false`。
- 响应完成前请求断开 → `AbortController.abort()` → 内核写路由前兜底，半途取消不落地。
- `createRemoteClient(url, token)`（kernel 子导出 `client-remote`）：`signal` 中止合成 `aborted` outcome 与本地平价；`eventsReady()` 是懒连接不丢帧的就绪点；Node 20 无全局 WebSocket 经 `webSocket` 选项注入；**不自动重连**（断线走 `onSocketDown` 交宿主；错过的帧不可重放，完整取证走服务端 audit/journal）。
- 每 workspace 单实例单写者：HTTP 并发天然排队进单漏斗，与引擎同步写路径一致。

**传输层硬化（G1-3，body 契约不变）**：每个 HTTP 响应带 `x-sar-protocol`（协议版本 `SAR_WIRE_VERSION`，客户端逐响应校验、主版本不符抛错早失败）+ `x-request-id`（传输层关联位，客户端可自带；区别于执行身份 traceId/runId）。传输层错误是结构化 `WireError` `{ error:{ code:WireErrorCode, message, requestId } }`——与能力级 InvokeOutcome 明确区分。POST invoke/checkpoint 支持 `idempotency-key` 头：同 key 重放返回缓存 outcome（带 `x-sar-idempotent-replay:true`）、不重复执行（配合 `EffectDescriptor.idempotency:'keyed'` 安全重试；缓存按 workspace+token 隔离，覆盖顺序重放不去重并发在途）。wire 常量/类型收口在 kernel `wire.ts`（稳定 contract）。

## 十二、智能层

- **skill**：`toToolSpecs`/`toToolSpecsOf`（描述符 → 工具规格，Claude 工具名不含 `.` 的 `records.query ↔ records__query` 双射）+ `handleToolCall`/`handleToolCallVia`（工具调用 → 同一漏斗；失败 content 自动带 explainError hint）。kernel 版与 SarClient 版**逐字节平价**（parity 测试钉死）。
- **planner**：`createPlanner(sarClient, { client, system, history? })` tool-use 循环——目录每 run 经 `catalog()` 重取、回灌走 `handleToolCallVia`、`maxRounds`/`signal`/`dryRun`；`LlmClient` 端口隔离 LLM 非确定性（内置 `createOpenAiCompatClient`：零 SDK SSE，tool_calls 按 index 跨片归并）；`createChatController(planner, { items? })` 无头时间线（流式正文/工具轨迹/中止；`history`+`items` 两份 conversations 快照配对恢复会话）。**NL 不进内核**。
- **agent**：`createAgent(sarClient, { policy, approve?, enrichObservation?, maxSteps? })` observe→plan→act——观察面经 `runtime.stats` 能力取数（切面下无对象戳探）；审批门=写动作先 dryRun 出 diff 过 `approve`；`enrichObservation` 钩子注入领域观察（空间摘要 `createSpatialObserver` / 知识命中 `createKbEnricher`）。治理长在内核不长在循环里。
- **mcp**：`tools/list` 直投 `inputJsonSchema`、`tools/call` 复用 `handleToolCall`——外部 MCP 客户端经同一 runtime 编辑，`caller.entry='mcp'` 进统一事件流。

## 十三、自进化边界（RFC-0009）

| 层          | 内容                                                                                                         | 准入                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| L1 自调优   | `createTuningReport`：运行数据 → 修订建议 + few-shot 素材                                                    | ✅ 报告是数据，修订由人执行                                                           |
| L2 编排进化 | `createSynthesis`：挖掘 → LLM 起草纯 JSON 草稿 → 静态检查 + 逐步 dryRun 干跑 → 审批 → 注册 + provenance 落流 | ✅ 草稿只能组合已注册能力、模板语言不图灵完备、undo 固定 macro、缺省 pending 不进目录 |
| L3 能力合成 | `ingestCapability`：签名 → schema/description/骨架源码                                                       | ⚠️ 仅 dev-time（人审进仓），不做运行时热代码                                          |
| L4 内核自改 | —                                                                                                            | ❌ 内核是信任锚点                                                                     |

## 十四、结构性不变量（测试钉死，非约定）

| 不变量            | 含义                                                                                                          | 验收位置                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 跨入口平价        | `invoke ≡ handleToolCall ≡ MCP tools/call` 同参同 diff/输出/终态                                              | skill/mcp parity 测试                     |
| 本地/远程入口平价 | `clientOf.invoke ≡ createRemoteClient.invoke`（去 durationMs 后 outcome 全等，含 diff）；WS 事件序列逐帧一致  | server 平价测试                           |
| skill 双生平价    | `toToolSpecs ≡ toToolSpecsOf`、`handleToolCall ≡ handleToolCallVia` 逐字节相等                                | skill client-parity 测试                  |
| 宏撤销折叠        | 多写步工作流 → `undoDepth` 恰 +1，一次 undo 全回退                                                            | kernel txgroup / workflow 测试            |
| dryRun 无副作用   | 返回 diff 但 snapshot 不变、撤销栈不长（原子能力 **与工作流同**——组合调用不绕过预览）                         | kernel dispatcher / workflow-preview 测试 |
| 组合与原子同契约  | 工作流经 invoke/SarClient 调用时 dryRun/signal/嵌套与原子能力同语义（预览零写入、中止无半写、嵌套单撤销单元） | kernel workflow-preview 测试              |
| 构建不可假绿      | d.ts 生成阶段任一 error 级 TS 诊断 → `vite build` 非零退出（`build/strict-dts` 的 `afterDiagnostic` 门）      | 全包 build（CI verify）                   |
| 执行身份贯穿      | 一条工作流全程一个 traceId、内部步骤继承；审计/事件/日志/远程 wire 按 traceId/runId 关联同一长任务            | kernel execution-context / server 测试    |
| 恢复等价          | 编辑→close→重开：终态/撤销栈深/redo 可用性全等（idb/file 矩阵）                                               | workspace 等价矩阵                        |
| 回放等价          | 同 seed `replayJournal` 复现相同终态**与撤销粒度**                                                            | kernel journal 测试                       |
| schema 同源       | 工具规格与命令面板的 JSON Schema 出自同一份 Zod 派生                                                          | skill schema 平价快照                     |
| 身份不可伪造      | 请求体伪造 caller 无效；目录裁剪与 invoke 强制同一判定                                                        | server token 测试 + kernel 权限测试       |

## 十五、错误码表

| code                                        | 触发点                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `capability_not_found`                      | 能力未注册（也走完整漏斗，观测可见）                              |
| `capability_conflict` / `workflow_conflict` | 重复注册                                                          |
| `permission_denied`                         | 白名单不含所需权限（或 guardrails/只读模式拒绝，同码同栈审计）    |
| `validation_failed`                         | 入参 zod 校验失败（带结构化 `issues`）                            |
| `handler_error`                             | handler 抛错 / 出参不符 outputSchema / 隐式组 plan 抛错           |
| `engine_rejected`                           | 引擎 dispatch 拒绝（如领域校验不过）                              |
| `service_missing`                           | `requires` 声明的宿主服务未注入                                   |
| `tx_group_not_found`                        | txGroupId 指向不存在的事务组                                      |
| `workflow_not_found`                        | 工作流 id 不存在                                                  |
| `workflow_aborted`                          | 工作流步失败 / 宏组内 plan 抛错 abort 整组 / macro+resume 拒绝    |
| `aborted`                                   | AbortSignal 中止（handler 前或写路由前；远程=请求中止客户端合成） |

---

延伸阅读：[核心概念](./concepts.md)（零基础视角）· [持久化](./persistence.md) · [远程模式](./remote.md) · [自进化](./evolution.md) · [API 参考](/api/)（typedoc 生成，勿手改）。
