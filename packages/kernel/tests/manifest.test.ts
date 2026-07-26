/**
 * U5-C 声明式清单能力（RFC-0012 §三）：JSON manifest → 只读 HTTP 能力。
 * 断言面：载入即校验（坏清单结构化拒绝）、url 占位/查询串组装与编码、
 * outputPick 取值、外访必须经注入的 fetch 服务（service_missing 可证）、
 * effects 固定只读、非 2xx 结构化上抛。
 */
import { describe, expect, it } from 'vitest';
import {
  capabilitiesFromManifest,
  createKernel,
  MANIFEST_FETCH_SERVICE_KEY,
  type ManifestFetch,
} from '../src/index';
import { ItemAlgebra, ItemEngine, type Item, type ItemDiff } from './helpers';

const GEOCODE_MANIFEST = {
  id: 'ext.geocode',
  title: '地名解析',
  description: '把地名文本解析为经纬度坐标（外部只读查询端点）。',
  url: 'https://geo.example.com/v1/geocode/{place}',
  params: {
    place: { type: 'string', description: '地名文本' },
    limit: { type: 'number', required: false },
  },
  headers: { 'x-api-key': 'demo' },
  outputPick: 'result.location',
};

function fakeFetch(
  respond: (url: string) => { status: number; body: unknown },
): ManifestFetch & { calls: { url: string; init?: unknown }[] } {
  const calls: { url: string; init?: unknown }[] = [];
  const fn: ManifestFetch = async (url, init) => {
    calls.push({ url, init });
    const { status, body } = respond(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return Object.assign(fn, { calls });
}

function makeKernel(fetchService?: ManifestFetch) {
  return createKernel<Item, ItemDiff>({
    engine: new ItemEngine([]),
    algebra: new ItemAlgebra(),
    packs: [{ id: 'ext', capabilities: capabilitiesFromManifest([GEOCODE_MANIFEST]) }],
    ...(fetchService ? { services: { [MANIFEST_FETCH_SERVICE_KEY]: fetchService } } : {}),
  });
}

describe('capabilitiesFromManifest', () => {
  it('载入即校验：坏清单结构化拒绝，不进目录', () => {
    expect(() => capabilitiesFromManifest([{ id: 'x' }])).toThrow(/清单 #0 非法/);
    expect(() =>
      capabilitiesFromManifest([{ ...GEOCODE_MANIFEST, url: 'ftp://x/y' }]),
    ).toThrow(/http\/https/);
    expect(() =>
      capabilitiesFromManifest([{ ...GEOCODE_MANIFEST, description: '太短' }]),
    ).toThrow(/15/);
    expect(() =>
      capabilitiesFromManifest([{ ...GEOCODE_MANIFEST, method: 'POST' }]),
    ).toThrow(/清单 #0 非法/); // 只读通道：只认 GET
  });

  it('effects 固定只读 + requires 声明 fetch 服务；描述符 schema 带参数形状', () => {
    const kernel = makeKernel(fakeFetch(() => ({ status: 200, body: {} })));
    const d = kernel.registry.describe('ext.geocode');
    expect(d.effects).toMatchObject({
      state: 'none',
      external: 'read',
      approval: 'never',
      idempotency: 'keyed',
    });
    const props = (d.inputJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(props ?? {}).sort()).toEqual(['limit', 'place']);
  });

  it('url 占位替换（URL 编码）+ 余参进查询串 + headers 透传 + outputPick 取值', async () => {
    const fetchService = fakeFetch(() => ({
      status: 200,
      body: { result: { location: { x: 118.1, y: 24.5 }, raw: 'noise' } },
    }));
    const kernel = makeKernel(fetchService);
    const out = await kernel.invoke<{ data: unknown }>('ext.geocode', {
      place: '厦门 大学',
      limit: 3,
    });
    expect(out.ok).toBe(true);
    expect(out.output!.data).toEqual({ x: 118.1, y: 24.5 });
    expect(fetchService.calls[0].url).toBe(
      `https://geo.example.com/v1/geocode/${encodeURIComponent('厦门 大学')}?limit=3`,
    );
    expect(fetchService.calls[0].init).toMatchObject({
      method: 'GET',
      headers: { 'x-api-key': 'demo' },
    });
  });

  it('外访必须经注入服务：未注册 fetch → service_missing（外访无旁路）', async () => {
    const kernel = makeKernel(undefined);
    const out = await kernel.invoke('ext.geocode', { place: 'x' });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('service_missing');
  });

  it('非 2xx → handler_error 结构化上抛（含状态码与截断体）', async () => {
    const kernel = makeKernel(fakeFetch(() => ({ status: 503, body: { msg: 'down' } })));
    const out = await kernel.invoke('ext.geocode', { place: 'x' });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('handler_error');
    expect(out.error?.message).toContain('503');
  });
});
