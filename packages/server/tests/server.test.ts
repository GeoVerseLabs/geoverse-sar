/**
 * S3 验收（目标架构 §五）：
 * - 本地/远程平价：同 invoke 同 outcome（wire 就是 InvokeOutcome，去时序位后全等）；
 * - token→caller 强制注入：请求体伪造 caller 无效、目录按 token 身份裁剪、未知 token 401；
 * - 传输层语义：400/404/405/426 只表达传输，能力失败永远是 200 + ok:false。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN,
  buildKernel,
  local,
  remote,
  startHarness,
  stripTiming,
  type Harness,
} from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('本地/远程入口平价', () => {
  it('catalog：远程目录与本地 clientOf 同 caller 逐字节相等', async () => {
    const rc = remote(h.base, 'tok-admin');
    const [remoteCat, localCat] = await Promise.all([
      rc.catalog(),
      local(h.kernel, ADMIN).catalog(),
    ]);
    expect(remoteCat).toEqual(JSON.parse(JSON.stringify(localCat)));
    expect(remoteCat.length).toBeGreaterThan(0);
  });

  it('catalog：filter（kind/category）经查询串透传', async () => {
    const rc = remote(h.base, 'tok-admin');
    const reads = await rc.catalog({ kind: 'read' });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((d) => d.kind === 'read')).toBe(true);
    const tests = await rc.catalog({ category: 'test' });
    expect(tests.map((d) => d.id).sort()).toEqual(['test.guarded', 'test.slow']);
  });

  it('invoke：双胞胎内核同参写入 → 去 durationMs 后 outcome 全等（含 diff）', async () => {
    // 远端 harness 内核 vs 本地新建同构内核：显式 id 保证确定性
    const twin = buildKernel();
    const input = { records: [{ id: 'r-1', x: 3, y: 4, props: { name: 'A' } }] };
    const rc = remote(h.base, 'tok-admin');
    const [ro, lo] = await Promise.all([
      rc.invoke('records.add', input),
      local(twin, ADMIN).invoke('records.add', input),
    ]);
    expect(ro.ok).toBe(true);
    expect(stripTiming(ro)).toEqual(JSON.parse(JSON.stringify(stripTiming(lo))));
    twin.dispose();
  });

  it('invoke：dryRun 透传——返回 diff 但远端状态不变', async () => {
    const rc = remote(h.base, 'tok-admin');
    const before = h.kernel.engine.snapshot().entities.size;
    const out = await rc.invoke(
      'records.add',
      { records: [{ x: 9, y: 9 }] },
      { dryRun: true },
    );
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    expect(out.diff).toBeDefined();
    expect(h.kernel.engine.snapshot().entities.size).toBe(before);
  });

  it('invoke：显式 traceId/runId 经 wire 透传并回写（G1-1 执行身份贯穿远程）', async () => {
    const rc = remote(h.base, 'tok-admin');
    const out = await rc.invoke(
      'records.add',
      { records: [{ id: 'r-trace', x: 1, y: 1 }] },
      { traceId: 'tr_fixed_1', runId: 'run_fixed_1' },
    );
    expect(out.ok).toBe(true);
    // 服务端不因请求身份而生成新 id——回写的正是客户端给的，整条长任务同标识
    expect(out.traceId).toBe('tr_fixed_1');
    expect(out.runId).toBe('run_fixed_1');
  });

  it('invoke：能力级失败（未知能力）是 200 + ok:false，与本地同构', async () => {
    const rc = remote(h.base, 'tok-admin');
    const [ro, lo] = await Promise.all([
      rc.invoke('no.such.capability'),
      local(h.kernel, ADMIN).invoke('no.such.capability'),
    ]);
    expect(ro.ok).toBe(false);
    expect(stripTiming(ro)).toEqual(JSON.parse(JSON.stringify(stripTiming(lo))));
    expect(ro.error?.code).toBe('capability_not_found');
  });

  it('checkpoint 路由糖 = invoke(runtime.checkpoint)（未注入服务 → service_missing）', async () => {
    const res = await fetch(`${h.base}/checkpoint`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-admin' },
    });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('service_missing');
  });

  it('取消平价：signal 中止 → aborted outcome（不抛），远端不落地', async () => {
    const rc = remote(h.base, 'tok-admin');
    const ac = new AbortController();
    const p = rc.invoke('test.slow', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const out = await p;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('aborted');
  });
});

describe('token→CallerInfo 强制注入', () => {
  it('viewer 目录被裁剪（看不见 test.guarded），invoke 同一判定兜底', async () => {
    const rc = remote(h.base, 'tok-viewer');
    const cat = await rc.catalog();
    expect(cat.some((d) => d.id === 'test.guarded')).toBe(false);
    const out = await rc.invoke('test.guarded', {});
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('permission_denied');
  });

  it('请求体伪造 caller 字段不生效（身份只来自 token）', async () => {
    const res = await fetch(`${h.base}/invoke`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok-viewer',
        'Content-Type': 'application/json',
      },
      // 伪造成全权 program caller——wire 上没有身份位，该字段根本不被读取
      body: JSON.stringify({
        id: 'test.guarded',
        input: {},
        caller: { entry: 'program' },
      }),
    });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('permission_denied');
  });

  it('未知/缺失 token → 401（传输层，抛异常而非 outcome）', async () => {
    await expect(remote(h.base, 'tok-nobody').catalog()).rejects.toThrow(/401/);
    const res = await fetch(`${h.base}/catalog`);
    expect(res.status).toBe(401);
  });
});

describe('传输层语义', () => {
  const auth = { Authorization: 'Bearer tok-admin' };

  it('未知工作区 404', async () => {
    const res = await fetch(`${h.origin}/workspaces/nope/catalog`, { headers: auth });
    expect(res.status).toBe(404);
  });

  it('坏 JSON / 缺 id → 400', async () => {
    const bad = await fetch(`${h.base}/invoke`, {
      method: 'POST',
      headers: auth,
      body: '{oops',
    });
    expect(bad.status).toBe(400);
    const noId = await fetch(`${h.base}/invoke`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ input: {} }),
    });
    expect(noId.status).toBe(400);
  });

  it('方法不符 405；events 端点 HTTP 直访 426', async () => {
    const post = await fetch(`${h.base}/catalog`, { method: 'POST', headers: auth });
    expect(post.status).toBe(405);
    const get = await fetch(`${h.base}/invoke`, { headers: auth });
    expect(get.status).toBe(405);
    const events = await fetch(`${h.base}/events`, { headers: auth });
    expect(events.status).toBe(426);
  });

  it('CORS 预检 204 + 头就位（playground 跨源用）', async () => {
    const res = await fetch(`${h.base}/invoke`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
  });
});
