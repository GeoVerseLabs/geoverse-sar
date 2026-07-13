---
'@geoverse-sar/kernel': patch
---

阶段三 Gate 0：Workflow 预览契约修复 + d.ts 假绿失败门。

- **G0-1 预览契约**：工作流以能力形式被 `invoke`/SarClient 调用时，dryRun/signal/嵌套事务组与原子能力同语义。`CapabilityContext` 增 `dryRun`/`txGroupId`，`WorkflowRunOptions` 增 `dryRun`/`signal`/`txGroupId`，投影 handler 全量透传给 `run()`：dryRun=预览事务组步进 stage 后终局 abort（引擎零写入、撤销栈不长）、signal 步间检查透传（错误码 `aborted`）、嵌套并入外层组保单一撤销单元。dispatcher 保 `SarError` 原始错误码不再压扁成 `handler_error`。修复外部复评 P0-1「以能力形式 + dryRun 调工作流内部步骤仍真实写入」。
- **G0-2 d.ts 假绿门**：`build/strict-dts` 的 `afterDiagnostic` 让声明生成阶段任一 error 级 TS 诊断使 `vite build` 非零退出；kernel/server 的 `tsconfig.build.json` 补 node types 消除此前被吞掉的 TS2591/TS2503。

kernel 新增契约测试 `workflow-preview.test.ts`（10 测），全仓 298 测四门禁全绿。
