/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  resolveEffects,
  type Capability,
  type CapabilityKind,
  type CapabilityPack,
  type EffectDescriptor,
} from './capability';
import { SarError } from './errors';
import { isGranted, type CallerInfo } from './permissions';
import { inputJsonSchemaOf, outputJsonSchemaOf, type JsonSchema } from './schema-utils';

/**
 * 唯一序列化边界（ADR-0010）：与 Claude/MCP 工具定义逐字段对齐
 * （id≡name / description≡description / inputJsonSchema≡input_schema）。
 */
export interface CapabilityDescriptor {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: CapabilityKind;
  /** 解析后的完整效应元数据（G1-2）：目录消费方（agent 审批门/UI 徽章）据此判断风险。 */
  effects: EffectDescriptor;
  tags?: readonly string[];
  permissions?: readonly string[];
  undoable?: boolean;
  /** 生命周期元数据（阶段四 U0）：全部可选、additive——wire/工具映射对多余字段天然兼容。 */
  since?: string;
  deprecated?: boolean | string;
  replacedBy?: string;
  inputJsonSchema: JsonSchema;
  outputJsonSchema: JsonSchema;
}

export interface DescribeFilter {
  /** 权限化目录裁剪：模型看不见即调不到。 */
  caller?: CallerInfo;
  category?: string;
  kind?: CapabilityKind;
  tag?: string;
}

export class CapabilityRegistry<TEntity = any, TDiff = any> {
  private caps = new Map<string, Capability<any, any, TEntity, TDiff>>();
  private descriptors = new Map<string, CapabilityDescriptor>();

  register(cap: Capability<any, any, TEntity, TDiff>): void {
    if (this.caps.has(cap.id)) {
      throw new SarError('capability_conflict', `能力 id 已注册: ${cap.id}`);
    }
    this.caps.set(cap.id, cap);
  }

  registerPack(pack: CapabilityPack<TEntity, TDiff>): void {
    for (const cap of pack.capabilities) this.register(cap);
  }

  get(id: string): Capability<any, any, TEntity, TDiff> | undefined {
    return this.caps.get(id);
  }

  has(id: string): boolean {
    return this.caps.has(id);
  }

  list(): Capability<any, any, TEntity, TDiff>[] {
    return [...this.caps.values()];
  }

  describe(id: string): CapabilityDescriptor {
    const cap = this.caps.get(id);
    if (!cap) throw new SarError('capability_not_found', `能力不存在: ${id}`);
    let d = this.descriptors.get(id);
    if (!d) {
      d = {
        id: cap.id,
        title: cap.title,
        description: cap.description,
        category: cap.category,
        kind: cap.kind,
        effects: resolveEffects(cap.kind, cap.effects),
        tags: cap.tags,
        permissions: cap.permissions,
        undoable: cap.undoable ?? cap.kind === 'write',
        since: cap.since,
        deprecated: cap.deprecated,
        replacedBy: cap.replacedBy,
        inputJsonSchema: inputJsonSchemaOf(cap.inputSchema),
        outputJsonSchema: outputJsonSchemaOf(cap.outputSchema),
      };
      this.descriptors.set(id, d);
    }
    return d;
  }

  describeAll(filter: DescribeFilter = {}): CapabilityDescriptor[] {
    return this.list()
      .filter((cap) => {
        if (filter.caller && !isGranted(cap.permissions, filter.caller)) return false;
        if (filter.category && cap.category !== filter.category) return false;
        if (filter.kind && cap.kind !== filter.kind) return false;
        if (filter.tag && !(cap.tags ?? []).includes(filter.tag)) return false;
        return true;
      })
      .map((cap) => this.describe(cap.id));
  }

  /** 关键词发现：命中 id / title / description / tags（大小写不敏感）。 */
  discover(query: string, filter: DescribeFilter = {}): CapabilityDescriptor[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.describeAll(filter);
    return this.describeAll(filter).filter((d) =>
      [d.id, d.title, d.description, ...(d.tags ?? [])]
        .join('\n')
        .toLowerCase()
        .includes(q),
    );
  }
}
