# @geoverse-sar/conformance

能力包**认证套件**（阶段四 U5-A，RFC-0012 / ADR-0018）：一行把 8 项检查挂进你的 vitest——doctor 委托、schema 派生往返、description lint、dryRun 纯性、写能力 `invert∘apply` 可逆性（fast-check 属性测试）、effects 声明一致性探针、非法组合、outputSchema 履约。独立包（kernel「只依赖 zod」硬不变量排除子导出方案）。

```ts
import { createCapabilityPackTestSuite } from '@geoverse-sar/conformance';
import { describe, expect, it } from 'vitest';

createCapabilityPackTestSuite(
  'my-pack',
  {
    pack: createMyPack(),
    createHarness: () => ({
      kernel: createKernel({ engine, algebra, packs: [createMyPack()] }),
    }),
    samples: { 'my.buffer': [{ id: 'a', distance: { value: 5, unit: 'm' } }] },
  },
  { describe, it, expect }, // vitest hooks 注入——坏包判红本身可测
);
```

- 纯函数形态 `runConformance(opts)` 返回结构化报告（不依赖测试框架），vitest 绑定只是投影。
- 认证流程：**doctor errors=0 → conformance 全绿 → 文档标 certified**（见 `sar/docs/extending.md` §七）。
- 自证：仓内 `capabilities-records` / `capabilities-geo` 两包吃同一套件；故意坏包（dryRun 泄写/effects 撒谎）判红用例钉死检查器本身。
