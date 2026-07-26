# 扩展指南：为 SAR 写扩展包

> 读者是**包作者**：你要给 SAR 添一个能力包、接一个引擎、挂一个外部工具源。逐条款的能力书写规范（字段、kind×effects、schema 纪律）在 [capabilities.md](./capabilities.md)——那是 normative 规范，本篇是生态视角的路线与红线。设计动机见内部 vault 的 RFC-0012。

## 一、扩展物全景

SAR 的扩展面一共四类，全部**不改内核**：

| 扩展物     | 形态                                                | 先例                                                            |
| ---------- | --------------------------------------------------- | --------------------------------------------------------------- |
| 能力包     | `CapabilityPack`（一组 Capability + 可选 workflow） | `capabilities-records` / `capabilities-geo`                     |
| 引擎       | `StateEngine<TEntity,TDiff>` + `DiffAlgebra`        | `engine-memory` / `engine-geo`（见 [engines.md](./engines.md)） |
| 宿主服务   | `services` 注入的任意对象（能力经 `requires` 声明） | view 服务 / kb 服务 / `runtime.fetch`                           |
| 外部工具源 | MCP-in 桥 / 声明式清单（见 §九选型）                | `createMcpCapabilityPack` / `capabilitiesFromManifest`          |

支撑三件套：`geo-profile`（geo 规范 schema，叶子包）、`eval`（scenario 确定性回归）、`conformance`（能力包认证套件）。

## 二、依赖红线（ESLint 机器强制，违则 lint 红）

1. **kernel 只依赖 zod**——禁止 import geoverse 包、地图库、同仓其它包。geo 类型永不进 kernel（grep 可证）。
2. **依赖只能由外向内**：入口层 → 能力层/组装层 → 引擎层 → kernel。
3. **geo 能力必须经 engine-geo 桥**——`capabilities-geo`（以及你的 geo 能力包）禁止直连 `@geoverse/*`；几何运算走桥（`GeoEngineHandle` / 几何算子桥），编辑复用 geoverse `EditEngine`，**不重做** geoverse 的 sync/history/EditSession。
4. **外访必须经 services 注入**——能力 handler 里不准直接 `fetch`/建连；外部访问经 `requires` 声明的服务进来（可测、可换、可探针——conformance 的 effects 一致性检查靠它）。
5. **job/外部工具不绕漏斗**——后台任务完成落地必须回 `invoke`；`JobManager` 结构上拿不到引擎引用。

## 三、命名空间与 id

- 能力 id：`<domain>.<verb>`（如 `records.translate`）；第三方包加 vendor 前缀（`acme.routing.solve`）。`.` 与 `__` 双射（Claude 工具名不含 `.`），所以 **id 不得含 `__`**。
- MCP-in 桥：`mcp.<namespace>.<tool>`，namespace 字符集 `[A-Za-z0-9_-]`。
- 服务键：runtime 保留 `runtime.*`（`runtime.jobs` / `runtime.sets` / `runtime.resources` / `runtime.fetch`…）；领域服务用短名（`view` / `kb`）或 vendor 前缀。
- 包 id（`CapabilityPack.id`）与 npm 包名不必一致，但目录里要稳定——审计、prompt profile、conformance 报告都按它归组。

## 四、geo-profile 的使用时机

- **跨包共享的 geo 原语**（Geometry/Feature/FeatureRef/BBox/CRSRef/Quantity）一律从 `@geoverse-sar/geo-profile` 取——不要在自己的包里再抄一份 schema；它是叶子包（只依赖 zod），任何层都能安全引用。
- **包私有的入参 schema 留在包内**：geo-profile 收敛的是"语言"，不是你的业务形状。
- **数量必须带单位**：长度/面积/距离入参用 `quantitySchema`，handler 用 `resolveQuantity` 换算——"buffer 500 不知道是米还是度"这类事故由 schema 层杜绝，**永远不猜单位**。
- 坐标语义：能力面契约固定 WGS-84 经纬度（`CRSRef` 只在数据面元信息出现），工作 CRS 是引擎内部事。

## 五、宿主服务约定

- 能力用 `requires: ['服务键']` 声明依赖，dispatcher 前置校验（缺失 → `service_missing`，不会跑到 handler 里半途炸）。
- 服务是**端口**：定义最小结构面（interface），内存参考实现随包给（`createMemoryViewService` / `createMemoryKb` 先例），生产宿主可换实现、能力零改动。
- 服务对象不进描述符、不进 wire——它只存在于宿主装配处；远程模式下服务在服务端。

## 六、prompt profile 的边界

包作者可随包携带 `promptProfile`（`PackPromptProfile`），宿主传给 planner `profiles` 构造期拼进 system：

- 只写"何时怎么用"的**经验层**：调用顺序惯例、单位约定、常见误用。
- **不复述目录与 schema**——那是描述符投影的职责，写了就是双份事实源。
- 上限强制：usageNotes ≤ 800 字、few-shot ≤ 3 条，超限构造即抛。
- few-shot 的 `input` 必须能过对应能力的 `inputSchema`；L1 调优报告（`createTuningReport`）产出的 few-shot 素材经人审后回填到这里。

## 七、认证流程：doctor → conformance → certified

发布一个能力包前的三级门：

1. **doctor errors = 0**：`runDoctor(kernel)` 装配体检通过（目录冲突/双射/schema 派生/requires 服务/工作流引用）。
2. **conformance 全绿**：用 `@geoverse-sar/conformance` 的 `createCapabilityPackTestSuite(name, { pack, createHarness })` 挂进你的 vitest——8 项检查（doctor 委托 / schema 往返 / description lint / dryRun 纯性 / 写能力可逆性 fast-check / effects 声明一致性 / 非法组合 / outputSchema 履约）。
3. **文档声明 certified**：README 注明 conformance 通过的版本与检查档位（strict 与否）。

```ts
import { createCapabilityPackTestSuite } from '@geoverse-sar/conformance';
import { describe, expect, it } from 'vitest';

createCapabilityPackTestSuite(
  'acme-routing',
  { pack, createHarness },
  { describe, it, expect },
);
```

## 八、版本治理

- 能力元数据三字段全 optional additive：`since`（引入版本）/ `deprecated`（弃用说明）/ `replacedBy`（替代能力 id）——doctor 会告警弃用引用。
- **journal 只含 diff 不含能力 id 语义**——历史回放对能力改名/弃用免疫，放心演进目录。
- 包版本走 changesets（本仓阶段性统一 patch）；破坏性 schema 变更宁可出新能力 id + `replacedBy`，不要原地改语义。

## 九、方向路线：接入方式选型

外部功能进 SAR 的三条路，按"你控制多少代码"选：

| 你有什么                       | 走哪条路                                  | 治理面                                          |
| ------------------------------ | ----------------------------------------- | ----------------------------------------------- |
| 只读 HTTP 端点（geocode/查询） | **声明式清单** `capabilitiesFromManifest` | effects 固定只读；不图灵完备，复杂需求即拒绝    |
| 现成 MCP server                | **MCP-in 桥** `createMcpCapabilityPack`   | effects 保守缺省（外部写+审批），显式降级       |
| 需要真逻辑/写状态              | **真能力包**（本篇全部条款）              | 全量：kind×effects、conformance、prompt profile |

三条路殊途同归：都过同一 `invoke` 漏斗——权限裁剪、审计归因、审批门、guardrails 对外来工具一视同仁。这是 SAR 生态的立身之本：**通用性的最大来源不是自己写几百个能力，而是让别人的工具进你的治理体系**。

---

延伸：[capabilities.md](./capabilities.md)（逐条款规范）· [engines.md](./engines.md)（接引擎）· [eval.md](./eval.md)（回归门）· [architecture.md](./architecture.md)（不变量表）。
