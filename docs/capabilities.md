# 写一个能力包

能力包 = `CapabilityPack { id, capabilities: Capability[] }`，经 `createKernel({ packs: [...] })` 注册。以下按 `capabilities-records` 的真实实现讲要点。

## 最小能力

```ts
import { z } from 'zod';
import type { Capability } from '@geoverse-sar/kernel';

const queryInput = z.object({
  propsEquals: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('属性全等匹配，如 {"type":"poi"}'),
});
const queryOutput = z.object({ records: z.array(recordSchema), count: z.number() });

const query: Capability<
  z.infer<typeof queryInput>,
  z.infer<typeof queryOutput>,
  RecordEntity,
  RecordDiff
> = {
  id: 'records.query',
  title: '查询记录',
  description: '按属性全等过滤查询点记录。只读、无副作用；写操作前先用它确认目标记录。',
  category: 'records',
  kind: 'read',
  inputSchema: queryInput,
  outputSchema: queryOutput,
  handler: async (ctx, input) => {
    let records = ctx.state.list(); // ctx.state：读一致视图（宏组内是投影态）
    // ...过滤
    return { output: { records, count: records.length } };
  },
};
```

## 逐条要点

- **id**：点分层级（`域.动作`），字符集 `[A-Za-z0-9._-]`，**禁止 `__`**（AI 入口工具名 `.`↔`__` 双射会歧义）——doctor 会检查。
- **description 是给模型读的**：逐字进 AI 工具目录，写清**何时该调**、副作用、可否撤销（≥15 字，doctor 会警告过短）。字段级说明用 `.describe()`。
- **kind 三态**：
  - `read`：handler 返回 `{ output }`，从 `ctx.state` 读。
  - `write`：handler 返回 `{ output, commands }`（推荐，Command 是纯 planner）或 `{ output, diff }`；应用/撤销/事件由引擎负责。**一次 invoke 的多条命令自动折叠为一个撤销单元**。
  - `action`：有副作用但非 diff（视野聚焦、undo/redo），返回 `{ output }`。
- **requires**：handler 依赖宿主服务时声明键名，如 `requires: ['view']`——dispatcher 在入口校验（缺失报 `service_missing` 而非 handler 深处裸错），doctor 启动期即可发现。

```ts
const focus: Capability<...> = {
  id: 'view.focus',
  kind: 'action',
  requires: [VIEW_SERVICE_KEY],
  handler: async (ctx, input) => {
    const view = ctx.services.require<ViewService>(VIEW_SERVICE_KEY);
    // ...
  },
};
```

- **权限**：`permissions: ['records:write']` + 调用方 `grantedPermissions` 白名单；目录裁剪（describeAll/toToolSpecs）与 invoke 强制用同一判定。
- **出参也校验**：handler 输出过不了 `outputSchema` 会报 `handler_error`——描述符即承诺。

## write 能力的 Command

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
        if (!before) throw new Error(`记录不存在: ${id}`); // plan 抛错 → invoke 失败、状态零污染
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

`plan` 必须纯：读 `state`、算 diff、不改任何东西。宏事务组内它收到的是**投影态**（叠加了前序步骤的缓冲 diff）。

## 上线前

```ts
import { runDoctor, formatDoctorReport } from '@geoverse-sar/kernel';
console.log(formatDoctorReport(runDoctor(kernel)));
```

doctor 会检查 id 合法性、工具名双射冲突、schema 可派生、description 质量、requires 服务齐备、工作流引用完整——详见 [doctor.md](./doctor.md)。
