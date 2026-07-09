# 持久化：SarStore 存储端口与流化

> 对应目标架构（共享 vault `SAR_TARGET_ARCHITECTURE.md`）R1+R2。本篇覆盖存储端口、
> journal/audit 流化（sink）与裸恢复；`openWorkspace` 完整恢复算法随后续任务（T4）扩展本篇。

## 为什么是"追加流 + 快照"

runtime 的持久数据只有两种形状，端口刻意只按形状定义、不做 ORM/查询：

| 形状                   | 数据                                         | 操作                           |
| ---------------------- | -------------------------------------------- | ------------------------------ |
| **追加流**（只增不改） | journal（事务日志）、audit（审计）、对话历史 | `append` / `read` / `truncate` |
| **快照**（整体替换）   | 实体状态、工作区元数据                       | `putSnapshot` / `getSnapshot`  |

```ts
interface SarStore {
  append(stream: string, records: unknown[]): Promise<number /* lastSeq */>;
  read(
    stream: string,
    opts?: { fromSeq?: number; limit?: number },
  ): Promise<StoreRecord[]>;
  truncate(stream: string, uptoSeq: number): Promise<void>;
  putSnapshot(key: string, data: unknown): Promise<void>;
  getSnapshot<T = unknown>(key: string): Promise<T | undefined>;
  close(): Promise<void>;
}
```

约束：记录必须 **JSON 可序列化**（journal 的 TDiff 约束自动覆盖）。三个适配器都先做 JSON
往返归一——内存适配器也一样，保证"测试绿了换持久化适配器不翻车"。

## seq 语义（恢复算法的地基）

- 由 store **按流**分配，从 1 起单调递增；`append` 返回本批最后一条的 seq。
- `read({ fromSeq })` 含边界；恢复时靠 `tail[0].seq === checkpointSeq + 1` 且逐条 +1 校验断档。
- `truncate` 只删头部（seq ≤ uptoSeq），**之后编号继续、永不回退复用**——
  流被清空后重启也如此（file 落 `.meta.json`，idb 有独立 `seqs` 表）。

## 三个适配器

| 适配器                  | 导入                              | 场景                                                                             |
| ----------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `memoryStore()`         | `@geoverse-sar/kernel`            | 测试/临时会话（现状"隐式不持久"的显式化）                                        |
| `idbStore(name)`        | `@geoverse-sar/kernel/store-idb`  | 浏览器——单 DB 三 objectStore（streams 复合键 / seqs / snapshots），append 单事务 |
| `fileStore(dir, opts?)` | `@geoverse-sar/kernel/store-file` | Node——每流一个 JSONL + snapshots/*.json，`fsync` 可配（默认每批）                |

环境特定适配器走**子导出**，不进浏览器主入口（fileStore 是内核唯一豁免"禁 Node
内置模块"lint 门的模块）。测试里三者跑同一契约套件（`packages/kernel/tests/store.test.ts`）。

## 崩溃一致性

- **追加流天然安全**：fileStore 装载时发现末尾无换行残行（写入中途断电）→ 丢弃 + 物理截掉 +
  `onWarn` 告警；**完整行**解析失败＝存储损坏，直接抛错并提示用最近快照恢复。
- **快照/截断原子性**：tmp 文件写完（可 fsync）再 rename 整体替换——中途崩溃最多留下冗余
  journal，不丢数据。
- idbStore 一批 append 与 seq 更新在同一 IndexedDB 事务内。

## journal/audit 流化（sink，R2）

`createJournal` / `createAuditLog` 接受 `sink: { store, stream?, onError? }`：每录一条即
append 进 store——**双写**：内存面照旧供查询（journal.entries() / audit.entries()），store
是持久化取证面。写入串行保序；**sink 故障吞错不断 invoke 主流程**（默认 console.error，
可换 `onError`）；`flush()` 等待未落定的写（关闭存储前调用）。

```ts
import { createAuditLog, createJournal } from '@geoverse-sar/kernel';
import { idbStore } from '@geoverse-sar/kernel/store-idb';

const store = idbStore('proj-1');
const audit = createAuditLog({ sink: { store } }); // → 'audit' 流
const kernel = createKernel({ ...opts, middleware: [audit.middleware] });
const journal = createJournal(kernel, { sink: { store } }); // → 'journal' 流
// 退出前：
await journal.flush();
await audit.flush();
await store.close();
```

## 裸恢复（S1「刷新不丢」，Workspace 之前的先行形态）

启动时从 store 读回 journal 全量重放，再挂录制 sink——注意**先重放、后开录**，
否则重放条目会被重复入账：

```ts
const store = idbStore('proj-1');
const engine = createEngine({ features: SEED });   // 初始态须与录制起点一致（同一 seed）
const kernel = createKernel({ engine, ... });
const tail = await store.read('journal');
replayJournal(kernel, tail.map((r) => r.record as JournalEntry<MyDiff>));
const journal = createJournal(kernel, { sink: { store } });  // 恢复完成后继续录制
```

刷新后要素、undoDepth、redo 可用性与关闭前一致（恢复等价）；audit 流跨会话累积可追溯。
可运行示例：playground `/geo.html`（IndexedDB 工作区 + 状态指示 + 清空按钮）。
完整生命周期（checkpoint 截断＝撤销地平线、快照 seed、seq 断档校验）由 `openWorkspace`（T4）承接。
