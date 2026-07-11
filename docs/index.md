---
layout: home

hero:
  name: GeoVerse SAR
  text: Spatial Application Runtime
  tagline: AI-native 空间应用运行时——一切能力注册成 Capability，一切操作走单一漏斗；GIS app、AI Copilot、自治 Agent 只是同一 Runtime 的不同入口。
  actions:
    - theme: brand
      text: 核心概念
      link: /concepts
    - theme: alt
      text: 架构与技术明细
      link: /architecture
    - theme: alt
      text: API 参考
      link: /api/
      target: _blank

features:
  - icon: 🔀
    title: 单一漏斗，跨入口平价
    details: dispatcher.invoke 是唯一调用路径——中间件 → 权限 → 校验 → handler → 写路由 → 事件。UI 点击、AI 工具调用、MCP 调用、远程 HTTP 只差一个 caller.entry，同参数产生相同 diff / 输出 / 终态，由测试钉死而非约定。
  - icon: ↩️
    title: 领域状态撤销是一等公民
    details: 引擎经通用 diff 端口接入（StateEngine + DiffAlgebra）；工作流经 TransactionGroup 把多步 diff 预合并成一个撤销单元（宏撤销）；写操作可 dryRun 预览"将改什么"再落地。
  - icon: 🛡️
    title: 治理长在内核
    details: 权限白名单同时裁剪目录与强制调用；审计对所有入口全量入账；AbortSignal 贯穿漏斗（写路由前兜底不落地）；journal 回放精确复现终态与撤销粒度；审批门把 dryRun diff 交给人审。
  - icon: 💾
    title: 工作区可恢复
    details: SarStore 存储端口（追加流 + 快照，memory/idb/file 三适配器同契约）；openWorkspace 恢复 = 快照 seed + journal tail 重放；checkpoint = 撤销地平线；浏览器刷新不丢、双开只读。
  - icon: 🌐
    title: 本地/远程入口平价
    details: 入口层依赖 SarClient 切面（caller 构造绑定，无处伪造身份）；server 薄层不发明协议——wire 就是 InvokeOutcome；createRemoteClient 还原同一切面，planner/agent 零改动远程化。
  - icon: 🌱
    title: 自进化：进化数据，不进化代码
    details: L1 调优报告（确定性零 LLM）；L2 workflow 合成——挖掘高频序列、LLM 起草纯 JSON 草稿、逐步 dryRun 验证、审批后注册（缺省 pending 不进目录），provenance 全程可追溯。
---
