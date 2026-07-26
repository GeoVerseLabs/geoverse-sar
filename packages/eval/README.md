# @geoverse-sar/eval

SAR 的**确定性评测闭环**（阶段四 U2，RFC-0011）：scenario = 装配工厂 + 计划（脚本化动作序列 / goal + LlmClient）+ **声明式断言**；runner 把终态规范化哈希（跑三遍逐字节相同=确定性判据）。断言白名单靠**构造**——`ScenarioExpect` 只有终态/撤销深度/审计序列/结局这些形状，"对 LLM 输出文本做匹配"在类型上就不存在。

```ts
import { runScenario, runScenarios, createScriptedLlm } from '@geoverse-sar/eval';

const r = await runScenario({
  id: 'translate-undo',
  setup: ({ middleware }) => ({
    kernel: createKernel({ engine, algebra, packs, middleware }),
  }),
  plan: [
    {
      invoke: { capabilityId: 'records.translate', input: { ids: ['p1'], dx: 5, dy: 0 } },
    },
    { undo: 1 },
  ],
  expect: { undoDepth: 0, entities: [{ id: 'p1', match: { x: 0 } }] },
});
```

- **deterministic 档**进 CI（scripted 步 / goal+`createScriptedLlm`）；live 档（真 LLM 报告）随 Provider 恢复后补——报告是数据不是门。
- **evolution 准入**：L2 合成 workflow 的 enable 前置=`runScenarios` 在含合成物的沙箱 kernel 上全绿（见 tests/evolution-admission）；L1 修订落地前后对同一集对比。
- 指南：`sar/docs/eval.md`；设计：vault `docs/rfc/0011-sar-eval-harness.md`。
