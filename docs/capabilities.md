# Capability 约束规范（v1）

> 本篇是 **normative 规范**：写"一个能力必须长什么样"，读者是能力作者；每条可判定条款都有对应的机器检查（doctor 检查项 id 随文标注，CI 级 conformance 套件见 §9）。教程式入门见 [concepts](./concepts.md)；第三方**包级**接入指南（依赖方向、命名空间、认证流程）在 extending 指南（阶段四 U5 交付）。

## 1. 能力模型总览

能力包 = `CapabilityPack { id, capabilities: Capability[] }`，经 `createKernel({ packs })` 注册。锚点：**`CapabilityDescriptor ≡ Claude/MCP 工具定义`**（`id ≡ name`、`inputJsonSchema ≡ input_schema`）——描述符是唯一序列化边界，同一份投影背 UI 命令面板、AI 工具目录与 MCP `tools/list`。

| 字段 | 必填 | 语义 | 谁消费 |
| --- | --- | --- | --- |
| `id` | ✔ | 点分层级唯一标识（§2） | 目录 / 工具名双射 / 审计归因 |
| `title` | ✔ | 中文动词短语（UI 面板显示名） | palette / 审批卡片 |
| `description` | ✔ | **写给模型读**：何时该调 + 副作用 + 可否撤销（§4.4） | AI 工具目录（逐字进）/ doctor |
| `category` | ✔ | 目录分组（query/edit/runtime/…） | 目录过滤 / CatalogSelector |
| `kind` | ✔ | 三态**目录路由**：read / write / action（§3.1） | handler 返回形态 / 写路由 |
| `effects` | 可选 | 效应四维（Partial 覆盖 kind 缺省，§3.2） | 审批门 / 预览安全 / 重试 / otel |
| `inputSchema` / `outputSchema` | ✔ | Zod（§4）；出参过不了 outputSchema 报 `handler_error` | 校验 / JSON Schema 派生 |
| `tags` | 可选 | 检索线索（catalog.search / selector 计分） | 发现 |
| `permissions` | 可选 | 权限点（§6）；目录裁剪与 invoke 强制同一判定 | 治理 |
| `undoable` | 可选 | 缺省 `kind==='write'`（§6） | UI 徽章 / effects 一致性检查 |
| `requires` | 可选 | 依赖的宿主服务键（§6）；缺失报 `service_missing` | dispatcher 前置校验 / doctor |
| `since` / `deprecated` / `replacedBy` | 可选 | 生命周期元数据（§8） | doctor 告警 / UI 徽章 |
| `handler` | ✔ | `(ctx, input) => { output } / { output, commands } / { output, diff }` | 单漏斗 |

## 2. id 与命名

- 点分层级 `域.动作`（`features.buffer`、`catalog.search`）；字符集 `[A-Za-z0-9._-]`【doctor `capability.id`】。
- **禁止 `__`**：AI 入口工具名做 `.`↔`__` 双射（Claude tool name 不含 `.`），`__` 会造成反解歧义【doctor `capability.id` / 冲突另报 `capability.tool-name-clash`】。
- 首段=域名。内建域：`features`/`view`/`history`/`records`/`runtime`/`catalog`。**第三方包用 vendor 前缀**（如 `acme.routing.solve`）——同 id 注册期直接抛 `capability_conflict`。

## 3. kind 三态与 effects 四维

### 3.1 kind 只管目录路由

`kind` 表达三态**心智**与 handler 返回形态，不表达风险：

- `read`：返回 `{ output }`；从 `ctx.state` 读（宏组内=投影态）。
- `write`：返回 `{ output, commands }`（推荐，Command 是纯 planner）或 `{ output, diff }`；应用/撤销/事件由引擎负责，一次 invoke 的多条命令自动折叠为**一个撤销单元**。
- `action`：有副作用但非 diff（视野聚焦、undo/redo、外部提交），返回 `{ output }`。

### 3.2 effects 四维语义表

`effects` 才是**预览 / 审批 / 重试 / 补偿**的判据（`kind` 判风险是已修复的历史缺陷 P0-3）。每个取值一行：

| 维度 | 取值 | 含义 | 典型例子 | 消费方行为 |
| --- | --- | --- | --- | --- |
| `state` | `none` | 不改内部状态 | 查询、聚焦 | —— |
| | `reversible` | 经 diff 可撤销 | 平移、改属性 | 审批门可 dryRun 出 diff 预览 |
| | `irreversible` | 改状态但无 diff 可回 | 清空回收站 | **跳过 dryRun 预览**（预览会真执行 handler） |
| `external` | `none` | 不碰外部世界 | 内存/引擎操作 | —— |
| | `read` | 只读外部 | geocode、取瓦片 | 可预览；重试安全性看幂等 |
| | `write` | 向外部提交 | 发布、发送、commit 到远端 | **跳过 dryRun 预览** + 建议 `approval:'always'` |
| `approval` | `never` | 不需审批 | 纯读 | 审批门直接放行 |
| | `policy` | 交宿主策略 | 内部可逆写（write 缺省） | agent 走 `approve` 回调 |
| | `always` | 强制人审 | 外部写 / 不可逆 | 必过审批门 |
| `idempotency` | `none` | 非幂等 | 一般写 | 失败重试须谨慎 |
| | `keyed` | 幂等键下可安全重试 | 远端提交 | 配 wire `idempotency-key` 重放不重复执行 |

### 3.3 缺省表与覆盖规则

未声明 `effects` 时按 kind 取缺省（`resolveEffects(kind, effects?)`，Partial 逐字段覆盖；**描述符恒携带解析后的完整 effects**——"每个能力都有效应元数据"由缺省成立）：

| kind | state | external | approval | idempotency |
| --- | --- | --- | --- | --- |
| `read` | none | none | never | keyed |
| `write` | reversible | none | policy | none |
| `action` | none | none | never | none |

核心规则：**危险的 action 不改 kind，用 effects 覆盖**——如"发布到外部系统"仍是 `kind:'action'`，声明 `effects: { external: 'write', approval: 'always', idempotency: 'keyed' }`。

### 3.4 选择决策树（四问）

1. **改内部实体状态吗？** 经 diff → `state:'reversible'`（write 缺省即对）；改了但无 diff 可回 → `'irreversible'` 且 `approval` 至少 `'always'`、`undoable:false`；不改 → `'none'`。
2. **碰外部世界吗？** 只读外部 → `external:'read'`；向外提交/发送/落盘到宿主之外 → `external:'write'`。
3. **approval 怎么选？** `external:'write'` 或 `state:'irreversible'` → `'always'`；内部可逆写 → `'policy'`（缺省）；纯读 → `'never'`。
4. **idempotency 何时必须 keyed？** `external:'write'` 且存在重试路径（远程断线重发 / agent 重试 / job 提交）→ 必须 `'keyed'` 且入参可派生幂等键；内部写经漏斗管控，`'none'` 可接受。

### 3.5 非法/可疑组合表【doctor `capability.effects`】

| 组合 | 级别 | 理由 |
| --- | --- | --- |
| `read` + `state ≠ 'none'` | error | read 不产生状态变更 |
| `read` + `external:'write'` | error | 外部写应为 action |
| `undoable`（显式或缺省）+ `state:'irreversible'` | error | 不可逆变更不能承诺可撤销——补 `undoable:false` |
| `write` + `state:'none'` | warn | 写能力不改状态很可疑 |

## 4. Schema 规范

### 4.1 入参

- 顶层必须 `z.object`（工具规格要求 object 形参）。
- 每个非平凡字段 `.describe()`——字段说明与 description 一样逐字进模型侧。
- **禁 `transform`**：JSON Schema 派生用 `z.toJSONSchema(…, { unrepresentable: 'any' })`，transform 会**静默退化成 any**，模型侧失去形状约束。
- `.refine` 的 message **不进** JSON Schema——复杂约束必须同时写进 `.describe()` 或 description（参照 `features.split` 的写法）。
- 校验失败回结构化 `outcome.issues`（path/message/code），AI 经 `is_error` 回灌自纠。

### 4.2 出参

- `outputSchema` 是承诺：handler 输出过不了它报 `handler_error`【描述符即承诺】。
- **LLM 友好摘要范式**：不倾倒完整坐标串——要素类出参用 `featureSummary { id, geometryType, bbox, center, props }`（geo-profile 提供规范 schema 与 `summarizeFeature`）。

### 4.3 geo 规范类型（@geoverse-sar/geo-profile）

跨包边界交换 geo 数据必须用共享底座 `@geoverse-sar/geo-profile`（仓内 `packages/geo-profile`）的规范 schema（`positionSchema`/`bboxSchema`/`geometrySchema`/`featureSchema`/`featureRefSchema`/`featureSummarySchema`/`crsRefSchema`/`quantitySchema`）；能力**私有**的入参 shape 留在包内。要点：

- `geometrySchema` 只收 GeoJSON 六个具体类型（GeometryCollection 刻意不收）；只做结构校验，几何有效性归引擎/后端。
- **距离/长度入参用 `Quantity{value, unit}` 替代裸数字**（过渡期可 `distanceSchema` union 兼容裸数字=工作区平面单位）；单位换算走 `resolveQuantity`——`m/km/deg` 依赖宿主声明 `localUnit`（如 `createGeoPack({ localUnit: 'm' })`），未声明/口径不匹配**结构化拒绝而非猜**。消掉"缓冲 500——米还是度"一类静默错误。
- geo 类型永不进 kernel（红线一）；geo-profile 是叶子包（只依赖 zod），ESLint 依赖门执行。

### 4.4 描述质量标准【doctor `capability.description`】

- ≥15 字；写清**何时该调**、副作用、可否撤销——它是模型选择工具的唯一依据。
- `title` 是中文动词短语；`category` 取既有值（新域先立目录约定）；`tags` 给检索用的关键词（catalog.search 与 CatalogSelector 都按 tags 加权）。

## 5. write 能力与 Command

`plan` 必须纯：读 `state`、算 diff、不改任何东西（读到的是宏组内**投影态**——第 N 步能看见第 N-1 步的缓冲效果）。plan 抛错 → invoke 失败、状态零污染。

```ts
export class TranslateRecordsCommand implements Command<RecordEntity, RecordDiff> {
  constructor(
    private ids: string[],
    private dx: number,
    private dy: number,
  ) {}
  plan(state: ReadonlyEntityState<RecordEntity>): RecordDiff {
    return {
      added: [],
      removed: [],
      modified: this.ids.map((id) => {
        const before = state.get(id);
        if (!before) throw new Error(`记录不存在: ${id}`);
        return {
          id,
          before,
          after: { ...before, x: before.x + this.dx, y: before.y + this.dy },
        };
      }),
    };
  }
}
```

派生类能力（buffer/offset/split/merge）在 handler 内用 `ctx.state`（组内即投影态）预计算输出 id，plan 只复验目标存在——输出与 ChangeSet 同源。

**ctx.state 是惰性只读视图（U0-5）**：单实体读走引擎精读端口（O(单实体)），枚举访问才物化快照；交出的实体**浅冻结**——原地变异直接抛 TypeError，深层变异改的也只是副本，永远落不进引擎。别改它，走 Command。

## 6. undoable / requires / permissions

- `undoable` 只属于 write（缺省 `kind==='write'`）【doctor `capability.kind`】；与 `state:'irreversible'` 组合非法（§3.5）。
- `requires: ['服务键']`：handler 依赖宿主服务时**必须**声明——dispatcher 入口校验（缺失报 `service_missing` 而非 handler 深处裸错）【doctor `capability.requires`】。服务键命名 `域.名词`（`runtime.checkpoint`、`runtime.catalog`）。**外部访问（fetch/第三方 SDK）也必须经 services 注入**，不得 handler 内裸调——这是权限、可测性与 effects 一致性探针（conformance）的共同前提。
- `permissions: ['records:write']`（命名 `域:动作`）+ 调用方 `grantedPermissions` 白名单；**目录裁剪（describeAll/toToolSpecs/catalog.search）与 invoke 强制用同一 `isGranted` 判定**——模型看不见即调不到，搜不到也调不了。

## 7. 工作流与投影约束

- steps 只引用已注册能力 id【doctor `workflow.step-ref`】；步骤 id 不得重复【`workflow.step-id`】。
- `undo:'macro'` 须含 ≥1 write 步【`workflow.macro`】；纯读/action 工作流用 `undo:'none'`。
- 工作流投影成同 id 能力后，kind 缺省 `undo==='none' ? 'action' : 'write'`。
- **组合型能力义务**：以能力形式被调时，`ctx.dryRun / ctx.txGroupId / ctx.signal / ctx.traceId` **必须透传**给内部的 run/invoke——否则外层 dryRun 预览会被内部真实写入击穿（Gate 0 契约，`workflow-preview.test.ts` 钉死）。普通能力无需理会（写路由由 dispatcher 统一拦截）。

## 8. 版本与弃用

- `since`：首次提供的包版本（semver）或日期；能力入参形状变更（如接 Quantity）也应刷新并在 description 说明兼容写法。
- `deprecated: true | '原因'`：**弃用不从目录隐藏**——journal 只含 diff，历史回放不受包升级影响（版本化压力只落在 workflow 引用与目录稳定性上，负担很轻）；隐藏/徽章交 UI 消费方。doctor 告警【`capability.deprecated`】。
- `replacedBy`: 替代能力 id；指向未注册能力告警【`capability.replaced-by`】；工作流步骤引用弃用能力告警【`workflow.deprecated-step`】。
- 弃用流程：标记 → doctor 告警期（至少一个 minor 周期）→ 移除。

## 9. 上线前检查链

```ts
import { runDoctor, formatDoctorReport } from '@geoverse-sar/kernel';
console.log(formatDoctorReport(runDoctor(kernel)));
```

两级检查，分工明确：

- **doctor**（启动期装配体检，零 dispatch，warn 不拦 error 拦）：id 合法性/工具名双射、schema 可派生、description 质量、kind×undoable、effects 组合、requires 服务、生命周期引用、工作流引用、端口冒烟、权限裁剪预览——详见 [doctor](./doctor.md)。
- **conformance**（CI 级测试套件，真实 invoke + 属性测试；阶段四 U5 交付 `@geoverse-sar/conformance`）：schema 派生往返、dryRun 纯性、写能力 `invert∘apply` 可逆性（fast-check）、effects 声明与实际行为一致性探针、outputSchema 履约。doctor 绿 + conformance 绿 + 文档齐 = certified pack。

目录规模化配套（U0-6）：`catalog.search` 元能力让模型在循环中自己检索目录（结果按调用方权限裁剪）；planner 侧 `CatalogSelector` 按 goal 收窄工具子集（runtime 元能力恒钉住）。**不要**把能力清单写进 system prompt——目录每 run 动态重取，权限变化即时生效（红线三）。
