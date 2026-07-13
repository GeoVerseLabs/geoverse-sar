---
'@geoverse-sar/kernel': patch
'@geoverse-sar/agent': patch
'@geoverse-sar/otel': patch
---

阶段三 Gate 1 · G1-2：EffectDescriptor 效应元数据 + agent 审批门 effect-aware。

修复外部复评 **P0-3**「Effect 模型停留 read/write/action——`action` 中的危险操作可能不经审批」。

- **kernel**：新增 `EffectDescriptor { state: none|reversible|irreversible, external: none|read|write, approval: never|policy|always, idempotency: none|keyed }` 与 `resolveEffects(kind, effects?)`。`kind` 只管目录路由，`effects` 才是预览/审批/重试/补偿判据。`Capability.effects?`（`Partial`，覆盖 kind 缺省：read→approval never、write→approval policy、action→approval never）。`CapabilityDescriptor`/`PaletteItem`/`MiddlewareContext` 恒携带**解析后的完整 effects**（"每个能力都有效应元数据"缺省即成立）。
- **agent**：审批门从 `kind === 'write'` 升级为 `effects.approval !== 'never'`——声明 `approval:'always'` 的危险 action（外部写/不可逆）由此会过门；且对 `external!=='none'` 或 `state==='irreversible'` 的能力**跳过 dryRun 预览**（预览下 handler 仍执行只拦状态写入，避免预览触发外部/不可逆副作用），审批仍生效但无 diff。观察面 `catalog` 每项带 `effects`。effects 缺席时退化到 `kind==='write'` 兼容。
- **otel**：invoke span 带 `sar.effect_state`/`sar.effect_external`/`sar.effect_approval`。

契约测试：kernel `effects.test.ts`（resolveEffects 三态缺省 + Partial 覆盖 + 描述符/palette 携带完整 effects）+ agent `effects.test.ts`（危险 action 过门且 external 跳过预览副作用不触发 + write approval:never 豁免）。全仓 311 测四门禁全绿。
