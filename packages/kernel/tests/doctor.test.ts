import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createKernel,
  formatDoctorReport,
  runDoctor,
  type SarKernel,
  type Workflow,
} from '../src/index';
import {
  allItemCapabilities,
  ItemAlgebra,
  ItemEngine,
  itemGet,
  type Item,
  type ItemDiff,
} from './helpers';

function healthyKernel(workflows: Workflow[] = []): SarKernel<Item, ItemDiff> {
  return createKernel<Item, ItemDiff>({
    engine: new ItemEngine([{ id: 'a', value: 1 }]),
    algebra: new ItemAlgebra(),
    packs: [{ id: 'item', capabilities: allItemCapabilities() }],
    workflows,
    services: { view: { focus: () => {} } },
  });
}

describe('runDoctor（装配体检）', () => {
  it('健康装配 → ok，且给出 doctor.ok 检查项', () => {
    const report = runDoctor(healthyKernel());
    expect(report.ok).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.summary.capabilities).toBe(7);
    expect(report.checks.some((c) => c.id === 'doctor.ok')).toBe(true);
  });

  it('id 含 __ → error（破坏工具名双射），并检出与点分 id 的工具名冲突', () => {
    const kernel = healthyKernel();
    kernel.registry.register({
      ...itemGet,
      id: 'item__get',
      title: '坏 id',
      description: '这个 id 会与 item.get 的工具名投影冲突。',
    });
    const report = runDoctor(kernel);
    expect(report.ok).toBe(false);
    const ids = report.checks.map((c) => c.id);
    expect(ids).toContain('capability.id');
    expect(ids).toContain('capability.tool-name-clash');
  });

  it('description 过短 → warn（不拦 ok）', () => {
    const kernel = healthyKernel();
    kernel.registry.register({ ...itemGet, id: 'item.terse', description: '短' });
    const report = runDoctor(kernel);
    expect(report.ok).toBe(true);
    const check = report.checks.find(
      (c) => c.id === 'capability.description' && c.target === 'item.terse',
    );
    expect(check?.level).toBe('warn');
  });

  it('requires 声明的服务未注册 → error 并附注入提示', () => {
    const kernel = healthyKernel();
    kernel.registry.register({
      ...itemGet,
      id: 'item.needsGeo',
      description: '依赖未注册服务的能力，用于体检测试。',
      requires: ['geoView'],
    });
    const report = runDoctor(kernel);
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.id === 'capability.requires');
    expect(check?.target).toBe('item.needsGeo');
    expect(check?.hint).toContain('services');
  });

  it('工作流引用未注册能力 / 步骤 id 重复 → error', () => {
    const wf: Workflow = {
      id: 'wf.broken',
      title: '坏工作流',
      description: '引用不存在的能力且步骤 id 重复。',
      inputSchema: z.object({}),
      undo: 'macro',
      steps: [
        { id: 's1', capability: 'item.get', input: { id: 'a' } },
        { id: 's1', capability: 'item.ghost', input: {} },
      ],
    };
    const report = runDoctor(healthyKernel([wf]));
    expect(report.ok).toBe(false);
    const ids = report.checks.map((c) => c.id);
    expect(ids).toContain('workflow.step-id');
    expect(ids).toContain('workflow.step-ref');
  });

  it("macro 工作流无 write 步 → warn（建议 undo:'none'）", () => {
    const wf: Workflow = {
      id: 'wf.readonly',
      title: '纯读宏',
      description: '只有 read 步却声明 macro 撤销。',
      inputSchema: z.object({}),
      undo: 'macro',
      steps: [{ id: 'look', capability: 'item.get', input: { id: 'a' } }],
    };
    const report = runDoctor(healthyKernel([wf]));
    const check = report.checks.find((c) => c.id === 'workflow.macro');
    expect(check?.level).toBe('warn');
  });

  it('权限裁剪预览：给 caller 时报告其不可见能力', () => {
    const report = runDoctor(healthyKernel(), {
      caller: { entry: 'ai', grantedPermissions: [] },
    });
    const check = report.checks.find((c) => c.id === 'permissions.trim-preview');
    expect(check?.message).toContain('item.secret');
  });

  it('formatDoctorReport 可读输出（含图标与 hint 缩进）', () => {
    const text = formatDoctorReport(runDoctor(healthyKernel()));
    expect(text).toContain('SAR doctor：通过');
    expect(text).toContain('✔ [doctor.ok]');
  });
});
