import { describe, expect, it } from 'vitest';
import type { EditableFeature } from '@geoverse-sar/engine-geo';
import { featureSchema, type GeoFeature } from '@geoverse-sar/geo-profile';

/**
 * geo-profile 与 editor-core 的"同构不互引"钉子（ADR-0015）：
 * GeoFeature 与 EditableFeature 靠 TS 结构类型双向可赋值——editor-core 若改
 * 要素形状，这里先红，"同构"从口头约定变成编译期结构事实。
 * （本测试放 capabilities-geo：唯一同时依赖两者的包；geo-profile 保持叶子零依赖。）
 */
describe('GeoFeature ≅ EditableFeature（类型级断言）', () => {
  it('双向可赋值 + featureSchema 输出可直接喂给引擎侧类型', () => {
    // 编译期断言：任一方向赋值失败都会让本文件 typecheck 红
    const toEditable = (f: GeoFeature): EditableFeature => f;
    const toProfile = (f: EditableFeature): GeoFeature => f;

    const parsed = featureSchema.parse({
      id: 'f1',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { name: '样例' },
    });
    const editable: EditableFeature = parsed; // schema 输出是 GeoFeature 的子类型

    expect(toEditable(toProfile(editable)).id).toBe('f1');
  });
});
