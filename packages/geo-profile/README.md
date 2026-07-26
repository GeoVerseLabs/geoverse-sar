# @geoverse-sar/geo-profile

SAR 能力层的**共享 geo schema 底座**（阶段四 U0）：规范化的 Geometry / Feature / FeatureRef / BBox / CRS / `Quantity{value, unit}` Zod schema + 纯平面 bbox 工具。跨包边界交换 geo 数据时用这里的规范类型，能力私有的入参 shape 留在各自包内。

## 位置纪律（ESLint 依赖门执行）

- **叶子包**：运行时只依赖 `zod`（`geojson` 仅类型）；不依赖 kernel / editor-core / 同仓任何包。
- **kernel 永不 import 本包**——geo 类型在 kernel 旁、不在内（红线一）。
- 与 editor-core 的 `EditableFeature` **同构不互引**：靠 TS 结构类型 + capabilities-geo 侧类型级断言测试钉死。

## 导出面

```ts
import {
  positionSchema,
  bboxSchema,
  geometrySchema,
  featureSchema,
  featureRefSchema,
  featureSummarySchema,
  crsRefSchema,
  quantitySchema,
  bboxOf,
  centerOf,
  bboxIntersects,
  summarizeFeature,
  type Bbox,
  type GeoFeature,
  type FeatureRef,
  type FeatureSummary,
  type CrsRef,
  type Quantity,
  type GeoGeometry,
} from '@geoverse-sar/geo-profile';
```

- `geometrySchema` 只收 GeoJSON 六个具体类型（GeometryCollection 刻意不收——编辑面约定）；只做结构校验，几何有效性归引擎/后端。
- `quantitySchema` 消"缓冲 500——米还是度"一类静默错误：距离/长度类入参用它替代裸数字。
- **入包硬门槛**：每个导出 schema 必须可经 `z.toJSONSchema` 派生（测试钉死）。

规范条款见 `sar/docs/capabilities.md`（约束规范）；设计见 vault `docs/adr/0014-geo-profile-shared-schema.md`。
