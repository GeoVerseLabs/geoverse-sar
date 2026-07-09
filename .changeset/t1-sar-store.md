---
'@geoverse-sar/kernel': patch
---

新增 SarStore 存储端口（追加流 + 快照，runtime 唯一持久化抽象；目标架构 R1）：`memoryStore` 随主入口导出；`idbStore`（IndexedDB，浏览器）与 `fileStore`（JSONL + meta，Node，崩溃残行丢弃 + tmp/rename 原子替换）走子导出 `@geoverse-sar/kernel/store-idb` / `store-file`。seq 按流单调分配、truncate 后不回退；三适配器同一契约测试钉死。
