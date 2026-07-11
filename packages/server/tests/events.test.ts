/**
 * S3 验收：WS 事件与本地 EventBus 序列一致（EventBus 直桥，JSON 往返后逐帧全等）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SarEvent } from '@geoverse-sar/kernel';
import { remote, startHarness, waitFor, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('WS 事件桥', () => {
  it('远程事件序列 ≡ 本地 EventBus 序列（JSON 往返全等，含顺序）', async () => {
    const localSeq: SarEvent[] = [];
    const remoteSeq: SarEvent[] = [];
    const offLocal = h.kernel.events.on((e) => localSeq.push(e));

    const rc = remote(h.base, 'tok-admin');
    const offRemote = rc.onEvent((e) => remoteSeq.push(e));
    await rc.eventsReady(); // 懒连接：就绪后帧不再丢

    await rc.invoke('records.add', { records: [{ id: 'ev-1', x: 1, y: 2 }] });
    await rc.invoke('records.translate', { ids: ['ev-1'], dx: 1, dy: 0 });
    await rc.invoke('no.such.capability'); // 失败也入流（invoke:end ok:false）

    await waitFor(() => remoteSeq.length >= localSeq.length && localSeq.length > 0);
    expect(remoteSeq).toEqual(JSON.parse(JSON.stringify(localSeq)));
    // 序列覆盖三类帧：invoke:start / engine:transaction / invoke:end
    const types = new Set(remoteSeq.map((e) => e.type));
    expect(types.has('invoke:start')).toBe(true);
    expect(types.has('invoke:end')).toBe(true);
    expect(types.has('engine:transaction')).toBe(true);

    offLocal();
    offRemote();
    rc.close();
  });

  it('解绑后不再收帧；close 后 socket 释放', async () => {
    const seen: SarEvent[] = [];
    const rc = remote(h.base, 'tok-admin');
    const off = rc.onEvent((e) => seen.push(e));
    await rc.eventsReady();
    await rc.invoke('records.query', {});
    await waitFor(() => seen.length >= 2);
    off();
    const frozen = seen.length;
    await rc.invoke('records.query', {});
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.length).toBe(frozen);
    rc.close();
  });

  it('坏 token 的 WS 连接被拒（onSocketDown 触发，不收帧）', async () => {
    let down = false;
    const seen: SarEvent[] = [];
    const rc = remote(h.base, 'tok-nobody', { onSocketDown: () => (down = true) });
    rc.onEvent((e) => seen.push(e));
    await waitFor(() => down);
    expect(seen.length).toBe(0);
    rc.close();
  });
});
