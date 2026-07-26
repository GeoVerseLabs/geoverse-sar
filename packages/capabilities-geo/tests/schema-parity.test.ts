import { describe, expect, it } from 'vitest';
import { createKernel } from '@geoverse-sar/kernel';
import {
  ChangeSetAlgebra,
  createGeoEngine,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import {
  createGeoHighlightAndNudgeWorkflow,
  createGeoPack,
  createMemoryGeoViewService,
  VIEW_SERVICE_KEY,
} from '../src/index';

/**
 * U0-3 迁移护栏：capabilities-geo 的内联共享 schema 收敛到 @geoverse-sar/geo-profile
 * 前后，AI 入口看到的 JSON Schema 必须逐字节不变——schema 是唯一序列化边界，
 * 派生细节漂移会静默打破模型侧的工具规格缓存与 few-shot 假设。
 * 快照在迁移前生成（基线=内联版），迁移后本测试必须原样通过。
 */
describe('U0-3 schema 迁移平价', () => {
  it('全部 geo 能力（含工作流投影）的 input/output JSON Schema 快照不变', () => {
    const kernel = createKernel<EditableFeature, ChangeSet>({
      engine: createGeoEngine({ features: [] }),
      algebra: new ChangeSetAlgebra(),
      packs: [createGeoPack()],
      workflows: [createGeoHighlightAndNudgeWorkflow()],
      services: { [VIEW_SERVICE_KEY]: createMemoryGeoViewService() },
    });
    const catalog = kernel
      .describeAll()
      .map((d) => ({ id: d.id, input: d.inputJsonSchema, output: d.outputJsonSchema }));
    expect(JSON.stringify(catalog, null, 2)).toMatchSnapshot();
  });
});
